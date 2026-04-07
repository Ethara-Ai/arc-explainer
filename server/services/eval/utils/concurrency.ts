/**
 * Concurrency primitives for the eval harness.
 * Extracted from EvalOrchestrator — reusable across the eval pipeline.
 */

/**
 * Async semaphore for limiting concurrent access to a shared resource.
 * Used for per-provider API rate limiting (matches Python's threading.Semaphore).
 */
export class AsyncSemaphore {
  private _count: number;
  private readonly _waiters: Array<() => void> = [];

  constructor(permits: number) {
    this._count = permits;
  }

  async acquire(): Promise<void> {
    if (this._count > 0) {
      this._count--;
      return;
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._count++;
    }
  }
}

/**
 * Run an array of async task factories with bounded concurrency.
 * Returns results in the same order as the input tasks array.
 *
 * Workers are resilient: if a task throws, the error is captured in the
 * results array and the worker continues processing remaining tasks.
 * This prevents one failing task from killing the entire worker pool.
 */
export async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];

  const results = new Array<T>(tasks.length);
  const errors = new Map<number, unknown>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      if (idx >= tasks.length) break;
      try {
        results[idx] = await tasks[idx]!();
      } catch (err: unknown) {
        errors.set(idx, err);
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // If any tasks failed, throw an AggregateError with all failures.
  // Callers that need partial results should use withConcurrencyLimitSettled instead.
  if (errors.size > 0) {
    const errList = Array.from(errors.entries())
      .sort(([a], [b]) => a - b)
      .map(([idx, err]) => err instanceof Error ? err : new Error(`Task ${idx}: ${String(err)}`));
    throw new AggregateError(
      errList,
      `${errors.size}/${tasks.length} tasks failed`,
    );
  }

  return results;
}

/**
 * Like withConcurrencyLimit but never throws — returns settled results
 * for each task (fulfilled with value or rejected with reason).
 * Used by the orchestrator where partial success is acceptable.
 */
export async function withConcurrencyLimitSettled<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
  if (tasks.length === 0) return [];

  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      if (idx >= tasks.length) break;
      try {
        const value = await tasks[idx]!();
        results[idx] = { status: "fulfilled", value };
      } catch (reason: unknown) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/**
 * Per-file write serializer to prevent interleaved concurrent appends.
 * Each file path gets its own promise chain — writes are queued in order.
 */
const fileWriteQueues = new Map<string, Promise<void>>();

export function serializedFileWrite(
  filePath: string,
  writeFn: () => Promise<void>,
): Promise<void> {
  const prev = fileWriteQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(writeFn, writeFn);
  fileWriteQueues.set(filePath, next);
  // Cleanup reference when queue drains to avoid unbounded Map growth
  next.then(() => {
    if (fileWriteQueues.get(filePath) === next) {
      fileWriteQueues.delete(filePath);
    }
  });
  return next;
}
