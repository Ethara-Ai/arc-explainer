import { describe, expect, it } from "vitest";
import {
  applyArc3ActionExecuted,
  applyArc3FrameUpdate,
  type Arc3FrameState,
} from "@/lib/arc3StreamFrameState";

interface TestFrame {
  score: number;
  state: string;
  frame: number[][][];
  action_counter: number;
}

function createFrame(score: number, actionCounter: number): TestFrame {
  return {
    score,
    state: "IN_PROGRESS",
    frame: [[[score]]],
    action_counter: actionCounter,
  };
}

describe("arc3StreamFrameState", () => {
  it("does not fabricate a frame when game.action_executed omits newFrame", () => {
    const state: Arc3FrameState<TestFrame> = {
      frames: [createFrame(0, 0), { ...createFrame(1, 1), action: { type: "ACTION1" } }],
      currentFrameIndex: 1,
    };

    const next = applyArc3ActionExecuted(state, {});

    expect(next.frames).toHaveLength(2);
    expect(next.currentFrameIndex).toBe(1);
    expect(next.frames[1].action?.type).toBe("ACTION1");
  });

  it("appends a new indexed frame update with its action metadata", () => {
    const state: Arc3FrameState<TestFrame> = {
      frames: [createFrame(0, 0)],
      currentFrameIndex: 0,
    };

    const next = applyArc3FrameUpdate(state, {
      frameIndex: 1,
      frameData: createFrame(1, 1),
      action: { type: "ACTION1" },
    });

    expect(next.frames).toHaveLength(2);
    expect(next.currentFrameIndex).toBe(1);
    expect(next.frames[1].action?.type).toBe("ACTION1");
  });

  it("preserves action alignment across sequential frame updates", () => {
    const started: Arc3FrameState<TestFrame> = {
      frames: [createFrame(0, 0)],
      currentFrameIndex: 0,
    };

    const afterFirstUpdate = applyArc3FrameUpdate(started, {
      frameIndex: 1,
      frameData: createFrame(1, 1),
      action: { type: "ACTION1" },
    });

    const afterFirstExecuted = applyArc3ActionExecuted(afterFirstUpdate, {});

    const afterSecondUpdate = applyArc3FrameUpdate(afterFirstExecuted, {
      frameIndex: 2,
      frameData: createFrame(2, 2),
      action: { type: "ACTION2" },
    });

    expect(afterSecondUpdate.frames).toHaveLength(3);
    expect(afterSecondUpdate.frames[1].action?.type).toBe("ACTION1");
    expect(afterSecondUpdate.frames[2].action?.type).toBe("ACTION2");
    expect(afterSecondUpdate.currentFrameIndex).toBe(2);
  });
});
