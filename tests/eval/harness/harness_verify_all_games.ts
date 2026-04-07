/**
 * COMPREHENSIVE TS HARNESS VERIFICATION
 * ======================================
 * Uses the REAL GameBridge and Arc3GameAdapter classes — the exact same code
 * that runs during actual evaluations. No Python mocks. No replications.
 *
 * For each game, tests the full lifecycle:
 *   Phase 1: BOOTSTRAP  — Arc3GameAdapter.create() → spawns subprocess, sends info
 *   Phase 2: RESET      — adapter.reset() → sends reset command
 *   Phase 3: ACTIONS    — adapter.step(action) × 3 with first available + "up"
 *   Phase 4: 2ND RESET  — adapter.reset() again (simulates harness re-run)
 *   Phase 5: DISPOSE    — adapter.dispose() → sends quit, kills process
 *
 * Every single response, error, stderr line, and timing is logged.
 *
 * Usage:
 *   npx tsx tests/eval/harness/harness_verify_all_games.ts
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
  "TS_HARNESS_VERIFICATION_FIXED.md",
);
const BRIDGE_TIMEOUT_MS = 15_000; // 15s per command

// ── Types ────────────────────────────────────────────────────────────────────

interface PhaseResult {
  phase: string;
  status: "OK" | "FAIL" | "SKIP";
  detail: string;
  durationMs: number;
  error?: string;
  stderr?: string[];
}

interface GameResult {
  gameId: string;
  phases: PhaseResult[];
  overallStatus: "PASS" | "FAIL";
  failedPhase: string | null;
  availableActions: string[];
  state: GameState | null;
  score: number | null;
  totalLevels: number | null;
  textObservation: string | null;
  renderText: string | null;
  stderrLines: string[];
  totalDurationMs: number;
}

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

// ── Main Test Runner ─────────────────────────────────────────────────────────

async function testGame(
  gameId: string,
  pyFilePath: string,
): Promise<GameResult> {
  const result: GameResult = {
    gameId,
    phases: [],
    overallStatus: "PASS",
    failedPhase: null,
    availableActions: [],
    state: null,
    score: null,
    totalLevels: null,
    textObservation: null,
    renderText: null,
    stderrLines: [],
    totalDurationMs: 0,
  };

  const gameStart = now();
  let adapter: Arc3GameAdapter | null = null;
  let failed = false;

  // ── Phase 1: BOOTSTRAP (create adapter = spawn subprocess + info) ──────

  const p1Start = now();
  try {
    adapter = await Arc3GameAdapter.create(gameId, pyFilePath, {
      commandTimeoutMs: BRIDGE_TIMEOUT_MS,
      allowedRoot: GAMES_DIR,
    });

    result.phases.push({
      phase: "1_BOOTSTRAP",
      status: "OK",
      detail: `title="${adapter.title}" totalLevels=${adapter.totalLevels}`,
      durationMs: elapsed(p1Start),
    });
    result.totalLevels = adapter.totalLevels;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.phases.push({
      phase: "1_BOOTSTRAP",
      status: "FAIL",
      detail: msg,
      durationMs: elapsed(p1Start),
      error: msg,
    });
    result.overallStatus = "FAIL";
    result.failedPhase = "BOOTSTRAP";
    failed = true;
  }

  // ── Phase 2: RESET ─────────────────────────────────────────────────────

  if (!failed && adapter) {
    const p2Start = now();
    try {
      await adapter.reset();

      const actions = adapter.getAvailableActions();
      const state = adapter.getState();
      const score = adapter.getScore();
      const text = adapter.renderText();

      result.availableActions = actions;
      result.state = state;
      result.score = score;
      result.renderText = text;

      result.phases.push({
        phase: "2_RESET",
        status: "OK",
        detail: `state=${state} score=${score} actions=[${actions.join(",")}]`,
        durationMs: elapsed(p2Start),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.phases.push({
        phase: "2_RESET",
        status: "FAIL",
        detail: msg,
        durationMs: elapsed(p2Start),
        error: msg,
      });
      result.overallStatus = "FAIL";
      result.failedPhase = "RESET";
      failed = true;
    }
  } else if (!failed) {
    result.phases.push({
      phase: "2_RESET",
      status: "SKIP",
      detail: "Skipped (no adapter)",
      durationMs: 0,
    });
  }

  // ── Phase 3: ACTIONS — step with first available action, then "up" ─────

  if (!failed && adapter) {
    const actionsToTry: string[] = [];

    // Pick first non-reset action from available
    for (const a of result.availableActions) {
      if (a.toLowerCase() !== "reset") {
        actionsToTry.push(a);
        break;
      }
    }
    // Also try "up" if not already chosen
    if (actionsToTry.length === 0 || actionsToTry[0] !== "up") {
      actionsToTry.push("up");
    }
    // One more step with the first action
    if (actionsToTry.length > 0) {
      actionsToTry.push(actionsToTry[0]!);
    }

    for (let i = 0; i < actionsToTry.length; i++) {
      const action = actionsToTry[i]!;
      const pStart = now();
      try {
        await adapter.step(action);

        const state = adapter.getState();
        const score = adapter.getScore();

        result.state = state;
        result.score = score;

        result.phases.push({
          phase: `3_ACTION_${i}_${action}`,
          status: "OK",
          detail: `action="${action}" → state=${state} score=${score}`,
          durationMs: elapsed(pStart),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.phases.push({
          phase: `3_ACTION_${i}_${action}`,
          status: "FAIL",
          detail: `action="${action}" → ${msg}`,
          durationMs: elapsed(pStart),
          error: msg,
        });
        result.overallStatus = "FAIL";
        result.failedPhase = `ACTION(${action})`;
        failed = true;
        break;
      }
    }
  }

  // ── Phase 4: 2ND RESET (tests re-reset after actions) ─────────────────

  if (!failed && adapter) {
    const p4Start = now();
    try {
      await adapter.reset();

      const state = adapter.getState();
      const score = adapter.getScore();

      result.phases.push({
        phase: "4_SECOND_RESET",
        status: "OK",
        detail: `state=${state} score=${score}`,
        durationMs: elapsed(p4Start),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.phases.push({
        phase: "4_SECOND_RESET",
        status: "FAIL",
        detail: msg,
        durationMs: elapsed(p4Start),
        error: msg,
      });
      result.overallStatus = "FAIL";
      result.failedPhase = "SECOND_RESET";
      failed = true;
    }
  }

  // ── Phase 5: DISPOSE ──────────────────────────────────────────────────

  if (adapter) {
    const p5Start = now();
    try {
      // Grab stderr before dispose kills the process
      const bridge = (adapter as any).bridge;
      if (bridge && typeof bridge.getStderrLines === "function") {
        result.stderrLines = bridge.getStderrLines();
      }

      await adapter.dispose();

      result.phases.push({
        phase: "5_DISPOSE",
        status: "OK",
        detail: `cleanly disposed`,
        durationMs: elapsed(p5Start),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.phases.push({
        phase: "5_DISPOSE",
        status: "FAIL",
        detail: msg,
        durationMs: elapsed(p5Start),
        error: msg,
      });
      // Don't mark overall as FAIL for dispose issues
    }
  }

  result.totalDurationMs = elapsed(gameStart);
  return result;
}

// ── Report Generation ────────────────────────────────────────────────────────

function generateReport(results: GameResult[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  const passed = results.filter((r) => r.overallStatus === "PASS");
  const failed = results.filter((r) => r.overallStatus === "FAIL");

  lines.push("# TS Harness Verification Report");
  lines.push("");
  lines.push(`**Generated:** ${timestamp}`);
  lines.push(
    `**Method:** Real \`GameBridge\` + \`Arc3GameAdapter\` classes (TypeScript, via \`npx tsx\`)`,
  );
  lines.push(`**Games directory:** \`${GAMES_DIR}\``);
  lines.push(
    `**Python binary:** \`${process.env["PYTHON_BIN"] || "python3"}\``,
  );
  lines.push(`**Bridge timeout:** ${BRIDGE_TIMEOUT_MS}ms per command`);
  lines.push(`**Total games tested:** ${results.length}`);
  lines.push(`**PASSED:** ${passed.length}  |  **FAILED:** ${failed.length}`);
  lines.push("");

  // ── Summary Table ──────────────────────────────────────────────────────

  lines.push("## Summary Table");
  lines.push("");
  lines.push(
    "| # | Game | Status | Failed Phase | Error (truncated) | Duration |",
  );
  lines.push(
    "|---|------|--------|-------------|-------------------|----------|",
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const status = r.overallStatus === "PASS" ? "PASS" : "**FAIL**";
    const phase = r.failedPhase || "-";
    const err = r.failedPhase
      ? truncate(r.phases.find((p) => p.status === "FAIL")?.error || "", 80)
      : "-";
    lines.push(
      `| ${i + 1} | ${r.gameId} | ${status} | ${phase} | ${err} | ${r.totalDurationMs}ms |`,
    );
  }

  lines.push("");

  // ── Failure Breakdown ──────────────────────────────────────────────────

  if (failed.length > 0) {
    lines.push("## Failure Breakdown by Phase");
    lines.push("");

    const byPhase: Record<string, GameResult[]> = {};
    for (const r of failed) {
      const phase = r.failedPhase || "UNKNOWN";
      if (!byPhase[phase]) byPhase[phase] = [];
      byPhase[phase]!.push(r);
    }

    for (const [phase, games] of Object.entries(byPhase).sort()) {
      lines.push(`### ${phase} (${games.length} games)`);
      lines.push("");
      lines.push(`Games: ${games.map((g) => g.gameId).join(", ")}`);
      lines.push("");
    }
  }

  // ── Detailed Per-Game Logs ─────────────────────────────────────────────

  lines.push("## Detailed Per-Game Logs");
  lines.push("");

  for (const r of results) {
    const statusBadge = r.overallStatus === "PASS" ? "PASS" : "FAIL";
    lines.push(`### ${r.gameId} — ${statusBadge}`);
    lines.push("");
    lines.push(`| Phase | Status | Detail | Duration |`);
    lines.push(`|-------|--------|--------|----------|`);

    for (const p of r.phases) {
      const statusStr =
        p.status === "OK" ? "OK" : p.status === "FAIL" ? "**FAIL**" : "SKIP";
      const detail = truncate(p.detail, 120)
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      lines.push(
        `| ${p.phase} | ${statusStr} | ${detail} | ${p.durationMs}ms |`,
      );
    }

    lines.push("");

    // Show error details for failures
    const failedPhases = r.phases.filter((p) => p.status === "FAIL");
    if (failedPhases.length > 0) {
      lines.push("**Error details:**");
      lines.push("");
      for (const fp of failedPhases) {
        lines.push("```");
        lines.push(`Phase: ${fp.phase}`);
        lines.push(`Error: ${fp.error || fp.detail}`);
        lines.push("```");
        lines.push("");
      }
    }

    // Show stderr if present
    if (r.stderrLines.length > 0) {
      lines.push("<details>");
      lines.push(
        `<summary>Subprocess stderr (${r.stderrLines.length} lines)</summary>`,
      );
      lines.push("");
      lines.push("```");
      for (const line of r.stderrLines) {
        lines.push(line);
      }
      lines.push("```");
      lines.push("</details>");
      lines.push("");
    }

    // Show render text for passing games (first frame)
    if (r.overallStatus === "PASS" && r.renderText) {
      lines.push("<details>");
      lines.push("<summary>Render text (first frame after reset)</summary>");
      lines.push("");
      lines.push("```");
      lines.push(truncate(r.renderText, 500));
      lines.push("```");
      lines.push("</details>");
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
  console.log(
    "║   TS HARNESS VERIFICATION — Real GameBridge + Adapter       ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log();
  console.log(`Games directory: ${GAMES_DIR}`);
  console.log(
    `PYTHON_BIN:     ${process.env["PYTHON_BIN"] || "(default python3)"}`,
  );
  console.log();

  // Discover games
  const discovered = discoverGames(GAMES_DIR);
  console.log(`Discovered ${discovered.length} games via discoverGames()`);

  if (discovered.length === 0) {
    console.error("ERROR: No games discovered. Check GAMES_DIR path.");
    process.exit(1);
  }

  // Also list any directories that WEREN'T discovered (missing metadata.json?)
  const allDirs = readdirSync(GAMES_DIR)
    .filter((d) => !d.startsWith("."))
    .filter((d) => {
      try {
        return statSync(join(GAMES_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  const discoveredIds = new Set(discovered.map((g) => g.gameId));
  const undiscovered = allDirs.filter((d) => !discoveredIds.has(d));
  if (undiscovered.length > 0) {
    console.log(
      `WARNING: ${undiscovered.length} directories not discovered: ${undiscovered.join(", ")}`,
    );
  }

  console.log();
  console.log(
    `${"GAME".padEnd(8)} ${"STATUS".padEnd(8)} ${"FAILED_PHASE".padEnd(20)} ${"DURATION".padEnd(10)} ERROR`,
  );
  console.log("-".repeat(100));

  const results: GameResult[] = [];

  for (const game of discovered) {
    const r = await testGame(game.gameId, game.pyFile);
    results.push(r);

    const status = r.overallStatus === "PASS" ? "PASS" : "FAIL";
    const phase = r.failedPhase || "-";
    const err = r.failedPhase
      ? truncate(r.phases.find((p) => p.status === "FAIL")?.error || "", 60)
      : "";

    console.log(
      `${r.gameId.padEnd(8)} ${status.padEnd(8)} ${phase.padEnd(20)} ${String(r.totalDurationMs + "ms").padEnd(10)} ${err}`,
    );
  }

  // Summary
  const passed = results.filter((r) => r.overallStatus === "PASS");
  const failed = results.filter((r) => r.overallStatus === "FAIL");

  console.log();
  console.log("=".repeat(100));
  console.log(
    `PASSED: ${passed.length}  FAILED: ${failed.length}  TOTAL: ${results.length}`,
  );

  if (failed.length > 0) {
    console.log();
    console.log("Failed games by phase:");
    const byPhase: Record<string, string[]> = {};
    for (const r of failed) {
      const phase = r.failedPhase || "UNKNOWN";
      if (!byPhase[phase]) byPhase[phase] = [];
      byPhase[phase]!.push(r.gameId);
    }
    for (const [phase, games] of Object.entries(byPhase).sort()) {
      console.log(`  ${phase}: ${games.join(", ")}`);
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
