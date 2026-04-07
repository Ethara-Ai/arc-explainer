import type { Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";
import { evalService } from "../services/evalService";
import { logger } from "../utils/logger";
import { formatResponse } from "../utils/responseFormatter";
import { JsonlWriter, readTrace } from "../services/eval/data/traceWriter";
import { DEFAULT_OUTPUT_DIR } from "@shared/config/llmConfig";

export const evalController = {
  /**
   * POST /api/eval/start
   * Body: { gameIds: string[], modelKeys: string[], numRuns?, maxSteps?, seedBase?, contextWindow?, withImages? }
   */
  async startEval(req: Request, res: Response) {
    try {
      const {
        gameIds,
        modelKeys,
        numRuns,
        maxSteps,
        seedBase,
        contextWindow,
        withImages,
        parallelGames,
        parallelRuns,
        sequentialModels,
        budgetGlobalUsd,
        budgetPerGameUsd,
      } = req.body;

      if (!gameIds || !Array.isArray(gameIds) || gameIds.length === 0) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "gameIds must be a non-empty array",
            ),
          );
      }
      if (!modelKeys || !Array.isArray(modelKeys) || modelKeys.length === 0) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "modelKeys must be a non-empty array",
            ),
          );
      }

      // Validate optional orchestrator overrides
      if (
        parallelGames != null &&
        (!Number.isInteger(parallelGames) ||
          parallelGames < 1 ||
          parallelGames > 20)
      ) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "parallelGames must be an integer 1-20",
            ),
          );
      }
      if (
        parallelRuns != null &&
        (!Number.isInteger(parallelRuns) ||
          parallelRuns < 1 ||
          parallelRuns > 10)
      ) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "parallelRuns must be an integer 1-10",
            ),
          );
      }
      if (sequentialModels != null && typeof sequentialModels !== "boolean") {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "sequentialModels must be a boolean",
            ),
          );
      }
      if (
        budgetGlobalUsd != null &&
        (typeof budgetGlobalUsd !== "number" || budgetGlobalUsd <= 0)
      ) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "budgetGlobalUsd must be a positive number",
            ),
          );
      }
      if (
        budgetPerGameUsd != null &&
        (typeof budgetPerGameUsd !== "number" || budgetPerGameUsd <= 0)
      ) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "budgetPerGameUsd must be a positive number",
            ),
          );
      }

      const sessionId = await evalService.startEval(
        {
          gameIds,
          modelKeys,
          numRuns: numRuns ?? undefined,
          maxSteps: maxSteps ?? undefined,
          seedBase: seedBase ?? undefined,
          contextWindow: contextWindow ?? undefined,
          withImages: withImages ?? undefined,
        },
        undefined,
        {
          parallelGames: parallelGames ?? undefined,
          parallelRuns: parallelRuns ?? undefined,
          sequentialModels: sequentialModels ?? undefined,
          budgetGlobalUsd: budgetGlobalUsd ?? undefined,
          budgetPerGameUsd: budgetPerGameUsd ?? undefined,
        },
      );

      return res.json(
        formatResponse.success({ sessionId }, "Eval session started"),
      );
    } catch (error: any) {
      const msg = error?.message || "Failed to start eval session";
      logger.error(`[EvalController] Failed to start eval: ${msg}`, "eval");

      // Return validation / config errors as 400, not 500
      if (
        msg.includes("validation failed") ||
        msg.includes("Config validation")
      ) {
        return res
          .status(400)
          .json(formatResponse.error("VALIDATION_ERROR", msg));
      }
      return res.status(500).json(formatResponse.error("INTERNAL_ERROR", msg));
    }
  },

  /**
   * GET /api/eval/stream/:id
   * SSE stream for eval progress events. Client connects and receives
   * eval.* events until session completes or client disconnects.
   */
  async streamEval(req: Request, res: Response) {
    try {
      const sessionId = req.params.id;
      if (!sessionId) {
        return res
          .status(400)
          .json(
            formatResponse.error("VALIDATION_ERROR", "Session ID required"),
          );
      }

      // Always allow SSE connection — the SSEStreamManager buffers events
      // and replays them when the client connects. This avoids race conditions
      // where the eval completes before the client's EventSource connects.
      logger.info(
        `[EvalController] streamEval: registering SSE for session=${sessionId}`,
        "eval",
      );
      evalService.registerStream(sessionId, res);
    } catch (error) {
      logger.error(
        `[EvalController] Failed to setup SSE stream: ${error}`,
        "eval",
      );
      // Guard: if SSE headers already sent, we can't send JSON — just end the response
      if (res.headersSent) {
        try {
          res.end();
        } catch {}
        return;
      }
      return res
        .status(500)
        .json(formatResponse.error("INTERNAL_ERROR", "Failed to setup stream"));
    }
  },

  /**
   * GET /api/eval/sessions
   * Query params: limit?, offset?
   */
  async listSessions(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const sessions = await evalService.listSessionsFromDb(limit, offset);
      const activeSessions = evalService.getActiveSessions();

      return res.json(
        formatResponse.success(
          {
            sessions,
            activeSessions,
          },
          "Sessions retrieved",
        ),
      );
    } catch (error) {
      logger.error(
        `[EvalController] Failed to list sessions: ${error}`,
        "eval",
      );
      return res
        .status(500)
        .json(
          formatResponse.error("INTERNAL_ERROR", "Failed to list sessions"),
        );
    }
  },

  /**
   * GET /api/eval/runs
   * Query params: sessionId?, limit?, offset?
   */
  async listRuns(req: Request, res: Response) {
    try {
      const sessionId = req.query.sessionId as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const runs = await evalService.getRuns(sessionId, limit, offset);
      return res.json(formatResponse.success({ runs }, "Runs retrieved"));
    } catch (error) {
      logger.error(`[EvalController] Failed to list runs: ${error}`, "eval");
      return res
        .status(500)
        .json(formatResponse.error("INTERNAL_ERROR", "Failed to list runs"));
    }
  },

  /**
   * GET /api/eval/runs/:id/steps
   */
  async getRunSteps(req: Request, res: Response) {
    try {
      const runId = req.params.id;
      if (!runId) {
        return res
          .status(400)
          .json(formatResponse.error("VALIDATION_ERROR", "Run ID required"));
      }

      const steps = await evalService.getRunSteps(runId);
      return res.json(formatResponse.success({ steps }, "Steps retrieved"));
    } catch (error) {
      logger.error(
        `[EvalController] Failed to get run steps: ${error}`,
        "eval",
      );
      return res
        .status(500)
        .json(
          formatResponse.error("INTERNAL_ERROR", "Failed to get run steps"),
        );
    }
  },

  /**
   * POST /api/eval/cancel/:id
   */
  async cancelEval(req: Request, res: Response) {
    try {
      const sessionId = req.params.id;
      if (!sessionId) {
        return res
          .status(400)
          .json(
            formatResponse.error("VALIDATION_ERROR", "Session ID required"),
          );
      }

      const cancelled = await evalService.cancelEval(sessionId);
      if (!cancelled) {
        return res
          .status(404)
          .json(
            formatResponse.error(
              "NOT_FOUND",
              "Session not active or not found",
            ),
          );
      }

      return res.json(
        formatResponse.success({ success: true }, "Eval session cancelled"),
      );
    } catch (error) {
      logger.error(`[EvalController] Failed to cancel eval: ${error}`, "eval");
      return res
        .status(500)
        .json(formatResponse.error("INTERNAL_ERROR", "Failed to cancel eval"));
    }
  },

  /**
   * GET /api/eval/games
   */
  async listGames(_req: Request, res: Response) {
    try {
      const games = evalService.listGames();
      return res.json(formatResponse.success({ games }, "Games retrieved"));
    } catch (error) {
      logger.error(`[EvalController] Failed to list games: ${error}`, "eval");
      return res
        .status(500)
        .json(formatResponse.error("INTERNAL_ERROR", "Failed to list games"));
    }
  },

  /**
   * GET /api/eval/models
   */
  async listModels(_req: Request, res: Response) {
    try {
      const models = evalService.listModels();
      return res.json(formatResponse.success({ models }, "Models retrieved"));
    } catch (error) {
      logger.error(`[EvalController] Failed to list models: ${error}`, "eval");
      return res
        .status(500)
        .json(formatResponse.error("INTERNAL_ERROR", "Failed to list models"));
    }
  },

  /**
   * GET /api/eval/file-sessions
   */
  async listFileSessions(_req: Request, res: Response) {
    try {
      const baseDir = DEFAULT_OUTPUT_DIR;

      let sessionDirs: string[];
      try {
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        sessionDirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
          .reverse();
      } catch {
        return res.json(
          formatResponse.success({ sessions: [] }, "No eval data found"),
        );
      }

      const sessions = [];

      for (const dir of sessionDirs) {
        const sessionPath = path.join(baseDir, dir);
        // Non-game directories to skip when scanning session contents
        const RESERVED_DIRS = new Set(["logs", "cancel"]);

        let gameEntries: string[];
        try {
          const entries = await fs.readdir(sessionPath, {
            withFileTypes: true,
          });
          gameEntries = entries
            .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name))
            .map((e) => e.name);
        } catch {
          continue;
        }

        const games = [];

        for (const gameId of gameEntries) {
          const gamePath = path.join(sessionPath, gameId);

          // ── Collect runs: new format (per-model subdirs) then old format (game-level) ──
          let rawRuns: Record<string, unknown>[] = [];

          // New format: scan model subdirectories for runs.jsonl
          try {
            const gameSubEntries = await fs.readdir(gamePath, {
              withFileTypes: true,
            });
            const modelDirs = gameSubEntries
              .filter(
                (e) =>
                  e.isDirectory() &&
                  e.name !== "traces" &&
                  !e.name.startsWith("."),
              )
              .map((e) => e.name);

            for (const modelDirName of modelDirs) {
              const modelRunsPath = path.join(
                gamePath,
                modelDirName,
                "runs.jsonl",
              );
              const modelRunsWriter = new JsonlWriter(modelRunsPath);
              const modelRuns = await modelRunsWriter.read();
              rawRuns = [...rawRuns, ...modelRuns];
            }
          } catch {
            // game dir unreadable — fall through to old format
          }

          // Old format fallback: game-level runs.jsonl
          if (rawRuns.length === 0) {
            const legacyRunsWriter = new JsonlWriter(
              path.join(gamePath, "runs.jsonl"),
            );
            rawRuns = await legacyRunsWriter.read();
          }

          const tracesDir = path.join(gamePath, "traces");
          let traceFiles: string[] = [];
          try {
            const tEntries = await fs.readdir(tracesDir);
            traceFiles = tEntries.filter((f) => f.endsWith("_trace.jsonl"));
          } catch {
            // traces dir may not exist
          }

          const runsWithSummary = [...rawRuns];
          for (const traceFile of traceFiles) {
            try {
              const records = await readTrace(path.join(tracesDir, traceFile));
              const summary = records.find((r) => r.type === "summary");
              if (summary) {
                const s = summary as unknown as Record<string, unknown>;
                const matchIdx = runsWithSummary.findIndex(
                  (r) => r.model === s.model && r.runNumber === s.runNumber,
                );
                if (matchIdx >= 0) {
                  runsWithSummary[matchIdx] = {
                    ...runsWithSummary[matchIdx],
                    ...s,
                  };
                } else {
                  runsWithSummary.push(s);
                }
              }
            } catch {
              // unreadable trace file
            }
          }

          games.push({
            gameId,
            runs: runsWithSummary,
            traceFiles,
          });
        }

        sessions.push({
          dir,
          timestamp: dir,
          games,
        });
      }

      return res.json(
        formatResponse.success({ sessions }, "File sessions retrieved"),
      );
    } catch (error) {
      logger.error(
        `[EvalController] Failed to list file sessions: ${error}`,
        "eval",
      );
      return res
        .status(500)
        .json(
          formatResponse.error(
            "INTERNAL_ERROR",
            "Failed to list file sessions",
          ),
        );
    }
  },

  /**
   * GET /api/eval/file-trace — query params: dir, gameId, model, run
   */
  async getFileTrace(req: Request, res: Response) {
    try {
      const { dir, gameId, model, run } = req.query;

      if (!dir || !gameId || !model || run === undefined) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "Required query params: dir, gameId, model, run",
            ),
          );
      }

      const dirStr = String(dir);
      const gameIdStr = String(gameId);
      const modelStr = String(model);
      const runNum = parseInt(String(run), 10);

      // Security: only allow safe characters to prevent directory traversal
      const safePattern = /^[a-zA-Z0-9._\-:]+$/;
      if (
        !safePattern.test(dirStr) ||
        !safePattern.test(gameIdStr) ||
        !safePattern.test(modelStr)
      ) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "Invalid characters in query params",
            ),
          );
      }
      if (isNaN(runNum) || runNum < 0) {
        return res
          .status(400)
          .json(
            formatResponse.error(
              "VALIDATION_ERROR",
              "run must be a non-negative integer",
            ),
          );
      }

      const safeModel = modelStr.replace(/[^a-zA-Z0-9._-]/g, "_");
      const tracePath = path.join(
        DEFAULT_OUTPUT_DIR,
        dirStr,
        gameIdStr,
        "traces",
        `${safeModel}_run${runNum}_trace.jsonl`,
      );

      // Security: verify resolved path stays within output directory
      const resolved = path.resolve(tracePath);
      if (!resolved.startsWith(path.resolve(DEFAULT_OUTPUT_DIR))) {
        return res
          .status(400)
          .json(
            formatResponse.error("VALIDATION_ERROR", "Path traversal detected"),
          );
      }

      const records = await readTrace(tracePath);
      return res.json(
        formatResponse.success({ records, tracePath }, "Trace loaded"),
      );
    } catch (error) {
      logger.error(
        `[EvalController] Failed to read file trace: ${error}`,
        "eval",
      );
      return res
        .status(500)
        .json(
          formatResponse.error("INTERNAL_ERROR", "Failed to read trace file"),
        );
    }
  },
};
