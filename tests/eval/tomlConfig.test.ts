import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import {
  loadTomlConfig,
  mergeCliOverToml,
} from "../../server/services/eval/config/tomlConfig";
import type {
  TomlEvalConfig,
  CliArgs,
} from "../../server/services/eval/config/tomlConfig";

// ── Temp dir helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "eval-toml-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeToml(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── loadTomlConfig: parsing ─────────────────────────────────────────────────

describe("loadTomlConfig parsing", () => {
  it("parses valid TOML with [eval], [budget], [circuit_breaker] sections", () => {
    const tomlPath = writeToml(
      "eval.toml",
      `
[eval]
game = ["ct01", "ft09"]
runs = 5
max_steps = 100
context_window = 30
seed = 99
output_dir = "/tmp/evals"
sequential = true

[budget]
global_usd = 50.0
per_game_usd = 10.0

[circuit_breaker]
threshold = 5
half_open_seconds = 120
`,
    );

    const cfg = loadTomlConfig(tomlPath);

    expect(cfg.game).toEqual(["ct01", "ft09"]);
    expect(cfg.runs).toBe(5);
    expect(cfg.maxSteps).toBe(100);
    expect(cfg.contextWindow).toBe(30);
    expect(cfg.seed).toBe(99);
    expect(cfg.outputDir).toBe("/tmp/evals");
    expect(cfg.sequential).toBe(true);
    expect(cfg.budgetGlobalUsd).toBe(50.0);
    expect(cfg.budgetPerGameUsd).toBe(10.0);
    expect(cfg.circuitBreakerThreshold).toBe(5);
    expect(cfg.circuitBreakerHalfOpenSeconds).toBe(120);
  });

  it("parses arrays of strings", () => {
    const tomlPath = writeToml(
      "eval.toml",
      `
[eval]
game = ["ct01", "ft09", "gw01"]
models = ["gpt-5.4-thinking", "claude-opus"]
`,
    );

    const cfg = loadTomlConfig(tomlPath);
    expect(cfg.game).toEqual(["ct01", "ft09", "gw01"]);
    expect(cfg.models).toEqual(["gpt-5.4-thinking", "claude-opus"]);
  });

  it("parses booleans (case-insensitive)", () => {
    const tomlPath = writeToml(
      "eval.toml",
      `
[eval]
sequential = true
`,
    );

    const cfg = loadTomlConfig(tomlPath);
    expect(cfg.sequential).toBe(true);
  });

  it("normalizes single string to array for game field", () => {
    const tomlPath = writeToml(
      "eval.toml",
      `
[eval]
game = "ct01"
`,
    );

    const cfg = loadTomlConfig(tomlPath);
    expect(cfg.game).toEqual(["ct01"]);
  });

  it("handles comments correctly", () => {
    const tomlPath = writeToml(
      "eval.toml",
      `
# This is a comment
[eval]
runs = 3  # inline comment
# game = ["skipped"]
seed = 42
`,
    );

    const cfg = loadTomlConfig(tomlPath);
    expect(cfg.runs).toBe(3);
    expect(cfg.seed).toBe(42);
    expect(cfg.game).toBeUndefined();
  });

  it("returns defaults for missing file", () => {
    const cfg = loadTomlConfig(path.join(tmpDir, "nonexistent.toml"));
    expect(cfg.resume).toBe(false);
    expect(cfg.game).toBeUndefined();
    expect(cfg.runs).toBeUndefined();
  });

  it("parses empty file and returns defaults", () => {
    const tomlPath = writeToml("empty.toml", "");
    const cfg = loadTomlConfig(tomlPath);
    expect(cfg.resume).toBe(false);
  });

  it("parses parallel configuration", () => {
    const tomlPath = writeToml(
      "eval.toml",
      `
[eval]
parallel_games = 4
parallel_runs = 3
`,
    );

    const cfg = loadTomlConfig(tomlPath);
    expect(cfg.parallelGames).toBe(4);
    expect(cfg.parallelRuns).toBe(3);
  });
});

// ── mergeCliOverToml ────────────────────────────────────────────────────────

describe("mergeCliOverToml", () => {
  it("CLI values override TOML values", () => {
    const toml: TomlEvalConfig = {
      runs: 3,
      maxSteps: 100,
      seed: 42,
    };
    const cli: CliArgs = {
      runs: 10,
      maxSteps: 200,
    };

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.runs).toBe(10);
    expect(merged.maxSteps).toBe(200);
  });

  it("TOML values preserved when CLI is undefined", () => {
    const toml: TomlEvalConfig = {
      runs: 5,
      maxSteps: 150,
      seed: 99,
      game: ["ct01", "ft09"],
    };
    const cli: CliArgs = {};

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.runs).toBe(5);
    expect(merged.maxSteps).toBe(150);
    expect(merged.seed).toBe(99);
    expect(merged.game).toEqual(["ct01", "ft09"]);
  });

  it("CLI arrays override TOML arrays (not merge)", () => {
    const toml: TomlEvalConfig = {
      game: ["ct01", "ft09"],
      models: ["gpt-5.4-thinking"],
    };
    const cli: CliArgs = {
      game: ["gw01"],
    };

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.game).toEqual(["gw01"]);
    expect(merged.models).toEqual(["gpt-5.4-thinking"]);
  });

  it("merges budget fields correctly", () => {
    const toml: TomlEvalConfig = {
      budgetGlobalUsd: 50.0,
      budgetPerGameUsd: 10.0,
    };
    const cli: CliArgs = {
      budgetGlobal: 100.0,
    };

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.budgetGlobalUsd).toBe(100.0);
    expect(merged.budgetPerGameUsd).toBe(10.0);
  });

  it("CLI resume overrides TOML resume", () => {
    const toml: TomlEvalConfig = { resume: false };
    const cli: CliArgs = { resume: true };

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.resume).toBe(true);
  });

  it("defaults resume to false when neither set", () => {
    const toml: TomlEvalConfig = {};
    const cli: CliArgs = {};

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.resume).toBe(false);
  });

  it("merges circuit breaker fields", () => {
    const toml: TomlEvalConfig = {
      circuitBreakerThreshold: 5,
      circuitBreakerHalfOpenSeconds: 120,
    };
    const cli: CliArgs = {
      circuitBreakerThreshold: 20,
    };

    const merged = mergeCliOverToml(toml, cli);
    expect(merged.circuitBreakerThreshold).toBe(20);
    expect(merged.circuitBreakerHalfOpenSeconds).toBe(120);
  });
});
