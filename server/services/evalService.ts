import { EvalOrchestrator } from "./eval/evalOrchestrator";
import type { SessionResult } from "./eval/evalOrchestrator";
import { EvalRepository } from "../repositories/EvalRepository";
import { sseStreamManager } from "./streaming/SSEStreamManager";
import { logger } from "../utils/logger";
import {
  MODEL_REGISTRY,
  ALL_MODEL_KEYS,
  DEFAULT_EVAL_CONFIG,
} from "@shared/config/llmConfig";
import { isDatabaseConnected } from "../repositories/base/BaseRepository";
import { ARC3_GAME_IDS } from "./eval/adapters/arc3GameAdapter";
import type {
  EvalSessionConfig,
  EvalConfig,
  EvalEvent,
} from "@shared/eval-types";
import type { EvalSession, EvalRun, EvalStep } from "@shared/schema";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OrchestratorOverrides {
  parallelGames?: number;
  parallelRuns?: number;
  sequentialModels?: boolean;
  budgetGlobalUsd?: number | null;
  budgetPerGameUsd?: number | null;
  circuitThreshold?: number;
  circuitHalfOpenSeconds?: number;
}

interface ActiveSession {
  orchestrator: EvalOrchestrator;
  sessionId: string;
  startedAt: Date;
  persistFailureCount: number;
  persistFailureWarned: boolean;
}

interface GameInfo {
  id: string;
  type: "arc3";
  title: string;
}

interface ModelInfo {
  key: string;
  name: string;
  provider: string;
  supportsVision: boolean;
}

// ─── Service ────────────────────────────────────────────────────────────────

class EvalService {
  private activeSessions: Map<string, ActiveSession> = new Map();
  private repository: EvalRepository;

  constructor() {
    this.repository = new EvalRepository();
  }

  async startEval(
    sessionConfig: EvalSessionConfig,
    evalConfig?: Partial<EvalConfig>,
    overrides?: OrchestratorOverrides,
  ): Promise<string> {
    const mergedConfig: EvalConfig = {
      ...DEFAULT_EVAL_CONFIG,
      ...evalConfig,
      maxSteps: sessionConfig.maxSteps ?? DEFAULT_EVAL_CONFIG.maxSteps,
      numRuns: sessionConfig.numRuns ?? DEFAULT_EVAL_CONFIG.numRuns,
      contextWindow:
        sessionConfig.contextWindow ?? DEFAULT_EVAL_CONFIG.contextWindow,
      seedBase: sessionConfig.seedBase ?? DEFAULT_EVAL_CONFIG.seedBase,
    };

    let resolvedSessionId: string | null = null;

    const wrappedEmitter = (event: EvalEvent): void => {
      if (event.type === "session_start" && !resolvedSessionId) {
        resolvedSessionId = event.session_id;
      }
      this.handleEvent(event);
    };

    const opts = overrides ?? {};
    const orchestrator = new EvalOrchestrator(
      sessionConfig,
      mergedConfig,
      wrappedEmitter,
      opts.budgetGlobalUsd ?? null,
      opts.budgetPerGameUsd ?? null,
      opts.circuitThreshold ?? 10,
      opts.circuitHalfOpenSeconds ?? 300,
      opts.parallelGames ?? 1,
      opts.parallelRuns ?? 1,
      opts.sequentialModels ?? false,
    );

    // Start the session. Attach .catch() IMMEDIATELY to prevent unhandled rejection.
    // The orchestrator validates config at the start of runSession() and may throw.
    const sessionPromise = orchestrator.runSession().catch((err: unknown) => {
      // This catch prevents Node unhandled rejection crash.
      // The error is re-handled below in the .then/.catch chain.
      throw err;
    });

    // Wait briefly for session_start event to fire and give us the ID.
    // If validation fails, the promise rejects immediately — we check for that.
    let earlyError: Error | null = null;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 200)),
      sessionPromise.catch((err: unknown) => {
        earlyError = err instanceof Error ? err : new Error(String(err));
      }),
    ]);

    // If the orchestrator already failed (e.g., validation), throw to controller
    if (earlyError) {
      throw earlyError;
    }

    if (!resolvedSessionId) {
      resolvedSessionId = `eval_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      logger.warn(
        `[EvalService] Could not capture sessionId from orchestrator, using fallback: ${resolvedSessionId}`,
        "eval",
      );
    }

    const sessionId = resolvedSessionId;

    this.activeSessions.set(sessionId, {
      orchestrator,
      sessionId,
      startedAt: new Date(),
      persistFailureCount: 0,
      persistFailureWarned: false,
    });

    try {
      await this.repository.createSession({
        id: sessionId,
        status: "running",
        gameIds: sessionConfig.gameIds.join(","),
        modelKeys: sessionConfig.modelKeys.join(","),
        numRuns: mergedConfig.numRuns,
        maxSteps: mergedConfig.maxSteps,
        seedBase: mergedConfig.seedBase,
        startedAt: new Date(),
      });
    } catch (error) {
      logger.error(
        `[EvalService] Failed to persist session ${sessionId} to DB (continuing anyway): ${error}`,
        "eval",
      );
    }

    sessionPromise
      .then(async (result: SessionResult) => {
        await this.handleSessionComplete(sessionId, result);
      })
      .catch(async (error: unknown) => {
        await this.handleSessionError(sessionId, error);
      })
      .finally(() => {
        this.activeSessions.delete(sessionId);
      });

    return sessionId;
  }

  async cancelEval(sessionId: string): Promise<boolean> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      logger.warn(
        `[EvalService] Cannot cancel — session ${sessionId} not active`,
        "eval",
      );
      return false;
    }

    active.orchestrator.abort();

    try {
      await this.repository.updateSessionStatus(sessionId, "cancelled", {
        completedAt: new Date(),
      });
    } catch (error) {
      logger.error(
        `[EvalService] Failed to update cancelled status for ${sessionId}: ${error}`,
        "eval",
      );
    }

    this.activeSessions.delete(sessionId);
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  listGames(): GameInfo[] {
    return ARC3_GAME_IDS.map((id) => ({
      id,
      type: "arc3" as const,
      title: id.toUpperCase(),
    }));
  }

  listModels(): ModelInfo[] {
    return ALL_MODEL_KEYS.map((key) => {
      const config = MODEL_REGISTRY[key];
      return {
        key,
        name: config.name,
        provider: config.provider,
        supportsVision: config.supportsVision ?? true,
      };
    });
  }

  // ── DB Read Operations ────────────────────────────────────────────────

  async getSession(sessionId: string): Promise<EvalSession | null> {
    return this.repository.getSession(sessionId);
  }

  async listSessionsFromDb(limit = 50, offset = 0): Promise<EvalSession[]> {
    return this.repository.listSessions(limit, offset);
  }

  async getRuns(
    sessionId?: string,
    limit = 100,
    offset = 0,
  ): Promise<EvalRun[]> {
    if (sessionId) {
      return this.repository.getRunsBySession(sessionId);
    }
    return this.repository.listRuns(limit, offset);
  }

  async getRunSteps(runId: string): Promise<EvalStep[]> {
    return this.repository.getStepsByRun(runId);
  }

  async getSessionSummary(sessionId: string) {
    return this.repository.getSessionSummary(sessionId);
  }

  // ── SSE Stream Registration ───────────────────────────────────────────

  registerStream(sessionId: string, res: import("express").Response): void {
    sseStreamManager.register(sessionId, res);
  }

  // ── Internal Event Handling ───────────────────────────────────────────

  private handleEvent(event: EvalEvent): void {
    const sessionId = "session_id" in event ? event.session_id : null;
    if (!sessionId) {
      logger.warn(
        `[EvalService] handleEvent: dropping event type=${event.type} — no session_id`,
        "eval",
      );
      return;
    }

    const stepInfo =
      event.type === "step"
        ? ` step=${event.step} hasGrid=${!!event.grid}`
        : "";
    logger.info(
      `[EvalService] handleEvent: type=${event.type} session=${sessionId}${stepInfo}`,
      "eval",
    );

    sseStreamManager.sendEvent(sessionId, `eval.${event.type}`, event);

    const session = this.activeSessions.get(sessionId);
    this.persistEvent(event).catch((error) => {
      if (session) {
        session.persistFailureCount += 1;
        logger.error(
          `[EvalService] Failed to persist ${event.type} event (${session.persistFailureCount} total for session ${sessionId}): ${error}`,
          "eval",
        );
        if (
          session.persistFailureCount >= 10 &&
          !session.persistFailureWarned
        ) {
          session.persistFailureWarned = true;
          logger.warn(
            `[EvalService] DB persistence degraded for session ${sessionId}: ${session.persistFailureCount} events failed. Step data may be incomplete.`,
            "eval",
          );
        }
      } else {
        logger.error(
          `[EvalService] Failed to persist ${event.type} event (session ${sessionId} not found): ${error}`,
          "eval",
        );
      }
    });
  }

  private async persistEvent(event: EvalEvent): Promise<void> {
    if (!isDatabaseConnected()) return;
    switch (event.type) {
      case "run_start": {
        await this.repository.createRun({
          id: event.run_id,
          sessionId: event.session_id,
          model: event.model,
          modelKey: event.model_key,
          gameId: event.game_id,
          gameType: event.game_type,
          runNumber: event.run_number,
          seed: event.seed,
          maxSteps: event.max_steps,
        });
        break;
      }
      case "step": {
        await this.repository.createStep({
          runId: event.run_id,
          step: event.step,
          action: event.action,
          score: event.score ?? null,
          level: event.level ?? null,
          totalLevels: event.total_levels ?? null,
          state: event.state,
          inputTokens: event.input_tokens ?? 0,
          outputTokens: event.output_tokens ?? 0,
          costUsd: event.step_cost_usd ?? null,
          cumulativeCostUsd: event.cumulative_cost_usd ?? null,
        });
        break;
      }
      case "run_end": {
        await this.repository.updateRun(event.run_id, {
          totalSteps: event.total_steps,
          finalScore: event.final_score,
          solved: event.solved,
          levelsCompleted: event.levels_completed ?? undefined,
          totalLevels: event.total_levels ?? undefined,
          costUsd: event.cost_usd ?? undefined,
          totalInputTokens: event.total_input_tokens,
          totalOutputTokens: event.total_output_tokens,
          totalReasoningTokens: event.total_reasoning_tokens,
          elapsedSeconds: event.elapsed_seconds,
          error: event.error ?? undefined,
        });
        break;
      }
      case "session_end": {
        // EvalSessionEndEvent has no status field — session_end means 'completed'
        await this.repository.updateSessionStatus(
          event.session_id,
          "completed",
          {
            totalRuns: event.total_runs,
            totalSteps: event.total_steps,
            totalCostUsd: event.total_cost_usd,
            completedAt: new Date(),
          },
        );
        if (sseStreamManager.has(event.session_id)) {
          sseStreamManager.close(event.session_id, {
            total_runs: event.total_runs,
            total_cost_usd: event.total_cost_usd,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleSessionComplete(
    sessionId: string,
    result: SessionResult,
  ): Promise<void> {
    logger.info(
      `[EvalService] Session ${sessionId} completed: status=${result.status}, cost=$${result.totalCost}`,
      "eval",
    );

    try {
      await this.repository.updateSessionStatus(sessionId, result.status, {
        totalRuns: result.results.length,
        totalCostUsd: result.totalCost,
        completedAt: result.completedAt,
      });
    } catch (error) {
      logger.error(
        `[EvalService] Failed to update completed session ${sessionId}: ${error}`,
        "eval",
      );
    }
  }

  private async handleSessionError(
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `[EvalService] Session ${sessionId} failed: ${message}`,
      "eval",
    );

    try {
      await this.repository.updateSessionStatus(sessionId, "error", {
        completedAt: new Date(),
      });
    } catch (dbError) {
      logger.error(
        `[EvalService] Failed to update error status for ${sessionId}: ${dbError}`,
        "eval",
      );
    }

    if (sseStreamManager.has(sessionId)) {
      sseStreamManager.error(sessionId, "SESSION_ERROR", message);
    }
  }
}

export const evalService = new EvalService();
