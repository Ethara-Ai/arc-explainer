import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("ARC3 AgentSDK cloud registry", () => {
  it("prefers the Claude ARN region over CLOUD_REGION", async () => {
    process.env.CLOUD_REGION = "us-east-1";
    process.env.CLAUDE_CLOUD_ARN = process.env.TEST_CLAUDE_CLOUD_ARN;
    process.env.KIMI_CLOUD_ARN = process.env.TEST_KIMI_CLOUD_ARN;
    process.env.CLOUD_INFERENCE_PROFILE_MARKER ??=
      "application-inference-profile";
    process.env.CLOUD_INFERENCE_ROUTING_PREFIX ??= "bedrock/converse/";
    process.env.CLOUD_MODEL_ROUTING_PREFIX ??= "bedrock/";

    const { getModelConfig } =
      await import("../server/services/arc3/agentSdk/providerRegistry.ts");

    const config = getModelConfig("claude-opus-4-6");
    expect(config.cloudRegion).toBe("ap-south-1");
  });

  it("throws when CLAUDE_CLOUD_ARN is missing", async () => {
    delete process.env.CLAUDE_CLOUD_ARN;
    process.env.KIMI_CLOUD_ARN = process.env.TEST_KIMI_CLOUD_ARN;

    const { getModelConfig } =
      await import("../server/services/arc3/agentSdk/providerRegistry.ts");

    expect(() => getModelConfig("claude-opus-4-6")).toThrow(
      "CLAUDE_CLOUD_ARN is required",
    );
  });

  it("uses the Kimi ARN region when present", async () => {
    process.env.CLOUD_REGION = "us-east-1";
    process.env.CLAUDE_CLOUD_ARN = process.env.TEST_CLAUDE_CLOUD_ARN;
    process.env.KIMI_CLOUD_ARN = process.env.TEST_KIMI_CLOUD_ARN;
    process.env.CLOUD_INFERENCE_PROFILE_MARKER ??=
      "application-inference-profile";
    process.env.CLOUD_INFERENCE_ROUTING_PREFIX ??= "bedrock/converse/";
    process.env.CLOUD_MODEL_ROUTING_PREFIX ??= "bedrock/";

    const { getModelConfig } =
      await import("../server/services/arc3/agentSdk/providerRegistry.ts");

    const config = getModelConfig(process.env.KIMI_CLOUD_MODEL_ID!);
    expect(config.cloudRegion).toBe("ap-south-1");
  });
});
