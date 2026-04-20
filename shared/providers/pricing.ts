

// ---------------------------------------------------------------------------
// TokenPricing
// ---------------------------------------------------------------------------

export interface TokenPricing {
  inputPerM: number;           // USD per 1M input tokens
  outputPerM: number;          // USD per 1M output tokens
  reasoningPerM: number;       // USD per 1M reasoning tokens (if separate)
  cachedInputPerM: number;     // USD per 1M cached input tokens (read from cache)
  cacheWritePerM: number;      // USD per 1M tokens written to cache
  // Long-context tiered pricing (0 = no tiered pricing)
  longContextThreshold: number;     // input_tokens above this use long rates
  longInputPerM: number;
  longOutputPerM: number;
  longReasoningPerM: number;
  longCachedInputPerM: number;
  longCacheWritePerM: number;
}

function createPricing(partial: Partial<TokenPricing> & Pick<TokenPricing, "inputPerM" | "outputPerM">): TokenPricing {
  return {
    reasoningPerM: 0,
    cachedInputPerM: 0,
    cacheWritePerM: 0,
    longContextThreshold: 0,
    longInputPerM: 0,
    longOutputPerM: 0,
    longReasoningPerM: 0,
    longCachedInputPerM: 0,
    longCacheWritePerM: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scalePricing(base: TokenPricing, multiplier: number): TokenPricing {
  const r = (v: number) => Math.round(v * multiplier * 100) / 100;
  return {
    inputPerM: r(base.inputPerM),
    outputPerM: r(base.outputPerM),
    reasoningPerM: r(base.reasoningPerM),
    cachedInputPerM: r(base.cachedInputPerM),
    cacheWritePerM: r(base.cacheWritePerM),
    longContextThreshold: base.longContextThreshold, // NOT scaled
    longInputPerM: r(base.longInputPerM),
    longOutputPerM: r(base.longOutputPerM),
    longReasoningPerM: r(base.longReasoningPerM),
    longCachedInputPerM: r(base.longCachedInputPerM),
    longCacheWritePerM: r(base.longCacheWritePerM),
  };
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

const GEMINI_BASE: TokenPricing = createPricing({
  inputPerM: 2.00,
  outputPerM: 12.00,
  reasoningPerM: 12.00,
  cachedInputPerM: 0.20,
  cacheWritePerM: 0.0,
  longContextThreshold: 200_000,
  longInputPerM: 4.00,
  longOutputPerM: 18.00,
  longReasoningPerM: 18.00,
  longCachedInputPerM: 0.40,
  longCacheWritePerM: 0.0,
});

export const PRICING: Record<string, TokenPricing> = {
  // OpenAI GPT-5.4
  "gpt-5.4": createPricing({
    inputPerM: 2.50,
    outputPerM: 15.00,
    reasoningPerM: 15.00,
    cachedInputPerM: 0.25,
    cacheWritePerM: 2.50,
    longContextThreshold: 272_000,
    longInputPerM: 5.00,
    longOutputPerM: 22.50,
    longReasoningPerM: 22.50,
    longCachedInputPerM: 0.50,
    longCacheWritePerM: 5.00,
  }),
  // Google Gemini 3.1 Pro Preview via OpenRouter
  "google/gemini-3.1-pro-preview": GEMINI_BASE,
  // Native Gemini
  "gemini-3.1-pro-preview": GEMINI_BASE,
  // Gemini 3.1 Priority (1.8x)
  "gemini-3.1-pro-preview-priority": scalePricing(GEMINI_BASE, 1.8),
  // Moonshot Kimi k2.5
  "kimi-k2.5": createPricing({ inputPerM: 0.72, outputPerM: 3.60 }),
  // Anthropic Claude Opus 4.6 (cloud)
  [process.env.CLAUDE_CLOUD_MODEL_ID ?? "claude-cloud-default"]: createPricing({
    inputPerM: 5.00,
    outputPerM: 25.00,
    reasoningPerM: 25.00,
    cachedInputPerM: 0.50,
    cacheWritePerM: 6.25,
  }),
  // Anthropic Claude Opus 4.6 via native API
  "claude-opus-4-6": createPricing({
    inputPerM: 5.00,
    outputPerM: 25.00,
    reasoningPerM: 25.00,
    cachedInputPerM: 0.50,
    cacheWritePerM: 6.25,
  }),
  // Anthropic Claude Opus 4.7 (cloud)
  [process.env.CLAUDE_47_CLOUD_MODEL_ID ?? "claude-47-cloud-default"]: createPricing({
    inputPerM: 5.00,
    outputPerM: 25.00,
    reasoningPerM: 25.00,
    cachedInputPerM: 0.50,
    cacheWritePerM: 6.25,
  }),
  // Anthropic Claude Opus 4.7 via native API
  "claude-opus-4-7": createPricing({
    inputPerM: 5.00,
    outputPerM: 25.00,
    reasoningPerM: 25.00,
    cachedInputPerM: 0.50,
    cacheWritePerM: 6.25,
  }),
  // Moonshot Kimi k2.5 (cloud)
  [process.env.KIMI_CLOUD_MODEL_ID ?? "kimi-cloud-default"]: createPricing({ inputPerM: 0.72, outputPerM: 3.60 }),
};

// ---------------------------------------------------------------------------
// computeCost
// ---------------------------------------------------------------------------

/**
 * Compute USD cost from token counts, accounting for prompt caching.
 *
 * FIX(#55): All token counts are clamped to >= 0 to prevent negative costs
 * from subtraction bugs upstream. NaN/Infinity are treated as 0.
 * FIX(#56): reasoningTokens are capped to outputTokens so the split
 * (textOutput + reasoning) never exceeds the API-reported total.
 *
 * @param modelId - API model identifier (must be in PRICING table)
 * @param inputTokens - Non-cached input tokens only
 * @param outputTokens - Number of output/completion tokens
 * @param reasoningTokens - Number of reasoning tokens (separate billing)
 * @param cachedInputTokens - Tokens served from provider cache
 * @param cacheWriteTokens - Tokens written to cache (one-time write cost)
 * @returns Cost in USD (always >= 0)
 * @throws Error if model has no pricing entry
 */
export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number = 0,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  // FIX(#55): Clamp all token counts -- protect against negative, NaN, Infinity
  const clamp = (n: number): number => {
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  };
  inputTokens = clamp(inputTokens);
  outputTokens = clamp(outputTokens);
  reasoningTokens = clamp(reasoningTokens);
  cachedInputTokens = clamp(cachedInputTokens);
  cacheWriteTokens = clamp(cacheWriteTokens);

  let pricing = PRICING[modelId] ?? null;

  if (!pricing) {
    // Fallback: prefix matching
    for (const [key, p] of Object.entries(PRICING)) {
      if (modelId.startsWith(key) || key.startsWith(modelId)) {
        pricing = p;
        break;
      }
    }
  }

  if (!pricing) {
    throw new Error(
      `No pricing data for model: ${modelId}. Available: ${Object.keys(PRICING).join(", ")}`
    );
  }

  // Apply long-context tier if applicable
  const totalInput = inputTokens + cachedInputTokens;
  if (pricing.longContextThreshold > 0 && totalInput >= pricing.longContextThreshold) {
    pricing = {
      ...pricing,
      inputPerM: pricing.longInputPerM,
      outputPerM: pricing.longOutputPerM,
      reasoningPerM: pricing.longReasoningPerM,
      cachedInputPerM: pricing.longCachedInputPerM,
      cacheWritePerM: pricing.longCacheWritePerM,
    };
  }

  // FIX(#56): Cap reasoning to output so (textOutput + reasoning) <= outputTokens.
  // This prevents overbilling when reasoning is char-estimated and exceeds API total.
  reasoningTokens = Math.min(reasoningTokens, outputTokens);

  // Subtract reasoning from output to avoid double-billing
  const textOutputTokens = Math.max(0, outputTokens - reasoningTokens);

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerM +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerM +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerM +
    (textOutputTokens / 1_000_000) * pricing.outputPerM +
    (reasoningTokens / 1_000_000) * pricing.reasoningPerM;

  // Guard against floating-point edge cases producing negative cost
  return Math.max(0, Math.round(cost * 1e8) / 1e8);
}
