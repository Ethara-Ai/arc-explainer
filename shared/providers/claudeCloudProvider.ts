import {
  BaseProvider,
  ProviderResponse,
  ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
  sanitizeRawResponse,
} from "./base";
import { extractRegionFromId } from "./regionUtils";


const DEFAULT_REGION = "us-east-1";

function buildCloudTool(validActions: string[]): any {
  return {
    toolSpec: {
      name: "play_action",
      description: "Choose your next action in the puzzle game.",
      inputSchema: {
        json: {
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
    },
  };
}

export class ClaudeCloudProvider extends BaseProvider {
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
      enableThinking?: boolean;
    } = {},
  ) {
    super();
    this._modelId = opts.modelId ?? process.env.CLAUDE_CLOUD_MODEL_ID ?? "";
    this._displayName = opts.displayName ?? "Claude Opus 4.6";
    this._pricingModelId = opts.pricingModelId ?? null;
    this._enableThinking = opts.enableThinking ?? true;
    const idRegion = extractRegionFromId(this._modelId);
    this._region =
      opts.region ?? idRegion ?? process.env.CLOUD_REGION ?? DEFAULT_REGION;
    this._apiKey = opts.apiKey ?? process.env.CLOUD_API_KEY ?? "";
    if (!this._apiKey) throw new Error("CLOUD_API_KEY not set.");
    this._baseUrl = opts.baseUrl ?? process.env.CLAUDE_CLOUD_BASE_URL ?? "";
    if (!this._baseUrl) throw new Error("CLAUDE_CLOUD_BASE_URL not set.");
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
    for (const turn of conversationHistory) {
      const content = turn.content;
      if (typeof content === "string") {
        messages.push({ role: turn.role, content: [{ text: content }] });
      } else {
        messages.push(turn);
      }
    }

    const userContent: any[] = [];
    if (imageB64) {
      let imgData = imageB64;
      if (imgData.startsWith("data:"))
        imgData = imgData.split(",")[1] ?? imgData;
      userContent.push({
        image: { format: "png", source: { bytes: imgData } },
      });
    }
    userContent.push({ text: currentObservation });
    messages.push({ role: "user", content: userContent });

    const body: any = {
      system: [{ text: systemPrompt }, { cachePoint: { type: "default" } }],
      messages,
      toolConfig: {
        tools: [buildCloudTool(validActions)],
        toolChoice: { auto: {} },
      },
      inferenceConfig: { maxTokens: 8192 },
    };

    // Enable adaptive thinking when configured (matches Python harness behavior).
    // Cloud API folds thinking tokens into outputTokens.
    if (this._enableThinking) {
      body.additionalModelRequestFields = {
        thinking: { type: "adaptive" },
        anthropic_beta: ["interleaved-thinking-2025-05-14"],
      };
    }

    const encodedModelId = encodeURIComponent(this._modelId);
    const url = `${this._baseUrl}/model/${encodedModelId}/converse`;

    // FIX(#82): Compose external signal with timeout so callers can cancel.
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
      // FIX(#86): Include model name in error for multi-provider debugging,
      // but never include auth header content.
      throw new Error(
        `[${this._displayName}] Claude Cloud API error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const response: any = await resp.json();
    const usage = response.usage ?? {};
    const inputTokens: number = usage.inputTokens ?? 0;
    let outputTokens: number = usage.outputTokens ?? 0;
    const cachedInputTokens: number = usage.cacheReadInputTokenCount ?? 0;
    const cacheWriteTokens: number = usage.cacheWriteInputTokenCount ?? 0;

    // Reasoning tokens: Cloud API folds thinking tokens into outputTokens
    // (no separate field exposed). We report reasoning_tokens=0 and let
    // output_tokens carry the full count. Since reasoning_per_m == output_per_m
    // for Claude, cost is correct either way. Matches Python harness behavior.
    const reasoningTokens = 0;
    const outputContent = response.output?.message?.content ?? [];

    let action = "SKIP";
    let reasoning = "";
    let notepadUpdate: string | null = null;
    const thinkingChunks: string[] = [];

    for (const block of outputContent) {
      // Capture thinking block text before skipping to action parsing
      if ("reasoningContent" in block) {
        const text = block.reasoningContent?.reasoningText?.text;
        if (text) thinkingChunks.push(text);
        continue;
      }
      if (block.toolUse?.name === "play_action") {
        const args = block.toolUse.input ?? {};
        action = String(args.action ?? "SKIP").trim();
        reasoning = String(args.reasoning ?? "").trim();
        const nu = args.notepad_update;
        if (nu != null && String(nu).trim()) notepadUpdate = String(nu).trim();
        break;
      } else if (block.text) {
        [action, reasoning, notepadUpdate] = this.parseActionResponse(
          block.text,
          validActions,
        );
      }
    }

    action = BaseProvider.matchAction(action, validActions);

    return createProviderResponse({
      action,
      reasoning,
      notepadUpdate,
      inputTokens,
      outputTokens,
      reasoningTokens,
      thinkingText:
        thinkingChunks.length > 0 ? thinkingChunks.join("\n\n") : null,
      costUsd: null,
      rawResponse: sanitizeRawResponse(response),
      cachedInputTokens,
      cacheWriteTokens,
    });
  }
}
