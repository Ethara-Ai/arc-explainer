import path from "path";
import { promises as fs } from "fs";
import type {
  OrchestratorConfig,
  EvalConfig,
  EvalSessionConfig,
  EventEmitter,
  RunRecord,
  GameModelResult,
  EvalSessionStatus,
  GameType,
  BaseEvalProvider,
  ProviderMessage,
  NotepadState,
  ProviderResponse,
} from "@shared/eval-types";
import type { BaseProvider } from "@shared/providers/base";
import {
  MODEL_REGISTRY,
  DEFAULT_EVAL_CONFIG,
  createProvider,
} from "@shared/config/llmConfig";
import { BudgetTracker } from "@shared/utils/budget";
import { CircuitBreaker } from "@shared/utils/circuitBreaker";
import { EvalRunner } from "./runner/evalRunner";
import { Arc3GameAdapter } from "./adapters/arc3GameAdapter";
import { GameBridgePool } from "./adapters/gameBridgePool";
import { validateAll } from "./validation/gameValidator";

import { startCancelWatcher, cleanStaleSentinels } from "./cancelWatcher";
import { CompositeAbortController } from "./compositeAbort";
import {
  formatSessionTimestamp,
  writeSessionMetadata,
  appendLogLine,
} from "./data/traceWriter";
import {
  AsyncSemaphore,
  withConcurrencyLimitSettled,
} from "./utils/concurrency";
import { logger } from "../../utils/logger";

// GameType is used in GameModelResult (shared/eval-types.ts); re-exported for consumers.
export type { GameType };

// ─── SessionResult ────────────────────────────────────────────────────────────

export interface SessionResult {
  sessionId: string;
  status: EvalSessionStatus;
  results: GameModelResult[];
  totalCost: number;
  totalTokens: number;
  totalDuration: number;
  startedAt: Date;
  completedAt: Date;
  config: EvalSessionConfig;
  budgetExceeded: boolean;
}

// ─── EvalTask (internal) ──────────────────────────────────────────────────────

interface EvalTask {
  modelKey: string;
  gameId: string;
  runIndex: number;
  seed: number;
}

// ─── Provider bridge ──────────────────────────────────────────────────────────

function bridgeProvider(
  bp: BaseProvider,
  signal?: AbortSignal,
): BaseEvalProvider {
  return {
    get modelName(): string {
      return bp.modelName;
    },
    get modelId(): string {
      return bp.modelId;
    },
    async chooseAction(
      systemPrompt: string,
      conversationHistory: ProviderMessage[],
      currentObservation: string,
      validActions: string[],
      notepad: NotepadState,
      imageB64?: string | null,
    ): Promise<ProviderResponse> {
      const raw = await bp.chooseActionAsync(
        {
          systemPrompt,
          conversationHistory,
          currentObservation,
          validActions,
          notepad: notepad.content,
          imageB64: imageB64 ?? null,
        },
        signal,
      );
      return {
        ...raw,
        rawResponse: raw.rawResponse as Record<string, unknown> | null,
      };
    },
  };
}

// ─── Disposable type guard ────────────────────────────────────────────────────

interface DisposableAdapter {
  dispose(): Promise<void>;
}

function isDisposable(adapter: unknown): adapter is DisposableAdapter {
  return (
    adapter !== null &&
    typeof adapter === "object" &&
    "dispose" in adapter &&
    typeof (adapter as DisposableAdapter).dispose === "function"
  );
}

// ─── Hard caps (match Python) ─────────────────────────────────────────────────

const MAX_PARALLEL_GAMES = 25;
const MAX_PARALLEL_RUNS = 10;

// ─── Orchestrator options ─────────────────────────────────────────────────────

export interface OrchestratorOptions {
  sessionConfig: EvalSessionConfig;
  evalConfig?: EvalConfig;
  eventEmitter?: EventEmitter;
  budgetGlobalUsd?: number | null;
  budgetPerGameUsd?: number | null;
  circuitThreshold?: number;
  circuitHalfOpenSeconds?: number;
  parallelGames?: number;
  parallelRuns?: number;
  sequentialModels?: boolean;
}

// ─── EvalOrchestrator ─────────────────────────────────────────────────────────

/**
 * EvalOrchestrator manages a full evaluation session across multiple models and games.
 *
 * Implements 3-level nested parallelism matching the Python orchestrator:
 *   Level 1 (outer): Games — up to parallelGames in parallel
 *   Level 2 (middle): Models per game — all models in parallel (or sequential)
 *   Level 3 (inner): Runs per model — up to parallelRuns in parallel
 *
 * Per-provider semaphores prevent API thundering herd regardless of nesting depth.
 *
 * Ported from: puzzle-eval-harness/scripts/evaluate/orchestrator.py
 */
export class EvalOrchestrator {
  private aborted = false;
  private draining = false;
  private readonly activeRunners = new Set<EvalRunner>();
  private sessionId = "";
  private budget: BudgetTracker | null = null;
  private breaker: CircuitBreaker | null = null;

  // ── Options (from constructor) ───────────────────────────────────────────
  private readonly sessionConfig: EvalSessionConfig;
  private readonly evalConfig: EvalConfig;
  private readonly eventEmitter?: EventEmitter;
  private readonly budgetGlobalUsd: number | null;
  private readonly budgetPerGameUsd: number | null;
  private readonly circuitThreshold: number;
  private readonly circuitHalfOpenSeconds: number;
  private readonly parallelGames: number;
  private readonly parallelRuns: number;
  private readonly sequentialModels: boolean;

  /** Effective output dir — session-timestamped subdirectory of evalConfig.outputDir. */
  private effectiveOutputDir: string | undefined;

  /** Session log file path — logs/session.log inside effectiveOutputDir. */
  private logFilePath: string | undefined;

  /** Per-provider semaphores — shared across all model keys using the same provider. */
  private providerSemaphores: Map<string, AsyncSemaphore> = new Map();

  /** Shared provider instances — one per model key, reused across runs. */
  private providerPool: Map<string, BaseProvider> = new Map();

  /** In-flight provider creation promises — prevents duplicate spawning under concurrency. */
  private providerPending: Map<string, Promise<BaseProvider>> = new Map();

  /** Active game adapters — tracked for cleanup on abort/session-end. */
  private activeAdapters: Set<Arc3GameAdapter> = new Set();

  /** Reusable game adapter pool — one pool of adapters per gameId. */
  private bridgePool: GameBridgePool | null = null;

  /** Global AbortController — fires on abort() or CANCEL_ALL sentinel. */
  private readonly globalAbort = new AbortController();

  /** Per-game AbortControllers — fires on CANCEL_{gameId} sentinel. */
  private readonly gameAborts = new Map<string, AbortController>();

  /** Per-model AbortControllers — fires on CANCEL_{gameId}_{modelKey} sentinel. */
  private readonly modelAborts = new Map<string, AbortController>();

  /** Cancel watcher cleanup function — null until started. */
  private cancelWatcherCleanup: (() => void) | null = null;

  /** Collected RunRecords keyed by "modelKey:gameId:runIndex" — safe concurrent writes. */
  private readonly collectedRecords = new Map<string, RunRecord | null>();

  constructor(opts: OrchestratorOptions);
  /** @deprecated Use options object constructor instead. */
  constructor(
    sessionConfig: EvalSessionConfig,
    evalConfig?: EvalConfig,
    eventEmitter?: EventEmitter,
    budgetGlobalUsd?: number | null,
    budgetPerGameUsd?: number | null,
    circuitThreshold?: number,
    circuitHalfOpenSeconds?: number,
    parallelGames?: number,
    parallelRuns?: number,
    sequentialModels?: boolean,
  );
  constructor(
    optsOrSessionConfig: OrchestratorOptions | EvalSessionConfig,
    evalConfig?: EvalConfig,
    eventEmitter?: EventEmitter,
    budgetGlobalUsd?: number | null,
    budgetPerGameUsd?: number | null,
    circuitThreshold?: number,
    circuitHalfOpenSeconds?: number,
    parallelGames?: number,
    parallelRuns?: number,
    sequentialModels?: boolean,
  ) {
    // Detect which constructor form was used
    if ("sessionConfig" in optsOrSessionConfig) {
      const opts = optsOrSessionConfig as OrchestratorOptions;
      this.sessionConfig = opts.sessionConfig;
      this.evalConfig = opts.evalConfig ?? DEFAULT_EVAL_CONFIG;
      this.eventEmitter = opts.eventEmitter;
      this.budgetGlobalUsd = opts.budgetGlobalUsd ?? null;
      this.budgetPerGameUsd = opts.budgetPerGameUsd ?? null;
      this.circuitThreshold = opts.circuitThreshold ?? 10;
      this.circuitHalfOpenSeconds = opts.circuitHalfOpenSeconds ?? 300.0;
      this.parallelGames = opts.parallelGames ?? 1;
      this.parallelRuns = opts.parallelRuns ?? 1;
      this.sequentialModels = opts.sequentialModels ?? false;
    } else {
      // Legacy positional constructor
      this.sessionConfig = optsOrSessionConfig as EvalSessionConfig;
      this.evalConfig = evalConfig ?? DEFAULT_EVAL_CONFIG;
      this.eventEmitter = eventEmitter;
      this.budgetGlobalUsd = budgetGlobalUsd ?? null;
      this.budgetPerGameUsd = budgetPerGameUsd ?? null;
      this.circuitThreshold = circuitThreshold ?? 10;
      this.circuitHalfOpenSeconds = circuitHalfOpenSeconds ?? 300.0;
      this.parallelGames = parallelGames ?? 1;
      this.parallelRuns = parallelRuns ?? 1;
      this.sequentialModels = sequentialModels ?? false;
    }
  }

  // ─── abort ──────────────────────────────────────────────────────────────────

  abort(): void {
    this.aborted = true;
    this.globalAbort.abort();
    for (const runner of this.activeRunners) {
      runner.abort();
    }
    // Snapshot keys to avoid mutation during iteration
    const providerKeys = Array.from(this.providerPool.keys());
    for (const key of providerKeys) {
      const provider = this.providerPool.get(key);
      if (
        provider &&
        "destroy" in provider &&
        typeof provider.destroy === "function"
      ) {
        (provider as { destroy: () => void }).destroy();
      }
      this.providerPool.delete(key);
    }
  }

  // ─── runSession ─────────────────────────────────────────────────────────────

  async runSession(): Promise<SessionResult> {
    const randomHex = Math.random().toString(16).slice(2, 10);
    this.sessionId = `eval_${Date.now()}_${randomHex}`;
    const startedAt = new Date();

    this.budget = new BudgetTracker({
      globalLimit: this.budgetGlobalUsd ?? null,
      perGameLimit: this.budgetPerGameUsd ?? null,
    });

    this.breaker = new CircuitBreaker({
      threshold: this.circuitThreshold,
      halfOpenSeconds: this.circuitHalfOpenSeconds,
    });

    // ── Validate config ──────────────────────────────────────────────────────
    const validation = validateAll(this.evalConfig, this.sessionConfig);
    if (!validation.valid) {
      const errorMsg = validation.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ");
      this.emitError(errorMsg, "VALIDATION_FAILED");
      throw new Error(
        `[EvalOrchestrator] Config validation failed: ${errorMsg}`,
      );
    }

    this.emitLog("info", `[EvalOrchestrator] Config validation passed`);

    // ── Create session-timestamped output directory ────────────────────────
    if (this.evalConfig.outputDir) {
      const timestamp = formatSessionTimestamp();
      this.effectiveOutputDir = path.join(this.evalConfig.outputDir, timestamp);

      // Create logs/ directory and session log file
      const logsDir = path.join(this.effectiveOutputDir, "logs");
      await fs.mkdir(logsDir, { recursive: true });
      this.logFilePath = path.join(logsDir, "session.log");

      // Write initial session-level game_metadata.json (will be overwritten at end with full array)
      await writeSessionMetadata(this.effectiveOutputDir, {
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        modelKeys: this.sessionConfig.modelKeys,
        gameIds: this.sessionConfig.gameIds,
        numRuns: this.sessionConfig.numRuns,
        maxSteps: this.sessionConfig.maxSteps,
        seedBase: this.sessionConfig.seedBase,
        contextWindow: this.sessionConfig.contextWindow,
        withImages: this.sessionConfig.withImages,
      });

      // Write per-game metadata.json for each game
      for (const gameId of this.sessionConfig.gameIds) {
        const gameDir = path.join(this.effectiveOutputDir, gameId);
        await fs.mkdir(gameDir, { recursive: true });
        const gameMetadata = {
          gameId,
          sessionId: this.sessionId,
          modelKeys: this.sessionConfig.modelKeys,
          numRuns: this.sessionConfig.numRuns,
          maxSteps: this.sessionConfig.maxSteps,
          seedBase: this.sessionConfig.seedBase,
          timestamp: new Date().toISOString(),
        };
        await fs.writeFile(
          path.join(gameDir, "metadata.json"),
          JSON.stringify(gameMetadata, null, 2),
          "utf-8",
        );
      }

      this.emitLog(
        "info",
        `[EvalOrchestrator] Session output dir: ${path.basename(this.effectiveOutputDir)}`,
      );
    }

    // ── Build per-provider semaphores ────────────────────────────────────────
    this.buildProviderSemaphores();

    // ── Initialize bridge pool for game adapter reuse ────────────────────────
    const poolSize = Math.max(
      Math.min(Math.max(1, this.parallelRuns), MAX_PARALLEL_RUNS, this.sessionConfig.numRuns),
      2,
    );
    this.bridgePool = new GameBridgePool({
      maxPerGame: poolSize,
      envDir: this.sessionConfig.envDir,
    });

    // ── Initialize per-game AbortControllers ─────────────────────────────────
    for (const gameId of this.sessionConfig.gameIds) {
      this.gameAborts.set(gameId, new AbortController());
    }

    // ── Start cancel watcher ─────────────────────────────────────────────────
    if (this.evalConfig.outputDir) {
      const sentinelDir = path.join(this.evalConfig.outputDir, "cancel");

      // Clean stale sentinels from a previous session
      const removed = await cleanStaleSentinels(sentinelDir);
      for (const name of removed) {
        this.emitLog("info", `[CancelWatcher] Removed stale sentinel: ${name}`);
      }

      // Build shutdown callback maps
      const gameShutdowns = new Map<string, () => void>();
      for (const [gameId, ac] of this.gameAborts) {
        gameShutdowns.set(gameId, () => {
          this.emitLog("warn", `[CancelWatcher] CANCEL_${gameId} detected`);
          ac.abort();
        });
      }

      // Model shutdowns are populated dynamically; we pass a live reference
      const modelShutdowns = new Map<string, () => void>();

      this.cancelWatcherCleanup = await startCancelWatcher({
        sentinelDir,
        onGlobalShutdown: () => {
          this.emitLog(
            "warn",
            "[CancelWatcher] CANCEL_ALL detected — shutting down",
          );
          this.abort();
        },
        gameShutdowns,
        modelShutdowns,
        onDrain: () => {
          this.emitLog(
            "warn",
            "[CancelWatcher] DRAIN detected — finishing in-progress, skipping new",
          );
          this.draining = true;
        },
        pollIntervalMs: 2000,
      });
    }

    // ── Pre-warm provider pool to avoid concurrent first-access races ────────
    await this.prewarmProviderPool();

    // ── Generate task list (for counting and result aggregation) ─────────────
    const tasks = this.generateTasks();
    const totalRuns = tasks.length;

    // ── Emit session_start ───────────────────────────────────────────────────
    this.eventEmitter?.({
      type: "session_start",
      session_id: this.sessionId,
      game_ids: this.sessionConfig.gameIds,
      model_keys: this.sessionConfig.modelKeys,
      parallel: true,
      models: this.sessionConfig.modelKeys,
      num_runs: this.sessionConfig.numRuns,
      max_steps: this.sessionConfig.maxSteps,
      total_runs: totalRuns,
      timestamp: new Date().toISOString(),
    });

    const effectiveParallelGames = Math.min(
      Math.max(1, this.parallelGames),
      MAX_PARALLEL_GAMES,
      this.sessionConfig.gameIds.length,
    );
    const effectiveParallelRuns = Math.min(
      Math.max(1, this.parallelRuns),
      MAX_PARALLEL_RUNS,
      this.sessionConfig.numRuns,
    );

    this.emitLog(
      "info",
      `[EvalOrchestrator] Session ${this.sessionId} starting: ` +
        `${this.sessionConfig.modelKeys.length} model(s) × ` +
        `${this.sessionConfig.gameIds.length} game(s) × ` +
        `${this.sessionConfig.numRuns} run(s) = ${totalRuns} total tasks. ` +
        `Parallelism: games=${effectiveParallelGames} models=${this.sequentialModels ? "sequential" : "parallel"} runs=${effectiveParallelRuns}. ` +
        `Output dir: ${this.effectiveOutputDir ? path.basename(this.effectiveOutputDir) : this.evalConfig.outputDir ?? "NONE"}`,
    );

    // ── Execute with 3-level nested parallelism ──────────────────────────────
    await this.executeNested(effectiveParallelGames, effectiveParallelRuns);

    // ── Stop cancel watcher ──────────────────────────────────────────────────
    this.cancelWatcherCleanup?.();
    this.cancelWatcherCleanup = null;

    // ── Build index-aligned results from collected records ────────────────────
    const rawRecords = this.buildAlignedRecords(tasks);

    // ── Aggregate results ────────────────────────────────────────────────────
    const gameModelResults = this.aggregateResults(rawRecords, tasks);

    // ── Emit model_done per model × game ─────────────────────────────────────
    const completedModelKeys = new Set<string>();
    const totalUniqueModels = this.sessionConfig.modelKeys.length;

    for (const result of gameModelResults) {
      completedModelKeys.add(result.modelKey);
      const modelCfg = MODEL_REGISTRY[result.modelKey];
      this.eventEmitter?.({
        type: "model_done",
        session_id: this.sessionId,
        model: modelCfg?.name ?? result.modelKey,
        model_key: result.modelKey,
        game_id: result.gameId,
        status: "completed",
        avg_score: result.avgScore,
        avg_score_pct: Math.round(result.avgScore * 10000) / 100,
        solved_count: result.solvedCount,
        total_runs: result.totalRuns,
        scores: result.scores,
        score_stddev: result.scoreStddev,
        total_cost_usd: result.runCost,
        completed_models: completedModelKeys.size,
        total_models: totalUniqueModels,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Compute session totals ───────────────────────────────────────────────
    const successfulRecords = rawRecords.filter(
      (r): r is RunRecord => r !== null,
    );
    const totalCost = gameModelResults.reduce((sum, r) => sum + r.runCost, 0);
    const totalTokens = successfulRecords.reduce(
      (sum, r) =>
        sum + r.totalInputTokens + r.totalOutputTokens + r.totalReasoningTokens,
      0,
    );
    const totalSteps = successfulRecords.reduce(
      (sum, r) => sum + r.totalSteps,
      0,
    );
    const completedAt = new Date();
    const totalDuration = (completedAt.getTime() - startedAt.getTime()) / 1000;

    const budgetExceeded = this.budget
      ? this.budget.checkBudget("").isOverGlobal
      : false;

    const status: EvalSessionStatus =
      this.aborted && budgetExceeded
        ? "failed"
        : this.aborted
          ? "cancelled"
          : successfulRecords.length === 0 && totalRuns > 0
            ? "failed"
            : "completed";

    // ── Emit session_end ─────────────────────────────────────────────────────
    this.eventEmitter?.({
      type: "session_end",
      session_id: this.sessionId,
      total_runs: totalRuns,
      total_steps: totalSteps,
      total_cost_usd: totalCost,
      elapsed_seconds: totalDuration,
      timestamp: new Date().toISOString(),
    });

    this.emitLog(
      "info",
      `[EvalOrchestrator] Session ${this.sessionId} ${status}: ` +
        `${successfulRecords.length}/${totalRuns} tasks succeeded, ` +
        `$${totalCost.toFixed(4)}, ${totalDuration.toFixed(1)}s`,
    );

    // ── Write final game_metadata.json as array of per-game results ─────────
    if (this.effectiveOutputDir) {
      const gameMetadataArray = this.sessionConfig.gameIds.map((gameId) => {
        const gameResults = gameModelResults.filter((r) => r.gameId === gameId);
        return {
          gameId,
          models: gameResults.map((r) => ({
            modelKey: r.modelKey,
            avgScore: r.avgScore,
            scores: r.scores,
            scoreStddev: r.scoreStddev,
            solvedCount: r.solvedCount,
            totalRuns: r.totalRuns,
            runCost: r.runCost,
            runSteps: r.runSteps,
            error: r.error,
          })),
        };
      });
      await writeSessionMetadata(this.effectiveOutputDir, {
        sessionId: this.sessionId,
        status,
        timestamp: new Date().toISOString(),
        completedAt: completedAt.toISOString(),
        totalCost,
        totalTokens,
        totalDuration,
        games: gameMetadataArray,
      });
    }

    // ── Cleanup providers and game adapters ───────────────────────────────────
    await this.cleanupPools();

    return {
      sessionId: this.sessionId,
      status,
      results: gameModelResults,
      totalCost,
      totalTokens,
      totalDuration,
      startedAt,
      completedAt,
      config: this.sessionConfig,
      budgetExceeded,
    };
  }

  // ─── Provider pool management ──────────────────────────────────────────────

  /**
   * Pre-warm the provider pool by creating all providers before parallel execution.
   * This avoids the race condition where multiple concurrent tasks try to create
   * the same provider simultaneously.
   */
  private async prewarmProviderPool(): Promise<void> {
    for (const modelKey of this.sessionConfig.modelKeys) {
      if (this.aborted) break;
      try {
        await this.getOrCreateProvider(modelKey);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitLog(
          "warn",
          `[EvalOrchestrator] Failed to pre-warm provider for ${modelKey}: ${msg}`,
        );
      }
    }
  }

  /**
   * Get or create a provider for a model key, with deduplication of concurrent
   * first-access. If two workers request the same modelKey simultaneously,
   * both get the same provider instance (only one createProvider call is made).
   */
  private async getOrCreateProvider(modelKey: string): Promise<BaseProvider> {
    const existing = this.providerPool.get(modelKey);
    if (existing) return existing;

    // Check for in-flight creation
    const pending = this.providerPending.get(modelKey);
    if (pending) return pending;

    // Create with dedup
    const creation = (async () => {
      this.emitLog(
        "info",
        `[EvalOrchestrator] Creating provider for ${modelKey}...`,
      );
      const provider = await createProvider(modelKey);
      this.providerPool.set(modelKey, provider);
      this.providerPending.delete(modelKey);
      this.emitLog(
        "info",
        `[EvalOrchestrator] Provider created: ${provider.modelName} (${modelKey})`,
      );

      if ("warmup" in provider && typeof provider.warmup === "function") {
        this.emitLog("info", `[EvalOrchestrator] Warming up ${modelKey}...`);
        await provider.warmup();
      }
      return provider;
    })();

    this.providerPending.set(modelKey, creation);

    try {
      return await creation;
    } catch (err) {
      this.providerPending.delete(modelKey);
      throw err;
    }
  }

  /**
   * Create a dedicated game adapter for a single run.
   * Each run gets its own adapter (and Python subprocess) so that parallel
   * runs on the same gameId don't compete for a shared bridge connection.
   */
  private async createGameAdapter(gameId: string): Promise<Arc3GameAdapter> {
    this.emitLog(
      "info",
      `[EvalOrchestrator] Creating game adapter for ${gameId}...`,
    );
    if (this.bridgePool) {
      const adapter = await this.bridgePool.acquire(gameId);
      this.activeAdapters.add(adapter);
      this.emitLog(
        "info",
        `[EvalOrchestrator] Game adapter acquired from pool: ${gameId} (type=${adapter.gameType})`,
      );
      return adapter;
    }
    const game = await Arc3GameAdapter.create(
      gameId,
      undefined,
      undefined,
      this.sessionConfig.envDir,
    );
    this.activeAdapters.add(game);
    this.emitLog(
      "info",
      `[EvalOrchestrator] Game adapter created: ${gameId} (type=${game.gameType})`,
    );
    return game;
  }

  /**
   * Dispose a game adapter and remove it from the active set.
   */
  private async disposeGameAdapter(adapter: Arc3GameAdapter): Promise<void> {
    this.activeAdapters.delete(adapter);
    if (this.bridgePool) {
      await this.bridgePool.release(adapter);
      return;
    }
    if (isDisposable(adapter)) {
      await adapter.dispose().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitLog(
          "warn",
          `[EvalOrchestrator] Failed to dispose game adapter ${adapter.gameId}: ${msg}`,
        );
      });
    }
  }

  /**
   * Clean up all pooled providers and any remaining game adapters.
   * Uses snapshots to avoid mutation-during-iteration.
   */
  private async cleanupPools(): Promise<void> {
    // Cleanup bridge pool
    if (this.bridgePool) {
      await this.bridgePool.dispose();
      this.bridgePool = null;
    }

    // Cleanup providers
    const providerKeys = Array.from(this.providerPool.keys());
    for (const key of providerKeys) {
      const provider = this.providerPool.get(key);
      if (
        provider &&
        "destroy" in provider &&
        typeof provider.destroy === "function"
      ) {
        (provider as { destroy: () => void }).destroy();
      }
      this.providerPool.delete(key);
    }

    // Cleanup any lingering game adapters (e.g. from aborted runs)
    const adapters = Array.from(this.activeAdapters);
    for (const adapter of adapters) {
      await this.disposeGameAdapter(adapter);
    }
  }

  // ─── Provider semaphores ────────────────────────────────────────────────────

  /**
   * Build per-provider semaphores from the providerMaxConcurrent config.
   * Multiple model keys sharing the same provider share the same semaphore.
   * Matches Python orchestrator.py lines 285-294.
   */
  private buildProviderSemaphores(): void {
    for (const modelKey of this.sessionConfig.modelKeys) {
      const modelCfg = MODEL_REGISTRY[modelKey];
      if (!modelCfg?.provider) continue;
      if (this.providerSemaphores.has(modelCfg.provider)) continue;

      const limit =
        this.evalConfig.providerMaxConcurrent[modelCfg.provider] ?? 10;
      this.providerSemaphores.set(modelCfg.provider, new AsyncSemaphore(limit));
      this.emitLog(
        "debug",
        `[EvalOrchestrator] Provider semaphore: ${modelCfg.provider} = ${limit}`,
      );
    }
  }

  // ─── 3-level nested execution ───────────────────────────────────────────────

  /**
   * Execute evaluation with 3-level nested parallelism.
   * Uses withConcurrencyLimitSettled so one game/model/run failure
   * doesn't abort sibling tasks.
   */
  private async executeNested(
    parallelGames: number,
    parallelRuns: number,
  ): Promise<void> {
    const gameIds = this.sessionConfig.gameIds;

    if (parallelGames <= 1) {
      // Sequential game execution
      for (const gameId of gameIds) {
        if (this.aborted) break;
        await this.executeGame(gameId, parallelRuns);
      }
    } else {
      // Parallel game execution — settled so one game failure doesn't kill others
      const gameTasks = gameIds.map(
        (gameId) => () => this.executeGame(gameId, parallelRuns),
      );
      await withConcurrencyLimitSettled(gameTasks, parallelGames);
    }
  }

  /**
   * Execute all models for a single game (Level 2).
   */
  private async executeGame(
    gameId: string,
    parallelRuns: number,
  ): Promise<void> {
    // Drain mode: skip games that haven't started yet
    if (this.draining) {
      this.emitLog(
        "info",
        `[EvalOrchestrator] Drain mode: skipping game ${gameId}`,
      );
      return;
    }
    if (this.aborted) return;

    this.emitLog(
      "info",
      `[EvalOrchestrator] Starting game ${gameId}: ${this.sessionConfig.modelKeys.length} model(s), ${this.sessionConfig.numRuns} run(s) each`,
    );

    const gameAbort = this.gameAborts.get(gameId);

    const modelKeys = this.sessionConfig.modelKeys;

    if (this.sequentialModels) {
      // Sequential model execution (--sequential flag)
      for (const modelKey of modelKeys) {
        if (this.aborted || gameAbort?.signal.aborted) break;
        await this.executeModel(gameId, modelKey, parallelRuns);
      }
    } else {
      // Parallel model execution (default) — settled for resilience
      const modelTasks = modelKeys.map(
        (modelKey) => () => this.executeModel(gameId, modelKey, parallelRuns),
      );
      await withConcurrencyLimitSettled(modelTasks, modelKeys.length);
    }
  }

  /**
   * Execute all runs for a single model on a single game (Level 3).
   */
  private async executeModel(
    gameId: string,
    modelKey: string,
    parallelRuns: number,
  ): Promise<void> {
    if (this.aborted) return;

    const gameAbort = this.gameAborts.get(gameId);
    if (gameAbort?.signal.aborted) return;

    this.emitLog(
      "info",
      `[EvalOrchestrator] Starting model ${modelKey} on game ${gameId}: ${this.sessionConfig.numRuns} run(s), parallelRuns=${parallelRuns}`,
    );

    // Register per-model abort controller for cancel watcher
    const modelAbortKey = `${gameId}_${modelKey}`;
    const modelAbortController = new AbortController();
    this.modelAborts.set(modelAbortKey, modelAbortController);

    // Build composite abort: global OR game OR model
    const compositeAbort = new CompositeAbortController(
      this.globalAbort.signal,
      gameAbort?.signal ?? this.globalAbort.signal,
      modelAbortController.signal,
    );

    try {
      const numRuns = this.sessionConfig.numRuns;
      const runIndices = Array.from({ length: numRuns }, (_, i) => i);
      const effectiveWorkers = Math.min(parallelRuns, numRuns);

      if (effectiveWorkers <= 1) {
        // Sequential run execution
        for (const runIndex of runIndices) {
          if (compositeAbort.signal.aborted) break;
          const seed = this.sessionConfig.seedBase + runIndex;
          const task: EvalTask = { modelKey, gameId, runIndex, seed };
          const record = await this.executeTaskSafe(
            task,
            compositeAbort.signal,
          );
          this.collectedRecords.set(
            `${task.modelKey}:${task.gameId}:${task.runIndex}`,
            record,
          );
        }
      } else {
        // Parallel run execution — settled for resilience
        const runTasks = runIndices.map((runIndex) => async () => {
          const seed = this.sessionConfig.seedBase + runIndex;
          const task: EvalTask = { modelKey, gameId, runIndex, seed };
          const record = await this.executeTaskSafe(
            task,
            compositeAbort.signal,
          );
          this.collectedRecords.set(
            `${task.modelKey}:${task.gameId}:${task.runIndex}`,
            record,
          );
        });
        await withConcurrencyLimitSettled(runTasks, effectiveWorkers);
      }
    } finally {
      compositeAbort.dispose();
      this.modelAborts.delete(modelAbortKey);
    }
  }

  // ─── Task generation ────────────────────────────────────────────────────────

  private generateTasks(): EvalTask[] {
    const tasks: EvalTask[] = [];
    for (const modelKey of this.sessionConfig.modelKeys) {
      for (const gameId of this.sessionConfig.gameIds) {
        for (
          let runIndex = 0;
          runIndex < this.sessionConfig.numRuns;
          runIndex++
        ) {
          tasks.push({
            modelKey,
            gameId,
            runIndex,
            seed: this.sessionConfig.seedBase + runIndex,
          });
        }
      }
    }
    return tasks;
  }

  // ─── Task execution ─────────────────────────────────────────────────────────

  /**
   * Execute a task, catching all errors so one failure doesn't abort the session.
   * Now accepts a composite AbortSignal for hierarchical cancellation.
   */
  private async executeTaskSafe(
    task: EvalTask,
    signal: AbortSignal,
  ): Promise<RunRecord | null> {
    if (this.aborted || signal.aborted) {
      this.emitLog(
        "warn",
        `[EvalOrchestrator] Skipping ${task.modelKey}/${task.gameId}#${task.runIndex} (aborted)`,
      );
      return null;
    }

    const modelCfg = MODEL_REGISTRY[task.modelKey];

    if (this.breaker && modelCfg && !this.breaker.canCall(task.modelKey)) {
      const state = this.breaker.getState(task.modelKey);
      this.emitLog(
        "warn",
        `[EvalOrchestrator] Circuit OPEN for ${task.modelKey} (${state.consecutiveFailures} consecutive failures) -- skipping ${task.modelKey}/${task.gameId}`,
      );
      return null;
    }

    if (this.budget) {
      const snap = this.budget.checkBudget(task.gameId);
      if (snap.isOverGlobal) {
        this.emitLog(
          "warn",
          `[EvalOrchestrator] Global budget exceeded ($${snap.globalSpent.toFixed(2)}/$${snap.globalLimit?.toFixed(2)}) -- skipping ${task.modelKey}/${task.gameId}`,
        );
        this.abort();
        return null;
      }
      if (snap.isOverGame) {
        this.emitLog(
          "warn",
          `[EvalOrchestrator] Game budget exceeded for ${task.gameId} ($${snap.gameSpent.toFixed(2)}/$${snap.gameLimit?.toFixed(2)}) -- skipping ${task.modelKey}`,
        );
        return null;
      }
    }

    // Acquire provider semaphore before executing
    const provider = modelCfg?.provider;
    const semaphore = provider
      ? this.providerSemaphores.get(provider)
      : undefined;

    const reservationUsd = 0.10;
    if (this.budget) {
      this.budget.reserve(task.gameId, reservationUsd);
    }

    try {
      if (semaphore) {
        this.emitLog(
          "debug",
          `[EvalOrchestrator] Acquiring semaphore for ${provider} (${task.modelKey}/${task.gameId}#${task.runIndex})`,
        );
        await semaphore.acquire();
        this.emitLog(
          "debug",
          `[EvalOrchestrator] Semaphore acquired for ${provider} (${task.modelKey}/${task.gameId}#${task.runIndex})`,
        );
      }

      const record = await this.executeTask(task, signal);

      if (this.budget && record.costUsd != null && record.costUsd > 0) {
        const snap = this.budget.recordCost(task.gameId, record.costUsd);
        if (snap.isOverGame) {
          this.emitLog(
            "warn",
            `[EvalOrchestrator] Game budget exceeded for ${task.gameId} after ${task.modelKey}`,
          );
        }
        if (snap.isOverGlobal) {
          this.emitLog(
            "warn",
            `[EvalOrchestrator] Global budget exceeded after ${task.modelKey}/${task.gameId}`,
          );
          this.abort();
        }
      }

      if (this.breaker && modelCfg) {
        this.breaker.recordSuccess(task.modelKey);
      }

      return record;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? `${err.constructor.name}: ${err.message}`
          : String(err);
      this.emitError(message, "TASK_FAILED", task.modelKey, task.gameId);
      this.emitLog(
        "warn",
        `[EvalOrchestrator] Task ${task.modelKey}/${task.gameId}#${task.runIndex} failed: ${message}`,
      );

      if (this.breaker && modelCfg) {
        this.breaker.recordFailure(task.modelKey);
      }

      return null;
    } finally {
      if (this.budget) {
        this.budget.releaseReservation(task.gameId, reservationUsd);
      }
      if (semaphore) {
        semaphore.release();
      }
    }
  }

  private async executeTask(
    task: EvalTask,
    signal?: AbortSignal,
  ): Promise<RunRecord> {
    this.emitLog(
      "info",
      `[EvalOrchestrator] executeTask: model=${task.modelKey} game=${task.gameId} run=${task.runIndex + 1}`,
    );

    const rawProvider = await this.getOrCreateProvider(task.modelKey);
    const provider = bridgeProvider(rawProvider, signal);

    // Each run gets its own adapter (and Python subprocess) so parallel
    // runs on the same gameId don't compete for a shared bridge connection.
    const game = await this.createGameAdapter(task.gameId);

    const modelConfig = MODEL_REGISTRY[task.modelKey];
    const maxContext = modelConfig?.maxContextTokens ?? 1_000_000;
    const maxOutput = modelConfig?.maxOutputTokens ?? 8192;
    const tokenBudget = maxContext - maxOutput;

    const mergedConfig: EvalConfig = {
      ...this.evalConfig,
      outputDir: this.effectiveOutputDir ?? this.evalConfig.outputDir,
      maxSteps: this.sessionConfig.maxSteps,
      numRuns: this.sessionConfig.numRuns,
      contextWindow: this.sessionConfig.contextWindow,
      seedBase: this.sessionConfig.seedBase,
      tokenBudget,
    };

    const runner = new EvalRunner(
      game,
      provider,
      mergedConfig,
      this.eventEmitter,
      this.sessionId,
      this.sessionConfig.withImages,
      this.logFilePath,
    );

    this.activeRunners.add(runner);

    try {
      const record = await runner.runGame(task.runIndex, task.seed);
      this.emitLog(
        "info",
        `[EvalOrchestrator] Task complete: ${record.runId} score=${record.finalScore} solved=${record.solved} cost=$${(record.costUsd ?? 0).toFixed(4)} steps=${record.totalSteps} elapsed=${record.elapsedSeconds}s`,
      );
      return record;
    } finally {
      this.activeRunners.delete(runner);
      await this.disposeGameAdapter(game);
    }
  }

  // ─── Result alignment ───────────────────────────────────────────────────────

  /**
   * Build an index-aligned results array from the collected records Map.
   */
  private buildAlignedRecords(tasks: EvalTask[]): Array<RunRecord | null> {
    return tasks.map(
      (task) =>
        this.collectedRecords.get(
          `${task.modelKey}:${task.gameId}:${task.runIndex}`,
        ) ?? null,
    );
  }

  // ─── Result aggregation ─────────────────────────────────────────────────────

  private aggregateResults(
    rawRecords: Array<RunRecord | null>,
    tasks: EvalTask[],
  ): GameModelResult[] {
    const groups = new Map<string, { runs: RunRecord[]; errors: string[] }>();

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const record = rawRecords[i] ?? null;
      const key = `${task.modelKey}:${task.gameId}`;

      let group = groups.get(key);
      if (!group) {
        group = { runs: [], errors: [] };
        groups.set(key, group);
      }

      if (record !== null) {
        group.runs.push(record);
        if (record.error !== null) {
          group.errors.push(record.error);
        }
      } else {
        group.errors.push(`Task ${task.runIndex} produced no record`);
      }
    }

    const results: GameModelResult[] = [];

    for (const modelKey of this.sessionConfig.modelKeys) {
      for (const gameId of this.sessionConfig.gameIds) {
        const key = `${modelKey}:${gameId}`;
        const group = groups.get(key) ?? { runs: [], errors: [] };
        const { runs } = group;

        const totalRuns = runs.length;
        const solvedCount = runs.filter((r) => r.solved).length;
        const scores = runs.map((r) => r.finalScore);
        const avgScore =
          totalRuns > 0
            ? scores.reduce((sum, s) => sum + s, 0) / totalRuns
            : 0;
        const scoreStddev =
          totalRuns > 1
            ? Math.sqrt(
                scores.reduce((sum, s) => sum + (s - avgScore) ** 2, 0) /
                  totalRuns,
              )
            : 0;
        const runSteps = runs.reduce((sum, r) => sum + r.totalSteps, 0);
        const runCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

        const error =
          totalRuns === 0 && group.errors.length > 0
            ? (group.errors[0] ?? null)
            : null;

        results.push({
          gameId,
          modelKey,
          runSteps,
          runCost,
          avgScore,
          solvedCount,
          totalRuns,
          scores,
          scoreStddev,
          error,
        });
      }
    }

    return results;
  }

  // ─── Logging helpers ────────────────────────────────────────────────────────

  private emitLog(level: "info" | "warn" | "debug", message: string): void {
    // Write to console so all log lines are visible in terminal
    if (level === "warn") {
      logger.warn(message, "eval-orchestrator");
    } else if (level !== "debug") {
      logger.info(message, "eval-orchestrator");
    }

    this.eventEmitter?.({
      type: "log",
      session_id: this.sessionId,
      level,
      message,
      timestamp: new Date().toISOString(),
    });
    if (this.logFilePath) {
      appendLogLine(this.logFilePath, level, message).catch((err) => {
        logger.warn(
          `[EvalOrchestrator] Log write failed: ${err instanceof Error ? err.message : String(err)}`,
          "eval-orchestrator",
        );
      });
    }
  }

  private emitError(
    message: string,
    code: string,
    modelKey?: string,
    gameId?: string,
  ): void {
    const logMsg = `[${code}] ${modelKey ?? ""}/${gameId ?? ""}: ${message}`;
    logger.error(logMsg, "eval-orchestrator");

    const modelCfg = modelKey ? MODEL_REGISTRY[modelKey] : undefined;
    this.eventEmitter?.({
      type: "error",
      session_id: this.sessionId,
      run_id: null,
      model: modelCfg?.name ?? modelKey ?? null,
      game_id: gameId ?? null,
      message,
      code,
      timestamp: new Date().toISOString(),
    });
    if (this.logFilePath) {
      appendLogLine(this.logFilePath, "error", logMsg).catch((err) => {
        logger.warn(
          `[EvalOrchestrator] Error log write failed: ${err instanceof Error ? err.message : String(err)}`,
          "eval-orchestrator",
        );
      });
    }
  }
}
