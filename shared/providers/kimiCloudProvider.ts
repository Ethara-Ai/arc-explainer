import {
  BaseProvider,
  ProviderResponse,
  ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
  sanitizeRawResponse,
} from "./base";
import { extractRegionFromId } from "./regionUtils";
import { computeCost } from "./pricing";

const DEFAULT_REGION = "us-east-1";

function buildKimiTool(validActions: string[]): any {
  return {
    type: "function",
    function: {
      name: "play_action",
      description: "Choose your next action in the puzzle game.",
      parameters: {
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
    },
  };
}

export class KimiCloudProvider extends BaseProvider {
  private _modelId: string;
  private _displayName: string;
  private _pricingModelId: string | null;
  private _region: string;
  private _apiKey: string;
  private _baseUrl: string;
  private _enableThinking: boolean;

  constructor(
    opts: {
      apiKey?: string;
      baseUrl?: string;
      modelId?: string;
      region?: string;
      displayName?: string;
      pricingModelId?: string | null;
      /** Enable Kimi thinking/reasoning mode. Default: true */
      enableThinking?: boolean;
    } = {},
  ) {
    super();
    this._modelId = opts.modelId ?? process.env.KIMI_CLOUD_MODEL_ID ?? "";
    this._displayName = opts.displayName ?? "Kimi K2.5";
    this._pricingModelId = opts.pricingModelId ?? null;
    this._enableThinking = opts.enableThinking ?? true;
    const idRegion = extractRegionFromId(this._modelId);
    this._region =
      opts.region ?? idRegion ?? process.env.CLOUD_REGION ?? DEFAULT_REGION;
    this._apiKey = opts.apiKey ?? process.env.CLOUD_API_KEY ?? "";
    if (!this._apiKey) throw new Error("CLOUD_API_KEY not set.");
    this._baseUrl = opts.baseUrl ?? process.env.KIMI_CLOUD_BASE_URL ?? "";
    if (!this._baseUrl) throw new Error("KIMI_CLOUD_BASE_URL not set.");
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

    const messages: any[] = [{ role: "system", content: systemPrompt }];
    for (const turn of conversationHistory) {
      messages.push({ role: turn.role, content: turn.content });
    }

    const userContent: any[] = [{ type: "text", text: currentObservation }];
    if (imageB64) {
      let imgData = imageB64;
      if (imgData.startsWith("data:"))
        imgData = imgData.split(",")[1] ?? imgData;
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imgData}` },
      });
    }
    messages.push({ role: "user", content: userContent });

    const body: any = {
      messages,
      tools: [buildKimiTool(validActions)],
      tool_choice: { type: "function", function: { name: "play_action" } },
      max_tokens: 8192,
      temperature: 0.3,
    };

    // Enable thinking/reasoning mode if configured
    // Kimi uses OpenAI-compatible "thinking" field
    if (this._enableThinking) {
      body.thinking = { type: "enabled", budget_tokens: 8192 };
      body.stream_options = { include_usage: true };
    }

    const encodedModelId = encodeURIComponent(this._modelId);
    const url = `${this._baseUrl}/model/${encodedModelId}/invoke`;

    // FIX(#83): Compose external signal with timeout so callers can cancel.
    const timeoutSignal = AbortSignal.timeout(600_000);
    const fetchSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      // FIX(#87): Include model name in error, never include auth header.
      throw new Error(
        `[${this._displayName}] Kimi Cloud API error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const response: any = await resp.json();
    const usage = response.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;

    // Extract reasoning tokens from Kimi's thinking blocks.
    // Kimi returns thinking in choices[0].message content blocks
    // with type: "thinking", or in a reasoning_content field.
    // Also check completion_tokens_details.reasoning_tokens (OpenAI-compatible).
    let reasoningTokens = 0;
    if (usage.completion_tokens_details?.reasoning_tokens) {
      reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
    }

    const choices = response.choices ?? [];
    if (choices.length && reasoningTokens === 0) {
      const message = choices[0].message ?? {};
      // Check for reasoning_content field (Kimi extended thinking)
      if (
        message.reasoning_content &&
        typeof message.reasoning_content === "string"
      ) {
        reasoningTokens = Math.ceil(message.reasoning_content.length / 4);
      }
      // Check for thinking content blocks in message content array
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "thinking" && block.thinking) {
            reasoningTokens += Math.ceil(String(block.thinking).length / 4);
          }
        }
      }
    }

    let action = "SKIP";
    let reasoning = "";
    let notepadUpdate: string | null = null;

    if (choices.length) {
      const message = choices[0].message ?? {};
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length) {
        try {
          const args = JSON.parse(toolCalls[0].function.arguments);
          action = String(args.action ?? "SKIP").trim();
          reasoning = String(args.reasoning ?? "").trim();
          const nu = args.notepad_update;
          if (nu != null && String(nu).trim())
            notepadUpdate = String(nu).trim();
        } catch {
          const text = toolCalls[0]?.function?.arguments ?? "";
          [action, reasoning, notepadUpdate] = this.parseActionResponse(
            text,
            validActions,
          );
        }
      } else if (message.content) {
        [action, reasoning, notepadUpdate] = this.parseActionResponse(
          message.content,
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
    );

    return createProviderResponse({
      action,
      reasoning,
      notepadUpdate,
      inputTokens,
      outputTokens,
      reasoningTokens,
      costUsd: cost,
      rawResponse: sanitizeRawResponse(response),
    });
  }
}
