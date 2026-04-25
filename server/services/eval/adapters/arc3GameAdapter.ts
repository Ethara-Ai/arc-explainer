import type {
  GameAdapter,
  GameState,
  GameType,
  GameMetadata,
} from "@shared/eval-types";
import { GameBridge } from "./gameBridge";
import type { BridgeFrameResponse, GameBridgeConfig } from "./types";
import { AsyncSemaphore } from "../utils/concurrency";

// ─── Constants ────────────────────────────────────────────────────────────────

/** All known ARC3 game IDs available via arcengine package. */
export const ARC3_GAME_IDS = [
  "ct01",
  "ct03",
  "ft09",
  "gw01",
  "gw02",
  "ls20",
  "vc33",
  "ws03",
  "ws04",
] as const;

/**
 * Full fallback action set — returned before any bridge response is available,
 * or when available_actions is absent from the frame.
 * Lowercase to match PuzzleEnvironment action convention.
 */
const ALL_HUMAN_ACTIONS: string[] = [
  "up",
  "down",
  "left",
  "right",
  "select",
  "reset",
  "click",
  "undo",
];

// ─── Frame helpers ────────────────────────────────────────────────────────────

/**
 * Extracts a 2D grid from a potentially multi-dimensional frame array.
 *
 * The Python bridge may return 2D, 3D, or 4D arrays depending on the game engine:
 *   - 2D (h, w)           → use as-is
 *   - 3D (N, h, w)        → take last element (last animation frame)
 *   - 4D (N, M, h, w)     → take last element twice
 *
 * This mirrors the Python Arc3GameAdapter logic:
 *   if frame.ndim == 4: frame = frame[-1]
 *   if frame.ndim == 3: frame = frame[-1]
 */
function extractFrame(raw: unknown): number[][] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // 1D array of numbers → wrap (edge case, shouldn't happen from arcengine)
  if (typeof raw[0] === "number") {
    return [raw as number[]];
  }

  // 2D array: inner elements are numbers (or it's an empty inner row)
  if (
    Array.isArray(raw[0]) &&
    (raw[0].length === 0 || typeof raw[0][0] === "number")
  ) {
    return raw as number[][];
  }

  // 3D or 4D: inner element is itself an array of arrays — take the last (animation frame)
  const lastOuter = raw[raw.length - 1];
  return extractFrame(lastOuter);
}

/**
 * Renders a 2D numeric grid as a text table with header info.
 * Mirrors the Python Arc3GameAdapter.render_text() output format exactly.
 *
 * Example output:
 *   Grid (5x4) | Level 1/3 | Score: 0% | State: NOT_FINISHED
 *
 *    0  1  2  3  4
 *    5  6  7  8  9
 */
function renderFrameText(
  frame: number[][],
  level: number | null,
  totalLevels: number | null,
  score: number,
  state: string,
): string {
  const h = frame.length;
  const w = frame[0]?.length ?? 0;
  const scorePct = Math.round(score * 100);

  const header =
    `Grid (${w}x${h}) | Level ${level ?? "?"}/${totalLevels ?? "?"}` +
    ` | Score: ${scorePct}% | State: ${state}`;

  const lines: string[] = [header, ""];
  for (const row of frame) {
    lines.push(row.map((c) => String(c).padStart(2)).join(" "));
  }

  return lines.join("\n");
}

// ─── Arc3GameAdapter ──────────────────────────────────────────────────────────

/**
 * ARC3 game adapter — wraps GameBridge to implement the GameAdapter interface.
 *
 * Lifecycle:
 *   1. Construct:  `new Arc3GameAdapter(gameId)`
 *   2. `reset()`   — auto-starts the bridge subprocess on first call
 *   3. `step()`    — loop until `isDone()` returns true
 *   4. `dispose()` — tears down the Python subprocess (always call when done)
 *
 * Key design note — GAME_OVER is NOT terminal for ARC3:
 *   When the agent fails a level, the game transitions to GAME_OVER state with
 *   only RESET available. The agent can call RESET to retry the level. Only WIN
 *   (or completing all levels) truly ends the run. This matches the Python
 *   Arc3GameAdapter behaviour exactly (see game_adapter.py lines 137-141, 247-256).
 *
 * Score formula: levels_completed / total_levels → float 0.0–1.0
 */
export class Arc3GameAdapter implements GameAdapter {
  readonly gameType: GameType = "arc3";

  private readonly bridge: GameBridge;
  private readonly _gameId: string;
  /** Serializes concurrent bridge commands (reset/step) from parallel runners. */
  private readonly commandSemaphore = new AsyncSemaphore(1);

  private _title: string = "";
  private _totalLevelsFromInfo: number | null = null;
  private _lastFrame: BridgeFrameResponse | null = null;
  private _bridgeStarted = false;
  private _winScore: number = 1.0; // Default win score; updated from frame responses

  constructor(
    gameId: string,
    pyFilePath: string,
    bridgeConfig?: Partial<GameBridgeConfig>,
  ) {
    this._gameId = gameId;
    this.bridge = new GameBridge(gameId, pyFilePath, bridgeConfig);
  }

  // ─── GameAdapter readonly properties ────────────────────────────────────────

  get gameId(): string {
    return this._gameId;
  }

  /** Title from BridgeInfoResponse; falls back to gameId before first start(). */
  get title(): string {
    return this._title || this._gameId;
  }

  /**
   * Current level number (1-indexed) from the last frame, or null before reset().
   * The bridge populates `current_level` as `level_index + 1` from game metadata.
   */
  get level(): number | null {
    return this._lastFrame?.current_level ?? null;
  }

  /**
   * Total levels in the game.
   * Prefers the value from the last frame; falls back to the info-time value.
   */
  get totalLevels(): number | null {
    return this._lastFrame?.total_levels ?? this._totalLevelsFromInfo ?? null;
  }

  /**
   * Win score for this game — the score value that indicates full completion.
   * Updated from frame responses; defaults to 1.0 for percentage-based scoring.
   */
  get winScore(): number {
    return this._winScore;
  }

  // ─── GameAdapter methods ─────────────────────────────────────────────────────

  /**
   * Reset the game to its initial state.
   * Automatically starts the bridge subprocess on the very first call.
   */
  async reset(seed?: number): Promise<void> {
    await this.commandSemaphore.acquire();
    try {
      if (!this._bridgeStarted) {
        const info = await this.bridge.start();
        this._title = info.title || this._gameId;
        this._totalLevelsFromInfo = info.total_levels ?? null;
        this._bridgeStarted = true;
      }
      this._lastFrame = await this.bridge.reset(seed);
      // Update winScore from frame response if present
      if (typeof this._lastFrame.win_score === "number") {
        this._winScore = this._lastFrame.win_score;
      }
    } finally {
      this.commandSemaphore.release();
    }
  }

  /**
   * Execute an action string and advance the game state.
   * Delegates parsing to GameBridge (handles 'UP', 'CLICK 10 15', 'ACTION7', etc.).
   * Throws if reset() has not been called first.
   */
  async step(action: string): Promise<void> {
    await this.commandSemaphore.acquire();
    try {
      if (!this._bridgeStarted || this._lastFrame === null) {
        throw new Error(
          `[Arc3GameAdapter:${this._gameId}] Must call reset() before step()`,
        );
      }
      this._lastFrame = await this.bridge.action(action);
      // Update winScore from frame response if present
      if (typeof this._lastFrame.win_score === "number") {
        this._winScore = this._lastFrame.win_score;
      }
    } finally {
      this.commandSemaphore.release();
    }
  }

  /**
   * Returns the current score as levels_completed / total_levels (0.0–1.0).
   * Returns 0 before the first reset() call.
   *
   * Mirrors Python: min(levels_completed / max(len(levels), 1), 1.0)
   */
  getScore(): number {
    if (this._lastFrame === null) return 0;
    const levelsCompleted = this._lastFrame.levels_completed ?? 0;
    const total = Math.max(this.totalLevels ?? 1, 1);
    return Math.min(levelsCompleted / total, 1.0);
  }

  /**
   * Returns the current game state, mapped from the bridge frame state string.
   *
   * Cycle guard: if levels_completed >= total_levels, returns WIN even if the
   * engine cycled back to an earlier level (matches Python get_state logic).
   * Returns NOT_PLAYED before the first reset().
   */
  getState(): GameState {
    if (this._lastFrame === null) return "NOT_PLAYED";

    const levelsCompleted = this._lastFrame.levels_completed ?? 0;
    const total = this.totalLevels ?? 0;

    // Cycle guard: all levels completed → WIN regardless of engine state
    if (total > 0 && levelsCompleted >= total) {
      return "WIN";
    }

    // Map the raw bridge state string to our GameState union
    switch (this._lastFrame.state.toUpperCase()) {
      case "WIN":
        return "WIN";
      case "GAME_OVER":
        return "GAME_OVER";
      case "NOT_FINISHED":
      case "IN_PROGRESS":
        return "NOT_FINISHED";
      default:
        // Unknown engine states default to NOT_FINISHED (forward-compatible)
        return "NOT_FINISHED";
    }
  }

  /**
   * Returns true when the game is truly finished — WIN or all levels completed.
   *
   * CRITICAL: GAME_OVER is NOT terminal for ARC3. A GAME_OVER just means the
   * agent failed the current level; it can call RESET to retry. Only WIN ends
   * the run.
   *
   * Python equivalent (game_adapter.py:247-256):
   *   if levels_completed >= total_levels: return True
   *   return state == WIN
   */
  isDone(): boolean {
    if (this._lastFrame === null) return false;

    const levelsCompleted = this._lastFrame.levels_completed ?? 0;
    const total = this.totalLevels ?? 0;

    // All levels completed → done (cycle guard)
    if (total > 0 && levelsCompleted >= total) {
      return true;
    }

    // Win state → done
    return this.getState() === "WIN";
  }

  /**
   * Returns human-readable action names valid in the current game state.
   *
   * Special cases:
   *   - Before first reset: returns full fallback action set
   *   - GAME_OVER state: returns only ['RESET'] — other actions silently do nothing
   *   - Normal play: translates arcengine ACTION1–ACTION7 to UP/DOWN/etc., always
   *     includes RESET so the agent can proactively restart a level
   */
  getAvailableActions(): string[] {
    if (this._lastFrame === null) {
      return [...ALL_HUMAN_ACTIONS];
    }

    // GAME_OVER: only reset is meaningful (matches Python lines 261-263)
    if (this._lastFrame.state.toUpperCase() === "GAME_OVER") {
      return ["reset"];
    }

    const bridgeActions = this._lastFrame.available_actions;
    if (!bridgeActions || bridgeActions.length === 0) {
      // No actions from bridge — return the full human set as fallback
      return [...ALL_HUMAN_ACTIONS];
    }

    // Actions come as lowercase from PuzzleEnvironment.get_actions() — pass through as-is.
    // No static map needed; the game defines its own action vocabulary.
    const humanActions: string[] = bridgeActions.filter(Boolean);

    // Always include reset so agent can proactively restart a level
    if (!humanActions.includes("reset")) {
      humanActions.push("reset");
    }

    return humanActions;
  }

  /**
   * Returns a text representation of the current frame for LLM consumption.
   * Mirrors Python Arc3GameAdapter.render_text() output format exactly.
   *
   * Format:
   *   Grid (WxH) | Level L/TL | Score: S% | State: STATE
   *
   *    c1 c2 c3 ...
   *    ...
   */
  renderText(): string {
    if (this._lastFrame === null) {
      return "(no frame — call reset() first)";
    }

    // Extract 2D grid from potentially multi-dimensional frame array
    const frame2d = extractFrame(this._lastFrame.frame as unknown);

    if (frame2d.length === 0) {
      // GAME_OVER produces empty frames — show header only (matches Python lines 282-287)
      return (
        `Grid (0x0) | Level ${this.level ?? "?"}/${this.totalLevels ?? "?"}` +
        ` | Score: ${Math.round(this.getScore() * 100)}% | State: ${this.getState()}`
      );
    }

    return renderFrameText(
      frame2d,
      this.level,
      this.totalLevels,
      this.getScore(),
      this.getState(),
    );
  }

  /**
   * Returns null — PNG rendering requires native image libraries (numpy/PIL)
   * which are unavailable in TypeScript without external npm packages.
   *
   * The eval runner handles null by omitting the image from the LLM prompt
   * (respects EvalSessionConfig.withImages). To enable visual rendering,
   * extend this class or add a canvas-based renderer.
   */
  async renderPngBase64(): Promise<string | null> {
    return null;
  }

  /**
   * Returns the raw grid data from the latest frame.
   * The frame is a 2D or 3D array of integers (cell colors 0-15).
   * Returns null if no frame has been received yet.
   */
  getGrid(): number[][] | number[][][] | null {
    if (!this._lastFrame) return null;
    return this._lastFrame.frame as number[][] | number[][][];
  }

  // ─── Extended API (beyond GameAdapter interface) ───────────────────────────

  /**
   * Returns static metadata about this game — used by GET /api/eval/games.
   */
  getMetadata(): GameMetadata {
    return {
      gameId: this._gameId,
      gameType: this.gameType,
      title: this.title,
      totalLevels: this.totalLevels,
      availableActions: this.getAvailableActions(),
    };
  }

  /**
   * Clean up the Python subprocess when this adapter is no longer needed.
   * Always call dispose() after evaluation to prevent process leaks.
   */
  async dispose(): Promise<void> {
    await this.bridge.quit();
    this._bridgeStarted = false;
    this._lastFrame = null;
  }

  // ─── Static factory ────────────────────────────────────────────────────────

  /**
   * Convenience factory — creates an adapter and pre-starts the bridge subprocess
   * to catch configuration errors (missing Python, arcengine not installed) early.
   *
   * Usage:
   *   const adapter = await Arc3GameAdapter.create('ls20');
   *   await adapter.reset();
   *   // ... evaluate ...
   *   await adapter.dispose();
   */
  static async create(
    gameId: string,
    pyFilePath?: string,
    config?: Partial<GameBridgeConfig>,
    envDir?: string,
  ): Promise<Arc3GameAdapter> {
    let resolvedPyFile = pyFilePath;
    if (!resolvedPyFile) {
      const { discoverGames } = await import("./types");
      const games = discoverGames(envDir);
      const found = games.find((g) => g.gameId === gameId);
      if (!found) {
        const available = games.map((g) => g.gameId).join(", ");
        throw new Error(
          `Game '${gameId}' not found in puzzle-environments/. Available: [${available}]`,
        );
      }
      resolvedPyFile = found.pyFile;
    }
    const mergedConfig = envDir ? { ...config, allowedRoot: envDir } : config;
    const adapter = new Arc3GameAdapter(gameId, resolvedPyFile, mergedConfig);
    // Pre-start to surface errors (missing Python, bad gameId) before eval begins
    const info = await adapter.bridge.start();
    adapter._title = info.title || gameId;
    adapter._totalLevelsFromInfo = info.total_levels ?? null;
    adapter._bridgeStarted = true;
    return adapter;
  }
}
