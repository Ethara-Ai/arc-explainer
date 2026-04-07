/**
 * Author: claude-sonnet-4-6
 * Date: 2026-03-24
 * PURPOSE: TypeScript port of Python resume.py (477 lines). Provides resume/recovery
 *   utilities for the eval harness: scanning completed runs across session directories,
 *   finding the latest session, and truncating stale/incomplete data from JSONL/CSV/trace
 *   files so an interrupted eval run can safely resume from where it left off.
 *   No external dependencies — uses Node.js fs/path only. All writes are atomic
 *   (temp file + renameSync) to match Python's os.replace semantics.
 *   Integration points: consumed by evalOrchestrator.ts and the runner CLI (index.ts)
 *   when --resume flag is active.
 * SRP/DRY check: Pass — single responsibility (resume file I/O), no duplication with
 *   existing traceWriter.ts (which only appends; this module reads + rewrites).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SESSIONS_TO_SCAN = 20;

// Regex for session directory names: YYYYMMDD_HHMMSS_* (8-digit date prefix)
const SESSION_DIR_PATTERN = /^\d{8}_/;

// ---------------------------------------------------------------------------
// Minimal inline types (intentionally NOT imported from shared modules to
// keep this file self-contained for pure file I/O use).
// ---------------------------------------------------------------------------

/** Minimal shape of a run record as stored in runs.jsonl */
interface RunRecord {
  run_number?: number;
  solved?: boolean;
  error?: string | null;
  total_steps?: number;
  max_steps?: number;
  [key: string]: unknown;
}

/** Config shape expected by scanCompletedRuns */
export interface ResumeConfig {
  outputBase: string;
  gameIds: string[];
  modelKeys: string[];
  numRuns: number;
  safeModelNames?: Record<string, string>; // modelKey -> safe filesystem name
  sessionDir?: string | null;             // if set, scan only this one session
}

// ---------------------------------------------------------------------------
// Public: isRunComplete
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _is_run_complete(record).
 * A run is considered complete if:
 *   - solved is explicitly true, OR
 *   - there is no error AND total_steps >= max_steps
 */
export function isRunComplete(record: RunRecord): boolean {
  if (record.solved === true) {
    return true;
  }
  const hasError = record.error !== undefined && record.error !== null && record.error !== '';
  if (!hasError && typeof record.total_steps === 'number' && typeof record.max_steps === 'number') {
    return record.total_steps >= record.max_steps;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public: scanCompletedRuns
// ---------------------------------------------------------------------------

/**
 * Mirrors Python scan_completed_runs().
 * Scans session directories under outputBase, finds {game_id}/{model_dir}/runs.jsonl,
 * and returns a Map of "(gameId,safeModel)" -> Set of completed 1-indexed run numbers.
 *
 * When config.sessionDir is provided, only that one directory is scanned.
 * Otherwise scans up to MAX_SESSIONS_TO_SCAN newest session directories.
 */
export function scanCompletedRuns(
  config: ResumeConfig,
): Map<string, Set<number>> {
  const { outputBase, gameIds, modelKeys, numRuns, safeModelNames, sessionDir } = config;

  // Build safe-model lookup: modelKey -> safe name (default: modelKey itself)
  const safeNameFor = (key: string): string =>
    safeModelNames?.[key] ?? key;

  const result = new Map<string, Set<number>>();

  // Initialise all (gameId, safeModel) pairs with empty sets
  for (const gameId of gameIds) {
    for (const modelKey of modelKeys) {
      const mapKey = `(${gameId},${safeNameFor(modelKey)})`;
      result.set(mapKey, new Set<number>());
    }
  }

  // Determine which session directories to examine
  let sessionDirs: string[];

  if (sessionDir) {
    // Single explicit session
    const resolved = path.resolve(outputBase, sessionDir);
    sessionDirs = fs.existsSync(resolved) ? [resolved] : [];
  } else {
    sessionDirs = _collectSessionDirs(outputBase, MAX_SESSIONS_TO_SCAN);
  }

  for (const sessDir of sessionDirs) {
    for (const gameId of gameIds) {
      for (const modelKey of modelKeys) {
        const safeModel = safeNameFor(modelKey);
        const runsPath = path.join(sessDir, gameId, safeModel, 'runs.jsonl');

        if (!fs.existsSync(runsPath)) {
          continue;
        }

        const completed = _classifyRuns(runsPath, numRuns);
        const mapKey = `(${gameId},${safeModel})`;
        const existing = result.get(mapKey)!;
        for (const runNum of completed) {
          existing.add(runNum);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: findLatestSession
// ---------------------------------------------------------------------------

/**
 * Mirrors Python find_latest_session(output_base).
 * Returns the absolute path of the most-recently-created session directory, or null.
 */
export function findLatestSession(outputBase: string): string | null {
  const dirs = _collectSessionDirs(outputBase, 1);
  return dirs.length > 0 ? dirs[0] : null;
}

// ---------------------------------------------------------------------------
// Public: truncateStaleData
// ---------------------------------------------------------------------------

/**
 * Mirrors Python truncate_stale_data().
 * Removes incomplete run records from runs.jsonl and then truncates all satellite
 * files (steps.jsonl, skips.jsonl, token_usage.csv, token_usage_summary.csv,
 * traces/{model}_trace.jsonl) to only keep rows belonging to fully-completed runs.
 *
 * @param sessionDir   Root session directory (e.g. "output/20260324_120000_run")
 * @param gameIds      If provided, only process these game IDs; otherwise all subdirs
 * @param safeModelNames  If provided, only process these safe model names; else all subdirs
 */
export function truncateStaleData(
  sessionDir: string,
  gameIds?: string[],
  safeModelNames?: string[],
): void {
  if (!fs.existsSync(sessionDir)) {
    logger.warn(`[resumeManager] truncateStaleData: session dir not found: ${sessionDir}`, 'eval-resume');
    return;
  }

  // Enumerate game directories
  const gameDirs = _subdirs(sessionDir).filter(
    (d) => !gameIds || gameIds.includes(path.basename(d)),
  );

  for (const gameDir of gameDirs) {
    const gameId = path.basename(gameDir);

    // Enumerate model directories inside game dir
    const modelDirs = _subdirs(gameDir).filter(
      (d) => !safeModelNames || safeModelNames.includes(path.basename(d)),
    );

    for (const modelDir of modelDirs) {
      const safeModel = path.basename(modelDir);
      const runsPath = path.join(modelDir, 'runs.jsonl');

      if (!fs.existsSync(runsPath)) {
        continue;
      }

      // Purge incomplete runs and collect the set of complete run numbers
      const keepRuns = _purgeIncompleteRuns(runsPath, `${gameId}/${safeModel}/runs.jsonl`);

      // Safety: if runs.jsonl was empty before purging, skip satellite truncation
      if (keepRuns === null) {
        logger.info(
          `[resumeManager] Skipping satellite truncation for ${gameId}/${safeModel} (runs.jsonl was already empty)`,
          'eval-resume',
        );
        continue;
      }

      // Truncate JSONL satellites
      const jsonlSatellites: Array<{ file: string; keyField: string }> = [
        { file: 'steps.jsonl', keyField: 'run_number' },
        { file: 'skips.jsonl', keyField: 'run_number' },
      ];

      for (const { file, keyField } of jsonlSatellites) {
        const filePath = path.join(modelDir, file);
        if (fs.existsSync(filePath)) {
          _truncateJsonl(filePath, keyField, keepRuns, `${gameId}/${safeModel}/${file}`);
        }
      }

      // Truncate CSV satellites
      const csvSatellites = ['token_usage.csv', 'token_usage_summary.csv'];
      for (const file of csvSatellites) {
        const filePath = path.join(modelDir, file);
        if (fs.existsSync(filePath)) {
          _truncateCsv(filePath, 'run_number', keepRuns, `${gameId}/${safeModel}/${file}`);
        }
      }

      // Truncate trace file: {sessionDir}/{gameId}/traces/{safeModel}_trace.jsonl
      const tracePath = path.join(gameDir, 'traces', `${safeModel}_trace.jsonl`);
      if (fs.existsSync(tracePath)) {
        _truncateTrace(tracePath, keepRuns, `${gameId}/traces/${safeModel}_trace.jsonl`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public: atomicWriteText
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _atomic_write_text().
 * Writes content to a temp file in the same directory as targetPath,
 * then renames it to targetPath (atomic from the OS perspective).
 */
export function atomicWriteText(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  // Create temp file in same directory for atomic rename across same filesystem
  const tmpPath = path.join(dir, `.tmp_${process.pid}_${Date.now()}_${path.basename(targetPath)}`);

  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal: _isSessionDir
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _is_session_dir(name).
 * Returns true if name matches the YYYYMMDD_ prefix pattern.
 */
export function _isSessionDir(name: string): boolean {
  return SESSION_DIR_PATTERN.test(name);
}

// ---------------------------------------------------------------------------
// Internal: _classifyRuns
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _classify_runs(path).
 * Reads runs.jsonl, classifies each line, and returns a Set of completed
 * 1-indexed run numbers capped to 1..numRuns if numRuns > 0.
 *
 * @param runsPath  Absolute path to runs.jsonl
 * @param numRuns   Cap value (0 = no cap)
 */
export function _classifyRuns(runsPath: string, numRuns = 0): Set<number> {
  const completed = new Set<number>();

  let raw: string;
  try {
    raw = fs.readFileSync(runsPath, 'utf8');
  } catch (err) {
    logger.warn(`[resumeManager] _classifyRuns: cannot read ${runsPath}: ${(err as Error).message}`, 'eval-resume');
    return completed;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  for (const line of lines) {
    let record: RunRecord;
    try {
      record = JSON.parse(line) as RunRecord;
    } catch {
      // Skip malformed lines
      continue;
    }

    if (typeof record.run_number !== 'number') {
      continue;
    }

    const runNum = record.run_number;

    // Cap to valid range if numRuns was provided
    if (numRuns > 0 && (runNum < 1 || runNum > numRuns)) {
      continue;
    }

    if (isRunComplete(record)) {
      completed.add(runNum);
    }
  }

  return completed;
}

// ---------------------------------------------------------------------------
// Internal: _purgeIncompleteRuns
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _purge_incomplete_runs(path, label).
 * Reads runs.jsonl, removes records for incomplete runs, rewrites atomically.
 *
 * Returns:
 *   - A Set<number> of run numbers that are complete (and were kept), OR
 *   - null if the file was empty before purging (sentinel for "skip satellites")
 */
export function _purgeIncompleteRuns(runsPath: string, label: string): Set<number> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(runsPath, 'utf8');
  } catch (err) {
    logger.warn(`[resumeManager] _purgeIncompleteRuns: cannot read ${label}: ${(err as Error).message}`, 'eval-resume');
    return new Set<number>();
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Safety sentinel: file was already empty
  if (lines.length === 0) {
    return null;
  }

  const keepLines: string[] = [];
  const keepRuns = new Set<number>();

  for (const line of lines) {
    let record: RunRecord;
    try {
      record = JSON.parse(line) as RunRecord;
    } catch {
      // Keep malformed lines as-is to avoid data loss
      keepLines.push(line);
      continue;
    }

    if (isRunComplete(record)) {
      keepLines.push(line);
      if (typeof record.run_number === 'number') {
        keepRuns.add(record.run_number);
      }
    } else {
      logger.info(
        `[resumeManager] Removing incomplete run #${record.run_number ?? '?'} from ${label}`,
        'eval-resume',
      );
    }
  }

  const newContent = keepLines.length > 0 ? keepLines.join('\n') + '\n' : '';
  atomicWriteText(runsPath, newContent);

  return keepRuns;
}

// ---------------------------------------------------------------------------
// Internal: _truncateJsonl
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _truncate_jsonl(path, key, keep_runs, label).
 * Reads a JSONL file and retains only records whose `key` field value is in keepRuns.
 * Rewrites the file atomically.
 */
export function _truncateJsonl(
  filePath: string,
  keyField: string,
  keepRuns: Set<number>,
  label: string,
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn(`[resumeManager] _truncateJsonl: cannot read ${label}: ${(err as Error).message}`, 'eval-resume');
    return;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const before = lines.length;

  const keepLines: string[] = [];
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Preserve unparseable lines
      keepLines.push(line);
      continue;
    }

    const runNum = record[keyField];
    if (typeof runNum === 'number' && keepRuns.has(runNum)) {
      keepLines.push(line);
    }
    // Records with no key field or non-kept run numbers are dropped
  }

  const after = keepLines.length;
  if (after < before) {
    logger.info(`[resumeManager] _truncateJsonl: ${label}: ${before} -> ${after} records`, 'eval-resume');
  }

  const newContent = keepLines.length > 0 ? keepLines.join('\n') + '\n' : '';
  atomicWriteText(filePath, newContent);
}

// ---------------------------------------------------------------------------
// Internal: _truncateCsv
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _truncate_csv(path, col_name, keep_runs, label).
 * Reads a CSV file, preserves the header row, and retains only data rows whose
 * `colName` column value (parsed as integer) is in keepRuns.
 * Rewrites the file atomically.
 */
export function _truncateCsv(
  filePath: string,
  colName: string,
  keepRuns: Set<number>,
  label: string,
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn(`[resumeManager] _truncateCsv: cannot read ${label}: ${(err as Error).message}`, 'eval-resume');
    return;
  }

  const lines = raw.split('\n');

  // Remove trailing empty lines but remember final newline intent
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return; // Nothing to do
  }

  // First line is the header
  const header = lines[0];
  const dataLines = lines.slice(1);

  // Find the column index for colName
  const headers = _parseCsvLine(header);
  const colIdx = headers.indexOf(colName);

  if (colIdx === -1) {
    logger.warn(`[resumeManager] _truncateCsv: column "${colName}" not found in ${label}, skipping`, 'eval-resume');
    return;
  }

  const before = dataLines.length;
  const keepDataLines: string[] = [];

  for (const line of dataLines) {
    if (line.trim() === '') continue;
    const cols = _parseCsvLine(line);
    const runNum = parseInt(cols[colIdx] ?? '', 10);
    if (!isNaN(runNum) && keepRuns.has(runNum)) {
      keepDataLines.push(line);
    }
  }

  const after = keepDataLines.length;
  if (after < before) {
    logger.info(`[resumeManager] _truncateCsv: ${label}: ${before} -> ${after} data rows`, 'eval-resume');
  }

  const allLines = [header, ...keepDataLines];
  const newContent = allLines.join('\n') + '\n';
  atomicWriteText(filePath, newContent);
}

// ---------------------------------------------------------------------------
// Internal: _truncateTrace
// ---------------------------------------------------------------------------

/**
 * Mirrors Python _truncate_trace(path, keep_runs, label).
 * Trace files are JSONL with a `run_number` field. Retains only records in keepRuns.
 * Delegates to _truncateJsonl with key="run_number".
 */
export function _truncateTrace(
  filePath: string,
  keepRuns: Set<number>,
  label: string,
): void {
  _truncateJsonl(filePath, 'run_number', keepRuns, label);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Lists immediate subdirectories of a directory.
 */
function _subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Returns up to `limit` session directories under outputBase, newest first.
 * A session directory must match the YYYYMMDD_ prefix pattern and be a directory.
 */
function _collectSessionDirs(outputBase: string, limit: number): string[] {
  if (!fs.existsSync(outputBase)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(outputBase, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionEntries = entries.filter(
    (e) => e.isDirectory() && _isSessionDir(e.name),
  );

  // Sort by name descending (YYYYMMDD_HHMMSS prefix ensures lexicographic = chronological)
  sessionEntries.sort((a, b) => b.name.localeCompare(a.name));

  return sessionEntries
    .slice(0, limit)
    .map((e) => path.join(outputBase, e.name));
}

/**
 * Minimal CSV line parser that handles double-quoted fields with embedded commas.
 * Sufficient for the numeric/string data in token_usage*.csv files.
 */
function _parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote inside quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result;
}
