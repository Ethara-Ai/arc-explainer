import { BaseRepository } from "./base/BaseRepository";
import { logger } from "../utils/logger";
import type {
  InsertEvalSession,
  EvalSession,
  InsertEvalRun,
  EvalRun,
  InsertEvalStep,
  EvalStep,
} from "@shared/schema";

// ─── Sessions ───────────────────────────────────────────────────────────────

export class EvalRepository extends BaseRepository {
  // ── Session CRUD ──────────────────────────────────────────────────────

  async createSession(session: InsertEvalSession): Promise<EvalSession | null> {
    if (!this.isConnected()) return null;
    try {
      const result = await this.query<EvalSession>(
        `INSERT INTO eval_sessions (id, status, game_ids, model_keys, num_runs, max_steps, seed_base, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          session.id,
          session.status ?? "running",
          session.gameIds,
          session.modelKeys,
          session.numRuns,
          session.maxSteps,
          session.seedBase,
          session.startedAt ?? new Date(),
        ],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to create session ${session.id}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<EvalSession | null> {
    if (!this.isConnected()) return null;
    try {
      const result = await this.query<EvalSession>(
        `SELECT * FROM eval_sessions WHERE id = $1`,
        [sessionId],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to get session ${sessionId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async listSessions(limit = 50, offset = 0): Promise<EvalSession[]> {
    if (!this.isConnected()) return [];
    try {
      const result = await this.query<EvalSession>(
        `SELECT * FROM eval_sessions ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to list sessions: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async updateSessionStatus(
    sessionId: string,
    status: string,
    summary?: {
      totalRuns?: number;
      totalSteps?: number;
      totalCostUsd?: number;
      completedAt?: Date;
    },
  ): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const setClauses = ["status = $2"];
      const params: unknown[] = [sessionId, status];
      let idx = 3;

      if (summary?.totalRuns !== undefined) {
        setClauses.push(`total_runs = $${idx}`);
        params.push(summary.totalRuns);
        idx++;
      }
      if (summary?.totalSteps !== undefined) {
        setClauses.push(`total_steps = $${idx}`);
        params.push(summary.totalSteps);
        idx++;
      }
      if (summary?.totalCostUsd !== undefined) {
        setClauses.push(`total_cost_usd = $${idx}`);
        params.push(summary.totalCostUsd);
        idx++;
      }
      if (summary?.completedAt !== undefined) {
        setClauses.push(`completed_at = $${idx}`);
        params.push(summary.completedAt);
        idx++;
      }

      await this.query(
        `UPDATE eval_sessions SET ${setClauses.join(", ")} WHERE id = $1`,
        params,
      );
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to update session ${sessionId} status: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  // ── Run CRUD ──────────────────────────────────────────────────────────

  async createRun(run: InsertEvalRun): Promise<EvalRun | null> {
    if (!this.isConnected()) return null;
    try {
      const result = await this.query<EvalRun>(
        `INSERT INTO eval_runs (
          id, session_id, model, model_key, game_id, game_type,
          run_number, seed, max_steps, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          run.id,
          run.sessionId,
          run.model,
          run.modelKey,
          run.gameId,
          run.gameType,
          run.runNumber,
          run.seed,
          run.maxSteps ?? 200,
          new Date(),
        ],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to create run ${run.id}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async updateRun(
    runId: string,
    data: {
      totalSteps?: number;
      finalScore?: number;
      solved?: boolean;
      levelsCompleted?: number;
      totalLevels?: number;
      costUsd?: number;
      totalInputTokens?: number;
      totalOutputTokens?: number;
      totalReasoningTokens?: number;
      elapsedSeconds?: number;
      error?: string;
    },
  ): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const setClauses: string[] = [];
      const params: unknown[] = [runId];
      let idx = 2;

      const fields: Array<[string, unknown]> = [
        ["total_steps", data.totalSteps],
        ["final_score", data.finalScore],
        ["solved", data.solved],
        ["levels_completed", data.levelsCompleted],
        ["total_levels", data.totalLevels],
        ["cost_usd", data.costUsd],
        ["total_input_tokens", data.totalInputTokens],
        ["total_output_tokens", data.totalOutputTokens],
        ["total_reasoning_tokens", data.totalReasoningTokens],
        ["elapsed_seconds", data.elapsedSeconds],
        ["error", data.error],
      ];

      for (const [col, val] of fields) {
        if (val !== undefined) {
          setClauses.push(`${col} = $${idx}`);
          params.push(val);
          idx++;
        }
      }

      if (setClauses.length === 0) return;

      await this.query(
        `UPDATE eval_runs SET ${setClauses.join(", ")} WHERE id = $1`,
        params,
      );
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to update run ${runId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async getRun(runId: string): Promise<EvalRun | null> {
    if (!this.isConnected()) return null;
    try {
      const result = await this.query<EvalRun>(
        `SELECT * FROM eval_runs WHERE id = $1`,
        [runId],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to get run ${runId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async getRunsBySession(sessionId: string): Promise<EvalRun[]> {
    if (!this.isConnected()) return [];
    try {
      const result = await this.query<EvalRun>(
        `SELECT * FROM eval_runs WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId],
      );
      return result.rows;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to get runs for session ${sessionId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async listRuns(limit = 100, offset = 0): Promise<EvalRun[]> {
    if (!this.isConnected()) return [];
    try {
      const result = await this.query<EvalRun>(
        `SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows;
    } catch (error) {
      logger.error(`[EvalRepository] Failed to list runs: ${error}`, "eval");
      throw error;
    }
  }

  // ── Step CRUD ─────────────────────────────────────────────────────────

  async createStep(step: InsertEvalStep): Promise<EvalStep | null> {
    if (!this.isConnected()) return null;
    try {
      const result = await this.query<EvalStep>(
        `INSERT INTO eval_steps (
          run_id, step, action, score, level, total_levels, state,
          input_tokens, output_tokens, cost_usd, cumulative_cost_usd, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          step.runId,
          step.step,
          step.action,
          step.score ?? null,
          step.level ?? null,
          step.totalLevels ?? null,
          step.state,
          step.inputTokens ?? 0,
          step.outputTokens ?? 0,
          step.costUsd ?? null,
          step.cumulativeCostUsd ?? null,
          new Date(),
        ],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to create step ${step.step} for run ${step.runId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async getStepsByRun(runId: string): Promise<EvalStep[]> {
    if (!this.isConnected()) return [];
    try {
      const result = await this.query<EvalStep>(
        `SELECT * FROM eval_steps WHERE run_id = $1 ORDER BY step ASC`,
        [runId],
      );
      return result.rows;
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to get steps for run ${runId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async bulkCreateSteps(steps: InsertEvalStep[]): Promise<void> {
    if (!this.isConnected() || steps.length === 0) return;
    try {
      // Batch insert for performance — build a single multi-row INSERT
      const values: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      for (const step of steps) {
        values.push(
          `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}, $${idx + 11})`,
        );
        params.push(
          step.runId,
          step.step,
          step.action,
          step.score ?? null,
          step.level ?? null,
          step.totalLevels ?? null,
          step.state,
          step.inputTokens ?? 0,
          step.outputTokens ?? 0,
          step.costUsd ?? null,
          step.cumulativeCostUsd ?? null,
          new Date(),
        );
        idx += 12;
      }

      await this.query(
        `INSERT INTO eval_steps (
          run_id, step, action, score, level, total_levels, state,
          input_tokens, output_tokens, cost_usd, cumulative_cost_usd, created_at
        ) VALUES ${values.join(", ")}`,
        params,
      );
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to bulk create ${steps.length} steps: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  // ── Aggregation Queries ───────────────────────────────────────────────

  async getSessionSummary(sessionId: string): Promise<{
    totalRuns: number;
    completedRuns: number;
    totalSteps: number;
    totalCostUsd: number;
    avgScore: number;
    solvedCount: number;
  } | null> {
    if (!this.isConnected()) return null;
    try {
      const result = await this.query<{
        total_runs: string;
        completed_runs: string;
        total_steps: string;
        total_cost_usd: string;
        avg_score: string;
        solved_count: string;
      }>(
        `SELECT
          COUNT(*) as total_runs,
          COUNT(CASE WHEN final_score IS NOT NULL THEN 1 END) as completed_runs,
          COALESCE(SUM(total_steps), 0) as total_steps,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(AVG(final_score), 0) as avg_score,
          COUNT(CASE WHEN solved = true THEN 1 END) as solved_count
        FROM eval_runs WHERE session_id = $1`,
        [sessionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        totalRuns: parseInt(row.total_runs, 10),
        completedRuns: parseInt(row.completed_runs, 10),
        totalSteps: parseInt(row.total_steps, 10),
        totalCostUsd: parseFloat(row.total_cost_usd),
        avgScore: parseFloat(row.avg_score),
        solvedCount: parseInt(row.solved_count, 10),
      };
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to get session summary ${sessionId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.isConnected()) return;
    try {
      await this.transaction(async (client) => {
        // Delete steps first (via runs), then runs, then session
        await this.query(
          `DELETE FROM eval_steps WHERE run_id IN (SELECT id FROM eval_runs WHERE session_id = $1)`,
          [sessionId],
          client,
        );
        await this.query(
          `DELETE FROM eval_runs WHERE session_id = $1`,
          [sessionId],
          client,
        );
        await this.query(
          `DELETE FROM eval_sessions WHERE id = $1`,
          [sessionId],
          client,
        );
      });
    } catch (error) {
      logger.error(
        `[EvalRepository] Failed to delete session ${sessionId}: ${error}`,
        "eval",
      );
      throw error;
    }
  }
}
