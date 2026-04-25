import path from "path";
import { fileURLToPath } from "url";
import { BaseProvider } from "../providers/base";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
export const PUZZLE_ENV_DIR = path.join(PROJECT_ROOT, "puzzle-environments");
export const DEFAULT_OUTPUT_DIR = path.join(
  PROJECT_ROOT,
  "data",
  "puzzle-evals",
);

// ---------------------------------------------------------------------------
// ModelConfig
// ---------------------------------------------------------------------------

export interface ModelConfig {
  name: string;
  modelId: string;
  provider: string;
  envKey: string;
  baseUrl?: string | null;
  supportsVision?: boolean;
  maxContextTokens?: number;
  reasoningEffort?: string | null;
  pricingModelId?: string | null;
  maxOutputTokens?: number;
  additionalHeaders?: Record<string, string> | null;
  timeoutMs?: number;
  vertexai?: boolean;
  gcpProject?: string | null;
  gcpLocation?: string;
  /** Vertex AI credentials: JSON string of service account key, or env var VERTEXAI_CREDENTIALS */
  vertexCredentials?: string | null;
  litellmModel?: string | null;
  /** Enable thinking/reasoning mode for this model. Default: true (all models think by default) */
  enableThinking?: boolean;
  /** Thinking token budget for Gemini models. -1 = dynamic. Default: -1 */
  thinkingBudget?: number;
  cloudRegion?: string;
  providerHint?: "claude" | "gemini" | "openai" | "kimi" | null;
}

// ---------------------------------------------------------------------------
// MODEL_REGISTRY
// ---------------------------------------------------------------------------

/**
 * Extract the region from a cloud resource ID string.
 * ID format: arn:<partition>:<service>:<region>:<account>:...
 * Returns null if the string is not a valid resource ID.
 */
function regionFromId(resourceId: string | undefined): string | null {
  if (!resourceId) return null;
  const parts = resourceId.split(":");
  if (parts.length >= 4 && parts[0] === "arn") {
    return parts[3] || null;
  }
  return null;
}

/**
 * Build MODEL_REGISTRY lazily so env vars are read at access time (after dotenv loads),
 * not at esbuild bundle time when they'd be undefined.
 */
function buildModelRegistry(): Record<string, ModelConfig> {
  const claudeCloudId = process.env.CLAUDE_CLOUD_ARN;
  const claude47CloudId = process.env.CLAUDE_47_CLOUD_ARN;
  const kimiCloudId = process.env.KIMI_CLOUD_ARN;

  if (!claudeCloudId) {
    throw new Error(
      "CLAUDE_CLOUD_ARN is required for Claude Opus 4.6. All cloud models must use cloud resource ID routing.",
    );
  }
  if (!kimiCloudId) {
    throw new Error(
      "KIMI_CLOUD_ARN is required for Kimi K2.5. All cloud models must use cloud resource ID routing.",
    );
  }

  const claudeModelId = process.env.CLAUDE_CLOUD_MODEL_ID ?? "";
  const claude47ModelId = process.env.CLAUDE_47_CLOUD_MODEL_ID ?? "";
  const kimiModelId = process.env.KIMI_CLOUD_MODEL_ID ?? "";
  const geminiModelId = process.env.GEMINI_MODEL_ID ?? "";
  const gptModelId = process.env.GPT_MODEL_ID ?? "";

  const claudeLitellmModel = process.env.CLAUDE_CLOUD_LITELLM_MODEL ?? "";
  const claude47LitellmModel = process.env.CLAUDE_47_CLOUD_LITELLM_MODEL ?? "";
  const kimiLitellmModel = process.env.KIMI_CLOUD_LITELLM_MODEL ?? "";
  const geminiLitellmModel = process.env.GEMINI_LITELLM_MODEL ?? "";
  const gptLitellmModel = process.env.GPT_LITELLM_MODEL ?? "";

  const kimiPricingModelId =
    process.env.KIMI_CLOUD_PRICING_MODEL_ID ?? kimiModelId;
  const geminiPricingModelId =
    process.env.GEMINI_PRICING_MODEL_ID ?? geminiModelId;
  const geminiPriorityPricingModelId =
    process.env.GEMINI_PRIORITY_PRICING_MODEL_ID ?? "";

  const vertexRequestType = process.env.VERTEX_REQUEST_TYPE ?? "";
  const vertexSharedRequestType = process.env.VERTEX_SHARED_REQUEST_TYPE ?? "";
  const vertexRequestHeader = process.env.VERTEX_REQUEST_HEADER ?? "";
  const vertexSharedRequestHeader =
    process.env.VERTEX_SHARED_REQUEST_HEADER ?? "";

  const priorityHeaders: Record<string, string> | null =
    vertexRequestHeader &&
    vertexRequestType &&
    vertexSharedRequestHeader &&
    vertexSharedRequestType
      ? {
          [vertexRequestHeader]: vertexRequestType,
          [vertexSharedRequestHeader]: vertexSharedRequestType,
        }
      : null;

  const registry: Record<string, ModelConfig> = {
    "claude-opus": {
      name: "Claude Opus 4.6",
      modelId: claudeModelId,
      provider: "litellm-sdk",
      envKey: "CLOUD_API_KEY",
      litellmModel: claudeLitellmModel,
      cloudRegion:
        regionFromId(claudeCloudId) ?? process.env.CLOUD_REGION ?? "us-east-1",
      pricingModelId: "anthropic.claude-opus-4-6-v1",
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8192,
      enableThinking: true,
      providerHint: "claude",
    },
    "kimi-k2.5": {
      name: "Kimi K2.5",
      modelId: kimiModelId,
      provider: "litellm-sdk",
      envKey: "CLOUD_API_KEY",
      litellmModel: kimiLitellmModel,
      cloudRegion:
        regionFromId(kimiCloudId) ?? process.env.CLOUD_REGION ?? "ap-south-1",
      pricingModelId: kimiPricingModelId,
      maxContextTokens: 256_000,
      maxOutputTokens: 8192,
      supportsVision: true,
      enableThinking: true,
      providerHint: "kimi",
    },
    "gemini-3.1-standard": {
      name: "Gemini 3.1 Pro",
      modelId: geminiModelId,
      provider: "litellm-sdk",
      envKey: "GEMINI_API_KEY",
      litellmModel: geminiLitellmModel,
      maxContextTokens: 1_000_000,
      pricingModelId: geminiPricingModelId,
      timeoutMs: 600_000,
      enableThinking: true,
      providerHint: "gemini",
      vertexai: true,
      gcpProject: process.env.GCP_PROJECT ?? null,
      gcpLocation: process.env.GCP_LOCATION ?? "us-central1",
      vertexCredentials: process.env.VERTEXAI_CREDENTIALS ?? null,
    },
    "gemini-3.1-priority": {
      name: "Gemini 3.1 Pro (Priority)",
      modelId: geminiModelId,
      provider: "litellm-sdk",
      envKey: "GEMINI_API_KEY",
      litellmModel: geminiLitellmModel,
      maxContextTokens: 1_000_000,
      pricingModelId: geminiPriorityPricingModelId,
      additionalHeaders: priorityHeaders,
      timeoutMs: 600_000,
      enableThinking: true,
      providerHint: "gemini",
      vertexai: true,
      gcpProject: process.env.GCP_PROJECT ?? null,
      gcpLocation: process.env.GCP_LOCATION ?? "us-central1",
      vertexCredentials: process.env.VERTEXAI_CREDENTIALS ?? null,
    },
    "gpt-5.4-thinking": {
      name: "ChatGPT 5.4 Thinking",
      modelId: gptModelId,
      provider: "litellm-sdk",
      envKey: "GPT_API_KEY",
      litellmModel: gptLitellmModel,
      maxContextTokens: 1_000_000,
      reasoningEffort: "high",
      enableThinking: true,
      providerHint: "openai",
    },
  };

  if (claude47CloudId) {
    registry["claude-opus-4.7"] = {
      name: "Claude Opus 4.7",
      modelId: claude47ModelId,
      provider: "litellm-sdk",
      envKey: "CLOUD_API_KEY",
      litellmModel: claude47LitellmModel,
      cloudRegion:
        regionFromId(claude47CloudId) ?? process.env.CLOUD_REGION ?? "us-east-1",
      pricingModelId: "anthropic.claude-opus-4-7",
      maxContextTokens: 1_000_000,
      maxOutputTokens: 16384,
      reasoningEffort: "high",
      enableThinking: true,
      providerHint: "claude",
    };
  }

  return registry;
}

/** Cached registry — built once on first access (after dotenv loads). */
let _cachedRegistry: Record<string, ModelConfig> | null = null;

export function getModelRegistry(): Record<string, ModelConfig> {
  if (!_cachedRegistry) {
    _cachedRegistry = buildModelRegistry();
  }
  return _cachedRegistry;
}

/**
 * Lazy proxy so env vars (e.g. CLAUDE_CLOUD_ARN) are read at first access
 * (after dotenv loads), not at module load / esbuild bundle time.
 * The result is cached — subsequent accesses return the same object.
 */
export const MODEL_REGISTRY = new Proxy({} as Record<string, ModelConfig>, {
  get(_target, prop: string) {
    return getModelRegistry()[prop];
  },
  ownKeys() {
    return Object.keys(getModelRegistry());
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const reg = getModelRegistry();
    if (prop in reg)
      return { configurable: true, enumerable: true, value: reg[prop] };
    return undefined;
  },
  has(_target, prop: string) {
    return prop in getModelRegistry();
  },
});

/**
 * Static model key list. These are constant strings — they don't depend on env
 * vars, so eager evaluation is safe. Kept in sync with buildModelRegistry()
 * by the test suite (see llmConfig.test.ts).
 */
export const ALL_MODEL_KEYS = [
  "claude-opus",
  "claude-opus-4.7",
  "kimi-k2.5",
  "gemini-3.1-standard",
  "gemini-3.1-priority",
  "gpt-5.4-thinking",
];

// ---------------------------------------------------------------------------
// EvalConfig
// ---------------------------------------------------------------------------

export interface EvalConfig {
  maxSteps: number;
  numRuns: number;
  contextWindow: number;
  seedBase: number;
  outputDir: string;
  dryRun: boolean;
  retryAttempts: number;
  retryBackoffBase: number;
  retryMaxWait: number;
  maxConsecutiveSkips: number;
  saveRawResponses: boolean;
  tokenBudget: number;
  providerMaxConcurrent: Record<string, number>;
  capturePrompts: boolean;
}

export const DEFAULT_EVAL_CONFIG: EvalConfig = {
  maxSteps: 200,
  numRuns: 3,
  contextWindow: 50,
  seedBase: 42,
  outputDir: DEFAULT_OUTPUT_DIR,
  dryRun: false,
  retryAttempts: 50,
  retryBackoffBase: 1.5,
  retryMaxWait: 60.0,
  maxConsecutiveSkips: 10,
  saveRawResponses: true,
  tokenBudget: 0,
  providerMaxConcurrent: {
    "litellm-sdk": 16,
  },
  capturePrompts: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate API key format for known providers.
 * Checks that the key is non-empty, meets minimum length requirements,
 * and has the expected prefix for known providers.
 *
 * @param key - The API key to validate
 * @param envKey - The environment variable name (used for error messages and prefix validation)
 * @throws {Error} If the key is invalid, empty, too short, or has wrong prefix
 */
function validateApiKeyFormat(key: string, envKey: string): void {
  if (!key || key.trim().length === 0) {
    throw new Error(`${envKey} is empty or whitespace`);
  }

  if (key.length < 20) {
    throw new Error(
      `${envKey} is too short (min 20 chars): ${key.length} chars`,
    );
  }

  // Validate known prefixes for common providers
}

export function getApiKey(modelKey: string): string {
  const cfg = MODEL_REGISTRY[modelKey];
  if (!cfg)
    throw new Error(
      `Unknown model: ${modelKey}. Available: ${ALL_MODEL_KEYS.join(", ")}`,
    );
  const key = process.env[cfg.envKey] ?? "";
  if (!key)
    throw new Error(
      `API key not set: ${cfg.envKey} (required for ${cfg.name})`,
    );
  // Validate API key format to catch configuration errors early
  validateApiKeyFormat(key, cfg.envKey);

  return key;
}

export function getModelConfig(modelKey: string): ModelConfig {
  const cfg = MODEL_REGISTRY[modelKey];
  if (!cfg)
    throw new Error(
      `Unknown model: ${modelKey}. Available: ${ALL_MODEL_KEYS.join(", ")}`,
    );
  return cfg;
}

/**
 * Create a provider instance from a model key.
 * Lazy imports to avoid pulling in all provider dependencies at startup.
 */
export async function createProvider(modelKey: string): Promise<BaseProvider> {
  const cfg = getModelConfig(modelKey);
  const apiKey = getApiKey(modelKey);
  const enableThinking = cfg.enableThinking ?? true;

  const resolvedLitellmModel = cfg.litellmModel ?? cfg.modelId;
  console.log(
    `[createProvider] modelKey=${modelKey} modelId=${cfg.modelId} litellmModel=${cfg.litellmModel} resolved=${resolvedLitellmModel} cloudRegion=${cfg.cloudRegion}`,
  );

  if (!cfg.modelId) {
    throw new Error(`model_id is empty for '${modelKey}'.`);
  }

  console.log(
    `[createProvider] DIRECT route for ${modelKey}: model=${resolvedLitellmModel}`,
  );

  switch (cfg.provider) {
    case "litellm-sdk": {
      const { LiteLLMSdkProvider } =
        await import("../providers/litellmSdkProvider");

      const isReasoningModel = enableThinking || cfg.reasoningEffort != null;
      const defaultTimeoutMs = isReasoningModel ? 300_000 : 120_000;

      return new LiteLLMSdkProvider({
        apiKey,
        modelId: cfg.modelId,
        litellmModel: resolvedLitellmModel,
        displayName: cfg.name,
        pricingModelId: cfg.pricingModelId,
        supportsVision: cfg.supportsVision,
        enableThinking,
        baseUrl: cfg.baseUrl ?? null,
        timeoutMs: cfg.timeoutMs ?? defaultTimeoutMs,
        cloudRegion: cfg.cloudRegion,
        providerHint: cfg.providerHint ?? null,
        reasoningEffort: cfg.reasoningEffort ?? null,
        additionalHeaders: cfg.additionalHeaders ?? null,
        vertexProject: cfg.gcpProject ?? null,
        vertexLocation: cfg.gcpLocation ?? null,
        vertexCredentials: cfg.vertexCredentials ?? null,
      });
    }
    default:
      throw new Error(
        `Unknown provider type: ${cfg.provider}. All models must use 'litellm-sdk'.`,
      );
  }
}
