/**
 * CompositeAbortController — fires if ANY constituent AbortSignal fires.
 * TypeScript equivalent of Python's CompositeShutdownEvent (OR semantics).
 *
 * Ported from: shutdown.py CompositeShutdownEvent
 *
 * Usage hierarchy (same as Python):
 *   global_signal  (top-level SIGINT / budget exceeded / CANCEL_ALL)
 *   game_signal    (per-game budget / CANCEL_{gameId})
 *   model_signal   (per-model circuit breaker / CANCEL_{gameId}_{modelKey})
 *
 * CompositeAbortController(global, game, model)
 *   - signal.aborted = true if ANY of the three is aborted
 *   - abort() aborts the LAST (most-specific) controller
 */
export class CompositeAbortController {
  private readonly _controller: AbortController;
  private readonly _cleanups: Array<() => void> = [];

  /**
   * @param parentSignals  AbortSignals from parent scopes (global → game → model).
   *                       If any parent fires, this composite fires too.
   */
  constructor(...parentSignals: AbortSignal[]) {
    this._controller = new AbortController();

    for (const parent of parentSignals) {
      if (parent.aborted) {
        // Already aborted — fire immediately
        this._controller.abort(parent.reason);
        return;
      }

      const handler = () => {
        if (!this._controller.signal.aborted) {
          this._controller.abort(parent.reason);
        }
      };
      parent.addEventListener("abort", handler, { once: true });
      this._cleanups.push(() =>
        parent.removeEventListener("abort", handler),
      );
    }
  }

  /** Composite signal — aborted if ANY parent or this controller is aborted. */
  get signal(): AbortSignal {
    return this._controller.signal;
  }

  /** Abort this (most-specific) scope. Matches Python CompositeShutdownEvent.set(). */
  abort(reason?: unknown): void {
    this._controller.abort(reason);
  }

  /** Remove event listeners to prevent memory leaks after the task completes. */
  dispose(): void {
    for (const cleanup of this._cleanups) {
      cleanup();
    }
    this._cleanups.length = 0;
  }
}
