

import OpenAI from "openai";
import {
  BaseProvider,
  ProviderResponse,
  ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
  sanitizeRawResponse,
} from "./base";
import { computeCost } from "./pricing";

/** OpenAI Responses API client extension (not yet in SDK types) */
interface ResponsesApiClient {
  responses: {
    create(body: Record<string, unknown>, options?: Record<string, unknown>): Promise<any>;
  };
}

/** Extended usage fields present in Chat Completions responses */
interface ChatCompletionUsageExtended {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}


// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

function buildChatCompletionsTool(validActions: string[]): any {
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

function buildResponsesApiTool(validActions: string[]): any {
  return {
    type: "function",
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
    return { model: modelId, _serialization_error: true };
  }
}

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

export class OpenAIProvider extends BaseProvider {
  protected _apiKey: string;
  protected _modelId: string;
  protected _displayName: string;
  protected _client: OpenAI;
  protected _reasoningEffort: string | null;
  protected _extraBody: Record<string, any> | null;

  constructor(
    opts: {
      apiKey?: string;
      modelId?: string;
      baseUrl?: string;
      displayName?: string;
      reasoningEffort?: string | null;
      extraBody?: Record<string, any> | null;
      defaultHeaders?: Record<string, string> | null;
    } = {},
  ) {
    super();
    this._apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this._modelId = opts.modelId ?? "gpt-5.4";
    this._displayName = opts.displayName ?? "GPT 5.4";
    this._reasoningEffort = opts.reasoningEffort ?? null;
    this._extraBody = opts.extraBody ?? null;

    const clientOpts: any = { apiKey: this._apiKey, timeout: 600_000 };
    if (opts.baseUrl) clientOpts.baseURL = opts.baseUrl;
    if (opts.defaultHeaders) clientOpts.defaultHeaders = opts.defaultHeaders;
    this._client = new OpenAI(clientOpts);
  }

  get modelName(): string {
    return this._displayName;
  }
  get modelId(): string {
    return this._modelId;
  }

  /**
   * Async entry point -- routes to Responses API or Chat Completions based on reasoningEffort.
   * FIX(#78): Accepts optional AbortSignal for caller-driven cancellation.
   */
  async chooseActionAsync(
    params: ChooseActionParams,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    if (this._reasoningEffort) {
      return this._chooseActionResponsesApi(params, signal);
    }
    return this._chooseActionChatCompletions(params, signal);
  }

  // ------------------------------------------------------------------
  // Responses API path
  // ------------------------------------------------------------------

  private async _chooseActionResponsesApi(
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

    const inputItems: any[] = [];
    for (const turn of conversationHistory) {
      inputItems.push({ role: turn.role, content: turn.content });
    }

    const userContent: any[] = [
      { type: "input_text", text: currentObservation },
    ];
    if (imageB64) {
      let imgData = imageB64;
      if (imgData.startsWith("data:"))
        imgData = imgData.split(",")[1] ?? imgData;
      userContent.push({
        type: "input_image",
        image_url: `data:image/png;base64,${imgData}`,
      });
    }
    inputItems.push({ role: "user", content: userContent });

    const response = await (this._client as unknown as ResponsesApiClient).responses.create(
      {
        model: this._modelId,
        instructions: systemPrompt,
        input: inputItems,
        tools: [buildResponsesApiTool(validActions)],
        tool_choice: { type: "function", name: "play_action" },
        max_output_tokens: 8192,
        reasoning: { effort: this._reasoningEffort },
        store: false,
      },
      signal ? { signal } : undefined,
    );

    // Extract token usage
    const usage = response.usage;
    let inputTokens = usage?.input_tokens ?? 0;
    let outputTokens = usage?.output_tokens ?? 0;
    let reasoningTokens = 0;
    if (usage?.output_tokens_details?.reasoning_tokens) {
      reasoningTokens = usage.output_tokens_details.reasoning_tokens;
    }
    let cachedInputTokens = 0;
    if (usage?.input_tokens_details?.cached_tokens) {
      cachedInputTokens = usage.input_tokens_details.cached_tokens;
    }
    inputTokens = Math.max(0, inputTokens - cachedInputTokens);

    // Parse tool call
    let action = "SKIP";
    let reasoning = "";
    let notepadUpdate: string | null = null;

    for (const item of response.output ?? []) {
      if (item.type === "function_call" && item.name === "play_action") {
        try {
          const args = JSON.parse(item.arguments);
          action = String(args.action ?? "SKIP").trim();
          reasoning = String(args.reasoning ?? "").trim();
          notepadUpdate = args.notepad_update ?? null;
          if (notepadUpdate !== null)
            notepadUpdate = String(notepadUpdate).trim();
        } catch {
          const text = item.arguments ?? "";
          [action, reasoning, notepadUpdate] = this.parseActionResponse(
            text,
            validActions,
          );
        }
        break;
      }
    }

    if (action === "SKIP" && response.output_text) {
      [action, reasoning, notepadUpdate] = this.parseActionResponse(
        response.output_text,
        validActions,
      );
    }

    action = BaseProvider.matchAction(action, validActions);

    const cost = computeCost(
      this._modelId,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
    );

    return createProviderResponse({
      action,
      reasoning,
      notepadUpdate,
      inputTokens,
      outputTokens,
      reasoningTokens,
      costUsd: cost,
      rawResponse: sanitizeRawResponse(
        serializeResponse(response, this._modelId),
      ),
      cachedInputTokens,
    });
  }

  // ------------------------------------------------------------------
  // Chat Completions API path
  // ------------------------------------------------------------------

  protected async _chooseActionChatCompletions(
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
        image_url: { url: `data:image/png;base64,${imgData}`, detail: "low" },
      });
    }
    messages.push({ role: "user", content: userContent });

    const callOpts: any = {
      model: this._modelId,
      messages,
      tools: [buildChatCompletionsTool(validActions)],
      tool_choice: { type: "function", function: { name: "play_action" } },
      max_tokens: 8192,
      temperature: 0.3,
    };
    if (this._extraBody) callOpts.extra_body = this._extraBody;

    const response = await this._client.chat.completions.create(
      callOpts,
      signal ? { signal } : undefined,
    );

    const usage = response.usage;
    let inputTokens = usage?.prompt_tokens ?? 0;
    let outputTokens = usage?.completion_tokens ?? 0;
    let reasoningTokens = 0;
    const extUsage = usage as ChatCompletionUsageExtended | undefined;
    if (extUsage?.completion_tokens_details?.reasoning_tokens) {
      reasoningTokens = extUsage.completion_tokens_details
        .reasoning_tokens;
    }
    let cachedInputTokens = 0;
    if (extUsage?.prompt_tokens_details?.cached_tokens) {
      cachedInputTokens = extUsage.prompt_tokens_details.cached_tokens;
    }
    inputTokens = Math.max(0, inputTokens - cachedInputTokens);

    let action = "SKIP";
    let reasoning = "";
    let notepadUpdate: string | null = null;

    if (response.choices?.length) {
      const choice = response.choices[0];
      if (choice.message.tool_calls?.length) {
        const tc = choice.message.tool_calls[0];
        // Narrow to function tool call (vs custom tool call)
        const fn = "function" in tc ? tc.function : null;
        if (fn) {
          try {
            const args = JSON.parse(fn.arguments);
            action = String(args.action ?? "SKIP").trim();
            reasoning = String(args.reasoning ?? "").trim();
            notepadUpdate = args.notepad_update ?? null;
            if (notepadUpdate !== null)
              notepadUpdate = String(notepadUpdate).trim();
          } catch {
            [action, reasoning, notepadUpdate] = this.parseActionResponse(
              fn.arguments ?? "",
              validActions,
            );
          }
        }
      } else if (choice.message.content) {
        [action, reasoning, notepadUpdate] = this.parseActionResponse(
          choice.message.content,
          validActions,
        );
      }
    }

    action = BaseProvider.matchAction(action, validActions);

    const apiCost = extUsage?.cost;
    const cost =
      apiCost && apiCost > 0
        ? Number(apiCost)
        : computeCost(
            this._modelId,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cachedInputTokens,
          );

    return createProviderResponse({
      action,
      reasoning,
      notepadUpdate,
      inputTokens,
      outputTokens,
      reasoningTokens,
      costUsd: cost,
      rawResponse: sanitizeRawResponse(
        serializeResponse(response, this._modelId),
      ),
      cachedInputTokens,
    });
  }
}
