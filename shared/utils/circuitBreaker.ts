

export interface CircuitState {
  readonly provider: string;
  readonly consecutiveFailures: number;
  readonly isOpen: boolean;
  readonly lastFailureTime: number | null;
  readonly tripThreshold: number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly halfOpenSeconds: number;
  private readonly failures = new Map<string, number>();
  private readonly lastFailureTime = new Map<string, number>();
  private readonly openState = new Map<string, boolean>();
  private readonly probing = new Map<string, boolean>();

  constructor(opts: { threshold?: number; halfOpenSeconds?: number } = {}) {
    this.threshold = opts.threshold ?? 10;
    this.halfOpenSeconds = opts.halfOpenSeconds ?? 300.0;
  }

  recordSuccess(provider: string): void {
    this.failures.set(provider, 0);
    this.openState.set(provider, false);
    this.probing.set(provider, false);
  }

  recordFailure(provider: string): CircuitState {
    const count = (this.failures.get(provider) ?? 0) + 1;
    this.failures.set(provider, count);
    this.lastFailureTime.set(provider, performance.now() / 1000);
    this.probing.set(provider, false);
    if (count >= this.threshold) {
      this.openState.set(provider, true);
    }
    return {
      provider,
      consecutiveFailures: count,
      isOpen: this.openState.get(provider) ?? false,
      lastFailureTime: this.lastFailureTime.get(provider) ?? null,
      tripThreshold: this.threshold,
    };
  }

  canCall(provider: string): boolean {
    if (!this.openState.get(provider)) return true;

    const lastFail = this.lastFailureTime.get(provider);
    if (lastFail == null) return true;

    const elapsed = performance.now() / 1000 - lastFail;
    if (elapsed >= this.halfOpenSeconds) {
      if (!this.probing.get(provider)) {
        this.probing.set(provider, true);
        return true;
      }
    }
    return false;
  }

  getState(provider: string): CircuitState {
    return {
      provider,
      consecutiveFailures: this.failures.get(provider) ?? 0,
      isOpen: this.openState.get(provider) ?? false,
      lastFailureTime: this.lastFailureTime.get(provider) ?? null,
      tripThreshold: this.threshold,
    };
  }
}
