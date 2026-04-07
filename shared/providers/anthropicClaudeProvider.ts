import Anthropic from "@anthropic-ai/sdk";
import {
  BaseProvider,
  ProviderResponse,
  ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
  sanitizeRawResponse,
} from "./base";
import { computeCost } from "./pricing";

/** Extended Anthropic usage fields not yet in published SDK types */
interface AnthropicUsageExtended {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Union of content block types including thinking blocks */
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

interface ToolUseBlockExtended {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

interface TextBlockExtended {
  type: "text";
  text: string;
}

type ContentBlockExtended =
  | ThinkingBlock
  | ToolUseBlockExtended
  | TextBlockExtended;

function buildAnthropicTool(validActions: string[]): any {
  return {
    name: "play_action",
    description: "Choose your next action in the puzzle game.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: buildActionDescription(validActions),
        },
        reasoning: {
          type: "string",
          description: "Brief explanation of why you chose this action",
        },
        notepad_update: {
          type: "string",
          description:
            "Updated notepad contents. Repeat current contents to keep unchanged.",
        },
      },
      required: ["action", "reasoning", "notepad_update"],
    },
  };
}

function serializeResponse(
  response: any,
  modelId: string,
): Record<string, any> {
  try {
    return typeof response.toJSON === "function"
      ? response.toJSON()
      : { ...response };
  } catch {
    return { id: response?.id, model: modelId, _serialization_error: true };
  }
}

export class AnthropicClaudeProvider extends BaseProvider {
  private _modelId: string;
  private _displayName: string;
  private _pricingModelId: string | null;
  private _client: Anthropic;
  private _enableThinking: boolean;

  constructor(opts: {
    apiKey: string;
    modelId?: string;
    displayName?: string;
    pricingModelId?: string | null;
    enableThinking?: boolean;
  }) {
    super();
    if (!opts.apiKey) throw new Error("Anthropic API key is empty.");
    this._modelId = opts.modelId ?? "claude-opus-4-6";
    this._displayName = opts.displayName ?? "Claude Opus 4.6";
    this._pricingModelId = opts.pricingModelId ?? null;
    this._enableThinking = opts.enableThinking ?? true;
    this._client = new Anthropic({ apiKey: opts.apiKey, timeout: 600_000 });
  }

  get modelName(): string {
    return this._displayName;
  }
  get modelId(): string {
    return this._modelId;
  }

  async chooseActionAsync(
    params: ChooseActionParams,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const {
      systemPrompt,
      conversationHistory,
      currentObservation,
      validActions,
      imageB64,
    } = params;

    const messages: any[] = [];

    // Conversation history
    for (const turn of conversationHistory) {
      const content = turn.content;
      if (typeof content === "string") {
        messages.push({ role: turn.role, content });
      } else if (Array.isArray(content)) {
        const blocks = content.map((block: any) => {
          if ("text" in block && Object.keys(block).length === 1) {
            return { type: "text", text: block.text };
          }
          return block;
        });
        messages.push({ role: turn.role, content: blocks });
      } else {
        messages.push(turn);
      }
    }

    // Current user turn
    const userContent: any[] = [];
    if (imageB64) {
      let imgData = imageB64;
      if (imgData.startsWith("data:"))
        imgData = imgData.split(",")[1] ?? imgData;
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: imgData },
      });
    }
    userContent.push({ type: "text", text: currentObservation });
    messages.push({ role: "user", content: userContent });

    // System prompt with cache_control
    const systemBlocks = [
      {
        type: "text" as const,
        text: systemPrompt,
        cache_control: { type: "ephemeral" as const },
      },
    ];

    const createOpts: any = {
      model: this._modelId,
      max_tokens: 8192,
      system: systemBlocks,
      messages,
      tools: [buildAnthropicTool(validActions)],
      tool_choice: { type: "auto" },
    };

    // Enable adaptive thinking when configured (matches Python harness behavior).
    // Claude supports adaptive thinking natively; must use tool_choice: "auto"
    // (not forced tool use) when thinking is enabled.
    if (this._enableThinking) {
      createOpts.thinking = { type: "adaptive" };
      createOpts.extra_headers = {
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      };
    }

    // FIX(#80): Pass AbortSignal to the Anthropic SDK via request options.
    const response = await this._client.messages.create(
      createOpts,
      signal ? { signal } : undefined,
    );

    // Extract usage
    const usage = response.usage;
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cachedInputTokens =
      (usage as AnthropicUsageExtended).cache_read_input_tokens ?? 0;
    const cacheWriteTokens =
      (usage as AnthropicUsageExtended).cache_creation_input_tokens ?? 0;

    // Reasoning tokens: Anthropic SDK reports thinking tokens as part of
    // output_tokens (no separate field in usage). Since reasoning and output
    // share the same per-token price for Claude, we report 0 here to match
    // Python harness behavior and avoid double-counting in cost calculations.
    const reasoningTokens = 0;

    // Parse response
    let action = "SKIP";
    let reasoning = "";
    let notepadUpdate: string | null = null;
    const thinkingChunks: string[] = [];

    for (const block of response.content as ContentBlockExtended[]) {
      // Capture thinking block text before skipping to action parsing
      if (block.type === "thinking") {
        const text = block.thinking;
        if (text) thinkingChunks.push(text);
        continue;
      }
      if (block.type === "tool_use" && block.name === "play_action") {
        const args = block.input ?? {};
        action = String(args.action ?? "SKIP").trim();
        reasoning = String(args.reasoning ?? "").trim();
        const nu = args.notepad_update;
        if (nu != null && String(nu).trim()) notepadUpdate = String(nu).trim();
        break;
      } else if (block.type === "text" && block.text) {
        [action, reasoning, notepadUpdate] = this.parseActionResponse(
          block.text,
          validActions,
        );
      }
    }

    action = BaseProvider.matchAction(action, validActions);

    const cost = computeCost(
      this._pricingModelId ?? this._modelId,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      cacheWriteTokens,
    );

    return createProviderResponse({
      action,
      reasoning,
      notepadUpdate,
      inputTokens,
      outputTokens,
      reasoningTokens,
      thinkingText:
        thinkingChunks.length > 0 ? thinkingChunks.join("\n\n") : null,
      costUsd: cost,
      rawResponse: sanitizeRawResponse(
        serializeResponse(response, this._modelId),
      ),
      cachedInputTokens,
      cacheWriteTokens,
    });
  }
}
