import { promises as fs } from "fs";
import path from "path";
import type {
  StepRecord,
  RunRecord,
  GameType,
  TraceHeader,
  TraceStep,
  TraceSummary,
  TraceRecord,
} from "@shared/eval-types";
import {
  TRACE_SCHEMA_VERSION,
  traceHeaderSchema,
  traceStepSchema,
  traceSummarySchema,
  traceRecordSchema,
} from "@shared/evalSchemas";
import { serializedFileWrite } from "../utils/concurrency";

// ─── JsonlWriter ─────────────────────────────────────────────────────────────

function jsonDefault(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/** Cache of directories that have already been created this process. */
const ensuredDirs = new Set<string>();

/**
 * Reusable JSONL (JSON Lines) file writer.
 * Each line is a self-contained JSON object terminated by \n.
 * Ported from: writer.py JsonlWriter class
 *
 * Writes are serialized per file path to prevent interleaved appends
 * from concurrent tasks. Directory creation is cached to avoid
 * redundant mkdir syscalls (avoids ~500K extra calls at scale).
 */
export class JsonlWriter {
  private readonly filepath: string;

  constructor(filepath: string) {
    this.filepath = filepath;
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.filepath);
    if (ensuredDirs.has(dir)) return;
    await fs.mkdir(dir, { recursive: true });
    ensuredDirs.add(dir);
  }

  async append(record: Record<string, unknown>): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(record, jsonDefault) + "\n";
    await serializedFileWrite(this.filepath, () =>
      fs.appendFile(this.filepath, line, "utf-8"),
    );
  }

  async writeAll(records: Record<string, unknown>[]): Promise<void> {
    await this.ensureDir();
    const lines =
      records.map((r) => JSON.stringify(r, jsonDefault)).join("\n") + "\n";
    await serializedFileWrite(this.filepath, () =>
      fs.writeFile(this.filepath, lines, "utf-8"),
    );
  }

  async read(): Promise<Record<string, unknown>[]> {
    try {
      const content = await fs.readFile(this.filepath, "utf-8");
      return content
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
}

// ─── Session Utilities ───────────────────────────────────────────────────────

/**
 * Format a date as a session-timestamp string: YYYYMMDD_HHmmss_SSS
 * Used to create unique, human-readable session directory names.
 */
export function formatSessionTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${mo}${d}_${h}${mi}${s}_${ms}`;
}

/**
 * Write a game_metadata.json file into the session directory.
 * Contains session-level context: which models, games, config, and timestamps.
 */
export async function writeSessionMetadata(
  sessionDir: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  const metadataPath = path.join(sessionDir, "game_metadata.json");
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

// ─── Log File Writer ─────────────────────────────────────────────────────────

/** Cache to avoid mkdir on every log append. */
const logDirsEnsured = new Set<string>();

/**
 * Append a log line to a session log file.
 * Format: ISO_TIMESTAMP [LEVEL] message
 * Writes are serialized per file to prevent interleaving from concurrent emitters.
 */
export async function appendLogLine(
  logFilePath: string,
  level: string,
  message: string,
): Promise<void> {
  const dir = path.dirname(logFilePath);
  if (!logDirsEnsured.has(dir)) {
    await fs.mkdir(dir, { recursive: true });
    logDirsEnsured.add(dir);
  }
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;
  await serializedFileWrite(logFilePath, () =>
    fs.appendFile(logFilePath, line, "utf-8"),
  );
}

// ─── Trace Writer Functions ──────────────────────────────────────────────────

export async function writeTraceHeader(
  tracePath: string,
  runId: string,
  model: string,
  gameId: string,
  gameType: GameType,
  runNumber: number,
  seed: number,
  maxSteps: number,
  systemPrompt: string,
): Promise<void> {
  const header: TraceHeader = {
    type: "header",
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId,
    model,
    gameId,
    gameType,
    runNumber,
    seed,
    maxSteps,
    systemPrompt,
    timestamp: new Date().toISOString(),
  };
  traceHeaderSchema.parse(header);
  const writer = new JsonlWriter(tracePath);
  await writer.append(header as unknown as Record<string, unknown>);
}

export async function writeTraceStep(
  tracePath: string,
  stepRecord: StepRecord,
  imageSent: boolean = false,
  rawResponseFile: string | null = null,
): Promise<void> {
  const traceStep: TraceStep = {
    type: "step",
    step: stepRecord.step,
    action: stepRecord.action,
    score: stepRecord.score,
    scorePct: stepRecord.scorePct,
    level: stepRecord.level,
    totalLevels: stepRecord.totalLevels,
    done: stepRecord.done,
    state: stepRecord.state,
    reasoning: stepRecord.reasoning,
    observation: stepRecord.observation,
    notepadContents: stepRecord.notepadContents,
    inputTokens: stepRecord.inputTokens,
    outputTokens: stepRecord.outputTokens,
    reasoningTokens: stepRecord.reasoningTokens,
    thinkingText: stepRecord.thinkingText ?? null,
    cachedInputTokens: stepRecord.cachedInputTokens,
    cacheWriteTokens: stepRecord.cacheWriteTokens,
    stepCostUsd: stepRecord.stepCostUsd,
    cumulativeCostUsd: stepRecord.cumulativeCostUsd,
    imageSent,
    rawResponseFile,
    ...(stepRecord.promptMessages ? { promptMessages: stepRecord.promptMessages } : {}),
    timestamp: new Date().toISOString(),
  };
  traceStepSchema.parse(traceStep);
  const writer = new JsonlWriter(tracePath);
  await writer.append(traceStep as unknown as Record<string, unknown>);
}

/**
 * Append a raw API response to a per-run JSONL file.
 * Pattern: {modelDir}/raw_responses_run{N}.jsonl
 *
 * Each line is a JSON object with `step` at the top level for identification,
 * followed by the full raw response payload.
 *
 * @param modelDir    Per-model output directory (e.g. outputDir/gameId/SafeModel/)
 * @param runNumber   1-indexed run number
 * @param step        0-indexed step number
 * @param rawResponse The raw LLM API response object
 * @returns Relative filename (e.g. "raw_responses_run1.jsonl"), or null if rawResponse is null/undefined
 */
export async function writeRawResponse(
  modelDir: string,
  runNumber: number,
  step: number,
  rawResponse: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  if (rawResponse == null) return null;

  const fileName = `raw_responses_run${runNumber}.jsonl`;
  const filePath = path.join(modelDir, fileName);

  const entry: Record<string, unknown> = {
    step,
    timestamp: new Date().toISOString(),
    ...rawResponse,
  };

  const writer = new JsonlWriter(filePath);
  await writer.append(entry);

  return fileName;
}

/**
 * Write a SKIP record to {modelDir}/skips.jsonl
 *
 * SKIP actions represent LLM failures (malformed output, errors) that don't
 * advance the game step counter. Recording them separately prevents duplicate
 * step indices in the main trace file while preserving cost accounting.
 *
 * @param modelDir - Per-model output directory (e.g. outputDir/gameId/SafeModel/)
 * @param skipRecord - Step record with action='SKIP'
 * @param imageSent - Whether an image was included in the prompt
 */
export async function writeTraceSkip(
  modelDir: string,
  skipRecord: StepRecord,
  imageSent: boolean = false,
): Promise<void> {
  const skipPath = path.join(modelDir, "skips.jsonl");

  const skipEntry = {
    type: "skip",
    attemptedStep: skipRecord.step, // Step that would have occurred if not skipped
    action: skipRecord.action, // Should be 'SKIP'
    reasoning: skipRecord.reasoning,
    observation: skipRecord.observation,
    inputTokens: skipRecord.inputTokens,
    outputTokens: skipRecord.outputTokens,
    reasoningTokens: skipRecord.reasoningTokens,
    cachedInputTokens: skipRecord.cachedInputTokens,
    cacheWriteTokens: skipRecord.cacheWriteTokens,
    stepCostUsd: skipRecord.stepCostUsd,
    cumulativeCostUsd: skipRecord.cumulativeCostUsd,
    imageSent,
    timestamp: new Date().toISOString(),
  };

  const writer = new JsonlWriter(skipPath);
  await writer.append(skipEntry);
}

export async function writeTraceFooter(
  tracePath: string,
  runRecord: RunRecord,
): Promise<void> {
  const summary: TraceSummary = {
    type: "summary",
    runId: runRecord.runId,
    model: runRecord.model,
    gameId: runRecord.gameId,
    gameType: runRecord.gameType,
    runNumber: runRecord.runNumber,
    totalSteps: runRecord.totalSteps,
    finalScore: runRecord.finalScore,
    finalScorePct: runRecord.finalScorePct,
    solved: runRecord.solved,
    costUsd: runRecord.costUsd,
    totalInputTokens: runRecord.totalInputTokens,
    totalOutputTokens: runRecord.totalOutputTokens,
    totalReasoningTokens: runRecord.totalReasoningTokens,
    elapsedSeconds: runRecord.elapsedSeconds,
    error: runRecord.error,
    timestamp: new Date().toISOString(),
  };
  traceSummarySchema.parse(summary);
  const writer = new JsonlWriter(tracePath);
  await writer.append(summary as unknown as Record<string, unknown>);
}

/**
 * Build the trace file path for a given run.
 * Pattern: {outputDir}/{gameId}/traces/{model}_run{runNumber}_trace.jsonl
 */
export function buildTracePath(
  outputDir: string,
  gameId: string,
  model: string,
  runNumber: number,
): string {
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(
    outputDir,
    gameId,
    "traces",
    `${safeModel}_run${runNumber}_trace.jsonl`,
  );
}

/**
 * Read and parse a trace JSONL file into typed TraceRecord array.
 */
export async function readTrace(tracePath: string): Promise<TraceRecord[]> {
  const writer = new JsonlWriter(tracePath);
  const raw = await writer.read();
  return raw.map((record) => traceRecordSchema.parse(record));
}
