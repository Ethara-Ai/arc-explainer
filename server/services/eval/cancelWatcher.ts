import { promises as fs } from "fs";
import path from "path";
import { logger } from "../../utils/logger";

/**
 * Sentinel-based cancellation for the evaluation harness.
 * Ported from: cancel_watcher.py
 *
 * Daemon interval polls for sentinel files in `{outputDir}/cancel/`:
 *   CANCEL_ALL                   → sets global shutdown
 *   DRAIN                        → sets drain (finish in-progress, skip new)
 *   CANCEL_{gameId}              → sets per-game shutdown
 *   CANCEL_{gameId}_{modelKey}   → sets per-model shutdown
 *
 * Priority order: CANCEL_ALL > DRAIN > per-game > per-model
 */

/** Callback fired when a sentinel is detected. */
export type ShutdownCallback = () => void;

export interface CancelWatcherConfig {
  /** Directory to watch for sentinel files (created if absent). */
  sentinelDir: string;
  /** Fires on CANCEL_ALL (kills everything immediately). */
  onGlobalShutdown: ShutdownCallback;
  /** Per-game shutdown callbacks keyed by gameId. */
  gameShutdowns: ReadonlyMap<string, ShutdownCallback>;
  /** Per-(gameId, modelKey) shutdown callbacks. Key = `${gameId}_${modelKey}`. */
  modelShutdowns?: ReadonlyMap<string, ShutdownCallback>;
  /** Fires on DRAIN (finish in-progress, skip new games). */
  onDrain?: ShutdownCallback;
  /** Polling interval in milliseconds (default: 2000). */
  pollIntervalMs?: number;
}

/**
 * Mutable state tracked across poll cycles.
 * Once a callback fires we mark it "fired" to avoid re-firing.
 */
interface WatcherState {
  globalFired: boolean;
  drainFired: boolean;
  firedGames: Set<string>;
  firedModels: Set<string>;
}

/**
 * Start a cancel watcher that polls for sentinel files at a fixed interval.
 *
 * Returns a cleanup function that stops the watcher.
 * The watcher uses setInterval (not a thread) — idiomatic for Node.js.
 *
 * Async because the sentinel directory must exist before polling starts —
 * if mkdir fails, cancellation infrastructure is broken and we propagate the error.
 */
export async function startCancelWatcher(
  config: CancelWatcherConfig,
): Promise<() => void> {
  const {
    sentinelDir,
    onGlobalShutdown,
    gameShutdowns,
    modelShutdowns,
    onDrain,
    pollIntervalMs = 2000,
  } = config;

  const state: WatcherState = {
    globalFired: false,
    drainFired: false,
    firedGames: new Set(),
    firedModels: new Set(),
  };

  // Sentinel directory MUST exist — cancellation breaks without it.
  await fs.mkdir(sentinelDir, { recursive: true });

  const intervalId = setInterval(() => {
    pollSentinels(sentinelDir, config, state).catch((err) => {
      logger.warn(
        `[CancelWatcher] Poll error: ${err instanceof Error ? err.message : String(err)}`,
        'eval-cancel',
      );
    });
  }, pollIntervalMs);

  // Don't keep the Node process alive just for the watcher
  if (typeof intervalId === "object" && "unref" in intervalId) {
    intervalId.unref();
  }

  return () => clearInterval(intervalId);
}

/**
 * Single poll cycle — check for sentinel files in priority order.
 * Matches Python cancel_watcher.py `_watch()` inner function.
 */
async function pollSentinels(
  sentinelDir: string,
  config: CancelWatcherConfig,
  state: WatcherState,
): Promise<void> {
  if (state.globalFired) return;

  // 1. CANCEL_ALL (highest priority)
  if (await fileExists(path.join(sentinelDir, "CANCEL_ALL"))) {
    state.globalFired = true;
    config.onGlobalShutdown();
    return; // No further checks needed
  }

  // 2. DRAIN
  if (
    config.onDrain &&
    !state.drainFired &&
    (await fileExists(path.join(sentinelDir, "DRAIN")))
  ) {
    state.drainFired = true;
    config.onDrain();
  }

  // 3. Per-game (snapshot keys to avoid mutation race)
  for (const [gameId, callback] of config.gameShutdowns) {
    if (state.firedGames.has(gameId)) continue;
    if (await fileExists(path.join(sentinelDir, `CANCEL_${gameId}`))) {
      state.firedGames.add(gameId);
      callback();
    }
  }

  // 4. Per-model (snapshot keys)
  if (config.modelShutdowns) {
    for (const [compositeKey, callback] of config.modelShutdowns) {
      if (state.firedModels.has(compositeKey)) continue;
      if (await fileExists(path.join(sentinelDir, `CANCEL_${compositeKey}`))) {
        state.firedModels.add(compositeKey);
        callback();
      }
    }
  }
}

/** Check if a file exists (non-throwing). */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove stale sentinel files from a previous session.
 * Called before starting the watcher when resuming.
 * Matches Python evaluate.py resume sentinel cleanup.
 */
export async function cleanStaleSentinels(
  sentinelDir: string,
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const entries = await fs.readdir(sentinelDir);
    for (const entry of entries) {
      const filePath = path.join(sentinelDir, entry);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        await fs.unlink(filePath);
        removed.push(entry);
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing to clean
  }
  return removed;
}
