export interface Arc3FrameAction {
  type: string;
  coordinates?: [number, number];
}

export interface Arc3FrameWithAction {
  action?: Arc3FrameAction;
}

export interface Arc3FrameState<TFrame extends object> {
  frames: ReadonlyArray<TFrame & Arc3FrameWithAction>;
  currentFrameIndex: number;
}

export interface Arc3FrameUpdatePayload<TFrame extends object> {
  frameIndex: number | string;
  frameData: TFrame;
  action?: Arc3FrameAction;
}

export interface Arc3ActionExecutedPayload<TFrame extends object> {
  newFrame?: TFrame;
}

/**
 * Merge a frame update into the current frame list using the backend's logical frame index.
 * Appends when the index is at or beyond the current list length to avoid sparse arrays.
 */
export function applyArc3FrameUpdate<TFrame extends object>(
  state: Arc3FrameState<TFrame>,
  payload: Arc3FrameUpdatePayload<TFrame>,
): Arc3FrameState<TFrame> {
  const frameIndex = Number(payload.frameIndex);
  if (!Number.isFinite(frameIndex) || frameIndex < 0) {
    return {
      frames: [...state.frames],
      currentFrameIndex: state.currentFrameIndex,
    };
  }

  const normalizedFrameIndex = Math.trunc(frameIndex);
  const frameWithAction = payload.action
    ? { ...payload.frameData, action: payload.action }
    : { ...payload.frameData };

  if (normalizedFrameIndex >= state.frames.length) {
    return {
      frames: [...state.frames, frameWithAction],
      currentFrameIndex: state.frames.length,
    };
  }

  return {
    frames: state.frames.map((frame, index) =>
      index === normalizedFrameIndex ? frameWithAction : frame,
    ),
    currentFrameIndex: normalizedFrameIndex,
  };
}

/**
 * Handle game.action_executed payloads. AgentSDK does not emit newFrame today,
 * so preserve the current frame state unless a frame is explicitly provided.
 */
export function applyArc3ActionExecuted<TFrame extends object>(
  state: Arc3FrameState<TFrame>,
  payload: Arc3ActionExecutedPayload<TFrame>,
): Arc3FrameState<TFrame> {
  if (!payload.newFrame) {
    return {
      frames: [...state.frames],
      currentFrameIndex: state.currentFrameIndex,
    };
  }

  return {
    frames: [...state.frames, payload.newFrame],
    currentFrameIndex: state.frames.length,
  };
}
