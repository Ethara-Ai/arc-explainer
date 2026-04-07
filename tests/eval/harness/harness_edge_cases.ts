/**
 * ULTRA EDGE-CASE TEST — All 54 Games
 * ====================================
 * Ported from Python test_ultra_edge_cases.py to TS eval harness.
 * Tests through the real Arc3GameAdapter (subprocess bridge).
 *
 * Test categories:
 *   T1.  MALFORMED ACTIONS     — empty, whitespace, NUL, control chars
 *   T2.  CLICK COORD EDGES     — negative, huge, float, missing coords
 *   T3.  CASE SENSITIVITY      — UP vs up vs Up
 *   T4.  UNICODE & SPECIALS    — emoji, CJK, SQL injection, JSON, XML
 *   T5.  VERY LONG STRINGS     — 1K+ char action strings
 *   T6.  RAPID STEP/RESET      — 100 rapid alternations
 *   T7.  STATE AFTER GARBAGE    — state recovers after bad inputs
 *   T8.  REWARD BOUNDS EXTENDED — 200 steps, all rewards valid
 *   T9.  ACTIONS STABILITY      — get_actions consistent across calls
 *  T10.  REPEATED SAME ACTION   — same action 100× in a row
 *  T11.  DISPOSE                — clean shutdown
 *
 * Usage:
 *   npx tsx tests/eval/harness/harness_edge_cases.ts
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
  "TS_EDGE_CASE_RESULTS.md",
);
const BRIDGE_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  test: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  detail: string;
  durationMs: number;
}

interface GameEdgeResult {
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

/**
 * Try stepping with a potentially invalid action.
 * Returns true if the adapter handled it (either gracefully or via error),
 * false if it caused an unrecoverable crash.
 */
async function safeStep(
  adapter: Arc3GameAdapter,
  action: string,
): Promise<{ ok: boolean; crashed: boolean }> {
  try {
    await adapter.step(action);
    return { ok: true, crashed: false };
  } catch {
    // An error from step() is acceptable for invalid input.
    // Check if adapter is still alive by calling getState.
    try {
      adapter.getState();
      return { ok: false, crashed: false };
    } catch {
      return { ok: false, crashed: true };
    }
  }
}

// ── Test Runner ──────────────────────────────────────────────────────────────

async function edgeTestGame(
  gameId: string,
  pyFilePath: string,
): Promise<GameEdgeResult> {
  const result: GameEdgeResult = {
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

  // ── BOOTSTRAP ────────────────────────────────────────────────────────────

  const tBoot = now();
  try {
    adapter = await Arc3GameAdapter.create(gameId, pyFilePath, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });
    await adapter.reset();
    addTest("T0_BOOTSTRAP", "PASS", "adapter created + reset", elapsed(tBoot));
  } catch (err) {
    addTest(
      "T0_BOOTSTRAP",
      "FAIL",
      err instanceof Error ? err.message : String(err),
      elapsed(tBoot),
    );
  }

  if (aborted || !adapter) {
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T1: MALFORMED ACTION STRINGS ─────────────────────────────────────────

  {
    const t1 = now();
    const malformedInputs: [string, string][] = [
      ["empty", ""],
      ["space", " "],
      ["multi_space", "     "],
      ["tab", "\t"],
      ["newline", "\n"],
      ["crlf", "\r\n"],
      ["nul", "\x00"],
      ["bell", "\x07"],
    ];

    let crashes = 0;
    let handled = 0;

    for (const [label, input] of malformedInputs) {
      try {
        await adapter.reset();
      } catch {
        break;
      }

      const { crashed } = await safeStep(adapter, input);
      if (crashed) {
        crashes++;
        // Try to recover
        try {
          await adapter.reset();
        } catch {
          break;
        }
      } else {
        handled++;
      }
    }

    if (crashes > 0) {
      addTest(
        "T1_MALFORMED",
        "FAIL",
        `${crashes}/${malformedInputs.length} inputs caused crashes`,
        elapsed(t1),
      );
    } else {
      addTest(
        "T1_MALFORMED",
        "PASS",
        `${handled} malformed inputs handled gracefully`,
        elapsed(t1),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T2: CLICK COORDINATE EDGE CASES ──────────────────────────────────────

  {
    const t2 = now();
    const actions = adapter.getAvailableActions();
    const hasClick = actions.some((a) => a.toLowerCase() === "click");

    if (!hasClick) {
      addTest("T2_CLICK_EDGES", "SKIP", "no click action", 0);
    } else {
      const clickVariants: [string, string][] = [
        ["no_coords", "click"],
        ["one_coord", "click 5"],
        ["negative", "click -1 -1"],
        ["huge", "click 99999 99999"],
        ["zero", "click 0 0"],
        ["float", "click 1.5 2.5"],
        ["string_coords", "click abc def"],
        ["extra_args", "click 1 2 3 4"],
        ["comma_sep", "click 5,5"],
      ];

      let crashes = 0;
      for (const [label, input] of clickVariants) {
        try {
          await adapter.reset();
        } catch {
          break;
        }
        const { crashed } = await safeStep(adapter, input);
        if (crashed) {
          crashes++;
          try {
            await adapter.reset();
          } catch {
            break;
          }
        }
      }

      if (crashes > 0) {
        addTest(
          "T2_CLICK_EDGES",
          "FAIL",
          `${crashes}/${clickVariants.length} click variants crashed`,
          elapsed(t2),
        );
      } else {
        addTest(
          "T2_CLICK_EDGES",
          "PASS",
          `${clickVariants.length} click variants handled`,
          elapsed(t2),
        );
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T3: CASE SENSITIVITY ─────────────────────────────────────────────────

  {
    const t3 = now();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");

    if (actions.length === 0) {
      addTest("T3_CASE_SENSITIVITY", "SKIP", "no non-reset actions", 0);
    } else {
      const base = actions[0]!;
      const variants = [
        base.toUpperCase(),
        base.toLowerCase(),
        base.charAt(0).toUpperCase() + base.slice(1),
      ];

      let crashes = 0;
      for (const v of variants) {
        try {
          await adapter.reset();
        } catch {
          break;
        }
        const { crashed } = await safeStep(adapter, v);
        if (crashed) {
          crashes++;
          try {
            await adapter.reset();
          } catch {
            break;
          }
        }
      }

      if (crashes > 0) {
        addTest(
          "T3_CASE_SENSITIVITY",
          "FAIL",
          `${crashes} case variants of "${base}" crashed`,
          elapsed(t3),
        );
      } else {
        addTest(
          "T3_CASE_SENSITIVITY",
          "PASS",
          `case variants of "${base}" handled`,
          elapsed(t3),
        );
      }
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T4: UNICODE & SPECIAL STRINGS ────────────────────────────────────────

  {
    const t4 = now();
    const specialInputs: [string, string][] = [
      ["emoji", "\u{1F600}"],
      ["cjk", "\u4E2D\u6587"],
      ["number", "42"],
      ["negative", "-1"],
      ["true", "true"],
      ["null", "null"],
      ["json", '{"action":"up"}'],
      ["xml", "<action>up</action>"],
      ["sql_inject", "'; DROP TABLE--"],
      ["path_traversal", "../../../etc/passwd"],
      ["html", "<script>alert(1)</script>"],
      ["pipe", "up | down"],
      ["backtick", "`up`"],
      ["asterisk", "*"],
      ["dots", "..."],
    ];

    let crashes = 0;
    for (const [label, input] of specialInputs) {
      try {
        await adapter.reset();
      } catch {
        break;
      }
      const { crashed } = await safeStep(adapter, input);
      if (crashed) {
        crashes++;
        try {
          await adapter.reset();
        } catch {
          break;
        }
      }
    }

    if (crashes > 0) {
      addTest(
        "T4_UNICODE_SPECIALS",
        "FAIL",
        `${crashes}/${specialInputs.length} special inputs crashed`,
        elapsed(t4),
      );
    } else {
      addTest(
        "T4_UNICODE_SPECIALS",
        "PASS",
        `${specialInputs.length} special inputs handled`,
        elapsed(t4),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T5: VERY LONG STRINGS ───────────────────────────────────────────────

  {
    const t5 = now();
    const longInputs: [string, string][] = [
      ["100_chars", "a".repeat(100)],
      ["1000_chars", "x".repeat(1000)],
      ["long_spaces", " ".repeat(1000)],
      ["repeated_action", "up ".repeat(500).trim()],
    ];

    let crashes = 0;
    for (const [label, input] of longInputs) {
      try {
        await adapter.reset();
      } catch {
        break;
      }
      const { crashed } = await safeStep(adapter, input);
      if (crashed) {
        crashes++;
        try {
          await adapter.reset();
        } catch {
          break;
        }
      }
    }

    if (crashes > 0) {
      addTest(
        "T5_LONG_STRINGS",
        "FAIL",
        `${crashes}/${longInputs.length} long strings crashed`,
        elapsed(t5),
      );
    } else {
      addTest(
        "T5_LONG_STRINGS",
        "PASS",
        `${longInputs.length} long strings handled`,
        elapsed(t5),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T6: RAPID STEP/RESET CYCLING ─────────────────────────────────────────

  {
    const t6 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(42);
    let crashes = 0;

    for (let i = 0; i < 100; i++) {
      try {
        const choice = rng();
        if (choice < 0.25) {
          await adapter.reset();
        } else if (choice < 0.5) {
          await adapter.step(actions[Math.floor(rng() * actions.length)]!);
          const state = adapter.getState();
          if (state === "GAME_OVER" || state === "WIN") await adapter.reset();
        } else if (choice < 0.75) {
          // step then immediate reset
          await adapter.step(actions[Math.floor(rng() * actions.length)]!);
          await adapter.reset();
        } else {
          // double reset
          await adapter.reset();
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
        "T6_RAPID_CYCLING",
        "FAIL",
        `${crashes} crashes in 100 rapid cycles`,
        elapsed(t6),
      );
    } else {
      addTest("T6_RAPID_CYCLING", "PASS", "100 rapid cycles OK", elapsed(t6));
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T7: STATE AFTER GARBAGE ──────────────────────────────────────────────

  {
    const t7 = now();
    await adapter.reset();
    const actsBefore = adapter.getAvailableActions();
    const stateBefore = adapter.getState();

    // Send garbage
    const garbage = ["", " ", "ZZZZ_INVALID", "a".repeat(500)];
    for (const g of garbage) {
      await safeStep(adapter, g);
    }

    // Reset and verify recovery
    try {
      await adapter.reset();
      const actsAfter = adapter.getAvailableActions();
      const stateAfter = adapter.getState();

      const issues: string[] = [];
      if (stateAfter !== "IN_PROGRESS") issues.push(`state=${stateAfter}`);
      const actSetBefore = new Set(actsBefore);
      const actSetAfter = new Set(actsAfter);
      if (
        actSetBefore.size !== actSetAfter.size ||
        ![...actSetBefore].every((a) => actSetAfter.has(a))
      ) {
        issues.push("actions changed after garbage");
      }

      if (issues.length > 0) {
        addTest(
          "T7_STATE_AFTER_GARBAGE",
          "WARN",
          issues.join("; "),
          elapsed(t7),
        );
      } else {
        addTest(
          "T7_STATE_AFTER_GARBAGE",
          "PASS",
          "state clean after garbage + reset",
          elapsed(t7),
        );
      }
    } catch (err) {
      addTest(
        "T7_STATE_AFTER_GARBAGE",
        "FAIL",
        `reset after garbage failed: ${err instanceof Error ? err.message : String(err)}`,
        elapsed(t7),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T8: REWARD BOUNDS EXTENDED ───────────────────────────────────────────

  {
    const t8 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");
    const rng = seededRandom(77);
    const violations: string[] = [];

    for (let i = 0; i < 200; i++) {
      try {
        await adapter.step(actions[Math.floor(rng() * actions.length)]!);
        const score = adapter.getScore();
        const state = adapter.getState();

        if (
          typeof score !== "number" ||
          Number.isNaN(score) ||
          !Number.isFinite(score)
        ) {
          violations.push(`step ${i}: invalid score=${score}`);
          break;
        }
        if (score < 0 || score > 1) {
          violations.push(`step ${i}: score=${score}`);
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
        "T8_REWARD_BOUNDS",
        "WARN",
        violations.slice(0, 3).join("; "),
        elapsed(t8),
      );
    } else {
      addTest(
        "T8_REWARD_BOUNDS",
        "PASS",
        "200 steps, all scores valid",
        elapsed(t8),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T9: ACTIONS STABILITY ────────────────────────────────────────────────

  {
    const t9 = now();
    await adapter.reset();
    const baseline = new Set(adapter.getAvailableActions());
    let stable = true;

    // Call 10 times
    for (let i = 0; i < 10; i++) {
      const current = new Set(adapter.getAvailableActions());
      if (
        baseline.size !== current.size ||
        ![...baseline].every((a) => current.has(a))
      ) {
        stable = false;
        break;
      }
    }

    // After invalid action
    await safeStep(adapter, "ZZZZ_INVALID_12345");
    try {
      await adapter.reset();
      const afterReset = new Set(adapter.getAvailableActions());
      if (
        baseline.size !== afterReset.size ||
        ![...baseline].every((a) => afterReset.has(a))
      ) {
        addTest(
          "T9_ACTIONS_STABILITY",
          "WARN",
          "actions changed after invalid input + reset",
          elapsed(t9),
        );
      } else if (!stable) {
        addTest(
          "T9_ACTIONS_STABILITY",
          "WARN",
          "actions inconsistent across repeated calls",
          elapsed(t9),
        );
      } else {
        addTest(
          "T9_ACTIONS_STABILITY",
          "PASS",
          "actions consistent across calls and after errors",
          elapsed(t9),
        );
      }
    } catch (err) {
      addTest(
        "T9_ACTIONS_STABILITY",
        "FAIL",
        err instanceof Error ? err.message : String(err),
        elapsed(t9),
      );
    }
  }

  if (aborted) {
    await safeDispose(adapter);
    result.totalDurationMs = elapsed(gameStart);
    return result;
  }

  // ── T10: REPEATED SAME ACTION ────────────────────────────────────────────

  {
    const t10 = now();
    await adapter.reset();
    const actions = adapter
      .getAvailableActions()
      .filter((a) => a.toLowerCase() !== "reset");

    if (actions.length === 0) {
      addTest("T10_REPEATED_ACTION", "SKIP", "no non-reset actions", 0);
    } else {
      const action = actions[0]!;
      let crashes = 0;

      for (let i = 0; i < 100; i++) {
        try {
          await adapter.step(action);
          const state = adapter.getState();
          if (state === "GAME_OVER" || state === "WIN") {
            await adapter.reset();
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
          "T10_REPEATED_ACTION",
          "FAIL",
          `${crashes} crashes repeating "${action}" 100×`,
          elapsed(t10),
        );
      } else {
        addTest(
          "T10_REPEATED_ACTION",
          "PASS",
          `"${action}" repeated 100× OK`,
          elapsed(t10),
        );
      }
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
    "║   ULTRA EDGE-CASE TEST — All Games                          ║",
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

  const allResults: GameEdgeResult[] = [];
  let totalPass = 0;
  let totalFail = 0;
  let totalWarn = 0;
  let totalTests = 0;

  console.log(
    "GAME     STATUS   TESTS    PASS   FAIL   WARN   DURATION   NOTES",
  );
  console.log("-".repeat(100));

  for (const game of games) {
    const result = await edgeTestGame(game.gameId, game.pyFile);
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
    "# Ultra Edge-Case Test Results",
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
