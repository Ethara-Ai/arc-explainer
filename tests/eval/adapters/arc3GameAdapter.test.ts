/**
 * Unit tests for server/services/eval/adapters/arc3GameAdapter.ts
 * Mocks GameBridge to avoid spawning Python subprocesses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Arc3GameAdapter } from "../../../server/services/eval/adapters/arc3GameAdapter";
import type {
  BridgeInfoResponse,
  BridgeFrameResponse,
} from "../../../server/services/eval/adapters/types";
import { AsyncSemaphore } from "../../../server/services/eval/utils/concurrency";

// ── Mock GameBridge ──────────────────────────────────────────────────────────

function createMockBridge() {
  return {
    start: vi.fn<() => Promise<BridgeInfoResponse>>(),
    reset: vi.fn<() => Promise<BridgeFrameResponse>>(),
    action: vi.fn<(action: string) => Promise<BridgeFrameResponse>>(),
    getInfo: vi.fn<() => Promise<BridgeInfoResponse>>(),
    quit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isAlive: vi.fn<() => boolean>().mockReturnValue(true),
    getStderrLines: vi.fn<() => string[]>().mockReturnValue([]),
  };
}

function buildInfoResponse(
  overrides: Partial<BridgeInfoResponse> = {},
): BridgeInfoResponse {
  return {
    type: "info",
    game_id: "test_game",
    title: "Test Game",
    description: "A test game",
    available_actions: [
      "up",
      "down",
      "left",
      "right",
      "click",
      "select",
      "undo",
    ],
    total_levels: 3,
    ...overrides,
  };
}

function buildFrameResponse(
  overrides: Partial<BridgeFrameResponse> = {},
): BridgeFrameResponse {
  return {
    type: "frame",
    frame: [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    score: 0,
    state: "IN_PROGRESS",
    action_counter: 0,
    max_actions: 200,
    win_score: 1.0,
    available_actions: [
      "up",
      "down",
      "left",
      "right",
      "click",
      "select",
      "undo",
    ],
    levels_completed: 0,
    current_level: 0,
    total_levels: 3,
    text_observation: "Test observation",
    ...overrides,
  };
}

/**
 * Creates an Arc3GameAdapter with the mock bridge injected via private field override.
 * This avoids spawning real Python subprocesses.
 */
function createAdapterWithMockBridge(
  gameId: string = "test_game",
  mockBridge?: ReturnType<typeof createMockBridge>,
) {
  const bridge = mockBridge ?? createMockBridge();

  // Use Object.create but avoid intersecting with private fields (causes never)
  const adapter = Object.create(Arc3GameAdapter.prototype) as Arc3GameAdapter;

  // Set fields via defineProperty to bypass private access
  Object.defineProperty(adapter, "gameType", {
    value: "arc3",
    writable: false,
  });
  Object.defineProperty(adapter, "bridge", { value: bridge, writable: true });
  Object.defineProperty(adapter, "_gameId", { value: gameId, writable: true });
  Object.defineProperty(adapter, "_title", { value: "", writable: true });
  Object.defineProperty(adapter, "_totalLevelsFromInfo", {
    value: null,
    writable: true,
  });
  Object.defineProperty(adapter, "_lastFrame", { value: null, writable: true });
  Object.defineProperty(adapter, "_bridgeStarted", {
    value: false,
    writable: true,
  });
  Object.defineProperty(adapter, "_winScore", { value: 1.0, writable: true });
  Object.defineProperty(adapter, "commandSemaphore", {
    value: new AsyncSemaphore(1),
    writable: false,
  });

  return { adapter, bridge };
}

// ── Constructor / Properties ─────────────────────────────────────────────────

describe("Arc3GameAdapter properties", () => {
  it("has gameType arc3", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.gameType).toBe("arc3");
  });

  it("returns gameId from constructor", () => {
    const { adapter } = createAdapterWithMockBridge("ct01");
    expect(adapter.gameId).toBe("ct01");
  });

  it("title falls back to gameId before start", () => {
    const { adapter } = createAdapterWithMockBridge("ct01");
    expect(adapter.title).toBe("ct01");
  });

  it("level is null before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.level).toBeNull();
  });

  it("totalLevels is null before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.totalLevels).toBeNull();
  });

  it("winScore defaults to 1.0", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.winScore).toBe(1.0);
  });
});

// ── reset() ──────────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.reset()", () => {
  it("auto-starts bridge on first call", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse());

    await adapter.reset();

    expect(bridge.start).toHaveBeenCalledOnce();
    expect(bridge.reset).toHaveBeenCalledOnce();
  });

  it("does not call start again on subsequent resets", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse());

    await adapter.reset();
    await adapter.reset();

    expect(bridge.start).toHaveBeenCalledOnce();
    expect(bridge.reset).toHaveBeenCalledTimes(2);
  });

  it("updates title from info response", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(
      buildInfoResponse({ title: "Custom Title" }),
    );
    bridge.reset.mockResolvedValue(buildFrameResponse());

    await adapter.reset();

    expect(adapter.title).toBe("Custom Title");
  });

  it("falls back to gameId when info title is empty", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge("my_game");
    bridge.start.mockResolvedValue(buildInfoResponse({ title: "" }));
    bridge.reset.mockResolvedValue(buildFrameResponse());

    await adapter.reset();

    expect(adapter.title).toBe("my_game");
  });

  it("updates totalLevels from info response", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse({ total_levels: 5 }));
    bridge.reset.mockResolvedValue(buildFrameResponse({ total_levels: 5 }));

    await adapter.reset();

    expect(adapter.totalLevels).toBe(5);
  });

  it("updates winScore from frame response", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse({ win_score: 3.0 }));

    await adapter.reset();

    expect(adapter.winScore).toBe(3.0);
  });
});

// ── step() ───────────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.step()", () => {
  it("throws before reset is called", async () => {
    const { adapter } = createAdapterWithMockBridge();

    await expect(adapter.step("up")).rejects.toThrow("Must call reset()");
  });

  it("delegates action to bridge.action", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse());
    bridge.action.mockResolvedValue(
      buildFrameResponse({ score: 0.5, action_counter: 1 }),
    );

    await adapter.reset();
    await adapter.step("up");

    expect(bridge.action).toHaveBeenCalledWith("up");
  });

  it("updates winScore from step frame response", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse());
    bridge.action.mockResolvedValue(buildFrameResponse({ win_score: 5.0 }));

    await adapter.reset();
    await adapter.step("click 3 4");

    expect(adapter.winScore).toBe(5.0);
  });
});

// ── getScore() ───────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.getScore()", () => {
  it("returns 0 before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.getScore()).toBe(0);
  });

  it("returns levels_completed / total_levels", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({ levels_completed: 1, total_levels: 4 }),
    );

    await adapter.reset();

    expect(adapter.getScore()).toBe(0.25);
  });

  it("caps at 1.0 when levels_completed exceeds total_levels", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({ levels_completed: 5, total_levels: 3 }),
    );

    await adapter.reset();

    expect(adapter.getScore()).toBe(1.0);
  });

  it("uses total_levels=1 when total_levels is 0 to avoid division by zero", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse({ total_levels: 0 }));
    bridge.reset.mockResolvedValue(
      buildFrameResponse({ levels_completed: 0, total_levels: 0 }),
    );

    await adapter.reset();

    // Math.max(0, 1) = 1, so 0/1 = 0
    expect(adapter.getScore()).toBe(0);
  });

  it("handles missing levels_completed (defaults to 0)", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    const frame = buildFrameResponse();
    delete (frame as unknown as Record<string, unknown>).levels_completed;
    bridge.reset.mockResolvedValue(frame);

    await adapter.reset();

    expect(adapter.getScore()).toBe(0);
  });
});

// ── getState() ───────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.getState()", () => {
  it("returns NOT_PLAYED before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.getState()).toBe("NOT_PLAYED");
  });

  it("maps IN_PROGRESS correctly", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({ state: "IN_PROGRESS" }),
    );

    await adapter.reset();

    expect(adapter.getState()).toBe("IN_PROGRESS");
  });

  it("maps WIN correctly", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse({ state: "WIN" }));

    await adapter.reset();

    expect(adapter.getState()).toBe("WIN");
  });

  it("maps GAME_OVER correctly", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse({ state: "GAME_OVER" }));

    await adapter.reset();

    expect(adapter.getState()).toBe("GAME_OVER");
  });

  it("cycle guard: returns WIN when all levels completed regardless of engine state", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse({ total_levels: 3 }));
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        state: "IN_PROGRESS",
        levels_completed: 3,
        total_levels: 3,
      }),
    );

    await adapter.reset();

    expect(adapter.getState()).toBe("WIN");
  });

  it("defaults unknown state strings to IN_PROGRESS", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({ state: "UNKNOWN_STATE" }),
    );

    await adapter.reset();

    expect(adapter.getState()).toBe("IN_PROGRESS");
  });
});

// ── isDone() ─────────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.isDone()", () => {
  it("returns false before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.isDone()).toBe(false);
  });

  it("returns false on GAME_OVER (critical: GAME_OVER is NOT terminal)", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        state: "GAME_OVER",
        levels_completed: 0,
        total_levels: 3,
      }),
    );

    await adapter.reset();

    expect(adapter.isDone()).toBe(false);
  });

  it("returns true on WIN state", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        state: "WIN",
        levels_completed: 0,
        total_levels: 3,
      }),
    );

    await adapter.reset();

    expect(adapter.isDone()).toBe(true);
  });

  it("returns true when all levels are completed", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse({ total_levels: 3 }));
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        state: "IN_PROGRESS",
        levels_completed: 3,
        total_levels: 3,
      }),
    );

    await adapter.reset();

    expect(adapter.isDone()).toBe(true);
  });

  it("returns false on IN_PROGRESS with incomplete levels", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        state: "IN_PROGRESS",
        levels_completed: 1,
        total_levels: 3,
      }),
    );

    await adapter.reset();

    expect(adapter.isDone()).toBe(false);
  });
});

// ── getAvailableActions() ────────────────────────────────────────────────────

describe("Arc3GameAdapter.getAvailableActions()", () => {
  it("returns fallback action set before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    const actions = adapter.getAvailableActions();

    expect(actions).toContain("up");
    expect(actions).toContain("down");
    expect(actions).toContain("left");
    expect(actions).toContain("right");
    expect(actions).toContain("select");
    expect(actions).toContain("reset");
    expect(actions).toContain("click");
    expect(actions).toContain("undo");
  });

  it("returns only reset on GAME_OVER", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse({ state: "GAME_OVER" }));

    await adapter.reset();

    expect(adapter.getAvailableActions()).toEqual(["reset"]);
  });

  it("always includes reset in normal play", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        available_actions: ["up", "down"],
      }),
    );

    await adapter.reset();

    const actions = adapter.getAvailableActions();
    expect(actions).toContain("reset");
    expect(actions).toContain("up");
    expect(actions).toContain("down");
  });

  it("does not duplicate reset if bridge already includes it", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        available_actions: ["up", "reset"],
      }),
    );

    await adapter.reset();

    const actions = adapter.getAvailableActions();
    const resetCount = actions.filter((a) => a === "reset").length;
    expect(resetCount).toBe(1);
  });

  it("returns fallback set when bridge returns empty actions", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({ available_actions: [] }),
    );

    await adapter.reset();

    const actions = adapter.getAvailableActions();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).toContain("up");
  });
});

// ── renderText() ─────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.renderText()", () => {
  it("returns placeholder text before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    const text = adapter.renderText();
    expect(text).toContain("no frame");
  });

  it("renders grid with header after reset", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        frame: [
          [0, 1],
          [2, 3],
        ],
        current_level: 1,
        total_levels: 3,
      }),
    );

    await adapter.reset();
    const text = adapter.renderText();

    expect(text).toContain("Grid (2x2)");
    expect(text).toContain("Level 1/3");
    expect(text).toContain("Score: 0%");
    expect(text).toContain("IN_PROGRESS");
  });

  it("handles empty frame (GAME_OVER produces empty frames)", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        frame: [],
        state: "GAME_OVER",
      }),
    );

    await adapter.reset();
    const text = adapter.renderText();

    expect(text).toContain("Grid (0x0)");
    expect(text).toContain("GAME_OVER");
  });

  it("handles 3D frame array (takes last element)", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        frame: [
          [
            [0, 1],
            [2, 3],
          ],
          [
            [4, 5],
            [6, 7],
          ],
        ] as unknown as number[][],
      }),
    );

    await adapter.reset();
    const text = adapter.renderText();

    // Should extract last 2D frame from 3D array
    expect(text).toContain("Grid (2x2)");
    // Values from the last frame [4,5],[6,7]
    expect(text).toContain("4");
    expect(text).toContain("7");
  });

  it("handles 4D frame array (takes last twice)", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(
      buildFrameResponse({
        frame: [
          [
            [
              [0, 1],
              [2, 3],
            ],
          ],
          [
            [
              [10, 11],
              [12, 13],
            ],
          ],
        ] as unknown as number[][],
      }),
    );

    await adapter.reset();
    const text = adapter.renderText();

    expect(text).toContain("Grid (2x2)");
    expect(text).toContain("10");
  });
});

// ── getGrid() ────────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.getGrid()", () => {
  it("returns null before reset", () => {
    const { adapter } = createAdapterWithMockBridge();
    expect(adapter.getGrid()).toBeNull();
  });

  it("returns raw frame data after reset", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    const frame = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    bridge.reset.mockResolvedValue(buildFrameResponse({ frame }));

    await adapter.reset();

    expect(adapter.getGrid()).toEqual(frame);
  });
});

// ── getMetadata() ────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.getMetadata()", () => {
  it("returns correct metadata structure", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge("ct01");
    bridge.start.mockResolvedValue(
      buildInfoResponse({ title: "Color Test 01", total_levels: 4 }),
    );
    bridge.reset.mockResolvedValue(buildFrameResponse({ total_levels: 4 }));

    await adapter.reset();
    const meta = adapter.getMetadata();

    expect(meta.gameId).toBe("ct01");
    expect(meta.gameType).toBe("arc3");
    expect(meta.title).toBe("Color Test 01");
    expect(meta.totalLevels).toBe(4);
    expect(meta.availableActions.length).toBeGreaterThan(0);
  });
});

// ── dispose() ────────────────────────────────────────────────────────────────

describe("Arc3GameAdapter.dispose()", () => {
  it("calls bridge.quit", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse());

    await adapter.reset();
    await adapter.dispose();

    expect(bridge.quit).toHaveBeenCalledOnce();
  });

  it("resets internal state after dispose", async () => {
    const { adapter, bridge } = createAdapterWithMockBridge();
    bridge.start.mockResolvedValue(buildInfoResponse());
    bridge.reset.mockResolvedValue(buildFrameResponse());

    await adapter.reset();
    await adapter.dispose();

    // After dispose, getState should return NOT_PLAYED (lastFrame is null)
    expect(adapter.getState()).toBe("NOT_PLAYED");
    expect(adapter.getScore()).toBe(0);
    expect(adapter.level).toBeNull();
  });
});

// ── renderPngBase64() ────────────────────────────────────────────────────────

describe("Arc3GameAdapter.renderPngBase64()", () => {
  it("returns null (not implemented in TS)", async () => {
    const { adapter } = createAdapterWithMockBridge();
    const result = await adapter.renderPngBase64();
    expect(result).toBeNull();
  });
});
