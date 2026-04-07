/**
 * Pure error classification functions for the eval retry pipeline.
 * Extracted from EvalRunner — zero `this` dependency.
 *
 * These classifiers determine which retry tier to apply:
 *   - Rate limit → wait until next minute boundary
 *   - Gemini transient → 30-60s cooldown
 *   - Non-transient → fail fast after 3 attempts
 *   - Everything else → exponential backoff
 *
 * Since commit 85227e03 all models route through `provider: "litellm-sdk"`,
 * so errors arrive as plain `Error` objects from PythonBridgeProcess with
 * `status_code`, `llm_provider`, and `error_type` properties rather than
 * typed SDK exception classes.
 */

/** Properties that the Python bridge attaches to Error objects. */
interface BridgeErrorAttrs {
  status_code?: number;
  status?: number;
  statusCode?: number;
  llm_provider?: string;
  error_type?: string;
  code?: number;
}

/** Extract a numeric HTTP status from any of the known property names. */
function extractStatusCode(error: Error): number {
  const attrs = error as unknown as BridgeErrorAttrs;
  return (
    attrs.status_code ?? attrs.status ?? attrs.statusCode ?? attrs.code ?? 0
  );
}

/** Check whether the error originated from a Gemini/Vertex AI provider. */
function isGeminiProvider(error: Error): boolean {
  const attrs = error as unknown as BridgeErrorAttrs;
  if (attrs.llm_provider?.startsWith("vertex_ai")) return true;
  if (attrs.llm_provider === "gemini") return true;
  return false;
}

/**
 * Universal rate-limit detector covering all providers.
 * Mirrors Python's `_is_rate_limit_error()`.
 *
 * Detects: HTTP 429, "rate_limit", "quota" in message, Gemini RESOURCE_EXHAUSTED.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  if (
    msg.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  ) {
    return true;
  }

  // HTTP status code check — covers bridge `status_code`, SDK `.status`, `.statusCode`, `.code`
  if (extractStatusCode(error) === 429) return true;

  // Gemini quota error (provider + status attributes)
  if (isGeminiQuotaError(error)) return true;

  return false;
}

/**
 * Detect Gemini-specific quota errors (HTTP 429, RESOURCE_EXHAUSTED).
 * Mirrors Python's `_is_gemini_quota_error()`.
 *
 * Uses `llm_provider` from the bridge to identify Gemini errors instead of
 * relying on SDK class names that don't survive the bridge serialization.
 */
export function isGeminiQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const statusCode = extractStatusCode(error);

  // Primary: bridge `llm_provider` guard + 429
  if (isGeminiProvider(error) && statusCode === 429) return true;

  // Secondary: RESOURCE_EXHAUSTED in message (works even without llm_provider)
  if (statusCode === 429 && error.message.includes("RESOURCE_EXHAUSTED")) {
    return true;
  }

  return false;
}

/**
 * Detect Gemini-specific transient server errors (504/503, DEADLINE_EXCEEDED, UNAVAILABLE).
 * Mirrors Python's `_is_gemini_transient_error()`.
 *
 * Uses `llm_provider` from the bridge to identify Gemini errors instead of
 * relying on SDK class names.
 */
export function isGeminiTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Provider guard: only fire for Gemini/Vertex AI errors
  if (!isGeminiProvider(error)) return false;

  const statusCode = extractStatusCode(error);
  if (statusCode === 504 || statusCode === 503) return true;

  const msg = error.message;
  if (msg.includes("DEADLINE_EXCEEDED") || msg.includes("UNAVAILABLE"))
    return true;

  return false;
}

/**
 * Detect non-transient errors that should NOT be retried many times.
 * Auth failures (401/403), not-found (404), bad request (400), and
 * missing credentials will never succeed on retry.
 * Returns true if the error is non-transient and should fail fast.
 */
export function isNonTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  const status = extractStatusCode(error);

  // HTTP 4xx errors that will never succeed on retry
  if (status === 401 || status === 403 || status === 404 || status === 400)
    return true;

  // Common auth/config failure messages from our providers
  if (
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("not found") ||
    msg.includes("invalid api key") ||
    msg.includes("api key not set") ||
    msg.includes("access denied") ||
    msg.includes("authentication") ||
    msg.includes("permission") ||
    msg.includes("no pricing data") ||
    msg.includes("unknown model") ||
    msg.includes("unknown provider") ||
    msg.includes("no module named") ||
    msg.includes("modulenotfounderror") ||
    msg.includes("bridge exited") ||
    msg.includes("bridge crashed") ||
    msg.includes("bridge did not send ready") ||
    msg.includes("bridge failed to start") ||
    msg.includes("context length") ||
    msg.includes("reduce the length") ||
    msg.includes("badrequesterror") ||
    msg.includes("maximum input length")
  )
    return true;

  return false;
}
