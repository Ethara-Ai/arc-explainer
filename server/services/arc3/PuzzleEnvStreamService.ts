import { nanoid } from "nanoid";
import type { Request } from "express";
import { sseStreamManager } from "../streaming/SSEStreamManager.ts";
import { logger } from "../../utils/logger.ts";
import { resolveStreamingConfig } from "@shared/config/streaming.ts";
import {
  puzzleEnvPythonBridge,
  type PuzzleEnvPayload,
} from "./PuzzleEnvPythonBridge.ts";

export interface PuzzleEnvStreamPayload {
  game_id: string;
  model_key: string; // Eval harness model registry key
  maxTurns?: number;
  systemPrompt?: string; // Custom system prompt override
  seed?: number; // Random seed for game instantiation
  contextWindow?: number; // Conversation history window (default 50)
  withImages?: boolean; // Include PNG screenshots
  agentName?: string; // Display name for the agent
  sessionId?: string;
  createdAt?: number;
  expiresAt?: number;
  // Cached metadata from prior run (for potential UI reuse)
  lastFrameData?: any;
  lastScore?: number;
}

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class PuzzleEnvStreamService {
  private readonly pending = new Map<string, PuzzleEnvStreamPayload>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Save a pending session payload and return sessionId.
   */
  savePayload(
    payload: PuzzleEnvStreamPayload,
    ttlMs: number = SESSION_TTL_MS,
  ): string {
    const sessionId = payload.sessionId ?? nanoid();
    const now = Date.now();
    const enriched: PuzzleEnvStreamPayload = {
      ...payload,
      sessionId,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.pending.set(sessionId, enriched);
    this.scheduleExpiration(sessionId, ttlMs);
    logger.debug(`[PuzzleEnv] Session ${sessionId} saved`, "puzzle-env");
    return sessionId;
  }

  /**
   * Get a pending session payload.
   */
  getPayload(sessionId: string): PuzzleEnvStreamPayload | undefined {
    return this.pending.get(sessionId);
  }

  /**
   * Clear a session and its expiration timer.
   */
  clear(sessionId: string): void {
    this.pending.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    logger.debug(`[PuzzleEnv] Session ${sessionId} cleared`, "puzzle-env");
  }

  /**
   * Schedule session expiration.
   */
  private scheduleExpiration(sessionId: string, ttlMs: number): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      this.timers.delete(sessionId);
      logger.debug(`[PuzzleEnv] Session ${sessionId} expired`, "puzzle-env");
    }, ttlMs);

    timer.unref();
    this.timers.set(sessionId, timer);
  }

  /**
   * Start streaming for a prepared session.
   * Spawns Python runner, parses NDJSON events, forwards to SSE.
   */
  async startStreaming(
    _req: Request,
    payload: PuzzleEnvStreamPayload,
  ): Promise<void> {
    const sessionId = payload.sessionId!;

    if (!sseStreamManager.has(sessionId)) {
      throw new Error(
        "SSE session must be registered before starting streaming.",
      );
    }

    const streamingConfig = resolveStreamingConfig();
    if (!streamingConfig.enabled) {
      sseStreamManager.error(
        sessionId,
        "STREAMING_DISABLED",
        "Streaming disabled on server.",
      );
      return;
    }

    const {
      game_id,
      model_key,
      maxTurns,
      systemPrompt,
      seed,
      contextWindow,
      withImages,
      agentName,
    } = payload;

    // Send initial status
    sseStreamManager.sendEvent(sessionId, "stream.init", {
      state: "starting",
      game_id,
      model_key,
      provider: "puzzle-env",
      agentName: agentName || model_key,
    });

    sseStreamManager.sendEvent(sessionId, "stream.status", {
      state: "running",
      message: `Spawning puzzle-environments runner (${model_key})...`,
      game_id,
    });

    // Build payload for Python runner
    const pythonPayload: PuzzleEnvPayload = {
      game_id,
      model_key,
      max_turns: maxTurns ?? 200,
      system_prompt: systemPrompt,
      seed: seed ?? 0,
      context_window: contextWindow ?? 50,
      with_images: withImages ?? false,
      agent_name: agentName || model_key,
    };

    // Register disconnect hook to kill Python child if client drops
    sseStreamManager.createStream(sessionId, {
      onDisconnect: () => {
        puzzleEnvPythonBridge.cancel(sessionId);
        this.clear(sessionId);
      },
    });

    try {
      // Spawn Python runner and parse NDJSON events
      const { code } = await puzzleEnvPythonBridge.spawnAgent(
        pythonPayload,
        { timeoutMs: 15 * 60 * 1000 }, // 15 minute timeout
        (line: string) => {
          // Parse NDJSON line and forward to SSE
          this.handleStdoutLine(sessionId, line, game_id);
        },
        (line: string) => {
          // Log stderr (Python tracebacks, debug info)
          logger.warn(`[PuzzleEnv] stderr: ${line}`, "puzzle-env");
        },
        sessionId,
      );

      if (code !== 0) {
        logger.error(
          `[PuzzleEnv] Python runner exited with code ${code}`,
          "puzzle-env",
        );
        sseStreamManager.error(
          sessionId,
          "RUNNER_ERROR",
          `Agent exited with code ${code}`,
        );
      }

      // Extend TTL for post-run reads
      this.scheduleExpiration(sessionId, 5 * 60 * 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[PuzzleEnv] Streaming failed: ${message}`, "puzzle-env");
      sseStreamManager.error(sessionId, "STREAMING_ERROR", message);
      this.clear(sessionId);
    } finally {
      sseStreamManager.closeStream(sessionId);
    }
  }

  /**
   * Parse NDJSON line from Python and forward as SSE event.
   */
  private handleStdoutLine(
    sessionId: string,
    line: string,
    game_id: string,
  ): void {
    if (!line.startsWith("{") || !line.endsWith("}")) {
      // Not JSON — emit as status message
      sseStreamManager.sendEvent(sessionId, "stream.status", {
        state: "running",
        message: line,
        game_id,
      });
      return;
    }

    try {
      const event = JSON.parse(line);
      const eventType = event.type || "stream.chunk";

      // Enrich event with game_id if not present; exclude type from payload
      const { type: _type, ...enrichedEvent } = {
        ...event,
        game_id: event.game_id || game_id,
      };

      // Forward to SSE
      sseStreamManager.sendEvent(sessionId, eventType, enrichedEvent);

      // Cache frame and score metadata for UI reuse
      const existing = this.pending.get(sessionId);
      if (existing) {
        const updates: Partial<PuzzleEnvStreamPayload> = {};
        if (eventType === "game.frame_update" && enrichedEvent.frameData) {
          updates.lastFrameData = enrichedEvent.frameData;
          if (enrichedEvent.frameData.score !== undefined) {
            updates.lastScore = enrichedEvent.frameData.score;
          }
        }
        if (Object.keys(updates).length > 0) {
          const merged = { ...existing, ...updates };
          this.pending.set(sessionId, merged);
        }
      }

      // Handle completion
      if (eventType === "agent.completed") {
        sseStreamManager.close(sessionId, enrichedEvent);
      }

      // Handle errors
      if (eventType === "stream.error") {
        sseStreamManager.error(
          sessionId,
          enrichedEvent.code || "RUNNER_ERROR",
          enrichedEvent.error || "Unknown error",
        );
      }
    } catch (parseError) {
      // JSON parse failed — emit as status
      logger.warn(
        `[PuzzleEnv] Failed to parse NDJSON: ${line.slice(0, 100)}`,
        "puzzle-env",
      );
      sseStreamManager.sendEvent(sessionId, "stream.status", {
        state: "running",
        message: line,
        game_id,
      });
    }
  }

  /**
   * Cancel an active streaming session.
   */
  cancel(sessionId: string): void {
    if (sseStreamManager.has(sessionId)) {
      sseStreamManager.teardown(sessionId, "cancelled");
    }
    this.clear(sessionId);
    logger.info(`[PuzzleEnv] Session ${sessionId} cancelled`, "puzzle-env");
  }
}

export const puzzleEnvStreamService = new PuzzleEnvStreamService();
