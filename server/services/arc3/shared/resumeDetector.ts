

import {
  listInterruptedSessions,
  loadLatestCheckpoint,
  markCheckpointCompleted,
  type SessionCheckpoint,
} from './sessionCheckpoint';

// ---------------------------------------------------------------------------
// ResumeCandidate — enriched checkpoint info for API responses
// ---------------------------------------------------------------------------

export interface ResumeCandidate {
  readonly sessionId: string;
  readonly runId: string;
  readonly gameId: string;
  readonly gameGuid: string;
  readonly modelId: string;
  readonly stepNumber: number;
  readonly lastScore: number;
  readonly lastState: string;
  readonly costSoFar: number;
  readonly interruptedAt: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get all resumable sessions (interrupted, not completed).
 */
export async function getResumableSessions(): Promise<ResumeCandidate[]> {
  const interrupted = await listInterruptedSessions();
  return interrupted.map(toResumeCandidate);
}

/**
 * Get resumable sessions for a specific game.
 */
export async function getResumableSessionsForGame(
  gameId: string,
): Promise<ResumeCandidate[]> {
  const all = await getResumableSessions();
  return all.filter((s) => s.gameId === gameId);
}

/**
 * Get the checkpoint data needed to resume a session.
 * Returns null if no checkpoint exists or session is already completed.
 */
export async function getResumeData(
  sessionId: string,
): Promise<SessionCheckpoint | null> {
  const checkpoint = await loadLatestCheckpoint(sessionId);
  if (!checkpoint || checkpoint.completed) return null;
  return checkpoint;
}

/**
 * Mark a session as no longer resumable (completed or abandoned).
 */
export async function dismissSession(sessionId: string): Promise<void> {
  await markCheckpointCompleted(sessionId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResumeCandidate(checkpoint: SessionCheckpoint): ResumeCandidate {
  return {
    sessionId: checkpoint.sessionId,
    runId: checkpoint.runId,
    gameId: checkpoint.gameId,
    gameGuid: checkpoint.gameGuid,
    modelId: checkpoint.modelId,
    stepNumber: checkpoint.stepNumber,
    lastScore: checkpoint.lastFrameScore,
    lastState: checkpoint.lastFrameState,
    costSoFar: checkpoint.costSnapshot.totalCostUsd,
    interruptedAt: checkpoint.createdAt,
  };
}
