

// ---------------------------------------------------------------------------
// Rate table (USD per million tokens)
// ---------------------------------------------------------------------------

export interface ModelRates {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  cacheWrite: number;
  longThreshold: number;        // 0 = no long-context tier
  longInput?: number;
  longCachedInput?: number;
  longOutput?: number;
  longReasoning?: number;
}

export const RATES: Record<string, ModelRates> = {
  "gemini-standard": {
    input: 2.00,
    cachedInput: 0.20,
    output: 12.00,
    reasoning: 12.00,
    cacheWrite: 0.00,
    longThreshold: 200_000,
    longInput: 4.00,
    longCachedInput: 0.40,
    longOutput: 18.00,
    longReasoning: 18.00,
  },
  "gemini-priority": {
    input: 3.60,
    cachedInput: 0.36,
    output: 21.60,
    reasoning: 21.60,
    cacheWrite: 0.00,
    longThreshold: 200_000,
    longInput: 7.20,
    longCachedInput: 0.72,
    longOutput: 32.40,
    longReasoning: 32.40,
  },
  "claude": {
    input: 5.00,
    cachedInput: 0.50,
    output: 25.00,
    reasoning: 25.00,
    cacheWrite: 6.25,
    longThreshold: 0,
  },
  "gpt-5.4": {
    input: 2.50,
    cachedInput: 0.25,
    output: 15.00,
    reasoning: 15.00,
    cacheWrite: 2.50,
    longThreshold: 272_000,
    longInput: 5.00,
    longCachedInput: 0.50,
    longOutput: 22.50,
    longReasoning: 22.50,
  },
  "kimi": {
    input: 0.72,
    cachedInput: 0.00,
    output: 3.60,
    reasoning: 0.00,
    cacheWrite: 0.00,
    longThreshold: 0,
  },
};

// ---------------------------------------------------------------------------
// Cost breakdown (returned by calculateCost)
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  costInput: number;
  costCached: number;
  costCacheWrite: number;
  costOutput: number;
  costReasoning: number;
  total: number;
  // Effective rates applied (after long-context tier resolution)
  rateInput: number;
  rateCached: number;
  rateCacheWrite: number;
  rateOutput: number;
  rateReasoning: number;
  // Token counts echoed back for logging
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  textOutputTokens: number;
  reasoningTokens: number;
}

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

/**
 * Calculate USD cost from token counts for a given model.
 *
 * @param model - Key in RATES table (e.g., "gpt-5.4", "claude", "gemini-standard")
 * @param inputTokens - Non-cached input tokens
 * @param outputTokens - Total output tokens (includes reasoning)
 * @param reasoningTokens - Reasoning tokens (subtracted from output to avoid double-billing)
 * @param cachedInputTokens - Tokens served from provider cache
 * @param cacheWriteTokens - Tokens written to cache (one-time write cost)
 * @returns CostBreakdown with per-component and total cost
 * @throws Error if model is not in RATES table
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number = 0,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
): CostBreakdown {
  const rates = RATES[model];
  if (!rates) {
    throw new Error(
      `Unknown model: "${model}". Available: ${Object.keys(RATES).join(", ")}`,
    );
  }

  // Determine if long-context tier applies
  const totalInput = inputTokens + cachedInputTokens;
  const useLong = rates.longThreshold > 0 && totalInput >= rates.longThreshold;

  const rIn = useLong ? (rates.longInput ?? rates.input) : rates.input;
  const rCached = useLong ? (rates.longCachedInput ?? rates.cachedInput) : rates.cachedInput;
  const rOut = useLong ? (rates.longOutput ?? rates.output) : rates.output;
  const rReason = useLong ? (rates.longReasoning ?? rates.reasoning) : rates.reasoning;
  const rWrite = rates.cacheWrite;

  // Subtract reasoning from output to avoid double-billing
  const textOutput = Math.max(0, outputTokens - reasoningTokens);

  const costInput = (inputTokens / 1_000_000) * rIn;
  const costCached = (cachedInputTokens / 1_000_000) * rCached;
  const costCacheWrite = (cacheWriteTokens / 1_000_000) * rWrite;
  const costOutput = (textOutput / 1_000_000) * rOut;
  const costReasoning = (reasoningTokens / 1_000_000) * rReason;

  const total = costInput + costCached + costCacheWrite + costOutput + costReasoning;

  return {
    costInput,
    costCached,
    costCacheWrite,
    costOutput,
    costReasoning,
    total,
    rateInput: rIn,
    rateCached: rCached,
    rateCacheWrite: rWrite,
    rateOutput: rOut,
    rateReasoning: rReason,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    textOutputTokens: textOutput,
    reasoningTokens,
  };
}

// ---------------------------------------------------------------------------
// printCostBreakdown (optional logging, mirrors Python __main__ output)
// ---------------------------------------------------------------------------

/**
 * Print a formatted cost breakdown to console.
 * Mirrors the Python cost_calculator.py output format.
 */
export function printCostBreakdown(
  model: string,
  breakdown: CostBreakdown,
  log: (msg: string) => void = console.log,
): void {
  const fmt = (tokens: number, rate: number, cost: number, label: string): string => {
    const t = tokens.toLocaleString().padStart(10);
    return `  ${label.padEnd(12)} ${t} tokens x $${rate}/M = $${cost.toFixed(6)}`;
  };

  log(`Cost breakdown for ${model}:`);
  log(fmt(breakdown.inputTokens, breakdown.rateInput, breakdown.costInput, "Input:"));
  log(fmt(breakdown.cachedInputTokens, breakdown.rateCached, breakdown.costCached, "Cached:"));
  log(fmt(breakdown.cacheWriteTokens, breakdown.rateCacheWrite, breakdown.costCacheWrite, "CacheWr:"));
  log(fmt(breakdown.textOutputTokens, breakdown.rateOutput, breakdown.costOutput, "Output:"));
  log(fmt(breakdown.reasoningTokens, breakdown.rateReasoning, breakdown.costReasoning, "Reasoning:"));
  log(`  ${"─".repeat(50)}`);
  log(`  TOTAL: $${breakdown.total.toFixed(8)}`);
}

/** Convenience: list all available model keys. */
export const AVAILABLE_MODELS = Object.keys(RATES);
