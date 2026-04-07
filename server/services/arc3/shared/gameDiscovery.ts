

import {
  discoverGames,
  type DiscoveredGame,
  ENVIRONMENT_FILES_DIR,
} from '../../eval/adapters/types';

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  readonly data: T;
  readonly expiresAt: number;
}

const TTL_MS = 60_000; // 60 seconds

let cachedGames: CacheEntry<DiscoveredGame[]> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get all available ARC-AGI-3 games with 60s TTL caching.
 * First call scans the filesystem; subsequent calls return cached results
 * until the TTL expires.
 *
 * @param envDir - Optional override for the environment files directory
 * @returns Array of discovered games sorted by gameId
 */
export function getAvailableGames(envDir?: string): DiscoveredGame[] {
  const now = Date.now();

  // Cache only applies when using default directory (overrides always re-scan)
  if (!envDir && cachedGames && cachedGames.expiresAt > now) {
    return cachedGames.data;
  }

  const games = discoverGames(envDir);

  // Only cache default-directory results
  if (!envDir) {
    cachedGames = { data: games, expiresAt: now + TTL_MS };
  }

  return games;
}

/**
 * Get a single game by ID. Returns null if not found.
 */
export function getGameById(
  gameId: string,
  envDir?: string,
): DiscoveredGame | null {
  const games = getAvailableGames(envDir);
  return games.find((g) => g.gameId === gameId) ?? null;
}

/**
 * Get list of all game IDs (sorted).
 */
export function getGameIds(envDir?: string): string[] {
  return getAvailableGames(envDir).map((g) => g.gameId);
}

/**
 * Invalidate the cached game list. Forces re-scan on next call.
 */
export function invalidateGameCache(): void {
  cachedGames = null;
}

/**
 * Get the default environment files directory path.
 */
export function getEnvironmentFilesDir(): string {
  return ENVIRONMENT_FILES_DIR;
}
