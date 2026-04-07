

// ---------------------------------------------------------------------------
// StepRecord — one per LLM call
// ---------------------------------------------------------------------------

export interface StepRecord {
  readonly runId: string;
  readonly stepNumber: number;
  readonly action: string;
  readonly reasoning: string;
  readonly notepadUpdate: string | null;

  // Token breakdown
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;

  // Cost
  readonly stepCostUsd: number;
  readonly cumulativeCostUsd: number;

  // Game state after action
  readonly score: number;
  readonly scorePct: number;
  readonly state: string;           // IN_PROGRESS, WIN, GAME_OVER, NOT_FINISHED
  readonly level: number | null;
  readonly totalLevels: number | null;
  readonly done: boolean;
  readonly actionCounter: number | null;
  readonly maxActions: number | null;

  // Context
  readonly notepadLength: number;
  readonly notepadContents: string;
  readonly elapsedMs: number;       // Wall time for this step
  readonly cumulativeElapsedMs: number;

  // Model info
  readonly modelId: string;
  readonly gameId: string;
  readonly gameGuid: string;
  readonly timestamp: string;       // ISO 8601
}

// ---------------------------------------------------------------------------
// RunRecord — one per completed game run
// ---------------------------------------------------------------------------

export interface RunRecord {
  readonly runId: string;
  readonly modelId: string;
  readonly gameId: string;
  readonly gameGuid: string;
  readonly scorecardId: string;

  // Final state
  readonly finalState: string;
  readonly finalScore: number;
  readonly finalScorePct: number;
  readonly solved: boolean;
  readonly totalSteps: number;

  // Aggregated tokens
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly totalCostUsd: number;

  // Timing
  readonly elapsedMs: number;

  // Metadata
  readonly maxSteps: number;
  readonly maxTurns: number;
  readonly reasoningEffort: string;
  readonly error: string | null;
  readonly timestamp: string;       // ISO 8601
}
