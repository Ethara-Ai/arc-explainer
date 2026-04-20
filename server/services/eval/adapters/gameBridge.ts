import { spawn, type ChildProcess } from "child_process";
import { getPythonBin } from "../../../config/env";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { resolve as resolvePath } from "path";
import { logger } from "../../../utils/logger";
import type {
  BridgeCommand,
  BridgeResponse,
  BridgeInfoResponse,
  BridgeFrameResponse,
  GameBridgeConfig,
} from "./types";
import {
  DEFAULT_BRIDGE_CONFIG,
  validateGameId,
  discoverGames,
  ENVIRONMENT_FILES_DIR,
} from "./types";

// ── Inline Python bridge script ───────────────────────────────────────────────
//
// Generated at runtime with the game_id interpolated. The script:
//   1. Imports the game module and discovers PuzzleEnvironment class
//   2. Creates a PuzzleEnvironment instance (no gymnasium)
//   3. Implements JSON-line protocol: reads commands from stdin, writes responses to stdout
//   4. Handles: info, reset, action, quit commands
//
// NOTE: `sys.stdin` iteration blocks until a line arrives, making this a tight
// read → process → write loop with no threading needed.

function buildPythonScript(gameId: string, pyFilePath: string): string {
  return `
import sys
import json
import importlib.util
import traceback
import os
import io
import numpy as np

# ── Stdout isolation ──────────────────────────────────────────────────────────
# Redirect stdout to stderr BEFORE loading any game code. This prevents game
# print() calls from corrupting the JSONL protocol on stdout. We keep a
# reference to the real stdout for protocol messages only.
_protocol_out = sys.stdout
sys.stdout = sys.stderr

def _proto_write(obj):
    """Write a JSON object to the protocol channel (original stdout)."""
    _protocol_out.write(json.dumps(obj) + '\\n')
    _protocol_out.flush()

game_id = ${JSON.stringify(gameId)}
py_file = ${JSON.stringify(pyFilePath)}


def load_puzzle_env_class(file_path):
    """Load the PuzzleEnvironment class from a game file (by name, no gymnasium)."""
    mod_name = f'_arc_eval_{os.path.basename(file_path).replace(".py", "")}'
    spec = importlib.util.spec_from_file_location(mod_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Cannot load spec from {file_path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    pe_cls = getattr(module, 'PuzzleEnvironment', None)
    if pe_cls is None or not isinstance(pe_cls, type):
        raise ImportError(
            f'No PuzzleEnvironment class found in {file_path}. '
            f'All ARC-AGI-3 games must provide a PuzzleEnvironment class.'
        )
    return pe_cls


def to_nested_list(obj):
    if hasattr(obj, 'tolist'):
        return obj.tolist()
    if isinstance(obj, (list, tuple)):
        return [to_nested_list(row) for row in obj]
    return obj


def get_color_index_frame():
    """Extract the 2D color-index grid (0-15) from the arcengine layer.

    Reaches into pe._engine (or pe._game) to access camera.render(sprites).
    Returns a nested list of color indices for frontend rendering.
    """
    try:
        engine = getattr(pe, '_engine', None) or getattr(pe, '_game', None)
        if engine is None:
            return None
        cam = engine.camera
        sprites = engine.current_level.get_sprites()
        grid = cam.render(sprites)
        if hasattr(grid, 'tolist'):
            return grid.tolist()
        return to_nested_list(grid)
    except Exception:
        return None


last_state = None
cumulative_reward = 0.0
done = False
step_count = 0


def build_frame_response(reward=0.0):
    """Build JSON frame response from PuzzleEnvironment state.

    All game metadata is read from state.metadata — no engine internals.
    All 54 games now provide: levels_completed, level_index, game_over, total_levels.
    """
    gm = getattr(last_state, 'metadata', {}) or {}
    text_obs = getattr(last_state, 'text_observation', '') or ''

    # Read standardized fields from metadata
    is_game_over = bool(gm.get('game_over', False))
    levels_completed = gm.get('levels_completed', 0) or 0
    total_levels = gm.get('total_levels')
    level_index = gm.get('level_index', 0) or 0

    # Determine state string
    if done and is_game_over:
        state_str = 'GAME_OVER'
    elif done:
        state_str = 'WIN'
    else:
        state_str = 'IN_PROGRESS'

    # Get available actions from PuzzleEnvironment
    available = list(pe.get_actions())

    # Get 2D color-index grid for frontend rendering (still needs engine access)
    frame = get_color_index_frame()
    if frame is None:
        frame = [[0]]

    return {
        'type': 'frame',
        'frame': frame,
        'score': cumulative_reward,
        'state': state_str,
        'action_counter': step_count,
        'max_actions': 200,
        'win_score': 1.0,
        'available_actions': available,
        'levels_completed': levels_completed,
        'current_level': level_index + 1,
        'level_index': level_index,
        'total_levels': total_levels,
        'text_observation': text_obs,
    }


def get_info_response():
    available = list(pe.get_actions())
    gm = getattr(last_state, 'metadata', {}) or {}
    return {
        'type': 'info',
        'game_id': game_id,
        'title': game_id,
        'description': '',
        'available_actions': available,
        'total_levels': gm.get('total_levels'),
    }


# ── Bootstrap ──────────────────────────────────────────────────────────────────
try:
    PEClass = load_puzzle_env_class(py_file)
    pe = PEClass(seed=0)
    last_state = pe.reset()
except Exception as exc:
    sys.stderr.write(f'[bridge] Failed to load game {game_id}: {exc}\\n')
    sys.stderr.flush()
    _proto_write({'type': 'error', 'message': str(exc)})
    sys.exit(1)

# ── Main loop ──────────────────────────────────────────────────────────────────
for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    try:
        cmd = json.loads(line)
    except json.JSONDecodeError as parse_err:
        sys.stderr.write(f'[bridge] JSON parse error: {parse_err}\\n')
        sys.stderr.flush()
        continue

    cmd_type = cmd.get('type', '')

    try:
        if cmd_type == 'info':
            _proto_write(get_info_response())

        elif cmd_type == 'reset':
            reset_seed = cmd.get('seed')
            if reset_seed is not None:
                pe = PEClass(seed=int(reset_seed))
            last_state = pe.reset()
            done = False
            cumulative_reward = 0.0
            step_count = 0
            _proto_write(build_frame_response())

        elif cmd_type == 'action':
            action_name = cmd.get('action', 'up').strip().lower()
            x = cmd.get('x')
            y = cmd.get('y')

            # Reconstruct full action string — TS parseActionString decomposes
            # "click 10 15" into {action: "click", x: 10, y: 15}, but
            # PuzzleEnvironment.step() expects the full string "click 10 15".
            if x is not None and y is not None:
                action_str = f"{action_name} {x} {y}"
            elif x is not None:
                action_str = f"{action_name} {x}"
            else:
                action_str = action_name

            # Handle RESET action via pe.reset()
            if action_str == 'reset':
                last_state = pe.reset()
                done = False
                cumulative_reward = 0.0
                step_count = 0
                _proto_write(build_frame_response())
                continue

            # Pass string action directly to PuzzleEnvironment
            result = pe.step(action_str)
            last_state = result.state
            cumulative_reward += result.reward
            done = result.done
            step_count += 1
            _proto_write(build_frame_response(result.reward))

        elif cmd_type == 'quit':
            if hasattr(pe, 'close'):
                pe.close()
            sys.exit(0)

        else:
            _proto_write({'type': 'error', 'message': f'Unknown command type: {cmd_type}'})

    except Exception as step_err:
        tb = traceback.format_exc()
        sys.stderr.write(f'[bridge] Step error: {tb}\\n')
        sys.stderr.flush()
        _proto_write({'type': 'error', 'message': str(step_err)})
`.trimStart();
}

// ── GameBridge class ──────────────────────────────────────────────────────────

/**
 * Bridges TypeScript eval runner ↔ Python PuzzleEnvironment game subprocess.
 *
 * Lifecycle:
 *   1. Construct with gameId + optional config
 *   2. `await bridge.start()` — spawns process, returns BridgeInfoResponse
 *   3. `await bridge.reset()` / `bridge.action(str)` — run the game
 *   4. `await bridge.quit()` — tears down cleanly; instance can be start()ed again
 *
 * Protocol:
 *   TS → Python (stdin) : one JSON line per command
 *   Python → TS (stdout): one JSON line per response
 *   Python stderr       : warnings / tracebacks collected but non-fatal
 *
 * Only one command may be in-flight at a time (synchronous protocol).
 */
export class GameBridge {
  private readonly gameId: string;
  private readonly pyFilePath: string;
  private readonly config: GameBridgeConfig;

  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private alive = false;
  private hasBeenStarted = false;
  private processExited = false;
  private stderrLines: string[] = [];

  private pendingResolve: ((value: BridgeResponse) => void) | null = null;
  private pendingReject: ((reason: Error) => void) | null = null;

  /** Mutex: non-null while a killAndRespawn or ensureAlive cycle is in-flight. */
  private respawning: Promise<void> | null = null;

  constructor(
    gameId: string,
    pyFilePath: string,
    config?: Partial<GameBridgeConfig>,
  ) {
    validateGameId(gameId);

    // Defense-in-depth: validate pyFilePath is a .py file within the expected directory
    const resolvedPyPath = resolvePath(pyFilePath);
    if (!resolvedPyPath.endsWith(".py")) {
      throw new Error(
        `[GameBridge] pyFilePath must end in .py: ${resolvedPyPath}`,
      );
    }
    const allowedRoot = resolvePath(
      config?.allowedRoot ?? ENVIRONMENT_FILES_DIR,
    );
    if (!resolvedPyPath.startsWith(allowedRoot + "/")) {
      throw new Error(
        `[GameBridge] pyFilePath must be within ${allowedRoot}: ${resolvedPyPath}`,
      );
    }

    this.gameId = gameId;
    this.pyFilePath = resolvedPyPath;
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  }

  /**
   * Construct a GameBridge from a game ID by looking up the game in puzzle-environments/.
   * @param envDir - Override the puzzle-environments root (for --game-dir flag)
   */
  static fromGameId(
    gameId: string,
    envDir?: string,
    config?: Partial<GameBridgeConfig>,
  ): GameBridge {
    const games = discoverGames(envDir);
    const found = games.find((g) => g.gameId === gameId);
    if (!found) {
      const available = games.map((g) => g.gameId).join(", ");
      throw new Error(
        `Game '${gameId}' not found in ${envDir ?? "puzzle-environments/"}. Available: [${available}]`,
      );
    }
    const mergedConfig = envDir ? { ...config, allowedRoot: envDir } : config;
    return new GameBridge(gameId, found.pyFile, mergedConfig);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Spawn the Python subprocess and verify it responds to an `info` command.
   * Safe to call after `quit()` — creates a fresh process each time.
   */
  async start(): Promise<BridgeInfoResponse> {
    if (this.alive) {
      return this.getInfo();
    }

    this.hasBeenStarted = true;
    this.stderrLines = [];
    this.spawnProcess();
    this.setupReadline();

    // First message: verify subprocess is alive and get game metadata
    const info = await this.getInfo();
    return info;
  }

  /**
   * Send any BridgeCommand and receive the next response from the subprocess.
   * Throws if no process is running or a command is already in-flight.
   * Auto-respawns dead bridges via ensureAlive() before sending.
   */
  async sendCommand(command: BridgeCommand): Promise<BridgeResponse> {
    if (this.processExited && this.hasBeenStarted) {
      await this.ensureAlive();
    }

    if (!this.proc?.stdin) {
      throw new Error(`[GameBridge:${this.gameId}] Process is not running`);
    }

    if (this.pendingResolve !== null) {
      throw new Error(
        `[GameBridge:${this.gameId}] A command is already in-flight — commands are synchronous`,
      );
    }

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(
          new Error(
            `[GameBridge:${this.gameId}] Timed out waiting for response to: ${JSON.stringify(command)}`,
          ),
        );
        // Fire-and-forget kill + respawn to prevent desync with zombie process
        void this.killAndRespawn().catch((err) => {
          logger.warn(
            `[GameBridge:${this.gameId}] killAndRespawn failed after timeout: ${err instanceof Error ? err.message : String(err)}`,
            "game-bridge",
          );
        });
      }, this.config.commandTimeoutMs);

      this.pendingResolve = (value: BridgeResponse) => {
        clearTimeout(timeoutHandle);
        if (value.type === "error") {
          reject(
            new Error(
              `[GameBridge:${this.gameId}] Game error: ${value.message}`,
            ),
          );
        } else {
          resolve(value);
        }
      };

      this.pendingReject = (reason: Error) => {
        clearTimeout(timeoutHandle);
        reject(reason);
      };

      try {
        this.writeToStdin(command);
      } catch (writeErr) {
        clearTimeout(timeoutHandle);
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(
          writeErr instanceof Error ? writeErr : new Error(String(writeErr)),
        );
      }
    });
  }

  /** Reset the game to its initial state; returns the opening frame. */
  async reset(seed?: number): Promise<BridgeFrameResponse> {
    const cmd: BridgeCommand =
      seed != null ? { type: "reset", seed } : { type: "reset" };
    const resp = await this.sendCommand(cmd);
    return resp as BridgeFrameResponse;
  }

  /**
   * Execute an action string and return the resulting frame.
   *
   * Accepts human-readable strings ("UP", "CLICK 10 15") as defined by each
   * game's PuzzleEnvironment.get_actions().
   *
   * Parsing rules:
   *   - Split on whitespace to extract name + optional x y coordinates
   *   - Lowercase the action name to match PuzzleEnvironment convention
   *   - Python bridge passes string directly to pe.step()
   *   - "CLICK 10 15" → passed as "click" with x=10, y=15
   */
  async action(actionStr: string): Promise<BridgeFrameResponse> {
    const command = this.parseActionString(actionStr);
    const resp = await this.sendCommand(command);
    return resp as BridgeFrameResponse;
  }

  /** Retrieve static game metadata without side-effects. */
  async getInfo(): Promise<BridgeInfoResponse> {
    const resp = await this.sendCommand({ type: "info" });
    return resp as BridgeInfoResponse;
  }

  /**
   * Gracefully quit the subprocess.
   * Sends `quit`, kills the process, and resets state so `start()` can be called again.
   */
  async quit(): Promise<void> {
    if (!this.proc) return;

    // Best-effort: send quit command (process may already be dying)
    try {
      if (this.alive && this.proc.stdin) {
        this.writeToStdin({ type: "quit" });
      }
    } catch {
      // Swallow — process may already be gone
    }

    // Give the process a brief window to exit cleanly before SIGTERM
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }

    this.teardown();
  }

  /** Returns true while the subprocess is running and healthy. */
  isAlive(): boolean {
    return this.alive;
  }

  /** Accumulated stderr lines from the subprocess — useful for debugging. */
  getStderrLines(): string[] {
    return [...this.stderrLines];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Spawn the Python3 subprocess with the inline bridge script for this gameId.
   * Sets up stderr collection and process-exit error propagation.
   */
  private spawnProcess(): void {
    const pythonBin =
      this.config.env?.["PYTHON_BIN"] ??
      getPythonBin() ??
      this.config.pythonBin;

    const script = buildPythonScript(this.gameId, this.pyFilePath);

    this.proc = spawn(pythonBin, ["-u", "-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure Python writes unbuffered UTF-8 to stdout/stderr
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
        ...(this.config.env ?? {}),
      },
    });

    // Collect stderr without treating it as fatal — Python prints tracebacks there
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        this.stderrLines.push(line);
        // Keep stderr buffer bounded to avoid memory growth on long runs
        if (this.stderrLines.length > 500) {
          this.stderrLines.shift();
        }
      }
    });

    // Propagate unexpected process exits to any waiting promise
    this.proc.on("exit", (code) => {
      this.alive = false;
      this.processExited = true;
      if (this.pendingReject) {
        const reject = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(
          new Error(
            `[GameBridge:${this.gameId}] Python process exited unexpectedly (code ${code}). ` +
              `Last stderr: ${this.stderrLines.slice(-3).join(" | ")}`,
          ),
        );
      }
    });

    // Propagate spawn errors (e.g. python3 not found)
    this.proc.on("error", (err) => {
      this.alive = false;
      if (this.pendingReject) {
        const reject = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(
          new Error(`[GameBridge:${this.gameId}] Spawn error: ${err.message}`),
        );
      }
    });

    this.alive = true;
    this.processExited = false;
  }

  /**
   * Create a readline interface on the subprocess stdout.
   * Each non-empty line is parsed as JSON and dispatched to the pending promise.
   */
  private setupReadline(): void {
    if (!this.proc?.stdout) {
      throw new Error(`[GameBridge:${this.gameId}] Process has no stdout`);
    }

    this.rl = createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity, // Handle Windows line endings gracefully
    });

    this.rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let parsed: BridgeResponse;
      try {
        parsed = JSON.parse(trimmed) as BridgeResponse;
      } catch {
        // Non-JSON from Python stdout (unlikely but possible during startup)
        // Treat as a non-fatal warning; don't reject the pending promise
        this.stderrLines.push(`[stdout-non-json] ${trimmed}`);
        return;
      }

      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingReject = null;
        resolve(parsed);
      }
    });
  }

  /**
   * Wait for the next JSON-line response from the subprocess, with a timeout.
   * This is a convenience wrapper used when you need to decouple the write and
   * the wait (e.g. in tests). Normal callers should use `sendCommand`.
   */
  private readResponse(timeoutMs?: number): Promise<BridgeResponse> {
    const timeout = timeoutMs ?? this.config.commandTimeoutMs;

    if (!this.alive) {
      return Promise.reject(
        new Error(
          `[GameBridge:${this.gameId}] Cannot read response — process is not running`,
        ),
      );
    }

    if (this.pendingResolve !== null) {
      return Promise.reject(
        new Error(`[GameBridge:${this.gameId}] A read is already pending`),
      );
    }

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(
          new Error(
            `[GameBridge:${this.gameId}] readResponse timed out after ${timeout}ms`,
          ),
        );
      }, timeout);

      this.pendingResolve = (value: BridgeResponse) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      };

      this.pendingReject = (reason: Error) => {
        clearTimeout(timeoutHandle);
        reject(reason);
      };
    });
  }

  /**
   * Write a single JSON-line command to the subprocess stdin.
   * Does NOT wait for a response — pair with `readResponse` or use `sendCommand`.
   */
  private writeToStdin(command: BridgeCommand): void {
    if (!this.proc?.stdin) {
      throw new Error(`[GameBridge:${this.gameId}] No stdin available`);
    }
    this.proc.stdin.write(JSON.stringify(command) + "\n");
  }

  /**
   * Parse a human-readable action string into a BridgeCommand.
   *
   * Examples:
   *   "UP"          → { type: 'action', action: 'up', x: null, y: null }
   *   "CLICK 10 15" → { type: 'action', action: 'click', x: 10, y: 15 }
   *   "UNDO"        → { type: 'action', action: 'undo', x: null, y: null }
   *   "SWAP"        → { type: 'action', action: 'swap', x: null, y: null }
   */
  private parseActionString(
    actionStr: string,
  ): Extract<BridgeCommand, { type: "action" }> {
    const parts = actionStr.trim().split(/\s+/);
    const rawName = parts[0] ?? "up";

    // Lowercase to match PuzzleEnvironment action convention.
    // Python bridge passes string directly to pe.step().
    const arcAction: string = rawName.toLowerCase();

    // Extract optional x, y coordinates (present for CLICK / ACTION6)
    const xRaw = parts[1];
    const yRaw = parts[2];
    const x = xRaw !== undefined ? parseInt(xRaw, 10) : null;
    const y = yRaw !== undefined ? parseInt(yRaw, 10) : null;

    return {
      type: "action",
      action: arcAction,
      x: Number.isNaN(x ?? NaN) ? null : x,
      y: Number.isNaN(y ?? NaN) ? null : y,
    };
  }

  /**
   * Force-kill the subprocess and spawn a fresh one.
   * Kill chain: stdin.end → SIGTERM → 5s grace → SIGKILL → teardown → start().
   * First line sets alive=false synchronously to prevent races.
   *
   * Re-entrant safe: concurrent callers share the same in-flight promise.
   */
  private killAndRespawn(): Promise<void> {
    // Immediately mark dead to prevent new commands from racing in
    this.alive = false;

    if (this.respawning) return this.respawning;

    this.respawning = this.doKillAndRespawn().finally(() => {
      this.respawning = null;
    });
    return this.respawning;
  }

  /** Internal kill + respawn logic — callers must go through killAndRespawn(). */
  private async doKillAndRespawn(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        // Process may already be gone
      }

      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may already be gone
      }

      // Wait up to 5s for process to exit; SIGKILL if it doesn't
      await new Promise<void>((resolve) => {
        let resolved = false;

        const killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Process may already be gone
          }
          done();
        }, 5000);

        const done = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(killTimer);
          proc.removeListener("exit", done);
          resolve();
        };

        proc.on("exit", done);
      });
    }

    this.teardown();
    await this.start();
  }

  /**
   * If the bridge is dead, respawn it by calling start().
   * No-ops if already alive. Re-entrant safe via shared respawning promise.
   */
  private ensureAlive(): Promise<void> {
    if (this.alive) return Promise.resolve();
    if (this.respawning) return this.respawning;

    this.respawning = this.start().then(
      () => {
        this.respawning = null;
      },
      (err) => {
        this.respawning = null;
        throw err;
      },
    );
    return this.respawning;
  }

  /** Release all resources without sending quit (used after unexpected exit). */
  private teardown(): void {
    this.alive = false;
    this.proc = null;
    this.rl = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}
