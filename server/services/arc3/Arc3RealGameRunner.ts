import { randomUUID, createHash } from "node:crypto";
import { Agent, run, extractAllTextOutput } from "@openai/agents";
import {
  Arc3ApiClient,
  type FrameData,
  type GameAction,
} from "./Arc3ApiClient.ts";
import type {
  Arc3AgentRunConfig,
  Arc3AgentRunResult,
  Arc3RunTimelineEntry,
  Arc3RunSummary,
  Arc3GameState,
} from "./types.ts";
import { buildArc3DefaultPrompt } from "./prompts.ts";
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TURNS,
  DEFAULT_GAME_ID,
} from "./utils/constants.ts";
import {
  processRunItems,
  processRunItemsWithReasoning,
} from "./utils/timelineProcessor.ts";
import {
  generateActionCaption,
  generateInspectCaption,
} from "./helpers/captionGenerator.ts";
import {
  countChangedPixels,
  analyzeFrameChanges,
  extractGrid,
  extractLayerStack,
} from "./helpers/frameAnalysis.ts";
import { calculateColorDistribution } from "./helpers/colorAnalysis.ts";
import {
  unpackFrames,
  summarizeFrameStructure,
} from "./helpers/frameUnpacker.ts";
import {
  createSession,
  getSessionByGuid,
  endSession,
  type SessionMetadata,
} from "./persistence/sessionManager";
import { saveFrame, type SavedFrame } from "./persistence/framePersistence";
import {
  openScorecard,
  closeScorecard,
  getScorecard,
} from "./scorecardService.ts";

import { executeGridAnalysis } from "./helpers/gridAnalyzer.ts";
import { logger } from "../../utils/logger.ts";
import {
  createArc3Tools,
  type Arc3ToolContext,
  type Arc3StreamHarness as FactoryStreamHarness,
} from "./tools/Arc3ToolFactory.ts";
import {
  buildCombinedInstructions,
  buildRunSummary,
} from "./helpers/runHelpers.ts";
import { PlaygroundTraceSession } from "./data/playgroundTraceWriter.ts";
import { Notepad } from "../eval/runner/notepad";

export interface Arc3StreamHarness {
  sessionId: string;
  emit: (chunk: any) => void;
  emitEvent: (event: string, data: any) => void;
  end: (summary: any) => void;
  metadata: {
    game_id: string; // Match API property name
    agentName: string;
  };
}

export class Arc3RealGameRunner {
  constructor(private readonly apiClient: Arc3ApiClient) {}

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

  /**
   * CRITICAL FIX: Persist unpacked animation frames to database.
   *
   * When an ARC-AGI-3 action returns animation (multiple frames), we unpack them
   * and persist each frame individually to the database. This ensures:
   * - Complete frame history (not lossy)
   * - Proper action efficiency scoring (counts all frames)
   * - Accurate replay data (animation visible)
   * - Agent context (can see state transitions)
   *
   * @param dbSessionId - Database session ID
   * @param unpackedFrames - Array of FrameData objects from unpackFrames()
   * @param action - The action that produced these frames
   * @param prevFrame - Previous frame for pixel diff calculation
   * @param currentFrameNumber - Starting frame number for this action
   * @returns Updated frame number after persistence
   */
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

        // Only compare pixel changes for final frame of animation
        // Intermediate frames are IN_PROGRESS, so pixel diff is less meaningful
        const isLastFrame = i === unpackedFrames.length - 1;
        const pixelsChanged =
          isLastFrame && prevFrame ? countChangedPixels(prevFrame, frame) : 0;

        // Generate caption (include animation sequence info if multi-frame)
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
          `[Frame Persistence] Saved frame ${frameNum} (animation ${i + 1}/${unpackedFrames.length}): ` +
            `${caption}`,
          "arc3",
        );

        frameNum++;
      }
    } catch (error) {
      logger.warn(
        `[Frame Persistence] Failed to persist unpacked frames: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "arc3",
      );
    }

    return frameNum;
  }

  /**
   * Continue an existing game session WITHOUT executing any actions.
   * CRITICAL: We must NOT execute actions just to "fetch" state - that changes the game!
   * Instead, we rely on the cached frame passed from the frontend.
   * If no cached frame is provided, we throw an error rather than corrupting game state.
   */
  private validateContinuationFrame(
    seedFrame: FrameData | undefined,
    gameId: string,
    gameGuid: string,
  ): FrameData {
    if (!seedFrame) {
      throw new Error(
        `[ARC3] Cannot continue game session ${gameGuid} without a seed frame. ` +
          `The frontend must provide the last known frame state when continuing. ` +
          `Executing actions to "fetch" state would corrupt the game!`,
      );
    }

    if (seedFrame.guid !== gameGuid) {
      logger.warn(
        `[ARC3] Seed frame guid (${seedFrame.guid}) doesn't match expected guid (${gameGuid}). Using seed frame anyway.`,
        "arc3",
      );
    }

    logger.info(
      `[ARC3] Continuing game session: ${gameGuid} at state=${seedFrame.state}, score=${seedFrame.score}, actions=${seedFrame.action_counter}/${seedFrame.max_actions}`,
      "arc3",
    );

    return seedFrame;
  }

  async run(config: Arc3AgentRunConfig): Promise<Arc3AgentRunResult> {
    const agentName = config.agentName?.trim() || "ARC3 Real Game Operator";
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const gameId = config.game_id ?? DEFAULT_GAME_ID;
    const scorecardId = await this.apiClient.openScorecard(
      ["arc-explainer", "agent-run"],
      "https://github.com/arc-explainer/arc-explainer",
      {
        source: "arc-explainer",
        mode: "agent-run",
        game_id: gameId,
        agentName,
      },
    );

    let gameGuid: string | null = null;
    let currentFrame: FrameData | null = null;
    let prevFrame: FrameData | null = null;
    const frames: FrameData[] = [];
    let dbSessionId: number | null = null;

    // Start a fresh session OR continue an existing one
    // CRITICAL: When continuing, we MUST have a seed frame - we can't execute actions to "fetch" state
    const initialFrame = config.existingGameGuid
      ? this.validateContinuationFrame(
          config.seedFrame,
          gameId,
          config.existingGameGuid,
        )
      : config.seedFrame
        ? config.seedFrame
        : await this.apiClient.startGame(gameId, undefined, scorecardId);

    gameGuid = initialFrame.guid;

    // ── Disk trace session (fire-and-forget — never crashes games) ────────
    const traceSession = PlaygroundTraceSession.create(gameId);
    const runStartMs = Date.now();
    traceSession
      .writeHeader({
        gameId,
        gameGuid: gameGuid ?? "unknown",
        scorecardId,
        agentName,
        model: config.model ?? DEFAULT_MODEL,
        maxTurns,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3",
        ),
      );

    // CRITICAL FIX: Unpack initial frame if it's an animation (4D array)
    const unpackedInitialFrames = unpackFrames(initialFrame);
    if (unpackedInitialFrames.length > 1) {
      logger.info(
        `[ARC3] Initial RESET returned ${unpackedInitialFrames.length} animation frames: ` +
          summarizeFrameStructure(initialFrame),
        "arc3",
      );
    }

    currentFrame = unpackedInitialFrames[unpackedInitialFrames.length - 1]; // Final frame is settled state
    frames.push(...unpackedInitialFrames); // Add all unpacked frames

    // Write initial frame to disk trace
    if (currentFrame) {
      traceSession
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
            "arc3",
          ),
        );
      traceSession
        .writeEvent("game.initialized", {
          gameGuid,
          isContinuation: !!config.existingGameGuid,
          unpackedFrameCount: unpackedInitialFrames.length,
        })
        .catch((err) =>
          logger.warn(
            `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
            "arc3",
          ),
        );
    }

    // Create database session for frame persistence (only for new games)
    let currentFrameNumber = 0;
    try {
      if (!config.existingGameGuid) {
        dbSessionId = await createSession(
          gameId,
          gameGuid,
          currentFrame.win_score,
          scorecardId,
        );

        // Persist all unpacked initial frames
        currentFrameNumber = await this.persistUnpackedFrames(
          dbSessionId,
          unpackedInitialFrames,
          { action: "RESET" },
          null,
          0,
        );

        logger.info(
          `Created session ${dbSessionId} for game ${gameId} (scorecard: ${scorecardId}) ` +
            `(${unpackedInitialFrames.length} initial frame(s))`,
          "arc3",
        );
      } else {
        logger.info(
          `[ARC3] Continuing game session ${gameGuid} on game ${gameId}`,
          "arc3",
        );
      }
    } catch (error) {
      logger.warn(
        `Failed to create database session: ${error instanceof Error ? error.message : String(error)}`,
        "arc3",
      );
    }

    // Track score progress to detect if agent is stuck
    let noScoreProgressStreak = 0;
    const updateNoScoreProgress = (
      prev: FrameData | null,
      curr: FrameData | null,
    ) => {
      if (!prev || !curr) return;
      if (curr.score === prev.score) {
        noScoreProgressStreak += 1;
      } else {
        noScoreProgressStreak = 0;
      }
    };

    // Create tool context for factory (mutable state accessed by tools via closure)
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
    };

    // Create tools via factory (DRY: eliminates ~240 lines of duplication)
    const tools = createArc3Tools(toolContext, true); // includeResetTool=true for non-streaming

    // Use shared helper for system prompt + operator guidance
    const combinedInstructions = buildCombinedInstructions(config);
    const storeResponse = config.storeResponse ?? true;
    const frameHash = currentFrame
      ? this.computeFrameHash(extractLayerStack(currentFrame))
      : undefined;
    const metadata = {
      sessionId: config.sessionId,
      gameGuid: gameGuid || undefined,
      frameHash,
      frameIndex: String(frames.length - 1),
      previousResponseId: config.previousResponseId ?? null,
      systemPromptPresetId: config.systemPromptPresetId ?? null,
      skipDefaultSystemPrompt: String(config.skipDefaultSystemPrompt ?? false),
    };

    const agent = new Agent({
      name: agentName,
      instructions: combinedInstructions,
      handoffDescription: "Operates the ARC-AGI-3 real game interface.",
      model: config.model ?? DEFAULT_MODEL,
      modelSettings: {
        reasoning: {
          effort: (config.reasoningEffort ?? "high") as
            | "minimal"
            | "low"
            | "medium"
            | "high",
          summary: "detailed",
        },
        text: { verbosity: "medium" },
        store: storeResponse,
        providerData: {
          metadata,
        },
      },
      tools,
    });

    const result = await run(
      agent,
      `Start playing the ARC-AGI-3 game "${gameId}". Narrate before every tool call, then execute it. Keep using the What I see / What it means / Next move format until you deliver the Final Report.`,
      {
        maxTurns,
        previousResponseId: config.previousResponseId,
      },
    );

    // Process timeline entries using extracted utility (eliminates duplication)
    const timeline = processRunItems(result.newItems, agentName);

    // Get final frame from context (tools mutate context during run)
    const finalFrame = toolContext.currentFrame;
    const finalGameGuid = toolContext.gameGuid;

    // Close scorecard when game reaches terminal state (per audit: must close after WIN/GAME_OVER)
    // Sessions remain open for continuations ONLY if game is still in progress
    if (
      finalFrame &&
      (finalFrame.state === "WIN" || finalFrame.state === "GAME_OVER")
    ) {
      try {
        await this.apiClient.closeScorecard(scorecardId);
        logger.info(
          `[ARC3] Closed scorecard ${scorecardId} - game ended with ${finalFrame.state}`,
          "arc3",
        );
      } catch (error) {
        logger.warn(
          `[ARC3] Failed to close scorecard ${scorecardId}: ${error instanceof Error ? error.message : String(error)}`,
          "arc3",
        );
      }
    }

    const usage = result.state._context.usage;
    const providerResponseId = result.lastResponseId ?? null;
    const finalOutputCandidate = result.finalOutput;
    const finalOutput =
      typeof finalOutputCandidate === "string"
        ? finalOutputCandidate
        : extractAllTextOutput(result.newItems);

    // Create summary from the last frame (should always exist since we start the game before agent runs)
    // Use shared helper for summary building (DRY: eliminates duplicated mapState + summary construction)
    if (finalFrame === null) {
      throw new Error("No frame data available - game did not start properly");
    }

    const summary = buildRunSummary(
      finalFrame,
      gameId,
      toolContext.frames.length,
    );

    // ── Write final frame + summary to disk trace (fire-and-forget) ───────
    traceSession
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
          "arc3",
        ),
      );
    traceSession
      .writeSummary({
        gameId,
        gameGuid: finalGameGuid || "unknown",
        finalState: finalFrame.state,
        finalScore: finalFrame.score,
        totalFrames: toolContext.frames.length,
        usage: {
          requests: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
        elapsedMs: Date.now() - runStartMs,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3",
        ),
      );

    return {
      runId: randomUUID(),
      gameGuid: finalGameGuid || "unknown",
      scorecardId, // CRITICAL: Return scorecard ID for session continuation
      finalOutput: finalOutput?.trim() ? finalOutput.trim() : undefined,
      timeline,
      frames: frames as any[], // Arc3AgentRunResult accepts any[] for frames
      summary,
      usage: {
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      providerResponseId,
    };
  }

  async runWithStreaming(
    config: Arc3AgentRunConfig,
    streamHarness: Arc3StreamHarness,
  ): Promise<Arc3AgentRunResult> {
    const agentName = config.agentName?.trim() || "ARC3 Real Game Operator";
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const gameId = config.game_id ?? DEFAULT_GAME_ID;

    // CRITICAL: Reuse existing scorecard on continuation, open new one on fresh start
    let scorecardId: string;
    if (config.scorecardId) {
      // Continuation: reuse existing scorecard (stays open across multiple agent runs)
      scorecardId = config.scorecardId;
      logger.info(
        `[ARC3 STREAMING] Reusing existing scorecard ${scorecardId} for continuation`,
        "arc3",
      );
    } else {
      // Fresh start: open new scorecard with educational metadata tags
      const scorecardTags = [
        "arc-explainer",
        "educational-playground", // Mark as educational, not official competition entry
        "interactive-agent", // User can interrupt/guide mid-game
        `model:${config.model ?? DEFAULT_MODEL}`,
        `reasoning:${config.reasoningEffort ?? "low"}`,
      ];

      scorecardId = await this.apiClient.openScorecard(
        scorecardTags,
        "https://github.com/arc-explainer/arc-explainer",
        {
          source: "arc-explainer",
          mode: "educational-interactive",
          game_id: gameId,
          agentName,
          userInterruptible: true,
          reasoningLevel: config.reasoningEffort ?? "low",
        },
      );
      logger.info(
        `[ARC3 STREAMING] Opened new scorecard ${scorecardId} for fresh game`,
        "arc3",
      );
    }

    let gameGuid: string | null = null;
    let currentFrame: FrameData | null = null;
    let prevFrame: FrameData | null = null;
    const frames: FrameData[] = [];
    let dbSessionId: number | null = null;
    let isContinuation = false;

    // Start a fresh session OR continue an existing one
    // CRITICAL: When continuing, we MUST have a seed frame - we can't execute actions to "fetch" state
    const initialFrame = config.existingGameGuid
      ? this.validateContinuationFrame(
          config.seedFrame,
          gameId,
          config.existingGameGuid,
        )
      : await this.apiClient.startGame(gameId, undefined, scorecardId);

    gameGuid = initialFrame.guid;
    isContinuation = !!config.existingGameGuid;

    // ── Disk trace session (fire-and-forget — never crashes games) ────────
    const streamTraceSession = PlaygroundTraceSession.create(gameId);
    const streamRunStartMs = Date.now();
    streamTraceSession
      .writeHeader({
        gameId,
        gameGuid: gameGuid ?? "unknown",
        scorecardId,
        agentName,
        model: config.model ?? DEFAULT_MODEL,
        maxTurns,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3",
        ),
      );

    // CRITICAL FIX: Unpack initial frame if it's an animation (4D array)
    const unpackedInitialFrames = unpackFrames(initialFrame);
    if (unpackedInitialFrames.length > 1) {
      logger.info(
        `[ARC3 STREAMING] Initial RESET returned ${unpackedInitialFrames.length} animation frames: ` +
          summarizeFrameStructure(initialFrame),
        "arc3",
      );
    }

    currentFrame = unpackedInitialFrames[unpackedInitialFrames.length - 1]; // Final frame is settled state
    frames.push(...unpackedInitialFrames); // Add all unpacked frames

    // Write initial frame to disk trace
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
            "arc3",
          ),
        );
      streamTraceSession
        .writeEvent("game.initialized", {
          gameGuid,
          isContinuation,
          unpackedFrameCount: unpackedInitialFrames.length,
        })
        .catch((err) =>
          logger.warn(
            `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
            "arc3",
          ),
        );
    }

    // Create database session for frame persistence (only for new games)
    let currentFrameNumber = 0;
    try {
      if (isContinuation) {
        logger.info(
          `[ARC3 STREAMING] Continuing game session ${gameGuid} on game ${gameId}`,
          "arc3",
        );
      } else {
        dbSessionId = await createSession(
          gameId,
          gameGuid,
          currentFrame.win_score,
          scorecardId,
        );

        // Persist all unpacked initial frames
        currentFrameNumber = await this.persistUnpackedFrames(
          dbSessionId,
          unpackedInitialFrames,
          { action: "RESET" },
          null,
          0,
        );

        logger.info(
          `Created streaming session ${dbSessionId} for game ${gameId} (scorecard: ${scorecardId}) ` +
            `(${unpackedInitialFrames.length} initial frame(s))`,
          "arc3",
        );
      }
    } catch (error) {
      logger.warn(
        `Failed to create database session: ${error instanceof Error ? error.message : String(error)}`,
        "arc3",
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

    // Add reasoning accumulator to track incremental reasoning content
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
      timestamp: Date.now(),
    });

    // Create persistent notepad for working memory across context window
    const notepad = new Notepad();

    // Create tool context for factory (mutable state accessed by tools via closure)
    // Streaming context includes harness and reasoning accumulator
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

    // Create tools via factory (DRY: eliminates ~285 lines of duplication)
    // No reset tool for streaming mode; notepad tools auto-included via ctx.notepad
    const tools = createArc3Tools(toolContext, false);

    // Use shared helper for system prompt + operator guidance + notepad instructions
    const combinedInstructions = buildCombinedInstructions(config, {
      notepadEnabled: true,
    });
    const storeResponse = config.storeResponse ?? true;
    const frameHash = currentFrame
      ? this.computeFrameHash(extractLayerStack(currentFrame))
      : undefined;
    const metadata = {
      sessionId: config.sessionId,
      gameGuid: gameGuid || undefined,
      frameHash,
      frameIndex: String(frames.length - 1),
      previousResponseId: config.previousResponseId ?? null,
      systemPromptPresetId: config.systemPromptPresetId ?? null,
      skipDefaultSystemPrompt: String(config.skipDefaultSystemPrompt ?? false),
    };

    const agent = new Agent({
      name: agentName,
      instructions: combinedInstructions,
      handoffDescription: "Operates the ARC-AGI-3 real game interface.",
      model: config.model ?? DEFAULT_MODEL,
      modelSettings: {
        reasoning: {
          effort: (config.reasoningEffort ?? "high") as
            | "minimal"
            | "low"
            | "medium"
            | "high",
          summary: "detailed",
        },
        text: { verbosity: "medium" },
        store: storeResponse,
        providerData: {
          metadata,
        },
      },
      tools,
    });

    // Emit agent ready event
    streamHarness.emitEvent("agent.ready", {
      agentName,
      model: config.model ?? DEFAULT_MODEL,
      instructions: combinedInstructions,
      timestamp: Date.now(),
    });

    // Use streaming mode for the agent run
    const result = await run(
      agent,
      `Start playing the ARC-AGI-3 game "${gameId}". Narrate before every tool call, then execute it. Keep using the What I see / What it means / Next move format until you deliver the Final Report.`,
      {
        maxTurns,
        stream: true,
        previousResponseId: config.previousResponseId,
      },
    );

    // Process streaming events
    for await (const event of result) {
      switch (event.type) {
        case "raw_model_stream_event":
          {
            const eventData = event.data;

            // The Agents SDK wraps Responses API events in event.data.event
            // when event.data.type === 'model'
            if (eventData.type === "model") {
              const modelEvent = (eventData as any).event;

              // Handle reasoning deltas - extract from nested event structure
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

            // Forward raw model events (for debugging/logging)
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
                // Reasoning deltas already handled via raw_model_stream_event; keep UI updated with latest aggregate
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
                      "arc3",
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
                      "arc3",
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
          // Forward agent updates
          streamHarness.emitEvent("agent.updated", {
            agent: event.agent,
            timestamp: Date.now(),
          });
          break;
      }
    }

    // Process final timeline entries using extracted utility (eliminates duplication)
    const timeline = processRunItemsWithReasoning(
      result.newItems,
      agentName,
      streamState.accumulatedReasoning,
    );

    // Get final frame from context (tools mutate context during run)
    const finalFrame = toolContext.currentFrame;
    const finalGameGuid = toolContext.gameGuid;

    // Close scorecard when game reaches terminal state (per audit: must close after WIN/GAME_OVER)
    // Sessions remain open for continuations ONLY if game is still in progress
    if (
      finalFrame &&
      (finalFrame.state === "WIN" || finalFrame.state === "GAME_OVER")
    ) {
      try {
        await this.apiClient.closeScorecard(scorecardId);
        logger.info(
          `[ARC3 STREAMING] Closed scorecard ${scorecardId} - game ended with ${finalFrame.state}`,
          "arc3",
        );
        streamHarness.emitEvent("scorecard.closed", {
          scorecardId,
          finalState: finalFrame.state,
          timestamp: Date.now(),
        });
      } catch (error) {
        logger.warn(
          `[ARC3 STREAMING] Failed to close scorecard ${scorecardId}: ${error instanceof Error ? error.message : String(error)}`,
          "arc3",
        );
      }
    }

    const usage = result.state._context.usage;
    const finalOutputCandidate = result.finalOutput;
    const finalOutput =
      typeof finalOutputCandidate === "string"
        ? finalOutputCandidate
        : extractAllTextOutput(result.newItems);

    // Create summary from the last frame (should always exist since we start the game before agent runs)
    // Use shared helper for summary building (DRY: eliminates duplicated mapState + summary construction)
    if (finalFrame === null) {
      throw new Error("No frame data available - game did not start properly");
    }

    const summary = buildRunSummary(
      finalFrame,
      gameId,
      toolContext.frames.length,
    );

    const generatedRunId = randomUUID();
    const providerResponseId = result.lastResponseId ?? null;

    // ── Write final frame + summary to disk trace (fire-and-forget) ───────
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
          "arc3",
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
          requests: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
        elapsedMs: Date.now() - streamRunStartMs,
      })
      .catch((err) =>
        logger.warn(
          `[Trace] write failed: ${err instanceof Error ? err.message : String(err)}`,
          "arc3",
        ),
      );

    // Emit completion event with scorecard ID for session continuation
    streamHarness.emitEvent("agent.completed", {
      runId: generatedRunId,
      gameGuid: finalGameGuid || "unknown", // Include game session guid for continuation
      scorecardId, // CRITICAL: Include scorecard ID for continuation requests
      finalOutput,
      summary,
      usage: {
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      timelineLength: timeline.length,
      frameCount: toolContext.frames.length,
      providerResponseId,
      timestamp: Date.now(),
    });

    return {
      runId: generatedRunId,
      gameGuid: finalGameGuid || "unknown",
      scorecardId, // CRITICAL: Return scorecard ID for session continuation
      finalOutput: finalOutput?.trim() ? finalOutput.trim() : undefined,
      timeline,
      frames: toolContext.frames as any[], // Arc3AgentRunResult accepts any[] for frames
      summary,
      usage: {
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      providerResponseId,
    };
  }
}
