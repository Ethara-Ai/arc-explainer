

// ---------------------------------------------------------------------------
// AsyncSemaphore
// ---------------------------------------------------------------------------

class AsyncSemaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /** Acquire a permit. Resolves when a slot is available. */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /** Release a permit, unblocking the next waiter. */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  /** Current number of available permits. */
  get available(): number {
    return this.permits;
  }

  /** Number of waiters in the queue. */
  get waiting(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Provider limits
// ---------------------------------------------------------------------------

const PROVIDER_LIMITS: Record<string, number> = {
  openai: 16,
  'claude-cloud': 8,
  'kimi-cloud': 8,
  vertex: 12,
  litellm: 10,
};

const DEFAULT_LIMIT = 8;

// ---------------------------------------------------------------------------
// ProviderSemaphore (singleton registry)
// ---------------------------------------------------------------------------

const semaphores = new Map<string, AsyncSemaphore>();

/**
 * Get (or create) the semaphore for a given provider.
 * Thread-safe: uses the same Map instance across all callers.
 */
function getSemaphore(provider: string): AsyncSemaphore {
  const key = provider.toLowerCase();
  let sem = semaphores.get(key);
  if (!sem) {
    const limit = PROVIDER_LIMITS[key] ?? DEFAULT_LIMIT;
    sem = new AsyncSemaphore(limit);
    semaphores.set(key, sem);
  }
  return sem;
}

/**
 * Acquire a provider concurrency slot.
 * Returns a release function that MUST be called when the request completes.
 *
 * Usage:
 * ```ts
 * const release = await acquireProviderSlot('openai');
 * try {
 *   await callLlm(...);
 * } finally {
 *   release();
 * }
 * ```
 */
export async function acquireProviderSlot(provider: string): Promise<() => void> {
  const sem = getSemaphore(provider);
  await sem.acquire();
  return () => sem.release();
}

/**
 * Execute an async function within a provider concurrency slot.
 * Automatically acquires and releases the semaphore.
 */
export async function withProviderSlot<T>(
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireProviderSlot(provider);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Get current stats for all active providers. */
export function getProviderStats(): Record<string, { available: number; waiting: number }> {
  const stats: Record<string, { available: number; waiting: number }> = {};
  for (const [key, sem] of semaphores) {
    stats[key] = { available: sem.available, waiting: sem.waiting };
  }
  return stats;
}
