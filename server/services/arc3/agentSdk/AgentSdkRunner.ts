import { randomUUID, createHash } from "node:crypto";
import {
  Agent,
  run,
  extractAllTextOutput,
  setTracingDisabled,
  MaxTurnsExceededError,
  Usage,
} from "@openai/agents";
import type { AgentInputItem, RunItem } from "@openai/agents";
import { type FrameData, type GameAction } from "../Arc3ApiClient.ts";
import type { GameClient } from "./GameClient.ts";
import type {
  Arc3AgentRunConfig,
  Arc3AgentRunResult,
  Arc3RunTimelineEntry,
  Arc3GameState,
} from "../types.ts";

import { DEFAULT_MAX_TURNS, DEFAULT_GAME_ID } from "../utils/constants.ts";
import { processRunItemsWithReasoning } from "../utils/timelineProcessor.ts";
import { generateActionCaption } from "../helpers/captionGenerator.ts";
import {
  countChangedPixels,
  extractLayerStack,
} from "../helpers/frameAnalysis.ts";
import {
  unpackFrames,
  summarizeFrameStructure,
} from "../helpers/frameUnpacker.ts";
import { createSession } from "../persistence/sessionManager";
import { saveFrame } from "../persistence/framePersistence";
import { logger } from "../../../utils/logger.ts";
import {
  createArc3Tools,
  type Arc3ToolContext,
  type Arc3StreamHarness as FactoryStreamHarness,
} from "../tools/Arc3ToolFactory.ts";
import {
  buildCombinedInstructions,
  buildRunSummary,
} from "../helpers/runHelpers.ts";
import { PlaygroundTraceSession } from "../data/playgroundTraceWriter.ts";
import {
  createAgentSdkModel,
  buildModelSettings,
  getModelConfig,
} from "./providerRegistry.ts";
import { createContextWindowFilter } from "./contextWindowFilter.ts";
import { Notepad } from "../../eval/runner/notepad";

/* ------------------------------------------------------------------ */
/*  Disable OpenAI tracing globally                                    */
/*  The @openai/agents SDK auto-sends traces to api.openai.com using   */
/*  OPENAI_API_KEY. This causes 401 errors for non-OpenAI models.      */
/* ------------------------------------------------------------------ */
setTracingDisabled(true);

/* ------------------------------------------------------------------ */
/*  Stream harness interface (identical to Arc3RealGameRunner)          */
/* ------------------------------------------------------------------ */

export interface Arc3StreamHarness {
  sessionId: string;
  emit: (chunk: any) => void;
  emitEvent: (event: string, data: any) => void;
  end: (summary: any) => void;
  metadata: {
    game_id: string;
    agentName: string;
  };
}

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

export class AgentSdkRunner {
  constructor(private readonly apiClient: GameClient) {}

  private computeFrameHash(
    frame: number[][][] | undefined,
  ): string | undefined {
    if (!frame || frame.length === 0) return undefined;
    try {
      return createHash("sha256")
        .update(JSON.stringify(frame))
        .digest("hex")
        .slice(0, 16);
    } catch {
      return undefined;
    }
  }

  private async persistUnpackedFrames(
    dbSessionId: number | null,
    unpackedFrames: FrameData[],
    action: GameAction,
    prevFrame: FrameData | null,
    currentFrameNumber: number,
  ): Promise<number> {
    if (!dbSessionId || unpackedFrames.length === 0) {
      return currentFrameNumber;
    }

    let frameNum = currentFrameNumber;

    try {
      for (let i = 0; i < unpackedFrames.length; i++) {
        const frame = unpackedFrames[i];
        const isLastFrame = i === unpackedFrames.length - 1;
        const pixelsChanged =
          isLastFrame && prevFrame ? countChangedPixels(prevFrame, frame) : 0;

        let caption = generateActionCaption(action, prevFrame, frame);
        if (unpackedFrames.length > 1) {
          caption += ` (frame ${i + 1}/${unpackedFrames.length})`;
        }

        await saveFrame(
          dbSessionId,
          frameNum,
          frame,
          action,
          caption,
          pixelsChanged,
        );

        logger.debug(
          `[AgentSdk Frame] Saved frame ${frameNum} (animation ${i + 1}/${unpackedFrames.length}): ${caption}`,
          "arc3-agentsdk",
        );

        frameNum++;
      }
    } catch (error) {
      logger.warn(
        `[AgentSdk Frame] Failed to persist unpacked frames: ${error instanceof Error ? error.message : String(error)}`,
        "arc3-agentsdk",
      );
    }

    return frameNum;
  }

  private validateContinuationFrame(
    seedFrame: FrameData | undefined,
    gameId: string,
    gameGuid: string,
  ): FrameData {
    if (!seedFrame) {
      throw new Error(
        `[AgentSdk] Cannot continue game session ${gameGuid} without a seed frame. ` +
          `The frontend must provide the last known frame state when continuing.`,
      );
    }

    if (seedFrame.guid !== gameGuid) {
      logger.warn(
        `[AgentSdk] Seed frame guid (${seedFrame.guid}) doesn't match expected guid (${gameGuid}). Using seed frame anyway.`,
        "arc3-agentsdk",
      );
    }

    logger.info(
      `[AgentSdk] Continuing game session: ${gameGuid} at state=${seedFrame.state}, score=${seedFrame.score}, actions=${seedFrame.action_counter}/${seedFrame.max_actions}`,
      "arc3-agentsdk",
    );

    return seedFrame;
  }

  /**
   * Run a game session with streaming, using a provider-registry model.
   * Mirrors Arc3RealGameRunner.runWithStreaming() but:
   * 1. Uses createAgentSdkModel() for the Agent's model (aisdk-wrapped)
   * 2. Uses buildModelSettings() for provider-aware settings
   * 3. Only passes previousResponseId when the model supports it
   * 4. Defensive event normalisation for both OpenAI-style and AI SDK events
   */
  async runWithStreaming(
    config: Arc3AgentRunConfig,
    streamHarness: Arc3StreamHarness,
    abortSignal?: AbortSignal,
  ): Promise<Arc3AgentRunResult> {
    const agentName = config.agentName?.trim() || "AgentSDK Operator";
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const contextWindow = config.contextWindow ?? 50;
    const gameId = config.game_id ?? DEFAULT_GAME_ID;
    const modelKey = config.model ?? "claude-opus-4-6";

    // Resolve model configuration from registry
    const modelConfig = getModelConfig(modelKey);
    logger.info(
      `[AgentSdk STREAMING] Starting run for game=${gameId}, model=${modelKey}, provider=${modelConfig.providerKind}, ` +
        `thinking=${modelConfig.enableThinking}, reasoningEffort=${modelConfig.reasoningEffort ?? config.reasoningEffort ?? "default"}, maxTurns=${maxTurns}`,
      "arc3-agentsdk",
    );

    // CRITICAL: Reuse existing scorecard on continuation, open new one on fresh start
    let scorecardId: string;
    if (config.scorecardId) {
      scorecardId = config.scorecardId;
      logger.info(
        `[AgentSdk STREAMING] Reusing existing scorecard ${scorecardId} for continuation`,
        "arc3-agentsdk",
      );
    } else {
      const scorecardTags = [
        "arc-explainer",
        "agentsdk-playground",
        `provider:${modelConfig.providerKind}`,
        `model:${modelKey}`,
        `reasoning:${config.reasoningEffort ?? "low"}`,
      ];

      scorecardId = await this.apiClient.openScorecard(
        scorecardTags,
        "https://github.com/arc-explainer/arc-explainer",
        {
          source: "arc-explainer",
          mode: "agentsdk-interactive",
          game_id: gameId,
          agentName,
          provider: modelConfig.providerKind,
          userInterruptible: true,
          reasoningLevel: config.reasoningEffort ?? "low",
        },
      );
      logger.info(
        `[AgentSdk STREAMING] Opened new scorecard ${scorecardId} for ${modelConfig.displayName}`,
        "arc3-agentsdk",
      );
    }

    let gameGuid: string | null = null;
    let currentFrame: FrameData | null = null;
    let prevFrame: FrameData | null = null;
    const frames: FrameData[] = [];
    let dbSessionId: number | null = null;
    let isContinuation = false;

    // Start or continue game
    const initialFrame = config.existingGameGuid
      ? this.validateContinuationFrame(
          config.seedFrame,
          gameId,
          config.existingGameGuid,
        )
      : await this.apiClient.startGame(gameId, undefined, scorecardId);

    gameGuid = initialFrame.guid;
    isContinuation = !!config.existingGameGuid;

    // Disk trace (fire-and-forget)
    const streamTraceSession = PlaygroundTraceSession.create(gameId);
    const streamRunStartMs = Date.now();
    streamTraceSession
      .writeHeader({
        gameId,
        gameGuid: gameGuid ?? "unknown",
        scorecardId,
        agentName,
        model: modelKey,
        maxTurns,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3-agentsdk",
        ),
      );

    // Unpack initial frame if it's an animation (4D array)
    const unpackedInitialFrames = unpackFrames(initialFrame);
    if (unpackedInitialFrames.length > 1) {
      logger.info(
        `[AgentSdk STREAMING] Initial RESET returned ${unpackedInitialFrames.length} animation frames: ` +
          summarizeFrameStructure(initialFrame),
        "arc3-agentsdk",
      );
    }

    currentFrame = unpackedInitialFrames[unpackedInitialFrames.length - 1];
    frames.push(...unpackedInitialFrames);

    if (currentFrame) {
      streamTraceSession
        .writeFrame({
          frameIndex: 0,
          state: currentFrame.state,
          score: currentFrame.score,
          actionCounter: currentFrame.action_counter,
          maxActions: currentFrame.max_actions,
        })
        .catch((err) =>
          logger.warn(
            `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
            "arc3-agentsdk",
          ),
        );
      streamTraceSession
        .writeEvent("game.initialized", {
          gameGuid,
          isContinuation,
          provider: modelConfig.providerKind,
          unpackedFrameCount: unpackedInitialFrames.length,
        })
        .catch((err) =>
          logger.warn(
            `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
            "arc3-agentsdk",
          ),
        );
    }

    // Create database session (only for new games)
    let currentFrameNumber = 0;
    try {
      if (isContinuation) {
        logger.info(
          `[AgentSdk STREAMING] Continuing game session ${gameGuid} on game ${gameId}`,
          "arc3-agentsdk",
        );
      } else {
        dbSessionId = await createSession(
          gameId,
          gameGuid,
          currentFrame.win_score,
          scorecardId,
        );

        currentFrameNumber = await this.persistUnpackedFrames(
          dbSessionId,
          unpackedInitialFrames,
          { action: "RESET" },
          null,
          0,
        );

        logger.info(
          `Created AgentSdk session ${dbSessionId} for game ${gameId} (scorecard: ${scorecardId}) ` +
            `(${unpackedInitialFrames.length} initial frame(s), provider: ${modelConfig.providerKind})`,
          "arc3-agentsdk",
        );
      }
    } catch (error) {
      logger.warn(
        `Failed to create database session: ${error instanceof Error ? error.message : String(error)}`,
        "arc3-agentsdk",
      );
    }

    // Emit all initial frames to streaming clients
    for (let i = 0; i < unpackedInitialFrames.length; i++) {
      const frame = unpackedInitialFrames[i];
      const isLastFrame = i === unpackedInitialFrames.length - 1;
      let caption = isContinuation
        ? `Continuing game session ${gameGuid}`
        : generateActionCaption({ action: "RESET" }, null, frame);

      if (unpackedInitialFrames.length > 1) {
        caption += ` (frame ${i + 1}/${unpackedInitialFrames.length})`;
      }

      streamHarness.emitEvent("game.started", {
        initialFrame: frame,
        frameIndex: String(i),
        caption,
        isAnimation: unpackedInitialFrames.length > 1,
        animationFrame: i,
        animationTotalFrames: unpackedInitialFrames.length,
        isLastAnimationFrame: isLastFrame,
        isContinuation,
        timestamp: Date.now(),
      });
    }

    // Reasoning accumulator
    const streamState = {
      accumulatedReasoning: "",
      reasoningSequence: 0,
    };
    let noScoreProgressStreak = 0;
    const updateNoScoreProgress = (
      prev: FrameData | null,
      curr: FrameData | null,
    ) => {
      if (!prev || !curr) return;
      if (curr.score === prev.score) {
        noScoreProgressStreak += 1;
        if (noScoreProgressStreak === 5) {
          streamHarness.emitEvent("agent.loop_hint", {
            message:
              "Score has not changed across 5 actions. Try an alternate strategy.",
            score: curr.score,
            action_counter: curr.action_counter,
            state: curr.state,
            timestamp: Date.now(),
          });
        }
      } else {
        noScoreProgressStreak = 0;
      }
    };

    // Emit agent starting event
    streamHarness.emitEvent("agent.starting", {
      gameId,
      agentName,
      maxTurns,
      model: modelKey,
      provider: modelConfig.providerKind,
      timestamp: Date.now(),
    });

    // Create persistent notepad for working memory across context window
    const notepad = new Notepad();

    // Create tool context (mutable state accessed by tools via closure)
    const toolContext: Arc3ToolContext = {
      currentFrame,
      prevFrame,
      gameGuid,
      frames,
      currentFrameNumber,
      gameId,
      scorecardId,
      dbSessionId,
      apiClient: this.apiClient,
      updateNoScoreProgress,
      notepad,
      streaming: {
        harness: streamHarness as FactoryStreamHarness,
        state: streamState,
        agentName,
      },
    };

    // Create tools via factory (no reset tool for streaming; notepad tools auto-included)
    const tools = createArc3Tools(toolContext, false);

    // Build combined instructions using shared helper + notepad instructions
    const combinedInstructions = buildCombinedInstructions(config, {
      notepadEnabled: true,
    });

    // Create the Agent with an aisdk()-wrapped model from the registry
    const agentModel = createAgentSdkModel(modelKey);
    const modelSettings = buildModelSettings(
      modelKey,
      config.reasoningEffort ?? "high",
    );
    logger.info(
      `[AgentSdk STREAMING] Model settings for ${modelKey}: ${JSON.stringify(modelSettings)}`,
      "arc3-agentsdk",
    );

    const frameHash = currentFrame
      ? this.computeFrameHash(extractLayerStack(currentFrame))
      : undefined;

    const agent = new Agent({
      name: agentName,
      instructions: combinedInstructions,
      handoffDescription: "Operates the ARC-AGI-3 real game interface.",
      model: agentModel,
      modelSettings: {
        ...modelSettings,
        providerData: {
          ...((modelSettings.providerData as Record<string, unknown>) ?? {}),
          metadata: {
            sessionId: config.sessionId,
            gameGuid: gameGuid || undefined,
            frameHash,
            frameIndex: String(frames.length - 1),
            previousResponseId: config.previousResponseId ?? null,
            provider: modelConfig.providerKind,
          },
        },
      },
      tools,
    });

    // Emit agent ready event
    streamHarness.emitEvent("agent.ready", {
      agentName,
      model: modelKey,
      provider: modelConfig.providerKind,
      instructions: combinedInstructions,
      timestamp: Date.now(),
    });

    // Build shared run options for previousResponseId
    const previousResponseOpts =
      modelConfig.supportsPreviousResponseId && config.previousResponseId
        ? { previousResponseId: config.previousResponseId }
        : {};

    const contextWindowFilter = createContextWindowFilter(contextWindow);

    /* ---------------------------------------------------------------- */
    /*  Retry loop                                                       */
    /*  The OpenAI Agents SDK terminates when the model returns text     */
    /*  without tool calls (it treats this as "final output"). For ARC   */
    /*  games the model often narrates without calling a tool, so we     */
    /*  re-invoke with the conversation history until the game reaches   */
    /*  a terminal state or turns are exhausted.                         */
    /* ---------------------------------------------------------------- */

    const initialPrompt = `Start playing the ARC-AGI-3 game "${gameId}". Narrate before every tool call, then execute it. Keep using the What I see / What it means / Next move format until you deliver the Final Report.`;

    let turnsUsed = 0;
    let segmentNumber = 0;
    let runInput: string | AgentInputItem[] = initialPrompt;
    const accumulatedUsage = new Usage();
    const allNewItems: RunItem[] = [];
    let lastResponseId: string | undefined;

    while (turnsUsed < maxTurns) {
      segmentNumber++;
      const turnsRemaining = maxTurns - turnsUsed;

      if (segmentNumber > 1) {
        logger.info(
          `[AgentSdk RETRY] Starting segment ${segmentNumber} with ${turnsRemaining} turns remaining ` +
            `(used ${turnsUsed}/${maxTurns}), game state: ${toolContext.currentFrame?.state ?? "unknown"}`,
          "arc3-agentsdk",
        );
        streamHarness.emitEvent("agent.retry_segment", {
          segment: segmentNumber,
          turnsUsed,
          turnsRemaining,
          gameState: toolContext.currentFrame?.state ?? "unknown",
          score: toolContext.currentFrame?.score ?? 0,
          timestamp: Date.now(),
        });
      }

      let segmentResult;
      try {
        segmentResult = await run(agent, runInput, {
          maxTurns: turnsRemaining,
          stream: true,
          callModelInputFilter: contextWindowFilter,
          ...previousResponseOpts,
        });
      } catch (err) {
        if (err instanceof MaxTurnsExceededError) {
          logger.info(
            `[AgentSdk RETRY] MaxTurnsExceededError in segment ${segmentNumber} — all ${maxTurns} turns consumed`,
            "arc3-agentsdk",
          );
          // Accumulate usage from the error state if available
          if (err.state) {
            accumulatedUsage.add(
              (err.state as any)._context?.usage ?? new Usage(),
            );
          }
          break;
        }
        throw err;
      }

      // Process streaming events for this segment
      let segmentAborted = false;
      for await (const event of segmentResult) {
        if (abortSignal?.aborted) {
          logger.info(
            `[AgentSdk] Abort signal received — stopping agent loop for ${gameId}`,
            "arc3-agentsdk",
          );
          segmentAborted = true;
          break;
        }
        switch (event.type) {
          case "raw_model_stream_event":
            {
              const eventData = event.data;

              // The Agents SDK wraps Responses API events in event.data.event
              // when event.data.type === 'model'
              if (eventData.type === "model") {
                const modelEvent = (eventData as any).event;

                // Handle reasoning deltas — both OpenAI-style and AI SDK normalised events
                if (modelEvent?.type === "response.reasoning_text.delta") {
                  const delta = modelEvent.delta ?? "";
                  streamState.accumulatedReasoning += delta;
                  streamState.reasoningSequence++;

                  streamHarness.emitEvent("agent.reasoning", {
                    delta,
                    content: streamState.accumulatedReasoning,
                    sequence: streamState.reasoningSequence,
                    contentIndex: modelEvent.content_index,
                    timestamp: Date.now(),
                  });
                }

                // Handle reasoning completion
                if (modelEvent?.type === "response.reasoning_text.done") {
                  const finalContent =
                    modelEvent.text ?? streamState.accumulatedReasoning;
                  streamState.accumulatedReasoning = finalContent;

                  streamHarness.emitEvent("agent.reasoning_complete", {
                    finalContent,
                    timestamp: Date.now(),
                  });
                }
              }

              // AI SDK providers may emit text deltas differently
              // Check for thinking/reasoning content in normalized events
              if (
                (eventData as any).type === "reasoning" ||
                (eventData as any).type === "thinking"
              ) {
                const delta =
                  (eventData as any).delta ?? (eventData as any).text ?? "";
                if (delta) {
                  streamState.accumulatedReasoning += delta;
                  streamState.reasoningSequence++;
                  streamHarness.emitEvent("agent.reasoning", {
                    delta,
                    content: streamState.accumulatedReasoning,
                    sequence: streamState.reasoningSequence,
                    timestamp: Date.now(),
                  });
                }
              }

              // Forward raw model events for debugging
              streamHarness.emitEvent("model.stream_event", {
                eventType: event.data.type,
                data: event.data,
                timestamp: Date.now(),
              });
            }
            break;

          case "run_item_stream_event":
            {
              const { item } = event;
              const timestamp = Date.now();

              switch (item.type) {
                case "message_output_item":
                  streamHarness.emitEvent("agent.message", {
                    agentName: item.agent.name,
                    content: item.content,
                    timestamp,
                  });
                  break;
                case "reasoning_item":
                  streamHarness.emitEvent("agent.reasoning", {
                    content: streamState.accumulatedReasoning,
                    timestamp,
                  });
                  break;
                case "tool_call_item": {
                  const toolName =
                    "name" in item.rawItem
                      ? item.rawItem.name
                      : item.rawItem.type;
                  const toolArgs =
                    "arguments" in item.rawItem
                      ? item.rawItem.arguments
                      : undefined;
                  streamHarness.emitEvent("agent.tool_call", {
                    tool: toolName,
                    arguments: toolArgs,
                    timestamp,
                  });
                  streamTraceSession
                    .writeEvent("agent.tool_call", {
                      tool: toolName,
                      arguments: toolArgs,
                    })
                    .catch((err) =>
                      logger.warn(
                        `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
                        "arc3-agentsdk",
                      ),
                    );
                  break;
                }
                case "tool_call_output_item": {
                  const toolResult =
                    item.output ?? item.rawItem.output ?? item.rawItem;
                  streamHarness.emitEvent("agent.tool_result", {
                    tool: item.rawItem.type,
                    result: toolResult,
                    timestamp,
                  });
                  streamTraceSession
                    .writeEvent("agent.tool_result", {
                      tool: item.rawItem.type,
                    })
                    .catch((err) =>
                      logger.warn(
                        `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
                        "arc3-agentsdk",
                      ),
                    );
                  break;
                }
                default:
                  streamHarness.emitEvent("agent.run_item", {
                    itemName: event.name,
                    item,
                    timestamp,
                  });
                  break;
              }
            }
            break;

          case "agent_updated_stream_event":
            streamHarness.emitEvent("agent.updated", {
              agent: event.agent,
              timestamp: Date.now(),
            });
            break;
        }
      }

      // Accumulate results from this segment
      const segmentUsage = segmentResult.state._context.usage;
      accumulatedUsage.add(segmentUsage);
      allNewItems.push(...segmentResult.newItems);
      turnsUsed += segmentResult.currentTurn;
      lastResponseId = segmentResult.lastResponseId ?? lastResponseId;

      // Check exit conditions
      if (segmentAborted) break;

      const gameState = toolContext.currentFrame?.state;
      if (gameState === "WIN" || gameState === "GAME_OVER") {
        logger.info(
          `[AgentSdk RETRY] Game reached terminal state "${gameState}" after segment ${segmentNumber}`,
          "arc3-agentsdk",
        );
        break;
      }

      if (abortSignal?.aborted) break;

      // If turns are exhausted, stop
      if (turnsUsed >= maxTurns) {
        logger.info(
          `[AgentSdk RETRY] All ${maxTurns} turns consumed after segment ${segmentNumber}`,
          "arc3-agentsdk",
        );
        break;
      }

      // Continue with conversation history for next segment
      runInput = segmentResult.history;

      logger.info(
        `[AgentSdk RETRY] Segment ${segmentNumber} ended (model returned text without tool calls). ` +
          `Turns: ${turnsUsed}/${maxTurns}, continuing with history (${segmentResult.history.length} items)`,
        "arc3-agentsdk",
      );
    }

    /* ---------------------------------------------------------------- */
    /*  Post-loop finalization                                           */
    /* ---------------------------------------------------------------- */

    // Process timeline from all segments
    const timeline = processRunItemsWithReasoning(
      allNewItems,
      agentName,
      streamState.accumulatedReasoning,
    );

    // Get final state from tool context (tools mutate it during run)
    const finalFrame = toolContext.currentFrame;
    const finalGameGuid = toolContext.gameGuid;

    // Close scorecard on terminal state
    if (
      finalFrame &&
      (finalFrame.state === "WIN" || finalFrame.state === "GAME_OVER")
    ) {
      try {
        await this.apiClient.closeScorecard(scorecardId);
        logger.info(
          `[AgentSdk STREAMING] Closed scorecard ${scorecardId} - game ended with ${finalFrame.state}`,
          "arc3-agentsdk",
        );
        streamHarness.emitEvent("scorecard.closed", {
          scorecardId,
          finalState: finalFrame.state,
          timestamp: Date.now(),
        });
      } catch (error) {
        logger.warn(
          `[AgentSdk STREAMING] Failed to close scorecard ${scorecardId}: ${error instanceof Error ? error.message : String(error)}`,
          "arc3-agentsdk",
        );
      }
    }

    const finalOutputText =
      allNewItems.length > 0 ? extractAllTextOutput(allNewItems) : undefined;

    if (finalFrame === null) {
      throw new Error("No frame data available - game did not start properly");
    }

    const summary = buildRunSummary(
      finalFrame,
      gameId,
      toolContext.frames.length,
    );

    const generatedRunId = randomUUID();
    // Only OpenAI models return a usable lastResponseId for continuation
    const providerResponseId = modelConfig.supportsPreviousResponseId
      ? (lastResponseId ?? null)
      : null;

    // Write final trace data
    streamTraceSession
      .writeFrame({
        frameIndex: toolContext.frames.length - 1,
        state: finalFrame.state,
        score: finalFrame.score,
        actionCounter: finalFrame.action_counter,
        maxActions: finalFrame.max_actions,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3-agentsdk",
        ),
      );
    streamTraceSession
      .writeSummary({
        gameId,
        gameGuid: finalGameGuid || "unknown",
        finalState: finalFrame.state,
        finalScore: finalFrame.score,
        totalFrames: toolContext.frames.length,
        usage: {
          requests: accumulatedUsage.requests,
          inputTokens: accumulatedUsage.inputTokens,
          outputTokens: accumulatedUsage.outputTokens,
          totalTokens: accumulatedUsage.totalTokens,
        },
        elapsedMs: Date.now() - streamRunStartMs,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3-agentsdk",
        ),
      );

    // Emit completion event
    streamHarness.emitEvent("agent.completed", {
      runId: generatedRunId,
      gameGuid: finalGameGuid || "unknown",
      scorecardId,
      finalOutput: finalOutputText,
      summary,
      usage: {
        requests: accumulatedUsage.requests,
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      timelineLength: timeline.length,
      frameCount: toolContext.frames.length,
      providerResponseId,
      provider: modelConfig.providerKind,
      supportsContinuation: modelConfig.supportsPreviousResponseId,
      segments: segmentNumber,
      turnsUsed,
      timestamp: Date.now(),
    });

    // Tear down local game bridge if applicable
    await this.apiClient.cleanup?.();

    return {
      runId: generatedRunId,
      gameGuid: finalGameGuid || "unknown",
      scorecardId,
      finalOutput: finalOutputText?.trim() ? finalOutputText.trim() : undefined,
      timeline,
      frames: toolContext.frames as any[],
      summary,
      usage: {
        requests: accumulatedUsage.requests,
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      providerResponseId,
    };
  }
}
