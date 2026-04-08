import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildTurnPrompt,
} from "../../server/services/eval/runner/promptBuilder";

// ── buildSystemPrompt: arc3 ─────────────────────────────────────────────────

describe("buildSystemPrompt arc3", () => {
  it("generates prompt for arc3 game type", () => {
    const prompt = buildSystemPrompt("arc3", 200, 75, false);

    expect(prompt).toContain("interactive environments");
    expect(prompt).toContain("click 10 15");
    expect(prompt).toContain("NOTEPAD");
    expect(prompt).toContain("8000 characters");
  });

  it("includes image line when withImages=true", () => {
    const withImages = buildSystemPrompt("arc3", 200, 75, true);
    const withoutImages = buildSystemPrompt("arc3", 200, 75, false);

    expect(withImages).toContain("screenshot image");
    expect(withoutImages).not.toContain("screenshot image");
  });

  it("incorporates maxSteps and contextWindow in arc2 prompt", () => {
    const prompt = buildSystemPrompt("arc2", 100, 30);

    expect(prompt).toContain("100 actions");
    expect(prompt).toContain("30 turns");
  });
});

// ── buildSystemPrompt: arc2 ─────────────────────────────────────────────────

describe("buildSystemPrompt arc2", () => {
  it("generates prompt for arc2 game type", () => {
    const prompt = buildSystemPrompt("arc2", 200, 50);

    expect(prompt).toContain("ARC-AGI-2");
    expect(prompt).toContain("pattern recognition");
    expect(prompt).toContain("SET_CELL");
    expect(prompt).toContain("SET_ROW");
    expect(prompt).toContain("SUBMIT");
    expect(prompt).toContain("RESET_GRID");
    expect(prompt).toContain("GRID COLORS");
    expect(prompt).toContain("200 actions");
    expect(prompt).toContain("50 turns");
  });
});

// ── buildSystemPrompt: caching ──────────────────────────────────────────────

describe("buildSystemPrompt caching", () => {
  it("returns same instance for identical params (cache hit)", () => {
    const a = buildSystemPrompt("arc3", 200, 75, false);
    const b = buildSystemPrompt("arc3", 200, 75, false);

    // Same string reference due to Map cache
    expect(a).toBe(b);
  });

  it("returns different instances for different params", () => {
    const a = buildSystemPrompt("arc3", 200, 75, false);
    const b = buildSystemPrompt("arc3", 100, 50, true);

    expect(a).not.toBe(b);
  });
});

// ── buildSystemPrompt: error handling ───────────────────────────────────────

describe("buildSystemPrompt error handling", () => {
  it("throws for unknown game type", () => {
    // @ts-expect-error — intentionally passing invalid type for test
    expect(() => buildSystemPrompt("arc4", 200, 50)).toThrow(
      /Unknown gameType/,
    );
  });
});

// ── buildTurnPrompt ─────────────────────────────────────────────────────────

describe("buildTurnPrompt", () => {
  it("includes step counter (1-indexed display)", () => {
    const prompt = buildTurnPrompt("grid state", ["UP", "DOWN"], "", 0, 200);
    expect(prompt).toContain("STEP 1/200");
  });

  it("includes observation text", () => {
    const prompt = buildTurnPrompt("Grid: [[0,1],[2,3]]", ["UP"], "", 5, 100);
    expect(prompt).toContain("Grid: [[0,1],[2,3]]");
  });

  it("lists available actions", () => {
    const prompt = buildTurnPrompt(
      "obs",
      ["UP", "DOWN", "LEFT", "RIGHT", "SELECT"],
      "",
      0,
      100,
    );
    expect(prompt).toContain("UP, DOWN, LEFT, RIGHT, SELECT");
  });

  it("truncates actions list at 30 and shows total", () => {
    const manyActions = Array.from({ length: 50 }, (_, i) => `ACTION_${i}`);
    const prompt = buildTurnPrompt("obs", manyActions, "", 0, 100);

    expect(prompt).toContain("ACTION_0");
    expect(prompt).toContain("ACTION_29");
    expect(prompt).toContain("50 total");
    expect(prompt).not.toContain("ACTION_30");
  });

  it("shows notepad contents when non-empty", () => {
    const prompt = buildTurnPrompt("obs", ["UP"], "My notes here", 0, 100);
    expect(prompt).toContain("My notes here");
    expect(prompt).not.toContain("(empty)");
  });

  it("shows (empty) for blank notepad", () => {
    const prompt = buildTurnPrompt("obs", ["UP"], "", 0, 100);
    expect(prompt).toContain("(empty)");
  });

  it("shows (empty) for whitespace-only notepad", () => {
    const prompt = buildTurnPrompt("obs", ["UP"], "   \n  ", 0, 100);
    expect(prompt).toContain("(empty)");
  });

  it("includes JSON response format instruction", () => {
    const prompt = buildTurnPrompt("obs", ["UP"], "", 0, 100);
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"notepad_update"');
  });
});
