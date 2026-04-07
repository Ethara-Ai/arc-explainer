

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { EvalModelConfig, EvalConfig, EvalProviderType } from "../shared/types/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const PUZZLE_ENV_DIR = path.join(PROJECT_ROOT, "puzzle-environments");
export const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "data", "puzzle-evals");

export const MODEL_REGISTRY: Record<string, EvalModelConfig> = {
  "gemini-3.1": {
    name: "Gemini 3.1",
    modelId: "gemini-3.1-pro-preview",
    provider: "gemini-fallback",
    envKey: "GEMINI_STUDIO_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "gemini-3.1-studio": {
    name: "Gemini 3.1 (Studio)",
    modelId: "gemini-3.1-pro-preview",
    provider: "gemini",
    envKey: "GEMINI_STUDIO_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "gemini-3.1-standard": {
    name: "Gemini 3.1 Standard",
    modelId: "gemini-3.1-pro-preview",
    provider: "gemini",
    envKey: "GEMINI_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    baseUrl: "https://aiplatform.googleapis.com/",
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "gemini-3.1-priority": {
    name: "Gemini 3.1 Priority",
    modelId: "gemini-3.1-pro-preview",
    provider: "gemini",
    envKey: "GEMINI_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    pricingModelId: "gemini-3.1-pro-preview-priority",
    additionalHeaders: {
      "X-Vertex-AI-LLM-Request-Type": "shared",
      "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
    },
    timeoutMs: 600_000,
    baseUrl: "https://aiplatform.googleapis.com/",
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "gemini-3.1-openrouter": {
    name: "Gemini 3.1 (OpenRouter)",
    modelId: "google/gemini-3.1-pro-preview",
    provider: "openrouter-gemini",
    envKey: "OPENROUTER_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },

  "gpt-5.4-thinking": {
    name: "GPT 5.4 Thinking",
    modelId: "gpt-5.4",
    provider: "openai",
    envKey: "GPT_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    reasoningEffort: "high",
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },

  "claude-opus": {
    name: "Claude Opus 4.6",
    modelId: process.env.CLAUDE_CLOUD_MODEL_ID ?? "",
    provider: "claude-cloud",
    envKey: "CLOUD_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "kimi-k2.5": {
    name: "Kimi k2.5",
    modelId: process.env.KIMI_CLOUD_MODEL_ID ?? "",
    provider: "kimi-cloud",
    envKey: "CLOUD_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },

  "claude-opus-arn": {
    name: "Claude Opus 4.6 (ARN)",
    modelId: process.env.CLAUDE_CLOUD_ARN ?? "",
    provider: "claude-cloud",
    envKey: "CLOUD_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    pricingModelId: process.env.CLAUDE_CLOUD_MODEL_ID ?? "",
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "claude-opus-arn2": {
    name: "Claude Opus 4.6 (ARN2)",
    modelId: process.env.CLAUDE_CLOUD_ARN_2 ?? "",
    provider: "claude-cloud",
    envKey: "CLOUD_API_KEY",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    pricingModelId: process.env.CLAUDE_CLOUD_MODEL_ID ?? "",
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "kimi-k2.5-arn": {
    name: "Kimi k2.5 (ARN)",
    modelId: process.env.KIMI_CLOUD_ARN ?? "",
    provider: "kimi-cloud",
    envKey: "CLOUD_API_KEY",
    supportsVision: true,
    maxContextTokens: 256_000,
    maxOutputTokens: 8192,
    pricingModelId: process.env.KIMI_CLOUD_MODEL_ID ?? "",
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },

  "claude-a1": {
    name: "Claude Opus 4.6 (A1)",
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY_1",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "claude-a2": {
    name: "Claude Opus 4.6 (A2)",
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY_2",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "claude-a3": {
    name: "Claude Opus 4.6 (A3)",
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY_3",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "claude-a4": {
    name: "Claude Opus 4.6 (A4)",
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY_4",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "claude-a5": {
    name: "Claude Opus 4.6 (A5)",
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY_5",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
  "claude-a6": {
    name: "Claude Opus 4.6 (A6)",
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY_6",
    supportsVision: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8192,
    timeoutMs: 600_000,
    vertexai: false,
    gcpLocation: "us-central1",
  },
} as const satisfies Record<string, EvalModelConfig>;

export const ALL_MODEL_KEYS = Object.keys(MODEL_REGISTRY);

export function createDefaultEvalConfig(overrides?: Partial<EvalConfig>): EvalConfig {
  return {
    maxSteps: 200,
    numRuns: 3,
    contextWindow: 50,
    seedBase: 42,
    outputDir: DEFAULT_OUTPUT_DIR,
    dryRun: false,
    retryAttempts: 10,
    retryBackoffBase: 1.5,
    retryMaxWait: 60.0,
    maxConsecutiveSkips: 10,
    saveRawResponses: true,
    tokenBudget: 0,
    providerMaxConcurrent: {
      "claude-cloud": 8,
      "anthropic": 10,
      "gemini": 12,
      "gemini-fallback": 12,
      "openrouter-gemini": 12,
      "openai": 16,
      "kimi-cloud": 32,
    },
    ...overrides,
  };
}

export const MODEL_COLORS: Record<string, string> = {
  "gemini-3.1": "#4A7C59",
  "gemini-3.1-studio": "#4A7C59",
  "gemini-3.1-standard": "#3D6B4E",
  "gemini-3.1-priority": "#2E5A3B",
  "gemini-3.1-openrouter": "#5E9B73",
  "gpt-5.4-thinking": "#5B8BA0",
  "claude-opus": "#C97B5D",
  "claude-opus-arn": "#D4956E",
  "claude-opus-arn2": "#E0A87F",
  "kimi-k2.5": "#7E5F9A",
  "kimi-k2.5-arn": "#9477B0",
  "claude-a1": "#C97B5D",
  "claude-a2": "#B56B4D",
  "claude-a3": "#A85B3D",
  "claude-a4": "#D4896B",
  "claude-a5": "#C07050",
  "claude-a6": "#B36545",
};

export function getApiKey(modelKey: string): string {
  const cfg = MODEL_REGISTRY[modelKey];
  if (!cfg) {
    throw new Error(`Unknown model: ${modelKey}. Available: ${ALL_MODEL_KEYS.join(", ")}`);
  }
  const key = process.env[cfg.envKey] ?? "";
  if (!key) {
    throw new Error(
      `API key not set: ${cfg.envKey} (required for ${cfg.name})`
    );
  }
  return key;
}

export function getModelConfig(modelKey: string): EvalModelConfig {
  const cfg = MODEL_REGISTRY[modelKey];
  if (!cfg) {
    throw new Error(`Unknown model: ${modelKey}. Available: ${ALL_MODEL_KEYS.join(", ")}`);
  }
  return cfg;
}

