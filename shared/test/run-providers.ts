

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  MODEL_REGISTRY,
  ALL_MODEL_KEYS,
  getModelConfig,
  createProvider,
} from "../config/llmConfig";
import type { ChooseActionParams } from "../providers/base";

// ---------------------------------------------------------------------------
// Log file setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always write logs relative to project root (works both in dev and after esbuild bundle)
const PROJECT_ROOT = process.cwd();
const LOGS_DIR = path.join(PROJECT_ROOT, "shared", "test", "logs");

function getLogFilePath(): string {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return path.join(LOGS_DIR, `provider-test-${ts}.txt`);
}

let _logPath = "";

function log(line: string): void {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${line}\n`;
  // Write to console AND log file
  process.stdout.write(entry);
  if (_logPath) {
    appendFileSync(_logPath, entry, "utf-8");
  }
}

function logOnly(line: string): void {
  // Write to log file only (no console)
  if (_logPath) {
    const timestamp = new Date().toISOString();
    appendFileSync(_logPath, `[${timestamp}] ${line}\n`, "utf-8");
  }
}

/**
 * Redact anything that looks like an API key in a string.
 * Matches common key patterns: sk-*, key-*, Bearer *, and long alphanumeric strings.
 */
function redactKeys(text: string): string {
  return text
    // OpenAI keys: sk-proj-..., sk-...
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***REDACTED***")
    // Generic API keys: long hex/base64 strings after common key-like prefixes
    .replace(/(api[_-]?key|bearer|authorization|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}["']?/gi, "$1=***REDACTED***")
    // Anything that looks like key=value with long values
    .replace(/([A-Z_]*KEY[A-Z_]*)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}["']?/gi, "$1=***REDACTED***");
}

// ---------------------------------------------------------------------------
// Test prompt (simulates a simple ARC3 game turn)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are playing an ARC-AGI puzzle game. You must choose one action per turn.
Respond with a JSON object containing:
- "action": one of the valid actions listed below
- "reasoning": a brief explanation of why you chose this action
- "notepad_update": optional notes to remember for next turn, or null

Respond ONLY with the JSON object, no extra text.`;

const TEST_OBSERVATION = `Step 3 of 200. Current score: 0.0. Level 1 of 3.

Grid (5x5):
0 0 0 0 0
0 1 0 0 0
0 0 2 0 0
0 0 0 1 0
0 0 0 0 0

The grid shows colored cells. Navigate to solve the puzzle.`;

const VALID_ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "RESET"];

const TEST_PARAMS: ChooseActionParams = {
  systemPrompt: SYSTEM_PROMPT,
  conversationHistory: [],
  currentObservation: TEST_OBSERVATION,
  validActions: VALID_ACTIONS,
  notepad: "",
  imageB64: null,
};

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

interface TestResult {
  modelKey: string;
  modelName: string;
  provider: string;
  status: "PASS" | "FAIL" | "SKIP";
  action?: string;
  reasoning?: string;
  tokens?: { input: number; output: number; reasoning: number };
  costUsd?: number;
  latencyMs?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function testProvider(modelKey: string): Promise<TestResult> {
  const cfg = getModelConfig(modelKey);
  const envKey = cfg.envKey;
  const apiKey = process.env[envKey] ?? "";

  const base: Omit<TestResult, "status"> = {
    modelKey,
    modelName: cfg.name,
    provider: cfg.provider,
  };

  logOnly(`--- Testing: ${modelKey} (${cfg.name}) ---`);
  logOnly(`  Provider type: ${cfg.provider}`);
  logOnly(`  Model ID: ${cfg.modelId}`);
  logOnly(`  Env key: ${envKey}`);

  // Skip if API key is not set
  if (!apiKey) {
    logOnly(`  SKIPPED: ${envKey} not set`);
    return { ...base, status: "SKIP", error: `${envKey} not set` };
  }

   logOnly(`  API key: ${envKey}=(set)`);

  try {
    // Create provider via factory
    const createStart = Date.now();
    const provider = await createProvider(modelKey);
    logOnly(`  Provider created in ${Date.now() - createStart}ms`);

    // Call the async chooseAction method
    const start = Date.now();
    logOnly(`  Calling chooseActionAsync()...`);
    const response = await provider.chooseActionAsync(TEST_PARAMS);
    const latencyMs = Date.now() - start;

    // Log full response details to file
    logOnly(`  Response received in ${latencyMs}ms`);
    logOnly(`  Action: ${response.action}`);
    logOnly(`  Reasoning: ${response.reasoning ?? "(none)"}`);
    logOnly(`  Notepad update: ${response.notepadUpdate ?? "(null)"}`);
    logOnly(`  Tokens: input=${response.inputTokens ?? 0} output=${response.outputTokens ?? 0} reasoning=${response.reasoningTokens ?? 0}`);
    logOnly(`  Cached input tokens: ${response.cachedInputTokens ?? 0}`);
    logOnly(`  Cache write tokens: ${response.cacheWriteTokens ?? 0}`);
    logOnly(`  Cost: $${(response.costUsd ?? 0).toFixed(8)}`);
    logOnly(`  Traffic type: ${response.trafficType ?? "(null)"}`);
    if (response.rawResponse) {
      // Sanitize raw response: strip any field that might contain API keys
      const safe = { ...response.rawResponse };
      for (const key of Object.keys(safe)) {
        const lk = key.toLowerCase();
        if (lk.includes("key") || lk.includes("token") || lk.includes("auth") || lk.includes("secret")) {
          safe[key] = "(redacted)";
        }
      }
      logOnly(`  Raw response (truncated): ${JSON.stringify(safe).slice(0, 500)}`);
    }

    // Validate response structure
    if (!response.action || typeof response.action !== "string") {
      logOnly(`  FAIL: Invalid action type`);
      return {
        ...base,
        status: "FAIL",
        latencyMs,
        error: `Invalid action: ${JSON.stringify(response.action)}`,
      };
    }

    logOnly(`  PASS`);
    return {
      ...base,
      status: "PASS",
      action: response.action,
      reasoning: response.reasoning?.slice(0, 100) ?? "(none)",
      tokens: {
        input: response.inputTokens ?? 0,
        output: response.outputTokens ?? 0,
        reasoning: response.reasoningTokens ?? 0,
      },
      costUsd: response.costUsd ?? 0,
      latencyMs,
    };
  } catch (err: any) {
    const errMsg = redactKeys(err.message ?? String(err));
    const errStack = redactKeys(err.stack ?? "(no stack)");
    logOnly(`  FAIL: ${errMsg}`);
    logOnly(`  Stack: ${errStack}`);
    return {
      ...base,
      status: "FAIL",
      error: errMsg.slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// Deduplicate: pick one model key per provider type
// ---------------------------------------------------------------------------

function pickOnePerProvider(): string[] {
  // For providers with multiple model keys (e.g., gemini-3.1, gemini-3.1-studio),
  // test only one to avoid redundant API calls. Prefer simpler variants.
  const providerPriority: Record<string, string[]> = {
    "openai": ["gpt-5.4-thinking"],
    "gemini": ["gemini-3.1-studio"],
    "gemini-fallback": ["gemini-3.1"],
    "openrouter-gemini": ["gemini-3.1-openrouter"],
    "claude-cloud": ["claude-opus"],
    "kimi-cloud": ["kimi-k2.5"],
    "anthropic": ["claude-a1"],
    "litellm-sdk": ["litellm-sdk-gemini-3.1"],
  };

  const selected: string[] = [];
  const seen = new Set<string>();

  for (const [provider, keys] of Object.entries(providerPriority)) {
    for (const key of keys) {
      if (MODEL_REGISTRY[key] && !seen.has(provider)) {
        selected.push(key);
        seen.add(provider);
      }
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Pretty printer
// ---------------------------------------------------------------------------

function printResults(results: TestResult[]): void {
  const passed = results.filter((r) => r.status === "PASS");
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");

  const sep = "=".repeat(70);
  const dash = "-".repeat(70);

  const lines: string[] = [];
  lines.push("", sep, "  PROVIDER LIVE TEST RESULTS", sep);

  for (const r of results) {
    const icon =
      r.status === "PASS" ? "[PASS]" : r.status === "FAIL" ? "[FAIL]" : "[SKIP]";

    lines.push(`\n${icon} ${r.modelKey} (${r.modelName})`);
    lines.push(`       Provider: ${r.provider}`);

    if (r.status === "PASS") {
      lines.push(`       Action:   ${r.action}`);
      lines.push(`       Reason:   ${r.reasoning}`);
      lines.push(
        `       Tokens:   in=${r.tokens!.input} out=${r.tokens!.output} reasoning=${r.tokens!.reasoning}`
      );
      lines.push(`       Cost:     $${r.costUsd!.toFixed(6)}`);
      lines.push(`       Latency:  ${r.latencyMs}ms`);
    } else if (r.status === "SKIP") {
      lines.push(`       Reason:   ${r.error}`);
    } else {
      lines.push(`       Error:    ${r.error}`);
    }
  }

  lines.push("", dash);
  lines.push(
    `  SUMMARY: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (${results.length} total)`
  );
  lines.push(dash);

  if (failed.length > 0) {
    lines.push("", "  FAILED PROVIDERS:");
    for (const r of failed) {
      lines.push(`    - ${r.modelKey}: ${r.error}`);
    }
  }

  if (skipped.length > 0) {
    lines.push("", "  SKIPPED (set env var to enable):");
    for (const r of skipped) {
      lines.push(`    - ${r.modelKey}: ${r.error}`);
    }
  }

  lines.push("");

  // Print to console
  for (const line of lines) {
    console.log(line);
  }

  // Also write to log file
  if (_logPath) {
    const timestamp = new Date().toISOString();
    appendFileSync(_logPath, `\n[${timestamp}] === SUMMARY ===\n`, "utf-8");
    for (const line of lines) {
      appendFileSync(_logPath, line + "\n", "utf-8");
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Load .env if dotenv is available (best effort)
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    // dotenv not installed, rely on process.env
  }

  // Initialize log file
  _logPath = getLogFilePath();
  writeFileSync(_logPath, `Provider Test Run\nStarted: ${new Date().toISOString()}\n${"=".repeat(70)}\n\n`, "utf-8");
  console.log(`Log file: ${_logPath}\n`);

  const runAll = process.argv.includes("--all");
  const specificKey = process.argv.find(
    (a) => !a.startsWith("-") && MODEL_REGISTRY[a]
  );

  let modelKeys: string[];

  if (specificKey) {
    modelKeys = [specificKey];
    log(`Testing single provider: ${specificKey}`);
  } else if (runAll) {
    modelKeys = [...ALL_MODEL_KEYS];
    log(`Testing ALL ${modelKeys.length} model keys`);
  } else {
    modelKeys = pickOnePerProvider();
    log(
      `Testing ${modelKeys.length} providers (one per type). Use --all for all ${ALL_MODEL_KEYS.length} model keys.`
    );
  }

  log(`Models: ${modelKeys.join(", ")}`);

  // Check which keys are available before starting
  const available: string[] = [];
  const missing: string[] = [];
  for (const key of modelKeys) {
    const cfg = getModelConfig(key);
    if (process.env[cfg.envKey]) {
      available.push(key);
    } else {
      missing.push(key);
    }
  }

  log(`API keys found: ${available.length}/${modelKeys.length}`);
  if (missing.length > 0) {
    log(`Missing keys for: ${missing.join(", ")}`);
  }

  // Run tests sequentially (avoid rate limiting)
  const results: TestResult[] = [];
  for (const key of modelKeys) {
    process.stdout.write(`Testing ${key}... `);
    const result = await testProvider(key);
    console.log(result.status);
    results.push(result);
  }

  printResults(results);

  log(`Log written to: ${_logPath}`);

  // Exit with failure code if any test failed
  const failures = results.filter((r) => r.status === "FAIL");
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
