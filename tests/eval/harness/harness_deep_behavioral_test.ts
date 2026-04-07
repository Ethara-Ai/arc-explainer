/**
 * DEEP BEHAVIORAL HARNESS TEST
 * ==============================
 * Tests harness behaviors NOT covered by harness_verify_all_games.ts:
 *
 *   Test 1: GAME_OVER handling — drive a game to GAME_OVER by exhausting max_actions,
 *           verify state="GAME_OVER", isDone()=false, getAvailableActions()=["reset"],
 *           then reset and verify game resumes at IN_PROGRESS.
 *
 *   Test 2: Click actions with coordinates — test games that have "click x y" style
 *           actions (lm42) and "click_X_Y" style actions (cp01). Verify the bridge
 *           correctly passes these to PuzzleEnvironment.
 *
 *   Test 3: Frame response field validation — verify every frame has action_counter,
 *           max_actions, win_score, levels_completed, current_level, total_levels,
 *           and text_observation fields present and correctly typed.
 *
 *   Test 4: Repeated reset stress — reset a game 10 times in a row, verifying state
 *           is consistent and no corruption occurs.
 *
 *   Test 5: Multi-dimensional frame extraction — verify getGrid() returns valid 2D
 *           arrays and renderText() produces correct grid output.
 *
 * Usage:
 *   npx tsx tests/eval/harness/harness_deep_behavioral_test.ts
 */

import "dotenv/config";

import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { Arc3GameAdapter } from "../../../server/services/eval/adapters/arc3GameAdapter";
import { GameBridge } from "../../../server/services/eval/adapters/gameBridge";
import { discoverGames } from "../../../server/services/eval/adapters/types";
import type { BridgeFrameResponse } from "../../../server/services/eval/adapters/types";

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
  "TS_DEEP_BEHAVIORAL_TEST_RESULTS.md",
);
const BRIDGE_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  testName: string;
  gameId: string;
  status: "PASS" | "FAIL";
  detail: string;
  checks: CheckResult[];
  durationMs: number;
  error?: string;
}

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL";
  expected: string;
  actual: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return performance.now();
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... (${s.length} chars total)`;
}

function check(
  checks: CheckResult[],
  name: string,
  expected: string,
  actual: string,
  condition: boolean,
): void {
  checks.push({ name, status: condition ? "PASS" : "FAIL", expected, actual });
}

// ── Test 1: GAME_OVER Handling ───────────────────────────────────────────────

async function testGameOver(gameId: string): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const start = now();
  let adapter: Arc3GameAdapter | null = null;

  try {
    const games = discoverGames(GAMES_DIR);
    const game = games.find((g) => g.gameId === gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);

    adapter = await Arc3GameAdapter.create(gameId, game.pyFile, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    await adapter.reset();

    // Step 1: Verify initial state
    check(
      checks,
      "Initial state is IN_PROGRESS",
      "IN_PROGRESS",
      adapter.getState(),
      adapter.getState() === "IN_PROGRESS",
    );
    check(
      checks,
      "isDone() is false initially",
      "false",
      String(adapter.isDone()),
      adapter.isDone() === false,
    );

    // Step 2: Exhaust max_actions by stepping repeatedly until GAME_OVER or 250 steps
    const actions = adapter.getAvailableActions().filter((a) => a !== "reset");
    const actionToUse = actions[0] || "up";
    let reachedGameOver = false;
    let stepCount = 0;
    const maxSteps = 250; // slightly above typical max_actions=200

    for (let i = 0; i < maxSteps; i++) {
      if (adapter.getState() === "GAME_OVER" || adapter.getState() === "WIN") {
        reachedGameOver = adapter.getState() === "GAME_OVER";
        break;
      }

      const currentActions = adapter
        .getAvailableActions()
        .filter((a) => a !== "reset");
      const action = currentActions[0] || actionToUse;
      await adapter.step(action);
      stepCount++;
    }

    const finalState = adapter.getState();

    if (finalState === "GAME_OVER") {
      // Step 3: Validate GAME_OVER behavior
      check(checks, "State is GAME_OVER", "GAME_OVER", finalState, true);
      check(
        checks,
        "isDone() is false during GAME_OVER",
        "false",
        String(adapter.isDone()),
        adapter.isDone() === false,
      );

      const goActions = adapter.getAvailableActions();
      check(
        checks,
        "Only reset available in GAME_OVER",
        '["reset"]',
        JSON.stringify(goActions),
        goActions.length === 1 && goActions[0] === "reset",
      );

      // Step 4: Reset from GAME_OVER and verify recovery
      await adapter.step("reset");

      const stateAfterReset = adapter.getState();
      check(
        checks,
        "State is IN_PROGRESS after reset from GAME_OVER",
        "IN_PROGRESS",
        stateAfterReset,
        stateAfterReset === "IN_PROGRESS",
      );
      check(
        checks,
        "isDone() is false after recovery",
        "false",
        String(adapter.isDone()),
        adapter.isDone() === false,
      );

      const recoveredActions = adapter.getAvailableActions();
      check(
        checks,
        "Multiple actions available after recovery",
        ">1",
        String(recoveredActions.length),
        recoveredActions.length > 1,
      );
    } else if (finalState === "WIN") {
      // Game was won — still a valid outcome, test WIN behavior
      check(
        checks,
        "State is WIN (game completed before GAME_OVER)",
        "WIN",
        finalState,
        true,
      );
      check(
        checks,
        "isDone() is true on WIN",
        "true",
        String(adapter.isDone()),
        adapter.isDone() === true,
      );
    } else {
      // Didn't reach GAME_OVER or WIN within maxSteps — still running
      check(
        checks,
        `Reached terminal state within ${maxSteps} steps`,
        "GAME_OVER or WIN",
        `IN_PROGRESS after ${stepCount} steps`,
        false,
      );
    }

    const allPassed = checks.every((c) => c.status === "PASS");
    return {
      testName: "Test 1: GAME_OVER Handling",
      gameId,
      status: allPassed ? "PASS" : "FAIL",
      detail: `${stepCount} steps, final state: ${finalState}`,
      checks,
      durationMs: elapsed(start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      testName: "Test 1: GAME_OVER Handling",
      gameId,
      status: "FAIL",
      detail: msg,
      checks,
      durationMs: elapsed(start),
      error: msg,
    };
  } finally {
    if (adapter) await adapter.dispose();
  }
}

// ── Test 2: Click Actions with Coordinates ───────────────────────────────────

async function testClickActions(gameId: string): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const start = now();
  let adapter: Arc3GameAdapter | null = null;

  try {
    const games = discoverGames(GAMES_DIR);
    const game = games.find((g) => g.gameId === gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);

    adapter = await Arc3GameAdapter.create(gameId, game.pyFile, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    await adapter.reset();
    const actions = adapter.getAvailableActions();

    // Find click-like actions
    const clickActions = actions.filter(
      (a) => a.toLowerCase().includes("click") && a !== "reset",
    );

    check(
      checks,
      "Has click actions",
      ">0",
      String(clickActions.length),
      clickActions.length > 0,
    );

    // Categorize: "click x y" (spaces) vs "click_x_y" (underscores) vs plain "click"
    const spacedClicks = clickActions.filter((a) =>
      /^click\s+\d+\s+\d+$/i.test(a),
    );
    const underscoreClicks = clickActions.filter((a) =>
      /^click_\d+_\d+$/i.test(a),
    );
    const plainClicks = clickActions.filter((a) => a.toLowerCase() === "click");

    check(
      checks,
      "Click action format detected",
      "spaced|underscore|plain",
      `spaced=${spacedClicks.length} underscore=${underscoreClicks.length} plain=${plainClicks.length}`,
      clickActions.length > 0,
    );

    // Try each type of click action and verify no error
    const clicksToTest: string[] = [];

    if (spacedClicks.length > 0) {
      clicksToTest.push(spacedClicks[0]!);
    }
    if (underscoreClicks.length > 0) {
      clicksToTest.push(underscoreClicks[0]!);
    }
    if (plainClicks.length > 0 && clicksToTest.length === 0) {
      clicksToTest.push(plainClicks[0]!);
    }

    for (const clickAction of clicksToTest) {
      const prevState = adapter.getState();
      try {
        await adapter.step(clickAction);
        const newState = adapter.getState();
        check(
          checks,
          `Click action "${clickAction}" executes without error`,
          "no error",
          `state: ${prevState} → ${newState}`,
          true,
        );

        // Verify frame is valid after click
        const grid = adapter.getGrid();
        check(
          checks,
          `Grid valid after "${clickAction}"`,
          "non-null 2D array",
          grid
            ? `${grid.length}x${(grid[0] as number[])?.length ?? 0}`
            : "null",
          grid !== null && Array.isArray(grid) && grid.length > 0,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        check(
          checks,
          `Click action "${clickAction}" executes without error`,
          "no error",
          msg,
          false,
        );
      }
    }

    const allPassed = checks.every((c) => c.status === "PASS");
    return {
      testName: "Test 2: Click Actions",
      gameId,
      status: allPassed ? "PASS" : "FAIL",
      detail: `Tested ${clicksToTest.length} click actions: [${clicksToTest.join(", ")}]`,
      checks,
      durationMs: elapsed(start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      testName: "Test 2: Click Actions",
      gameId,
      status: "FAIL",
      detail: msg,
      checks,
      durationMs: elapsed(start),
      error: msg,
    };
  } finally {
    if (adapter) await adapter.dispose();
  }
}

// ── Test 3: Frame Response Field Validation ──────────────────────────────────

async function testFrameFields(gameId: string): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const start = now();
  let bridge: GameBridge | null = null;

  try {
    const games = discoverGames(GAMES_DIR);
    const game = games.find((g) => g.gameId === gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);

    // Use raw bridge to inspect frame responses directly
    bridge = new GameBridge(gameId, game.pyFile, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    await bridge.start();
    const frame: BridgeFrameResponse = await bridge.reset();

    // Validate all required fields exist and are correct types
    check(
      checks,
      "frame.type === 'frame'",
      "frame",
      frame.type,
      frame.type === "frame",
    );

    check(
      checks,
      "frame.frame is 2D array",
      "number[][]",
      Array.isArray(frame.frame)
        ? `array[${frame.frame.length}]`
        : typeof frame.frame,
      Array.isArray(frame.frame) && frame.frame.length > 0,
    );

    check(
      checks,
      "frame.score is number",
      "number",
      `${typeof frame.score} (${frame.score})`,
      typeof frame.score === "number",
    );

    check(
      checks,
      "frame.state is valid string",
      "IN_PROGRESS|WIN|GAME_OVER",
      frame.state,
      ["IN_PROGRESS", "WIN", "GAME_OVER"].includes(frame.state),
    );

    check(
      checks,
      "frame.action_counter is number",
      "number",
      `${typeof frame.action_counter} (${frame.action_counter})`,
      typeof frame.action_counter === "number",
    );

    check(
      checks,
      "frame.action_counter is 0 after reset",
      "0",
      String(frame.action_counter),
      frame.action_counter === 0,
    );

    check(
      checks,
      "frame.max_actions is number > 0",
      ">0",
      `${typeof frame.max_actions} (${frame.max_actions})`,
      typeof frame.max_actions === "number" && frame.max_actions > 0,
    );

    check(
      checks,
      "frame.win_score is number",
      "number",
      `${typeof frame.win_score} (${frame.win_score})`,
      typeof frame.win_score === "number",
    );

    check(
      checks,
      "frame.available_actions is string[]",
      "string[]",
      Array.isArray(frame.available_actions)
        ? `[${frame.available_actions.slice(0, 5).join(",")}${frame.available_actions.length > 5 ? "..." : ""}]`
        : typeof frame.available_actions,
      Array.isArray(frame.available_actions) &&
        frame.available_actions.length > 0,
    );

    check(
      checks,
      "frame.levels_completed is number or undefined",
      "number|undefined",
      `${typeof frame.levels_completed} (${frame.levels_completed})`,
      frame.levels_completed === undefined ||
        typeof frame.levels_completed === "number",
    );

    check(
      checks,
      "frame.current_level is number or undefined",
      "number|undefined",
      `${typeof frame.current_level} (${frame.current_level})`,
      frame.current_level === undefined ||
        typeof frame.current_level === "number",
    );

    check(
      checks,
      "frame.total_levels is number or undefined",
      "number|undefined",
      `${typeof frame.total_levels} (${frame.total_levels})`,
      frame.total_levels === undefined ||
        typeof frame.total_levels === "number",
    );

    check(
      checks,
      "frame.text_observation is string or undefined",
      "string|undefined",
      `${typeof frame.text_observation}${frame.text_observation ? ` (len=${frame.text_observation.length})` : ""}`,
      frame.text_observation === undefined ||
        typeof frame.text_observation === "string",
    );

    // Step once and verify action_counter increments
    const actions = frame.available_actions.filter(
      (a: string) => a !== "reset",
    );
    if (actions.length > 0) {
      const stepFrame: BridgeFrameResponse = await bridge.action(actions[0]!);

      check(
        checks,
        "action_counter increments after step",
        "1",
        String(stepFrame.action_counter),
        stepFrame.action_counter === 1,
      );

      // Step again
      const step2Actions = stepFrame.available_actions.filter(
        (a: string) => a !== "reset",
      );
      if (step2Actions.length > 0) {
        const stepFrame2: BridgeFrameResponse = await bridge.action(
          step2Actions[0]!,
        );
        check(
          checks,
          "action_counter increments to 2",
          "2",
          String(stepFrame2.action_counter),
          stepFrame2.action_counter === 2,
        );
      }
    }

    const allPassed = checks.every((c) => c.status === "PASS");
    return {
      testName: "Test 3: Frame Field Validation",
      gameId,
      status: allPassed ? "PASS" : "FAIL",
      detail: `${checks.filter((c) => c.status === "PASS").length}/${checks.length} checks passed`,
      checks,
      durationMs: elapsed(start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      testName: "Test 3: Frame Field Validation",
      gameId,
      status: "FAIL",
      detail: msg,
      checks,
      durationMs: elapsed(start),
      error: msg,
    };
  } finally {
    if (bridge) await bridge.quit();
  }
}

// ── Test 4: Repeated Reset Stress ────────────────────────────────────────────

async function testRepeatedResets(gameId: string): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const start = now();
  let adapter: Arc3GameAdapter | null = null;

  try {
    const games = discoverGames(GAMES_DIR);
    const game = games.find((g) => g.gameId === gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);

    adapter = await Arc3GameAdapter.create(gameId, game.pyFile, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    // Record first reset state for comparison
    await adapter.reset();
    const firstState = adapter.getState();
    const firstScore = adapter.getScore();
    const firstActions = adapter.getAvailableActions().sort();
    const firstGrid = adapter.getGrid();
    const firstGridStr = firstGrid
      ? JSON.stringify(firstGrid.slice(0, 2))
      : "null";

    check(
      checks,
      "First reset: state is IN_PROGRESS",
      "IN_PROGRESS",
      firstState,
      firstState === "IN_PROGRESS",
    );

    // Do some steps to change state
    const actions = adapter.getAvailableActions().filter((a) => a !== "reset");
    if (actions.length > 0) {
      await adapter.step(actions[0]!);
      await adapter.step(actions[0]!);
    }

    // Reset 10 times and verify consistency
    for (let i = 0; i < 10; i++) {
      await adapter.reset();

      const state = adapter.getState();
      const score = adapter.getScore();
      const currentActions = adapter.getAvailableActions().sort();
      const grid = adapter.getGrid();
      const gridStr = grid ? JSON.stringify(grid.slice(0, 2)) : "null";

      if (i === 0 || i === 4 || i === 9) {
        // Spot-check a few iterations
        check(
          checks,
          `Reset #${i + 2}: state is IN_PROGRESS`,
          "IN_PROGRESS",
          state,
          state === "IN_PROGRESS",
        );
        check(
          checks,
          `Reset #${i + 2}: score is 0`,
          "0",
          String(score),
          score === 0,
        );
        check(
          checks,
          `Reset #${i + 2}: actions match first reset`,
          JSON.stringify(firstActions),
          JSON.stringify(currentActions),
          JSON.stringify(firstActions) === JSON.stringify(currentActions),
        );
        check(
          checks,
          `Reset #${i + 2}: grid matches first reset (first 2 rows)`,
          truncate(firstGridStr, 80),
          truncate(gridStr, 80),
          firstGridStr === gridStr,
        );
      }
    }

    const allPassed = checks.every((c) => c.status === "PASS");
    return {
      testName: "Test 4: Repeated Reset Stress",
      gameId,
      status: allPassed ? "PASS" : "FAIL",
      detail: `11 resets total, ${checks.filter((c) => c.status === "PASS").length}/${checks.length} checks passed`,
      checks,
      durationMs: elapsed(start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      testName: "Test 4: Repeated Reset Stress",
      gameId,
      status: "FAIL",
      detail: msg,
      checks,
      durationMs: elapsed(start),
      error: msg,
    };
  } finally {
    if (adapter) await adapter.dispose();
  }
}

// ── Test 5: Grid + renderText Validation ─────────────────────────────────────

async function testGridAndRender(gameId: string): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const start = now();
  let adapter: Arc3GameAdapter | null = null;

  try {
    const games = discoverGames(GAMES_DIR);
    const game = games.find((g) => g.gameId === gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);

    adapter = await Arc3GameAdapter.create(gameId, game.pyFile, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    await adapter.reset();

    // Validate grid
    const grid = adapter.getGrid();
    check(
      checks,
      "getGrid() returns non-null",
      "non-null",
      grid === null ? "null" : "array",
      grid !== null,
    );

    if (grid && Array.isArray(grid)) {
      const isRect =
        Array.isArray(grid[0]) &&
        grid.every(
          (row) =>
            Array.isArray(row) &&
            (row as number[]).length === (grid[0] as number[]).length,
        );

      check(
        checks,
        "Grid is rectangular (all rows same length)",
        "true",
        String(isRect),
        isRect,
      );

      const h = grid.length;
      const w = Array.isArray(grid[0]) ? (grid[0] as number[]).length : 0;
      check(
        checks,
        "Grid dimensions > 0",
        ">0 x >0",
        `${w}x${h}`,
        h > 0 && w > 0,
      );

      // Validate all values are numbers (color indices)
      let allNumbers = true;
      for (const row of grid) {
        if (Array.isArray(row)) {
          for (const cell of row as number[]) {
            if (typeof cell !== "number") {
              allNumbers = false;
              break;
            }
          }
        }
      }
      check(
        checks,
        "All grid cells are numbers",
        "true",
        String(allNumbers),
        allNumbers,
      );
    }

    // Validate renderText
    const text = adapter.renderText();
    check(
      checks,
      "renderText() returns non-empty string",
      "non-empty",
      `length=${text.length}`,
      text.length > 0,
    );

    // Validate header format
    const headerMatch = text.match(
      /^Grid \((\d+)x(\d+)\) \| Level (\S+)\/(\S+) \| Score: (\d+)% \| State: (\S+)/,
    );
    check(
      checks,
      "renderText() header matches format",
      "Grid (WxH) | Level L/TL | Score: S% | State: STATE",
      text.split("\n")[0] ?? "",
      headerMatch !== null,
    );

    if (headerMatch) {
      const [, w, h, level, totalLevels, score, state] = headerMatch;
      check(
        checks,
        "Header state matches getState()",
        adapter.getState(),
        state!,
        state === adapter.getState(),
      );

      const expectedScore = Math.round(adapter.getScore() * 100);
      check(
        checks,
        "Header score matches getScore()",
        String(expectedScore),
        score!,
        Number(score) === expectedScore,
      );
    }

    // Step and verify grid changes
    const actions = adapter.getAvailableActions().filter((a) => a !== "reset");
    if (actions.length > 0) {
      const gridBefore = JSON.stringify(adapter.getGrid());
      await adapter.step(actions[0]!);
      const gridAfter = JSON.stringify(adapter.getGrid());
      const textAfter = adapter.renderText();

      check(
        checks,
        "renderText() still valid after step",
        "non-empty",
        `length=${textAfter.length}`,
        textAfter.length > 0,
      );

      // Grid may or may not change (depends on game) — just verify it's valid
      const gridAfterParsed = adapter.getGrid();
      check(
        checks,
        "getGrid() still valid after step",
        "non-null",
        gridAfterParsed === null ? "null" : "array",
        gridAfterParsed !== null,
      );
    }

    const allPassed = checks.every((c) => c.status === "PASS");
    return {
      testName: "Test 5: Grid + renderText Validation",
      gameId,
      status: allPassed ? "PASS" : "FAIL",
      detail: `${checks.filter((c) => c.status === "PASS").length}/${checks.length} checks passed`,
      checks,
      durationMs: elapsed(start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      testName: "Test 5: Grid + renderText Validation",
      gameId,
      status: "FAIL",
      detail: msg,
      checks,
      durationMs: elapsed(start),
      error: msg,
    };
  } finally {
    if (adapter) await adapter.dispose();
  }
}

// ── Test 6: text_observation Field ───────────────────────────────────────────

async function testTextObservation(gameId: string): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const start = now();
  let bridge: GameBridge | null = null;

  try {
    const games = discoverGames(GAMES_DIR);
    const game = games.find((g) => g.gameId === gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);

    bridge = new GameBridge(gameId, game.pyFile, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    await bridge.start();
    const resetFrame: BridgeFrameResponse = await bridge.reset();

    // Check text_observation exists as a field (even if empty)
    const hasField = "text_observation" in resetFrame;
    check(
      checks,
      "text_observation field present in frame",
      "true",
      String(hasField),
      hasField,
    );

    const textObs = resetFrame.text_observation;
    check(
      checks,
      "text_observation type is string or undefined",
      "string|undefined",
      typeof textObs,
      textObs === undefined || typeof textObs === "string",
    );

    if (typeof textObs === "string") {
      check(
        checks,
        "text_observation is non-null string",
        "string",
        `"${truncate(textObs, 60)}"`,
        true,
      );
    }

    // Step a few times and check text_observation on each frame
    const actions = resetFrame.available_actions.filter(
      (a: string) => a !== "reset",
    );
    if (actions.length > 0) {
      const stepFrame: BridgeFrameResponse = await bridge.action(actions[0]!);
      const stepTextObs = stepFrame.text_observation;

      check(
        checks,
        "text_observation present after step",
        "string|undefined",
        typeof stepTextObs,
        stepTextObs === undefined || typeof stepTextObs === "string",
      );
    }

    const allPassed = checks.every((c) => c.status === "PASS");
    return {
      testName: "Test 6: text_observation Field",
      gameId,
      status: allPassed ? "PASS" : "FAIL",
      detail: `text_observation=${typeof textObs === "string" ? `"${truncate(textObs, 40)}"` : "undefined/empty"}`,
      checks,
      durationMs: elapsed(start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      testName: "Test 6: text_observation Field",
      gameId,
      status: "FAIL",
      detail: msg,
      checks,
      durationMs: elapsed(start),
      error: msg,
    };
  } finally {
    if (bridge) await bridge.quit();
  }
}

// ── Report Generation ────────────────────────────────────────────────────────

function generateReport(results: TestResult[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  const passed = results.filter((r) => r.status === "PASS");
  const failed = results.filter((r) => r.status === "FAIL");

  lines.push("# Deep Behavioral Harness Test Results");
  lines.push("");
  lines.push(`**Generated:** ${timestamp}`);
  lines.push(`**Games directory:** \`${GAMES_DIR}\``);
  lines.push(
    `**Python binary:** \`${process.env["PYTHON_BIN"] || "python3"}\``,
  );
  lines.push(`**Total tests:** ${results.length}`);
  lines.push(`**PASSED:** ${passed.length}  |  **FAILED:** ${failed.length}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| # | Test | Game | Status | Detail | Duration |");
  lines.push("|---|------|------|--------|--------|----------|");

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const status = r.status === "PASS" ? "PASS" : "**FAIL**";
    lines.push(
      `| ${i + 1} | ${r.testName} | ${r.gameId} | ${status} | ${truncate(r.detail, 80)} | ${r.durationMs}ms |`,
    );
  }

  lines.push("");

  // Detailed results
  lines.push("## Detailed Results");
  lines.push("");

  for (const r of results) {
    const badge = r.status === "PASS" ? "PASS" : "FAIL";
    lines.push(`### ${r.testName} (${r.gameId}) — ${badge}`);
    lines.push("");

    if (r.error) {
      lines.push("**Error:**");
      lines.push("```");
      lines.push(r.error);
      lines.push("```");
      lines.push("");
    }

    if (r.checks.length > 0) {
      lines.push("| Check | Status | Expected | Actual |");
      lines.push("|-------|--------|----------|--------|");

      for (const c of r.checks) {
        const statusStr = c.status === "PASS" ? "PASS" : "**FAIL**";
        const expected = truncate(c.expected, 60)
          .replace(/\|/g, "\\|")
          .replace(/\n/g, " ");
        const actual = truncate(c.actual, 60)
          .replace(/\|/g, "\\|")
          .replace(/\n/g, " ");
        lines.push(`| ${c.name} | ${statusStr} | ${expected} | ${actual} |`);
      }

      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Environment
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
  console.log(
    "║   DEEP BEHAVIORAL HARNESS TEST                              ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log();
  console.log(`Games directory: ${GAMES_DIR}`);
  console.log();

  const results: TestResult[] = [];

  // Test 1: GAME_OVER handling — use bb01 (simple, will hit max_actions)
  console.log("[1/6] Testing GAME_OVER handling (bb01)...");
  results.push(await testGameOver("bb01"));
  console.log(
    `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
  );

  // Test 2a: Click actions — lm42 (has "click x y" with spaces)
  console.log("[2a/6] Testing click actions with coordinates (lm42)...");
  results.push(await testClickActions("lm42"));
  console.log(
    `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
  );

  // Test 2b: Click actions — cp01 (has click_40_24 with underscores)
  console.log("[2b/6] Testing click actions with underscores (cp01)...");
  results.push(await testClickActions("cp01"));
  console.log(
    `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
  );

  // Test 3: Frame response field validation — run across 3 diverse games
  for (const gid of ["bb01", "lm42", "st88"]) {
    console.log(`[3/6] Testing frame field validation (${gid})...`);
    results.push(await testFrameFields(gid));
    console.log(
      `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
    );
  }

  // Test 4: Repeated reset stress — across 3 games
  for (const gid of ["bb01", "gm02", "sl77"]) {
    console.log(`[4/6] Testing repeated resets (${gid})...`);
    results.push(await testRepeatedResets(gid));
    console.log(
      `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
    );
  }

  // Test 5: Grid + renderText validation
  for (const gid of ["bb01", "cd01", "fx42"]) {
    console.log(`[5/6] Testing grid + renderText (${gid})...`);
    results.push(await testGridAndRender(gid));
    console.log(
      `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
    );
  }

  // Test 6: text_observation field — sample across games
  for (const gid of ["bb01", "lm42", "st88", "cp01"]) {
    console.log(`[6/6] Testing text_observation (${gid})...`);
    results.push(await testTextObservation(gid));
    console.log(
      `  → ${results[results.length - 1]!.status}: ${results[results.length - 1]!.detail}`,
    );
  }

  // Summary
  const passed = results.filter((r) => r.status === "PASS");
  const failed = results.filter((r) => r.status === "FAIL");

  console.log();
  console.log("=".repeat(80));
  console.log(
    `PASSED: ${passed.length}  FAILED: ${failed.length}  TOTAL: ${results.length}`,
  );

  if (failed.length > 0) {
    console.log();
    console.log("FAILED tests:");
    for (const r of failed) {
      console.log(`  ${r.testName} (${r.gameId}): ${truncate(r.detail, 80)}`);
      const failedChecks = r.checks.filter((c) => c.status === "FAIL");
      for (const c of failedChecks) {
        console.log(
          `    - ${c.name}: expected=${c.expected} actual=${c.actual}`,
        );
      }
    }
  }

  // Write report
  const report = generateReport(results);
  writeFileSync(OUTPUT_FILE, report, "utf-8");
  console.log();
  console.log(`Full report written to: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
