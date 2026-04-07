import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  varchar,
  real,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Worm Arena Sessions table for persistent live-link resolution
export const wormArenaSessions = pgTable("worm_arena_sessions", {
  sessionId: varchar("session_id", { length: 255 }).primaryKey(),
  modelA: varchar("model_a", { length: 255 }).notNull(),
  modelB: varchar("model_b", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  gameId: varchar("game_id", { length: 255 }),
});

export const insertWormArenaSessionSchema = createInsertSchema(
  wormArenaSessions,
).pick({
  sessionId: true,
  modelA: true,
  modelB: true,
  expiresAt: true,
});

// Visitor stats for landing page
export const visitorStats = pgTable("visitor_stats", {
  id: serial("id").primaryKey(),
  page: varchar("page", { length: 255 }).notNull().unique(),
  count: integer("count").notNull().default(0),
});

export const insertVisitorStatsSchema = createInsertSchema(visitorStats).pick({
  page: true,
  count: true,
});

export type InsertVisitorStats = z.infer<typeof insertVisitorStatsSchema>;
export type VisitorStats = typeof visitorStats.$inferSelect;

// ─── Eval Harness Tables ─────────────────────────────────────────────────────

export const evalSessions = pgTable("eval_sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  status: varchar("status", { length: 20 }).notNull().default("running"),
  gameIds: text("game_ids").notNull(),
  modelKeys: text("model_keys").notNull(),
  numRuns: integer("num_runs").notNull(),
  maxSteps: integer("max_steps").notNull(),
  seedBase: integer("seed_base").notNull(),
  totalRuns: integer("total_runs"),
  totalSteps: integer("total_steps"),
  totalCostUsd: real("total_cost_usd"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertEvalSessionSchema = createInsertSchema(evalSessions).pick({
  id: true,
  status: true,
  gameIds: true,
  modelKeys: true,
  numRuns: true,
  maxSteps: true,
  seedBase: true,
  startedAt: true,
});

export type InsertEvalSession = z.infer<typeof insertEvalSessionSchema>;
export type EvalSession = typeof evalSessions.$inferSelect;

export const evalRuns = pgTable("eval_runs", {
  id: varchar("id", { length: 128 }).primaryKey(),
  sessionId: varchar("session_id", { length: 64 })
    .notNull()
    .references(() => evalSessions.id, { onDelete: "cascade" }),
  model: varchar("model", { length: 128 }).notNull(),
  modelKey: varchar("model_key", { length: 128 }).notNull(),
  gameId: varchar("game_id", { length: 64 }).notNull(),
  gameType: varchar("game_type", { length: 10 }).notNull(),
  runNumber: integer("run_number").notNull(),
  seed: integer("seed").notNull(),
  totalSteps: integer("total_steps"),
  maxSteps: integer("max_steps").notNull().default(200),
  finalScore: real("final_score"),
  solved: boolean("solved").notNull().default(false),
  levelsCompleted: integer("levels_completed"),
  totalLevels: integer("total_levels"),
  costUsd: real("cost_usd"),
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  totalReasoningTokens: integer("total_reasoning_tokens").notNull().default(0),
  elapsedSeconds: real("elapsed_seconds"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertEvalRunSchema = createInsertSchema(evalRuns).pick({
  id: true,
  sessionId: true,
  model: true,
  modelKey: true,
  gameId: true,
  gameType: true,
  runNumber: true,
  seed: true,
  maxSteps: true,
});

export type InsertEvalRun = z.infer<typeof insertEvalRunSchema>;
export type EvalRun = typeof evalRuns.$inferSelect;

export const evalSteps = pgTable("eval_steps", {
  id: serial("id").primaryKey(),
  runId: varchar("run_id", { length: 128 })
    .notNull()
    .references(() => evalRuns.id, { onDelete: "cascade" }),
  step: integer("step").notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  score: real("score"),
  level: integer("level"),
  totalLevels: integer("total_levels"),
  state: varchar("state", { length: 20 }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd"),
  cumulativeCostUsd: real("cumulative_cost_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertEvalStepSchema = createInsertSchema(evalSteps).pick({
  runId: true,
  step: true,
  action: true,
  score: true,
  state: true,
  level: true,
  totalLevels: true,
  inputTokens: true,
  outputTokens: true,
  costUsd: true,
  cumulativeCostUsd: true,
});

export type InsertEvalStep = z.infer<typeof insertEvalStepSchema>;
export type EvalStep = typeof evalSteps.$inferSelect;
