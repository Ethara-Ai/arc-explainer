

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  agentSdkStreamService,
  type AgentSdkStreamPayload,
} from "../services/arc3/agentSdk/AgentSdkStreamService";
import { getRegisteredModels } from "../services/arc3/agentSdk/providerRegistry";
import { sseStreamManager } from "../services/streaming/SSEStreamManager";
import { formatResponse } from "../utils/responseFormatter";
import { logger } from "../utils/logger";
import { getAvailableGames } from "../services/arc3/shared/gameDiscovery";
import {
  validateDryRun,
  type DryRunRequest,
} from "../services/arc3/shared/dryRunValidator";
import {
  getResumableSessions,
  dismissSession,
} from "../services/arc3/shared/resumeDetector";

const router = Router();

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const streamRunSchema = z.object({
  game_id: z.string().trim().max(120).default("ls20"),
  agentName: z.string().trim().max(60).optional(),
  systemPrompt: z.string().trim().optional(),
  instructions: z
    .string({ required_error: "instructions is required" })
    .trim()
    .min(1, "instructions must not be empty"),
  model: z.string().trim().max(120).optional(),
  maxTurns: z.coerce.number().int().min(2).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  systemPromptPresetId: z.enum(["twitch", "playbook", "none"]).optional(),
  skipDefaultSystemPrompt: z.boolean().optional(),
});

const frameSeedSchema = z.object({
  guid: z.string().trim().min(1).max(200),
  game_id: z.string().trim().min(1).max(200),
  frame: z
    .array(z.array(z.array(z.number().int().min(0).max(15)).max(64)).max(64))
    .min(1)
    .max(10),
  score: z.number().int().min(0),
  state: z.enum([
    "NOT_PLAYED",
    "NOT_STARTED",
    "IN_PROGRESS",
    "WIN",
    "GAME_OVER",
  ]),
  action_counter: z.number().int().min(0).optional(),
  max_actions: z.number().int().min(0).optional(),
  win_score: z.number().int().min(0).optional(),
  full_reset: z.boolean().optional(),
  available_actions: z
    .array(z.union([z.string(), z.number()]))
    .max(20)
    .optional(),
});

const continueSessionSchema = z.object({
  userMessage: z.string().trim().min(1, "userMessage must not be empty"),
  previousResponseId: z.string().trim().min(1).optional(),
  existingGameGuid: z.string().optional(),
  lastFrame: frameSeedSchema.optional(),
});

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

/**
 * GET /api/arc3-agentsdk/models
 * Return available models from the provider registry
 */
router.get(
  "/models",
  asyncHandler(async (_req: Request, res: Response) => {
    const models = getRegisteredModels();
    logger.info(
      `[AgentSdk Route] Returning ${models.length} registered AgentSDK models`,
      "arc3-agentsdk-route",
    );
    res.json(formatResponse.success(models));
  }),
);

/**
 * POST /api/arc3-agentsdk/stream/prepare
 * Validate + store pending session -> sessionId
 */
router.post(
  "/stream/prepare",
  asyncHandler(async (req: Request, res: Response) => {
    const payload = streamRunSchema.parse(req.body);
    logger.info(
      `[AgentSdk Route] Preparing stream: game=${payload.game_id}, model=${payload.model ?? "claude-opus-4-6"}, ` +
        `maxTurns=${payload.maxTurns ?? "(default)"}, preset=${payload.systemPromptPresetId ?? "(default)"}`,
      "arc3-agentsdk-route",
    );
    const sessionId = agentSdkStreamService.savePendingPayload(
      payload as AgentSdkStreamPayload,
    );
    res.json(formatResponse.success({ sessionId }));
  }),
);

/**
 * GET /api/arc3-agentsdk/stream/:sessionId
 * Register SSE + start streaming
 */
router.get(
  "/stream/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    logger.info(
      `[AgentSdk Route] Opening SSE stream for session ${sessionId}`,
      "arc3-agentsdk-route",
    );
    const payload = agentSdkStreamService.getPendingPayload(sessionId);

    if (!payload) {
      return res
        .status(404)
        .json(
          formatResponse.error(
            "SESSION_NOT_FOUND",
            "Session not found or expired",
          ),
        );
    }

    // Register SSE connection
    sseStreamManager.register(sessionId, res);

    // Start streaming
    await agentSdkStreamService.startStreaming(req, {
      ...payload,
      sessionId,
    });
  }),
);

/**
 * POST /api/arc3-agentsdk/stream/cancel/:sessionId
 * Cancel active session
 */
router.post(
  "/stream/cancel/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    logger.warn(
      `[AgentSdk Route] Cancel request for session ${sessionId}`,
      "arc3-agentsdk-route",
    );
    agentSdkStreamService.cancelSession(sessionId);
    res.json(formatResponse.success({ cancelled: true }));
  }),
);

/**
 * POST /api/arc3-agentsdk/stream/:sessionId/continue
 * Prepare a continuation session (only for models that support previousResponseId)
 */
router.post(
  "/stream/:sessionId/continue",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { userMessage, previousResponseId, existingGameGuid, lastFrame } =
      continueSessionSchema.parse(req.body);

    logger.info(
      `[AgentSdk Continue] Preparing continuation with sessionId=${sessionId}, hasResponseId=${!!previousResponseId}, existingGameGuid=${existingGameGuid}`,
      "arc3-agentsdk",
    );

    const payload = agentSdkStreamService.getPendingPayload(sessionId);
    if (!payload) {
      return res
        .status(404)
        .json(
          formatResponse.error(
            "SESSION_NOT_FOUND",
            "Session not found or expired",
          ),
        );
    }

    const effectivePreviousResponseId =
      previousResponseId || payload.providerResponseId;
    if (!effectivePreviousResponseId) {
      return res
        .status(400)
        .json(
          formatResponse.error(
            "MISSING_PREVIOUS_RESPONSE_ID",
            "previousResponseId is required to chain Responses API runs. This model may not support continuation.",
          ),
        );
    }

    const cachedFrame = payload.lastFrame;
    const clientFrame = lastFrame
      ? {
          guid: lastFrame.guid,
          game_id: lastFrame.game_id,
          frame: lastFrame.frame,
          score: lastFrame.score,
          state: lastFrame.state,
          action_counter: lastFrame.action_counter,
          max_actions: lastFrame.max_actions,
          win_score: lastFrame.win_score,
          full_reset: lastFrame.full_reset,
          available_actions: lastFrame.available_actions as
            | string[]
            | undefined,
        }
      : undefined;

    const clientComplete = Boolean(
      clientFrame &&
      clientFrame.action_counter !== undefined &&
      clientFrame.max_actions !== undefined &&
      clientFrame.win_score !== undefined,
    );

    if (clientFrame && !clientComplete && cachedFrame) {
      logger.warn(
        `[AgentSdk Continue] Ignoring incomplete client frame, using cached frame for session ${sessionId}`,
        "arc3-agentsdk",
      );
    }

    const normalizedLastFrame = clientComplete
      ? (clientFrame as unknown as import("../services/arc3/Arc3ApiClient").FrameData)
      : cachedFrame;

    let continuationGameGuid = existingGameGuid;
    if (
      existingGameGuid &&
      (!normalizedLastFrame ||
        normalizedLastFrame.action_counter === undefined ||
        normalizedLastFrame.max_actions === undefined)
    ) {
      logger.warn(
        `[AgentSdk Continue] Missing usable seed frame; falling back to fresh session for session ${sessionId}`,
        "arc3-agentsdk",
      );
      continuationGameGuid = undefined;
    }

    agentSdkStreamService.saveContinuationPayload(sessionId, payload, {
      userMessage,
      previousResponseId: effectivePreviousResponseId as string,
      existingGameGuid: continuationGameGuid,
      lastFrame: normalizedLastFrame,
    });

    res.json(formatResponse.success({ sessionId, ready: true }));
  }),
);

/**
 * GET /api/arc3-agentsdk/stream/:sessionId/continue-stream
 * Start SSE streaming for a prepared continuation session
 */
router.get(
  "/stream/:sessionId/continue-stream",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const continuationPayload =
      agentSdkStreamService.getContinuationPayload(sessionId);

    if (!continuationPayload) {
      return res
        .status(404)
        .json(
          formatResponse.error(
            "SESSION_NOT_FOUND",
            "Continuation session not found or expired",
          ),
        );
    }

    sseStreamManager.register(sessionId, res);

    await agentSdkStreamService.continueStreaming(req, continuationPayload);
  }),
);

/* ------------------------------------------------------------------ */
/*  Game Discovery                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET /api/arc3-agentsdk/games
 * Return available ARC-AGI-3 games from puzzle-environments
 */
router.get(
  "/games",
  asyncHandler(async (_req: Request, res: Response) => {
    const games = getAvailableGames();
    const simplified = games.map((g) => ({
      gameId: g.gameId,
      title: g.metadata.title ?? g.gameId,
      tags: g.metadata.tags ?? [],
      baselineActions: g.metadata.baseline_actions ?? [],
    }));
    res.json(formatResponse.success(simplified));
  }),
);

/* ------------------------------------------------------------------ */
/*  Dry Run                                                             */
/* ------------------------------------------------------------------ */

const dryRunSchema = z.object({
  models: z.array(z.string().trim().min(1)).min(1),
  games: z.array(z.string().trim().min(1)).min(1),
  runsPerGame: z.coerce.number().int().min(1).max(50).default(1),
  maxSteps: z.coerce.number().int().min(1).max(500).default(50),
});

/**
 * POST /api/arc3-agentsdk/dry-run
 * Validate config without making LLM calls. Returns cost estimates.
 */
router.post(
  "/dry-run",
  asyncHandler(async (req: Request, res: Response) => {
    const request = dryRunSchema.parse(req.body) as DryRunRequest;
    const report = validateDryRun(request);
    const statusCode = report.valid ? 200 : 422;
    res.status(statusCode).json(formatResponse.success(report));
  }),
);

/* ------------------------------------------------------------------ */
/*  Resume / Interrupted Sessions                                       */
/* ------------------------------------------------------------------ */

/**
 * GET /api/arc3-agentsdk/sessions/interrupted
 * List sessions that were interrupted and can be resumed
 */
router.get(
  "/sessions/interrupted",
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = await getResumableSessions();
    res.json(formatResponse.success(sessions));
  }),
);

/**
 * POST /api/arc3-agentsdk/sessions/:sessionId/dismiss
 * Mark an interrupted session as no longer resumable
 */
router.post(
  "/sessions/:sessionId/dismiss",
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    await dismissSession(sessionId);
    res.json(formatResponse.success({ dismissed: true }));
  }),
);

export default router;
