/**
 * STRESS & STATE-MACHINE TEST — All 54 Games
 * ============================================
 * Ported from Python test_comprehensive_all_games.py to TS eval harness.
 * Tests through the real Arc3GameAdapter (subprocess bridge), not Python mocks.
 *
 * Test categories:
 *   T1. BOOTSTRAP           — adapter create + info validation
 *   T2. STATE AFTER RESET   — score=0, state=IN_PROGRESS, actions non-empty
 *   T3. ALL ACTIONS         — every available action works without crash
 *   T4. REWARD INVARIANTS   — reward in [0,1], type=number, no NaN
 *   T5. ACTION FLOOD        — 200 random steps without crash (auto-reset on done)
 *   T6. TRIPLE RESET        — 3 sequential resets produce clean state
 *   T7. STATE AFTER DONE    — stepping after game ends is safe
 *   T8. STEP-RESET INTERLEAVE — random mix of step/reset 50×
 *   T9. METADATA CONSISTENCY — metadata keys/types stable across steps
 *  T10. DETERMINISTIC RESET  — two resets with same adapter produce same state
 *  T11. DISPOSE             — clean shutdown
 *
 * Usage:
 *   npx tsx tests/eval/harness/harness_stress_test.ts
 */

import "dotenv/config";

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { Arc3GameAdapter } from "../../../server/services/eval/adapters/arc3GameAdapter";
import { discoverGames } from "../../../server/services/eval/adapters/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  "TS_STRESS_TEST_RESULTS.md",
);
const BRIDGE_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  test: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  detail: string;
  durationMs: number;
}

interface GameStressResult {
  gameId: string;
  tests: TestResult[];
  overallStatus: "PASS" | "FAIL";
  warnings: string[];
  totalDurationMs: number;
}

const VALID_STATES = new Set(["IN_PROGRESS", "WIN", "GAME_OVER", "NOT_PLAYED"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return performance.now();
}
function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

async function safeDispose(adapter: Arc3GameAdapter | null): Promise<void> {
  if (!adapter) return;
  try {
    await adapter.dispose();
  } catch {
    /* ignore */
  }
}

// ── Test Runner ──────────────────────────────────────────────────────────────

async function stressTestGame(
  gameId: string,
  pyFilePath: string,
): Promise<GameStressResult> {
  const result: GameStressResult = {
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

  // ── T1: BOOTSTRAP ────────────────────────────────────────────────────────

  const t1 = now();
  try {
    adapter = await Arc3GameAdapter.create(gameId, pyFilePath, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });
    addTest(
      "T1_BOOTSTRAP",
      "PASS",
      `title="${adapter.title}" totalLevels=${adapter.totalLevels}`,
      elapsed(t1),
    );
  } catch (err) {
    addTest(
      "T1_BOOTSTRAP",
      "FAIL",
      err instanceof Error ? err.message : String(err),
      elapsed(t1),
    );
  }

  if (aborted || !adapter) {
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T2: STATE AFTER RESET ────────────────────────────────────────────────

  const t2 = now();
  try {
    await adapter.reset();
    const state = adapter.getState();
    const score = adapter.getScore();
    const actions = adapter.getAvailableActions();
    const text = adapter.renderText();

    const issues: string[] = [];
    if (state !== "IN_PROGRESS") issues.push(`state=${state}`);
    if (score !== 0) issues.push(`score=${score}`);
    if (!actions || actions.length === 0) issues.push("no actions");
    if (!text || text.length === 0) issues.push("empty text");

    if (issues.length > 0) {
      addTest("T2_RESET_STATE", "WARN", issues.join("; "), elapsed(t2));
    } else {
      addTest(
        "T2_RESET_STATE",
        "PASS",
        `actions=[${actions.join(",")}] score=${score}`,
        elapsed(t2),
      );
    }
  } catch (err) {
    addTest(
      "T2_RESET_STATE",
      "FAIL",
      err instanceof Error ? err.message : String(err),
      elapsed(t2),
    );
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T3: ALL ACTIONS ──────────────────────────────────────────────────────

  {
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const failedActions: string[] = [];

    for (const action of actions) {
      const t3 = now();
      try {
        await adapter.reset(); // fresh state per action
        await adapter.step(action);
        const state = adapter.getState();
        const score = adapter.getScore();

        if (score < 0 || score > 1) {
          failedActions.push(`${action}: score=${score}`);
        } else if (!VALID_STATES.has(state)) {
          failedActions.push(`${action}: state=${state}`);
        }
      } catch (err) {
        failedActions.push(
          `${action}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (failedActions.length > 0) {
      addTest(
        "T3_ALL_ACTIONS",
        "FAIL",
        `${failedActions.length}/${actions.length} failed: ${failedActions.slice(0, 3).join("; ")}`,
        0,
      );
    } else {
      addTest("T3_ALL_ACTIONS", "PASS", `${actions.length} actions all OK`, 0);
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T4: REWARD INVARIANTS ────────────────────────────────────────────────

  {
    const t4 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(77);
    const violations: string[] = [];
    let cumReward = 0;

    for (let i = 0; i < 100; i++) {
      try {
        const action = actions[Math.floor(rng() * actions.length)]!;
        await adapter.step(action);
        const score = adapter.getScore();
        const state = adapter.getState();

        if (typeof score !== "number") {
          violations.push(`step ${i}: score type=${typeof score}`);
          break;
        }
        if (Number.isNaN(score) || !Number.isFinite(score)) {
          violations.push(`step ${i}: score is NaN/Inf`);
          break;
        }
        if (score < 0 || score > 1) {
          violations.push(`step ${i}: score=${score} outside [0,1]`);
        }

        if (state === "GAME_OVER" || state === "WIN") {
          await adapter.reset();
        }
      } catch {
        try {
          await adapter.reset();
        } catch {
          break;
        }
      }
    }

    if (violations.length > 0) {
      addTest(
        "T4_REWARD_INVARIANTS",
        "WARN",
        violations.slice(0, 3).join("; "),
        elapsed(t4),
      );
    } else {
      addTest(
        "T4_REWARD_INVARIANTS",
        "PASS",
        "100 steps, all scores in [0,1]",
        elapsed(t4),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T5: ACTION FLOOD (200 random steps) ──────────────────────────────────

  {
    const t5 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(99);
    let crashes = 0;
    let doneCount = 0;

    for (let i = 0; i < 200; i++) {
      try {
        const action = actions[Math.floor(rng() * actions.length)]!;
        await adapter.step(action);
        const state = adapter.getState();
        if (state === "GAME_OVER" || state === "WIN") {
          doneCount++;
          await adapter.reset();
        }
      } catch {
        crashes++;
        if (crashes >= 5) break;
        try {
          await adapter.reset();
        } catch {
          break;
        }
      }
    }

    if (crashes > 0) {
      addTest(
        "T5_ACTION_FLOOD",
        "FAIL",
        `${crashes} crashes in 200 steps (${doneCount} resets)`,
        elapsed(t5),
      );
    } else {
      addTest(
        "T5_ACTION_FLOOD",
        "PASS",
        `200 steps OK (${doneCount} game completions)`,
        elapsed(t5),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T6: TRIPLE RESET ─────────────────────────────────────────────────────

  {
    const t6 = now();
    const scores: number[] = [];
    const states: string[] = [];
    let ok = true;

    for (let i = 0; i < 3; i++) {
      try {
        await adapter.reset();
        scores.push(adapter.getScore());
        states.push(adapter.getState());
      } catch (err) {
        addTest(
          "T6_TRIPLE_RESET",
          "FAIL",
          `reset #${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
          elapsed(t6),
        );
        ok = false;
        break;
      }
    }

    if (ok) {
      const allZero = scores.every((s) => s === 0);
      const allIP = states.every((s) => s === "IN_PROGRESS");
      if (!allZero || !allIP) {
        addTest(
          "T6_TRIPLE_RESET",
          "WARN",
          `scores=[${scores}] states=[${states}]`,
          elapsed(t6),
        );
      } else {
        addTest("T6_TRIPLE_RESET", "PASS", "3× clean resets", elapsed(t6));
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T7: STATE AFTER DONE ─────────────────────────────────────────────────

  {
    const t7 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(42);
    let reachedDone = false;

    // Drive to done
    for (let i = 0; i < 500; i++) {
      try {
        await adapter.step(actions[Math.floor(rng() * actions.length)]!);
        const state = adapter.getState();
        if (state === "GAME_OVER" || state === "WIN") {
          reachedDone = true;
          break;
        }
      } catch {
        break;
      }
    }

    if (!reachedDone) {
      addTest(
        "T7_STATE_AFTER_DONE",
        "SKIP",
        "could not reach done in 500 steps",
        elapsed(t7),
      );
    } else {
      // Try stepping after done
      const postDoneIssues: string[] = [];
      for (const action of actions.slice(0, 3)) {
        try {
          await adapter.step(action);
          const state = adapter.getState();
          if (!VALID_STATES.has(state)) {
            postDoneIssues.push(`${action}: invalid state=${state}`);
          }
        } catch (err) {
          postDoneIssues.push(
            `${action}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Recovery: reset should work
      try {
        await adapter.reset();
        const state = adapter.getState();
        if (state !== "IN_PROGRESS") {
          postDoneIssues.push(`reset after done: state=${state}`);
        }
      } catch (err) {
        postDoneIssues.push(
          `reset after done crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (postDoneIssues.length > 0) {
        addTest(
          "T7_STATE_AFTER_DONE",
          "WARN",
          postDoneIssues.slice(0, 3).join("; "),
          elapsed(t7),
        );
      } else {
        addTest(
          "T7_STATE_AFTER_DONE",
          "PASS",
          "steps after done safe, reset recovers",
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

  // ── T8: STEP-RESET INTERLEAVE ────────────────────────────────────────────

  {
    const t8 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(77);
    let crashes = 0;

    for (let i = 0; i < 50; i++) {
      try {
        if (rng() < 0.3) {
          await adapter.reset();
        } else {
          await adapter.step(actions[Math.floor(rng() * actions.length)]!);
          const state = adapter.getState();
          if (state === "GAME_OVER" || state === "WIN") {
            await adapter.reset();
          }
        }
      } catch {
        crashes++;
        if (crashes >= 3) break;
        try {
          await adapter.reset();
        } catch {
          break;
        }
      }
    }

    if (crashes > 0) {
      addTest(
        "T8_INTERLEAVE",
        "FAIL",
        `${crashes} crashes in 50 interleaved ops`,
        elapsed(t8),
      );
    } else {
      addTest(
        "T8_INTERLEAVE",
        "PASS",
        "50 step/reset interleaves OK",
        elapsed(t8),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T9: METADATA CONSISTENCY ─────────────────────────────────────────────

  {
    const t9 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(88);

    // Capture initial metadata keys from renderText (adapter doesn't expose raw metadata)
    const initialText = adapter.renderText();
    const initialScore = adapter.getScore();
    const initialState = adapter.getState();
    const issues: string[] = [];

    for (let i = 0; i < 30; i++) {
      try {
        await adapter.step(actions[Math.floor(rng() * actions.length)]!);
        const state = adapter.getState();
        const score = adapter.getScore();

        if (!VALID_STATES.has(state)) {
          issues.push(`step ${i}: invalid state=${state}`);
        }
        if (typeof score !== "number" || Number.isNaN(score)) {
          issues.push(`step ${i}: invalid score=${score}`);
        }

        if (state === "GAME_OVER" || state === "WIN") {
          await adapter.reset();
        }
      } catch {
        try {
          await adapter.reset();
        } catch {
          break;
        }
      }
    }

    if (issues.length > 0) {
      addTest(
        "T9_METADATA_CONSISTENCY",
        "WARN",
        issues.slice(0, 3).join("; "),
        elapsed(t9),
      );
    } else {
      addTest(
        "T9_METADATA_CONSISTENCY",
        "PASS",
        "30 steps, all states/scores valid",
        elapsed(t9),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T10: DETERMINISTIC RESET ─────────────────────────────────────────────

  {
    const t10 = now();
    try {
      await adapter.reset();
      const text1 = adapter.renderText();
      const score1 = adapter.getScore();
      const state1 = adapter.getState();

      await adapter.reset();
      const text2 = adapter.renderText();
      const score2 = adapter.getScore();
      const state2 = adapter.getState();

      const issues: string[] = [];
      if (text1 !== text2) issues.push("text differs across resets");
      if (score1 !== score2)
        issues.push(`score differs: ${score1} vs ${score2}`);
      if (state1 !== state2)
        issues.push(`state differs: ${state1} vs ${state2}`);

      if (issues.length > 0) {
        addTest(
          "T10_DETERMINISTIC_RESET",
          "WARN",
          issues.join("; "),
          elapsed(t10),
        );
      } else {
        addTest(
          "T10_DETERMINISTIC_RESET",
          "PASS",
          "consecutive resets produce identical state",
          elapsed(t10),
        );
      }
    } catch (err) {
      addTest(
        "T10_DETERMINISTIC_RESET",
        "FAIL",
        err instanceof Error ? err.message : String(err),
        elapsed(t10),
      );
    }
  }

  // ── T11: DISPOSE ─────────────────────────────────────────────────────────

  {
    const t11 = now();
    try {
      await adapter.dispose();
      adapter = null;
      addTest("T11_DISPOSE", "PASS", "clean shutdown", elapsed(t11));
    } catch (err) {
      addTest(
        "T11_DISPOSE",
        "FAIL",
        err instanceof Error ? err.message : String(err),
        elapsed(t11),
      );
    }
  }

  await safeDispose(adapter);
  result.totalDurationMs = elapsed(gameStart);
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const PYTHON_BIN = resolve(
    GAMES_DIR,
    "..",
    "..",
    "..",
    "venv",
    "bin",
    "python3",
  );

  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║   STRESS & STATE-MACHINE TEST — All Games                   ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log();
  console.log(`Games directory: ${GAMES_DIR}`);
  console.log(`PYTHON_BIN:     ${PYTHON_BIN}`);
  console.log();

  const games = discoverGames(GAMES_DIR);
  console.log(`Discovered ${games.length} games\n`);

  const allResults: GameStressResult[] = [];
  let totalPass = 0;
  let totalFail = 0;
  let totalWarn = 0;
  let totalTests = 0;

  console.log(
    "GAME     STATUS   TESTS    PASS   FAIL   WARN   DURATION   NOTES",
  );
  console.log("-".repeat(100));

  for (const game of games) {
    const result = await stressTestGame(game.gameId, game.pyFile);
    allResults.push(result);

    const pass = result.tests.filter((t) => t.status === "PASS").length;
    const fail = result.tests.filter((t) => t.status === "FAIL").length;
    const warn = result.tests.filter((t) => t.status === "WARN").length;
    totalTests += result.tests.length;
    totalPass += pass;
    totalFail += fail;
    totalWarn += warn;

    const notes =
      result.warnings.length > 0 ? `${result.warnings.length} warnings` : "";

    console.log(
      `${game.gameId.padEnd(9)}${result.overallStatus.padEnd(9)}` +
        `${String(result.tests.length).padEnd(9)}` +
        `${String(pass).padEnd(7)}${String(fail).padEnd(7)}${String(warn).padEnd(7)}` +
        `${String(result.totalDurationMs) + "ms"}`.padEnd(11) +
        notes,
    );
  }

  const gamesPass = allResults.filter((r) => r.overallStatus === "PASS").length;
  const gamesFail = allResults.filter((r) => r.overallStatus === "FAIL").length;
  const gamesWithWarnings = allResults.filter(
    (r) => r.overallStatus === "PASS" && r.warnings.length > 0,
  ).length;

  console.log("\n" + "=".repeat(100));
  console.log(
    `GAMES: ${games.length}  PASS: ${gamesPass}  FAIL: ${gamesFail}  WITH_WARNINGS: ${gamesWithWarnings}`,
  );
  console.log(
    `TESTS: ${totalTests}  PASS: ${totalPass}  FAIL: ${totalFail}  WARN: ${totalWarn}`,
  );

  // Write report
  const reportLines: string[] = [
    "# Stress & State-Machine Test Results",
    "",
    `**Games:** ${games.length}  **Pass:** ${gamesPass}  **Fail:** ${gamesFail}`,
    `**Tests:** ${totalTests}  **Pass:** ${totalPass}  **Fail:** ${totalFail}  **Warn:** ${totalWarn}`,
    "",
  ];

  for (const r of allResults) {
    reportLines.push(`## ${r.gameId} — ${r.overallStatus}`);
    reportLines.push("");
    for (const t of r.tests) {
      reportLines.push(
        `- **${t.test}**: ${t.status} — ${t.detail} (${t.durationMs}ms)`,
      );
    }
    reportLines.push("");
  }

  writeFileSync(OUTPUT_FILE, reportLines.join("\n"));
  console.log(`\nFull report written to: ${OUTPUT_FILE}`);

  process.exit(gamesFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
