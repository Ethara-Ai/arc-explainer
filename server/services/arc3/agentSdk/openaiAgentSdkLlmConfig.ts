import type { AgentSdkModelConfig } from "./agentSdkLlmConfig.ts";

export function buildOpenAIAgentSdkModelConfigs(): AgentSdkModelConfig[] {
  return [
    {
      key: "gpt-5.4",
      displayName: "GPT 5.4 Thinking",
      providerKind: "litellm-sdk",
      color: "#10B981",
      supportsReasoning: true,
      supportsPreviousResponseId: false,
      litellmModel: "openai/gpt-5.4",
      envKey: "GPT_API_KEY",
      providerHint: "openai",
      enableThinking: true,
      reasoningEffort: "high",
    },
  ];
}
