

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// ---------------------------------------------------------------------------
// Strict JSON replacer (mirrors Python json_default)
// ---------------------------------------------------------------------------

/**
 * JSON replacer that handles Date objects explicitly.
 * Throws on unknown non-serializable types instead of silently
 * converting via toString(), which masks serialization bugs.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  // Let JSON.stringify handle primitives, arrays, and plain objects natively.
  // Anything else (Map, Set, class instances with no toJSON) will throw
  // via JSON.stringify's own TypeError -- no silent str() fallback.
  return value;
}

// ---------------------------------------------------------------------------
// JsonlWriter
// ---------------------------------------------------------------------------

/**
 * Read and write JSONL (newline-delimited JSON) files.
 *
 * Usage:
 * ```ts
 * const writer = new JsonlWriter("/tmp/steps.jsonl");
 * writer.append({ step: 1, action: "UP", score: 0.5 });
 * writer.append({ step: 2, action: "RIGHT", score: 0.75 });
 *
 * const records = JsonlWriter.read("/tmp/steps.jsonl");
 * // [{ step: 1, ... }, { step: 2, ... }]
 * ```
 */
export class JsonlWriter {
  readonly filepath: string;

  constructor(filepath: string) {
    this.filepath = filepath;
    // Ensure parent directory exists
    const dir = dirname(filepath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Append a single record as a JSON line. */
  append(record: Record<string, unknown>): void {
    const line = JSON.stringify(record, jsonReplacer) + "\n";
    appendFileSync(this.filepath, line, "utf-8");
  }

  /** Write all records to file (overwrites existing content). */
  writeAll(records: Record<string, unknown>[]): void {
    const dir = dirname(this.filepath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const content = records
      .map((r) => JSON.stringify(r, jsonReplacer))
      .join("\n") + (records.length > 0 ? "\n" : "");
    writeFileSync(this.filepath, content, "utf-8");
  }

  /** Read a JSONL file and return a list of parsed objects. */
  static read(filepath: string): Record<string, unknown>[] {
    if (!existsSync(filepath)) {
      return [];
    }
    const content = readFileSync(filepath, "utf-8");
    const records: Record<string, unknown>[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        records.push(JSON.parse(trimmed) as Record<string, unknown>);
      }
    }
    return records;
  }
}
