
// ---------------------------------------------------------------------------
// StepCost
// ---------------------------------------------------------------------------

export interface StepCost {
  readonly stepNumber: number;
  readonly action: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// CostTracker (immutable)
// ---------------------------------------------------------------------------

export class CostTracker {
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly steps: ReadonlyArray<StepCost>;

  constructor(
    totalCostUsd: number = 0,
    totalInputTokens: number = 0,
    totalOutputTokens: number = 0,
    totalReasoningTokens: number = 0,
    totalCachedInputTokens: number = 0,
    totalCacheWriteTokens: number = 0,
    steps: ReadonlyArray<StepCost> = [],
  ) {
    this.totalCostUsd = totalCostUsd;
    this.totalInputTokens = totalInputTokens;
    this.totalOutputTokens = totalOutputTokens;
    this.totalReasoningTokens = totalReasoningTokens;
    this.totalCachedInputTokens = totalCachedInputTokens;
    this.totalCacheWriteTokens = totalCacheWriteTokens;
    this.steps = steps;
  }

  /** Record a step and return a new CostTracker with updated totals. */
  recordStep(step: StepCost): CostTracker {
    return new CostTracker(
      this.totalCostUsd + step.costUsd,
      this.totalInputTokens + step.inputTokens,
      this.totalOutputTokens + step.outputTokens,
      this.totalReasoningTokens + step.reasoningTokens,
      this.totalCachedInputTokens + step.cachedInputTokens,
      this.totalCacheWriteTokens + step.cacheWriteTokens,
      [...this.steps, step],
    );
  }

  /** Build SSE payload for agent.cost_update events. */
  toSSEPayload(): Record<string, unknown> {
    return {
      totalCostUsd: this.totalCostUsd,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalCachedInputTokens: this.totalCachedInputTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      stepCount: this.steps.length,
    };
  }

  /** Build final run summary cost section. */
  toRunSummary(): Record<string, unknown> {
    return {
      totalCostUsd: this.totalCostUsd,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalCachedInputTokens: this.totalCachedInputTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      stepCount: this.steps.length,
      costPerStep: this.steps.map((s) => ({
        step: s.stepNumber,
        action: s.action,
        costUsd: s.costUsd,
        elapsedMs: s.elapsedMs,
      })),
    };
  }
}

/**
 * Compute cost for a single step.
 * Cost is now reported by the LLM provider (LiteLLM) at call time,
 * so this function returns 0. Callers should use provider-reported cost.
 */
export function computeStepCost(
  _modelId: string,
  _inputTokens: number,
  _outputTokens: number,
  _reasoningTokens: number = 0,
  _cachedInputTokens: number = 0,
  _cacheWriteTokens: number = 0,
): number {
  return 0;
}
