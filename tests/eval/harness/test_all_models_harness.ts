/**
 * TEST ALL MODELS — TS Eval Harness Integration Test
 * ===================================================
 * Tests the full TypeScript eval harness pipeline for every model in MODEL_REGISTRY:
 *   1. Bootstrap a real PuzzleEnvironment game via GameBridge
 *   2. Create a LiteLLMSdkProvider for each model
 *   3. Make one real API call per model with actual game state
 *   4. Verify we get a valid ProviderResponse with rawResponse
 *   5. Report results with full raw response details
 *
 * Usage:
 *   npx tsx tests/eval/harness/test_all_models_harness.ts
 *
 * Optional env overrides:
 *   GAME_ID=bb01          (default: bb01)
 *   MODELS=claude-opus,kimi-k2.5  (comma-separated subset, default: all)
 */

import "dotenv/config";

import { GameBridge } from "../../../server/services/eval/adapters/gameBridge";
import {
  ALL_MODEL_KEYS,
  MODEL_REGISTRY,
  createProvider,
  getApiKey,
} from "../../../shared/config/llmConfig";
import type {
  ProviderResponse,
  ChooseActionParams,
} from "../../../shared/providers/base";
import type { BridgeFrameResponse } from "../../../server/services/eval/adapters/types";

// ── Config ──────────────────────────────────────────────────────────────────

const GAME_ID = process.env.GAME_ID ?? "bb01";
const SELECTED_MODELS = process.env.MODELS
  ? process.env.MODELS.split(",").map((s) => s.trim())
  : ALL_MODEL_KEYS;
const CALL_TIMEOUT_MS = 180_000; // 3 minutes per model call

// ── Types ───────────────────────────────────────────────────────────────────

interface ModelTestResult {
  modelKey: string;
  modelName: string;
  status: "SUCCESS" | "FAIL" | "SKIP";
  durationMs: number;
  action?: string;
  reasoning?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  thinkingText?: string | null;
  hasRawResponse: boolean;
  rawResponseKeys?: string[];
  rawResponseSnippet?: string;
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hr(char = "─", len = 80): string {
  return char.repeat(len);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

function buildSystemPrompt(gameId: string, actions: string[]): string {
  return [
    `You are playing an ARC-AGI puzzle game called "${gameId}".`,
    `Your goal is to solve the puzzle by choosing the best action each turn.`,
    `Available actions: ${actions.join(", ")}`,
    `Think step by step about what you observe, then choose the best action.`,
  ].join("\n");
}

function buildObservation(frame: BridgeFrameResponse): string {
  const lines: string[] = [];
  lines.push(`== Turn Observation ==`);
  lines.push(`Score: ${frame.score}`);
  lines.push(`State: ${frame.state}`);
  lines.push(
    `Step: ${frame.action_counter ?? 0} / ${frame.max_actions ?? 200}`,
  );
  if (frame.text_observation) {
    lines.push(`\nText Observation:\n${frame.text_observation}`);
  }
  if (frame.available_actions?.length) {
    lines.push(`\nAvailable Actions: ${frame.available_actions.join(", ")}`);
  }
  // Include a small grid representation
  if (frame.frame && Array.isArray(frame.frame)) {
    const gridHeight = frame.frame.length;
    const gridWidth = Array.isArray(frame.frame[0]) ? frame.frame[0].length : 0;
    lines.push(`\nGrid: ${gridHeight}x${gridWidth}`);
    // Show first few rows
    const maxRows = Math.min(5, gridHeight);
    for (let r = 0; r < maxRows; r++) {
      const row = frame.frame[r];
      if (Array.isArray(row)) {
        lines.push(row.map((c: number) => String(c).padStart(2)).join(" "));
      }
    }
    if (gridHeight > maxRows) {
      lines.push(`  ... (${gridHeight - maxRows} more rows)`);
    }
  }
  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(hr("="));
  console.log("  TS EVAL HARNESS — ALL MODELS INTEGRATION TEST");
  console.log(hr("="));
  console.log(`Game:   ${GAME_ID}`);
  console.log(`Models: ${SELECTED_MODELS.join(", ")}`);
  console.log(`Time:   ${new Date().toISOString()}`);
  console.log(hr());

  // ── Phase 1: Bootstrap game ───────────────────────────────────────────
  console.log("\n[Phase 1] Bootstrapping PuzzleEnvironment game...");

  let bridge: GameBridge;
  try {
    bridge = GameBridge.fromGameId(GAME_ID);
  } catch (err) {
    console.error(`FATAL: Could not find game '${GAME_ID}': ${err}`);
    process.exit(1);
  }

  let info;
  try {
    info = await bridge.start();
    console.log(`  Game started: ${info.game_id}`);
    console.log(
      `  Available actions: ${info.available_actions?.join(", ") ?? "N/A"}`,
    );
    console.log(`  Total levels: ${info.total_levels ?? "unknown"}`);
  } catch (err) {
    console.error(`FATAL: Could not start game bridge: ${err}`);
    console.error(
      `  Stderr: ${bridge.getStderrLines().slice(-5).join("\n  ")}`,
    );
    process.exit(1);
  }

  // Reset to get initial frame
  let frame: BridgeFrameResponse;
  try {
    frame = await bridge.reset();
    console.log(`  Reset OK — Score: ${frame.score}, State: ${frame.state}`);
    console.log(
      `  Actions available: ${frame.available_actions?.join(", ") ?? "none"}`,
    );
  } catch (err) {
    console.error(`FATAL: Could not reset game: ${err}`);
    await bridge.quit();
    process.exit(1);
  }

  const validActions = frame.available_actions ??
    info.available_actions ?? ["up", "down", "left", "right"];
  const systemPrompt = buildSystemPrompt(GAME_ID, validActions);
  const observation = buildObservation(frame);

  console.log(`\n  System prompt: ${truncate(systemPrompt, 120)}`);
  console.log(`  Observation:   ${truncate(observation, 120)}`);
  console.log(hr());

  // ── Phase 2: Test each model ──────────────────────────────────────────
  const results: ModelTestResult[] = [];

  for (const modelKey of SELECTED_MODELS) {
    console.log(`\n${hr("─")}`);
    console.log(`[Model] ${modelKey}`);

    const cfg = MODEL_REGISTRY[modelKey];
    if (!cfg) {
      console.log(`  SKIP: Unknown model key`);
      results.push({
        modelKey,
        modelName: "unknown",
        status: "SKIP",
        durationMs: 0,
        hasRawResponse: false,
        error: "Unknown model key",
      });
      continue;
    }

    // Check API key
    let apiKeyValid = false;
    try {
      getApiKey(modelKey);
      apiKeyValid = true;
    } catch (err) {
      console.log(
        `  SKIP: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({
        modelKey,
        modelName: cfg.name,
        status: "SKIP",
        durationMs: 0,
        hasRawResponse: false,
        error: `API key not available: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    console.log(`  Name:     ${cfg.name}`);
    console.log(`  Model ID: ${cfg.modelId}`);
    console.log(`  LiteLLM:  ${cfg.litellmModel ?? cfg.modelId}`);
    console.log(`  Provider: ${cfg.provider}`);
    console.log(`  Thinking: ${cfg.enableThinking ?? true}`);
    console.log(`  Hint:     ${cfg.providerHint ?? "none"}`);

    let provider: any;
    try {
      provider = await createProvider(modelKey);
      console.log(`  Provider created: ${provider.modelName}`);
    } catch (err) {
      console.log(`  FAIL: Could not create provider: ${err}`);
      results.push({
        modelKey,
        modelName: cfg.name,
        status: "FAIL",
        durationMs: 0,
        hasRawResponse: false,
        error: `Provider creation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Build the ChooseActionParams
    const params: ChooseActionParams = {
      systemPrompt,
      conversationHistory: [],
      currentObservation: observation,
      validActions,
      notepad: "",
      imageB64: null,
    };

    // Make the API call
    const t0 = Date.now();
    let response: ProviderResponse | null = null;
    let callError: string | null = null;

    try {
      console.log(`  Calling ${cfg.name} via LiteLLM SDK bridge...`);

      // Use AbortController for timeout
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);

      response = await provider.chooseActionAsync(params, ac.signal);
      clearTimeout(timeout);
    } catch (err) {
      callError = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR: ${truncate(callError, 200)}`);
    }

    const durationMs = Date.now() - t0;

    // Shutdown the provider's Python subprocess
    if (typeof provider.shutdown === "function") {
      try {
        await provider.shutdown();
      } catch {
        // Ignore shutdown errors
      }
    }

    if (response) {
      console.log(`  SUCCESS in ${durationMs}ms`);
      console.log(`    Action:          ${response.action}`);
      console.log(`    Reasoning:       ${truncate(response.reasoning, 100)}`);
      console.log(`    Input tokens:    ${response.inputTokens}`);
      console.log(`    Output tokens:   ${response.outputTokens}`);
      console.log(`    Reasoning tkns:  ${response.reasoningTokens}`);
      console.log(`    Cached input:    ${response.cachedInputTokens}`);
      console.log(`    Cache write:     ${response.cacheWriteTokens}`);
      console.log(`    Cost USD:        $${(response.costUsd ?? 0).toFixed(6)}`);
      console.log(
        `    Has thinking:    ${response.thinkingText ? "yes (" + response.thinkingText.length + " chars)" : "no"}`,
      );
      console.log(`    Has raw resp:    ${response.rawResponse != null}`);

      if (response.rawResponse) {
        const keys = Object.keys(response.rawResponse);
        console.log(`    Raw resp keys:   ${keys.join(", ")}`);

        // Show snippet of raw response
        const snippet = JSON.stringify(response.rawResponse, null, 2);
        console.log(`    Raw response snippet (first 500 chars):`);
        console.log(`    ${truncate(snippet, 500).split("\n").join("\n    ")}`);
      }

      if (response.thinkingText) {
        console.log(`    Thinking text (first 200 chars):`);
        console.log(`    ${truncate(response.thinkingText, 200)}`);
      }

      results.push({
        modelKey,
        modelName: cfg.name,
        status: "SUCCESS",
        durationMs,
        action: response.action,
        reasoning: response.reasoning,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        reasoningTokens: response.reasoningTokens,
        costUsd: response.costUsd ?? undefined,
        thinkingText: response.thinkingText,
        hasRawResponse: response.rawResponse != null,
        rawResponseKeys: response.rawResponse
          ? Object.keys(response.rawResponse)
          : [],
        rawResponseSnippet: response.rawResponse
          ? truncate(JSON.stringify(response.rawResponse), 1000)
          : undefined,
      });
    } else {
      results.push({
        modelKey,
        modelName: cfg.name,
        status: "FAIL",
        durationMs,
        hasRawResponse: false,
        error: callError ?? "No response received",
      });
    }
  }

  // ── Phase 3: Cleanup game ─────────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("[Phase 3] Cleaning up game bridge...");
  try {
    await bridge.quit();
    console.log("  Game bridge shut down cleanly.");
  } catch (err) {
    console.log(`  Warning: bridge cleanup error: ${err}`);
  }

  // ── Phase 4: Summary ─────────────────────────────────────────────────
  console.log(`\n${hr("=")}`);
  console.log("  RESULTS SUMMARY");
  console.log(hr("="));

  const successes = results.filter((r) => r.status === "SUCCESS");
  const failures = results.filter((r) => r.status === "FAIL");
  const skips = results.filter((r) => r.status === "SKIP");

  console.log(`\n  Total:     ${results.length}`);
  console.log(`  Success:   ${successes.length}`);
  console.log(`  Failed:    ${failures.length}`);
  console.log(`  Skipped:   ${skips.length}`);
  console.log();

  // Table header
  const colModel = 25;
  const colStatus = 10;
  const colTime = 10;
  const colAction = 15;
  const colTokens = 20;
  const colCost = 12;
  const colRaw = 8;

  console.log(
    "  " +
      "Model".padEnd(colModel) +
      "Status".padEnd(colStatus) +
      "Time".padEnd(colTime) +
      "Action".padEnd(colAction) +
      "Tokens (in/out/rsn)".padEnd(colTokens) +
      "Cost USD".padEnd(colCost) +
      "RawResp".padEnd(colRaw),
  );
  console.log(
    "  " +
      hr(
        "─",
        colModel +
          colStatus +
          colTime +
          colAction +
          colTokens +
          colCost +
          colRaw,
      ),
  );

  for (const r of results) {
    const model = truncate(r.modelKey, colModel - 2).padEnd(colModel);
    const status = r.status.padEnd(colStatus);
    const time =
      r.durationMs > 0
        ? `${(r.durationMs / 1000).toFixed(1)}s`.padEnd(colTime)
        : "N/A".padEnd(colTime);
    const action = (r.action ?? "-").padEnd(colAction);
    const tokens =
      r.status === "SUCCESS"
        ? `${r.inputTokens}/${r.outputTokens}/${r.reasoningTokens}`.padEnd(
            colTokens,
          )
        : "-".padEnd(colTokens);
    const cost =
      r.status === "SUCCESS"
        ? `$${r.costUsd?.toFixed(4) ?? "0"}`.padEnd(colCost)
        : "-".padEnd(colCost);
    const raw = (r.hasRawResponse ? "YES" : "NO").padEnd(colRaw);

    console.log(`  ${model}${status}${time}${action}${tokens}${cost}${raw}`);
  }

  // Failures detail
  if (failures.length > 0) {
    console.log(`\n  FAILURES:`);
    for (const f of failures) {
      console.log(`    ${f.modelKey}: ${f.error}`);
    }
  }

  // Skips detail
  if (skips.length > 0) {
    console.log(`\n  SKIPPED:`);
    for (const s of skips) {
      console.log(`    ${s.modelKey}: ${s.error}`);
    }
  }

  // Success with raw response detail
  const withRaw = successes.filter((r) => r.hasRawResponse);
  if (withRaw.length > 0) {
    console.log(`\n  SUCCESSFUL RAW RESPONSES (${withRaw.length}):`);
    for (const r of withRaw) {
      console.log(`\n    ${r.modelKey} (${r.modelName}):`);
      console.log(`      Action: ${r.action}`);
      console.log(`      Reasoning: ${truncate(r.reasoning ?? "", 150)}`);
      console.log(`      Raw keys: ${r.rawResponseKeys?.join(", ")}`);
    }
  }

  console.log(`\n${hr("=")}`);

  // Exit code: 0 if at least one success with raw response, 1 otherwise
  if (withRaw.length > 0) {
    console.log(
      "  PASS: At least one model returned a successful response with rawResponse.",
    );
    process.exit(0);
  } else {
    console.log(
      "  FAIL: No model returned a successful response with rawResponse.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err}`);
  process.exit(1);
});
