// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RetryConfig {
  readonly maxAttempts: number; // Total attempts (default: 5)
  readonly backoffBase: number; // Exponential base (default: 1.5)
  readonly maxWaitMs: number; // Cap on any single wait (default: 60000)
  readonly nonTransientMaxRetries: number; // Fast-fail limit for auth errors (default: 3)
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  backoffBase: 1.5,
  maxWaitMs: 60_000,
  nonTransientMaxRetries: 3,
};

// ---------------------------------------------------------------------------
// Retry event callback (for SSE emission)
// ---------------------------------------------------------------------------

export interface RetryEvent {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly waitMs: number;
  readonly tier: "rate_limit" | "transient" | "general" | "non_transient";
  readonly reason: string;
}

export type OnRetryCallback = (event: RetryEvent) => void;

// ---------------------------------------------------------------------------
// Error classifiers (bridge-compatible: status_code, llm_provider, error_type)
// ---------------------------------------------------------------------------

interface BridgeErrorAttrs {
  status_code?: number;
  status?: number;
  statusCode?: number;
  llm_provider?: string;
  error_type?: string;
  code?: number;
}

function extractStatusCode(error: Error): number {
  const attrs = error as unknown as BridgeErrorAttrs;
  return (
    attrs.status_code ?? attrs.status ?? attrs.statusCode ?? attrs.code ?? 0
  );
}

function isGeminiProvider(error: Error): boolean {
  const attrs = error as unknown as BridgeErrorAttrs;
  if (attrs.llm_provider?.startsWith("vertex_ai")) return true;
  if (attrs.llm_provider === "gemini") return true;
  return false;
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (
    msg.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  )
    return true;

  if (extractStatusCode(error) === 429) return true;

  // Gemini RESOURCE_EXHAUSTED
  if (isGeminiProvider(error) && extractStatusCode(error) === 429) return true;
  if (
    extractStatusCode(error) === 429 &&
    error.message.includes("RESOURCE_EXHAUSTED")
  )
    return true;

  return false;
}

function isTransientError(error: unknown): boolean {
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

function isNonTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const status = extractStatusCode(error);

  if (status === 401 || status === 403 || status === 404 || status === 400)
    return true;

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
    msg.includes("context length") ||
    msg.includes("reduce the length") ||
    msg.includes("maximum input length")
  )
    return true;

  return false;
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

/**
 * Compute wait time aligned to next minute boundary + jitter.
 * TPM rate limits refill on minute boundaries.
 */
function computeMinuteBoundaryWait(): number {
  const nowSec = Date.now() / 1000;
  let secondsToNext = 60 - (nowSec % 60);
  if (secondsToNext < 5) secondsToNext += 60;
  const jitterSec = 5 + Math.random() * 40;
  return (secondsToNext + jitterSec) * 1000;
}

/**
 * Sleep that resolves early if the AbortSignal fires.
 */
export function interruptibleSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    const cleanup = () => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener("abort", cleanup, { once: true });

    // Guard against abort between promise creation and listener registration
    if (signal?.aborted) cleanup();
  });
}

// ---------------------------------------------------------------------------
// callWithRetry
// ---------------------------------------------------------------------------

/**
 * Execute an async function with 3-tier retry logic.
 *
 * Tier 1 — Rate limit (429): Wait until next minute boundary + jitter
 * Tier 2 — Transient (503/504): 30-60s cooldown with jitter
 * Tier 3 — General: Exponential backoff capped at maxWaitMs
 * Non-transient (401/403/404): Fail fast after 3 attempts
 *
 * @param fn - Async function to execute
 * @param config - Retry configuration (optional, uses defaults)
 * @param signal - AbortSignal for cancellation
 * @param onRetry - Callback emitted before each retry wait
 * @returns Result of fn()
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  signal?: AbortSignal,
  onRetry?: OnRetryCallback,
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;
  let nonTransientCount = 0;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("Run aborted");

    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt >= cfg.maxAttempts - 1) break;

      // Non-transient: fail fast after limited retries
      if (isNonTransientError(err)) {
        nonTransientCount++;
        if (nonTransientCount >= cfg.nonTransientMaxRetries) break;
        const waitMs = 2000 * nonTransientCount;
        onRetry?.({
          attempt: attempt + 1,
          maxAttempts: cfg.maxAttempts,
          waitMs,
          tier: "non_transient",
          reason: String(err),
        });
        await interruptibleSleep(waitMs, signal);
        if (signal?.aborted) throw new Error("Run aborted");
        continue;
      }

      let waitMs: number;
      let tier: RetryEvent["tier"];

      if (isRateLimitError(err)) {
        waitMs = computeMinuteBoundaryWait();
        tier = "rate_limit";
      } else if (isTransientError(err)) {
        waitMs = (30 + Math.random() * 30) * 1000;
        tier = "transient";
      } else {
        const rawWaitSec =
          Math.pow(cfg.backoffBase, attempt) * (0.5 + Math.random());
        waitMs = Math.min(rawWaitSec * 1000, cfg.maxWaitMs);
        tier = "general";
      }

      onRetry?.({
        attempt: attempt + 1,
        maxAttempts: cfg.maxAttempts,
        waitMs,
        tier,
        reason: String(err),
      });

      await interruptibleSleep(waitMs, signal);
      if (signal?.aborted) throw new Error("Run aborted");
    }
  }

  throw new Error(
    `All ${cfg.maxAttempts} retry attempts failed: ${String(lastError)}`,
  );
}
