export type AgentSdkProviderKind = "litellm-sdk";
export type AgentSdkProviderHint = "claude" | "gemini" | "openai" | "kimi";

export interface AgentSdkModelConfig {
  readonly key: string;
  readonly displayName: string;
  readonly providerKind: AgentSdkProviderKind;
  readonly color: string;
  readonly supportsReasoning: boolean;
  readonly supportsPreviousResponseId: boolean;
  readonly litellmModel: string;
  readonly envKey: string;
  readonly cloudRegion?: string;
  readonly providerHint: AgentSdkProviderHint;
  readonly enableThinking: boolean;
  readonly thinkingBudget?: number;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

function extractRegionFromId(modelId: string | undefined): string | null {
  if (!modelId || !modelId.startsWith("arn:")) {
    return null;
  }

  const parts = modelId.split(":");
  if (parts.length < 4 || parts[0] !== "arn") {
    return null;
  }

  return parts[3] || null;
}

function resolveCloudRegion(
  modelIdEnvVar: string,
  fallbackRegion: string,
): string {
  const idRegion = extractRegionFromId(process.env[modelIdEnvVar]);
  return idRegion ?? process.env.CLOUD_REGION ?? fallbackRegion;
}

function resolveCloudLitellmModel(envVar: string): string {
  const cloudModelId = process.env[envVar];
  if (!cloudModelId) {
    throw new Error(
      `${envVar} is required. All cloud models must use cloud resource ID routing.`,
    );
  }

  const inferenceProfileMarker =
    process.env.CLOUD_INFERENCE_PROFILE_MARKER ?? "";
  if (inferenceProfileMarker && cloudModelId.includes(inferenceProfileMarker)) {
    const inferencePrefix = process.env.CLOUD_INFERENCE_ROUTING_PREFIX;
    if (!inferencePrefix)
      throw new Error("CLOUD_INFERENCE_ROUTING_PREFIX is required.");
    return `${inferencePrefix}${cloudModelId}`;
  }

  const modelPrefix = process.env.CLOUD_MODEL_ROUTING_PREFIX;
  if (!modelPrefix) throw new Error("CLOUD_MODEL_ROUTING_PREFIX is required.");
  return `${modelPrefix}${cloudModelId}`;
}

export function buildAgentSdkCloudModelConfigs(): AgentSdkModelConfig[] {
  return [
    {
      key: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      providerKind: "litellm-sdk",
      color: "#D946EF",
      supportsReasoning: true,
      supportsPreviousResponseId: false,
      litellmModel: resolveCloudLitellmModel("CLAUDE_CLOUD_ARN"),
      envKey: "CLOUD_API_KEY",
      cloudRegion: resolveCloudRegion("CLAUDE_CLOUD_ARN", "us-east-1"),
      providerHint: "claude",
      enableThinking: true,
      thinkingBudget: 8192,
    },
    {
      key: process.env.KIMI_CLOUD_MODEL_ID ?? "",
      displayName: "Kimi K2.5",
      providerKind: "litellm-sdk",
      color: "#8B5CF6",
      supportsReasoning: false,
      supportsPreviousResponseId: false,
      litellmModel: resolveCloudLitellmModel("KIMI_CLOUD_ARN"),
      envKey: "CLOUD_API_KEY",
      cloudRegion: resolveCloudRegion("KIMI_CLOUD_ARN", "ap-south-1"),
      providerHint: "kimi",
      enableThinking: true,
    },
  ];
}

export function buildAgentSdkDirectModelConfigs(): AgentSdkModelConfig[] {
  return [
    {
      key: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro",
      providerKind: "litellm-sdk",
      color: "#3B82F6",
      supportsReasoning: true,
      supportsPreviousResponseId: false,
      litellmModel: "gemini/gemini-3.1-pro-preview",
      envKey: "GEMINI_API_KEY",
      providerHint: "gemini",
      enableThinking: true,
      thinkingBudget: -1,
    },
  ];
}
