/**
 * Unit tests for server/services/eval/adapters/types.ts
 * Tests: validateGameId, discoverGames, DEFAULT_BRIDGE_CONFIG, type exports
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateGameId,
  discoverGames,
  DEFAULT_BRIDGE_CONFIG,
} from "../../../server/services/eval/adapters/types";

// ── validateGameId ───────────────────────────────────────────────────────────

describe("validateGameId", () => {
  it("accepts valid lowercase gameIds", () => {
    expect(() => validateGameId("ct01")).not.toThrow();
    expect(() => validateGameId("ft09")).not.toThrow();
    expect(() => validateGameId("game_123")).not.toThrow();
    expect(() => validateGameId("a")).not.toThrow();
  });

  it("accepts gameIds with underscores and digits", () => {
    expect(() => validateGameId("abc_def_123")).not.toThrow();
    expect(() => validateGameId("0123456789")).not.toThrow();
    expect(() => validateGameId("_leading")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateGameId("")).toThrow("non-empty string");
  });

  it("rejects uppercase characters", () => {
    expect(() => validateGameId("CT01")).toThrow("Only lowercase");
    expect(() => validateGameId("GameOne")).toThrow("Only lowercase");
  });

  it("rejects special characters", () => {
    expect(() => validateGameId("game-01")).toThrow("Only lowercase");
    expect(() => validateGameId("game.py")).toThrow("Only lowercase");
    expect(() => validateGameId("game/id")).toThrow("Only lowercase");
    expect(() => validateGameId("game id")).toThrow("Only lowercase");
    expect(() => validateGameId("game;drop")).toThrow("Only lowercase");
  });

  it("rejects strings longer than 50 characters", () => {
    const longId = "a".repeat(51);
    expect(() => validateGameId(longId)).toThrow("too long");
  });

  it("accepts exactly 50 characters", () => {
    const exactId = "a".repeat(50);
    expect(() => validateGameId(exactId)).not.toThrow();
  });

  it("rejects non-string inputs", () => {
    // @ts-expect-error testing runtime behavior with bad input
    expect(() => validateGameId(null)).toThrow("non-empty string");
    // @ts-expect-error testing runtime behavior with bad input
    expect(() => validateGameId(undefined)).toThrow("non-empty string");
    // @ts-expect-error testing runtime behavior with bad input
    expect(() => validateGameId(42)).toThrow("non-empty string");
  });
});

// ── discoverGames ────────────────────────────────────────────────────────────

describe("discoverGames", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "arc-test-discover-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent directory", () => {
    const games = discoverGames("/does/not/exist/anywhere");
    expect(games).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    const games = discoverGames(tmpDir);
    expect(games).toEqual([]);
  });

  it("discovers flat layout game (gameId/gameId.py + metadata.json)", () => {
    const gameDir = join(tmpDir, "test_game");
    mkdirSync(gameDir);
    writeFileSync(
      join(gameDir, "metadata.json"),
      JSON.stringify({ game_id: "test_game", title: "Test Game" }),
    );
    writeFileSync(join(gameDir, "test_game.py"), "class PuzzleEnvironment: pass");

    const games = discoverGames(tmpDir);

    expect(games).toHaveLength(1);
    expect(games[0]!.gameId).toBe("test_game");
    expect(games[0]!.pyFile).toContain("test_game.py");
    expect(games[0]!.gameDir).toBe(gameDir);
    expect(games[0]!.metadata.game_id).toBe("test_game");
    expect(games[0]!.metadata.title).toBe("Test Game");
  });

  it("discovers versioned layout (gameId/v1/gameId.py)", () => {
    const gameDir = join(tmpDir, "ver_game");
    const v1Dir = join(gameDir, "v1");
    mkdirSync(v1Dir, { recursive: true });
    writeFileSync(
      join(v1Dir, "metadata.json"),
      JSON.stringify({ game_id: "ver_game" }),
    );
    writeFileSync(join(v1Dir, "ver_game.py"), "class PuzzleEnvironment: pass");

    const games = discoverGames(tmpDir);

    expect(games).toHaveLength(1);
    expect(games[0]!.gameId).toBe("ver_game");
    expect(games[0]!.gameDir).toBe(v1Dir);
  });

  it("picks latest version directory", () => {
    const gameDir = join(tmpDir, "multi_ver");
    const v1 = join(gameDir, "v1");
    const v2 = join(gameDir, "v2");
    mkdirSync(v1, { recursive: true });
    mkdirSync(v2, { recursive: true });

    writeFileSync(
      join(v1, "metadata.json"),
      JSON.stringify({ game_id: "multi_ver", title: "v1" }),
    );
    writeFileSync(join(v1, "multi_ver.py"), "# v1");

    writeFileSync(
      join(v2, "metadata.json"),
      JSON.stringify({ game_id: "multi_ver", title: "v2" }),
    );
    writeFileSync(join(v2, "multi_ver.py"), "# v2");

    const games = discoverGames(tmpDir);

    expect(games).toHaveLength(1);
    expect(games[0]!.gameDir).toBe(v2);
    expect(games[0]!.metadata.title).toBe("v2");
  });

  it("skips directories without metadata.json", () => {
    const gameDir = join(tmpDir, "no_meta");
    mkdirSync(gameDir);
    writeFileSync(join(gameDir, "no_meta.py"), "pass");

    const games = discoverGames(tmpDir);
    expect(games).toEqual([]);
  });

  it("skips directories starting with . or _", () => {
    const hidden = join(tmpDir, ".hidden");
    const internal = join(tmpDir, "_internal");
    mkdirSync(hidden);
    mkdirSync(internal);
    writeFileSync(
      join(hidden, "metadata.json"),
      JSON.stringify({ game_id: "hidden" }),
    );
    writeFileSync(join(hidden, "hidden.py"), "pass");
    writeFileSync(
      join(internal, "metadata.json"),
      JSON.stringify({ game_id: "internal" }),
    );
    writeFileSync(join(internal, "internal.py"), "pass");

    const games = discoverGames(tmpDir);
    expect(games).toEqual([]);
  });

  it("skips entries with invalid metadata JSON", () => {
    const gameDir = join(tmpDir, "bad_json");
    mkdirSync(gameDir);
    writeFileSync(join(gameDir, "metadata.json"), "{invalid json!!!");
    writeFileSync(join(gameDir, "bad_json.py"), "pass");

    const games = discoverGames(tmpDir);
    expect(games).toEqual([]);
  });

  it("skips directories without any .py files", () => {
    const gameDir = join(tmpDir, "no_py");
    mkdirSync(gameDir);
    writeFileSync(
      join(gameDir, "metadata.json"),
      JSON.stringify({ game_id: "no_py" }),
    );
    writeFileSync(join(gameDir, "readme.txt"), "no python here");

    const games = discoverGames(tmpDir);
    expect(games).toEqual([]);
  });

  it("falls back to first .py file when gameId.py not found", () => {
    const gameDir = join(tmpDir, "fallback_py");
    mkdirSync(gameDir);
    writeFileSync(
      join(gameDir, "metadata.json"),
      JSON.stringify({ game_id: "fallback_py" }),
    );
    // Name doesn't match gameId
    writeFileSync(join(gameDir, "alpha.py"), "class PuzzleEnvironment: pass");

    const games = discoverGames(tmpDir);

    expect(games).toHaveLength(1);
    expect(games[0]!.pyFile).toContain("alpha.py");
  });

  it("returns games sorted by gameId", () => {
    for (const id of ["zzz_game", "aaa_game", "mmm_game"]) {
      const dir = join(tmpDir, id);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "metadata.json"),
        JSON.stringify({ game_id: id }),
      );
      writeFileSync(join(dir, `${id}.py`), "pass");
    }

    const games = discoverGames(tmpDir);

    expect(games).toHaveLength(3);
    expect(games[0]!.gameId).toBe("aaa_game");
    expect(games[1]!.gameId).toBe("mmm_game");
    expect(games[2]!.gameId).toBe("zzz_game");
  });

  it("uses entry name as gameId fallback when metadata has no game_id", () => {
    const gameDir = join(tmpDir, "dir_name");
    mkdirSync(gameDir);
    writeFileSync(
      join(gameDir, "metadata.json"),
      JSON.stringify({ title: "No ID field" }),
    );
    writeFileSync(join(gameDir, "dir_name.py"), "pass");

    const games = discoverGames(tmpDir);

    expect(games).toHaveLength(1);
    // Falls back to directory entry name when game_id is empty
    expect(games[0]!.gameId).toBe("dir_name");
  });

  it("discovers multiple games in a single directory", () => {
    for (const id of ["game_a", "game_b", "game_c"]) {
      const dir = join(tmpDir, id);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "metadata.json"),
        JSON.stringify({ game_id: id }),
      );
      writeFileSync(join(dir, `${id}.py`), "pass");
    }

    const games = discoverGames(tmpDir);
    expect(games).toHaveLength(3);
  });
});

// ── DEFAULT_BRIDGE_CONFIG ────────────────────────────────────────────────────

describe("DEFAULT_BRIDGE_CONFIG", () => {
  it("has correct pythonBin for platform", () => {
    const expected = process.platform === "win32" ? "python" : "python3";
    expect(DEFAULT_BRIDGE_CONFIG.pythonBin).toBe(expected);
  });

  it("has 10 second command timeout", () => {
    expect(DEFAULT_BRIDGE_CONFIG.commandTimeoutMs).toBe(10_000);
  });

  it("does not have env set", () => {
    expect(DEFAULT_BRIDGE_CONFIG.env).toBeUndefined();
  });
});
