import type { ModelRequest } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  LiteLLMAgentModel,
  normalizeResponseToolCalls,
} from "../server/services/arc3/agentSdk/LiteLLMAgentModel.ts";

function buildModelRequest(): ModelRequest {
  return {
    input: "Inspect the board.",
    modelSettings: {},
    tools: [],
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

function buildBridgeResponse(): { data: Record<string, unknown> } {
  return {
    data: {
      response: {
        choices: [
          {
            message: {
              content: "ok",
            },
          },
        ],
      },
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
      },
    },
  };
}

describe("normalizeResponseToolCalls", () => {
  it("recovers the real tool name from tool_use content when tool_calls are malformed", () => {
    const normalized = normalizeResponseToolCalls({
      tool_calls: [
        {
          id: "call_1",
          function: {
            name: "tooluse_3xkyPgMx8M6jR1BiLA9TQ7",
            arguments:
              '<|tool_call_argument_begin|> {"note":"check the board"}',
          },
        },
      ],
      content: [
        {
          type: "tool_use",
          id: "tooluse_3xkyPgMx8M6jR1BiLA9TQ7",
          name: "inspect_game_state",
          input: { note: "check the board" },
        },
      ],
    });

    expect(normalized).toEqual([
      {
        id: "tooluse_3xkyPgMx8M6jR1BiLA9TQ7",
        name: "inspect_game_state",
        arguments: JSON.stringify({ note: "check the board" }),
      },
    ]);
  });

  it("falls back to content tool_use blocks when tool_calls are absent", () => {
    const normalized = normalizeResponseToolCalls({
      content: [
        {
          type: "tool_use",
          id: "tooluse_abc",
          name: "inspect_game_state",
          input: { note: null },
        },
      ],
    });

    expect(normalized[0]?.name).toBe("inspect_game_state");
    expect(normalized[0]?.arguments).toBe(JSON.stringify({ note: null }));
  });
});

describe("LiteLLMAgentModel request shaping", () => {
  it("does not attach Anthropic thinking payloads to Kimi requests", async () => {
    const model = new LiteLLMAgentModel({
      litellmModel: process.env.TEST_LITELLM_KIMI_MODEL ?? "",
      displayName: "Kimi K2.5",
      apiKey: "test-key",
      providerHint: "kimi",
      enableThinking: true,
      thinkingBudget: 4096,
      maxTokens: 2048,
    });

    let capturedRequest: Record<string, unknown> | null = null;

    // Stub the PythonBridgeProcess to capture the request without spawning Python
    const fakeBridge = {
      sendRequest: async (
        request: Record<string, unknown>,
      ): Promise<{ data: Record<string, unknown> }> => {
        capturedRequest = request;
        return buildBridgeResponse();
      },
      shutdown: async () => {},
    };
    (model as unknown as { _bridge: typeof fakeBridge })._bridge = fakeBridge;

    await model.getResponse(buildModelRequest());

    if (!capturedRequest) {
      throw new Error("Expected LiteLLMAgentModel to emit a bridge request");
    }

    const emittedRequest: Record<string, unknown> = capturedRequest;
    expect(emittedRequest["extra_body"]).toBeUndefined();
    expect(emittedRequest["reasoning_effort"]).toBeUndefined();
    expect(emittedRequest["max_tokens"]).toBe(2048);
  });
});
