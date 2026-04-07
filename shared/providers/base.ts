

// ---------------------------------------------------------------------------
// ProviderResponse
// ---------------------------------------------------------------------------

export interface ProviderResponse {
  action: string; // Chosen action (e.g., "UP", "SELECT", "CLICK 10 15")
  reasoning: string; // Model's explanation
  notepadUpdate: string | null; // New notepad contents, or null to keep current
  inputTokens: number; // Non-cached input tokens only (billed at full rate)
  outputTokens: number;
  reasoningTokens: number; // For models with explicit reasoning (o-series, etc.)
  thinkingText: string | null; // Extended thinking text (Claude thinking blocks, etc.)
  costUsd: number; // Calculated from tokens + pricing
  rawResponse: Record<string, any> | null; // Full API response for debugging
  // --- Prompt caching fields (optional, default 0) ---
  cachedInputTokens: number; // Tokens served from cache (billed at discounted rate)
  cacheWriteTokens: number; // Tokens written to cache (one-time write cost)
  // --- Traffic routing (Gemini-specific, null for other providers) ---
  trafficType: string | null; // ON_DEMAND_PRIORITY, ON_DEMAND, or null
}

/** Create a ProviderResponse with sensible defaults for optional fields. */
export function createProviderResponse(
  partial: Omit<
    ProviderResponse,
    "cachedInputTokens" | "cacheWriteTokens" | "trafficType" | "thinkingText"
  > &
    Partial<
      Pick<
        ProviderResponse,
        | "cachedInputTokens"
        | "cacheWriteTokens"
        | "trafficType"
        | "thinkingText"
      >
    >,
): ProviderResponse {
  return {
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    trafficType: null,
    thinkingText: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// buildActionDescription
// ---------------------------------------------------------------------------

/**
 * Build a dynamic tool description showing only the current game's actions.
 * Keeps the tool schema honest and prevents models from hallucinating actions.
 */
export function buildActionDescription(validActions: string[]): string {
  if (validActions.length > 0) {
    const examples = validActions.join(", ");
    return `Action to take. Valid actions this turn: ${examples}`;
  }
  return "Action to take";
}

// ---------------------------------------------------------------------------
// BaseProvider (abstract)
// ---------------------------------------------------------------------------

export interface ChooseActionParams {
  systemPrompt: string;
  conversationHistory: Array<{ role: string; content: any }>;
  currentObservation: string;
  validActions: string[];
  notepad: string;
  imageB64: string | null;
}

export abstract class BaseProvider {
  /**
   * Synchronous entry point -- exists only for interface compatibility.
   * All real providers are async; this throws by default.
   * Callers MUST use chooseActionAsync() instead.
   */
  chooseAction(params: ChooseActionParams): ProviderResponse {
    throw new Error(
      `${this.constructor.name}.chooseAction() is sync and not implemented. ` +
        `Use chooseActionAsync() for actual API calls.`,
    );
  }

  /**
   * Async entry point -- THE method all callers should use.
   * Every concrete provider MUST override this.
   */
  abstract chooseActionAsync(
    params: ChooseActionParams,
    signal?: AbortSignal,
  ): Promise<ProviderResponse>;

  /** Human-readable display name (e.g., 'Gemini 3.1'). */
  abstract get modelName(): string;

  /** API model identifier (e.g., 'gemini-3.1-pro'). */
  abstract get modelId(): string;

  /**
   * Parse JSON response from model. Returns [action, reasoning, notepadUpdate].
   * Expected: {"action": "...", "reasoning": "...", "notepad_update": "..." | null}
   * Falls back to regex/keyword extraction if JSON parsing fails.
   */
  protected parseActionResponse(
    text: string,
    validActions: string[],
  ): [string, string, string | null] {
    // Check for empty response FIRST
    if (!text || text.trim().length === 0) {
      return ["SKIP", "(empty response from LLM)", null];
    }

    // Try JSON extraction first
    const data = BaseProvider.extractJsonWithAction(text);
    if (data !== null) {
      const action = String(data.action ?? "").trim();
      const reasoning = String(data.reasoning ?? "").trim();
      let notepadUpdate: string | null = data.notepad_update ?? null;
      if (notepadUpdate !== null) {
        notepadUpdate = String(notepadUpdate).trim();
      }
      if (action) {
        const matched = BaseProvider.matchAction(action, validActions);
        return [matched, reasoning, notepadUpdate];
      }
    }

    // Fallback: scan text for action keywords
    const reasoning = text.slice(0, 500);
    for (const va of validActions) {
      if (text.toUpperCase().includes(va.toUpperCase())) {
        return [va, reasoning, null];
      }
    }

    // Last resort: SKIP — never inject an action the model didn't choose.
    // Silently picking validActions[0] would corrupt benchmark scores.
    return ["SKIP", `(parse failed) ${text.slice(0, 200)}`, null];
  }

  /**
   * Match a parsed action string against valid actions.
   * Tries exact, case-insensitive, then prefix match.
   */
  static matchAction(action: string, validActions: string[]): string {
    // Exact match
    if (validActions.includes(action)) return action;

    // Case-insensitive exact match
    const upper = action.toUpperCase();
    for (const va of validActions) {
      if (upper === va.toUpperCase()) return va;
    }

    // Prefix match (e.g., "CLICK 10 15" matches valid action "CLICK")
    const actionBase = upper.split(/\s+/)[0] ?? "";
    for (const va of validActions) {
      const vaBase = va.toUpperCase().split(/\s+/)[0] ?? "";
      // if (actionBase === vaBase) return va; // Return canonical action from validActions
      if (actionBase === vaBase) return action.toUpperCase();
    }

    // No match -- return as-is
    return action;
  }

  /**
   * Extract a JSON object containing an 'action' key from text.
   * Uses brace-depth counter to handle nested braces in string values.
   */
  static extractJsonWithAction(text: string): Record<string, any> | null {
    let start = 0;
    while (true) {
      const idx = text.indexOf("{", start);
      if (idx === -1) return null;

      let depth = 0;
      for (let end = idx; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}") depth--;

        if (depth === 0) {
          const candidate = text.slice(idx, end + 1);
          try {
            const data = JSON.parse(candidate);
            if (typeof data === "object" && data !== null && "action" in data) {
              return data;
            }
          } catch {
            // Not valid JSON, try next '{'
          }
          break;
        }
      }
      start = idx + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// sanitizeRawResponse (FIX #84-#89: API key security)
// ---------------------------------------------------------------------------

/** Keys whose values should be fully redacted in raw responses. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "secret",
  "token",
  "bearer",
  "x-goog-api-key",
  "anthropic-api-key",
]);

/** Patterns that look like API keys / bearer tokens in string values. */
const KEY_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-_\.]{8,}/gi,
  /sk-[A-Za-z0-9]{20,}/gi,
  /key-[A-Za-z0-9]{20,}/gi,
  /AIza[A-Za-z0-9\-_]{30,}/gi,
];

/**
 * Deep-clone a raw API response object, redacting any fields that could
 * contain API keys, auth headers, or tokens. Safe for logging and trace files.
 *
 * - Keys matching SENSITIVE_KEYS are replaced with "[REDACTED]"
 * - String values matching KEY_PATTERNS are scrubbed inline
 * - Recurses into nested objects and arrays
 * - Returns null if input is null/undefined
 */
export function sanitizeRawResponse(
  obj: Record<string, any> | null | undefined,
): Record<string, any> | null {
  if (obj == null) return null;

  function sanitize(val: unknown, key?: string): unknown {
    // Redact entire value if the key is sensitive
    if (key && SENSITIVE_KEYS.has(key.toLowerCase())) {
      return "[REDACTED]";
    }

    if (val === null || val === undefined) return val;

    if (typeof val === "string") {
      let scrubbed = val;
      for (const pat of KEY_PATTERNS) {
        // Reset lastIndex since patterns use /g
        pat.lastIndex = 0;
        scrubbed = scrubbed.replace(pat, "[REDACTED]");
      }
      return scrubbed;
    }

    if (Array.isArray(val)) {
      return val.map((item) => sanitize(item));
    }

    if (typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = sanitize(v, k);
      }
      return out;
    }

    // numbers, booleans, etc. pass through
    return val;
  }

  return sanitize(obj) as Record<string, any>;
}
