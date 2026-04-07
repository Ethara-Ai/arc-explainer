/**
 * Unit tests for server/services/eval/adapters/gameBridge.ts
 * Mocks child_process.spawn to simulate Python subprocess communication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
import type { ChildProcess } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Mock child_process ───────────────────────────────────────────────────────

// We need to mock the spawn function before importing GameBridge
vi.mock("child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "child_process";
import { GameBridge } from "../../../server/services/eval/adapters/gameBridge";
import type {
  BridgeInfoResponse,
  BridgeFrameResponse,
} from "../../../server/services/eval/adapters/types";

const mockSpawn = vi.mocked(spawn);

// ── Test Helpers ─────────────────────────────────────────────────────────────

/** Temporary directory tree that simulates puzzle-environments layout */
let tmpRoot: string;
let pyFilePath: string;

function createTempGameDir(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), "arc-bridge-test-"));
  const gameDir = join(tmpRoot, "test_game");
  mkdirSync(gameDir);
  pyFilePath = join(gameDir, "test_game.py");
  writeFileSync(pyFilePath, "class PuzzleEnvironment: pass");
  writeFileSync(
    join(gameDir, "metadata.json"),
    JSON.stringify({ game_id: "test_game" }),
  );
}

function cleanupTempDir(): void {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Creates a mock ChildProcess with controllable stdin/stdout/stderr.
 * Returns the mock process and helpers to feed lines to stdout/stderr.
 */
function createMockProcess() {
  // Build a partial ChildProcess mock with only the properties GameBridge uses.
  // Cast through unknown because we intentionally skip the 10+ properties
  // (stdio, connected, exitCode, etc.) that GameBridge never accesses.
  const emitter = new EventEmitter();

  const stdinData: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      stdinData.push(chunk.toString());
      callback();
    },
  });

  const stdout = new Readable({
    read() {
      // Data will be pushed manually
    },
  });

  const stderr = new Readable({
    read() {
      // Data will be pushed manually
    },
  });

  let killed = false;
  const kill = vi.fn((): boolean => {
    killed = true;
    return true;
  });

  // Assign properties onto the emitter, then cast once to ChildProcess.
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    get killed() {
      return killed;
    },
    set killed(v: boolean) {
      killed = v;
    },
    kill,
  }) as unknown as ChildProcess;

  return {
    proc,
    stdinData,
    /** Push a JSON line to stdout (simulates Python response) */
    sendResponse(data: object) {
      stdout.push(JSON.stringify(data) + "\n");
    },
    /** Push a line to stderr */
    sendStderr(line: string) {
      stderr.emit("data", Buffer.from(line + "\n"));
    },
    /** Simulate process exit */
    emitExit(code: number) {
      emitter.emit("exit", code);
    },
    /** Simulate spawn error */
    emitError(err: Error) {
      emitter.emit("error", err);
    },
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  createTempGameDir();
});

afterEach(() => {
  cleanupTempDir();
});

// ── Constructor Validation ───────────────────────────────────────────────────

describe("GameBridge constructor", () => {
  it("rejects non-.py pyFilePath", () => {
    const txtPath = join(tmpRoot, "test_game", "game.txt");
    writeFileSync(txtPath, "not python");

    expect(
      () => new GameBridge("test_game", txtPath, { allowedRoot: tmpRoot }),
    ).toThrow("must end in .py");
  });

  it("rejects pyFilePath outside allowedRoot", () => {
    const outsidePath = "/tmp/evil/game.py";

    expect(
      () => new GameBridge("test_game", outsidePath, { allowedRoot: tmpRoot }),
    ).toThrow("must be within");
  });

  it("rejects invalid gameId (uppercase)", () => {
    expect(
      () => new GameBridge("INVALID", pyFilePath, { allowedRoot: tmpRoot }),
    ).toThrow("Only lowercase");
  });

  it("rejects empty gameId", () => {
    expect(
      () => new GameBridge("", pyFilePath, { allowedRoot: tmpRoot }),
    ).toThrow("non-empty string");
  });

  it("accepts valid gameId and .py path", () => {
    expect(
      () => new GameBridge("test_game", pyFilePath, { allowedRoot: tmpRoot }),
    ).not.toThrow();
  });
});

// ── start() ──────────────────────────────────────────────────────────────────

describe("GameBridge.start()", () => {
  it("spawns process and returns info response", async () => {
    const { proc, sendResponse } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startPromise = bridge.start();

    // Simulate Python subprocess responding to info command
    // Need a small delay for readline setup
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test Game",
      description: "A test",
      available_actions: ["up", "down"],
      total_levels: 3,
    } satisfies BridgeInfoResponse);

    const info = await startPromise;

    expect(info.type).toBe("info");
    expect(info.game_id).toBe("test_game");
    expect(info.title).toBe("Test Game");
    expect(info.total_levels).toBe(3);
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("returns cached info if already alive", async () => {
    const { proc, sendResponse } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test Game",
      description: "",
      available_actions: ["up"],
      total_levels: 1,
    } satisfies BridgeInfoResponse);

    await startPromise;

    // Second start — should re-send info command, not re-spawn
    const secondPromise = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test Game",
      description: "",
      available_actions: ["up"],
      total_levels: 1,
    } satisfies BridgeInfoResponse);

    const info2 = await secondPromise;
    expect(info2.game_id).toBe("test_game");

    // spawn should only be called once
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});

// ── reset() ──────────────────────────────────────────────────────────────────

describe("GameBridge.reset()", () => {
  it("sends reset command and returns frame response", async () => {
    const { proc, sendResponse, stdinData } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    // Start first
    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test",
      description: "",
      available_actions: ["up"],
    } satisfies BridgeInfoResponse);
    await startP;

    // Reset
    const resetP = bridge.reset();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "frame",
      frame: [
        [0, 1],
        [2, 3],
      ],
      score: 0,
      state: "IN_PROGRESS",
      action_counter: 0,
      max_actions: 200,
      win_score: 1.0,
      available_actions: ["up", "down"],
    } satisfies BridgeFrameResponse);

    const frame = await resetP;

    expect(frame.type).toBe("frame");
    expect(frame.state).toBe("IN_PROGRESS");
    expect(frame.score).toBe(0);

    // Verify reset command was sent to stdin
    const resetCmd = stdinData.find((s) => s.includes('"type":"reset"'));
    expect(resetCmd).toBeDefined();
  });
});

// ── action() ─────────────────────────────────────────────────────────────────

describe("GameBridge.action()", () => {
  async function setupBridge() {
    const mock = createMockProcess();
    mockSpawn.mockReturnValue(mock.proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    // Start
    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    mock.sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test",
      description: "",
      available_actions: ["up", "click"],
    } satisfies BridgeInfoResponse);
    await startP;

    return { bridge, ...mock };
  }

  it("sends simple action (up)", async () => {
    const { bridge, sendResponse, stdinData } = await setupBridge();

    const actionP = bridge.action("up");
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "frame",
      frame: [[1]],
      score: 0,
      state: "IN_PROGRESS",
      action_counter: 1,
      max_actions: 200,
      win_score: 1.0,
      available_actions: ["up", "click"],
    } satisfies BridgeFrameResponse);

    const frame = await actionP;
    expect(frame.action_counter).toBe(1);

    // Verify the action command includes lowercase action
    const actionCmd = stdinData.find((s) => s.includes('"action":"up"'));
    expect(actionCmd).toBeDefined();
  });

  it("parses click with coordinates (CLICK 10 15)", async () => {
    const { bridge, sendResponse, stdinData } = await setupBridge();

    const actionP = bridge.action("CLICK 10 15");
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "frame",
      frame: [[1]],
      score: 0,
      state: "IN_PROGRESS",
      action_counter: 1,
      max_actions: 200,
      win_score: 1.0,
      available_actions: ["click"],
    } satisfies BridgeFrameResponse);

    await actionP;

    const actionCmd = stdinData.find((s) => s.includes('"action":"click"'));
    expect(actionCmd).toBeDefined();

    // Verify coordinates are parsed
    const parsed = JSON.parse(actionCmd!);
    expect(parsed.x).toBe(10);
    expect(parsed.y).toBe(15);
  });

  it("handles bare click (no coordinates) — x,y should be null", async () => {
    const { bridge, sendResponse, stdinData } = await setupBridge();

    const actionP = bridge.action("click");
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "frame",
      frame: [[1]],
      score: 0,
      state: "IN_PROGRESS",
      action_counter: 1,
      max_actions: 200,
      win_score: 1.0,
      available_actions: ["click"],
    } satisfies BridgeFrameResponse);

    await actionP;

    const actionCmd = stdinData.find((s) => s.includes('"action":"click"'));
    expect(actionCmd).toBeDefined();
    const parsed = JSON.parse(actionCmd!);
    expect(parsed.x).toBeNull();
    expect(parsed.y).toBeNull();
  });

  it("lowercases action name (UP → up)", async () => {
    const { bridge, sendResponse, stdinData } = await setupBridge();

    const actionP = bridge.action("UP");
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "frame",
      frame: [[1]],
      score: 0,
      state: "IN_PROGRESS",
      action_counter: 1,
      max_actions: 200,
      win_score: 1.0,
      available_actions: ["up"],
    } satisfies BridgeFrameResponse);

    await actionP;

    const actionCmd = stdinData.find((s) => s.includes('"action":"up"'));
    expect(actionCmd).toBeDefined();
  });
});

// ── quit() ───────────────────────────────────────────────────────────────────

describe("GameBridge.quit()", () => {
  it("sends quit command and kills process", async () => {
    const { proc, sendResponse } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test",
      description: "",
      available_actions: ["up"],
    } satisfies BridgeInfoResponse);
    await startP;

    await bridge.quit();

    // Process should be killed
    expect(proc.kill).toHaveBeenCalled();
    expect(bridge.isAlive()).toBe(false);
  });

  it("no-ops if process is not running", async () => {
    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
    });

    // Should not throw
    await expect(bridge.quit()).resolves.toBeUndefined();
  });
});

// ── sendCommand when not running ─────────────────────────────────────────────

describe("GameBridge.sendCommand() error handling", () => {
  it("throws when process is not running", async () => {
    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
    });

    await expect(bridge.sendCommand({ type: "info" })).rejects.toThrow(
      "Process is not running",
    );
  });
});

// ── Timeout handling ─────────────────────────────────────────────────────────

describe("GameBridge timeout handling", () => {
  it("rejects after commandTimeoutMs if no response", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 100, // Very short timeout for testing
    });

    // start() will send an info command and wait for response
    // We don't send any response, so it should timeout
    await expect(bridge.start()).rejects.toThrow("Timed out");
  });
});

// ── Error response handling ──────────────────────────────────────────────────

describe("GameBridge error response handling", () => {
  it("rejects promise when Python returns error response", async () => {
    const { proc, sendResponse } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "error",
      message: "Game crashed: division by zero",
    });

    await expect(startP).rejects.toThrow("Game error");
  });
});

// ── getStderrLines() ─────────────────────────────────────────────────────────

describe("GameBridge.getStderrLines()", () => {
  it("returns empty array initially", () => {
    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
    });

    expect(bridge.getStderrLines()).toEqual([]);
  });

  it("returns defensive copy", () => {
    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
    });

    const lines1 = bridge.getStderrLines();
    const lines2 = bridge.getStderrLines();

    // Should be different array instances
    expect(lines1).not.toBe(lines2);
  });

  it("collects stderr output from process", async () => {
    const { proc, sendResponse, sendStderr } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));

    sendStderr("[bridge] Warning: deprecated API");
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test",
      description: "",
      available_actions: ["up"],
    } satisfies BridgeInfoResponse);

    await startP;

    const stderr = bridge.getStderrLines();
    expect(stderr.some((l) => l.includes("deprecated"))).toBe(true);
  });
});

// ── isAlive() ────────────────────────────────────────────────────────────────

describe("GameBridge.isAlive()", () => {
  it("returns false before start", () => {
    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
    });

    expect(bridge.isAlive()).toBe(false);
  });

  it("returns true after start", async () => {
    const { proc, sendResponse } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test",
      description: "",
      available_actions: ["up"],
    } satisfies BridgeInfoResponse);
    await startP;

    expect(bridge.isAlive()).toBe(true);
  });

  it("returns false after quit", async () => {
    const { proc, sendResponse } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    sendResponse({
      type: "info",
      game_id: "test_game",
      title: "Test",
      description: "",
      available_actions: ["up"],
    } satisfies BridgeInfoResponse);
    await startP;

    await bridge.quit();

    expect(bridge.isAlive()).toBe(false);
  });
});

// ── Process exit handling ────────────────────────────────────────────────────

describe("GameBridge process exit handling", () => {
  it("rejects pending promise on unexpected process exit", async () => {
    const { proc, emitExit } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));

    // Process exits before responding
    emitExit(1);

    await expect(startP).rejects.toThrow("exited unexpectedly");
  });

  it("rejects pending promise on spawn error", async () => {
    const { proc, emitError } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const bridge = new GameBridge("test_game", pyFilePath, {
      allowedRoot: tmpRoot,
      commandTimeoutMs: 5000,
    });

    const startP = bridge.start();
    await new Promise((r) => setTimeout(r, 10));

    emitError(new Error("python3 not found"));

    await expect(startP).rejects.toThrow("Spawn error");
  });
});

// ── fromGameId static factory ────────────────────────────────────────────────

describe("GameBridge.fromGameId()", () => {
  it("throws for non-existent gameId", () => {
    expect(() => GameBridge.fromGameId("nonexistent", tmpRoot)).toThrow(
      "not found",
    );
  });

  it("creates bridge for discovered game", () => {
    // tmpRoot has test_game/ with metadata.json + test_game.py
    const bridge = GameBridge.fromGameId("test_game", tmpRoot);
    expect(bridge).toBeInstanceOf(GameBridge);
  });
});
