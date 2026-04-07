

import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Re-export core adapter types from shared
export type {
  GameAdapter,
  GameState,
  GameType,
  GameMetadata,
} from "@shared/eval-types";

// ── Environment files discovery ────────────────────────────────────────────────

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const PROJECT_ROOT = resolve(__dirname_local, "..", "..", "..", "..");
export const ENVIRONMENT_FILES_DIR = join(
  PROJECT_ROOT,
  "puzzle-environments",
  "ARC-AGI-3",
  "environment_files",
);

/**
 * Metadata loaded from a game's metadata.json.
 */
export interface GameFileMetadata {
  game_id: string;
  default_fps?: number;
  baseline_actions?: number[];
  tags?: string[];
  local_dir?: string;
  class_name?: string;
  title?: string;
}

/**
 * A discovered game with its resolved filesystem path.
 */
export interface DiscoveredGame {
  gameId: string;
  gameDir: string; // absolute path to the version folder (e.g. puzzle-environments/fm01/v1/)
  pyFile: string; // absolute path to the .py game file
  metadata: GameFileMetadata;
}

/**
 * Scan puzzle-environments/ directory to discover all available games.
 *
 * Default path: puzzle-environments/ARC-AGI-3/puzzle-environments/ (git submodule)
 *
 * Directory structure expected (flat — no version subdirs):
 *   {game_id}/
 *     {game_id}.py
 *     metadata.json
 *
 * Also supports versioned layout ({game_id}/v1/{game_id}.py) if present.
 *
 * @param envDir - Override the puzzle-environments root (for --game-dir flag)
 * @returns Array of discovered games sorted by gameId
 */
export function discoverGames(envDir?: string): DiscoveredGame[] {
  const root = envDir ?? ENVIRONMENT_FILES_DIR;

  if (!existsSync(root)) {
    return [];
  }

  const games: DiscoveredGame[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries.sort()) {
    const gameDir = join(root, entry);

    try {
      if (!statSync(gameDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (entry.startsWith(".") || entry.startsWith("_")) continue;

    // Version subdirectories (v1, v2, etc.) — pick latest
    let resolvedDir: string | null = null;
    try {
      const versionDirs = readdirSync(gameDir)
        .filter((d) => d.startsWith("v") && !d.startsWith("_"))
        .filter((d) => {
          try {
            return statSync(join(gameDir, d)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();

      if (versionDirs.length > 0) {
        const latest = versionDirs[versionDirs.length - 1];
        const candidate = join(gameDir, latest);
        if (existsSync(join(candidate, "metadata.json"))) {
          resolvedDir = candidate;
        }
      }
    } catch {
      // Fall through to direct layout check
    }

    // Fallback: metadata.json directly in game folder (no version subdirs)
    if (!resolvedDir && existsSync(join(gameDir, "metadata.json"))) {
      resolvedDir = gameDir;
    }

    if (!resolvedDir) continue;

    // Load metadata
    let metadata: GameFileMetadata;
    try {
      const raw = readFileSync(join(resolvedDir, "metadata.json"), "utf-8");
      metadata = JSON.parse(raw) as GameFileMetadata;
    } catch {
      continue;
    }

    // Find the Python game file
    const gameId = metadata.game_id || entry;
    let pyFile: string | null = null;

    // Try {game_id}.py first, then class_name.py, then first .py file
    for (const candidate of [
      join(resolvedDir, `${gameId}.py`),
      metadata.class_name
        ? join(resolvedDir, `${metadata.class_name.toLowerCase()}.py`)
        : null,
    ]) {
      if (candidate && existsSync(candidate)) {
        pyFile = candidate;
        break;
      }
    }

    // Fallback: first .py file in the directory
    if (!pyFile) {
      try {
        const pyFiles = readdirSync(resolvedDir)
          .filter((f) => f.endsWith(".py"))
          .sort();
        if (pyFiles.length > 0) {
          pyFile = join(resolvedDir, pyFiles[0]);
        }
      } catch {
        // no .py files
      }
    }

    if (!pyFile) continue;

    games.push({
      gameId,
      gameDir: resolvedDir,
      pyFile,
      metadata,
    });
  }

  return games;
}

/**
 * Messages sent FROM TypeScript TO the Python subprocess via stdin.
 * Each command is a single JSON line.
 */
export type BridgeCommand =
  | { type: "info" }
  | { type: "reset"; seed?: number }
  | { type: "action"; action: string; x: number | null; y: number | null }
  | { type: "quit" };

/**
 * Game info response from Python subprocess.
 * Sent once on startup after 'info' command.
 */
export interface BridgeInfoResponse {
  type: "info";
  game_id: string;
  title: string;
  description: string;
  available_actions: string[];
  total_levels?: number;
}

/**
 * Frame response from Python subprocess.
 * Sent after each action or reset command.
 */
export interface BridgeFrameResponse {
  type: "frame";
  frame: number[][];
  score: number;
  state: string;
  action_counter: number;
  max_actions: number;
  win_score: number;
  available_actions: string[];
  levels_completed?: number;
  current_level?: number;
  level_index?: number;
  total_levels?: number;
  text_observation?: string;
}

/**
 * Error response from Python subprocess.
 * Sent when a command fails.
 */
export interface BridgeErrorResponse {
  type: "error";
  message: string;
}

/**
 * Union of all possible responses from the Python subprocess.
 */
export type BridgeResponse =
  | BridgeInfoResponse
  | BridgeFrameResponse
  | BridgeErrorResponse;

// NOTE: Actions are fetched dynamically from each game's PuzzleEnvironment
// via get_actions(). The Python bridge sends lowercase action names directly
// to pe.step() — no integer conversion needed.

/**
 * Configuration for the GameBridge subprocess.
 */
export interface GameBridgeConfig {
  /** Path to Python executable (auto-detected by default) */
  pythonBin: string;
  /** Timeout in ms for individual commands (default: 10000) */
  commandTimeoutMs: number;
  /** Additional environment variables to pass to subprocess */
  env?: Record<string, string>;
  /** Override the allowed root directory for pyFilePath validation (defaults to ENVIRONMENT_FILES_DIR) */
  allowedRoot?: string;
}

/**
 * Default GameBridge configuration.
 * Uses 'python' on Windows, 'python3' on Unix-like systems.
 */
export const DEFAULT_BRIDGE_CONFIG: GameBridgeConfig = {
  pythonBin: process.platform === "win32" ? "python" : "python3",
  commandTimeoutMs: 10_000,
};

/**
 * Validate gameId against whitelist to prevent command injection.
 * Only alphanumeric characters and underscores allowed.
 *
 * @param gameId - The game identifier to validate
 * @throws {Error} If gameId is invalid, empty, or exceeds length limit
 */
export function validateGameId(gameId: string): void {
  const VALID_PATTERN = /^[a-z0-9_]+$/;

  if (!gameId || typeof gameId !== "string") {
    throw new Error("gameId must be a non-empty string");
  }

  if (!VALID_PATTERN.test(gameId)) {
    throw new Error(
      `Invalid gameId "${gameId}". Only lowercase letters, numbers, and underscores allowed.`,
    );
  }

  if (gameId.length > 50) {
    throw new Error(`gameId too long (max 50 chars): ${gameId}`);
  }
}
