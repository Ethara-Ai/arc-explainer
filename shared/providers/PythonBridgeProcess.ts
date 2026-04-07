import { spawn, type ChildProcess } from "child_process";
import { getPythonBin } from "../../server/config/env";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "readline";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PythonBridgeConfig {
  readonly bridgeScript: string;
  readonly displayName: string;
  readonly logPrefix: string;
  readonly logCategory?: string;
  readonly startupTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maxRestartAttempts?: number;
  readonly maxPendingRequests?: number;
  readonly maxStderrLines?: number;
  readonly env?: Record<string, string>;
}

export interface BridgeResult {
  data: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: BridgeResult) => void;
  reject: (reason: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface BridgeError {
  error_type: string;
  message: string;
  traceback: string;
  status_code?: number;
  llm_provider?: string;
}

interface BridgeMessage {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
  error?: BridgeError;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_MAX_PENDING_REQUESTS = 100;
const DEFAULT_MAX_STDERR_LINES = 500;
const SIGKILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// PythonBridgeProcess
// ---------------------------------------------------------------------------

/**
 * Manages a long-lived Python subprocess communicating via NDJSON over
 * stdin/stdout. Supports request multiplexing (multiple in-flight requests
 * identified by UUID), lazy start, auto-restart, and graceful shutdown.
 *
 * Extracted from LiteLLMSdkProvider and LiteLLMAgentModel to eliminate
 * ~400 lines of duplicated subprocess management code.
 */
export class PythonBridgeProcess {
  private readonly _config: PythonBridgeConfig;
  private readonly _startupTimeoutMs: number;
  private readonly _callTimeoutMs: number;
  private readonly _maxRestartAttempts: number;
  private readonly _maxPendingRequests: number;
  private readonly _maxStderrLines: number;

  private _proc: ChildProcess | null = null;
  private _rl: ReadlineInterface | null = null;
  private _alive = false;
  private _starting = false;
  private _stderrLines: string[] = [];
  private _pending = new Map<string, PendingRequest>();
  private _restartCount = 0;

  constructor(config: PythonBridgeConfig) {
    this._config = config;
    this._startupTimeoutMs =
      config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this._callTimeoutMs = config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this._maxRestartAttempts =
      config.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    this._maxPendingRequests =
      config.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this._maxStderrLines =
      config.maxStderrLines ?? DEFAULT_MAX_STDERR_LINES;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Send a request to the Python bridge and return the multiplexed response.
   * Lazily starts the subprocess on first call. Auto-restarts on crash.
   */
  async sendRequest(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<BridgeResult> {
    await this._ensureAlive();
    return this._sendRequest(request, signal, timeoutMs);
  }

  /**
   * Gracefully shut down the Python subprocess.
   */
  async shutdown(): Promise<void> {
    if (!this._proc) return;

    try {
      this._proc.stdin?.end();
    } catch {
      // Process may already be gone
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    if (this._proc && !this._proc.killed) {
      this._proc.kill("SIGTERM");
      setTimeout(() => {
        if (this._proc && !this._proc.killed) {
          this._proc.kill("SIGKILL");
        }
      }, SIGKILL_GRACE_MS);
    }

    this._teardown();
  }

  // ── Private: Subprocess Lifecycle ───────────────────────────────────────

  private async _ensureAlive(): Promise<void> {
    if (this._alive) return;

    if (this._starting) {
      await this._waitForAlive();
      return;
    }

    if (this._restartCount >= this._maxRestartAttempts) {
      throw new Error(
        `[${this._config.logPrefix}] Python bridge crashed ${this._restartCount} times, giving up. ` +
          `Last stderr: ${this._stderrLines.slice(-5).join(" | ")}`,
      );
    }

    this._starting = true;
    try {
      await this._startProcess();
    } finally {
      this._starting = false;
    }
  }

  private async _waitForAlive(): Promise<void> {
    const deadline = Date.now() + this._startupTimeoutMs;
    while (!this._alive && this._starting) {
      if (Date.now() > deadline) {
        throw new Error(
          `[${this._config.logPrefix}] Timed out waiting for Python bridge to start`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this._alive) {
      throw new Error(
        `[${this._config.logPrefix}] Python bridge failed to start`,
      );
    }
  }

  private async _startProcess(): Promise<void> {
    const pythonBin = getPythonBin();
    this._stderrLines = [];

    this._proc = spawn(pythonBin, ["-u", this._config.bridgeScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
        ...(this._config.env ?? {}),
      },
    });

    // Collect stderr (ring buffer) and forward for observability
    this._proc.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        this._stderrLines.push(line);
        if (this._stderrLines.length > this._maxStderrLines) {
          this._stderrLines.shift();
        }
        console.log(`[${this._config.logPrefix}:bridge] ${line}`);
      }
    });

    // Handle unexpected exits
    this._proc.on("exit", (code) => {
      this._alive = false;
      for (const [id, pending] of this._pending) {
        clearTimeout(pending.timeoutHandle);
        pending.reject(
          new Error(
            `[${this._config.logPrefix}] Python bridge exited (code ${code}) with request ${id} in-flight. ` +
              `Stderr: ${this._stderrLines.slice(-3).join(" | ")}`,
          ),
        );
      }
      this._pending.clear();
      this._restartCount++;
    });

    this._proc.on("error", (err) => {
      this._alive = false;
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timeoutHandle);
        pending.reject(
          new Error(
            `[${this._config.logPrefix}] Spawn error: ${err.message}`,
          ),
        );
      }
      this._pending.clear();
    });

    this._setupReadline();
    await this._waitForReady();

    this._alive = true;
    this._restartCount = 0;
  }

  private _setupReadline(): void {
    if (!this._proc?.stdout) {
      throw new Error(`[${this._config.logPrefix}] Process has no stdout`);
    }

    this._rl = createInterface({
      input: this._proc.stdout,
      crlfDelay: Infinity,
    });

    this._rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: BridgeMessage;
      try {
        msg = JSON.parse(trimmed) as BridgeMessage;
      } catch {
        this._stderrLines.push(`[stdout-non-json] ${trimmed}`);
        return;
      }

      // "ready" signal is handled separately in _waitForReady
      if (msg.type === "ready") return;

      // Dispatch to pending request by ID
      const requestId = msg.id;
      if (!requestId) return;

      const pending = this._pending.get(requestId);
      if (!pending) return;

      this._pending.delete(requestId);
      clearTimeout(pending.timeoutHandle);

      if (msg.type === "error" && msg.error) {
        const err = new Error(
          `[${this._config.logPrefix}] ${msg.error.error_type}: ${msg.error.message}`,
        ) as Error & Record<string, unknown>;
        err.status_code = msg.error.status_code;
        err.llm_provider = msg.error.llm_provider;
        err.error_type = msg.error.error_type;
        pending.reject(err);
      } else if (msg.type === "result" && msg.data) {
        pending.resolve({ data: msg.data });
      } else {
        pending.reject(
          new Error(
            `[${this._config.logPrefix}] Unexpected message type: ${msg.type}`,
          ),
        );
      }
    });
  }

  private _waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `[${this._config.logPrefix}] Python bridge did not send ready signal within ${this._startupTimeoutMs}ms. ` +
              `Stderr: ${this._stderrLines.slice(-5).join(" | ")}`,
          ),
        );
      }, this._startupTimeoutMs);

      const checkLine = (line: string) => {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === "ready") {
            clearTimeout(timeout);
            this._rl?.removeListener("line", checkLine);
            resolve();
          }
        } catch {
          // Not JSON yet, keep waiting
        }
      };

      this._rl?.on("line", checkLine);

      this._proc?.on("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `[${this._config.logPrefix}] Python bridge exited (code ${code}) before ready. ` +
              `Stderr: ${this._stderrLines.join(" | ")}`,
          ),
        );
      });
    });
  }

  // ── Private: Request Multiplexing ───────────────────────────────────────

  private _sendRequest(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<BridgeResult> {
    if (!this._alive || !this._proc?.stdin) {
      return Promise.reject(
        new Error(
          `[${this._config.logPrefix}] Python bridge is not running`,
        ),
      );
    }

    if (this._pending.size >= this._maxPendingRequests) {
      return Promise.reject(
        new Error(
          `[${this._config.logPrefix}] Too many pending requests (${this._pending.size}/${this._maxPendingRequests})`,
        ),
      );
    }

    const requestId = randomUUID();
    const requestWithId = { ...request, id: requestId };
    const effectiveTimeout = timeoutMs ?? this._callTimeoutMs;

    return new Promise<BridgeResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new Error(
            `[${this._config.logPrefix}] Request aborted before send`,
          ),
        );
        return;
      }

      const timeoutHandle = setTimeout(() => {
        this._pending.delete(requestId);
        reject(
          new Error(
            `[${this._config.logPrefix}] Request ${requestId} timed out after ${effectiveTimeout}ms`,
          ),
        );
      }, effectiveTimeout);

      const pending: PendingRequest = { resolve, reject, timeoutHandle };
      this._pending.set(requestId, pending);

      const abortHandler = () => {
        const p = this._pending.get(requestId);
        if (p) {
          this._pending.delete(requestId);
          clearTimeout(p.timeoutHandle);
          p.reject(
            new Error(
              `[${this._config.logPrefix}] Request aborted by caller`,
            ),
          );
        }
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      try {
        this._proc!.stdin!.write(JSON.stringify(requestWithId) + "\n");
      } catch (writeErr) {
        this._pending.delete(requestId);
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", abortHandler);
        reject(
          writeErr instanceof Error ? writeErr : new Error(String(writeErr)),
        );
      }
    });
  }

  // ── Private: Cleanup ────────────────────────────────────────────────────

  private _teardown(): void {
    this._alive = false;
    this._proc = null;
    this._rl = null;
  }
}
