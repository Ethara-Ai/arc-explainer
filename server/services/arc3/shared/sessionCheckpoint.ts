

import { promises as fs } from 'fs';
import path from 'path';
import { safeStringify } from './safeJson';
import type { CostTracker } from './CostTracker';
import type { Notepad } from '../../eval/runner/notepad';

// ---------------------------------------------------------------------------
// Checkpoint data shape
// ---------------------------------------------------------------------------

export interface SessionCheckpoint {
  readonly sessionId: string;
  readonly runId: string;
  readonly stepNumber: number;
  readonly gameId: string;
  readonly gameGuid: string;
  readonly scorecardId: string;
  readonly modelId: string;
  readonly conversationHistory: ReadonlyArray<{ role: string; content: string }>;
  readonly notepadState: { content: string; maxChars: number; history: string[] };
  readonly costSnapshot: {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    totalCachedInputTokens: number;
    totalCacheWriteTokens: number;
  };
  readonly lastFrameState: string;
  readonly lastFrameScore: number;
  readonly createdAt: string;   // ISO 8601
  readonly completed: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoint directory
// ---------------------------------------------------------------------------

const CHECKPOINT_DIR = path.join('data', 'playground-checkpoints');

// ---------------------------------------------------------------------------
// Save checkpoint
// ---------------------------------------------------------------------------

/**
 * Save a session checkpoint to disk (atomic: write to tmp then rename).
 * Called after each step in the StepLoopEngine.
 */
export async function saveCheckpoint(checkpoint: SessionCheckpoint): Promise<string> {
  const dir = path.join(CHECKPOINT_DIR, checkpoint.sessionId);
  await fs.mkdir(dir, { recursive: true });

  const filename = `checkpoint_step${checkpoint.stepNumber}.json`;
  const filepath = path.join(dir, filename);
  const tmpPath = `${filepath}.tmp`;

  const data = safeStringify(checkpoint, true);
  await fs.writeFile(tmpPath, data, 'utf-8');
  await fs.rename(tmpPath, filepath);

  // Also write a "latest" symlink/copy for quick resume detection
  const latestPath = path.join(dir, 'latest.json');
  await fs.writeFile(latestPath, data, 'utf-8');

  return filepath;
}

// ---------------------------------------------------------------------------
// Load checkpoint
// ---------------------------------------------------------------------------

/**
 * Load the latest checkpoint for a session.
 * Returns null if no checkpoint exists.
 */
export async function loadLatestCheckpoint(
  sessionId: string,
): Promise<SessionCheckpoint | null> {
  const latestPath = path.join(CHECKPOINT_DIR, sessionId, 'latest.json');
  try {
    const data = await fs.readFile(latestPath, 'utf-8');
    return JSON.parse(data) as SessionCheckpoint;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// List interrupted sessions
// ---------------------------------------------------------------------------

/**
 * Scan checkpoint directory for incomplete sessions.
 * Returns sessions where completed === false.
 */
export async function listInterruptedSessions(): Promise<SessionCheckpoint[]> {
  const interrupted: SessionCheckpoint[] = [];

  try {
    const entries = await fs.readdir(CHECKPOINT_DIR);
    for (const entry of entries) {
      const latestPath = path.join(CHECKPOINT_DIR, entry, 'latest.json');
      try {
        const data = await fs.readFile(latestPath, 'utf-8');
        const checkpoint = JSON.parse(data) as SessionCheckpoint;
        if (!checkpoint.completed) {
          interrupted.push(checkpoint);
        }
      } catch {
        // Skip invalid checkpoint dirs
      }
    }
  } catch {
    // Checkpoint directory doesn't exist yet
  }

  return interrupted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------
// Mark completed
// ---------------------------------------------------------------------------

/**
 * Mark a session checkpoint as completed (prevents it from appearing in
 * interrupted sessions list).
 */
export async function markCheckpointCompleted(sessionId: string): Promise<void> {
  const latestPath = path.join(CHECKPOINT_DIR, sessionId, 'latest.json');
  try {
    const data = await fs.readFile(latestPath, 'utf-8');
    const checkpoint = JSON.parse(data) as SessionCheckpoint;
    const updated: SessionCheckpoint = { ...checkpoint, completed: true };
    await fs.writeFile(latestPath, safeStringify(updated, true), 'utf-8');
  } catch {
    // No checkpoint to mark
  }
}

/**
 * Build a checkpoint from current engine state.
 */
export function buildCheckpoint(params: {
  sessionId: string;
  runId: string;
  stepNumber: number;
  gameId: string;
  gameGuid: string;
  scorecardId: string;
  modelId: string;
  conversationHistory: Array<{ role: string; content: string }>;
  notepad: Notepad;
  costTracker: CostTracker;
  lastFrameState: string;
  lastFrameScore: number;
  completed: boolean;
}): SessionCheckpoint {
  return {
    sessionId: params.sessionId,
    runId: params.runId,
    stepNumber: params.stepNumber,
    gameId: params.gameId,
    gameGuid: params.gameGuid,
    scorecardId: params.scorecardId,
    modelId: params.modelId,
    conversationHistory: [...params.conversationHistory],
    notepadState: params.notepad.toState(),
    costSnapshot: {
      totalCostUsd: params.costTracker.totalCostUsd,
      totalInputTokens: params.costTracker.totalInputTokens,
      totalOutputTokens: params.costTracker.totalOutputTokens,
      totalReasoningTokens: params.costTracker.totalReasoningTokens,
      totalCachedInputTokens: params.costTracker.totalCachedInputTokens,
      totalCacheWriteTokens: params.costTracker.totalCacheWriteTokens,
    },
    lastFrameState: params.lastFrameState,
    lastFrameScore: params.lastFrameScore,
    createdAt: new Date().toISOString(),
    completed: params.completed,
  };
}
