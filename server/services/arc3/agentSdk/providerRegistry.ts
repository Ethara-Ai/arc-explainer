import type { Model } from "@openai/agents";
import { logger } from "../../../utils/logger.ts";
import {
  LiteLLMAgentModel,
  type LiteLLMAgentModelConfig,
} from "./LiteLLMAgentModel.ts";
import {
  buildAgentSdkCloudModelConfigs,
  buildAgentSdkDirectModelConfigs,
  type AgentSdkModelConfig,
} from "./agentSdkLlmConfig.ts";
import { buildOpenAIAgentSdkModelConfigs } from "./openaiAgentSdkLlmConfig.ts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ProviderKind = "litellm-sdk";

/* ------------------------------------------------------------------ */
/*  Model Registry (lazy — initialized on first access)                */
/* ------------------------------------------------------------------ */

let _cachedRegistry: ReadonlyArray<AgentSdkModelConfig> | null = null;
let _cachedConfigByKey: Map<string, AgentSdkModelConfig> | null = null;

function getRegistry(): ReadonlyArray<AgentSdkModelConfig> {
  if (!_cachedRegistry) {
    validateEnvironment();
    _cachedRegistry = [
      ...buildAgentSdkCloudModelConfigs(),
      ...buildAgentSdkDirectModelConfigs(),
      ...buildOpenAIAgentSdkModelConfigs(),
    ];
    _cachedConfigByKey = new Map(_cachedRegistry.map((c) => [c.key, c]));
  }
  return _cachedRegistry;
}

function getConfigByKey(): Map<string, AgentSdkModelConfig> {
  getRegistry(); // ensure initialized
  return _cachedConfigByKey!;
}

/* ------------------------------------------------------------------ */
/*  Lazy-initialised LiteLLMAgentModel singletons                      */
/* ------------------------------------------------------------------ */

const modelCache = new Map<string, LiteLLMAgentModel>();

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Look up model configuration by key.
 * @throws if key is not registered.
 */
export function getModelConfig(modelKey: string): AgentSdkModelConfig {
  const config = getConfigByKey().get(modelKey);
  if (!config) {
    throw new Error(
      `Unknown AgentSDK model key "${modelKey}". ` +
        `Registered: ${getRegistry()
          .map((m) => m.key)
          .join(", ")}`,
    );
  }
  return config;
}

/**
 * Create an Agents-SDK-compatible Model from a registry key.
 * Returns a LiteLLMAgentModel that bridges to the Python litellmBridge subprocess.
 * Models are cached per key to share subprocess resources.
 */
export function createAgentSdkModel(modelKey: string): Model {
  const config = getModelConfig(modelKey);

  const cached = modelCache.get(modelKey);
  if (cached) {
    return cached;
  }

  const apiKey = process.env[config.envKey] ?? "";

  const litellmConfig: LiteLLMAgentModelConfig = {
    litellmModel: config.litellmModel,
    displayName: config.displayName,
    apiKey,
    cloudRegion: config.cloudRegion,
    timeoutMs: 180_000,
    enableThinking: config.enableThinking,
    thinkingBudget: config.thinkingBudget,
    providerHint: config.providerHint,
    reasoningEffort: config.reasoningEffort,
    maxTokens: 16384,
  };

  logger.info(
    `[AgentSdk Registry] Creating LiteLLM model for ${config.displayName} ` +
      `(litellm: ${config.litellmModel}, env: ${config.envKey}, thinking=${config.enableThinking}, providerHint=${config.providerHint}, cloudRegion=${config.cloudRegion ?? "(none)"})`,
    "arc3-agentsdk",
  );

  const model = new LiteLLMAgentModel(litellmConfig);
  modelCache.set(modelKey, model);
  return model;
}

/**
 * Build modelSettings for an Agent constructor.
 * With LiteLLM, most provider-specific config is handled by the bridge.
 * These settings are passed through to the Agents SDK Agent constructor.
 */
export function buildModelSettings(
  modelKey: string,
  _reasoningEffort: string = "high",
): Record<string, unknown> {
  getModelConfig(modelKey);

  // Keep temperature unspecified so each provider can use its default.
  // AgentSDK playground reasoning is handled inside LiteLLMAgentModel.
  return {};
}

/**
 * Return all registered model configurations for the /models endpoint.
 */
export function getRegisteredModels(): readonly AgentSdkModelConfig[] {
  return getRegistry();
}

/* ------------------------------------------------------------------ */
/*  Environment validation (called on first registry access)             */
/* ------------------------------------------------------------------ */

function validateEnvironment(): void {
  // Cloud resource ID env vars are required — fail hard if missing (routing violations)
  const requiredCloudIds: Array<{ envVar: string; label: string }> = [
    {
      envVar: "CLAUDE_CLOUD_ARN",
      label: "Claude Opus 4.6 (LiteLLM)",
    },
    { envVar: "KIMI_CLOUD_ARN", label: "Kimi K2.5 (LiteLLM)" },
  ];

  for (const { envVar, label } of requiredCloudIds) {
    if (!process.env[envVar]) {
      throw new Error(
        `${envVar} is required for ${label}. All cloud models must use cloud resource ID routing.`,
      );
    }
  }

  const optionalKeys: Array<{ envVar: string; label: string }> = [
    { envVar: "CLOUD_API_KEY", label: "Cloud models (LiteLLM)" },
    { envVar: "GEMINI_API_KEY", label: "Gemini 3.1 Pro (LiteLLM)" },
    { envVar: "GPT_API_KEY", label: "GPT 5.4 (LiteLLM/OpenAI)" },
  ];

  for (const { envVar, label } of optionalKeys) {
    if (!process.env[envVar]) {
      logger.warn(
        `[AgentSdk Registry] ${envVar} not set — ${label} will fail when selected.`,
        "arc3-agentsdk",
      );
    }
  }
}
