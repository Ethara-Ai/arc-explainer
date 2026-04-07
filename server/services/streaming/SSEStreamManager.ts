/**
 *
 * Author: Codex using GPT-5-high
 * Date: 2026-03-08
 * PURPOSE: Manages Server-Sent Event connections for analysis streaming, providing
 *          registration, heartbeats, event emission, replay buffering, and cleanup
 *          across multiple sessions. Buffers events when no client is connected and
 *          replays them on connection (solves POST-then-SSE race condition).
 * SRP/DRY check: Pass — no existing SSE session registry.
 * shadcn/ui: Pass — backend infrastructure only.
 */

import type { Response } from "express";
import { logger } from "../../utils/logger";
import type { StreamCompletion } from "../base/BaseAIService";

export interface SSEStreamConnection {
  sessionId: string;
  response: Response;
  createdAt: number;
  heartbeat?: NodeJS.Timeout;
  closed: boolean;
}

class SSEStreamManager {
  private connections: Map<string, SSEStreamConnection> = new Map();
  // Buffer events per session when no client is connected yet
  private eventBuffers: Map<string, Array<{ event: string; data: string }>> =
    new Map();
  private streams: Map<
    string,
    {
      onConnect?: (clientId: string) => void;
      onDisconnect?: (clientId: string) => void;
    }
  > = new Map();
  private readonly heartbeatIntervalMs = 15000;

  register(sessionId: string, res: Response): SSEStreamConnection {
    logger.debug(
      `[SSEStreamManager] register called: sessionId=${sessionId}`,
      "sse-manager",
    );
    const existing = this.connections.get(sessionId);
    if (existing) {
      logger.debug(
        `[SSEStreamManager] Existing connection found for ${sessionId}, tearing down`,
        "sse-manager",
      );
      this.teardown(sessionId, "duplicate-session");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const connection: SSEStreamConnection = {
      sessionId,
      response: res,
      createdAt: Date.now(),
      closed: false,
    };

    connection.heartbeat = setInterval(() => {
      this.sendComment(sessionId, "keep-alive");
    }, this.heartbeatIntervalMs);

    res.on("close", () => {
      logger.debug(
        `[SSEStreamManager] Client closed connection for ${sessionId}`,
        "sse-manager",
      );
      this.teardown(sessionId, "client-disconnect");
    });

    this.connections.set(sessionId, connection);
    logger.info(
      `[SSEStreamManager] Registered connection for ${sessionId}. Total connections: ${this.connections.size}`,
      "sse-manager",
    );

    // Replay any buffered events that arrived before the client connected
    const buffered = this.eventBuffers.get(sessionId);
    if (buffered && buffered.length > 0) {
      logger.info(
        `[SSEStreamManager] REPLAYING ${buffered.length} buffered event(s) for ${sessionId}: [${buffered.map((e) => e.event).join(", ")}]`,
        "sse-manager",
      );
      for (const evt of buffered) {
        try {
          connection.response.write(`event: ${evt.event}\n`);
          connection.response.write(`data: ${evt.data}\n\n`);
        } catch (err) {
          logger.warn(
            `[SSEStreamManager] REPLAY WRITE FAILED for ${sessionId}: ${err}`,
            "sse-manager",
          );
          break;
        }
      }
      this.eventBuffers.delete(sessionId);
    } else {
      logger.info(
        `[SSEStreamManager] No buffered events for ${sessionId} at registration time`,
        "sse-manager",
      );
    }

    // Trigger stream connection callback if registered
    const streamConfig = this.streams.get(sessionId);
    if (streamConfig?.onConnect) {
      streamConfig.onConnect(sessionId);
    }

    return connection;
  }

  createStream(
    streamKey: string,
    config: {
      onConnect?: (clientId: string) => void;
      onDisconnect?: (clientId: string) => void;
    },
  ): void {
    this.streams.set(streamKey, config);
  }

  closeStream(streamKey: string): void {
    this.streams.delete(streamKey);
  }

  sendEvent<T>(sessionId: string, event: string, payload: T): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.closed) {
      // Buffer the event so it can be replayed when the client connects
      const serialized = JSON.stringify(payload ?? {});
      if (!this.eventBuffers.has(sessionId)) {
        this.eventBuffers.set(sessionId, []);
      }
      const buf = this.eventBuffers.get(sessionId)!;
      buf.push({ event, data: serialized });
      logger.info(
        `[SSEStreamManager] BUFFERED event ${event} for ${sessionId} (buffer size: ${buf.length})`,
        "sse-manager",
      );
      return;
    }

    try {
      const serialized = JSON.stringify(payload ?? {});
      logger.info(
        `[SSEStreamManager] SENDING event ${event} to ${sessionId} (dataLen=${serialized.length})`,
        "sse-manager",
      );
      connection.response.write(`event: ${event}\n`);
      connection.response.write(`data: ${serialized}\n\n`);
    } catch (error) {
      logger.warn(
        `[SSEStreamManager] WRITE FAILED for event ${event} to ${sessionId}: ${error}`,
        "sse-manager",
      );
    }
  }

  sendChunk(sessionId: string, chunk: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.closed) {
      // Silently ignore - this is normal when async operations complete after stream ends
      return;
    }
    try {
      connection.response.write(
        chunk.endsWith("\n\n") ? chunk : `${chunk}\n\n`,
      );
    } catch (error) {
      // Connection may have closed between the check and write - this is fine
      logger.debug(
        `Failed to send chunk to ${sessionId}: ${error}`,
        "sse-manager",
      );
    }
  }

  sendComment(sessionId: string, comment: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.closed) return;
    connection.response.write(`: ${comment}\n\n`);
  }

  teardown(sessionId: string, reason: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;

    // Trigger stream disconnection callback if registered
    const streamConfig = this.streams.get(sessionId);
    if (streamConfig?.onDisconnect) {
      streamConfig.onDisconnect(sessionId);
    }

    if (connection.heartbeat) {
      clearInterval(connection.heartbeat);
    }

    if (!connection.closed) {
      try {
        connection.response.write(`event: stream.end\n`);
        connection.response.write(`data: ${JSON.stringify({ reason })}\n\n`);
        connection.response.end();
      } catch (error) {
        logger.debug(
          `Failed to finalize SSE session ${sessionId}: ${error}`,
          "sse-manager",
        );
      }
    }

    connection.closed = true;
    this.connections.delete(sessionId);
    this.eventBuffers.delete(sessionId);
  }

  close(
    sessionId: string,
    summary?: Record<string, unknown> | StreamCompletion,
  ): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    if (summary) {
      this.sendEvent(sessionId, "stream.complete", { ...summary });
    }
    this.teardown(sessionId, "completed");
  }

  error(
    sessionId: string,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.closed) {
      // Session already closed - log for debugging but don't warn
      logger.debug(
        `Attempted to send error to closed session ${sessionId}: ${code}`,
        "sse-manager",
      );
      return;
    }
    this.sendEvent(sessionId, "stream.error", {
      code,
      message,
      ...(details ?? {}),
    });
    this.teardown(sessionId, code);
  }

  has(sessionId: string): boolean {
    const connection = this.connections.get(sessionId);
    return !!connection && !connection.closed;
  }

  hasBufferedEvents(sessionId: string): boolean {
    const buf = this.eventBuffers.get(sessionId);
    return !!buf && buf.length > 0;
  }
}

export const sseStreamManager = new SSEStreamManager();
