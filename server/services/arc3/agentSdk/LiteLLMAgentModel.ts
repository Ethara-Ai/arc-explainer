import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Usage } from "@openai/agents";
import type {
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  AgentOutputItem,
  AgentInputItem,
  SerializedTool,
  FunctionCallItem,
  AssistantMessageItem,
} from "@openai/agents";
import { logger } from "../../../utils/logger.ts";
import {
  PythonBridgeProcess,
  type BridgeResult,
} from "../../../../shared/providers/PythonBridgeProcess";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { existsSync } from "node:fs";

/**
 * Resolve the Python bridge script path at call time (not module load).
 * Tries the source-tree relative path first, then project root (cwd) as
 * fallback for esbuild bundles where __dirname points to dist/.
 * Throws with both tried paths if neither exists.
 */
function resolveBridgeScript(): string {
  const sourceRelative = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "shared",
    "providers",
    "litellmBridge.py",
  );
  if (existsSync(sourceRelative)) return sourceRelative;

  const projectRoot = path.join(
    process.cwd(),
    "shared",
    "providers",
    "litellmBridge.py",
  );
  if (existsSync(projectRoot)) {
    logger.info(
      `[LiteLLMAgentModel] Bridge script not at ${sourceRelative}, using fallback: ${projectRoot}`,
      "arc3-agentsdk",
    );
    return projectRoot;
  }

  throw new Error(
    `[LiteLLMAgentModel] Bridge script not found at:\n  - ${sourceRelative}\n  - ${projectRoot}`,
  );
}

const DEFAULT_CALL_TIMEOUT_MS = 180_000;

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

export interface LiteLLMAgentModelConfig {
  readonly litellmModel: string;
  readonly displayName: string;
  readonly apiKey: string;
  readonly cloudRegion?: string;
  readonly timeoutMs?: number;
  readonly enableThinking?: boolean;
  readonly thinkingBudget?: number;
  readonly providerHint?: "claude" | "gemini" | "openai" | "kimi";
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
  readonly maxTokens?: number;
}

/* ------------------------------------------------------------------ */
/*  Message translation helpers                                        */
/* ------------------------------------------------------------------ */

type ChatMessage = {
  role: string;
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
};

interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function sanitizeToolArguments(rawArgs: unknown): string {
  if (typeof rawArgs !== "string") {
    return JSON.stringify(rawArgs ?? {});
  }

  const trimmed = rawArgs.trim();
  const beginMarker = "<|tool_call_argument_begin|>";
  const endMarker = "<|tool_call_argument_end|>";

  let candidate = trimmed;
  if (candidate.startsWith(beginMarker)) {
    candidate = candidate.slice(beginMarker.length).trim();
  }
  if (candidate.endsWith(endMarker)) {
    candidate = candidate.slice(0, -endMarker.length).trim();
  }

  const jsonStart = candidate.indexOf("{");
  const jsonEnd = candidate.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    return candidate.slice(jsonStart, jsonEnd + 1);
  }

  return candidate;
}

function normalizeContentBlockToolCalls(
  content: unknown,
): Map<string, NormalizedToolCall> {
  const normalized = new Map<string, NormalizedToolCall>();
  if (!Array.isArray(content)) {
    return normalized;
  }

  for (const block of content) {
    const record = block as Record<string, unknown>;

    if (
      record.type === "tool_use" &&
      typeof record.id === "string" &&
      typeof record.name === "string"
    ) {
      normalized.set(record.id, {
        id: record.id,
        name: record.name,
        arguments: JSON.stringify(record.input ?? {}),
      });
      continue;
    }

    const cloudToolUse = record.toolUse as
      | Record<string, unknown>
      | undefined;
    const cloudToolId =
      typeof cloudToolUse?.toolUseId === "string"
        ? cloudToolUse.toolUseId
        : typeof cloudToolUse?.id === "string"
          ? cloudToolUse.id
          : null;
    const cloudToolName =
      typeof cloudToolUse?.name === "string" ? cloudToolUse.name : null;

    if (cloudToolId && cloudToolName) {
      normalized.set(cloudToolId, {
        id: cloudToolId,
        name: cloudToolName,
        arguments: JSON.stringify(cloudToolUse?.input ?? {}),
      });
    }
  }

  return normalized;
}

export function normalizeResponseToolCalls(
  message: Record<string, unknown> | undefined,
): NormalizedToolCall[] {
  if (!message) {
    return [];
  }

  const normalizedContentBlocks = normalizeContentBlockToolCalls(
    message.content,
  );
  const rawToolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : [];

  const normalizedToolCalls: NormalizedToolCall[] = [];

  for (const rawToolCall of rawToolCalls) {
    const rawFunction = rawToolCall.function as
      | Record<string, unknown>
      | undefined;
    const rawToolId =
      typeof rawToolCall.id === "string" ? rawToolCall.id : randomUUID();
    const rawToolName =
      typeof rawFunction?.name === "string" ? rawFunction.name : "";
    const matchedContentToolCall =
      normalizedContentBlocks.get(rawToolId) ??
      normalizedContentBlocks.get(rawToolName);

    const resolvedName =
      matchedContentToolCall?.name ??
      (rawToolName.startsWith("tooluse_") ? "" : rawToolName);
    const resolvedArguments =
      matchedContentToolCall?.arguments ??
      sanitizeToolArguments(rawFunction?.arguments ?? {});

    if (!resolvedName) {
      logger.warn(
        `[LiteLLMAgentModel] Dropping malformed tool call with id=${rawToolId} because no valid tool name was found`,
        "arc3-agentsdk",
      );
      continue;
    }

    normalizedToolCalls.push({
      id: matchedContentToolCall?.id ?? rawToolId,
      name: resolvedName,
      arguments: resolvedArguments,
    });
  }

  if (normalizedToolCalls.length > 0) {
    return normalizedToolCalls;
  }

  return [...normalizedContentBlocks.values()];
}

function translateInputToMessages(
  systemInstructions: string | undefined,
  input: string | AgentInputItem[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (systemInstructions) {
    messages.push({ role: "system", content: systemInstructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  // Debug: log full item sequence for diagnosing tool_call pairing issues
  const inputItems = input as AgentInputItem[];
  for (let idx = 0; idx < inputItems.length; idx++) {
    const itm = inputItems[idx] as Record<string, unknown>;
    const extra: string[] = [];
    if (itm.role) extra.push(`role=${itm.role}`);
    if (itm.callId) extra.push(`callId=${String(itm.callId).slice(0, 40)}...`);
    if (itm.name) extra.push(`name=${itm.name}`);
    if (itm.type === "message" && itm.content && Array.isArray(itm.content)) {
      const blockTypes = (itm.content as Array<Record<string, unknown>>).map(
        (c) => c.type,
      );
      extra.push(`contentBlocks=[${blockTypes.join(", ")}]`);
    }
    logger.debug(
      `[LiteLLMAgentModel] translateInput item[${idx}]: type=${itm.type} ${extra.join(", ")}`,
      "arc3-agentsdk",
    );
  }

  for (const item of input) {
    switch (item.type) {
      case "message": {
        const role =
          item.role === "assistant"
            ? "assistant"
            : item.role === "system"
              ? "system"
              : "user";

        if (
          role === "assistant" &&
          "content" in item &&
          Array.isArray(item.content)
        ) {
          const contentBlocks = item.content as Array<Record<string, unknown>>;
          const textParts = contentBlocks
            .filter(
              (c) => c.type === "output_text" && typeof c.text === "string",
            )
            .map((c) => c.text as string);
          if (textParts.length > 0) {
            messages.push({ role: "assistant", content: textParts.join("") });
          } else {
            const blockTypes = contentBlocks.map((c) => c.type);
            logger.info(
              `[LiteLLMAgentModel] translateInput: assistant message dropped — ` +
                `${contentBlocks.length} content blocks, types=[${blockTypes.join(", ")}] (no output_text)`,
              "arc3-agentsdk",
            );
          }
        } else if ("content" in item && Array.isArray(item.content)) {
          const contentBlocks = item.content as Array<Record<string, unknown>>;
          const textParts = contentBlocks
            .filter(
              (c) =>
                (c.type === "input_text" && typeof c.text === "string") ||
                (c.type === "output_text" && typeof c.text === "string"),
            )
            .map((c) => c.text as string);
          if (textParts.length > 0) {
            messages.push({ role, content: textParts.join("") });
          } else {
            const blockTypes = contentBlocks.map((c) => c.type);
            logger.info(
              `[LiteLLMAgentModel] translateInput: ${role} message dropped — ` +
                `${contentBlocks.length} content blocks, types=[${blockTypes.join(", ")}] (no input_text/output_text)`,
              "arc3-agentsdk",
            );
          }
        } else {
          // Non-array content (string or missing)
          const rawContent = "content" in item ? item.content : undefined;
          if (typeof rawContent === "string" && rawContent.length > 0) {
            messages.push({ role, content: rawContent });
          } else {
            logger.info(
              `[LiteLLMAgentModel] translateInput: ${role} message with non-array/empty content — ` +
                `content type=${typeof rawContent}`,
              "arc3-agentsdk",
            );
          }
        }
        break;
      }

      case "function_call": {
        const fcItem = item as FunctionCallItem;
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: fcItem.callId,
              type: "function",
              function: {
                name: fcItem.name,
                arguments: fcItem.arguments,
              },
            },
          ],
        });
        break;
      }

      case "function_call_result": {
        const resultItem = item as {
          callId: string;
          output: string | { type: string; text: string } | unknown;
        };
        let toolContent: string;
        if (typeof resultItem.output === "string") {
          toolContent = resultItem.output;
        } else if (
          resultItem.output &&
          typeof resultItem.output === "object" &&
          "text" in (resultItem.output as Record<string, unknown>)
        ) {
          toolContent = String(
            (resultItem.output as Record<string, unknown>).text,
          );
        } else {
          toolContent = JSON.stringify(resultItem.output);
        }
        messages.push({
          role: "tool",
          content: toolContent,
          tool_call_id: resultItem.callId,
        });
        break;
      }

      default: {
        const droppedType = (item as Record<string, unknown>).type;
        const droppedRole = (item as Record<string, unknown>).role;
        logger.info(
          `[LiteLLMAgentModel] translateInput: skipping item type="${droppedType}"${droppedRole ? ` role="${droppedRole}"` : ""}`,
          "arc3-agentsdk",
        );
        break;
      }
    }
  }

  // Post-process: merge assistant messages that carry tool_calls into the
  // preceding assistant message.  The Agents SDK emits function_call as a
  // separate item AFTER the assistant text output.  Our switch-case above
  // creates two back-to-back assistant messages:
  //   assistant(content=text)  +  assistant(content="", tool_calls=[...])
   // LiteLLM / Gemini / cloud providers all require tool_calls to live on the SAME
  // assistant message that precedes the tool response.  This pass folds
  // consecutive assistant-with-tool_calls into the prior assistant.
  //
  // Additionally handles:
  //  - Multiple parallel tool calls: each emitted as a separate function_call
  //    item → separate assistant messages that must be merged into one.
  //  - Dropped assistant text: when the assistant message had no output_text
  //    (e.g. only reasoning blocks), the text message is dropped but
  //    function_call items still produce standalone assistant messages. These
  //    are kept as-is (content="") so tool results have a matching tool_call.
  const merged: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      prev &&
      prev.role === "assistant"
    ) {
      // Merge tool_calls into the preceding assistant message, whether or
      // not it already carries tool_calls (handles parallel tool calls).
      if (prev.tool_calls) {
        prev.tool_calls = [...prev.tool_calls, ...msg.tool_calls];
      } else {
        prev.tool_calls = msg.tool_calls;
      }
      if (msg.content && msg.content !== "") {
        prev.content = prev.content
          ? `${prev.content}\n${msg.content}`
          : msg.content;
      }
      logger.info(
        `[LiteLLMAgentModel] translateInput: merged tool_calls into preceding assistant message ` +
          `(total tool_calls: ${prev.tool_calls.length})`,
        "arc3-agentsdk",
      );
    } else {
      merged.push(msg);
    }
  }

  // Validation pass: ensure every tool message has a matching tool_call in a
  // preceding assistant message. Gemini / cloud providers reject orphaned tool
  // messages. Build a set of all tool_call IDs from assistant messages, then
  // check each tool message. If orphaned, inject a synthetic assistant
  // message with a placeholder tool_call right before the tool message.
  const validated: ChatMessage[] = [];
  const knownToolCallIds = new Set<string>();

  for (const msg of merged) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const tcId = (tc as Record<string, unknown>).id as string | undefined;
        if (tcId) knownToolCallIds.add(tcId);
      }
    }

    if (msg.role === "tool" && msg.tool_call_id) {
      if (!knownToolCallIds.has(msg.tool_call_id)) {
        // Orphaned tool result — inject a synthetic assistant message so the
        // API sees a matching tool_call before this tool response.
        logger.warn(
          `[LiteLLMAgentModel] translateInput: orphaned tool result (tool_call_id=${msg.tool_call_id}). ` +
            `Injecting synthetic assistant tool_call to satisfy API constraints.`,
          "arc3-agentsdk",
        );
        const syntheticAssistant: ChatMessage = {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: msg.tool_call_id,
              type: "function",
              function: {
                name: "_unknown",
                arguments: "{}",
              },
            },
          ],
        };
        validated.push(syntheticAssistant);
        knownToolCallIds.add(msg.tool_call_id);
      }
    }

    validated.push(msg);
  }

  // Debug: log final message sequence to diagnose tool_call pairing
  for (let idx = 0; idx < validated.length; idx++) {
    const m = validated[idx];
    const tcCount = m.tool_calls ? m.tool_calls.length : 0;
    const tcIds = m.tool_calls
      ? (m.tool_calls as Array<Record<string, unknown>>)
          .map((tc) =>
            String((tc as Record<string, unknown>).id ?? "?").slice(0, 40),
          )
          .join(", ")
      : "";
    const contentPreview =
      typeof m.content === "string" ? m.content.slice(0, 60) : "[array]";
    logger.info(
      `[LiteLLMAgentModel] finalMsg[${idx}]: role=${m.role}` +
        `${tcCount > 0 ? ` tool_calls=${tcCount} ids=[${tcIds}]` : ""}` +
        `${m.tool_call_id ? ` tool_call_id=${m.tool_call_id.slice(0, 40)}` : ""}` +
        ` content="${contentPreview}"`,
      "arc3-agentsdk",
    );
  }

  // Cloud API requires at least one non-system message.
  // The Agents SDK may pass input as AgentInputItem[] where all items
  // are filtered out (e.g., reasoning items only), leaving only the
  // system message. Inject a minimal user message as a safeguard.
  const hasNonSystem = validated.some((m) => m.role !== "system");
  if (!hasNonSystem && validated.length > 0) {
    logger.warn(
      `[LiteLLMAgentModel] No non-system messages after translation. ` +
        `Input was ${typeof input === "string" ? "string" : `array(${(input as AgentInputItem[]).length} items: ${(input as AgentInputItem[]).map((i) => i.type).join(", ")})`}. ` +
        `Injecting user fallback for cloud API compatibility.`,
      "arc3-agentsdk",
    );
    validated.push({ role: "user", content: "Continue." });
  }

  return validated;
}

function translateToolsToOpenAI(
  tools: SerializedTool[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const tool of tools) {
    if (tool.type === "function") {
      // SerializedFunctionTool shape: { type, name, description, parameters, strict }
      const ft = tool as {
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict: boolean;
      };
      result.push({
        type: "function",
        function: {
          name: ft.name,
          description: ft.description,
          parameters: ft.parameters,
          strict: ft.strict,
        },
      });
    }
    // Skip hosted_tool, computer, shell, apply_patch — not supported via LiteLLM
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  LiteLLMAgentModel                                                  */
/* ------------------------------------------------------------------ */

export class LiteLLMAgentModel implements Model {
  private readonly _config: LiteLLMAgentModelConfig;
  private _bridge: PythonBridgeProcess | null = null;

  constructor(config: LiteLLMAgentModelConfig) {
    this._config = config;
  }

  /* ---- Model interface: getResponse ---- */

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this._ensureBridge();

    const inputType = typeof request.input === "string" ? "string" : "array";
    const inputItems =
      inputType === "array" ? (request.input as AgentInputItem[]) : [];
    const itemTypes = inputItems.map(
      (i) =>
        `${i.type}${(i as Record<string, unknown>).role ? `(${(i as Record<string, unknown>).role})` : ""}`,
    );
    logger.info(
      `[LiteLLMAgentModel] getResponse: inputType=${inputType}, items=${inputItems.length}, ` +
        `types=[${itemTypes.join(", ")}], hasSystemInstructions=${!!request.systemInstructions}`,
      "arc3-agentsdk",
    );

    const messages = translateInputToMessages(
      request.systemInstructions,
      request.input,
    );

    const messageRoles = messages.map((m) => m.role);
    logger.info(
      `[LiteLLMAgentModel] Translated ${messages.length} messages: roles=[${messageRoles.join(", ")}]`,
      "arc3-agentsdk",
    );

    const tools = translateToolsToOpenAI(request.tools);

    const bridgeRequest: Record<string, unknown> = {
      type: "completion",
      model: this._config.litellmModel,
      messages,
      max_tokens: this._config.maxTokens ?? 16384,
      api_key: this._config.apiKey,
      timeout_ms: this._config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    };

    if (tools.length > 0) {
      bridgeRequest.tools = tools;
    }

    if (this._config.cloudRegion) {
      bridgeRequest.aws_region_name = this._config.cloudRegion;
    }

    // Apply model settings from the request
    if (request.modelSettings.temperature != null) {
      bridgeRequest.temperature = request.modelSettings.temperature;
    }

    if (request.modelSettings.topP != null) {
      bridgeRequest.top_p = request.modelSettings.topP;
    }

    if (request.modelSettings.maxTokens != null) {
      bridgeRequest.max_tokens = request.modelSettings.maxTokens;
    }

    // Tool choice
    if (request.modelSettings.toolChoice && tools.length > 0) {
      bridgeRequest.tool_choice = request.modelSettings.toolChoice;
    }

    // Thinking/reasoning support
    if (this._config.enableThinking !== false) {
      const budget = this._config.thinkingBudget ?? 8192;
      switch (this._config.providerHint) {
        case "openai":
          bridgeRequest.reasoning_effort =
            this._config.reasoningEffort ?? "high";
          break;
        case "gemini":
          // Gemini 3.1 thinking is model-intrinsic for this AgentSDK path.
          break;
        case "kimi":
          // Kimi K2.5 thinking is on by default — no explicit param needed
          break;
        case "claude":
        default: {
          if (budget > 0) {
            const minMaxTokens = budget + 1024;
            const currentMax = (bridgeRequest.max_tokens as number) ?? 0;
            if (currentMax < minMaxTokens) {
              bridgeRequest.max_tokens = minMaxTokens;
            }
            bridgeRequest.extra_body = {
              thinking: { type: "enabled", budget_tokens: budget },
            };
          }
          break;
        }
      }
    }

    logger.info(
      `[LiteLLMAgentModel] Sending request for ${this._config.displayName}: model=${this._config.litellmModel}, ` +
        `providerHint=${this._config.providerHint ?? "(none)"}, tools=${tools.length}, cloudRegion=${this._config.cloudRegion ?? "(none)"}, ` +
        `reasoning=${String(bridgeRequest.reasoning_effort ?? "(none)")}, hasThinking=${!!bridgeRequest.extra_body}`,
      "arc3-agentsdk",
    );

    let result: BridgeResult;
    try {
      result = await this._bridge!.sendRequest(bridgeRequest, request.signal);
    } catch (error) {
      const enrichedError =
        error instanceof Error ? error : new Error(String(error));
      const errorMetadata = enrichedError as unknown as Record<string, unknown>;
      const statusCode = String(errorMetadata.status_code ?? "(none)");
      const llmProvider = String(errorMetadata.llm_provider ?? "(unknown)");
      logger.error(
        `[LiteLLMAgentModel] Request failed for ${this._config.displayName}: ${enrichedError.message} ` +
          `(status=${statusCode}, llm_provider=${llmProvider})`,
        "arc3-agentsdk",
      );
      throw enrichedError;
    }

    logger.info(
      `[LiteLLMAgentModel] Response received for ${this._config.displayName}`,
      "arc3-agentsdk",
    );

    return this._parseResponse(result.data);
  }

  /* ---- Model interface: getStreamedResponse ---- */

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    // LiteLLM bridge is request-response, not streaming.
    // Collect full response, then emit StreamEvent sequence.

    if (request.signal?.aborted) {
      throw new Error(
        "[LiteLLMAgentModel] Request aborted before stream start",
      );
    }

    // 1. Emit response_started
    yield {
      type: "response_started" as const,
    };

    // 2. Get the full response (AbortSignal propagated via getResponse → _sendRequest)
    const response = await this.getResponse(request);

    // 3. Emit text deltas for any assistant message content
    for (const outputItem of response.output) {
      if (outputItem.type === "message" && outputItem.role === "assistant") {
        const msgItem = outputItem as AssistantMessageItem;
        for (const content of msgItem.content) {
          if (content.type === "output_text" && content.text) {
            yield {
              type: "output_text_delta" as const,
              delta: content.text,
            };
          }
        }
      }
    }

    // 4. Emit response_done with usage + output
    yield {
      type: "response_done" as const,
      response: {
        id: response.responseId ?? randomUUID(),
        output: response.output as AgentOutputItem[],
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
        },
      },
    } as StreamEvent;
  }

  /* ---- Response parsing ---- */

  private _parseResponse(data: Record<string, unknown>): ModelResponse {
    const responseData = data.response as Record<string, unknown> | undefined;
    const usageRaw = (data.usage ?? {}) as Record<string, number>;

    const inputTokens = usageRaw.prompt_tokens ?? 0;
    const outputTokens = usageRaw.completion_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    logger.info(
      `[LiteLLMAgentModel] Parsed response for ${this._config.displayName}: ` +
        `inputTokens=${inputTokens}, outputTokens=${outputTokens}, totalTokens=${totalTokens}`,
      "arc3-agentsdk",
    );

    const usage = new Usage({
      requests: 1,
      inputTokens,
      outputTokens,
      totalTokens,
    });

    const output: AgentOutputItem[] = [];

    const choices = (responseData?.choices ?? []) as Array<
      Record<string, unknown>
    >;
    if (choices.length > 0) {
      const choice = choices[0];
      const message = choice?.message as Record<string, unknown> | undefined;

      if (message) {
        // Collect tool calls (if any) to emit AFTER the assistant text.
        // The Agents SDK replays output items in order as conversation
        // history. If FunctionCallItems come before AssistantMessageItem,
        // translateInputToMessages produces:
        //   assistant(tool_calls) → assistant(text) → tool(result)
        // LiteLLM / Gemini require tool results to immediately follow
        // the assistant message with matching tool_calls. Emitting text
        // first ensures the merge pass folds tool_calls onto the text
        // message, producing the correct sequence:
        //   assistant(text + tool_calls) → tool(result)
        const toolCalls = normalizeResponseToolCalls(message);

        // Handle text content → AssistantMessageItem output items (FIRST)
        const content = message.content;
        if (content && typeof content === "string" && content.trim()) {
          const assistantMessage: AssistantMessageItem = {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: content,
              },
            ],
          };
          output.push(assistantMessage);
        } else if (Array.isArray(content)) {
          // Some models return content as an array of blocks
          const textParts: string[] = [];
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              textParts.push(b.text);
            }
          }
          if (textParts.length > 0) {
            const assistantMessage: AssistantMessageItem = {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: textParts.join(""),
                },
              ],
            };
            output.push(assistantMessage);
          }
        }

        // Handle tool calls → FunctionCallItem output items (AFTER text)
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const functionCallItem: FunctionCallItem = {
              type: "function_call",
              callId: tc.id ?? randomUUID(),
              name: tc.name,
              arguments: tc.arguments,
            };
            output.push(functionCallItem);
          }
        }
      }
    }

    return {
      usage,
      output,
      responseId: undefined, // LiteLLM doesn't support response chaining
    };
  }

  /* ---- Bridge lifecycle ---- */

  private _ensureBridge(): void {
    if (!this._bridge) {
      logger.info(
        `[LiteLLMAgentModel] Creating Python bridge for ${this._config.displayName} (model: ${this._config.litellmModel})`,
        "arc3-agentsdk",
      );
      this._bridge = new PythonBridgeProcess({
        bridgeScript: resolveBridgeScript(),
        displayName: this._config.displayName,
        logPrefix: "LiteLLMAgentModel",
        logCategory: "arc3-agentsdk",
        callTimeoutMs: this._config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      });
    }
  }

  /* ---- Shutdown ---- */

  async shutdown(): Promise<void> {
    if (this._bridge) {
      await this._bridge.shutdown();
    }
  }
}
