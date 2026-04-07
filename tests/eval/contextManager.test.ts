import { describe, it, expect } from "vitest";
import {
  ContextManager,
  estimateTokens,
} from "../../server/services/eval/runner/contextManager";

// ── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates tokens from text length at ~1.2 chars per token", () => {
    // 200 chars / 1.2 ≈ 166.67 → ceil → 167 tokens
    const text = "a".repeat(200);
    expect(estimateTokens(text)).toBe(167);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("ceils the result (no fractional tokens)", () => {
    // 5 chars / 1.2 ≈ 4.17 → ceil → 5
    expect(estimateTokens("hello")).toBe(5);
  });

  it("handles long text correctly", () => {
    const text = "x".repeat(12000);
    // 12000 / 1.2 = 10000
    expect(estimateTokens(text)).toBe(10000);
  });
});

// ── ContextManager: sliding window ──────────────────────────────────────────

describe("ContextManager sliding window", () => {
  it("default window size is 10 messages", () => {
    const cm = new ContextManager();
    // Add 20 messages
    for (let i = 0; i < 20; i++) {
      cm.addTurn(i % 2 === 0 ? "user" : "assistant", `message-${i}`);
    }
    const context = cm.getContext();
    expect(context).toHaveLength(10);
    // Should be the LAST 10 messages
    expect(context[0].content).toBe("message-10");
    expect(context[9].content).toBe("message-19");
  });

  it("returns all messages when fewer than window size", () => {
    const cm = new ContextManager({ windowSize: 10 });
    cm.addTurn("user", "hello");
    cm.addTurn("assistant", "hi");

    const context = cm.getContext();
    expect(context).toHaveLength(2);
  });

  it("respects custom window size", () => {
    const cm = new ContextManager({ windowSize: 4 });
    for (let i = 0; i < 10; i++) {
      cm.addTurn("user", `msg-${i}`);
    }
    const context = cm.getContext();
    expect(context).toHaveLength(4);
    expect(context[0].content).toBe("msg-6");
  });

  it("empty context returns empty array", () => {
    const cm = new ContextManager();
    expect(cm.getContext()).toEqual([]);
  });
});

// ── ContextManager: totalTurns ──────────────────────────────────────────────

describe("ContextManager totalTurns", () => {
  it("counts all messages (not just windowed ones)", () => {
    const cm = new ContextManager({ windowSize: 4 });
    for (let i = 0; i < 20; i++) {
      cm.addTurn("user", `msg-${i}`);
    }
    expect(cm.totalTurns).toBe(20);
  });

  it("starts at 0", () => {
    const cm = new ContextManager();
    expect(cm.totalTurns).toBe(0);
  });
});

// ── ContextManager: clear ───────────────────────────────────────────────────

describe("ContextManager clear", () => {
  it("removes all history", () => {
    const cm = new ContextManager();
    cm.addTurn("user", "hello");
    cm.addTurn("assistant", "hi");
    expect(cm.totalTurns).toBe(2);

    cm.clear();
    expect(cm.totalTurns).toBe(0);
    expect(cm.getContext()).toEqual([]);
  });
});

// ── ContextManager: token budget trimming ───────────────────────────────────

describe("ContextManager getContextWithinBudget", () => {
  it("returns full window when within budget", () => {
    const cm = new ContextManager({ windowSize: 10 });
    cm.addTurn("user", "short");
    cm.addTurn("assistant", "reply");

    // Budget is huge — no trimming needed
    const context = cm.getContextWithinBudget(100000, "system", "observation");
    expect(context).toHaveLength(2);
  });

  it("trims oldest turn pairs when over budget", () => {
    const cm = new ContextManager({ windowSize: 20 });

    // Add 10 turn pairs (20 messages), each ~100 chars
    for (let i = 0; i < 10; i++) {
      cm.addTurn("user", "a".repeat(100));
      cm.addTurn("assistant", "b".repeat(100));
    }

    // 20 messages * 100 chars / 1.2 chars/token ≈ 1667 tokens from history
    // System + observation = ~200 chars / 1.2 ≈ 167 tokens fixed
    // Total ≈ 1834 tokens. Budget of 1000 * 0.9 = 900 effective — must trim
    const context = cm.getContextWithinBudget(
      1000,
      "a".repeat(100),
      "b".repeat(100),
    );

    // Should have fewer than 20 messages
    expect(context.length).toBeLessThan(20);
    // Should still have messages (budget > 0)
    expect(context.length).toBeGreaterThan(0);
    // Should be even number (pairs)
    expect(context.length % 2).toBe(0);
  });

  it("trims by pairs (2 messages at a time)", () => {
    const cm = new ContextManager({ windowSize: 6 });

    cm.addTurn("user", "x".repeat(60));
    cm.addTurn("assistant", "y".repeat(60));
    cm.addTurn("user", "x".repeat(60));
    cm.addTurn("assistant", "y".repeat(60));
    cm.addTurn("user", "x".repeat(60));
    cm.addTurn("assistant", "y".repeat(60));

    // Tight budget: only room for ~2 messages of history
    // 6 messages * 60 chars / 1.2 = 300 tokens history
    // System + obs = 10 chars each ≈ 18 tokens fixed
    // Total ≈ 318; budget 200 * 0.9 = 180; need to drop pairs
    const context = cm.getContextWithinBudget(200, "tiny", "tiny");
    expect(context.length).toBeLessThan(6);
    expect(context.length % 2).toBe(0);
  });

  it("returns empty when budget is impossibly small", () => {
    const cm = new ContextManager({ windowSize: 10 });
    cm.addTurn("user", "message");
    cm.addTurn("assistant", "reply");

    // Huge system prompt eats all budget
    const context = cm.getContextWithinBudget(
      10,
      "a".repeat(1000),
      "b".repeat(1000),
    );
    expect(context).toHaveLength(0);
  });
});
