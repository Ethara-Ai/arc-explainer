import { describe, it, expect } from "vitest";

import {
  BaseProvider,
  ProviderResponse,
  ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
} from "../providers/base";

import { PRICING, computeCost, TokenPricing } from "../providers/pricing";

import { extractRegionFromId } from "../providers/regionUtils";

import {
  MODEL_REGISTRY,
  ALL_MODEL_KEYS,
  DEFAULT_EVAL_CONFIG,
  getModelConfig,
  EvalConfig,
  ModelConfig,
} from "../config/llmConfig";

import { OpenAIProvider } from "../providers/openaiProvider";
import { ClaudeCloudProvider } from "../providers/claudeCloudProvider";
import { KimiCloudProvider } from "../providers/kimiCloudProvider";
import { AnthropicClaudeProvider } from "../providers/anthropicClaudeProvider";
import { KimiProvider } from "../providers/kimiProvider";
import { OpenRouterGeminiProvider } from "../providers/openrouterGeminiProvider";
import { GeminiFallbackProvider } from "../providers/geminiFallbackProvider";
import { LiteLLMSdkProvider } from "../providers/litellmSdkProvider";

// ═══════════════════════════════════════════════════════════════════════════
// 1. BaseProvider: shared response parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("BaseProvider.extractJsonWithAction", () => {
  it("extracts valid JSON with action key", () => {
    const text =
      'Some preamble {"action": "UP", "reasoning": "go up"} trailing';
    const result = BaseProvider.extractJsonWithAction(text);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("UP");
    expect(result!.reasoning).toBe("go up");
  });

  it("returns null when no JSON found", () => {
    expect(BaseProvider.extractJsonWithAction("no json here")).toBeNull();
  });

  it("returns null when JSON has no action key", () => {
    expect(
      BaseProvider.extractJsonWithAction('{"reasoning": "hmm"}'),
    ).toBeNull();
  });

  it("handles nested braces in strings", () => {
    const text = '{"action": "CLICK 5 3", "reasoning": "cell at {5,3}"}';
    const result = BaseProvider.extractJsonWithAction(text);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("CLICK 5 3");
  });

  it("skips invalid JSON and finds next valid one", () => {
    const text = '{broken {"action": "DOWN", "reasoning": "valid"}';
    const result = BaseProvider.extractJsonWithAction(text);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("DOWN");
  });

  it("extracts notepad_update when present", () => {
    const text =
      '{"action": "SELECT", "reasoning": "test", "notepad_update": "my notes"}';
    const result = BaseProvider.extractJsonWithAction(text);
    expect(result).not.toBeNull();
    expect(result!.notepad_update).toBe("my notes");
  });

  it("handles null notepad_update", () => {
    const text = '{"action": "UP", "reasoning": "x", "notepad_update": null}';
    const result = BaseProvider.extractJsonWithAction(text);
    expect(result).not.toBeNull();
    expect(result!.notepad_update).toBeNull();
  });
});

describe("BaseProvider.matchAction", () => {
  const actions = ["UP", "DOWN", "LEFT", "RIGHT", "CLICK", "SELECT", "RESET"];

  it("matches exact action", () => {
    expect(BaseProvider.matchAction("UP", actions)).toBe("UP");
  });

  it("matches case-insensitive", () => {
    expect(BaseProvider.matchAction("down", actions)).toBe("DOWN");
    expect(BaseProvider.matchAction("Left", actions)).toBe("LEFT");
  });

  it("matches prefix for compound actions (CLICK x y)", () => {
    const result = BaseProvider.matchAction("CLICK 10 15", actions);
    expect(result).toBe("CLICK 10 15");
  });

  it("returns as-is when no match found", () => {
    expect(BaseProvider.matchAction("JUMP", actions)).toBe("JUMP");
  });

  it("handles empty valid actions list", () => {
    expect(BaseProvider.matchAction("UP", [])).toBe("UP");
  });
});

describe("buildActionDescription", () => {
  it("lists valid actions when provided", () => {
    const desc = buildActionDescription(["UP", "DOWN", "LEFT"]);
    expect(desc).toContain("UP");
    expect(desc).toContain("DOWN");
    expect(desc).toContain("LEFT");
    expect(desc).toContain("Valid actions this turn");
  });

  it("returns generic description for empty list", () => {
    expect(buildActionDescription([])).toBe("Action to take");
  });
});

describe("createProviderResponse", () => {
  it("fills default values for optional fields", () => {
    const resp = createProviderResponse({
      action: "UP",
      reasoning: "test",
      notepadUpdate: null,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      costUsd: 0.001,
      rawResponse: null,
    });
    expect(resp.cachedInputTokens).toBe(0);
    expect(resp.cacheWriteTokens).toBe(0);
    expect(resp.trafficType).toBeNull();
  });

  it("allows overriding optional fields", () => {
    const resp = createProviderResponse({
      action: "DOWN",
      reasoning: "r",
      notepadUpdate: null,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      costUsd: 0.01,
      rawResponse: null,
      cachedInputTokens: 500,
      trafficType: "ON_DEMAND_PRIORITY",
    });
    expect(resp.cachedInputTokens).toBe(500);
    expect(resp.trafficType).toBe("ON_DEMAND_PRIORITY");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Pricing engine
// ═══════════════════════════════════════════════════════════════════════════

describe("PRICING table", () => {
  it("has entries for all core models", () => {
    expect(PRICING["gpt-5.4"]).toBeDefined();
    expect(PRICING["gemini-3.1-pro-preview"]).toBeDefined();
    expect(PRICING["gemini-3.1-pro-preview-priority"]).toBeDefined();
    expect(PRICING[process.env.CLAUDE_CLOUD_MODEL_ID!]).toBeDefined();
    expect(PRICING[process.env.KIMI_CLOUD_MODEL_ID!]).toBeDefined();
    expect(PRICING["claude-opus-4-6"]).toBeDefined();
    expect(PRICING["kimi-k2.5"]).toBeDefined();
  });

  it("has valid pricing structure for each model", () => {
    for (const [key, pricing] of Object.entries(PRICING)) {
      expect(pricing.inputPerM).toBeGreaterThanOrEqual(0);
      expect(pricing.outputPerM).toBeGreaterThan(0);
      expect(pricing.longContextThreshold).toBeGreaterThanOrEqual(0);
    }
  });

  it("priority tier is ~1.8x standard for Gemini", () => {
    const std = PRICING["gemini-3.1-pro-preview"];
    const pri = PRICING["gemini-3.1-pro-preview-priority"];
    // Allow small rounding margin
    expect(pri.inputPerM / std.inputPerM).toBeCloseTo(1.8, 1);
    expect(pri.outputPerM / std.outputPerM).toBeCloseTo(1.8, 1);
  });
});

describe("computeCost", () => {
  it("calculates GPT-5.4 cost correctly", () => {
    const cost = computeCost("gpt-5.4", 1000, 500, 100);
    // input: 1000/1M * 2.50 = 0.0025
    // text output: (500-100)/1M * 15.00 = 0.006
    // reasoning: 100/1M * 15.00 = 0.0015
    // total = 0.01
    expect(cost).toBeCloseTo(0.01, 6);
  });

  it("applies long-context tier when threshold exceeded", () => {
    const shortCost = computeCost("gpt-5.4", 100_000, 1000);
    const longCost = computeCost("gpt-5.4", 272_000, 1000);
    // Long-context input rate is 2x standard (5.00 vs 2.50)
    expect(longCost).toBeGreaterThan(shortCost);
  });

  it("accounts for cached input tokens", () => {
    const noCacheCost = computeCost("gpt-5.4", 1000, 500);
    const withCacheCost = computeCost("gpt-5.4", 500, 500, 0, 500);
    // Cached tokens are cheaper (0.25/M vs 2.50/M), so total should be less
    expect(withCacheCost).toBeLessThan(noCacheCost);
  });

  it("accounts for cache write tokens", () => {
    const baseCost = computeCost("gpt-5.4", 1000, 500);
    const withWriteCost = computeCost("gpt-5.4", 1000, 500, 0, 0, 1000);
    expect(withWriteCost).toBeGreaterThan(baseCost);
  });

  it("subtracts reasoning from output to avoid double-billing", () => {
    // 1000 output, 1000 reasoning -> text output = 0
    const cost = computeCost("gpt-5.4", 1000, 1000, 1000);
    // input: 1000/1M * 2.50 = 0.0025
    // text output: 0/1M * 15.00 = 0
    // reasoning: 1000/1M * 15.00 = 0.015
    expect(cost).toBeCloseTo(0.0175, 6);
  });

  it("throws for unknown model", () => {
    expect(() => computeCost("nonexistent-model", 100, 100)).toThrow(
      /No pricing data/,
    );
  });

  it("does prefix matching for ARN-style model IDs", () => {
    const modelId = process.env.CLAUDE_CLOUD_MODEL_ID!;
    const cost = computeCost(modelId, 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });

  it("returns zero cost for zero tokens", () => {
    expect(computeCost("gpt-5.4", 0, 0)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. regionUtils
// ═══════════════════════════════════════════════════════════════════════════

describe("extractRegionFromId", () => {
  it("extracts region from valid ARN", () => {
    const testClaudeId = process.env.TEST_CLAUDE_CLOUD_ARN!;
    expect(extractRegionFromId(testClaudeId)).toBe("ap-south-1");
    const testKimiId = process.env.TEST_KIMI_CLOUD_ARN!;
    expect(extractRegionFromId(testKimiId)).toBe("ap-south-1");
  });

  it("returns null for non-ARN model IDs", () => {
    expect(extractRegionFromId(process.env.CLAUDE_CLOUD_MODEL_ID!)).toBeNull();
    expect(extractRegionFromId(process.env.KIMI_CLOUD_MODEL_ID!)).toBeNull();
    expect(extractRegionFromId("gpt-5.4")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRegionFromId("")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Config registry (shared/config/llmConfig.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("MODEL_REGISTRY", () => {
  it("contains all 15 model keys", () => {
    expect(ALL_MODEL_KEYS.length).toBe(15);
  });

  it("includes the 4 core MVP models", () => {
    expect(MODEL_REGISTRY["gpt-5.4-thinking"]).toBeDefined();
    expect(MODEL_REGISTRY["gemini-3.1"]).toBeDefined();
    expect(MODEL_REGISTRY["claude-opus"]).toBeDefined();
    expect(MODEL_REGISTRY["kimi-k2.5"]).toBeDefined();
  });

  it("every model has required fields", () => {
    for (const [key, cfg] of Object.entries(MODEL_REGISTRY)) {
      expect(cfg.name).toBeTruthy();
      expect(cfg.modelId).toBeTruthy();
      expect(cfg.provider).toBeTruthy();
      expect(cfg.envKey).toBeTruthy();
    }
  });

  it("maps correct providers for each model family", () => {
    expect(MODEL_REGISTRY["gpt-5.4-thinking"].provider).toBe("openai");
    expect(MODEL_REGISTRY["claude-opus"].provider).toBe("claude-cloud");
    expect(MODEL_REGISTRY["kimi-k2.5"].provider).toBe("kimi-cloud");
    expect(MODEL_REGISTRY["claude-a1"].provider).toBe("anthropic");
    expect(MODEL_REGISTRY["gemini-3.1-studio"].provider).toBe("gemini");
    expect(MODEL_REGISTRY["gemini-3.1-openrouter"].provider).toBe(
      "openrouter-gemini",
    );
    expect(MODEL_REGISTRY["litellm-sdk-gemini-3.1"].provider).toBe(
      "litellm-sdk",
    );
    expect(MODEL_REGISTRY["gemini-3.1"].provider).toBe("gemini-fallback");
  });

  it("GPT-5.4 has reasoning_effort set to high", () => {
    expect(MODEL_REGISTRY["gpt-5.4-thinking"].reasoningEffort).toBe("high");
  });

  it("Gemini priority has correct headers", () => {
    const cfg = MODEL_REGISTRY["gemini-3.1-priority"];
    expect(cfg.additionalHeaders).toBeDefined();
    expect(cfg.additionalHeaders!["X-Vertex-AI-LLM-Request-Type"]).toBe(
      "shared",
    );
    expect(cfg.additionalHeaders!["X-Vertex-AI-LLM-Shared-Request-Type"]).toBe(
      "priority",
    );
    expect(cfg.pricingModelId).toBe("gemini-3.1-pro-preview-priority");
  });

  it("LiteLLM SDK models have litellmModel set", () => {
    expect(MODEL_REGISTRY["litellm-sdk-gemini-3.1"].litellmModel).toBe(
      "gemini/gemini-3.1-pro-preview",
    );
    expect(MODEL_REGISTRY["litellm-sdk-claude-opus"].litellmModel).toContain(
      process.env.CLOUD_MODEL_ROUTING_PREFIX ??
        process.env.CLOUD_INFERENCE_ROUTING_PREFIX,
    );
    expect(MODEL_REGISTRY["litellm-sdk-claude-a1"].litellmModel).toBe(
      "anthropic/claude-opus-4-6",
    );
  });
});

describe("getModelConfig", () => {
  it("returns config for valid model key", () => {
    const cfg = getModelConfig("gpt-5.4-thinking");
    expect(cfg.name).toBe("GPT 5.4 Thinking");
    expect(cfg.modelId).toBe("gpt-5.4");
    expect(cfg.provider).toBe("openai");
  });

  it("throws for unknown model key", () => {
    expect(() => getModelConfig("nonexistent")).toThrow(/Unknown model/);
  });
});

describe("DEFAULT_EVAL_CONFIG", () => {
  it("has correct default values", () => {
    expect(DEFAULT_EVAL_CONFIG.maxSteps).toBe(200);
    expect(DEFAULT_EVAL_CONFIG.numRuns).toBe(3);
    expect(DEFAULT_EVAL_CONFIG.contextWindow).toBe(50);
    expect(DEFAULT_EVAL_CONFIG.seedBase).toBe(42);
    expect(DEFAULT_EVAL_CONFIG.dryRun).toBe(false);
    expect(DEFAULT_EVAL_CONFIG.maxConsecutiveSkips).toBe(10);
  });

  it("has concurrency limits for all provider types", () => {
    const c = DEFAULT_EVAL_CONFIG.providerMaxConcurrent;
    expect(c["openai"]).toBeGreaterThan(0);
    expect(c["gemini"]).toBeGreaterThan(0);
    expect(c["claude-cloud"]).toBeGreaterThan(0);
    expect(c["kimi-cloud"]).toBeGreaterThan(0);
    expect(c["anthropic"]).toBeGreaterThan(0);
    expect(c["litellm-sdk"]).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Provider class structure (no API calls)
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider classes extend BaseProvider", () => {
  it("OpenAIProvider extends BaseProvider", () => {
    const p = new OpenAIProvider({ apiKey: "test-key" });
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("GPT 5.4");
    expect(p.modelId).toBe("gpt-5.4");
  });

  it("ClaudeCloudProvider extends BaseProvider and requires API key", () => {
    expect(() => new ClaudeCloudProvider({ apiKey: "" })).toThrow(
      /CLOUD_API_KEY/,
    );
    const p = new ClaudeCloudProvider({ apiKey: "test-key" });
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("Claude Opus 4.6");
  });

  it("KimiCloudProvider extends BaseProvider and requires API key", () => {
    expect(() => new KimiCloudProvider({ apiKey: "" })).toThrow(
      /CLOUD_API_KEY/,
    );
    const p = new KimiCloudProvider({ apiKey: "test-key" });
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("Kimi K2.5");
  });

  it("AnthropicClaudeProvider extends BaseProvider and requires API key", () => {
    expect(() => new AnthropicClaudeProvider({ apiKey: "" })).toThrow(
      /API key/,
    );
    const p = new AnthropicClaudeProvider({ apiKey: "test-key" });
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("Claude Opus 4.6");
  });

  it("KimiProvider extends OpenAIProvider (thin wrapper)", () => {
    const p = new KimiProvider({ apiKey: "test-key" });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("Kimi k2.5");
    expect(p.modelId).toBe("kimi-k2.5");
  });

  it("OpenRouterGeminiProvider extends OpenAIProvider (thin wrapper)", () => {
    const p = new OpenRouterGeminiProvider({ apiKey: "test-key" });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("Gemini 3.1");
  });

  it("LiteLLMSdkProvider extends BaseProvider", () => {
    const p = new LiteLLMSdkProvider({
      apiKey: "test-key",
      modelId: "test-model",
      litellmModel: "test/model",
    });
    expect(p).toBeInstanceOf(BaseProvider);
    expect(p.modelName).toBe("LiteLLM SDK Model");
  });

  it("GeminiFallbackProvider requires at least one tier", () => {
    expect(
      () =>
        new GeminiFallbackProvider({
          tiers: [],
          modelId: "x",
          displayName: "y",
        }),
    ).toThrow(/at least one tier/);
  });
});

describe("Provider sync chooseAction throws (must use async)", () => {
  it("OpenAIProvider.chooseAction throws with guidance", () => {
    const p = new OpenAIProvider({ apiKey: "test" });
    expect(() => p.chooseAction({} as ChooseActionParams)).toThrow(
      /chooseActionAsync/,
    );
  });

  it("ClaudeCloudProvider.chooseAction throws with guidance", () => {
    const p = new ClaudeCloudProvider({ apiKey: "test" });
    expect(() => p.chooseAction({} as ChooseActionParams)).toThrow(
      /chooseActionAsync/,
    );
  });

  it("KimiCloudProvider.chooseAction throws with guidance", () => {
    const p = new KimiCloudProvider({ apiKey: "test" });
    expect(() => p.chooseAction({} as ChooseActionParams)).toThrow(
      /chooseActionAsync/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Barrel export (shared/providers/index.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("Barrel export completeness", () => {
  it("exports all provider classes and utilities", async () => {
    const barrel = await import("../providers/index");
    // Base
    expect(barrel.BaseProvider).toBeDefined();
    expect(barrel.buildActionDescription).toBeDefined();
    expect(barrel.createProviderResponse).toBeDefined();
    expect(barrel.sanitizeRawResponse).toBeDefined();
    // Pricing
    expect(barrel.PRICING).toBeDefined();
    expect(barrel.computeCost).toBeDefined();
    // Utils
    expect(barrel.extractRegionFromId).toBeDefined();
    // Providers
    expect(barrel.OpenAIProvider).toBeDefined();
    expect(barrel.ClaudeCloudProvider).toBeDefined();
    expect(barrel.KimiCloudProvider).toBeDefined();
    expect(barrel.AnthropicClaudeProvider).toBeDefined();
    expect(barrel.KimiProvider).toBeDefined();
    expect(barrel.OpenRouterGeminiProvider).toBeDefined();
    expect(barrel.GeminiFallbackProvider).toBeDefined();
    expect(barrel.LiteLLMSdkProvider).toBeDefined();
  });
});
