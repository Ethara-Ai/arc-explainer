import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "fs";
import path from "path";
import os from "os";
import {
  isRunComplete,
  scanCompletedRuns,
  findLatestSession,
  truncateStaleData,
  atomicWriteText,
  _isSessionDir,
  _classifyRuns,
  _truncateJsonl,
} from "../../server/services/eval/resume/resumeManager";

// ── Temp dir helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "eval-resume-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeJsonl(filePath: string, records: Record<string, unknown>[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf-8");
}

function readJsonlLines(filePath: string): Record<string, unknown>[] {
  const raw = readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function createSessionDir(base: string, name: string): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── isRunComplete ───────────────────────────────────────────────────────────

describe("isRunComplete", () => {
  it("solved=true → complete", () => {
    expect(isRunComplete({ solved: true, run_number: 1 })).toBe(true);
  });

  it("total_steps >= max_steps with no error → complete", () => {
    expect(
      isRunComplete({
        solved: false,
        total_steps: 200,
        max_steps: 200,
        run_number: 1,
      }),
    ).toBe(true);
  });

  it("total_steps > max_steps → complete", () => {
    expect(
      isRunComplete({
        solved: false,
        total_steps: 210,
        max_steps: 200,
        run_number: 1,
      }),
    ).toBe(true);
  });

  it("in-progress (fewer steps than max) → not complete", () => {
    expect(
      isRunComplete({
        solved: false,
        total_steps: 50,
        max_steps: 200,
        run_number: 1,
      }),
    ).toBe(false);
  });

  it("error set but not solved and not max steps → not complete", () => {
    expect(
      isRunComplete({
        solved: false,
        error: "API timeout",
        total_steps: 10,
        max_steps: 200,
        run_number: 1,
      }),
    ).toBe(false);
  });

  it("missing total_steps and max_steps and not solved → not complete", () => {
    expect(isRunComplete({ solved: false, run_number: 1 })).toBe(false);
  });

  it("empty record → not complete", () => {
    expect(isRunComplete({})).toBe(false);
  });
});

// ── _isSessionDir ───────────────────────────────────────────────────────────

describe("_isSessionDir", () => {
  it("matches YYYYMMDD_ pattern", () => {
    expect(_isSessionDir("20260324_120000")).toBe(true);
    expect(_isSessionDir("20260324_120000_run")).toBe(true);
  });

  it("rejects non-matching names", () => {
    expect(_isSessionDir("logs")).toBe(false);
    expect(_isSessionDir("cancel")).toBe(false);
    expect(_isSessionDir("2026032")).toBe(false);
  });
});

// ── findLatestSession ───────────────────────────────────────────────────────

describe("findLatestSession", () => {
  it("returns newest directory by name", () => {
    createSessionDir(tmpDir, "20260320_100000");
    createSessionDir(tmpDir, "20260324_120000");
    createSessionDir(tmpDir, "20260322_110000");

    const latest = findLatestSession(tmpDir);
    expect(latest).toBe(path.join(tmpDir, "20260324_120000"));
  });

  it("ignores non-matching directories", () => {
    createSessionDir(tmpDir, "logs");
    createSessionDir(tmpDir, "cancel");
    createSessionDir(tmpDir, "20260324_120000");

    const latest = findLatestSession(tmpDir);
    expect(latest).toBe(path.join(tmpDir, "20260324_120000"));
  });

  it("returns null for empty directory", () => {
    expect(findLatestSession(tmpDir)).toBeNull();
  });

  it("returns null for non-existent directory", () => {
    expect(findLatestSession(path.join(tmpDir, "nonexistent"))).toBeNull();
  });
});

// ── _classifyRuns ───────────────────────────────────────────────────────────

describe("_classifyRuns", () => {
  it("identifies completed runs from runs.jsonl", () => {
    const runsPath = path.join(tmpDir, "runs.jsonl");
    writeJsonl(runsPath, [
      { run_number: 1, solved: true },
      { run_number: 2, solved: false, total_steps: 50, max_steps: 200 },
      { run_number: 3, solved: false, total_steps: 200, max_steps: 200 },
    ]);

    const completed = _classifyRuns(runsPath, 3);
    expect(completed.has(1)).toBe(true);
    expect(completed.has(2)).toBe(false);
    expect(completed.has(3)).toBe(true);
  });

  it("returns empty set for non-existent file", () => {
    const completed = _classifyRuns(path.join(tmpDir, "nope.jsonl"));
    expect(completed.size).toBe(0);
  });

  it("caps to numRuns range", () => {
    const runsPath = path.join(tmpDir, "runs.jsonl");
    writeJsonl(runsPath, [
      { run_number: 1, solved: true },
      { run_number: 5, solved: true },
    ]);

    const completed = _classifyRuns(runsPath, 3);
    expect(completed.has(1)).toBe(true);
    expect(completed.has(5)).toBe(false);
  });
});

// ── scanCompletedRuns ───────────────────────────────────────────────────────

describe("scanCompletedRuns", () => {
  it("finds completed runs across session dirs", () => {
    const session = createSessionDir(tmpDir, "20260324_120000");
    const modelDir = path.join(session, "ct01", "gpt-5.4");
    mkdirSync(modelDir, { recursive: true });
    writeJsonl(path.join(modelDir, "runs.jsonl"), [
      { run_number: 1, solved: true },
      { run_number: 2, solved: false, total_steps: 50, max_steps: 200 },
      { run_number: 3, solved: false, total_steps: 200, max_steps: 200 },
    ]);

    const result = scanCompletedRuns({
      outputBase: tmpDir,
      gameIds: ["ct01"],
      modelKeys: ["gpt-5.4"],
      numRuns: 3,
    });

    const key = "(ct01,gpt-5.4)";
    expect(result.has(key)).toBe(true);
    const completed = result.get(key)!;
    expect(completed.has(1)).toBe(true);
    expect(completed.has(2)).toBe(false);
    expect(completed.has(3)).toBe(true);
  });

  it("returns empty sets when no session dirs exist", () => {
    const result = scanCompletedRuns({
      outputBase: tmpDir,
      gameIds: ["ct01"],
      modelKeys: ["gpt-5.4"],
      numRuns: 3,
    });

    const key = "(ct01,gpt-5.4)";
    expect(result.get(key)!.size).toBe(0);
  });

  it("uses safeModelNames mapping when provided", () => {
    const session = createSessionDir(tmpDir, "20260324_120000");
    const modelDir = path.join(session, "ct01", "GPT_5.4_Thinking");
    mkdirSync(modelDir, { recursive: true });
    writeJsonl(path.join(modelDir, "runs.jsonl"), [
      { run_number: 1, solved: true },
    ]);

    const result = scanCompletedRuns({
      outputBase: tmpDir,
      gameIds: ["ct01"],
      modelKeys: ["gpt-5.4-thinking"],
      numRuns: 3,
      safeModelNames: { "gpt-5.4-thinking": "GPT_5.4_Thinking" },
    });

    const key = "(ct01,GPT_5.4_Thinking)";
    expect(result.get(key)!.has(1)).toBe(true);
  });
});

// ── _truncateJsonl ──────────────────────────────────────────────────────────

describe("_truncateJsonl", () => {
  it("removes entries not in keepRuns", () => {
    const filePath = path.join(tmpDir, "steps.jsonl");
    writeJsonl(filePath, [
      { run_number: 1, step: 0, action: "UP" },
      { run_number: 1, step: 1, action: "DOWN" },
      { run_number: 2, step: 0, action: "LEFT" },
      { run_number: 3, step: 0, action: "RIGHT" },
    ]);

    _truncateJsonl(filePath, "run_number", new Set([1, 3]), "test/steps.jsonl");

    const kept = readJsonlLines(filePath);
    expect(kept).toHaveLength(3);
    expect(kept.every((r) => r.run_number === 1 || r.run_number === 3)).toBe(
      true,
    );
  });

  it("preserves all entries when all runs are in keepRuns", () => {
    const filePath = path.join(tmpDir, "steps.jsonl");
    writeJsonl(filePath, [
      { run_number: 1, step: 0 },
      { run_number: 2, step: 0 },
    ]);

    _truncateJsonl(
      filePath,
      "run_number",
      new Set([1, 2]),
      "test/steps.jsonl",
    );

    const kept = readJsonlLines(filePath);
    expect(kept).toHaveLength(2);
  });
});

// ── atomicWriteText ─────────────────────────────────────────────────────────

describe("atomicWriteText", () => {
  it("writes content atomically to target path", () => {
    const targetPath = path.join(tmpDir, "atomic.txt");
    atomicWriteText(targetPath, "hello world\n");

    const content = readFileSync(targetPath, "utf-8");
    expect(content).toBe("hello world\n");
  });

  it("creates parent directories if needed", () => {
    const targetPath = path.join(tmpDir, "deep", "nested", "file.txt");
    atomicWriteText(targetPath, "nested content\n");

    const content = readFileSync(targetPath, "utf-8");
    expect(content).toBe("nested content\n");
  });

  it("overwrites existing file", () => {
    const targetPath = path.join(tmpDir, "overwrite.txt");
    writeFileSync(targetPath, "old", "utf-8");

    atomicWriteText(targetPath, "new");
    expect(readFileSync(targetPath, "utf-8")).toBe("new");
  });
});

// ── truncateStaleData ───────────────────────────────────────────────────────

describe("truncateStaleData", () => {
  it("removes incomplete runs from runs.jsonl and satellites", () => {
    const sessionDir = createSessionDir(tmpDir, "20260324_120000");
    const modelDir = path.join(sessionDir, "ct01", "GPT_5.4");
    mkdirSync(modelDir, { recursive: true });

    writeJsonl(path.join(modelDir, "runs.jsonl"), [
      { run_number: 1, solved: true },
      { run_number: 2, solved: false, total_steps: 50, max_steps: 200 },
    ]);

    writeJsonl(path.join(modelDir, "steps.jsonl"), [
      { run_number: 1, step: 0, action: "UP" },
      { run_number: 1, step: 1, action: "DOWN" },
      { run_number: 2, step: 0, action: "LEFT" },
    ]);

    truncateStaleData(sessionDir, ["ct01"], ["GPT_5.4"]);

    const runsKept = readJsonlLines(path.join(modelDir, "runs.jsonl"));
    expect(runsKept).toHaveLength(1);
    expect(runsKept[0].run_number).toBe(1);

    const stepsKept = readJsonlLines(path.join(modelDir, "steps.jsonl"));
    expect(stepsKept).toHaveLength(2);
    expect(stepsKept.every((s) => s.run_number === 1)).toBe(true);
  });

  it("handles non-existent session directory gracefully", () => {
    expect(() =>
      truncateStaleData(path.join(tmpDir, "nonexistent")),
    ).not.toThrow();
  });

  it("skips satellite truncation when runs.jsonl is empty", () => {
    const sessionDir = createSessionDir(tmpDir, "20260324_120000");
    const modelDir = path.join(sessionDir, "ct01", "GPT_5.4");
    mkdirSync(modelDir, { recursive: true });

    writeFileSync(path.join(modelDir, "runs.jsonl"), "", "utf-8");
    writeJsonl(path.join(modelDir, "steps.jsonl"), [
      { run_number: 1, step: 0, action: "UP" },
    ]);

    truncateStaleData(sessionDir, ["ct01"], ["GPT_5.4"]);

    const stepsAfter = readJsonlLines(path.join(modelDir, "steps.jsonl"));
    expect(stepsAfter).toHaveLength(1);
  });
});
