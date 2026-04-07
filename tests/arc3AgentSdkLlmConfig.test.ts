import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("AgentSDK LiteLLM config", () => {
  it("uses provider-specific thinking defaults for CLOUD_API_KEY-backed models", async () => {
    process.env.CLAUDE_CLOUD_ARN = process.env.TEST_CLAUDE_CLOUD_ARN;
    process.env.KIMI_CLOUD_ARN = process.env.TEST_KIMI_CLOUD_ARN;
    process.env.CLOUD_INFERENCE_PROFILE_MARKER ??=
      "application-inference-profile";
    process.env.CLOUD_INFERENCE_ROUTING_PREFIX ??= "bedrock/converse/";
    process.env.CLOUD_MODEL_ROUTING_PREFIX ??= "bedrock/";

    const { buildAgentSdkCloudModelConfigs } =
      await import("../server/services/arc3/agentSdk/agentSdkLlmConfig.ts");

    const configs = buildAgentSdkCloudModelConfigs();
    expect(configs).toHaveLength(2);
    const claudeConfig = configs.find(
      (config) => config.key === "claude-opus-4-6",
    );
    const kimiConfig = configs.find(
      (config) => config.key === process.env.KIMI_CLOUD_MODEL_ID,
    );

    expect(claudeConfig?.envKey).toBe("CLOUD_API_KEY");
    expect(kimiConfig?.envKey).toBe("CLOUD_API_KEY");
    expect(claudeConfig?.enableThinking).toBe(true);
    expect(kimiConfig?.enableThinking).toBe(false);
    expect(kimiConfig?.supportsReasoning).toBe(false);
    expect(claudeConfig?.cloudRegion).toBe("ap-south-1");
    expect(kimiConfig?.cloudRegion).toBe("ap-south-1");
  });

  it("keeps OpenAI AgentSDK config separate and reasoning-enabled", async () => {
    const { buildOpenAIAgentSdkModelConfigs } =
      await import("../server/services/arc3/agentSdk/openaiAgentSdkLlmConfig.ts");

    const configs = buildOpenAIAgentSdkModelConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].key).toBe("gpt-5.4");
    expect(configs[0].providerHint).toBe("openai");
    expect(configs[0].enableThinking).toBe(true);
    expect(configs[0].reasoningEffort).toBe("high");
  });

  it("does not force temperature in AgentSDK model settings", async () => {
    process.env.CLAUDE_CLOUD_ARN = process.env.TEST_CLAUDE_CLOUD_ARN;
    process.env.KIMI_CLOUD_ARN = process.env.TEST_KIMI_CLOUD_ARN;
    process.env.CLOUD_INFERENCE_PROFILE_MARKER ??=
      "application-inference-profile";
    process.env.CLOUD_INFERENCE_ROUTING_PREFIX ??= "bedrock/converse/";
    process.env.CLOUD_MODEL_ROUTING_PREFIX ??= "bedrock/";

    const { buildModelSettings } =
      await import("../server/services/arc3/agentSdk/providerRegistry.ts");

    expect(buildModelSettings("gpt-5.4")).toEqual({});
  });
});
