/**
 * DEEP EDGE-CASE HARNESS TEST
 * ============================
 * Goes far beyond the basic lifecycle test. For each game, exercises:
 *
 *   1. BOOTSTRAP       — create adapter, validate info fields
 *   2. RESET           — validate initial state, score=0, actions non-empty, frame valid
 *   3. ALL ACTIONS     — step() with EVERY available action (up/down/left/right/select/click/undo)
 *   4. CLICK WITH COORDS — step("click 5 5") if click is in available actions
 *   5. RAPID FIRE      — 15 random actions in quick succession
 *   6. UNDO            — step("undo") after actions, verify no crash
 *   7. TRIPLE RESET    — reset 3× in a row, verify state is clean each time
 *   8. GAME_OVER RECOVERY — if we hit GAME_OVER, verify reset() recovers
 *   9. RENDER VALID    — frame is 2D grid, values 0-15, dimensions > 0
 *  10. STATE INTEGRITY — score in [0,1], state is valid enum, text_observation exists
 *  11. DISPOSE         — clean shutdown
 *
 * Usage:
 *   npx tsx tests/eval/harness/harness_deep_test.ts
 */

import "dotenv/config";

import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, statSync, writeFileSync } from "fs";
import { Arc3GameAdapter } from "../../../server/services/eval/adapters/arc3GameAdapter";
import { discoverGames } from "../../../server/services/eval/adapters/types";
import type { GameState } from "../../../server/services/eval/adapters/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration ────────────────────────────────────────────────────────────

const GAMES_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "puzzle-environments",
  "ARC-AGI-3",
  "environment_files",
);
const OUTPUT_FILE = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "TS_DEEP_TEST_RESULTS.md",
);
const BRIDGE_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  test: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  detail: string;
  durationMs: number;
}

interface GameDeepResult {
  gameId: string;
  tests: TestResult[];
  overallStatus: "PASS" | "FAIL";
  warnings: string[];
  totalDurationMs: number;
}

const VALID_STATES: Set<string> = new Set([
  "IN_PROGRESS",
  "WIN",
  "GAME_OVER",
  "NOT_PLAYED",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return performance.now();
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function truncate(s: string, max: number = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... (${s.length} chars total)`;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ── Test Runner for a Single Game ────────────────────────────────────────────

async function deepTestGame(
  gameId: string,
  pyFilePath: string,
): Promise<GameDeepResult> {
  const result: GameDeepResult = {
    gameId,
    tests: [],
    overallStatus: "PASS",
    warnings: [],
    totalDurationMs: 0,
  };

  const gameStart = now();
  let adapter: Arc3GameAdapter | null = null;
  let aborted = false;

  function addTest(
    test: string,
    status: "PASS" | "FAIL" | "WARN" | "SKIP",
    detail: string,
    durationMs: number,
  ) {
    result.tests.push({ test, status, detail, durationMs });
    if (status === "FAIL") {
      result.overallStatus = "FAIL";
      aborted = true;
    }
    if (status === "WARN") {
      result.warnings.push(`${test}: ${detail}`);
    }
  }

  // ── T1: BOOTSTRAP ──────────────────────────────────────────────────────

  const t1 = now();
  try {
    adapter = await Arc3GameAdapter.create(gameId, pyFilePath, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    // Validate info fields
    const title = adapter.title;
    const totalLevels = adapter.totalLevels;

    if (!title || title.length === 0) {
      addTest("T1_BOOTSTRAP", "WARN", "title is empty", elapsed(t1));
    } else {
      addTest(
        "T1_BOOTSTRAP",
        "PASS",
        `title="${title}" totalLevels=${totalLevels}`,
        elapsed(t1),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addTest("T1_BOOTSTRAP", "FAIL", msg, elapsed(t1));
  }

  if (aborted || !adapter) {
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T2: INITIAL RESET + STATE VALIDATION ──────────────────────────────

  const t2 = now();
  try {
    await adapter.reset();

    const actions = adapter.getAvailableActions();
    const state = adapter.getState();
    const score = adapter.getScore();
    const text = adapter.renderText();
    const grid = adapter.getGrid();

    const issues: string[] = [];

    // Validate state
    if (!VALID_STATES.has(state)) {
      issues.push(`invalid state "${state}"`);
    }
    if (state !== "IN_PROGRESS") {
      issues.push(`expected IN_PROGRESS after reset, got "${state}"`);
    }

    // Validate score
    if (score !== 0) {
      issues.push(`expected score=0 after reset, got ${score}`);
    }

    // Validate actions
    if (!actions || actions.length === 0) {
      issues.push("no available actions after reset");
    }

    // Validate text observation
    if (!text || text.length === 0) {
      issues.push("empty renderText after reset");
    }

    // Validate grid
    if (grid === null) {
      issues.push("grid is null after reset");
    } else if (Array.isArray(grid)) {
      const outerLen = grid.length;
      if (outerLen === 0) {
        issues.push("grid is empty array");
      } else {
        // Check if 2D
        const firstRow = grid[0];
        if (Array.isArray(firstRow) && typeof firstRow[0] === "number") {
          // 2D grid - validate dimensions and values
          const height = outerLen;
          const width = (firstRow as number[]).length;
          if (width === 0) {
            issues.push("grid width is 0");
          }
          // Check value range (0-15 is standard ARC color palette)
          let outOfRange = 0;
          for (const row of grid as number[][]) {
            for (const val of row) {
              if (val < 0 || val > 15) outOfRange++;
            }
          }
          if (outOfRange > 0) {
            issues.push(`${outOfRange} grid cells outside 0-15 range`);
          }
        }
      }
    }

    if (issues.length > 0) {
      addTest(
        "T2_RESET_VALIDATE",
        "WARN",
        `actions=[${actions.join(",")}] issues: ${issues.join("; ")}`,
        elapsed(t2),
      );
    } else {
      addTest(
        "T2_RESET_VALIDATE",
        "PASS",
        `state=${state} score=${score} actions=[${actions.join(",")}] gridOK textLen=${text.length}`,
        elapsed(t2),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addTest("T2_RESET_VALIDATE", "FAIL", msg, elapsed(t2));
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T3: EVERY AVAILABLE ACTION ─────────────────────────────────────────

  {
    const actions = adapter.getAvailableActions();
    const nonResetActions = actions.filter((a) => a.toLowerCase() !== "reset");

    for (const action of nonResetActions) {
      const t3 = now();
      try {
        await adapter.step(action);
        const state = adapter.getState();
        const score = adapter.getScore();

        // Validate score is in range
        if (score < 0 || score > 1) {
          addTest(
            `T3_ACTION_${action}`,
            "WARN",
            `score ${score} outside [0,1]`,
            elapsed(t3),
          );
        } else if (!VALID_STATES.has(state)) {
          addTest(
            `T3_ACTION_${action}`,
            "WARN",
            `invalid state "${state}"`,
            elapsed(t3),
          );
        } else {
          addTest(
            `T3_ACTION_${action}`,
            "PASS",
            `state=${state} score=${score}`,
            elapsed(t3),
          );
        }

        // If GAME_OVER or WIN, stop further action tests
        if (state === "GAME_OVER" || state === "WIN") break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addTest(`T3_ACTION_${action}`, "FAIL", msg, elapsed(t3));
        break;
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T4: CLICK WITH COORDINATES ─────────────────────────────────────────

  {
    // Reset before click test
    const treset = now();
    try {
      await adapter.reset();
      addTest("T4_PRE_CLICK_RESET", "PASS", "reset OK", elapsed(treset));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T4_PRE_CLICK_RESET", "FAIL", msg, elapsed(treset));
    }

    if (!aborted) {
      const actions = adapter.getAvailableActions();
      const hasClick = actions.some((a) => a.toLowerCase() === "click");

      if (hasClick) {
        // Test click with coordinates
        const t4 = now();
        try {
          await adapter.step("click 5 5");
          const state = adapter.getState();
          addTest(
            "T4_CLICK_COORDS",
            "PASS",
            `click 5 5 → state=${state}`,
            elapsed(t4),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addTest("T4_CLICK_COORDS", "FAIL", msg, elapsed(t4));
        }

        // Test click with edge coordinates
        if (!aborted) {
          const t4b = now();
          try {
            await adapter.step("click 0 0");
            const state = adapter.getState();
            addTest(
              "T4_CLICK_ORIGIN",
              "PASS",
              `click 0 0 → state=${state}`,
              elapsed(t4b),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addTest("T4_CLICK_ORIGIN", "FAIL", msg, elapsed(t4b));
          }
        }

        // Test bare click (no coordinates) — previously a latent bug
        if (!aborted) {
          const t4c = now();
          try {
            await adapter.step("click");
            const state = adapter.getState();
            addTest(
              "T4_BARE_CLICK",
              "PASS",
              `bare click → state=${state}`,
              elapsed(t4c),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addTest("T4_BARE_CLICK", "FAIL", msg, elapsed(t4c));
          }
        }
      } else {
        addTest("T4_CLICK_COORDS", "SKIP", "click not in available actions", 0);
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T5: RAPID-FIRE 15 RANDOM ACTIONS ──────────────────────────────────

  {
    const treset = now();
    try {
      await adapter.reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T5_RAPID_FIRE_RESET", "FAIL", msg, elapsed(treset));
    }

    if (!aborted) {
      const t5 = now();
      const actions = adapter
        .getAvailableActions()
        .filter((a) => a.toLowerCase() !== "reset");
      let rapidFails = 0;
      let rapidOk = 0;
      let hitTerminal = false;

      for (let i = 0; i < 15 && !hitTerminal; i++) {
        const action = actions.length > 0 ? pickRandom(actions) : "up";
        try {
          await adapter.step(action);
          rapidOk++;
          const state = adapter.getState();
          if (state === "GAME_OVER" || state === "WIN") {
            hitTerminal = true;
            // Try to recover with reset if GAME_OVER
            if (state === "GAME_OVER") {
              try {
                await adapter.reset();
                rapidOk++;
              } catch {
                rapidFails++;
              }
            }
          }
        } catch (err) {
          rapidFails++;
          // Don't abort on individual step failures in rapid fire
          break;
        }
      }

      if (rapidFails > 0) {
        addTest(
          "T5_RAPID_FIRE",
          "FAIL",
          `${rapidOk} OK, ${rapidFails} failed out of 15 rapid actions`,
          elapsed(t5),
        );
      } else {
        addTest(
          "T5_RAPID_FIRE",
          "PASS",
          `${rapidOk} steps OK (terminal hit: ${hitTerminal})`,
          elapsed(t5),
        );
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T6: UNDO AFTER ACTIONS ─────────────────────────────────────────────

  {
    const treset = now();
    try {
      await adapter.reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T6_UNDO_RESET", "FAIL", msg, elapsed(treset));
    }

    if (!aborted) {
      const actions = adapter.getAvailableActions();
      const hasUndo = actions.some((a) => a.toLowerCase() === "undo");

      if (hasUndo) {
        // Do a step first, then undo
        const t6 = now();
        try {
          await adapter.step("up");
          const stateBeforeUndo = adapter.getState();
          await adapter.step("undo");
          const stateAfterUndo = adapter.getState();
          addTest(
            "T6_UNDO",
            "PASS",
            `up→undo: state ${stateBeforeUndo}→${stateAfterUndo}`,
            elapsed(t6),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addTest("T6_UNDO", "FAIL", msg, elapsed(t6));
        }
      } else {
        addTest("T6_UNDO", "SKIP", "undo not in available actions", 0);
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T7: TRIPLE RESET ──────────────────────────────────────────────────

  {
    const t7 = now();
    let tripleOk = true;
    const scores: number[] = [];
    const states: string[] = [];

    for (let i = 0; i < 3; i++) {
      try {
        await adapter.reset();
        scores.push(adapter.getScore());
        states.push(adapter.getState());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addTest(
          "T7_TRIPLE_RESET",
          "FAIL",
          `reset #${i + 1} failed: ${msg}`,
          elapsed(t7),
        );
        tripleOk = false;
        break;
      }
    }

    if (tripleOk) {
      // Validate all resets give score=0 and IN_PROGRESS
      const allZero = scores.every((s) => s === 0);
      const allInProgress = states.every((s) => s === "IN_PROGRESS");
      const issues: string[] = [];
      if (!allZero) issues.push(`scores not all 0: [${scores.join(",")}]`);
      if (!allInProgress)
        issues.push(`states not all IN_PROGRESS: [${states.join(",")}]`);

      if (issues.length > 0) {
        addTest("T7_TRIPLE_RESET", "WARN", issues.join("; "), elapsed(t7));
      } else {
        addTest(
          "T7_TRIPLE_RESET",
          "PASS",
          "3× reset all gave score=0 state=IN_PROGRESS",
          elapsed(t7),
        );
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T8: SELECT ACTION ──────────────────────────────────────────────────

  {
    const actions = adapter.getAvailableActions();
    const hasSelect = actions.some((a) => a.toLowerCase() === "select");

    if (hasSelect) {
      const t8 = now();
      try {
        await adapter.step("select");
        const state = adapter.getState();
        addTest("T8_SELECT", "PASS", `select → state=${state}`, elapsed(t8));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addTest("T8_SELECT", "FAIL", msg, elapsed(t8));
      }
    } else {
      addTest("T8_SELECT", "SKIP", "select not in available actions", 0);
    }
  }

  // ── T9: RENDER FRAME VALIDATION ────────────────────────────────────────

  {
    const t9 = now();
    try {
      await adapter.reset();
      const grid = adapter.getGrid();
      const text = adapter.renderText();

      const issues: string[] = [];

      if (grid === null) {
        issues.push("grid is null");
      } else if (Array.isArray(grid)) {
        // Recursively find the inner 2D array
        let grid2d: number[][] | null = null;
        if (Array.isArray(grid[0]) && typeof (grid[0] as any)[0] === "number") {
          grid2d = grid as unknown as number[][];
        } else if (
          Array.isArray(grid[0]) &&
          Array.isArray((grid[0] as any)[0])
        ) {
          // 3D — take last
          const lastFrame = grid[grid.length - 1] as unknown;
          if (Array.isArray(lastFrame)) grid2d = lastFrame as number[][];
        }

        if (grid2d) {
          const h = grid2d.length;
          const w = grid2d[0]?.length ?? 0;
          if (h === 0 || w === 0) {
            issues.push(`grid dimensions ${w}x${h} — zero dimension`);
          }
          // Check consistency: all rows same width
          const widths = new Set(grid2d.map((r) => r.length));
          if (widths.size > 1) {
            issues.push(`inconsistent row widths: ${[...widths].join(",")}`);
          }
          // Check value range
          let minVal = Infinity;
          let maxVal = -Infinity;
          for (const row of grid2d) {
            for (const v of row) {
              if (v < minVal) minVal = v;
              if (v > maxVal) maxVal = v;
            }
          }
          if (minVal < 0) issues.push(`min grid value ${minVal} < 0`);
          if (maxVal > 15)
            issues.push(
              `max grid value ${maxVal} > 15 (expected 0-15 ARC palette)`,
            );
        }
      }

      // Validate text contains expected header pattern
      if (text && !text.includes("Grid") && !text.includes("no frame")) {
        issues.push("renderText missing 'Grid' header");
      }

      if (issues.length > 0) {
        addTest("T9_RENDER_VALIDATE", "WARN", issues.join("; "), elapsed(t9));
      } else {
        addTest(
          "T9_RENDER_VALIDATE",
          "PASS",
          `grid and text render valid`,
          elapsed(t9),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T9_RENDER_VALIDATE", "FAIL", msg, elapsed(t9));
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T10: ACTIONS AFTER GAME_OVER ────────────────────────────────────────

  {
    // Try to reach GAME_OVER by doing many steps, then test recovery
    const t10 = now();
    try {
      await adapter.reset();
      let hitGameOver = false;

      // Do up to 50 random steps trying to reach GAME_OVER
      const actions = adapter
        .getAvailableActions()
        .filter((a) => a.toLowerCase() !== "reset");
      for (let i = 0; i < 50; i++) {
        const action = actions.length > 0 ? pickRandom(actions) : "up";
        try {
          await adapter.step(action);
        } catch {
          break;
        }
        const state = adapter.getState();
        if (state === "GAME_OVER") {
          hitGameOver = true;
          break;
        }
        if (state === "WIN") break;
      }

      if (hitGameOver) {
        // Verify only reset is available in GAME_OVER
        const goActions = adapter.getAvailableActions();
        const onlyReset = goActions.length === 1 && goActions[0] === "reset";

        // Test that reset recovers from GAME_OVER
        await adapter.reset();
        const stateAfterReset = adapter.getState();
        const scoreAfterReset = adapter.getScore();

        if (stateAfterReset !== "IN_PROGRESS") {
          addTest(
            "T10_GAMEOVER_RECOVER",
            "WARN",
            `after GAME_OVER+reset: state=${stateAfterReset} (expected IN_PROGRESS)`,
            elapsed(t10),
          );
        } else {
          addTest(
            "T10_GAMEOVER_RECOVER",
            "PASS",
            `hit GAME_OVER → reset → state=${stateAfterReset} score=${scoreAfterReset} onlyResetAvail=${onlyReset}`,
            elapsed(t10),
          );
        }
      } else {
        addTest(
          "T10_GAMEOVER_RECOVER",
          "SKIP",
          "did not reach GAME_OVER in 50 steps",
          elapsed(t10),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T10_GAMEOVER_RECOVER", "FAIL", msg, elapsed(t10));
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T11: METADATA CONSISTENCY ──────────────────────────────────────────

  {
    const t11 = now();
    try {
      await adapter.reset();
      const meta = adapter.getMetadata();
      const issues: string[] = [];

      if (meta.gameId !== gameId) {
        issues.push(`gameId mismatch: ${meta.gameId} vs ${gameId}`);
      }
      if (meta.gameType !== "arc3") {
        issues.push(`gameType: ${meta.gameType} (expected arc3)`);
      }
      if (!meta.availableActions || meta.availableActions.length === 0) {
        issues.push("metadata has no availableActions");
      }

      if (issues.length > 0) {
        addTest("T11_METADATA", "WARN", issues.join("; "), elapsed(t11));
      } else {
        addTest(
          "T11_METADATA",
          "PASS",
          `gameId=${meta.gameId} type=${meta.gameType} actions=${meta.availableActions.length}`,
          elapsed(t11),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T11_METADATA", "FAIL", msg, elapsed(t11));
    }
  }

  // ── T12: SCORE MONOTONICITY OVER MULTIPLE STEPS ────────────────────────

  {
    const t12 = now();
    try {
      await adapter.reset();
      let prevScore = adapter.getScore();
      let scoreDecreased = false;
      let scoreHistory: number[] = [prevScore];

      const actions = adapter
        .getAvailableActions()
        .filter((a) => a.toLowerCase() !== "reset");

      for (let i = 0; i < 20; i++) {
        const action = actions.length > 0 ? pickRandom(actions) : "up";
        try {
          await adapter.step(action);
        } catch {
          break;
        }
        const curScore = adapter.getScore();
        scoreHistory.push(curScore);
        if (curScore < prevScore) {
          scoreDecreased = true;
        }
        prevScore = curScore;
        const state = adapter.getState();
        if (state === "WIN" || state === "GAME_OVER") break;
      }

      if (scoreDecreased) {
        addTest(
          "T12_SCORE_MONOTONIC",
          "WARN",
          `score decreased during play: [${scoreHistory.join(",")}]`,
          elapsed(t12),
        );
      } else {
        addTest(
          "T12_SCORE_MONOTONIC",
          "PASS",
          `score non-decreasing over ${scoreHistory.length} observations: max=${Math.max(...scoreHistory)}`,
          elapsed(t12),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest("T12_SCORE_MONOTONIC", "FAIL", msg, elapsed(t12));
    }
  }

  // ── T13: STEP AFTER DISPOSE SHOULD ERROR ───────────────────────────────

  // We'll do this test as the very last one since it disposes the adapter

  // ── DISPOSE ────────────────────────────────────────────────────────────

  {
    const tDispose = now();
    try {
      const bridge = (adapter as any).bridge;
      if (bridge && typeof bridge.getStderrLines === "function") {
        const stderr = bridge.getStderrLines();
        if (stderr.length > 0) {
          result.warnings.push(
            `stderr: ${stderr.length} lines — ${truncate(stderr.join(" | "), 200)}`,
          );
        }
      }

      await adapter.dispose();
      addTest("T13_DISPOSE", "PASS", "cleanly disposed", elapsed(tDispose));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTest(
        "T13_DISPOSE",
        "WARN",
        `dispose error: ${msg}`,
        elapsed(tDispose),
      );
    }
  }

  result.totalDurationMs = elapsed(gameStart);
  return result;
}

async function safeDispose(adapter: Arc3GameAdapter | null) {
  if (!adapter) return;
  try {
    await adapter.dispose();
  } catch {
    // ignore
  }
}

// ── Report Generation ────────────────────────────────────────────────────────

function generateReport(results: GameDeepResult[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  const passed = results.filter((r) => r.overallStatus === "PASS");
  const failed = results.filter((r) => r.overallStatus === "FAIL");
  const withWarnings = results.filter((r) => r.warnings.length > 0);

  const totalTests = results.reduce((sum, r) => sum + r.tests.length, 0);
  const totalFails = results.reduce(
    (sum, r) => sum + r.tests.filter((t) => t.status === "FAIL").length,
    0,
  );
  const totalWarns = results.reduce(
    (sum, r) => sum + r.tests.filter((t) => t.status === "WARN").length,
    0,
  );
  const totalPasses = results.reduce(
    (sum, r) => sum + r.tests.filter((t) => t.status === "PASS").length,
    0,
  );
  const totalSkips = results.reduce(
    (sum, r) => sum + r.tests.filter((t) => t.status === "SKIP").length,
    0,
  );

  lines.push("# Deep Edge-Case Test Results");
  lines.push("");
  lines.push(`**Generated:** ${timestamp}`);
  lines.push(
    `**Method:** Real \`GameBridge\` + \`Arc3GameAdapter\` — deep edge-case testing`,
  );
  lines.push(`**Games directory:** \`${GAMES_DIR}\``);
  lines.push(
    `**Python binary:** \`${process.env["PYTHON_BIN"] || "python3"}\``,
  );
  lines.push(`**Bridge timeout:** ${BRIDGE_TIMEOUT_MS}ms per command`);
  lines.push("");
  lines.push("## Overall Summary");
  lines.push("");
  lines.push(`- **Games tested:** ${results.length}`);
  lines.push(`- **Games PASS:** ${passed.length}`);
  lines.push(`- **Games FAIL:** ${failed.length}`);
  lines.push(`- **Games with warnings:** ${withWarnings.length}`);
  lines.push("");
  lines.push(`- **Total individual tests:** ${totalTests}`);
  lines.push(`- **Tests PASS:** ${totalPasses}`);
  lines.push(`- **Tests FAIL:** ${totalFails}`);
  lines.push(`- **Tests WARN:** ${totalWarns}`);
  lines.push(`- **Tests SKIP:** ${totalSkips}`);
  lines.push("");

  // ── Game Summary Table ──────────────────────────────────────────────────

  lines.push("## Game Summary Table");
  lines.push("");
  lines.push(
    "| # | Game | Status | Tests | Pass | Fail | Warn | Skip | Warnings | Duration |",
  );
  lines.push(
    "|---|------|--------|-------|------|------|------|------|----------|----------|",
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const status = r.overallStatus === "PASS" ? "PASS" : "**FAIL**";
    const tc = r.tests.length;
    const tp = r.tests.filter((t) => t.status === "PASS").length;
    const tf = r.tests.filter((t) => t.status === "FAIL").length;
    const tw = r.tests.filter((t) => t.status === "WARN").length;
    const ts = r.tests.filter((t) => t.status === "SKIP").length;
    const warns = r.warnings.length > 0 ? truncate(r.warnings[0]!, 60) : "-";
    lines.push(
      `| ${i + 1} | ${r.gameId} | ${status} | ${tc} | ${tp} | ${tf} | ${tw} | ${ts} | ${warns} | ${r.totalDurationMs}ms |`,
    );
  }

  lines.push("");

  // ── Failed Games Detail ─────────────────────────────────────────────────

  if (failed.length > 0) {
    lines.push("## Failed Games");
    lines.push("");

    for (const r of failed) {
      lines.push(`### ${r.gameId} — FAIL`);
      lines.push("");
      for (const t of r.tests) {
        const icon =
          t.status === "PASS"
            ? "OK"
            : t.status === "FAIL"
              ? "**FAIL**"
              : t.status === "WARN"
                ? "WARN"
                : "SKIP";
        lines.push(`- ${t.test}: ${icon} — ${truncate(t.detail, 120)}`);
      }
      lines.push("");
    }
  }

  // ── Warnings Detail ─────────────────────────────────────────────────────

  if (withWarnings.length > 0) {
    lines.push("## Games with Warnings");
    lines.push("");

    for (const r of withWarnings) {
      if (r.overallStatus === "FAIL") continue; // Already shown above
      lines.push(`### ${r.gameId}`);
      lines.push("");
      for (const w of r.warnings) {
        lines.push(`- ${w}`);
      }
      lines.push("");
    }
  }

  // ── Detailed Per-Game Logs ──────────────────────────────────────────────

  lines.push("## Detailed Per-Game Test Logs");
  lines.push("");

  for (const r of results) {
    const statusBadge = r.overallStatus === "PASS" ? "PASS" : "FAIL";
    lines.push(`### ${r.gameId} — ${statusBadge}`);
    lines.push("");
    lines.push("| Test | Status | Detail | Duration |");
    lines.push("|------|--------|--------|----------|");

    for (const t of r.tests) {
      const statusStr =
        t.status === "PASS"
          ? "PASS"
          : t.status === "FAIL"
            ? "**FAIL**"
            : t.status === "WARN"
              ? "WARN"
              : "SKIP";
      const detail = truncate(t.detail, 100)
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      lines.push(
        `| ${t.test} | ${statusStr} | ${detail} | ${t.durationMs}ms |`,
      );
    }

    lines.push("");

    if (r.warnings.length > 0) {
      lines.push("**Warnings:**");
      for (const w of r.warnings) {
        lines.push(`- ${truncate(w, 200)}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // ── Environment ────────────────────────────────────────────────────────

  lines.push("## Environment");
  lines.push("");
  lines.push("```");
  lines.push(`Node.js:      ${process.version}`);
  lines.push(`Platform:     ${process.platform} ${process.arch}`);
  lines.push(
    `PYTHON_BIN:   ${process.env["PYTHON_BIN"] || "(not set — using python3)"}`,
  );
  lines.push(`Games dir:    ${GAMES_DIR}`);
  lines.push(`Timestamp:    ${timestamp}`);
  lines.push("```");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log("║   DEEP EDGE-CASE HARNESS TEST — All Actions, All Paths     ║");
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log();
  console.log(`Games directory: ${GAMES_DIR}`);
  console.log(
    `PYTHON_BIN:     ${process.env["PYTHON_BIN"] || "(default python3)"}`,
  );
  console.log();

  const discovered = discoverGames(GAMES_DIR);
  console.log(`Discovered ${discovered.length} games`);

  if (discovered.length === 0) {
    console.error("ERROR: No games discovered. Check GAMES_DIR path.");
    process.exit(1);
  }

  console.log();
  console.log(
    `${"GAME".padEnd(8)} ${"STATUS".padEnd(8)} ${"TESTS".padEnd(8)} ${"PASS".padEnd(6)} ${"FAIL".padEnd(6)} ${"WARN".padEnd(6)} ${"DURATION".padEnd(10)} NOTES`,
  );
  console.log("-".repeat(110));

  const results: GameDeepResult[] = [];

  for (const game of discovered) {
    const r = await deepTestGame(game.gameId, game.pyFile);
    results.push(r);

    const status = r.overallStatus;
    const tc = r.tests.length;
    const tp = r.tests.filter((t) => t.status === "PASS").length;
    const tf = r.tests.filter((t) => t.status === "FAIL").length;
    const tw = r.tests.filter((t) => t.status === "WARN").length;
    const notes =
      tf > 0
        ? truncate(r.tests.find((t) => t.status === "FAIL")?.detail || "", 50)
        : tw > 0
          ? `${tw} warnings`
          : "";

    console.log(
      `${r.gameId.padEnd(8)} ${status.padEnd(8)} ${String(tc).padEnd(8)} ${String(tp).padEnd(6)} ${String(tf).padEnd(6)} ${String(tw).padEnd(6)} ${String(r.totalDurationMs + "ms").padEnd(10)} ${notes}`,
    );
  }

  // Summary
  const passed = results.filter((r) => r.overallStatus === "PASS");
  const failed = results.filter((r) => r.overallStatus === "FAIL");
  const warned = results.filter(
    (r) => r.overallStatus === "PASS" && r.warnings.length > 0,
  );

  console.log();
  console.log("=".repeat(110));
  console.log(
    `GAMES: ${results.length}  PASS: ${passed.length}  FAIL: ${failed.length}  WITH_WARNINGS: ${warned.length}`,
  );

  const totalTests = results.reduce((s, r) => s + r.tests.length, 0);
  const totalPass = results.reduce(
    (s, r) => s + r.tests.filter((t) => t.status === "PASS").length,
    0,
  );
  const totalFail = results.reduce(
    (s, r) => s + r.tests.filter((t) => t.status === "FAIL").length,
    0,
  );
  const totalWarn = results.reduce(
    (s, r) => s + r.tests.filter((t) => t.status === "WARN").length,
    0,
  );

  console.log(
    `TESTS: ${totalTests}  PASS: ${totalPass}  FAIL: ${totalFail}  WARN: ${totalWarn}`,
  );

  if (failed.length > 0) {
    console.log();
    console.log("Failed games:");
    for (const r of failed) {
      const failTest = r.tests.find((t) => t.status === "FAIL");
      console.log(
        `  ${r.gameId}: ${failTest?.test} — ${truncate(failTest?.detail || "", 80)}`,
      );
    }
  }

  if (warned.length > 0) {
    console.log();
    console.log("Games with warnings:");
    for (const r of warned) {
      console.log(
        `  ${r.gameId}: ${r.warnings.map((w) => truncate(w, 60)).join("; ")}`,
      );
    }
  }

  // Write report
  const report = generateReport(results);
  writeFileSync(OUTPUT_FILE, report, "utf-8");
  console.log();
  console.log(`Full report written to: ${OUTPUT_FILE}`);
  console.log(
    `Report size: ${report.length} chars, ${report.split("\n").length} lines`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
