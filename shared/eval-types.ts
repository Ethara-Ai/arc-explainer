// ─── Game State ──────────────────────────────────────────────────────────────

/** Game lifecycle state — matches Python BaseGameAdapter.get_state() */
export type GameState = "NOT_PLAYED" | "IN_PROGRESS" | "WIN" | "GAME_OVER";

/** Game type identifier */
export type GameType = "arc2" | "arc3";

// ─── Provider Types ──────────────────────────────────────────────────────────

/** Role for conversation history messages sent to LLM providers */
export type ProviderRole = "user" | "assistant" | "system";

/** Single message in the conversation history passed to a provider */
export interface ProviderMessage {
  role: ProviderRole;
  content: string;
}

/**
 * Response from an LLM provider after choosing an action.
 * Ported from: base.py ProviderResponse dataclass
 */
export interface ProviderResponse {
  action: string;
  reasoning: string;
  notepadUpdate: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  thinkingText: string | null;
  costUsd: number;
  rawResponse: Record<string, unknown> | null;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  trafficType: string | null;
}

/**
 * Provider identifier — must match keys used in MODEL_REGISTRY / providerFactory
 * Ported from: config.py provider field in ModelConfig
 */
export type ProviderKey =
  | "openai"
  | "gemini"
  | "claude-cloud"
  | "kimi-cloud";

// ─── Token Pricing ───────────────────────────────────────────────────────────

/**
 * Per-model token pricing tiers (per million tokens).
 * Ported from: pricing.py TokenPricing dataclass
 *
 * Standard rates apply up to longContextThreshold tokens.
 * Long-context rates apply beyond that threshold (0 = no tiered pricing).
 */
export interface TokenPricing {
  inputPerM: number;
  outputPerM: number;
  reasoningPerM: number;
  cachedInputPerM: number;
  cacheWritePerM: number;
  longContextThreshold: number;
  longInputPerM: number;
  longOutputPerM: number;
  longReasoningPerM: number;
  longCachedInputPerM: number;
  longCacheWritePerM: number;
}

// ─── Model Configuration ─────────────────────────────────────────────────────

/**
 * Configuration for a single LLM model.
 * Ported from: config.py ModelConfig dataclass
 */
export interface ModelConfig {
  /** Human-readable display name (e.g. "GPT-5.4 Thinking") */
  name: string;
  /** Provider-specific model identifier (e.g. "gpt-5.4-0227") */
  modelId: string;
  /** Which provider implementation to use */
  provider: ProviderKey;
  /** Environment variable name holding the API key */
  envKey: string;
  /** Optional base URL override for the provider API */
  baseUrl: string | null;
  /** Whether the model accepts image input */
  supportsVision: boolean;
  /** Maximum context window in tokens */
  maxContextTokens: number;
  /** Reasoning effort hint (provider-specific, e.g. "high") */
  reasoningEffort: string | null;
  /** Override key for pricing lookup (defaults to model key) */
  pricingModelId: string | null;
  /** Maximum output tokens per request */
  maxOutputTokens: number;
  /** Extra headers to include in API requests */
  additionalHeaders: Record<string, string> | null;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Whether to use Vertex AI (Gemini) */
  vertexai: boolean;
  /** GCP project ID (Vertex AI only) */
  gcpProject: string | null;
  /** GCP region (Vertex AI only) */
  gcpLocation: string;
}

/** Chart color assignment per model key — used by frontend charts */
export type ModelColors = Record<string, string>;

// ─── Eval Configuration ──────────────────────────────────────────────────────

/**
 * Top-level evaluation run configuration.
 * Ported from: config.py EvalConfig dataclass
 */
export interface EvalConfig {
  /** Maximum steps per game run before forced termination */
  maxSteps: number;
  /** Number of runs per model-game combination */
  numRuns: number;
  /** Sliding window size for context manager */
  contextWindow: number;
  /** Base seed for reproducible runs (run N uses seedBase + N) */
  seedBase: number;
  /** Root output directory for traces and results */
  outputDir: string;
  /** If true, validate config without actually running evaluations */
  dryRun: boolean;
  /** Max retry attempts for transient provider errors */
  retryAttempts: number;
  /** Exponential backoff base in seconds */
  retryBackoffBase: number;
  /** Maximum wait between retries in seconds */
  retryMaxWait: number;
  /** Maximum consecutive skips/failures before aborting a run (prevents infinite loop) */
  maxConsecutiveSkips: number;
  /** Whether to persist raw LLM responses in trace files */
  saveRawResponses: boolean;
  /** Token budget for context trimming (model context tokens - reserved output tokens). 0 = disabled. */
  tokenBudget: number;
  /** Per-provider concurrency limits (provider key -> max concurrent) */
  providerMaxConcurrent: Record<string, number>;
}

/**
 * Session-level config passed from the frontend when starting an eval.
 * Subset of EvalConfig + game/model selection.
 */
export interface EvalSessionConfig {
  /** Which games to evaluate (game IDs) */
  gameIds: string[];
  /** Which models to evaluate (model registry keys) */
  modelKeys: string[];
  /** Number of runs per model-game pair */
  numRuns: number;
  /** Maximum steps per run */
  maxSteps: number;
  /** Base seed for reproducibility */
  seedBase: number;
  /** Context window size */
  contextWindow: number;
  /** Whether to include screenshot images in prompts */
  withImages: boolean;
  /** Override environment_files/ root directory (--game-dir flag) */
  envDir?: string;
}

// ─── Game Metadata ───────────────────────────────────────────────────────────

/**
 * Static metadata about a game — returned by GET /api/eval/games.
 * Ported from: game_adapter.py BaseGameAdapter properties
 */
export interface GameMetadata {
  gameId: string;
  gameType: GameType;
  title: string;
  totalLevels: number | null;
  availableActions: string[];
}

// ─── Step Record ─────────────────────────────────────────────────────────────

/**
 * Record of a single evaluation step within a run.
 * Ported from: schemas.py StepRecord dataclass (22 fields)
 *
 * Stored in DB (evalSteps table — subset of fields) and trace files (all fields).
 */
export interface StepRecord {
  runId: string;
  model: string;
  gameId: string;
  gameType: GameType;
  runNumber: number;
  step: number;
  action: string;
  /** Normalized score 0.0–1.0 */
  score: number;
  level: number | null;
  totalLevels: number | null;
  done: boolean;
  state: GameState;
  cumulativeCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  notepadLength: number;
  reasoning: string;
  notepadContents: string;
  observation: string;
  /** Score as percentage 0–100 */
  scorePct: number;
  stepCostUsd: number;
  reasoningTokens: number;
  thinkingText: string | null;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/**
 * Subset of StepRecord for SSE events — omits large text fields.
 * Matches Python StepRecord.to_event_dict()
 */
export interface StepEventData {
  runId: string;
  model: string;
  gameId: string;
  gameType: GameType;
  runNumber: number;
  step: number;
  action: string;
  score: number;
  level: number | null;
  totalLevels: number | null;
  done: boolean;
  state: GameState;
  cumulativeCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  scorePct: number;
  stepCostUsd: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

// ─── Run Record ──────────────────────────────────────────────────────────────

/**
 * Summary record for a complete evaluation run (one model + one game + one seed).
 * Ported from: schemas.py RunRecord dataclass (20+ fields)
 */
export interface RunRecord {
  runId: string;
  model: string;
  gameId: string;
  gameType: GameType;
  runNumber: number;
  totalSteps: number;
  maxSteps: number;
  /** Final score 0.0–1.0 */
  finalScore: number;
  solved: boolean;
  levelsCompleted: number | null;
  totalLevels: number | null;
  costUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  elapsedSeconds: number;
  notepadFinal: string;
  error: string | null;
  modelId: string;
  seed: number;
  /** Score as percentage 0–100 */
  finalScorePct: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  resetCount: number;
  /** Number of RESET action attempts (counted before execution) */
  resetAttempts: number;
  /** Number of successful RESET executions (counted after success) */
  resetSuccesses: number;
}

/**
 * Subset of RunRecord for SSE events — matches Python RunRecord.to_event_dict()
 */
export interface RunEventData {
  runId: string;
  model: string;
  gameId: string;
  gameType: GameType;
  runNumber: number;
  totalSteps: number;
  maxSteps: number;
  finalScore: number;
  solved: boolean;
  levelsCompleted: number | null;
  totalLevels: number | null;
  costUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  elapsedSeconds: number;
  error: string | null;
  finalScorePct: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  resetCount: number;
}

// ─── Trace Records (JSONL) ──────────────────────────────────────────────────

/** Header record — first line of a trace JSONL file */
export interface TraceHeader {
  type: "header";
  schemaVersion: number;
  runId: string;
  model: string;
  gameId: string;
  gameType: GameType;
  runNumber: number;
  seed: number;
  maxSteps: number;
  systemPrompt: string;
  timestamp: string;
}

/** Step record in trace file — includes image_sent flag */
export interface TraceStep {
  type: "step";
  step: number;
  action: string;
  score: number;
  scorePct: number;
  level: number | null;
  totalLevels: number | null;
  done: boolean;
  state: GameState;
  reasoning: string;
  observation: string;
  notepadContents: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  thinkingText: string | null;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  stepCostUsd: number;
  cumulativeCostUsd: number;
  imageSent: boolean;
  /** Relative path to the raw API response JSON file, or null if not saved */
  rawResponseFile: string | null;
  timestamp: string;
}

/** Summary record — last line of a trace JSONL file */
export interface TraceSummary {
  type: "summary";
  runId: string;
  model: string;
  gameId: string;
  gameType: GameType;
  runNumber: number;
  totalSteps: number;
  finalScore: number;
  finalScorePct: number;
  solved: boolean;
  costUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  elapsedSeconds: number;
  error: string | null;
  timestamp: string;
}

/** Discriminated union for all trace record types */
export type TraceRecord = TraceHeader | TraceStep | TraceSummary;

// ─── SSE Event Types (eval.* namespace) ──────────────────────────────────────

export interface EvalSessionStartEvent {
  type: "session_start";
  session_id: string;
  game_ids: string[];
  model_keys: string[];
  parallel: boolean;
  models: string[];
  num_runs: number;
  max_steps: number;
  total_runs: number;
  timestamp: string;
}

export interface EvalRunStartEvent {
  type: "run_start";
  session_id: string;
  run_id: string;
  model: string;
  model_key: string;
  game_id: string;
  game_type: GameType;
  run_number: number;
  seed: number;
  max_steps: number;
  timestamp: string;
}

export interface EvalStepEvent {
  type: "step";
  session_id: string;
  run_id: string;
  model: string;
  model_key: string;
  game_id: string;
  game_type: GameType;
  run_number: number;
  step: number;
  action: string;
  score: number;
  score_pct: number;
  level: number | null;
  total_levels: number | null;
  done: boolean;
  state: GameState;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  step_cost_usd: number;
  cumulative_cost_usd: number;
  /** Raw grid data from the game adapter (2D or 3D array of cell colors 0-15) */
  grid?: number[][] | number[][][] | null;
  /** Model reasoning text for this step */
  reasoning?: string;
  /** Current notepad contents after this step */
  notepad_contents?: string;
  timestamp: string;
}

export interface EvalRunEndEvent {
  type: "run_end";
  session_id: string;
  run_id: string;
  model: string;
  model_key: string;
  game_id: string;
  game_type: GameType;
  run_number: number;
  total_steps: number;
  final_score: number;
  final_score_pct: number;
  solved: boolean;
  levels_completed: number | null;
  total_levels: number | null;
  cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  elapsed_seconds: number;
  error: string | null;
  timestamp: string;
}

export interface EvalSessionEndEvent {
  type: "session_end";
  session_id: string;
  total_runs: number;
  total_steps: number;
  total_cost_usd: number;
  elapsed_seconds: number;
  timestamp: string;
}

export interface EvalModelDoneEvent {
  type: "model_done";
  session_id: string;
  model: string;
  model_key: string;
  game_id: string;
  status: "completed" | "failed";
  avg_score: number;
  avg_score_pct: number;
  solved_count: number;
  total_runs: number;
  scores: number[];
  score_stddev: number;
  total_cost_usd: number;
  completed_models: number;
  total_models: number;
  timestamp: string;
}

export interface EvalErrorEvent {
  type: "error";
  session_id: string;
  run_id: string | null;
  model: string | null;
  game_id: string | null;
  message: string;
  code: string;
  timestamp: string;
}

export interface EvalLogEvent {
  type: "log";
  session_id: string;
  level: "info" | "warn" | "debug";
  message: string;
  timestamp: string;
}

/** Discriminated union of all SSE event types */
export type EvalEvent =
  | EvalSessionStartEvent
  | EvalRunStartEvent
  | EvalStepEvent
  | EvalRunEndEvent
  | EvalSessionEndEvent
  | EvalModelDoneEvent
  | EvalErrorEvent
  | EvalLogEvent;

/** SSE event type string literals */
export type EvalEventType = EvalEvent["type"];

// ─── Orchestrator Types ──────────────────────────────────────────────────────

/**
 * Orchestrator-level configuration.
 * Ported from: orchestrator.py OrchestratorConfig frozen dataclass
 */
export interface OrchestratorConfig {
  /** Max games running in parallel */
  parallelGames: number;
  /** Global budget cap in USD (0 = unlimited) */
  budgetGlobalUsd: number;
  /** Per-game budget cap in USD (0 = unlimited) */
  budgetPerGameUsd: number;
  /** Circuit breaker: consecutive failures before tripping */
  circuitThreshold: number;
  /** Seconds before half-opening a tripped circuit */
  circuitHalfOpenSeconds: number;
  /** If true, run models sequentially instead of in parallel */
  sequentialModels: boolean;
  /** Max parallel runs per model-game combination */
  parallelRuns: number;
  /** Whether to skip already-completed runs when resuming */
  resumeCompleted: boolean;
  /** Whether to include screenshots in prompts */
  withImages: boolean;
}

/**
 * Result summary for one model's evaluation of one game.
 * Ported from: orchestrator.py GameModelResult frozen dataclass
 */
export interface GameModelResult {
  gameId: string;
  modelKey: string;
  /** Total steps across all runs */
  runSteps: number;
  /** Total cost across all runs */
  runCost: number;
  /** Average score across all runs (0.0–1.0) */
  avgScore: number;
  /** Number of runs that achieved solved=true */
  solvedCount: number;
  /** Total number of runs completed */
  totalRuns: number;
  /** Individual run scores (one per completed run, 0.0–1.0) */
  scores: number[];
  /** Population standard deviation of scores (0 when ≤1 run) */
  scoreStddev: number;
  /** Error message if the model-game combination failed */
  error: string | null;
}

// ─── Runner Support Types ────────────────────────────────────────────────────

/**
 * Notepad state snapshot — for serialization/restoration.
 * Ported from: notepad.py Notepad class
 */
export interface NotepadState {
  content: string;
  maxChars: number;
  history: string[];
}

/**
 * Context manager configuration.
 * Ported from: context_manager.py ContextManager constructor args
 */
export interface ContextManagerConfig {
  /** Number of recent turns to include in the sliding window */
  windowSize: number;
  /** Optional logging callback for routing log messages to session.log */
  logger?: (level: "info" | "warn" | "debug", message: string) => void;
}

// ─── Game Adapter Interface ──────────────────────────────────────────────────

/**
 * Interface that all game adapters must implement.
 * Ported from: game_adapter.py BaseGameAdapter ABC
 *
 * NOTE: This is a TYPE definition only. Concrete implementations live in
 * server/services/eval/adapters/ (owned by Team Forge).
 */
export interface GameAdapter {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly title: string;
  readonly level: number | null;
  readonly totalLevels: number | null;
  /** Win score — the score value indicating full completion (default 1.0 for percentage-based). */
  readonly winScore: number;

  reset(seed?: number): Promise<void>;
  step(action: string): Promise<void>;
  getScore(): number;
  getState(): GameState;
  isDone(): boolean;
  getAvailableActions(): string[];
  renderText(): string;
  renderPngBase64(): Promise<string | null>;
  /** Returns the raw grid data from the latest frame, or null if no frame yet */
  getGrid(): number[][] | number[][][] | null;
}

// ─── Provider Interface ──────────────────────────────────────────────────────

/**
 * Interface that all LLM providers must implement.
 * Ported from: base.py BaseProvider ABC
 *
 * NOTE: This is a TYPE definition only. Concrete implementations live in
 * server/services/eval/providers/ (owned by Team Conduit).
 */
export interface BaseEvalProvider {
  readonly modelName: string;
  readonly modelId: string;

  chooseAction(
    systemPrompt: string,
    conversationHistory: ProviderMessage[],
    currentObservation: string,
    validActions: string[],
    notepad: NotepadState,
    imageB64?: string | null,
  ): Promise<ProviderResponse>;
}

// ─── Utility Types ───────────────────────────────────────────────────────────

/** Event emitter callback — used by orchestrator to push SSE events */
export type EventEmitter = (event: EvalEvent) => void;

/** Eval session status lifecycle */
export type EvalSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Helper to convert a StepRecord to a StepEventData (omit large text fields) */
export function toStepEventData(step: StepRecord): StepEventData {
  return {
    runId: step.runId,
    model: step.model,
    gameId: step.gameId,
    gameType: step.gameType,
    runNumber: step.runNumber,
    step: step.step,
    action: step.action,
    score: step.score,
    level: step.level,
    totalLevels: step.totalLevels,
    done: step.done,
    state: step.state,
    cumulativeCostUsd: step.cumulativeCostUsd,
    inputTokens: step.inputTokens,
    outputTokens: step.outputTokens,
    reasoningTokens: step.reasoningTokens,
    scorePct: step.scorePct,
    stepCostUsd: step.stepCostUsd,
    cachedInputTokens: step.cachedInputTokens,
    cacheWriteTokens: step.cacheWriteTokens,
  };
}

/** Helper to convert a RunRecord to a RunEventData (omit notepadFinal) */
export function toRunEventData(run: RunRecord): RunEventData {
  return {
    runId: run.runId,
    model: run.model,
    gameId: run.gameId,
    gameType: run.gameType,
    runNumber: run.runNumber,
    totalSteps: run.totalSteps,
    maxSteps: run.maxSteps,
    finalScore: run.finalScore,
    solved: run.solved,
    levelsCompleted: run.levelsCompleted,
    totalLevels: run.totalLevels,
    costUsd: run.costUsd,
    totalInputTokens: run.totalInputTokens,
    totalOutputTokens: run.totalOutputTokens,
    totalReasoningTokens: run.totalReasoningTokens,
    elapsedSeconds: run.elapsedSeconds,
    error: run.error,
    finalScorePct: run.finalScorePct,
    totalCachedInputTokens: run.totalCachedInputTokens,
    totalCacheWriteTokens: run.totalCacheWriteTokens,
    resetCount: run.resetCount,
  };
}
