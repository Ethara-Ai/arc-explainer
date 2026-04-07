import { Arc3GameAdapter } from "./arc3GameAdapter";
import type { GameBridgeConfig } from "./types";

interface PoolConfig {
  maxPerGame: number;
  envDir?: string;
  bridgeConfig?: Partial<GameBridgeConfig>;
}

export class GameBridgePool {
  private readonly pools = new Map<string, Arc3GameAdapter[]>();
  private readonly inUse = new Set<Arc3GameAdapter>();
  private readonly config: PoolConfig;

  constructor(config?: Partial<PoolConfig>) {
    this.config = { maxPerGame: 4, ...config };
  }

  async acquire(gameId: string): Promise<Arc3GameAdapter> {
    const idle = this.pools.get(gameId);

    while (idle && idle.length > 0) {
      const adapter = idle.pop()!;
      try {
        await adapter.reset();
        this.inUse.add(adapter);
        return adapter;
      } catch {
        await adapter.dispose().catch(() => {});
      }
    }

    const adapter = await Arc3GameAdapter.create(
      gameId,
      undefined,
      this.config.bridgeConfig,
      this.config.envDir,
    );
    this.inUse.add(adapter);
    return adapter;
  }

  async release(adapter: Arc3GameAdapter): Promise<void> {
    this.inUse.delete(adapter);

    const gameId = adapter.gameId;
    let idle = this.pools.get(gameId);
    if (!idle) {
      idle = [];
      this.pools.set(gameId, idle);
    }

    if (idle.length < this.config.maxPerGame) {
      idle.push(adapter);
    } else {
      await adapter.dispose().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    for (const idle of this.pools.values()) {
      for (const adapter of idle) {
        await adapter.dispose().catch(() => {});
      }
    }
    this.pools.clear();

    for (const adapter of this.inUse) {
      await adapter.dispose().catch(() => {});
    }
    this.inUse.clear();
  }

  get stats(): { total: number; idle: number; inUse: number } {
    let idle = 0;
    for (const pool of this.pools.values()) {
      idle += pool.length;
    }
    return { total: idle + this.inUse.size, idle, inUse: this.inUse.size };
  }
}
