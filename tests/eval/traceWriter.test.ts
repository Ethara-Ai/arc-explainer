import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  JsonlWriter,
  writeTraceHeader,
  writeTraceStep,
  writeTraceFooter,
  buildTracePath,
  readTrace,
} from "../../server/services/eval/data/traceWriter";
import type {
  StepRecord,
  RunRecord,
  TraceRecord,
} from "../../shared/eval-types";

// ── Temp dir helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-trace-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function mockStepRecord(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    runId: "model_ct01_run1",
    model: "Test Model",
    gameId: "ct01",
    gameType: "arc3",
    runNumber: 1,
    step: 0,
    action: "UP",
    score: 0.25,
    level: 1,
    totalLevels: 4,
    done: false,
    state: "IN_PROGRESS",
    cumulativeCostUsd: 0.003,
    inputTokens: 1000,
    outputTokens: 200,
    notepadLength: 50,
    reasoning: "Moving up to explore",
    notepadContents: "First observation",
    observation: "Grid state",
    scorePct: 25.0,
    stepCostUsd: 0.003,
    reasoningTokens: 30,
    thinkingText: null,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function mockRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "model_ct01_run1",
    model: "Test Model",
    gameId: "ct01",
    gameType: "arc3",
    runNumber: 1,
    totalSteps: 10,
    maxSteps: 200,
    finalScore: 0.5,
    solved: false,
    levelsCompleted: 2,
    totalLevels: 4,
    costUsd: 0.05,
    totalInputTokens: 10000,
    totalOutputTokens: 2000,
    totalReasoningTokens: 500,
    elapsedSeconds: 30.5,
    notepadFinal: "Final notes",
    error: null,
    modelId: "test-model-v1",
    seed: 42,
    finalScorePct: 50.0,
    totalCachedInputTokens: 0,
    totalCacheWriteTokens: 0,
    resetCount: 0,
    resetAttempts: 0,
    resetSuccesses: 0,
    ...overrides,
  };
}

// ── JsonlWriter ─────────────────────────────────────────────────────────────

describe("JsonlWriter", () => {
  it("appends records and reads them back", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    const writer = new JsonlWriter(filePath);

    await writer.append({ type: "header", name: "test" });
    await writer.append({ type: "step", value: 42 });

    const records = await writer.read();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ type: "header", name: "test" });
    expect(records[1]).toEqual({ type: "step", value: 42 });
  });

  it("creates nested directories automatically", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "deep.jsonl");
    const writer = new JsonlWriter(filePath);

    await writer.append({ key: "value" });

    const records = await writer.read();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ key: "value" });
  });

  it("writeAll overwrites existing content", async () => {
    const filePath = path.join(tmpDir, "overwrite.jsonl");
    const writer = new JsonlWriter(filePath);

    await writer.append({ old: true });
    await writer.writeAll([{ new: true }, { also_new: true }]);

    const records = await writer.read();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ new: true });
    expect(records[1]).toEqual({ also_new: true });
  });

  it("read returns empty array for nonexistent file", async () => {
    const filePath = path.join(tmpDir, "nonexistent.jsonl");
    const writer = new JsonlWriter(filePath);

    const records = await writer.read();
    expect(records).toEqual([]);
  });

  it("handles empty lines correctly", async () => {
    const filePath = path.join(tmpDir, "empty-lines.jsonl");
    // Write content with an empty line in between
    await fs.writeFile(filePath, '{"a":1}\n\n{"b":2}\n', "utf-8");

    const writer = new JsonlWriter(filePath);
    const records = await writer.read();
    expect(records).toHaveLength(2);
  });
});

// ── buildTracePath ──────────────────────────────────────────────────────────

describe("buildTracePath", () => {
  it("builds correct path with safe model name", () => {
    const result = buildTracePath("/output", "ct01", "GPT 5.4", 1);
    expect(result).toBe(
      path.join("/output", "ct01", "traces", "GPT_5.4_run1_trace.jsonl"),
    );
  });

  it("sanitizes special characters in model name", () => {
    const result = buildTracePath("/out", "game1", "model/v2:latest", 3);
    expect(result).toBe(
      path.join("/out", "game1", "traces", "model_v2_latest_run3_trace.jsonl"),
    );
  });

  it("preserves allowed characters (dots, hyphens, underscores)", () => {
    const result = buildTracePath("/out", "g1", "my-model_v1.5", 2);
    expect(result).toBe(
      path.join("/out", "g1", "traces", "my-model_v1.5_run2_trace.jsonl"),
    );
  });
});

// ── writeTraceHeader ────────────────────────────────────────────────────────

describe("writeTraceHeader", () => {
  it("writes a header record as JSONL", async () => {
    const tracePath = path.join(tmpDir, "trace.jsonl");

    await writeTraceHeader(
      tracePath,
      "run1",
      "TestModel",
      "ct01",
      "arc3",
      1,
      42,
      200,
      "System prompt text",
    );

    const records = await readTrace(tracePath);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("header");

    if (records[0].type === "header") {
      expect(records[0].runId).toBe("run1");
      expect(records[0].model).toBe("TestModel");
      expect(records[0].gameId).toBe("ct01");
      expect(records[0].gameType).toBe("arc3");
      expect(records[0].runNumber).toBe(1);
      expect(records[0].seed).toBe(42);
      expect(records[0].maxSteps).toBe(200);
      expect(records[0].systemPrompt).toBe("System prompt text");
      expect(records[0].timestamp).toBeTruthy();
    }
  });
});

// ── writeTraceStep ──────────────────────────────────────────────────────────

describe("writeTraceStep", () => {
  it("writes a step record from StepRecord", async () => {
    const tracePath = path.join(tmpDir, "step.jsonl");
    const step = mockStepRecord();

    await writeTraceStep(tracePath, step, true);

    const records = await readTrace(tracePath);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("step");

    if (records[0].type === "step") {
      expect(records[0].action).toBe("UP");
      expect(records[0].score).toBe(0.25);
      expect(records[0].imageSent).toBe(true);
      expect(records[0].reasoning).toBe("Moving up to explore");
      expect(records[0].timestamp).toBeTruthy();
    }
  });

  it("defaults imageSent to false", async () => {
    const tracePath = path.join(tmpDir, "step-no-img.jsonl");
    const step = mockStepRecord();

    await writeTraceStep(tracePath, step);

    const records = await readTrace(tracePath);
    if (records[0].type === "step") {
      expect(records[0].imageSent).toBe(false);
    }
  });
});

// ── writeTraceFooter ────────────────────────────────────────────────────────

describe("writeTraceFooter", () => {
  it("writes a summary record from RunRecord", async () => {
    const tracePath = path.join(tmpDir, "footer.jsonl");
    const run = mockRunRecord();

    await writeTraceFooter(tracePath, run);

    const records = await readTrace(tracePath);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("summary");

    if (records[0].type === "summary") {
      expect(records[0].runId).toBe("model_ct01_run1");
      expect(records[0].finalScore).toBe(0.5);
      expect(records[0].solved).toBe(false);
      expect(records[0].costUsd).toBe(0.05);
      expect(records[0].error).toBeNull();
      expect(records[0].timestamp).toBeTruthy();
    }
  });
});

// ── Full round-trip: header + steps + summary ───────────────────────────────

describe("full trace round-trip", () => {
  it("writes header, multiple steps, and summary — reads back correctly", async () => {
    const tracePath = path.join(tmpDir, "full-trace.jsonl");

    await writeTraceHeader(
      tracePath,
      "run1",
      "Model",
      "ct01",
      "arc3",
      1,
      42,
      200,
      "sys prompt",
    );
    await writeTraceStep(
      tracePath,
      mockStepRecord({ step: 0, action: "UP" }),
      false,
    );
    await writeTraceStep(
      tracePath,
      mockStepRecord({ step: 1, action: "RIGHT", score: 0.5 }),
      true,
    );
    await writeTraceStep(
      tracePath,
      mockStepRecord({
        step: 2,
        action: "SELECT",
        score: 1.0,
        done: true,
        state: "WIN",
      }),
      false,
    );
    await writeTraceFooter(
      tracePath,
      mockRunRecord({ totalSteps: 3, finalScore: 1.0, solved: true }),
    );

    const records = await readTrace(tracePath);
    expect(records).toHaveLength(5);

    expect(records[0].type).toBe("header");
    expect(records[1].type).toBe("step");
    expect(records[2].type).toBe("step");
    expect(records[3].type).toBe("step");
    expect(records[4].type).toBe("summary");

    // Verify step progression
    if (records[1].type === "step") expect(records[1].action).toBe("UP");
    if (records[2].type === "step") expect(records[2].action).toBe("RIGHT");
    if (records[3].type === "step") expect(records[3].action).toBe("SELECT");

    // Verify summary
    if (records[4].type === "summary") {
      expect(records[4].finalScore).toBe(1.0);
      expect(records[4].solved).toBe(true);
    }
  });
});
