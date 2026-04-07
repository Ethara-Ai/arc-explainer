import { nanoid } from "nanoid";
import type { Request } from "express";
import { sseStreamManager } from "../../streaming/SSEStreamManager";
import { logger } from "../../../utils/logger";
import { resolveStreamingConfig } from "@shared/config/streaming";
import { Arc3ApiClient } from "../Arc3ApiClient";
import type { FrameData } from "../Arc3ApiClient";
import { AgentSdkRunner } from "./AgentSdkRunner";
import type { Arc3AgentRunConfig } from "../types";
import { getModelConfig } from "./providerRegistry";
import { LocalGameClient, isLocalGame } from "./LocalGameClient";

/* ------------------------------------------------------------------ */
/*  Payload types                                                      */
/* ------------------------------------------------------------------ */

export interface AgentSdkStreamPayload {
  game_id: string;
  agentName?: string;
  systemPrompt?: string;
  instructions: string;
  model?: string;
  maxTurns?: number;
  contextWindow?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  sessionId?: string;
  createdAt?: number;
  expiresAt?: number;
  existingGameGuid?: string;
  scorecardId?: string;
  providerResponseId?: string | null;
  lastFrame?: FrameData;
  systemPromptPresetId?: "twitch" | "playbook" | "none";
  skipDefaultSystemPrompt?: boolean;
}

export interface ContinueAgentSdkStreamPayload extends AgentSdkStreamPayload {
  userMessage: string;
  previousResponseId: string;
  lastFrame?: FrameData;
}

export const PENDING_AGENTSDK_SESSION_TTL_SECONDS = 900; // 15 minutes
const POST_RUN_TTL_MS = 300_000; // 5 minutes — continuation window after run completes

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class AgentSdkStreamService {
  private readonly pendingSessions: Map<string, AgentSdkStreamPayload> =
    new Map();
  private readonly pendingSessionTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();
  private readonly continuationSessions: Map<
    string,
    ContinueAgentSdkStreamPayload
  > = new Map();
  private readonly continuationSessionTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();
  private readonly activeAbortControllers: Map<string, AbortController> =
    new Map();
  private readonly apiClient: Arc3ApiClient;
  private readonly gameRunner: AgentSdkRunner;

  constructor() {
    const apiKey = process.env.ARC3_API_KEY || "";
    if (!apiKey) {
      logger.warn(
        "[AgentSdk StreamService] ARC3_API_KEY is not set. Remote game streaming will fail until configured.",
        "arc3-agentsdk-stream",
      );
    }
    this.apiClient = new Arc3ApiClient(apiKey);
    this.gameRunner = new AgentSdkRunner(this.apiClient);
  }

  /**
   * Create the appropriate runner for a game ID.
   * Local puzzle-environments games use LocalGameClient; remote games use Arc3ApiClient.
   */
  private createRunner(gameId: string): AgentSdkRunner {
    if (isLocalGame(gameId)) {
      logger.info(
        `[AgentSdk StreamService] Using LocalGameClient for local game: ${gameId}`,
        "arc3-agentsdk-stream",
      );
      return new AgentSdkRunner(new LocalGameClient());
    }
    return this.gameRunner;
  }

  /* ---- Pending session management ---- */

  savePendingPayload(
    payload: AgentSdkStreamPayload,
    ttlMs: number = PENDING_AGENTSDK_SESSION_TTL_SECONDS * 1000,
  ): string {
    const sessionId = payload.sessionId ?? nanoid();
    const now = Date.now();
    const expirationTimestamp = ttlMs > 0 ? now + ttlMs : now;

    const enrichedPayload: AgentSdkStreamPayload = {
      ...payload,
      sessionId,
      createdAt: now,
      expiresAt: expirationTimestamp,
    };

    this.pendingSessions.set(sessionId, enrichedPayload);
    this.scheduleExpiration(sessionId, ttlMs);
    return sessionId;
  }

  getPendingPayload(sessionId: string): AgentSdkStreamPayload | undefined {
    return this.pendingSessions.get(sessionId);
  }

  clearPendingPayload(sessionId: string): void {
    this.pendingSessions.delete(sessionId);
    const timer = this.pendingSessionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingSessionTimers.delete(sessionId);
    }
  }

  updatePendingPayload(
    sessionId: string,
    updates: Partial<AgentSdkStreamPayload>,
  ): void {
    const existingPayload = this.pendingSessions.get(sessionId);
    if (!existingPayload) {
      return;
    }

    const mergedPayload: AgentSdkStreamPayload = {
      ...existingPayload,
      ...updates,
      sessionId: existingPayload.sessionId,
      createdAt: existingPayload.createdAt,
      expiresAt: updates.expiresAt ?? existingPayload.expiresAt,
    };

    this.pendingSessions.set(sessionId, mergedPayload);
  }

  /* ---- Continuation session management ---- */

  saveContinuationPayload(
    sessionId: string,
    basePayload: AgentSdkStreamPayload,
    continuationData: {
      userMessage: string;
      previousResponseId: string;
      existingGameGuid?: string;
      lastFrame?: FrameData;
    },
    ttlMs: number = PENDING_AGENTSDK_SESSION_TTL_SECONDS * 1000,
  ): void {
    if (!continuationData.previousResponseId) {
      throw new Error("Continuation payload requires a previousResponseId.");
    }

    const now = Date.now();
    const expirationTimestamp = ttlMs > 0 ? now + ttlMs : now;

    const continuationPayload: ContinueAgentSdkStreamPayload = {
      ...basePayload,
      sessionId,
      userMessage: continuationData.userMessage,
      previousResponseId: continuationData.previousResponseId,
      existingGameGuid: continuationData.existingGameGuid,
      lastFrame: continuationData.lastFrame ?? basePayload.lastFrame,
      createdAt: now,
      expiresAt: expirationTimestamp,
    };

    this.continuationSessions.set(sessionId, continuationPayload);
    this.scheduleContinuationExpiration(sessionId, ttlMs);
  }

  getContinuationPayload(
    sessionId: string,
  ): ContinueAgentSdkStreamPayload | undefined {
    return this.continuationSessions.get(sessionId);
  }

  clearContinuationPayload(sessionId: string): void {
    this.continuationSessions.delete(sessionId);
    const timer = this.continuationSessionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.continuationSessionTimers.delete(sessionId);
    }
  }

  /* ---- TTL expiration scheduling ---- */

  private scheduleContinuationExpiration(
    sessionId: string,
    ttlMs: number,
  ): void {
    const existingTimer = this.continuationSessionTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (ttlMs <= 0) {
      this.clearContinuationPayload(sessionId);
      return;
    }

    const timer = setTimeout(() => {
      this.continuationSessions.delete(sessionId);
      this.continuationSessionTimers.delete(sessionId);
      logger.debug(
        `[AgentSdk Streaming] Continuation payload for session ${sessionId} expired after ${ttlMs}ms`,
        "arc3-agentsdk-stream",
      );
    }, ttlMs);

    timer.unref();

    this.continuationSessionTimers.set(sessionId, timer);
  }

  private scheduleExpiration(sessionId: string, ttlMs: number): void {
    const existingTimer = this.pendingSessionTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (ttlMs <= 0) {
      this.clearPendingPayload(sessionId);
      return;
    }

    const timer = setTimeout(() => {
      this.pendingSessions.delete(sessionId);
      this.pendingSessionTimers.delete(sessionId);
      logger.debug(
        `[AgentSdk Streaming] Pending payload for session ${sessionId} expired after ${ttlMs}ms`,
        "arc3-agentsdk-stream",
      );
    }, ttlMs);

    timer.unref();

    this.pendingSessionTimers.set(sessionId, timer);
  }

  /* ---- Streaming ---- */

  async startStreaming(
    _req: Request,
    payload: AgentSdkStreamPayload,
  ): Promise<string> {
    const sessionId = payload.sessionId ?? nanoid();

    if (!process.env.ARC3_API_KEY && !isLocalGame(payload.game_id)) {
      sseStreamManager.error(
        sessionId,
        "CONFIG_ERROR",
        "ARC3_API_KEY is not configured. Set the environment variable and restart the server.",
      );
      return sessionId;
    }

    try {
      if (!sseStreamManager.has(sessionId)) {
        throw new Error(
          "SSE session must be registered before starting AgentSDK streaming.",
        );
      }

      const streamingConfig = resolveStreamingConfig();
      if (!streamingConfig.enabled) {
        sseStreamManager.error(
          sessionId,
          "STREAMING_DISABLED",
          "Streaming is disabled on this server.",
        );
        return sessionId;
      }

      const {
        game_id,
        agentName,
        systemPrompt,
        instructions,
        model,
        maxTurns,
        contextWindow,
        reasoningEffort,
        systemPromptPresetId,
        skipDefaultSystemPrompt,
      } = payload;

      // Resolve model config for logging
      const modelKey = model ?? "claude-opus-4-6";
      const modelConfig = getModelConfig(modelKey);
      logger.info(
        `[AgentSdk Streaming] Starting session ${sessionId}: game=${game_id}, model=${modelKey}, ` +
          `provider=${modelConfig.providerKind}, maxTurns=${maxTurns ?? "(default)"}, preset=${systemPromptPresetId ?? "(default)"}`,
        "arc3-agentsdk-stream",
      );

      sseStreamManager.sendEvent(sessionId, "stream.init", {
        state: "starting",
        game_id,
        agentName: agentName || "AgentSDK Agent",
        model: modelKey,
        provider: modelConfig.providerKind,
        timestamp: Date.now(),
      });

      // Create streaming harness
      const streamHarness = {
        sessionId,
        emit: (chunk: any) => {
          const enrichedChunk = {
            ...(chunk ?? {}),
            metadata: {
              ...(chunk?.metadata ?? {}),
              game_id,
              agentName: agentName || "AgentSDK Agent",
            },
          };
          sseStreamManager.sendEvent(sessionId, "stream.chunk", enrichedChunk);
        },
        end: (summary: any) => {
          sseStreamManager.close(sessionId, summary);
        },
        emitEvent: (event: string, data: any) => {
          const enrichedEvent =
            data && typeof data === "object"
              ? { ...data, game_id, agentName: agentName || "AgentSDK Agent" }
              : { game_id, agentName: agentName || "AgentSDK Agent" };
          sseStreamManager.sendEvent(sessionId, event, enrichedEvent);
        },
        metadata: {
          game_id,
          agentName: agentName || "AgentSDK Agent",
        },
      };

      const runConfig: Arc3AgentRunConfig = {
        game_id,
        agentName,
        systemPrompt,
        instructions,
        model: modelKey,
        maxTurns,
        contextWindow,
        reasoningEffort,
        storeResponse: true,
        sessionId,
        systemPromptPresetId,
        skipDefaultSystemPrompt,
      };

      sseStreamManager.sendEvent(sessionId, "stream.status", {
        state: "running",
        game_id,
        message: `${modelConfig.displayName} is starting to play the game...`,
        timestamp: Date.now(),
      });

      const abortController = new AbortController();
      this.activeAbortControllers.set(sessionId, abortController);

      const runner = this.createRunner(game_id);
      const runResult = await runner.runWithStreaming(
        runConfig,
        streamHarness,
        abortController.signal,
      );

      this.activeAbortControllers.delete(sessionId);

      const finalFrame =
        Array.isArray(runResult.frames) && runResult.frames.length > 0
          ? (runResult.frames[runResult.frames.length - 1] as FrameData)
          : payload.lastFrame;

      logger.info(
        `[AgentSdk Streaming] Caching final frame for session ${sessionId}; frame index=${runResult.frames?.length ?? 0}`,
        "arc3-agentsdk-stream",
      );

      // Persist state for future continuations
      this.updatePendingPayload(sessionId, {
        existingGameGuid: runResult.gameGuid,
        scorecardId: runResult.scorecardId,
        providerResponseId: runResult.providerResponseId ?? null,
        lastFrame: finalFrame,
      });

      // Extend TTL for continuation window
      this.scheduleExpiration(sessionId, POST_RUN_TTL_MS);
      logger.info(
        `[AgentSdk Streaming] Session ${sessionId} completed, extended TTL to ${POST_RUN_TTL_MS}ms`,
        "arc3-agentsdk-stream",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `AgentSdk streaming failed: ${message}`,
        "arc3-agentsdk-stream",
      );
      sseStreamManager.error(sessionId, "STREAMING_FAILED", message);
      this.clearPendingPayload(sessionId);
    }

    return sessionId;
  }

  async continueStreaming(
    _req: Request,
    payload: ContinueAgentSdkStreamPayload,
  ): Promise<string> {
    const sessionId = payload.sessionId ?? nanoid();

    if (!process.env.ARC3_API_KEY && !isLocalGame(payload.game_id)) {
      sseStreamManager.error(
        sessionId,
        "CONFIG_ERROR",
        "ARC3_API_KEY is not configured. Set the environment variable and restart the server.",
      );
      return sessionId;
    }

    try {
      if (!sseStreamManager.has(sessionId)) {
        throw new Error(
          "SSE session must be registered before continuing AgentSDK streaming.",
        );
      }

      const streamingConfig = resolveStreamingConfig();
      if (!streamingConfig.enabled) {
        sseStreamManager.error(
          sessionId,
          "STREAMING_DISABLED",
          "Streaming is disabled on this server.",
        );
        return sessionId;
      }

      const {
        game_id,
        agentName,
        systemPrompt,
        instructions,
        model,
        maxTurns,
        contextWindow,
        reasoningEffort,
        userMessage,
        previousResponseId,
        existingGameGuid,
        scorecardId,
        systemPromptPresetId,
        skipDefaultSystemPrompt,
      } = payload;

      if (!previousResponseId) {
        throw new Error(
          "AgentSDK continuation requires a previousResponseId to maintain conversation state.",
        );
      }

      // Validate game state
      const TERMINAL_STATES = new Set(["WIN", "GAME_OVER"]);
      if (
        payload.lastFrame?.state &&
        TERMINAL_STATES.has(payload.lastFrame.state)
      ) {
        throw new Error(
          `Cannot continue game in terminal state: ${payload.lastFrame.state}. Game has already ended.`,
        );
      }

      const modelKey = model ?? "claude-opus-4-6";
      const modelConfig = getModelConfig(modelKey);
      logger.info(
        `[AgentSdk Continue] Continuing session ${sessionId}: game=${game_id}, model=${modelKey}, ` +
          `provider=${modelConfig.providerKind}, existingGameGuid=${existingGameGuid ?? "(none)"}`,
        "arc3-agentsdk-stream",
      );

      sseStreamManager.sendEvent(sessionId, "stream.init", {
        state: "continuing",
        game_id,
        agentName: agentName || "AgentSDK Agent",
        hasPreviousResponse: !!previousResponseId,
        isContinuingGame: !!existingGameGuid,
        provider: modelConfig.providerKind,
        timestamp: Date.now(),
      });

      const streamHarness = {
        sessionId,
        emit: (chunk: any) => {
          const enrichedChunk = {
            ...(chunk ?? {}),
            metadata: {
              ...(chunk?.metadata ?? {}),
              game_id,
              agentName: agentName || "AgentSDK Agent",
            },
          };
          sseStreamManager.sendEvent(sessionId, "stream.chunk", enrichedChunk);
        },
        end: (summary: any) => {
          sseStreamManager.close(sessionId, summary);
        },
        emitEvent: (event: string, data: any) => {
          const enrichedEvent =
            data && typeof data === "object"
              ? { ...data, game_id, agentName: agentName || "AgentSDK Agent" }
              : { game_id, agentName: agentName || "AgentSDK Agent" };
          sseStreamManager.sendEvent(sessionId, event, enrichedEvent);
        },
        metadata: {
          game_id,
          agentName: agentName || "AgentSDK Agent",
        },
      };

      sseStreamManager.sendEvent(sessionId, "stream.status", {
        state: "running",
        game_id,
        message: existingGameGuid
          ? `${modelConfig.displayName} continuing game ${existingGameGuid}`
          : `${modelConfig.displayName} continuing with user message`,
        timestamp: Date.now(),
      });

      logger.info(
        `[AgentSdk Continue] Running with userMessage (${userMessage.length} chars), previousResponseId=${!!previousResponseId}, existingGameGuid=${existingGameGuid}`,
        "arc3-agentsdk-stream",
      );

      const runConfig: Arc3AgentRunConfig = {
        game_id,
        agentName,
        systemPrompt,
        instructions: `${instructions}\n\nUser feedback: ${userMessage}`,
        model: modelKey,
        maxTurns,
        contextWindow,
        reasoningEffort,
        existingGameGuid,
        scorecardId,
        previousResponseId,
        seedFrame: payload.lastFrame,
        storeResponse: true,
        sessionId,
        systemPromptPresetId,
        skipDefaultSystemPrompt,
      };

      const abortController = new AbortController();
      this.activeAbortControllers.set(sessionId, abortController);

      const runner = this.createRunner(game_id);
      const runResult = await runner.runWithStreaming(
        runConfig,
        streamHarness,
        abortController.signal,
      );

      this.activeAbortControllers.delete(sessionId);

      const finalFrame =
        Array.isArray(runResult.frames) && runResult.frames.length > 0
          ? (runResult.frames[runResult.frames.length - 1] as FrameData)
          : payload.lastFrame;

      logger.info(
        `[AgentSdk Streaming] Caching continuation frame for session ${sessionId}; frame index=${runResult.frames?.length ?? 0}`,
        "arc3-agentsdk-stream",
      );

      this.updatePendingPayload(sessionId, {
        existingGameGuid: runResult.gameGuid,
        scorecardId: runResult.scorecardId,
        providerResponseId: runResult.providerResponseId ?? null,
        lastFrame: finalFrame,
      });

      const extendedTTL = 300000;
      this.scheduleExpiration(sessionId, extendedTTL);
      logger.info(
        `[AgentSdk Streaming] Continuation ${sessionId} completed, extended TTL to ${POST_RUN_TTL_MS}ms`,
        "arc3-agentsdk-stream",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `AgentSdk continuation failed: ${message}`,
        "arc3-agentsdk-stream",
      );
      sseStreamManager.error(sessionId, "STREAMING_FAILED", message);
      this.clearPendingPayload(sessionId);
    } finally {
      this.clearContinuationPayload(sessionId);
    }

    return sessionId;
  }

  cancelSession(sessionId: string): void {
    logger.warn(
      `[AgentSdk Streaming] Cancelling session ${sessionId}`,
      "arc3-agentsdk-stream",
    );
    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
    }
    if (sseStreamManager.has(sessionId)) {
      sseStreamManager.teardown(sessionId, "cancelled");
    }
    this.clearPendingPayload(sessionId);
  }
}

export const agentSdkStreamService = new AgentSdkStreamService();
