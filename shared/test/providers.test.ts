import { describe, it, expect } from "vitest";

import {
  BaseProvider,
  ProviderResponse,
  ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
} from "../providers/base";

import { extractDeduplicatedReasoning } from "../providers/reasoningDedup";

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

  it("returns SKIP when no match found", () => {
    expect(BaseProvider.matchAction("JUMP", actions)).toBe("SKIP");
  });

  it("handles empty valid actions list", () => {
    expect(BaseProvider.matchAction("UP", [])).toBe("SKIP");
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

// ═══════════════════════════════════════════════════════════════════════════
// 1b. parseActionResponse: last-declaration regex fallback (Change A)
// ═══════════════════════════════════════════════════════════════════════════

class TestProvider extends BaseProvider {
  get modelName() { return "Test"; }
  get modelId() { return "test"; }
  async chooseActionAsync(): Promise<ProviderResponse> {
    throw new Error("Not implemented");
  }
  testParse(text: string, validActions: string[]): [string, string, string | null] {
    return this.parseActionResponse(text, validActions);
  }
}

describe("parseActionResponse fallback (last-declaration regex)", () => {
  const provider = new TestProvider();
  const actions = ["UP", "DOWN", "LEFT", "RIGHT", "RESET", "SELECT"];

  it("extracts action from 'Action: UP' declaration", () => {
    const text = "I think I should go up.\nAction: UP";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("UP");
  });

  it("uses last declaration when multiple present", () => {
    const text = "Action: RESET\nWait no, reconsider.\nAction: DOWN";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("DOWN");
  });

  it("handles 'Acting:' variant", () => {
    const text = "My analysis...\nActing: LEFT";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("LEFT");
  });

  it("handles quoted action values", () => {
    const text = 'Action: "SELECT"';
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("SELECT");
  });

  it("does NOT extract action from narrative text mentioning keyword", () => {
    const text = "I should not RESET the board. Let me think more carefully about this.";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("SKIP");
  });

  it("returns SKIP when declaration has invalid action", () => {
    const text = "Action: JUMP";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("SKIP");
  });

  it("case-insensitive match for declared action", () => {
    const text = "Action: up";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("UP");
  });

  it("JSON extraction takes priority over declaration regex", () => {
    const text = 'Action: LEFT\n{"action": "RIGHT", "reasoning": "correct"}';
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("RIGHT");
  });

  it("empty response returns SKIP", () => {
    const [action, reasoning] = provider.testParse("", actions);
    expect(action).toBe("SKIP");
    expect(reasoning).toContain("empty");
  });

  it("reasoning is truncated to 2500 chars in fallback", () => {
    const longText = "x".repeat(5000) + "\nAction: UP";
    const [, reasoning] = provider.testParse(longText, actions);
    expect(reasoning.length).toBeLessThanOrEqual(2700);
  });

  it("returns last VALID action, not last any action (Action: DOWN then Action: GARBAGE)", () => {
    const text = "Reasoning: analysis\nAction: DOWN\nMore text\nAction: GARBAGE";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("DOWN");
  });

  it("ignores 'Action: action' template echo after valid declaration", () => {
    const text = "Action: LEFT\nSome reasoning here\nAction: action";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("LEFT");
  });

  it("does not partial-match 'selected' to valid action 'SELECT'", () => {
    const text = "Action: selected";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("SKIP");
  });

  it("matches Action:reset (no space after colon)", () => {
    const text = "Action:RESET";
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("RESET");
  });

  it("rejects Action: <action> template echo as invalid", () => {
    const text = 'Action: UP\nChoose carefully\nAction: "action"';
    const [action] = provider.testParse(text, actions);
    expect(action).toBe("UP");
  });

  // CLICK coordinate preservation tests
  const clickActions = ["UP", "DOWN", "LEFT", "RIGHT", "CLICK", "SUBMIT"];

  it("preserves CLICK coordinates from declaration", () => {
    const [action] = provider.testParse(
      "Reasoning: cell at row 22 col 27\nAction: CLICK 22 27",
      clickActions,
    );
    expect(action).toBe("CLICK 22 27");
  });

  it("handles bare CLICK without coordinates", () => {
    const [action] = provider.testParse("Action: CLICK", clickActions);
    expect(action).toBe("CLICK");
  });

  it("preserves CLICK with single coordinate pair", () => {
    const [action] = provider.testParse("Action: CLICK 5 9", clickActions);
    expect(action).toBe("CLICK 5 9");
  });

  it("does not capture non-digit suffixes after action word", () => {
    const [action] = provider.testParse("Action: CLICK abc", clickActions);
    expect(action).toBe("CLICK");
  });

  it("does NOT append trailing digits to non-coordinate actions", () => {
    const [action] = provider.testParse("Action: UP 5", clickActions);
    expect(action).toBe("UP");
  });

  it("caps CLICK coordinates at 2 numbers (discards excess)", () => {
    const [action] = provider.testParse("Action: CLICK 10 15 20", clickActions);
    expect(action).toBe("CLICK 10 15");
  });

  it("handles CLICK 0 0 (zero coordinates)", () => {
    const [action] = provider.testParse("Action: CLICK 0 0", clickActions);
    expect(action).toBe("CLICK 0 0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1c. Kimi reasoning dedup (Change B)
// ═══════════════════════════════════════════════════════════════════════════

describe("extractDeduplicatedReasoning", () => {
  it("strips paired <think> blocks", () => {
    const text = "<think>internal reasoning</think>Reasoning: The grid shows a pattern.";
    const result = extractDeduplicatedReasoning(text);
    expect(result).not.toContain("internal reasoning");
    expect(result).toContain("grid shows a pattern");
  });

  it("deduplicates repeated reasoning segments", () => {
    const text = [
      "Reasoning: The grid has 3 colored cells in the top row.",
      "Action: UP",
      "Reasoning: The grid has 3 colored cells in the top row.",
      "Action: DOWN",
      "Reasoning: Now I see 4 cells moved to bottom row.",
    ].join("\n");
    const result = extractDeduplicatedReasoning(text);
    const occurrences = result.match(/3 colored cells/g);
    expect(occurrences?.length ?? 0).toBeLessThanOrEqual(1);
    expect(result).toContain("4 cells moved");
  });

  it("preserves unique segments", () => {
    const text = [
      "Reasoning: First I notice the blue pattern.",
      "Action: UP",
      "Reasoning: After moving, the red cells shifted.",
      "Action: DOWN",
      "Reasoning: The green border emerged.",
    ].join("\n");
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("blue pattern");
    expect(result).toContain("red cells shifted");
    expect(result).toContain("green border");
  });

  it("caps output at ~2500 chars with sentence boundary", () => {
    const longSegment = "Reasoning: " + "This is a sentence. ".repeat(200);
    const result = extractDeduplicatedReasoning(longSegment);
    expect(result.length).toBeLessThanOrEqual(2700);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles text with no Reasoning: markers (passthrough with clean)", () => {
    const text = "The model produced some output without markers. It goes on and on.";
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("model produced some output");
  });

  it("handles segment terminated by JSON block", () => {
    const text = 'Reasoning: I should select cell 5.\n{"action": "SELECT", "reasoning": "pick"}';
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("select cell 5");
    expect(result).not.toContain('"action"');
  });

  it("handles segment terminated by </think>", () => {
    const text = "Reasoning: The answer is clear.</think>other stuff";
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("answer is clear");
  });

  it("strips marker prefixes from output", () => {
    const text = "Reasoning: Just the reasoning content here.";
    const result = extractDeduplicatedReasoning(text);
    expect(result).not.toMatch(/^Reasoning:/);
    expect(result).toContain("reasoning content here");
  });

  it("accepts segment at 74% overlap, rejects at 76% (boundary test)", () => {
    // Build two segments: seg1 has 10 words, seg2 shares exactly N of them
    const baseWords = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    // 8/10 overlap = 80% → should reject
    const seg2High = "alpha bravo charlie delta echo foxtrot golf hotel kilo lima";
    const textHigh = `Reasoning: ${baseWords}\nAction: UP\nReasoning: ${seg2High}`;
    const resultHigh = extractDeduplicatedReasoning(textHigh);
    const highCount = (resultHigh.match(/kilo/g) ?? []).length;
    expect(highCount).toBe(0);

    // 7/10 overlap = 70% → should accept
    const seg2Low = "alpha bravo charlie delta echo foxtrot golf unique1 unique2 unique3";
    const textLow = `Reasoning: ${baseWords}\nAction: UP\nReasoning: ${seg2Low}`;
    const resultLow = extractDeduplicatedReasoning(textLow);
    expect(resultLow).toContain("unique1");
  });

  it("handles no-markers path with clean_no_markers_content equivalent", () => {
    const text = "Some analysis of the grid.\nnotepad_update: stuff\nAction: UP\nChoose your next action from the list.";
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("analysis of the grid");
    expect(result).not.toContain("notepad_update");
    expect(result).not.toContain("Choose your next action");
  });

  it("strips template JSON echo from segments", () => {
    const text = 'Reasoning: I see a pattern.{"action": "<action>", "reasoning": "<why>" more stuff}';
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("see a pattern");
    expect(result).not.toContain("<action>");
  });

  it("terminates segment at 'Please respond with'", () => {
    const text = "Reasoning: My analysis is complete.\nPlease respond with valid JSON:";
    const result = extractDeduplicatedReasoning(text);
    expect(result).toContain("analysis is complete");
    expect(result).not.toContain("Please respond");
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
