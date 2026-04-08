import type {
  GameAdapter,
  BaseEvalProvider,
  EvalConfig,
  StepRecord,
  RunRecord,
  GameState,
  ProviderMessage,
  ProviderResponse,
  EventEmitter,
  GameType,
  TokenPricing,
  NotepadState,
} from "@shared/eval-types";
import type { ChooseActionParams } from "@shared/providers/base";
import { stepRecordSchema, runRecordSchema } from "@shared/evalSchemas";
import { promises as fs } from "fs";
import path from "path";
import { ContextManager } from "./contextManager";
import { Notepad } from "./notepad";
import { buildSystemPrompt, buildTurnPrompt } from "./promptBuilder";
import {
  writeTraceHeader,
  writeTraceStep,
  writeTraceSkip,
  writeTraceFooter,
  buildTracePath,
  writeRawResponse,
  JsonlWriter,
  appendLogLine,
} from "../data/traceWriter";
import {
  isRateLimitError,
  isGeminiTransientError,
  isNonTransientError,
} from "./errorClassifiers";
import { serializedFileWrite } from "../utils/concurrency";
import { logger } from "../../../utils/logger";

// ─── Type-only aliases (satisfy import list; unused at runtime but aid docs) ─
// GameState, GameType, TokenPricing, ChooseActionParams are referenced here for
// completeness. Actual usage is through GameAdapter / BaseEvalProvider interfaces.

const TOKEN_CSV_HEADER =
  "run_id,model,game_id,run_number,step,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,cache_write_tokens,step_cost_usd,cumulative_cost_usd,action,score,state\n";
const TOKEN_SUMMARY_CSV_HEADER =
  "run_id,model,game_id,run_number,total_input_tokens,total_output_tokens,total_reasoning_tokens,total_cached_input_tokens,total_cache_write_tokens,total_cost_usd,total_steps,final_score,solved,elapsed_seconds\n";

/** RFC 4180-compliant CSV field escaping: wraps in double quotes if the value
 *  contains a comma, double-quote, or newline. Internal quotes are doubled. */
function escapeCsvField(value: unknown): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",") + "\n";
}

/** Cache of directories already created this process (avoids redundant mkdir). */
const csvDirsEnsured = new Set<string>();

/**
 * Append a CSV row, creating the file with header if it doesn't exist.
 * Uses the `wx` (exclusive create) flag to atomically create-with-header,
 * avoiding the TOCTOU race between access-check and write.
 * Writes are serialized per file path to prevent interleaved appends
 * from concurrent runs writing to the same CSV.
 */
async function appendCsv(
  filepath: string,
  header: string,
  row: string,
): Promise<void> {
  const dir = path.dirname(filepath);
  if (!csvDirsEnsured.has(dir)) {
    await fs.mkdir(dir, { recursive: true });
    csvDirsEnsured.add(dir);
  }
  await serializedFileWrite(filepath, async () => {
    try {
      // Attempt exclusive create: succeeds only if file does NOT exist.
      // Writes header + first row atomically — no window for a race.
      await fs.writeFile(filepath, header + row, { flag: "wx" });
      return;
    } catch (err: unknown) {
      // EEXIST means the file already exists — fall through to append.
      // Any other error (EACCES, ENOSPC, etc.) should propagate.
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "EEXIST"
        )
      ) {
        throw err;
      }
    }
    await fs.appendFile(filepath, row, "utf-8");
  });
}

/**
 * EvalRunner executes ONE game run for ONE model.
 * Multi-game / multi-model parallelism is the orchestrator's job.
 *
 * Ported from: eval_runner.py _execute_run() inner function
 */
export class EvalRunner {
  /** AbortController used to interrupt an in-progress run gracefully. */
  private abortController: AbortController = new AbortController();

  /**
   * Session ID propagated to all emitted events.
   * Set by the orchestrator after construction when it knows the session.
   */
  private sessionId: string;

  /**
   * @param game         Game adapter (owns Python subprocess / game state)
   * @param provider     LLM provider that chooses actions
   * @param config       Eval configuration (steps, retries, output dir, …)
   * @param eventEmitter Optional SSE/event callback for real-time monitoring
   * @param sessionId    Optional session ID for event correlation
   * @param withImages   Whether to include screenshots in turn prompts
   * @param logFilePath  Optional path to session log file for persistent logging
   */
  constructor(
    private readonly game: GameAdapter,
    private readonly provider: BaseEvalProvider,
    private readonly config: EvalConfig,
    private readonly eventEmitter?: EventEmitter,
    sessionId: string = "",
    private readonly withImages: boolean = false,
    private readonly logFilePath?: string,
  ) {
    this.sessionId = sessionId;
  }

  /**
   * Abort the current run. The running step loop will halt before starting
   * the next step. Any in-progress provider call will complete naturally
   * (network calls are not interruptible).
   */
  abort(): void {
    this.abortController.abort();
  }

  // ─── Main entry point ─────────────────────────────────────────────────────

  /**
   * Execute a single game run for the configured model and game.
   * Port of Python's `_execute_run()` inner function inside `run_single_game()`.
   *
   * Flow:
   *   1. Build system prompt (cached for repeated calls with same args)
   *   2. Create ContextManager + Notepad
   *   3. Reset game to initial state
   *   4. Step loop: render → prompt → LLM call → action → record
   *   5. Build and return RunRecord
   *
   * @param runIndex  0-indexed run index (run 1 → runIndex 0)
   * @param seed      Optional seed override; defaults to config.seedBase + runIndex
   */
  async runGame(runIndex: number, seed?: number): Promise<RunRecord> {
    const runSeed = seed ?? this.config.seedBase + runIndex;
    const runNumber = runIndex + 1;
    const runId = `${this.provider.modelName}_${this.game.gameId}_run${runNumber}`;

    // System prompt is cached by buildSystemPrompt() — safe to call per run
    const systemPrompt = buildSystemPrompt(
      this.game.gameType,
      this.config.maxSteps,
      this.config.contextWindow,
      this.withImages,
    );

    // config.contextWindow = game turns (per spec: "last N turns").
    // Each game turn produces 2 messages (user observation + assistant action),
    // so the sliding window over raw messages is 2x the turn count.
    const contextManager = new ContextManager({
      windowSize: this.config.contextWindow * 2,
      logger: (level, message) => this.emitLog(level, message),
    });
    const notepad = new Notepad();

    // Reset game to initial state before this run
    this.emitLog(
      "debug",
      `[EvalRunner] Resetting game ${this.game.gameId} for ${runId}...`,
    );
    await this.game.reset(runSeed);
    this.emitLog(
      "debug",
      `[EvalRunner] Game reset complete: ${this.game.gameId} for ${runId}`,
    );

    this.emitLog(
      "info",
      `[EvalRunner] Run starting: ${runId} model=${this.provider.modelName} game=${this.game.gameId} seed=${runSeed} (maxSteps=${this.config.maxSteps}, outputDir=${this.config.outputDir ? path.basename(this.config.outputDir) : "NONE"})`,
    );

    // ── Safety limits ─────────────────────────────────────────────────────────
    const maxSkips = this.config.maxConsecutiveSkips ?? 10;

    // ── Accumulators ─────────────────────────────────────────────────────────
    const runSteps: StepRecord[] = [];
    const startTime = Date.now();
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let totalCachedInputTokens = 0;
    let totalCacheWriteTokens = 0;
    let resetCount = 0;
    let resetAttempts = 0; // Count all RESET action attempts (before execution)
    let resetSuccesses = 0; // Count successful RESET executions only
    let consecutiveSkips = 0;
    let errorMsg: string | null = null;
    let lastStep = 0;

    // Trace file path (null if outputDir not configured)
    const tracePath = this.config.outputDir
      ? buildTracePath(
          this.config.outputDir,
          this.game.gameId,
          this.provider.modelName,
          runNumber,
        )
      : null;

    // Per-model subdirectory: {outputDir}/{gameId}/{SafeModel}/
    const safeModel = this.provider.modelName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const modelDir = this.config.outputDir
      ? path.join(this.config.outputDir, this.game.gameId, safeModel)
      : null;

    // Per-run steps file: {outputDir}/{gameId}/{SafeModel}/steps.jsonl
    const stepsWriter = modelDir
      ? new JsonlWriter(path.join(modelDir, "steps.jsonl"))
      : null;

    // Per-model runs file: {outputDir}/{gameId}/{SafeModel}/runs.jsonl
    const runsWriter = modelDir
      ? new JsonlWriter(path.join(modelDir, "runs.jsonl"))
      : null;

    // Per-step timing file: {outputDir}/{gameId}/{SafeModel}/timing.jsonl
    const timingWriter = modelDir
      ? new JsonlWriter(path.join(modelDir, "timing.jsonl"))
      : null;

    // Per-step token usage CSV: {outputDir}/{gameId}/{SafeModel}/token_usage.csv
    const tokenCsvPath = modelDir
      ? path.join(modelDir, "token_usage.csv")
      : null;

    // Per-run token usage summary CSV: {outputDir}/{gameId}/{SafeModel}/token_usage_summary.csv
    const tokenSummaryCsvPath = modelDir
      ? path.join(modelDir, "token_usage_summary.csv")
      : null;

    // ── Emit run_start ────────────────────────────────────────────────────────
    this.eventEmitter?.({
      type: "run_start",
      session_id: this.sessionId,
      run_id: runId,
      model: this.provider.modelName,
      model_key: this.provider.modelName,
      game_id: this.game.gameId,
      game_type: this.game.gameType,
      run_number: runNumber,
      seed: runSeed,
      max_steps: this.config.maxSteps,
      timestamp: new Date().toISOString(),
    });

    // Write trace header (first line of the per-run JSONL trace file)
    if (tracePath) {
      await writeTraceHeader(
        tracePath,
        runId,
        this.provider.modelName,
        this.game.gameId,
        this.game.gameType,
        runNumber,
        runSeed,
        this.config.maxSteps,
        systemPrompt,
      );
    }

    // ── Step loop ─────────────────────────────────────────────────────────────
    try {
      let step = 0;

      this.emitLog(
        "info",
        `[EvalRunner] Entering step loop: ${runId} (maxSteps=${this.config.maxSteps}, game.isDone=${this.game.isDone()})`,
      );

      while (step < this.config.maxSteps && !this.game.isDone()) {
        let apiCallMs: number | null = null;
        let gameStepMs: number | null = null;

        // Honour abort signal — clean exit between steps
        if (this.abortController.signal.aborted) {
          this.emitLog(
            "warn",
            `[EvalRunner] Abort detected at step ${step}: ${runId}`,
          );
          errorMsg = "Run aborted";
          break;
        }

        lastStep = step;

        // ── Render current game state ────────────────────────────────────────
        const textObs = this.game.renderText();
        const imageB64 = this.withImages
          ? await this.game.renderPngBase64()
          : null;
        const availableActions = this.game.getAvailableActions();

        // ── Build turn prompt ────────────────────────────────────────────────
        const turnPrompt = buildTurnPrompt(
          textObs,
          availableActions,
          notepad.read(),
          step,
          this.config.maxSteps,
        );

        // Dry-run: skip API calls entirely
        if (this.config.dryRun) {
          this.emitLog(
            "info",
            `[EvalRunner] [dry-run] Step ${step}: would call API`,
          );
          break;
        }

        // ── Build conversation context (sliding window + token budget) ────────
        const context =
          this.config.tokenBudget > 0
            ? contextManager.getContextWithinBudget(
                this.config.tokenBudget,
                systemPrompt,
                turnPrompt,
              )
            : contextManager.getContext();

        // Strip action descriptions ("UP - Move up" → "UP") to keep valid_actions
        // list concise and consistent with what the JSON schema documents
        const validActionKeys = availableActions.map(
          (a) => a.split(/\s+/)[0] ?? a,
        );

        // ── Call provider with retry ─────────────────────────────────────────
        let response: ProviderResponse;
        this.emitLog(
          "debug",
          `[EvalRunner] Step ${step}/${this.config.maxSteps}: calling provider ${this.provider.modelName}... (${runId})`,
        );
        try {
          const apiCallStart = Date.now();
          response = await this.callProviderWithRetry(
            systemPrompt,
            context,
            turnPrompt,
            validActionKeys,
            notepad.toState(),
            imageB64,
          );
          apiCallMs = Date.now() - apiCallStart;
          this.emitLog(
            "debug",
            `[EvalRunner] API response in ${apiCallMs}ms: action=${response.action} cost=$${response.costUsd.toFixed(4)} in=${response.inputTokens} out=${response.outputTokens} reasoning=${response.reasoningTokens} cached=${response.cachedInputTokens} (${runId} step=${step})`,
          );
        } catch (retryErr: unknown) {
          // All retry tiers exhausted — back off, do NOT increment step
          consecutiveSkips += 1;
          if (consecutiveSkips >= maxSkips) {
            errorMsg = `Terminated: ${consecutiveSkips} consecutive failures — model cannot produce valid actions`;
            this.emitLog("warn", `[EvalRunner] ${errorMsg}`);
            break;
          }
          const backoffSec = Math.min(
            Math.pow(this.config.retryBackoffBase, consecutiveSkips),
            this.config.retryMaxWait,
          );
          this.emitLog(
            "warn",
            `[EvalRunner] All retries exhausted (consecutiveSkips=${consecutiveSkips}/${maxSkips}): ` +
              `${String(retryErr)}. Backing off ${backoffSec.toFixed(0)}s...`,
          );

          await this.interruptibleSleep(backoffSec * 1000);
          if (this.abortController.signal.aborted) {
            errorMsg = "Run aborted";
            break;
          }
          continue; // no step increment
        }

        // ── Handle SKIP action ────────────────────────────────────────────────
        // Provider returned no usable action (parse failure / refusal).
        // Accumulate cost, feed rejection back into context, back off.
        // Terminates after maxConsecutiveSkips to prevent unbounded cost.
        if (response.action === "SKIP") {
          consecutiveSkips += 1;
          if (consecutiveSkips >= maxSkips) {
            // Accumulate cost for this final SKIP before breaking
            totalCost += response.costUsd;
            totalInputTokens += response.inputTokens;
            totalOutputTokens += response.outputTokens;
            totalReasoningTokens += response.reasoningTokens;
            totalCachedInputTokens += response.cachedInputTokens;
            totalCacheWriteTokens += response.cacheWriteTokens;
            errorMsg = `Terminated: ${consecutiveSkips} consecutive SKIPs — model cannot produce valid actions`;
            this.emitLog(
              "warn",
              `[EvalRunner] ${errorMsg} (cost=$${totalCost.toFixed(4)})`,
            );
            break;
          }

          // The API call was real — accumulate cost even for SKIPs
          totalCost += response.costUsd;
          totalInputTokens += response.inputTokens;
          totalOutputTokens += response.outputTokens;
          totalReasoningTokens += response.reasoningTokens;
          totalCachedInputTokens += response.cachedInputTokens;
          totalCacheWriteTokens += response.cacheWriteTokens;

          // Feed rejection back so model can self-correct on the next attempt
          contextManager.addTurn("user", turnPrompt);
          contextManager.addTurn(
            "assistant",
            `Action: SKIP\nReasoning: ${response.reasoning || "no usable action"}`,
          );
          contextManager.addTurn(
            "user",
            `ERROR: Your response could not be parsed into a valid action. ` +
              `Available actions are: ${availableActions.join(", ")}. ` +
              `Please respond with valid JSON: ` +
              `{"action": "<action>", "reasoning": "<why>", "notepad_update": "<updated notepad>"}`,
          );

          // Build and record the SKIP step for cost accounting (step counter unchanged)
          const skipRecord: StepRecord = this.buildStepRecord(
            runId,
            runNumber,
            step,
            "SKIP",
            response,
            textObs,
            totalCost,
            notepad,
          );
          runSteps.push(skipRecord);

          if (modelDir) {
            // Write SKIP to separate skips file to prevent duplicate step indices
            await writeTraceSkip(modelDir, skipRecord, imageB64 !== null);
          }

          if (timingWriter) {
            await timingWriter.append({
              run_id: runId,
              run_number: runNumber,
              step,
              api_call_ms: apiCallMs,
              game_step_ms: gameStepMs,
              timestamp: new Date().toISOString(),
            });
          }

          const skipBackoffSec = Math.min(
            Math.pow(this.config.retryBackoffBase, consecutiveSkips),
            this.config.retryMaxWait,
          );
          this.emitLog(
            "warn",
            `[EvalRunner] Provider returned SKIP (consecutiveSkips=${consecutiveSkips}): ` +
              `${response.reasoning || "unknown reason"}. Backing off ${skipBackoffSec.toFixed(0)}s...`,
          );

          await this.interruptibleSleep(skipBackoffSec * 1000);
          if (this.abortController.signal.aborted) {
            errorMsg = "Run aborted";
            break;
          }
          continue; // no step increment
        }

        // ── Update notepad ────────────────────────────────────────────────────
        if (response.notepadUpdate !== null) {
          notepad.update(response.notepadUpdate);
        }

        // ── Execute action in game engine ─────────────────────────────────────
        // Count RESET attempts before execution (for analytics)
        if (response.action.toUpperCase() === "RESET") {
          resetAttempts += 1;
        }

        try {
          const gameStepStart = Date.now();
          await this.game.step(response.action);
          gameStepMs = Date.now() - gameStepStart;
          this.emitLog(
            "debug",
            `[EvalRunner] Game step executed in ${gameStepMs}ms: action=${response.action} (${runId} step=${step})`,
          );

          // Count successful RESETs only (for analytics)
          if (response.action.toUpperCase() === "RESET") {
            resetCount += 1; // Legacy counter for backward compatibility
            resetSuccesses += 1;
          }
        } catch (actionErr: unknown) {
          // Game engine rejected the action (invalid action string)
          consecutiveSkips += 1;
          if (consecutiveSkips >= maxSkips) {
            errorMsg = `Terminated: ${consecutiveSkips} consecutive invalid actions — model cannot produce valid actions`;
            this.emitLog("warn", `[EvalRunner] ${errorMsg}`);
            break;
          }
          const actionBackoffSec = Math.min(
            Math.pow(this.config.retryBackoffBase, consecutiveSkips),
            this.config.retryMaxWait,
          );

          // Feed rejection back so model can self-correct
          contextManager.addTurn("user", turnPrompt);
          contextManager.addTurn(
            "assistant",
            `Action: ${response.action}\nReasoning: ${response.reasoning}`,
          );
          contextManager.addTurn(
            "user",
            `ERROR: Invalid action '${response.action}'. ` +
              `Available actions are: ${availableActions.join(", ")}. ` +
              `Choose ONLY from the listed actions.`,
          );

          this.emitLog(
            "warn",
            `[EvalRunner] Invalid action '${response.action}': ${String(actionErr)} ` +
              `(consecutiveSkips=${consecutiveSkips}). Backing off ${actionBackoffSec.toFixed(0)}s...`,
          );

          await this.interruptibleSleep(actionBackoffSec * 1000);
          if (this.abortController.signal.aborted) {
            errorMsg = "Run aborted";
            break;
          }
          continue; // no step increment
        }

        const newScore = this.game.getScore();

        // Successful step — reset consecutive skip counter
        consecutiveSkips = 0;

        // ── Update conversation context ───────────────────────────────────────
        contextManager.addTurn("user", turnPrompt);
        contextManager.addTurn(
          "assistant",
          `Action: ${response.action}\nReasoning: ${response.reasoning}`,
        );

        // ── Accumulate costs ──────────────────────────────────────────────────
        totalCost += response.costUsd;
        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;
        totalReasoningTokens += response.reasoningTokens;
        totalCachedInputTokens += response.cachedInputTokens;
        totalCacheWriteTokens += response.cacheWriteTokens;

        // ── Build step record ─────────────────────────────────────────────────
        const stepRecord: StepRecord = this.buildStepRecord(
          runId,
          runNumber,
          step,
          response.action,
          response,
          textObs,
          totalCost,
          notepad,
        );
        runSteps.push(stepRecord);

        // ── Emit step event ───────────────────────────────────────────────────
        this.eventEmitter?.({
          type: "step",
          session_id: this.sessionId,
          run_id: runId,
          model: this.provider.modelName,
          model_key: this.provider.modelName,
          game_id: this.game.gameId,
          game_type: this.game.gameType,
          run_number: runNumber,
          step,
          action: response.action,
          score: newScore,
          score_pct: stepRecord.scorePct,
          level: this.game.level,
          total_levels: this.game.totalLevels,
          done: this.game.isDone(),
          state: this.game.getState(),
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          reasoning_tokens: response.reasoningTokens,
          cached_input_tokens: response.cachedInputTokens,
          cache_write_tokens: response.cacheWriteTokens,
          step_cost_usd: response.costUsd,
          cumulative_cost_usd: totalCost,
          grid: this.game.getGrid(),
          reasoning: response.reasoning,
          notepad_contents: notepad.read(),
          timestamp: new Date().toISOString(),
        });

        this.emitLog(
          "info",
          `[EvalRunner] Step ${step}: action=${response.action} score=${newScore} scorePct=${stepRecord.scorePct}% cost=$${totalCost.toFixed(4)} in=${response.inputTokens} out=${response.outputTokens} reasoning=${response.reasoningTokens} (${runId})`,
        );

        // ── Write step data to disk (parallelized) ─────────────────────────
        // Raw response must be written first (trace step references its path).
        // The remaining writes (trace, steps JSONL, token CSV) are independent.
        let rawResponseFile: string | null = null;
        if (modelDir) {
          rawResponseFile = await writeRawResponse(
            modelDir,
            runNumber,
            step,
            response.rawResponse,
          );
        }

        const writePromises: Promise<void>[] = [];

        if (tracePath) {
          writePromises.push(
            writeTraceStep(
              tracePath,
              stepRecord,
              imageB64 !== null,
              rawResponseFile,
            ),
          );
        }

        if (stepsWriter) {
          writePromises.push(
            stepsWriter.append({
              run_id: runId,
              model: this.provider.modelName,
              game_id: this.game.gameId,
              game_type: this.game.gameType,
              run_number: runNumber,
              step,
              action: response.action,
              score: stepRecord.score,
              score_pct: stepRecord.scorePct,
              level: this.game.level,
              total_levels: this.game.totalLevels,
              done: this.game.isDone(),
              state: this.game.getState(),
              cumulative_cost_usd: totalCost,
              input_tokens: response.inputTokens,
              output_tokens: response.outputTokens,
              reasoning_tokens: response.reasoningTokens,
              cached_input_tokens: response.cachedInputTokens,
              cache_write_tokens: response.cacheWriteTokens,
              step_cost_usd: response.costUsd,
              notepad_length: notepad.read().length,
              reasoning: response.reasoning,
              observation: textObs,
              notepad_contents: notepad.read(),
              timestamp: new Date().toISOString(),
            }),
          );
        }

        if (tokenCsvPath) {
          const row = csvRow([
            runId, this.provider.modelName, this.game.gameId, runNumber,
            step, response.inputTokens, response.outputTokens, response.reasoningTokens,
            response.cachedInputTokens, response.cacheWriteTokens, response.costUsd,
            totalCost, response.action, newScore, this.game.getState(),
          ]);
          writePromises.push(appendCsv(tokenCsvPath, TOKEN_CSV_HEADER, row));
        }

        if (timingWriter) {
          writePromises.push(
            timingWriter.append({
              run_id: runId,
              run_number: runNumber,
              step,
              api_call_ms: apiCallMs,
              game_step_ms: gameStepMs,
              timestamp: new Date().toISOString(),
            }),
          );
        }

        if (writePromises.length > 0) {
          await Promise.all(writePromises);
        }

        if (this.game.isDone()) {
          break;
        }

        step += 1;
      }
    } catch (err: unknown) {
      errorMsg =
        err instanceof Error
          ? `${err.constructor.name}: ${err.message}`
          : String(err);
      this.emitLog(
        "warn",
        `[EvalRunner] Error in step loop for ${runId}: ${errorMsg}`,
      );
      this.eventEmitter?.({
        type: "error",
        session_id: this.sessionId,
        run_id: `${this.provider.modelName}_${this.game.gameId}_run${runNumber}`,
        model: this.provider.modelName,
        game_id: this.game.gameId,
        message: errorMsg,
        code: "EVAL_RUNNER_ERROR",
        timestamp: new Date().toISOString(),
      });
    }

    // ── Build run record ──────────────────────────────────────────────────────
    const endTime = Date.now();
    const elapsedSeconds = Math.round((endTime - startTime) / 100) / 10;

    const runRecord: RunRecord = {
      runId,
      model: this.provider.modelName,
      gameId: this.game.gameId,
      gameType: this.game.gameType,
      runNumber,
      totalSteps: lastStep + 1,
      maxSteps: this.config.maxSteps,
      finalScore: Number.isFinite(this.game.getScore())
        ? Math.min(Math.max(0, this.game.getScore()), 1.0)
        : 0,
      solved: this.game.getState() === "WIN",
      levelsCompleted: this.game.level,
      totalLevels: this.game.totalLevels,
      costUsd: totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalReasoningTokens,
      elapsedSeconds,
      notepadFinal: notepad.read(),
      error: errorMsg,
      modelId: this.provider.modelId,
      seed: runSeed,
      finalScorePct:
        this.game.winScore > 0
          ? Math.round((this.game.getScore() / this.game.winScore) * 10000) /
            100
          : 0,
      totalCachedInputTokens,
      totalCacheWriteTokens,
      resetCount,
      resetAttempts,
      resetSuccesses,
    };
    runRecordSchema.parse(runRecord);

    // ── Emit run_end ──────────────────────────────────────────────────────────
    this.emitLog(
      "info",
      `[EvalRunner] Run complete: ${runId} score=${runRecord.finalScore} scorePct=${runRecord.finalScorePct}% solved=${runRecord.solved} steps=${runRecord.totalSteps} cost=$${totalCost.toFixed(4)} tokens=${totalInputTokens + totalOutputTokens + totalReasoningTokens} elapsed=${elapsedSeconds}s`,
    );
    this.eventEmitter?.({
      type: "run_end",
      session_id: this.sessionId,
      run_id: runId,
      model: this.provider.modelName,
      model_key: this.provider.modelName,
      game_id: this.game.gameId,
      game_type: this.game.gameType,
      run_number: runNumber,
      total_steps: runRecord.totalSteps,
      final_score: runRecord.finalScore,
      final_score_pct: runRecord.finalScorePct,
      solved: runRecord.solved,
      levels_completed: runRecord.levelsCompleted,
      total_levels: runRecord.totalLevels,
      cost_usd: totalCost,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_reasoning_tokens: totalReasoningTokens,
      elapsed_seconds: elapsedSeconds,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });

    // Write trace footer (last line of the JSONL trace file)
    if (tracePath) {
      await writeTraceFooter(tracePath, runRecord);
    }

    // Write run record to shared runs.jsonl (one line per completed run)
    if (runsWriter) {
      await runsWriter.append({
        type: "run_complete",
        run_id: runRecord.runId,
        model: runRecord.model,
        game_id: runRecord.gameId,
        game_type: runRecord.gameType,
        run_number: runRecord.runNumber,
        total_steps: runRecord.totalSteps,
        max_steps: runRecord.maxSteps,
        final_score: runRecord.finalScore,
        solved: runRecord.solved,
        levels_completed: runRecord.levelsCompleted,
        total_levels: runRecord.totalLevels,
        cost_usd: runRecord.costUsd,
        total_input_tokens: runRecord.totalInputTokens,
        total_output_tokens: runRecord.totalOutputTokens,
        total_reasoning_tokens: runRecord.totalReasoningTokens,
        elapsed_seconds: runRecord.elapsedSeconds,
        error: runRecord.error,
        model_id: runRecord.modelId,
        seed: runRecord.seed,
        final_score_pct: runRecord.finalScorePct,
        total_cached_input_tokens: runRecord.totalCachedInputTokens,
        total_cache_write_tokens: runRecord.totalCacheWriteTokens,
        reset_count: runRecord.resetCount,
        timestamp: new Date().toISOString(),
      });
    }

    // Write per-run token usage summary CSV
    if (tokenSummaryCsvPath) {
      const summaryRow = csvRow([
        runRecord.runId, runRecord.model, runRecord.gameId, runRecord.runNumber,
        runRecord.totalInputTokens, runRecord.totalOutputTokens, runRecord.totalReasoningTokens,
        runRecord.totalCachedInputTokens, runRecord.totalCacheWriteTokens, runRecord.costUsd,
        runRecord.totalSteps, runRecord.finalScore, runRecord.solved, runRecord.elapsedSeconds,
      ]);
      await appendCsv(
        tokenSummaryCsvPath,
        TOKEN_SUMMARY_CSV_HEADER,
        summaryRow,
      );
    }

    return runRecord;
  }

  // ─── Retry logic ──────────────────────────────────────────────────────────

  /**
   * Call the provider with 3-tier exponential backoff retry.
   * Ported from Python's `_call_provider_with_retry()` standalone function.
   *
   * Tier 1: Rate limit (any provider, 429) → wait until next minute boundary
   * Tier 2: Gemini transient errors (504/503, RESOURCE_EXHAUSTED) → 30-60s cooldown
   * Tier 3: All other errors → exponential backoff capped at retryMaxWait
   *
   * The `validActions` list passed here contains bare keywords only (no descriptions),
   * consistent with the Python source which strips descriptions before passing to provider.
   */
  private async callProviderWithRetry(
    systemPrompt: string,
    context: ProviderMessage[],
    turnPrompt: string,
    validActions: string[],
    notepad: NotepadState,
    imageB64: string | null,
  ): Promise<ProviderResponse> {
    const NON_TRANSIENT_MAX_RETRIES = 3;
    let lastError: unknown;
    let nonTransientCount = 0;

    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      if (this.abortController.signal.aborted) {
        throw new Error("Run aborted");
      }

      try {
        // BaseEvalProvider.chooseAction uses positional args (eval-types.ts interface)
        return await this.provider.chooseAction(
          systemPrompt,
          context,
          turnPrompt,
          validActions,
          notepad,
          imageB64,
        );
      } catch (err: unknown) {
        lastError = err;

        // No more retries remaining — fall through to throw below
        if (attempt >= this.config.retryAttempts - 1) break;

        // Non-transient errors (401/403/404/bad config) get max 3 retries then fail fast
        if (isNonTransientError(err)) {
          nonTransientCount++;
          if (nonTransientCount >= NON_TRANSIENT_MAX_RETRIES) {
            this.emitLog(
              "warn",
              `[EvalRunner] Non-transient error after ${nonTransientCount} attempts — failing fast: ${String(err)}`,
            );
            break;
          }
          const waitMs = 2000 * nonTransientCount;
          this.emitLog(
            "warn",
            `[EvalRunner] Non-transient error (attempt ${nonTransientCount}/${NON_TRANSIENT_MAX_RETRIES}): ` +
              `${String(err)}. Retrying in ${(waitMs / 1000).toFixed(0)}s...`,
          );
          await this.interruptibleSleep(waitMs);
          if (this.abortController.signal.aborted) {
            throw new Error("Run aborted");
          }
          continue;
        }

        let waitMs: number;

        if (isRateLimitError(err)) {
          // Tier 1: Rate limit — align retry to next minute boundary
          waitMs = this.computeMinuteBoundaryWait();
          this.emitLog(
            "warn",
            `[EvalRunner] Rate limit hit: ${String(err)}. ` +
              `Waiting ${(waitMs / 1000).toFixed(0)}s until next minute boundary... ` +
              `(attempt ${attempt + 1}/${this.config.retryAttempts})`,
          );
        } else if (isGeminiTransientError(err)) {
          // Tier 2: Gemini transient — moderate 30-60s cooldown
          waitMs = (30 + Math.random() * 30) * 1000;
          this.emitLog(
            "warn",
            `[EvalRunner] Gemini transient error (504/503): ${String(err)}. ` +
              `Retrying in ${(waitMs / 1000).toFixed(1)}s... ` +
              `(attempt ${attempt + 1}/${this.config.retryAttempts})`,
          );
        } else {
          // Tier 3: General error — exponential backoff with jitter
          const rawWaitSec =
            Math.pow(this.config.retryBackoffBase, attempt) *
            (0.5 + Math.random());
          waitMs = Math.min(rawWaitSec, this.config.retryMaxWait) * 1000;
          this.emitLog(
            "warn",
            `[EvalRunner] API call failed (attempt ${attempt + 1}/${this.config.retryAttempts}): ` +
              `${String(err)}. Retrying in ${(waitMs / 1000).toFixed(1)}s...`,
          );
        }

        await this.interruptibleSleep(waitMs);
        if (this.abortController.signal.aborted) {
          throw new Error("Run aborted");
        }
      }
    }

    throw new Error(
      `[EvalRunner] All ${this.config.retryAttempts} retry attempts failed: ${String(lastError)}`,
    );
  }

  // ─── Timing helpers ───────────────────────────────────────────────────────

  /**
   * Compute milliseconds to wait until the next minute boundary + jitter.
   * TPM rate limits refill on minute boundaries; aligning retries minimises waste.
   *
   * If the next boundary is <5s away, skip to the one after (bucket may not be full).
   * Adds 5-45s jitter to prevent thundering herd when multiple runners hit limits.
   *
   * Mirrors Python's `_compute_minute_boundary_wait()`.
   */
  private computeMinuteBoundaryWait(): number {
    const nowSec = Date.now() / 1000;
    let secondsToNext = 60 - (nowSec % 60);

    if (secondsToNext < 5) {
      // Too close to boundary — the token bucket may not be fully refilled yet
      secondsToNext += 60;
    }

    // 5-45s jitter to spread retries across the minute boundary
    const jitterSec = 5 + Math.random() * 40;
    return (secondsToNext + jitterSec) * 1000;
  }

  /**
   * Sleep for `ms` milliseconds. Resolves immediately if the abort signal fires,
   * allowing the step loop to exit cleanly without waiting for the full sleep.
   * Mirrors Python's `_interruptible_sleep()`.
   */
  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        // Normal timeout — remove the abort listener to prevent leak
        this.abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      // Add listener FIRST to avoid race condition
      this.abortController.signal.addEventListener("abort", onAbort, {
        once: true,
      });

      // THEN check if already aborted (handles case where abort() called
      // between promise creation and listener registration)
      if (this.abortController.signal.aborted) {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      }
    });
  }

  // ─── Record builders ──────────────────────────────────────────────────────

  /**
   * Assemble a StepRecord from the current game state and provider response.
   * Called for both successful steps and SKIP-accounting records.
   *
   * @param step           0-indexed step number
   * @param action         The action taken (or 'SKIP')
   * @param response       Full provider response
   * @param observation    Text observation shown to the model this step
   * @param cumulativeCost Running total cost including this step
   * @param notepad        Current notepad instance (for contents + length)
   */
  private buildStepRecord(
    runId: string,
    runNumber: number,
    step: number,
    action: string,
    response: ProviderResponse,
    observation: string,
    cumulativeCost: number,
    notepad: Notepad,
  ): StepRecord {
    const rawScore = this.game.getScore();
    const score = Number.isFinite(rawScore)
      ? Math.min(Math.max(0, rawScore), 1.0)
      : 0;
    const record: StepRecord = {
      runId,
      model: this.provider.modelName,
      gameId: this.game.gameId,
      gameType: this.game.gameType,
      runNumber,
      step,
      action,
      score,
      level: this.game.level,
      totalLevels: this.game.totalLevels,
      done: action === "SKIP" ? false : this.game.isDone(),
      state: this.game.getState(),
      cumulativeCostUsd: cumulativeCost,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      notepadLength: notepad.read().length,
      reasoning: response.reasoning,
      notepadContents: notepad.read(),
      observation,
      scorePct:
        this.game.winScore > 0
          ? Math.round((score / this.game.winScore) * 10000) / 100
          : 0,
      stepCostUsd: response.costUsd,
      reasoningTokens: response.reasoningTokens,
      thinkingText: response.thinkingText ?? null,
      cachedInputTokens: response.cachedInputTokens,
      cacheWriteTokens: response.cacheWriteTokens,
    };
    stepRecordSchema.parse(record);
    return record;
  }

  // ─── Logging helper ───────────────────────────────────────────────────────

  /**
   * Emit a structured log event via the event emitter AND write to console.
   * Dual-output ensures retry failures and step progress are visible both in
   * the terminal (for developers) and in SSE (for the frontend dashboard).
   */
  private emitLog(level: "info" | "warn" | "debug", message: string): void {
    // Always write to console so retry failures are visible in terminal
    if (level === "warn") {
      logger.warn(message, 'eval-runner');
    } else if (level === "debug") {
      // debug is noisy — only log when NODE_DEBUG or similar is set
    } else {
      logger.info(message, 'eval-runner');
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
          `[EvalRunner] Log write failed: ${err instanceof Error ? err.message : String(err)}`,
          'eval-runner',
        );
      });
    }
  }
}

/**
 * Convenience factory — creates an EvalRunner and executes a single run.
 * Useful for one-shot evaluation without holding a runner instance.
 *
 * @param game       Game adapter
 * @param provider   LLM provider
 * @param config     Eval configuration
 * @param runIndex   0-indexed run number
 * @param options    Optional: seed, eventEmitter, sessionId, withImages, logFilePath
 */
export async function runSingleGame(
  game: GameAdapter,
  provider: BaseEvalProvider,
  config: EvalConfig,
  runIndex: number,
  options?: {
    seed?: number;
    eventEmitter?: EventEmitter;
    sessionId?: string;
    withImages?: boolean;
    logFilePath?: string;
  },
): Promise<RunRecord> {
  const runner = new EvalRunner(
    game,
    provider,
    config,
    options?.eventEmitter,
    options?.sessionId ?? "",
    options?.withImages ?? false,
    options?.logFilePath,
  );
  return runner.runGame(runIndex, options?.seed);
}
