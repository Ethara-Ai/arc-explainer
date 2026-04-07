-- Migration: Convert eval numeric columns from TEXT to REAL
-- The USING clause safely converts existing text values to real.

ALTER TABLE "eval_sessions"
  ALTER COLUMN "total_cost_usd" TYPE real USING "total_cost_usd"::real;

ALTER TABLE "eval_runs"
  ALTER COLUMN "final_score" TYPE real USING "final_score"::real,
  ALTER COLUMN "cost_usd" TYPE real USING "cost_usd"::real,
  ALTER COLUMN "elapsed_seconds" TYPE real USING "elapsed_seconds"::real;

ALTER TABLE "eval_steps"
  ALTER COLUMN "score" TYPE real USING "score"::real,
  ALTER COLUMN "cost_usd" TYPE real USING "cost_usd"::real,
  ALTER COLUMN "cumulative_cost_usd" TYPE real USING "cumulative_cost_usd"::real;
