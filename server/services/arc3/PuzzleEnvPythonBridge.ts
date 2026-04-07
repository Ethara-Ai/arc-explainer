

import { spawn, type SpawnOptions as ChildProcessSpawnOptions } from 'child_process';
import path from 'path';
import * as readline from 'readline';
import { logger } from '../../utils/logger.ts';
import { getPythonBin } from '../../config/env';

export interface PuzzleEnvPayload {
  game_id: string;
  model_key: string;              // Eval harness model registry key (e.g., "claude-opus", "gpt-5.4-thinking")
  max_turns?: number;             // Default 200
  system_prompt?: string;         // Override system prompt (uses prompt_builder default if null)
  seed?: number;                  // Random seed for ARC3 game instantiation
  context_window?: number;        // Number of recent turns to keep (default 50)
  with_images?: boolean;          // Include PNG screenshots in observations
  agent_name?: string;            // Display name for the agent
  // Meta-commands (mutually exclusive with game_id/model_key)
  command?: 'list_games' | 'list_models';
}

export interface PuzzleEnvSpawnOptions {
  timeoutMs?: number;
  customEnv?: Record<string, string>;
}

export class PuzzleEnvPythonBridge {
  /**
   * Resolve Python binary path from environment or default.
   */
  resolvePythonBin(): string {
    return getPythonBin();
  }

  /**
   * Resolve path to puzzle_env_runner.py.
   * Uses -m module invocation so Python resolves imports correctly.
   */
  resolveRunnerArgs(): string[] {
    return ['-m', 'server.python.puzzle_env_runner'];
  }

  /**
   * Build spawn options with environment variables.
   * All eval harness API keys are passed through the process environment —
   * the Python config.py reads them via os.environ.
   */
  buildSpawnOptions(
    _payload: PuzzleEnvPayload,
    opts: PuzzleEnvSpawnOptions = {}
  ): ChildProcessSpawnOptions {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PYTHONUNBUFFERED: '1',  // Force unbuffered output for streaming
    };

    // Add custom env vars
    if (opts.customEnv) {
      Object.assign(env, opts.customEnv);
    }

    return {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
  }

  // Track active children by session for disconnect-driven teardown
  private activeChildren: Map<string, ReturnType<typeof spawn>> = new Map();

  /**
   * Spawn the puzzle-env runner subprocess with streaming line-by-line output.
   * Parses stdout as NDJSON events and forwards to callbacks.
   */
  async spawnAgent(
    payload: PuzzleEnvPayload,
    spawnOpts: PuzzleEnvSpawnOptions,
    onStdoutLine: (line: string) => void,
    onStderrLine: (line: string) => void,
    sessionId?: string
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const pythonBin = this.resolvePythonBin();
    const runnerArgs = this.resolveRunnerArgs();
    const timeoutMs = spawnOpts.timeoutMs ?? 15 * 60 * 1000; // 15 min default (longer for multi-model)

    const childSpawnOpts = this.buildSpawnOptions(payload, spawnOpts);

    return new Promise((resolve, reject) => {
      logger.info(
        `[PuzzleEnv] Spawning Python runner: ${pythonBin} ${runnerArgs.join(' ')}`,
        'puzzle-env'
      );
      logger.info(
        `[PuzzleEnv] Game: ${payload.game_id ?? '(command)'}, Model: ${payload.model_key ?? '(command)'}`,
        'puzzle-env'
      );

      const child = spawn(pythonBin, runnerArgs, childSpawnOpts);
      if (sessionId) {
        this.activeChildren.set(sessionId, child);
      }

      if (!child.stdout || !child.stderr || !child.stdin) {
        return reject(
          new Error('Python process streams not available for PuzzleEnv runner')
        );
      }

      // Timeout handling
      const timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        const mins = Math.round(timeoutMs / (60 * 1000));
        logger.error(
          `[PuzzleEnv] Runner timeout (${mins} minutes exceeded). Process killed.`,
          'puzzle-env'
        );
        reject(
          new Error(`PuzzleEnv runner timeout (${mins} minutes exceeded).`)
        );
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      // Use readline for line-by-line parsing of stdout (NDJSON)
      const rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });

      let stdoutBuf = '';
      let stderrBuf = '';

      rl.on('line', (line) => {
        stdoutBuf += line + '\n';
        const trimmed = line.trim();
        if (trimmed) {
          onStdoutLine(trimmed);
        }
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderrBuf += text;
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            onStderrLine(trimmed);
          }
        }
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);
        rl.close();
        logger.info(
          `[PuzzleEnv] Python process exited with code ${code}`,
          'puzzle-env'
        );
        if (sessionId) {
          this.activeChildren.delete(sessionId);
        }
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, code });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        rl.close();
        logger.error(
          `[PuzzleEnv] Failed to spawn runner: ${err instanceof Error ? err.message : String(err)}`,
          'puzzle-env'
        );
        if (sessionId) {
          this.activeChildren.delete(sessionId);
        }
        reject(err);
      });

      // Send payload via stdin
      try {
        child.stdin.setDefaultEncoding('utf8');
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
        logger.debug(
          `[PuzzleEnv] Sent payload to Python runner`,
          'puzzle-env'
        );
      } catch (err) {
        clearTimeout(timeoutHandle);
        rl.close();
        logger.error(
          `[PuzzleEnv] Failed to send payload: ${err instanceof Error ? err.message : String(err)}`,
          'puzzle-env'
        );
        child.kill();
        if (sessionId) {
          this.activeChildren.delete(sessionId);
        }
        reject(err);
      }
    });
  }

  /**
   * Kill an active child process for a session (used on SSE disconnect).
   */
  cancel(sessionId: string): void {
    const child = this.activeChildren.get(sessionId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
      logger.info(`[PuzzleEnv] Killed Python runner for session ${sessionId} on disconnect`, 'puzzle-env');
    }
    this.activeChildren.delete(sessionId);
  }
}

export const puzzleEnvPythonBridge = new PuzzleEnvPythonBridge();
