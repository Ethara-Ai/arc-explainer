

/**
 * JSON replacer that converts non-finite numbers and undefined to null.
 * Dates are serialized as ISO strings.
 */
function safeReplacer(_key: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Serialize an object to JSON, replacing undefined, NaN, and Infinity with null.
 * Safe for JSONL trace files, SSE payloads, and any persisted data.
 *
 * @param obj - Object to serialize
 * @param pretty - If true, format with 2-space indentation (default: false)
 * @returns JSON string with no undefined/NaN/Infinity values
 */
export function safeStringify(obj: unknown, pretty: boolean = false): string {
  return JSON.stringify(obj, safeReplacer, pretty ? 2 : undefined);
}
