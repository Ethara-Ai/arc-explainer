/**
 * @author Claude
 * @date 2026-04-02
 * PURPOSE: Unit tests for shared/providers/litellmSdkProvider.ts — LiteLLM SDK
 *   subprocess bridge provider. Tests thinking config, token extraction, cost
 *   calculation, tool call parsing, and vision support.
 * SRP: Tests LiteLLMSdkProvider class in isolation via mocked subprocess.
 * DRY: Shared helpers for mock setup and response building.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mock state — shared between mocks and test helpers
// ---------------------------------------------------------------------------

/** Captured stdin writes — each entry is a parsed JSON request */
let capturedRequests: Array<Record<string, unknown>> = [];

/** The mock readline instance used for emitting response lines */
let mockRlEmitter: EventEmitter;

/** The mock process stdout/stderr emitters */
let mockStdout: EventEmitter;
let mockStderr: EventEmitter;
let mockProcEmitter: EventEmitter;

/** Whether the bridge has sent the ready signal */
let readySent = false;

/** Auto-respond mode: when true, emits a result response after stdin.write */
let autoRespond = true;

/** Custom response builder — tests can override */
let responseBuilder: ((req: Record<string, unknown>) => Record<string, unknown>) | null = null;

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("child_process", () => {
  return {
    spawn: vi.fn(() => {
      mockStdout = new EventEmitter();
      mockStderr = new EventEmitter();
      mockProcEmitter = new EventEmitter();

      const mockProc = Object.assign(mockProcEmitter, {
        stdin: {
          write: vi.fn((data: string) => {
            const parsed = JSON.parse(data.trim());
            capturedRequests.push(parsed);

            if (autoRespond && responseBuilder) {
              const responseData = responseBuilder(parsed);
              // Schedule async to simulate real subprocess behavior
              setTimeout(() => {
                mockRlEmitter.emit("line", JSON.stringify({
                  type: "result",
                  id: parsed.id,
                  data: responseData,
                }));
              }, 1);
            }
            return true;
          }),
          end: vi.fn(),
        },
        stdout: mockStdout,
        stderr: mockStderr,
        killed: false,
        kill: vi.fn(),
        pid: 12345,
      });

      // Emit the "ready" signal shortly after spawn
      setTimeout(() => {
        if (!readySent) {
          readySent = true;
          mockRlEmitter.emit("line", JSON.stringify({ type: "ready" }));
        }
      }, 1);

      return mockProc;
    }),
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock("readline", () => {
  return {
    createInterface: vi.fn(() => {
      mockRlEmitter = new EventEmitter();
      return mockRlEmitter;
    }),
  };
});

vi.mock("../../server/config/env", () => ({
  getPythonBin: vi.fn(() => "python3"),
}));

// ---------------------------------------------------------------------------
// Import provider AFTER mocks are set up
// ---------------------------------------------------------------------------

import { LiteLLMSdkProvider } from "../../shared/providers/litellmSdkProvider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBridgeResponseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const usage = {
    prompt_tokens: 500,
    completion_tokens: 100,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...(overrides.usage as Record<string, unknown> ?? {}),
  };

  const message = {
    tool_calls: [
      {
        function: {
          name: "play_action",
          arguments: JSON.stringify({
            action: "UP",
            reasoning: "going up",
            notepad_update: null,
          }),
        },
      },
    ],
    content: null,
    reasoning_content: null,
    ...(overrides.message as Record<string, unknown> ?? {}),
  };

  return {
    usage,
    response: {
      choices: [{ message }],
    },
    cost_usd: 0.0042,
    ...(overrides.top as Record<string, unknown> ?? {}),
  };
}

function setDefaultResponseBuilder(overrides: Record<string, unknown> = {}) {
  responseBuilder = () => buildBridgeResponseData(overrides);
}

function createProvider(
  hint: "claude" | "gemini" | "openai" | "kimi" | null = null,
  enableThinking = true,
) {
  return new LiteLLMSdkProvider({
    apiKey: "test-key-00000000000000",
    modelId: "test-model",
    litellmModel: "test/test-model",
    displayName: "Test Model",
    providerHint: hint,
    enableThinking,
  });
}

const baseParams = {
  systemPrompt: "You are a puzzle solver.",
  conversationHistory: [] as Array<{ role: string; content: string }>,
  currentObservation: "Grid state here",
  validActions: ["UP", "DOWN", "LEFT", "RIGHT"],
  notepad: "",
  imageB64: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiteLLMSdkProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequests = [];
    readySent = false;
    autoRespond = true;
    responseBuilder = null;
  });

  afterEach(async () => {
    // Clear any pending timers
    vi.restoreAllMocks();
  });

  describe("provider-specific thinking config", () => {
    it("sends enabled thinking with budget for claude hint", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("claude");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.extra_body).toEqual({
        thinking: { type: "enabled", budget_tokens: 8192 },
      });
      expect(req.tool_choice).toBe("auto");
      expect(req.reasoning_effort).toBeUndefined();
      // Claude thinking bumps max_tokens to at least 9216
      expect(req.max_tokens).toBeGreaterThanOrEqual(9216);
    });

    it("sends reasoning_effort for openai hint", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.reasoning_effort).toBe("high");
      expect(req.extra_body).toBeUndefined();
      expect(req.tool_choice).toBe("required");
    });

    it("sends no thinking config for gemini hint (model-intrinsic)", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("gemini");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.extra_body).toBeUndefined();
      expect(req.reasoning_effort).toBeUndefined();
      // Gemini uses forced tool_choice
      expect(req.tool_choice).toEqual({
        type: "function",
        function: { name: "play_action" },
      });
    });

    it("sends no thinking config for kimi hint (not supported)", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("kimi");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.extra_body).toBeUndefined();
      expect(req.reasoning_effort).toBeUndefined();
    });

    it("sends enabled thinking with budget for null hint (default)", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider(null);
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.extra_body).toEqual({
        thinking: { type: "enabled", budget_tokens: 8192 },
      });
    });

    it("skips all thinking config when enableThinking is false", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("claude", false);
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.extra_body).toBeUndefined();
      expect(req.reasoning_effort).toBeUndefined();
      // When thinking is disabled, claude doesn't force auto — uses forced tool_choice
      expect(req.tool_choice).toEqual({
        type: "function",
        function: { name: "play_action" },
      });
    });

    it("skips thinking config for openai when disabled", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai", false);
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.reasoning_effort).toBeUndefined();
      expect(req.extra_body).toBeUndefined();
      // openai still uses "required" tool_choice regardless of thinking
      expect(req.tool_choice).toBe("required");
    });
  });

  describe("cost extraction", () => {
    it("uses cost_usd from bridge response data", async () => {
      responseBuilder = () => buildBridgeResponseData({ top: { cost_usd: 0.00785 } });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.costUsd).toBeCloseTo(0.00785, 5);
    });

    it("returns null costUsd when bridge returns cost_usd: null", async () => {
      responseBuilder = () => buildBridgeResponseData({ top: { cost_usd: null } });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.costUsd).toBeNull();
    });

    it("returns 0 costUsd when bridge returns cost_usd: 0", async () => {
      responseBuilder = () => buildBridgeResponseData({ top: { cost_usd: 0 } });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.costUsd).toBe(0);
    });

    it("returns null costUsd when bridge omits cost_usd entirely", async () => {
      responseBuilder = () => {
        const data = buildBridgeResponseData();
        delete (data as Record<string, unknown>).cost_usd;
        return data;
      };
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.costUsd).toBeNull();
    });
  });

  describe("thinkingText extraction", () => {
    it("extracts thinkingText from reasoning_content field", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          reasoning_content: "I should go up because the goal is above.",
          tool_calls: [
            {
              function: {
                name: "play_action",
                arguments: JSON.stringify({ action: "UP", reasoning: "go up" }),
              },
            },
          ],
          content: null,
        },
      });
      const provider = createProvider("claude");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.thinkingText).toBe(
        "I should go up because the goal is above.",
      );
    });

    it("extracts thinkingText from thinking content blocks array", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          reasoning_content: null,
          content: [
            { type: "thinking", thinking: "First thought" },
            { type: "thinking", thinking: "Second thought" },
            { type: "text", text: "some text" },
          ],
          tool_calls: [
            {
              function: {
                name: "play_action",
                arguments: JSON.stringify({ action: "DOWN", reasoning: "go down" }),
              },
            },
          ],
        },
      });
      const provider = createProvider("claude");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.thinkingText).toBe("First thought\n\nSecond thought");
    });

    it("returns null thinkingText when no reasoning present", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.thinkingText).toBeNull();
    });

    it("prefers reasoning_content over content blocks when both present", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          reasoning_content: "Direct reasoning field",
          content: [
            { type: "thinking", thinking: "Block reasoning" },
          ],
          tool_calls: [
            {
              function: {
                name: "play_action",
                arguments: JSON.stringify({ action: "UP", reasoning: "test" }),
              },
            },
          ],
        },
      });
      const provider = createProvider("claude");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.thinkingText).toBe("Direct reasoning field");
    });
  });

  describe("token extraction", () => {
    it("extracts basic prompt and completion tokens", async () => {
      responseBuilder = () => buildBridgeResponseData({
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(200);
    });

    it("extracts reasoning_tokens from usage", async () => {
      responseBuilder = () => buildBridgeResponseData({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          reasoning_tokens: 150,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.reasoningTokens).toBe(150);
    });

    it("extracts cached_tokens from usage", async () => {
      responseBuilder = () => buildBridgeResponseData({
        usage: {
          prompt_tokens: 800,
          completion_tokens: 100,
          cached_tokens: 200,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.cachedInputTokens).toBe(200);
      // input adjusted: 800 - 200 = 600
      expect(result.inputTokens).toBe(600);
    });

    it("extracts cache_read_input_tokens (Anthropic style)", async () => {
      responseBuilder = () => buildBridgeResponseData({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          cached_tokens: 0,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 50,
        },
      });
      const provider = createProvider("claude");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.cachedInputTokens).toBe(300);
      expect(result.cacheWriteTokens).toBe(50);
      // input adjusted: 1000 - 300 = 700
      expect(result.inputTokens).toBe(700);
    });

    it("adjusts input tokens by subtracting cached tokens", async () => {
      responseBuilder = () => buildBridgeResponseData({
        usage: {
          prompt_tokens: 500,
          completion_tokens: 50,
          cached_tokens: 500,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      // Math.max(0, 500 - 500) = 0
      expect(result.inputTokens).toBe(0);
      expect(result.cachedInputTokens).toBe(500);
    });
  });

  describe("tool call parsing", () => {
    it("parses standard tool call response", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.action).toBe("UP");
      expect(result.reasoning).toBe("going up");
    });

    it("falls back to text parsing when tool call JSON is invalid", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          tool_calls: [
            {
              function: {
                name: "play_action",
                arguments: "not valid json with action UP",
              },
            },
          ],
          content: null,
          reasoning_content: null,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.action).toBe("UP");
    });

    it("falls back to content parsing when no tool calls", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          tool_calls: undefined,
          content: '{"action": "LEFT", "reasoning": "go left"}',
          reasoning_content: null,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.action).toBe("LEFT");
      expect(result.reasoning).toBe("go left");
    });

    it("returns SKIP when no valid content or tool calls", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          tool_calls: undefined,
          content: null,
          reasoning_content: null,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.action).toBe("SKIP");
    });

    it("extracts notepad_update from tool call arguments", async () => {
      responseBuilder = () => buildBridgeResponseData({
        message: {
          tool_calls: [
            {
              function: {
                name: "play_action",
                arguments: JSON.stringify({
                  action: "RIGHT",
                  reasoning: "moving right",
                  notepad_update: "Remember: wall is on left",
                }),
              },
            },
          ],
          content: null,
          reasoning_content: null,
        },
      });
      const provider = createProvider("openai");
      const result = await provider.chooseActionAsync(baseParams);

      expect(result.action).toBe("RIGHT");
      expect(result.notepadUpdate).toBe("Remember: wall is on left");
    });
  });

  describe("vision support", () => {
    it("includes image_url in user message when imageB64 provided", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("kimi");
      await provider.chooseActionAsync({
        ...baseParams,
        imageB64: "iVBORw0KGgoAAAANS",
      });

      const req = capturedRequests[0];
      const messages = req.messages as Array<Record<string, unknown>>;
      const userMsg = messages[messages.length - 1];
      const content = userMsg.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("image_url");
      const imgUrl = content[1].image_url as Record<string, string>;
      expect(imgUrl.url).toContain("data:image/png;base64,iVBORw0KGgoAAAANS");
    });

    it("strips data: prefix from imageB64 before wrapping", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("claude");
      await provider.chooseActionAsync({
        ...baseParams,
        imageB64: "data:image/png;base64,ABC123",
      });

      const req = capturedRequests[0];
      const messages = req.messages as Array<Record<string, unknown>>;
      const userMsg = messages[messages.length - 1];
      const content = userMsg.content as Array<Record<string, unknown>>;
      const imgUrl = content[1].image_url as Record<string, string>;
      // Should not double-wrap the data: prefix
      expect(imgUrl.url).toBe("data:image/png;base64,ABC123");
    });

    it("omits image when imageB64 is null", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      const messages = req.messages as Array<Record<string, unknown>>;
      const userMsg = messages[messages.length - 1];
      const content = userMsg.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
    });
  });

  describe("request payload structure", () => {
    it("includes model, messages, tools, and api_key in bridge request", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      expect(req.type).toBe("completion");
      expect(req.model).toBe("test/test-model");
      expect(req.api_key).toBe("test-key-00000000000000");
      expect(req.messages).toBeDefined();
      expect(req.tools).toBeDefined();
      expect(req.id).toBeDefined(); // UUID for multiplexing
    });

    it("includes system message and user message in messages array", async () => {
      setDefaultResponseBuilder();
      const provider = createProvider("openai");
      await provider.chooseActionAsync(baseParams);

      const req = capturedRequests[0];
      const messages = req.messages as Array<Record<string, unknown>>;
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toBe("You are a puzzle solver.");
      expect(messages[messages.length - 1].role).toBe("user");
    });
  });
});
