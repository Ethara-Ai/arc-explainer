import path from "path";
import { fileURLToPath } from "url";
import {
  BaseProvider,
  type ProviderResponse,
  type ChooseActionParams,
  buildActionDescription,
  createProviderResponse,
  sanitizeRawResponse,
} from "./base";
import { computeCost } from "./pricing";
import { PythonBridgeProcess } from "./PythonBridgeProcess";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { existsSync } from "fs";

/**
 * Resolve the Python bridge script path at call time (not module load).
 * Tries co-located path first (__dirname), then project root (cwd) as fallback
 * for esbuild bundles where __dirname points to dist/.
 * Throws with both tried paths if neither exists.
 */
function resolveBridgeScript(): string {
  const colocated = path.join(__dirname, "litellmBridge.py");
  if (existsSync(colocated)) return colocated;

  const projectRoot = path.join(
    process.cwd(),
    "shared",
    "providers",
    "litellmBridge.py",
  );
  if (existsSync(projectRoot)) {
    console.log(
      `[LiteLLMSdkProvider] Bridge script not at ${colocated}, using fallback: ${projectRoot}`,
    );
    return projectRoot;
  }

  throw new Error(
    `[LiteLLMSdkProvider] Bridge script not found at:\n  - ${colocated}\n  - ${projectRoot}`,
  );
}

/** Default timeout per LLM call, ms */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function buildTool(validActions: string[]): Record<string, any> {
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

// ---------------------------------------------------------------------------
// LiteLLMSdkProvider
// ---------------------------------------------------------------------------

export class LiteLLMSdkProvider extends BaseProvider {
  private _modelId: string;
  private _litellmModel: string;
  private _displayName: string;
  private _pricingModelId: string;
  private _supportsVision: boolean;
  private _enableThinking: boolean;
  private _apiKey: string;
  private _baseUrl: string | null;
  private _timeoutMs: number;
  private _cloudRegion: string | null;
  private _providerHint: "claude" | "gemini" | "openai" | "kimi" | null;
  private _reasoningEffort: string | null;
  private _additionalHeaders: Record<string, string> | null;
  private _vertexProject: string | null;
  private _vertexLocation: string | null;
  private _vertexCredentials: string | null;
  private _awsAccessKeyId: string | null;
  private _awsSecretAccessKey: string | null;

  // Subprocess management (delegated to PythonBridgeProcess)
  private _bridge: PythonBridgeProcess | null = null;

  constructor(opts: {
    apiKey: string;
    modelId: string;
    litellmModel: string;
    displayName?: string;
    pricingModelId?: string | null;
    supportsVision?: boolean;
    enableThinking?: boolean;
    baseUrl?: string | null;
    timeoutMs?: number;
    cloudRegion?: string;
    providerHint?: "claude" | "gemini" | "openai" | "kimi" | null;
    reasoningEffort?: string | null;
    additionalHeaders?: Record<string, string> | null;
    vertexProject?: string | null;
    vertexLocation?: string | null;
    vertexCredentials?: string | null;
    awsAccessKeyId?: string | null;
    awsSecretAccessKey?: string | null;
  }) {
    super();
    this._apiKey = opts.apiKey;
    this._modelId = opts.modelId;
    this._litellmModel = opts.litellmModel;
    this._displayName = opts.displayName ?? "LiteLLM SDK Model";
    this._pricingModelId = opts.pricingModelId ?? opts.modelId;
    this._supportsVision = opts.supportsVision ?? true;
    this._enableThinking = opts.enableThinking ?? true;
    this._baseUrl = opts.baseUrl ?? null;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this._cloudRegion = opts.cloudRegion ?? null;
    this._providerHint = opts.providerHint ?? null;
    this._reasoningEffort = opts.reasoningEffort ?? null;
    this._additionalHeaders = opts.additionalHeaders ?? null;
    this._vertexProject = opts.vertexProject ?? null;
    this._vertexLocation = opts.vertexLocation ?? null;
    this._vertexCredentials = opts.vertexCredentials ?? null;
    this._awsAccessKeyId = opts.awsAccessKeyId ?? null;
    this._awsSecretAccessKey = opts.awsSecretAccessKey ?? null;
  }

  get modelName(): string {
    return this._displayName;
  }

  get modelId(): string {
    return this._modelId;
  }

  /**
   * Send a minimal request to wake up the gateway (avoids cold-start 503 on first real call).
   * Swallows errors — warmup failure should never block eval execution.
   */
  async warmup(): Promise<void> {
    this._ensureBridge();
    const isReasoningModel = this._enableThinking || this._reasoningEffort != null;
    const request: Record<string, any> = {
      type: "completion",
      model: this._litellmModel,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: isReasoningModel ? 100 : 1,
      timeout: 15,
    };
    if (this._baseUrl) request.base_url = this._baseUrl;
    if (this._apiKey) request.api_key = this._apiKey;
    if (this._cloudRegion) request.aws_region_name = this._cloudRegion;
    if (this._awsAccessKeyId) request.aws_access_key_id = this._awsAccessKeyId;
    if (this._awsSecretAccessKey) request.aws_secret_access_key = this._awsSecretAccessKey;
    if (this._additionalHeaders) request.extra_headers = this._additionalHeaders;

    try {
      await this._bridge!.sendRequest(request, undefined, 15_000);
    } catch {
      // Expected — gateway may still 503 on first ping, but it warms up the route
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

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

    // Ensure subprocess is running (lazy init + auto-restart)
    this._ensureBridge();

    // Build messages in OpenAI Chat Completions format (LiteLLM accepts this)
    const messages: Array<Record<string, any>> = [
      { role: "system", content: systemPrompt },
    ];
    for (const turn of conversationHistory) {
      messages.push({ role: turn.role, content: turn.content });
    }

    // User message with optional image
    const userContent: Array<Record<string, any>> = [
      { type: "text", text: currentObservation },
    ];
    if (imageB64 && this._supportsVision) {
      let imgData = imageB64;
      if (imgData.startsWith("data:"))
        imgData = imgData.split(",")[1] ?? imgData;
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${imgData}`,
          detail: "low",
        },
      });
    }
    messages.push({ role: "user", content: userContent });

    // Build the request payload for the Python bridge
    const isAdaptiveClaude = this._providerHint === "claude" &&
      (this._modelId.includes("4.7") || this._modelId.includes("4-7"));
    const needsLargeOutput = isAdaptiveClaude || this._providerHint === "openai";
    const request: Record<string, any> = {
      type: "completion",
      model: this._litellmModel,
      messages,
      tools: [buildTool(validActions)],
      max_tokens: needsLargeOutput ? 16384 : 8192,
      api_key: this._apiKey,
      timeout_ms: this._timeoutMs,
    };

    // Claude with extended thinking rejects forced tool_choice (returns 400)
    if (this._providerHint === "claude" && this._enableThinking) {
      request.tool_choice = "auto";
    } else if (this._providerHint === "openai") {
      // OpenAI Responses API rejects Chat Completions tool_choice object format
      request.tool_choice = "required";
    } else {
      request.tool_choice = {
        type: "function",
        function: { name: "play_action" },
      };
    }

    if (this._baseUrl) {
      request.base_url = this._baseUrl;
    }

    if (this._cloudRegion) {
      request.aws_region_name = this._cloudRegion;
    }

    if (this._awsAccessKeyId) {
      request.aws_access_key_id = this._awsAccessKeyId;
    }
    if (this._awsSecretAccessKey) {
      request.aws_secret_access_key = this._awsSecretAccessKey;
    }

    if (this._additionalHeaders) {
      request.extra_headers = this._additionalHeaders;
    }

    if (this._vertexProject) {
      request.vertex_project = this._vertexProject;
    }
    if (this._vertexLocation) {
      request.vertex_location = this._vertexLocation;
    }
    if (this._vertexCredentials) {
      request.vertex_credentials = this._vertexCredentials;
    }

    if (this._enableThinking) {
      switch (this._providerHint) {
        case "claude": {
          const isAdaptive = this._modelId.includes("4.7") || this._modelId.includes("4-7");
          if (isAdaptive) {
            // Opus 4.7: thinking.type="enabled" is rejected — must use adaptive
            request.extra_body = {
              thinking: { type: "adaptive", display: "summarized" },
            };
            request.reasoning_effort = this._reasoningEffort ?? "high";
          } else {
            // Opus 4/4.6: fixed-budget thinking still supported
            const thinkingBudget = 8192;
            const minMaxTokens = thinkingBudget + 1024;
            request.max_tokens = Math.max(request.max_tokens ?? 0, minMaxTokens);
            request.extra_body = {
              thinking: { type: "enabled", budget_tokens: thinkingBudget },
            };
          }
          break;
        }
        case "openai":
          request.reasoning_effort = this._reasoningEffort ?? "high";
          break;
        case "gemini":
          // Gemini 3.1 thinking is model-intrinsic — no explicit config needed
          break;
        case "kimi":
          // Kimi K2.5 thinking is on by default — no explicit param needed
          break;
        default:
          request.extra_body = {
            thinking: { type: "adaptive" },
          };
          request.reasoning_effort = this._reasoningEffort ?? "high";
          break;
      }
    }

    // ── Responses API conversion for OpenAI reasoning models ────────────────
    // GPT 5.4 with reasoningEffort needs the Responses API to report
    // reasoning_tokens. Mutate the already-built request in-place so that
    // prompt building, tool definitions, and action descriptions stay identical.
    const useResponsesApi =
      this._providerHint === "openai" && this._reasoningEffort != null;

    if (useResponsesApi) {
      request.type = "responses";

      // messages → input (non-system) + instructions (system prompt)
      const systemMsg = messages.find(
        (m: Record<string, any>) => m.role === "system",
      );
      request.instructions = systemMsg?.content ?? "";
      request.input = messages
        .filter((m: Record<string, any>) => m.role !== "system")
        .map((m: Record<string, any>) => {
          if (!Array.isArray(m.content)) return m;
          return {
            ...m,
            content: m.content.map((part: Record<string, any>) => {
              if (part.type === "text") {
                return { type: "input_text", text: part.text };
              }
              if (part.type === "image_url") {
                return {
                  type: "input_image",
                  image_url: part.image_url?.url ?? part.image_url,
                };
              }
              return part;
            }),
          };
        });
      delete request.messages;

      // Tool format: Chat Completions wraps in {type,function:{name,parameters}}
      // Responses API uses flat {type,name,parameters}
      const chatTool = request.tools?.[0];
      if (chatTool?.function) {
        request.tools = [
          {
            type: "function",
            name: chatTool.function.name,
            description: chatTool.function.description,
            parameters: chatTool.function.parameters,
          },
        ];
      }

      // tool_choice: Responses API uses {type,name} instead of string "required"
      request.tool_choice = { type: "function", name: "play_action" };

      // max_tokens → max_output_tokens
      request.max_output_tokens = request.max_tokens;
      delete request.max_tokens;

      // reasoning config
      request.reasoning = { effort: this._reasoningEffort };
      delete request.reasoning_effort;

      request.store = false;
    }

    if (process.env.HELICONE_API_KEY) {
      request.metadata = {
        model: this._modelId,
        provider: this._providerHint ?? "unknown",
      };
    }

    console.log(
      `[LiteLLMSdkProvider] Sending to bridge: model=${request.model} type=${request.type} cloudRegion=${request.aws_region_name ?? "(none)"} apiKeyLen=${request.api_key?.length ?? 0}`,
    );

    // Send request and wait for multiplexed response
    const result = await this._bridge!.sendRequest(
      request,
      signal,
      this._timeoutMs,
    );
    // Cast to `any` for deeply-nested Python bridge JSON
    const responseData = result.data as Record<string, any>;

    // Extract usage from the bridge response
    // Both _extract_response_data and _extract_responses_data normalize to the
    // same field names (prompt_tokens, completion_tokens, reasoning_tokens)
    const usage = responseData.usage ?? {};
    let inputTokens = (usage.prompt_tokens ?? 0) as number;
    const outputTokens = (usage.completion_tokens ?? 0) as number;
    let reasoningTokens = (usage.reasoning_tokens ?? 0) as number;
    let cachedInputTokens = (usage.cached_tokens ?? 0) as number;
    let cacheWriteTokens = (usage.cache_creation_input_tokens ?? 0) as number;

    // Anthropic cache fields (LiteLLM pass-through)
    if (usage.cache_read_input_tokens > 0 && cachedInputTokens === 0) {
      cachedInputTokens = usage.cache_read_input_tokens as number;
    }

    // ── Reasoning tokens + thinkingText extraction ───────────────────────────
    // LiteLLM normalizes reasoning to message.reasoning_content for Anthropic/Kimi.
    let thinkingText: string | null = null;

    if (responseData.response?.choices?.length) {
      const msg = responseData.response.choices[0]?.message;

      // reasoning_content field (LiteLLM unified field for Claude/Kimi thinking)
      if (msg?.reasoning_content && typeof msg.reasoning_content === "string") {
        thinkingText = msg.reasoning_content;
      }

      // Anthropic thinking blocks in content array (fallback)
      if (!thinkingText && Array.isArray(msg?.content)) {
        const thinkingChunks: string[] = [];
        for (const block of msg.content) {
          if (block.type === "thinking" && block.thinking) {
            thinkingChunks.push(String(block.thinking));
          }
        }
        if (thinkingChunks.length > 0) {
          thinkingText = thinkingChunks.join("\n\n");
        }
      }
    }

    // Adjust input tokens to exclude cached
    inputTokens = Math.max(0, inputTokens - cachedInputTokens);

    // Parse action from tool call in the response
    let action = "SKIP";
    let reasoning = "";
    let notepadUpdate: string | null = null;

    if (useResponsesApi) {
      // Responses API: output[] contains items with type "function_call"
      const output = responseData.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (
            item.type === "function_call" &&
            item.name === "play_action"
          ) {
            try {
              const args =
                typeof item.arguments === "string"
                  ? JSON.parse(item.arguments)
                  : item.arguments;
              action = String(args.action ?? "SKIP").trim();
              reasoning = String(args.reasoning ?? "").trim();
              notepadUpdate = args.notepad_update ?? null;
              if (notepadUpdate !== null)
                notepadUpdate = String(notepadUpdate).trim();
            } catch {
              const text = item.arguments ?? "";
              [action, reasoning, notepadUpdate] = this.parseActionResponse(
                typeof text === "string" ? text : JSON.stringify(text),
                validActions,
              );
            }
            break;
          }
        }
      }

      // Fallback: try output_text if no function_call found
      if (action === "SKIP" && responseData.response?.output_text) {
        [action, reasoning, notepadUpdate] = this.parseActionResponse(
          responseData.response.output_text,
          validActions,
        );
      }
    } else {
      // Chat Completions: choices[].message.tool_calls
      const choices = responseData.response?.choices;
      if (choices?.length) {
        const choice = choices[0];
        const toolCalls = choice?.message?.tool_calls;

        if (toolCalls?.length) {
          const tc = toolCalls[0];
          const fnArgs = tc?.function?.arguments;
          if (fnArgs) {
            try {
              const args =
                typeof fnArgs === "string" ? JSON.parse(fnArgs) : fnArgs;
              action = String(args.action ?? "SKIP").trim();
              reasoning = String(args.reasoning ?? "").trim();
              notepadUpdate = args.notepad_update ?? null;
              if (notepadUpdate !== null)
                notepadUpdate = String(notepadUpdate).trim();
            } catch {
              [action, reasoning, notepadUpdate] = this.parseActionResponse(
                typeof fnArgs === "string" ? fnArgs : JSON.stringify(fnArgs),
                validActions,
              );
            }
          }
        } else if (choice?.message?.content) {
          const content = choice.message.content;
          [action, reasoning, notepadUpdate] = this.parseActionResponse(
            typeof content === "string" ? content : JSON.stringify(content),
            validActions,
          );
        }
      }
    }

    action = BaseProvider.matchAction(action, validActions);

    // Cost: prefer LiteLLM-computed cost, fallback to our pricing table
    let costUsd = responseData.cost_usd as number | null;
    if (costUsd == null || costUsd <= 0) {
      try {
        costUsd = computeCost(
          this._pricingModelId,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedInputTokens,
          cacheWriteTokens,
        );
      } catch {
        // Fallback rough estimate
        costUsd =
          (inputTokens / 1_000_000) * 2.0 + (outputTokens / 1_000_000) * 10.0;
      }
    }

    return createProviderResponse({
      action,
      reasoning,
      notepadUpdate,
      inputTokens,
      outputTokens,
      reasoningTokens,
      thinkingText,
      costUsd,
      rawResponse: sanitizeRawResponse(responseData ?? null),
      cachedInputTokens,
      cacheWriteTokens,
    });
  }

  /**
   * Gracefully shut down the Python subprocess.
   * Called when the provider is no longer needed.
   */
  async shutdown(): Promise<void> {
    if (this._bridge) {
      await this._bridge.shutdown();
    }
  }

  // ── Private: Bridge Lifecycle ───────────────────────────────────────────

  /**
   * Lazily create the PythonBridgeProcess on first use.
   */
  private _ensureBridge(): void {
    if (!this._bridge) {
      this._bridge = new PythonBridgeProcess({
        bridgeScript: resolveBridgeScript(),
        displayName: this._displayName,
        logPrefix: "LiteLLMSdkProvider",
        callTimeoutMs: this._timeoutMs,
      });
    }
  }
}
