/**
 * Author: Claude Haiku 4.5
 * Date: 2026-03-24
 * PURPOSE: One-off cleanup script for orphaned step/skip/CSV records left by the
 *          resume truncation bug. Handles two cases:
 *
 *          Case 1: runs.jsonl is empty (all runs failed) but steps.jsonl etc. still
 *                  have data -> empties the satellite files.
 *
 *          Case 2: runs.jsonl has completed records but steps.jsonl has duplicate
 *                  records from a prior failed attempt (same run_number, different
 *                  run_id) -> filters to keep only records matching valid run_ids.
 *
 *          Uses run_id (unique per execution) as the join key, not run_number
 *          (which collides across resume attempts).
 *
 *          Works on both eval harness session directories AND flat model directories
 *          (like delivery exports).
 *
 * SRP/DRY check: Pass -- standalone cleanup script, no external dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface FileCleanupStats {
  kept: number;
  removed: number;
}

interface CleanupResult {
  dir: string;
  valid_run_ids: number;
  files: Record<string, FileCleanupStats>;
}

/**
 * Write content to path atomically via temp file + fs.renameSync.
 */
function atomicWriteText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  try {
    fs.writeFileSync(tmpFile, content, 'utf-8');
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Find all directories containing a runs.jsonl file.
 */
function findModelDirs(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Check if this directory contains runs.jsonl
          if (fs.existsSync(path.join(fullPath, 'runs.jsonl'))) {
            results.push(fullPath);
          }
          // Recurse into subdirectories
          walk(fullPath);
        }
      }
    } catch (error) {
      // Ignore permission errors, etc.
    }
  }

  walk(root);
  return results.sort();
}

/**
 * Extract the set of run_id values from runs.jsonl.
 */
function loadValidRunIds(runsPath: string): Set<string> {
  const runIds = new Set<string>();

  if (!fs.existsSync(runsPath)) {
    return runIds;
  }

  try {
    const content = fs.readFileSync(runsPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) {
        continue;
      }

      try {
        const record = JSON.parse(stripped);
        const rid = record.run_id;
        if (typeof rid === 'string' && rid) {
          runIds.add(rid);
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  } catch (error) {
    // If file can't be read, return empty set
  }

  return runIds;
}

/**
 * Filter JSONL file to keep only records with run_id in validRunIds.
 * Returns [kept, removed] counts.
 */
function cleanJsonl(filePath: string, validRunIds: Set<string>, dryRun: boolean): [number, number] {
  if (!fs.existsSync(filePath)) {
    return [0, 0];
  }

  const keptLines: string[] = [];
  let removed = 0;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) {
        continue;
      }

      try {
        const record = JSON.parse(stripped);
        const rid = record.run_id || '';
        if (validRunIds.has(rid)) {
          keptLines.push(stripped);
        } else {
          removed += 1;
        }
      } catch {
        removed += 1;
      }
    }

    if (removed > 0 && !dryRun) {
      const newContent = keptLines.length > 0 ? keptLines.join('\n') + '\n' : '';
      atomicWriteText(filePath, newContent);
    }
  } catch (error) {
    // If file can't be read, skip it
  }

  return [keptLines.length, removed];
}

/**
 * Filter CSV file to keep header + rows where run_id column is in validRunIds.
 * Falls back gracefully if no run_id column exists.
 * Returns [kept, removed] counts (excluding header).
 */
function cleanCsv(filePath: string, validRunIds: Set<string>, dryRun: boolean): [number, number] {
  if (!fs.existsSync(filePath)) {
    return [0, 0];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    if (lines.length < 2) {
      return [0, 0];
    }

    const header = parseCSVLine(lines[0]);

    // Find run_id column index
    let colIdx = -1;
    try {
      colIdx = header.indexOf('run_id');
    } catch {
      // No run_id column
    }

    if (colIdx === -1) {
      // Cannot reliably filter without run_id column
      return [lines.length - 1, 0];
    }

    const kept: string[] = [lines[0]];
    let removed = 0;

    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      try {
        if (row[colIdx] && validRunIds.has(row[colIdx])) {
          kept.push(lines[i]);
        } else {
          removed += 1;
        }
      } catch {
        removed += 1;
      }
    }

    if (removed > 0 && !dryRun) {
      const newContent = kept.join('\n') + '\n';
      atomicWriteText(filePath, newContent);
    }

    return [kept.length - 1, removed];
  } catch (error) {
    // If file can't be read, skip it
  }

  return [0, 0];
}

/**
 * Simple CSV line parser (handles quoted fields).
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

/**
 * Filter trace JSONL to keep only records with run_id in validRunIds.
 * Returns [kept, removed] counts.
 */
function cleanTrace(filePath: string, validRunIds: Set<string>, dryRun: boolean): [number, number] {
  if (!fs.existsSync(filePath)) {
    return [0, 0];
  }

  const keptLines: string[] = [];
  let removed = 0;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) {
        continue;
      }

      try {
        const record = JSON.parse(stripped);
        const rid = record.run_id || '';
        if (validRunIds.has(rid)) {
          keptLines.push(stripped);
        } else {
          removed += 1;
        }
      } catch {
        removed += 1;
      }
    }

    if (removed > 0 && !dryRun) {
      const newContent = keptLines.length > 0 ? keptLines.join('\n') + '\n' : '';
      atomicWriteText(filePath, newContent);
    }
  } catch (error) {
    // If file can't be read, skip it
  }

  return [keptLines.length, removed];
}

/**
 * Clean orphaned records from a single model directory.
 * Returns a summary object with before/after counts.
 */
export function cleanModelDir(modelDir: string, dryRun: boolean): CleanupResult {
  const runsPath = path.join(modelDir, 'runs.jsonl');
  const validRunIds = loadValidRunIds(runsPath);

  const result: CleanupResult = {
    dir: modelDir,
    valid_run_ids: validRunIds.size,
    files: {},
  };

  // Clean JSONL files
  for (const jsonlName of ['steps.jsonl', 'skips.jsonl']) {
    const filePath = path.join(modelDir, jsonlName);
    if (fs.existsSync(filePath)) {
      const [kept, removed] = cleanJsonl(filePath, validRunIds, dryRun);
      if (removed > 0) {
        result.files[jsonlName] = { kept, removed };
      }
    }
  }

  // Clean CSV files
  for (const csvName of ['token_usage.csv', 'token_usage_summary.csv']) {
    const filePath = path.join(modelDir, csvName);
    if (fs.existsSync(filePath)) {
      const [kept, removed] = cleanCsv(filePath, validRunIds, dryRun);
      if (removed > 0) {
        result.files[csvName] = { kept, removed };
      }
    }
  }

  // Traces may be in a sibling traces/ directory (eval harness layout)
  const safeModel = path.basename(modelDir);
  const tracesPath = path.join(path.dirname(modelDir), 'traces', `${safeModel}_trace.jsonl`);
  if (fs.existsSync(tracesPath)) {
    const [kept, removed] = cleanTrace(tracesPath, validRunIds, dryRun);
    if (removed > 0) {
      result.files[`traces/${safeModel}_trace.jsonl`] = { kept, removed };
    }
  }

  return result;
}

/**
 * Find all model directories recursively.
 */
export { findModelDirs };

/**
 * CLI entry point.
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx ts-node cleanupOrphanedSteps.ts <path> [--dry-run]');
    console.error('');
    console.error('Examples:');
    console.error('  # Dry run on a single model directory:');
    console.error('  npx ts-node cleanupOrphanedSteps.ts /path/to/Kimi_k2.5_(Cloud_ARN) --dry-run');
    console.error('');
    console.error('  # Clean all model dirs under a session:');
    console.error('  npx ts-node cleanupOrphanedSteps.ts /data/puzzle-evals/20260317_020000_consolidated');
    console.error('');
    console.error('  # Clean everything under the output root:');
    console.error('  npx ts-node cleanupOrphanedSteps.ts /data/puzzle-evals');
    process.exit(1);
  }

  const targetPath = args[0];
  const dryRun = args.includes('--dry-run');

  const root = path.resolve(targetPath);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Error: ${root} is not a directory`);
    process.exit(1);
  }

  const modelDirs = findModelDirs(root);

  if (modelDirs.length === 0) {
    console.log(`No model directories (containing runs.jsonl) found under ${root}`);
    process.exit(0);
  }

  const prefix = dryRun ? '[DRY RUN] ' : '';
  let totalRemoved = 0;
  let dirsAffected = 0;

  for (const modelDir of modelDirs) {
    const result = cleanModelDir(modelDir, dryRun);
    if (Object.keys(result.files).length > 0) {
      dirsAffected += 1;
      console.log(`\n${prefix}${result.dir}  (valid_run_ids: ${result.valid_run_ids})`);
      for (const [fname, counts] of Object.entries(result.files)) {
        totalRemoved += counts.removed;
        console.log(`  ${fname}: kept ${counts.kept}, removed ${counts.removed}`);
      }
    }
  }

  console.log(
    `\n${prefix}Summary: scanned ${modelDirs.length} model dirs, ` +
      `${dirsAffected} had orphaned data, ${totalRemoved} total records removed.`,
  );
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
