// ---------------------------------------------------------------------------
// BudgetSnapshot (immutable point-in-time view)
// ---------------------------------------------------------------------------

export interface BudgetSnapshot {
  readonly globalSpent: number;
  readonly globalLimit: number | null;
  readonly gameSpent: number;
  readonly gameLimit: number | null;
  readonly globalRemaining: number | null;
  readonly gameRemaining: number | null;
  readonly isOverGlobal: boolean;
  readonly isOverGame: boolean;
}

function createSnapshot(
  globalSpent: number,
  globalLimit: number | null,
  gameSpent: number,
  gameLimit: number | null,
): BudgetSnapshot {
  const globalRemaining =
    globalLimit === null ? null : Math.max(0, globalLimit - globalSpent);
  const gameRemaining =
    gameLimit === null ? null : Math.max(0, gameLimit - gameSpent);
  const isOverGlobal =
    globalLimit === null ? false : globalSpent >= globalLimit;
  const isOverGame = gameLimit === null ? false : gameSpent >= gameLimit;

  return Object.freeze({
    globalSpent,
    globalLimit,
    gameSpent,
    gameLimit,
    globalRemaining,
    gameRemaining,
    isOverGlobal,
    isOverGame,
  });
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

/**
 * Global + per-game USD budget tracker.
 *
 * Node.js is single-threaded so no mutex is needed (unlike the Python
 * version which uses threading.Lock). Async operations yield at await
 * points but never mid-statement, so numeric updates are atomic.
 *
 * Usage:
 * ```ts
 * const tracker = new BudgetTracker({ globalLimit: 50.0, perGameLimit: 10.0 });
 * const snap = tracker.recordCost("cc01", 0.25);
 * if (snap.isOverGame) { // trigger game shutdown }
 * ```
 */
export class BudgetTracker {
  private readonly _globalLimit: number | null;
  private readonly _perGameLimit: number | null;
  private _globalSpent: number;
  private _globalReserved: number;
  private readonly _perGame: Map<string, number>;
  private readonly _perGameReserved: Map<string, number>;

  constructor(
    opts: {
      globalLimit?: number | null;
      perGameLimit?: number | null;
    } = {},
  ) {
    this._globalLimit = opts.globalLimit ?? null;
    this._perGameLimit = opts.perGameLimit ?? null;
    this._globalSpent = 0;
    this._globalReserved = 0;
    this._perGame = new Map();
    this._perGameReserved = new Map();
  }

  /** Record cost and return an immutable snapshot. */
  recordCost(gameId: string, costUsd: number | null | undefined): BudgetSnapshot {
    if (costUsd == null) return this.checkBudget(gameId);

    this._globalSpent += costUsd;
    const prev = this._perGame.get(gameId) ?? 0;
    this._perGame.set(gameId, prev + costUsd);

    return createSnapshot(
      this._globalSpent + this._globalReserved,
      this._globalLimit,
      this._perGame.get(gameId)! + (this._perGameReserved.get(gameId) ?? 0),
      this._perGameLimit,
    );
  }

  /**
   * Read-only snapshot of current budget state.
   * Includes reserved amounts from in-flight tasks so concurrent workers
   * see an accurate picture of committed spend.
   */
  checkBudget(gameId: string): BudgetSnapshot {
    return createSnapshot(
      this._globalSpent + this._globalReserved,
      this._globalLimit,
      (this._perGame.get(gameId) ?? 0) +
        (this._perGameReserved.get(gameId) ?? 0),
      this._perGameLimit,
    );
  }

  /**
   * Reserve budget for an in-flight task. The reservation is included in
   * checkBudget snapshots so concurrent workers see committed spend.
   * Call releaseReservation() when the task completes (with actual cost recorded).
   *
   * @param gameId  Game the reservation is for
   * @param amount  Estimated cost to reserve (e.g. average step cost × maxSteps)
   */
  reserve(gameId: string, amount: number): void {
    this._globalReserved += amount;
    const prev = this._perGameReserved.get(gameId) ?? 0;
    this._perGameReserved.set(gameId, prev + amount);
  }

  /**
   * Release a previous reservation. Called when a task completes
   * and its actual cost has been recorded via recordCost().
   */
  releaseReservation(gameId: string, amount: number): void {
    this._globalReserved = Math.max(0, this._globalReserved - amount);
    const prev = this._perGameReserved.get(gameId) ?? 0;
    this._perGameReserved.set(gameId, Math.max(0, prev - amount));
  }

  /** Total USD spent across all games. */
  get globalSpent(): number {
    return this._globalSpent;
  }

  /** USD spent on a specific game. */
  gameSpent(gameId: string): number {
    return this._perGame.get(gameId) ?? 0;
  }

  /** Reset all spend counters (useful for tests). */
  reset(): void {
    this._globalSpent = 0;
    this._globalReserved = 0;
    this._perGame.clear();
    this._perGameReserved.clear();
  }
}
