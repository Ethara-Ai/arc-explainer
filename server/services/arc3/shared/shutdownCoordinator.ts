

// ---------------------------------------------------------------------------
// Singleton shutdown controller
// ---------------------------------------------------------------------------

let globalController: AbortController = new AbortController();
let shutdownRequested = false;
const shutdownCallbacks: Array<() => Promise<void>> = [];

/**
 * Get the global AbortSignal. All StepLoopEngine instances should
 * check this signal between steps.
 */
export function getShutdownSignal(): AbortSignal {
  return globalController.signal;
}

/**
 * Check if shutdown has been requested.
 */
export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

/**
 * Register a callback to run during graceful shutdown.
 * Callbacks run in registration order. Each gets 5 seconds max.
 */
export function onShutdown(callback: () => Promise<void>): void {
  shutdownCallbacks.push(callback);
}

/**
 * Request graceful shutdown. Fires the abort signal and runs all
 * registered callbacks.
 */
export async function requestShutdown(reason: string = 'shutdown requested'): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;

  console.log(`[ShutdownCoordinator] Shutdown requested: ${reason}`);

  // Fire the global abort signal
  globalController.abort(reason);

  // Run callbacks with individual timeouts
  for (const cb of shutdownCallbacks) {
    try {
      await Promise.race([
        cb(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      console.error(
        `[ShutdownCoordinator] Callback error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log('[ShutdownCoordinator] All callbacks completed.');
}

/**
 * Reset the shutdown state (for tests or after restart).
 */
export function resetShutdown(): void {
  globalController = new AbortController();
  shutdownRequested = false;
  shutdownCallbacks.length = 0;
}

// ---------------------------------------------------------------------------
// Process signal handlers (register once on module load)
// ---------------------------------------------------------------------------

let handlersRegistered = false;

/**
 * Install SIGINT/SIGTERM handlers. Safe to call multiple times —
 * only registers once.
 */
export function installShutdownHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  const handler = (signal: string) => {
    console.log(`\n[ShutdownCoordinator] Received ${signal}`);
    requestShutdown(signal).then(() => {
      // Give a moment for cleanup, then exit
      setTimeout(() => process.exit(0), 1000);
    });
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
