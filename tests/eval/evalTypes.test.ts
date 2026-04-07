import { describe, it, expect } from "vitest";
import {
  toStepEventData,
  toRunEventData,
  type StepRecord,
  type RunRecord,
  type StepEventData,
  type RunEventData,
  type EvalEvent,
  type EvalSessionStartEvent,
  type EvalStepEvent,
  type EvalRunEndEvent,
  type EvalErrorEvent,
  type EvalLogEvent,
} from "../../shared/eval-types";

// ── Fixtures ────────────────────────────────────────────────────────────────

function createMockStepRecord(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    runId: "gpt-5.4_ct01_run1",
    model: "GPT 5.4",
    gameId: "ct01",
    gameType: "arc3",
    runNumber: 1,
    step: 5,
    action: "CLICK 3 4",
    score: 0.5,
    level: 2,
    totalLevels: 4,
    done: false,
    state: "IN_PROGRESS",
    cumulativeCostUsd: 0.0325,
    inputTokens: 2000,
    outputTokens: 500,
    notepadLength: 120,
    reasoning: "I see a pattern in the grid that suggests clicking at (3,4)",
    notepadContents: "Rule: colors shift clockwise",
    observation: "Grid: [[0,1],[2,3]]",
    scorePct: 50.0,
    stepCostUsd: 0.005,
    reasoningTokens: 100,
    thinkingText: null,
    cachedInputTokens: 300,
    cacheWriteTokens: 50,
    ...overrides,
  };
}

function createMockRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "gpt-5.4_ct01_run1",
    model: "GPT 5.4",
    gameId: "ct01",
    gameType: "arc3",
    runNumber: 1,
    totalSteps: 42,
    maxSteps: 200,
    finalScore: 0.75,
    solved: false,
    levelsCompleted: 3,
    totalLevels: 4,
    costUsd: 0.85,
    totalInputTokens: 50000,
    totalOutputTokens: 12000,
    totalReasoningTokens: 3000,
    elapsedSeconds: 120.5,
    notepadFinal: "Final strategy: apply color rotation rule per level",
    error: null,
    modelId: "gpt-5.4",
    seed: 42,
    finalScorePct: 75.0,
    totalCachedInputTokens: 10000,
    totalCacheWriteTokens: 2000,
    resetCount: 1,
    resetAttempts: 0,
    resetSuccesses: 0,
    ...overrides,
  };
}

// ── toStepEventData ─────────────────────────────────────────────────────────

describe("toStepEventData", () => {
  it("omits large text fields (reasoning, notepadContents, observation)", () => {
    const step = createMockStepRecord();
    const eventData = toStepEventData(step);

    // These fields should be ABSENT from event data
    expect(eventData).not.toHaveProperty("reasoning");
    expect(eventData).not.toHaveProperty("notepadContents");
    expect(eventData).not.toHaveProperty("observation");
    expect(eventData).not.toHaveProperty("notepadLength");
  });

  it("preserves all non-text fields exactly", () => {
    const step = createMockStepRecord();
    const eventData = toStepEventData(step);

    expect(eventData.runId).toBe("gpt-5.4_ct01_run1");
    expect(eventData.model).toBe("GPT 5.4");
    expect(eventData.gameId).toBe("ct01");
    expect(eventData.gameType).toBe("arc3");
    expect(eventData.runNumber).toBe(1);
    expect(eventData.step).toBe(5);
    expect(eventData.action).toBe("CLICK 3 4");
    expect(eventData.score).toBe(0.5);
    expect(eventData.level).toBe(2);
    expect(eventData.totalLevels).toBe(4);
    expect(eventData.done).toBe(false);
    expect(eventData.state).toBe("IN_PROGRESS");
    expect(eventData.cumulativeCostUsd).toBe(0.0325);
    expect(eventData.inputTokens).toBe(2000);
    expect(eventData.outputTokens).toBe(500);
    expect(eventData.reasoningTokens).toBe(100);
    expect(eventData.scorePct).toBe(50.0);
    expect(eventData.stepCostUsd).toBe(0.005);
    expect(eventData.cachedInputTokens).toBe(300);
    expect(eventData.cacheWriteTokens).toBe(50);
  });

  it("handles null level and totalLevels", () => {
    const step = createMockStepRecord({ level: null, totalLevels: null });
    const eventData = toStepEventData(step);

    expect(eventData.level).toBeNull();
    expect(eventData.totalLevels).toBeNull();
  });

  it("handles edge case: zero score", () => {
    const step = createMockStepRecord({ score: 0, scorePct: 0 });
    const eventData = toStepEventData(step);

    expect(eventData.score).toBe(0);
    expect(eventData.scorePct).toBe(0);
  });

  it("handles edge case: done=true with WIN state", () => {
    const step = createMockStepRecord({ done: true, state: "WIN" });
    const eventData = toStepEventData(step);

    expect(eventData.done).toBe(true);
    expect(eventData.state).toBe("WIN");
  });
});

// ── toRunEventData ──────────────────────────────────────────────────────────

describe("toRunEventData", () => {
  it("omits notepadFinal field", () => {
    const run = createMockRunRecord();
    const eventData = toRunEventData(run);

    expect(eventData).not.toHaveProperty("notepadFinal");
    expect(eventData).not.toHaveProperty("modelId");
  });

  it("preserves all non-text fields exactly", () => {
    const run = createMockRunRecord();
    const eventData = toRunEventData(run);

    expect(eventData.runId).toBe("gpt-5.4_ct01_run1");
    expect(eventData.model).toBe("GPT 5.4");
    expect(eventData.gameId).toBe("ct01");
    expect(eventData.gameType).toBe("arc3");
    expect(eventData.runNumber).toBe(1);
    expect(eventData.totalSteps).toBe(42);
    expect(eventData.maxSteps).toBe(200);
    expect(eventData.finalScore).toBe(0.75);
    expect(eventData.solved).toBe(false);
    expect(eventData.levelsCompleted).toBe(3);
    expect(eventData.totalLevels).toBe(4);
    expect(eventData.costUsd).toBe(0.85);
    expect(eventData.totalInputTokens).toBe(50000);
    expect(eventData.totalOutputTokens).toBe(12000);
    expect(eventData.totalReasoningTokens).toBe(3000);
    expect(eventData.elapsedSeconds).toBe(120.5);
    expect(eventData.error).toBeNull();
    expect(eventData.finalScorePct).toBe(75.0);
    expect(eventData.totalCachedInputTokens).toBe(10000);
    expect(eventData.totalCacheWriteTokens).toBe(2000);
    expect(eventData.resetCount).toBe(1);
  });

  it("handles null optional fields", () => {
    const run = createMockRunRecord({
      levelsCompleted: null,
      totalLevels: null,
      error: null,
    });
    const eventData = toRunEventData(run);

    expect(eventData.levelsCompleted).toBeNull();
    expect(eventData.totalLevels).toBeNull();
    expect(eventData.error).toBeNull();
  });

  it("handles error string", () => {
    const run = createMockRunRecord({ error: "Provider timeout after 600s" });
    const eventData = toRunEventData(run);

    expect(eventData.error).toBe("Provider timeout after 600s");
  });

  it("handles perfect score (solved=true)", () => {
    const run = createMockRunRecord({
      finalScore: 1.0,
      finalScorePct: 100.0,
      solved: true,
    });
    const eventData = toRunEventData(run);

    expect(eventData.finalScore).toBe(1.0);
    expect(eventData.finalScorePct).toBe(100.0);
    expect(eventData.solved).toBe(true);
  });
});

// ── EvalEvent discriminated union ───────────────────────────────────────────

describe("EvalEvent discriminated union", () => {
  it("narrows correctly on session_start type", () => {
    const event: EvalEvent = {
      type: "session_start",
      session_id: "eval_123",
      game_ids: ["ct01", "ft09"],
      model_keys: ["gpt-5.4-thinking"],
      parallel: true,
      models: ["gpt-5.4-thinking"],
      num_runs: 3,
      max_steps: 200,
      total_runs: 6,
      timestamp: "2026-03-24T00:00:00Z",
    };

    expect(event.type).toBe("session_start");
    if (event.type === "session_start") {
      expect(event.game_ids).toHaveLength(2);
      expect(event.total_runs).toBe(6);
    }
  });

  it("narrows correctly on step type", () => {
    const event: EvalEvent = {
      type: "step",
      session_id: "eval_123",
      run_id: "run1",
      model: "GPT 5.4",
      model_key: "gpt-5.4-thinking",
      game_id: "ct01",
      game_type: "arc3",
      run_number: 1,
      step: 0,
      action: "UP",
      score: 0.25,
      score_pct: 25.0,
      level: 1,
      total_levels: 4,
      done: false,
      state: "IN_PROGRESS",
      input_tokens: 1000,
      output_tokens: 200,
      reasoning_tokens: 50,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      step_cost_usd: 0.003,
      cumulative_cost_usd: 0.003,
      timestamp: "2026-03-24T00:00:01Z",
    };

    expect(event.type).toBe("step");
    if (event.type === "step") {
      expect(event.step_cost_usd).toBe(0.003);
      expect(event.cumulative_cost_usd).toBe(0.003);
    }
  });

  it("narrows correctly on error type", () => {
    const event: EvalEvent = {
      type: "error",
      session_id: "eval_123",
      run_id: "run1",
      model: "GPT 5.4",
      game_id: "ct01",
      message: "Rate limit exceeded",
      code: "RATE_LIMIT",
      timestamp: "2026-03-24T00:00:02Z",
    };

    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.code).toBe("RATE_LIMIT");
      expect(event.run_id).toBe("run1");
    }
  });

  it("narrows correctly on log type", () => {
    const event: EvalEvent = {
      type: "log",
      session_id: "eval_123",
      level: "warn",
      message: "Backing off 30s",
      timestamp: "2026-03-24T00:00:03Z",
    };

    expect(event.type).toBe("log");
    if (event.type === "log") {
      expect(event.level).toBe("warn");
    }
  });

  it("all 8 event types have distinct type discriminants", () => {
    const types = new Set([
      "session_start",
      "run_start",
      "step",
      "run_end",
      "session_end",
      "model_done",
      "error",
      "log",
    ]);
    expect(types.size).toBe(8);
  });
});
