

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sseStreamManager } from "../services/streaming/SSEStreamManager.ts";
import { puzzleEnvStreamService } from "../services/arc3/PuzzleEnvStreamService.ts";
import { puzzleEnvPythonBridge } from "../services/arc3/PuzzleEnvPythonBridge.ts";
import { logger } from "../utils/logger.ts";

const router = Router();

// Validation schema for stream prepare request
const prepareSchema = z.object({
  game_id: z.string().min(1, "game_id is required"),
  model_key: z.string().min(1, "model_key is required"), // Eval harness registry key
  maxTurns: z.number().int().min(1).max(500).optional().default(200),
  systemPrompt: z.string().optional(), // Override system prompt
  seed: z.number().int().min(0).optional().default(0),
  contextWindow: z.number().int().min(1).max(200).optional().default(50),
  withImages: z.boolean().optional().default(false),
  agentName: z.string().optional(), // Display name for agent
});

// Helper for consistent response format
const formatResponse = {
  success: <T>(data: T) => ({ success: true, data }),
  error: (code: string, message: string) => ({
    success: false,
    error: { code, message },
  }),
};

// Async handler wrapper
const asyncHandler = (fn: (req: Request, res: Response) => Promise<any>) => {
  return (req: Request, res: Response, next: any) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
};

/**
 * GET /games
 * List all available puzzle-environments games (ARC-AGI-3 + ARC-AGI-2).
 * Spawns a lightweight Python subprocess to run discover_games().
 */
router.get(
  "/games",
  asyncHandler(async (_req: Request, res: Response) => {
    logger.info("[PuzzleEnv] Listing games", "puzzle-env");

    try {
      const result = await spawnCommandRunner({ command: "list_games" });
      if (result.error) {
        return res
          .status(500)
          .json(formatResponse.error("LIST_GAMES_ERROR", result.error));
      }
      res.json(formatResponse.success(result.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[PuzzleEnv] Failed to list games: ${message}`,
        "puzzle-env",
      );
      res.status(500).json(formatResponse.error("LIST_GAMES_ERROR", message));
    }
  }),
);

/**
 * GET /models
 * List all available eval harness model keys (from MODEL_REGISTRY).
 * Spawns a lightweight Python subprocess to read the registry.
 */
router.get(
  "/models",
  asyncHandler(async (_req: Request, res: Response) => {
    logger.info("[PuzzleEnv] Listing models", "puzzle-env");

    try {
      const result = await spawnCommandRunner({ command: "list_models" });
      if (result.error) {
        return res
          .status(500)
          .json(formatResponse.error("LIST_MODELS_ERROR", result.error));
      }
      res.json(formatResponse.success(result.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[PuzzleEnv] Failed to list models: ${message}`,
        "puzzle-env",
      );
      res.status(500).json(formatResponse.error("LIST_MODELS_ERROR", message));
    }
  }),
);

/**
 * POST /stream/prepare
 * Prepare a streaming session, returns sessionId for SSE connection.
 */
router.post(
  "/stream/prepare",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = prepareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json(
          formatResponse.error(
            "VALIDATION_ERROR",
            parsed.error.errors.map((e) => e.message).join("; "),
          ),
        );
    }

    const payload = parsed.data;
    logger.info(
      `[PuzzleEnv] Preparing session for game=${payload.game_id}, model=${payload.model_key}`,
      "puzzle-env",
    );

    const sessionId = puzzleEnvStreamService.savePayload(payload);
    res.json(formatResponse.success({ sessionId }));
  }),
);

/**
 * GET /stream/:sessionId
 * Start SSE streaming for a prepared session.
 */
router.get(
  "/stream/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    const payload = puzzleEnvStreamService.getPayload(sessionId);
    if (!payload) {
      return res
        .status(404)
        .json(
          formatResponse.error(
            "SESSION_NOT_FOUND",
            `Session ${sessionId} not found or expired`,
          ),
        );
    }

    logger.info(
      `[PuzzleEnv] Starting streaming for session=${sessionId}, game=${payload.game_id}, model=${payload.model_key}`,
      "puzzle-env",
    );

    // Register SSE connection
    sseStreamManager.register(sessionId, res);

    // Start streaming (non-blocking, events flow via SSE)
    await puzzleEnvStreamService.startStreaming(req, { ...payload, sessionId });
  }),
);

/**
 * POST /stream/cancel/:sessionId
 * Cancel an active streaming session.
 */
router.post(
  "/stream/cancel/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    logger.info(`[PuzzleEnv] Cancelling session=${sessionId}`, "puzzle-env");

    puzzleEnvStreamService.cancel(sessionId);
    res.json(formatResponse.success({ cancelled: true, sessionId }));
  }),
);

/**
 * GET /health
 * Health check endpoint for puzzle-environments runner.
 */
router.get(
  "/health",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(
      formatResponse.success({
        status: "healthy",
        provider: "puzzle-env",
        timestamp: Date.now(),
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Internal helper: spawn Python runner for meta-commands (list_games, list_models)
// ---------------------------------------------------------------------------

interface CommandResult {
  data?: any;
  error?: string;
}

/**
 * Spawn a short-lived Python runner for meta-commands (list_games, list_models).
 * These are quick, non-streaming operations that return a single NDJSON event.
 */
async function spawnCommandRunner(payload: {
  command: string;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let resultData: any = null;
    let errorMessage: string | null = null;

    puzzleEnvPythonBridge
      .spawnAgent(
        payload as any,
        { timeoutMs: 30 * 1000 }, // 30 seconds for listing
        (line: string) => {
          try {
            const event = JSON.parse(line);
            if (event.type === "games.list" || event.type === "models.list") {
              const { type: _type, ...payload } = event;
              resultData = payload;
            }
            if (event.type === "stream.error") {
              errorMessage = event.error || "Unknown error";
            }
          } catch {
            // Ignore non-JSON lines
          }
        },
        (line: string) => {
          logger.debug(`[PuzzleEnv] command stderr: ${line}`, "puzzle-env");
        },
      )
      .then(({ code }) => {
        if (errorMessage) {
          resolve({ error: errorMessage });
        } else if (resultData) {
          resolve({ data: resultData });
        } else {
          resolve({
            error: `Python runner exited with code ${code} and no data`,
          });
        }
      })
      .catch((err) => {
        resolve({ error: err instanceof Error ? err.message : String(err) });
      });
  });
}

export default router;
