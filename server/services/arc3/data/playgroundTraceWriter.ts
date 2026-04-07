import path from "path";
import {
  JsonlWriter,
  formatSessionTimestamp,
} from "../../eval/data/traceWriter";
import { safeStringify } from "../shared/safeJson";
import type { StepRecord, RunRecord } from "../shared/stepRecord";

// ─── Trace Record Types ──────────────────────────────────────────────────────

export interface PlaygroundTraceHeader {
  readonly type: "header";
  readonly gameId: string;
  readonly gameGuid: string;
  readonly scorecardId: string;
  readonly agentName: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly timestamp: string;
}

export interface PlaygroundTraceEvent {
  readonly type: "event";
  readonly event: string;
  readonly step: number;
  readonly data: Record<string, unknown>;
  readonly timestamp: string;
}

export interface PlaygroundTraceFrame {
  readonly type: "frame";
  readonly frameIndex: number;
  readonly state: string;
  readonly score: number;
  readonly actionCounter: number | null;
  readonly maxActions: number;
  readonly timestamp: string;
}

export interface PlaygroundTraceSummary {
  readonly type: "summary";
  readonly gameId: string;
  readonly gameGuid: string;
  readonly finalState: string;
  readonly finalScore: number;
  readonly totalFrames: number;
  readonly usage: {
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly elapsedMs: number;
  readonly timestamp: string;
}

export type PlaygroundTraceRecord =
  | PlaygroundTraceHeader
  | PlaygroundTraceEvent
  | PlaygroundTraceFrame
  | PlaygroundTraceSummary;

// ─── Base output directory ───────────────────────────────────────────────────

const PLAYGROUND_RUNS_DIR = path.join("data", "playground-runs");

// ─── PlaygroundTraceSession ──────────────────────────────────────────────────

/**
 * Manages JSONL trace writing for a single playground game session.
 * Output: data/playground-runs/{timestamp}/{gameId}/traces/trace.jsonl
 *
 * All public methods are fire-and-forget safe — callers should use
 * `.catch(() => {})` to prevent disk errors from crashing games.
 */
export class PlaygroundTraceSession {
  private readonly writer: JsonlWriter;
  private stepCounter = 0;

  constructor(
    readonly sessionDir: string,
    readonly gameId: string,
  ) {
    const tracePath = path.join(sessionDir, gameId, "traces", "trace.jsonl");
    this.writer = new JsonlWriter(tracePath);
  }

  /**
   * Create a new session with a timestamp-based directory.
   * Returns the session instance ready for writing.
   */
  static create(gameId: string): PlaygroundTraceSession {
    const timestamp = formatSessionTimestamp();
    const sessionDir = path.join(PLAYGROUND_RUNS_DIR, timestamp);
    return new PlaygroundTraceSession(sessionDir, gameId);
  }

  async writeHeader(params: {
    gameId: string;
    gameGuid: string;
    scorecardId: string;
    agentName: string;
    model: string;
    maxTurns: number;
  }): Promise<void> {
    const header: PlaygroundTraceHeader = {
      type: "header",
      gameId: params.gameId,
      gameGuid: params.gameGuid,
      scorecardId: params.scorecardId,
      agentName: params.agentName,
      model: params.model,
      maxTurns: params.maxTurns,
      timestamp: new Date().toISOString(),
    };
    await this.writer.append(header as unknown as Record<string, unknown>);
  }

  async writeEvent(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const record: PlaygroundTraceEvent = {
      type: "event",
      event,
      step: this.stepCounter++,
      data,
      timestamp: new Date().toISOString(),
    };
    await this.writer.append(record as unknown as Record<string, unknown>);
  }

  async writeFrame(frame: {
    frameIndex: number;
    state: string;
    score: number;
    actionCounter: number | null;
    maxActions: number;
  }): Promise<void> {
    const record: PlaygroundTraceFrame = {
      type: "frame",
      frameIndex: frame.frameIndex,
      state: frame.state,
      score: frame.score,
      actionCounter: frame.actionCounter,
      maxActions: frame.maxActions,
      timestamp: new Date().toISOString(),
    };
    await this.writer.append(record as unknown as Record<string, unknown>);
  }

  async writeSummary(params: {
    gameId: string;
    gameGuid: string;
    finalState: string;
    finalScore: number;
    totalFrames: number;
    usage: {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    elapsedMs: number;
  }): Promise<void> {
    const summary: PlaygroundTraceSummary = {
      type: "summary",
      gameId: params.gameId,
      gameGuid: params.gameGuid,
      finalState: params.finalState,
      finalScore: params.finalScore,
      totalFrames: params.totalFrames,
      usage: params.usage,
      elapsedMs: params.elapsedMs,
      timestamp: new Date().toISOString(),
    };
    await this.writer.append(summary as unknown as Record<string, unknown>);
  }

  /**
   * Write a detailed step record using safe JSON serialization.
   * Replaces any NaN/Infinity/undefined with null to prevent malformed JSONL.
   */
  async writeStepRecord(stepRecord: StepRecord): Promise<void> {
    const safe = JSON.parse(
      safeStringify({
        type: "step_record",
        ...stepRecord,
      }),
    ) as Record<string, unknown>;
    await this.writer.append(safe);
  }

  /**
   * Write an aggregated run record using safe JSON serialization.
   */
  async writeRunRecord(runRecord: RunRecord): Promise<void> {
    const safe = JSON.parse(
      safeStringify({
        type: "run_record",
        ...runRecord,
      }),
    ) as Record<string, unknown>;
    await this.writer.append(safe);
  }
}
