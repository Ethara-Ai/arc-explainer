export type EvalProviderType =
  | "openai"
  | "gemini"
  | "gemini-fallback"
  | "openrouter-gemini"
  | "kimi"
  | "claude-cloud"
  | "kimi-cloud"
  | "anthropic";

export interface EvalModelConfig {
  name: string;
  modelId: string;
  provider: EvalProviderType;
  envKey: string;
  baseUrl?: string;
  supportsVision: boolean;
  maxContextTokens: number;
  reasoningEffort?: "low" | "medium" | "high";
  /** Override modelId for cost lookups (e.g. cloud ARN -> base model pricing). */
  pricingModelId?: string;
  maxOutputTokens: number;
  // WARNING: shared objects -- never mutate in-place (affects all createProvider calls)
  additionalHeaders?: Record<string, string>;
  timeoutMs: number;
  vertexai: boolean;
  gcpProject?: string;
  gcpLocation: string;
}

export interface EvalConfig {
  maxSteps: number;
  numRuns: number;
  contextWindow: number;
  seedBase: number;
  outputDir: string;
  dryRun: boolean;
  retryAttempts: number;
  /** 1.5^attempt seconds (non-Gemini errors). */
  retryBackoffBase: number;
  /** Cap for backoff; rate limits use minute-boundary alignment instead. */
  retryMaxWait: number;
  maxConsecutiveSkips: number;
  saveRawResponses: boolean;
  /** Token budget for context trimming (model context - reserved output). 0 = disabled. */
  tokenBudget: number;
  providerMaxConcurrent: Partial<Record<EvalProviderType, number>>;
}

export interface BaseEvalProvider {
  readonly displayName: string;
  readonly modelId: string;
}
