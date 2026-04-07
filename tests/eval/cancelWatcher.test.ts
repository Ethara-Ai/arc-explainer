import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  startCancelWatcher,
  cleanStaleSentinels,
} from "../../server/services/eval/cancelWatcher";
import type { CancelWatcherConfig } from "../../server/services/eval/cancelWatcher";

// ── Temp dir helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-cancel-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a sentinel file in the temp dir */
async function createSentinel(name: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, name), "", "utf-8");
}

/** Wait for a specified number of milliseconds */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a minimal CancelWatcherConfig with short polling */
function mockConfig(
  overrides: Partial<CancelWatcherConfig> = {},
): CancelWatcherConfig {
  return {
    sentinelDir: tmpDir,
    onGlobalShutdown: () => {},
    gameShutdowns: new Map(),
    pollIntervalMs: 50,
    ...overrides,
  };
}

// ── startCancelWatcher: basic lifecycle ─────────────────────────────────────

describe("startCancelWatcher lifecycle", () => {
  it("creates sentinel directory if it doesn't exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "cancel");
    const cleanup = await startCancelWatcher(
      mockConfig({ sentinelDir: nestedDir }),
    );

    const stat = await fs.stat(nestedDir);
    expect(stat.isDirectory()).toBe(true);

    cleanup();
  });

  it("returns a cleanup function that stops the watcher", async () => {
    let callCount = 0;
    const cleanup = await startCancelWatcher(
      mockConfig({
        onGlobalShutdown: () => {
          callCount++;
        },
      }),
    );

    // Stop the watcher before creating sentinel
    cleanup();

    await createSentinel("CANCEL_ALL");
    await delay(150);

    // Callback should NOT have fired after cleanup
    expect(callCount).toBe(0);
  });
});

// ── startCancelWatcher: sentinel detection ──────────────────────────────────

describe("startCancelWatcher sentinel detection", () => {
  it("CANCEL_ALL sentinel fires onGlobalShutdown callback", async () => {
    let fired = false;
    const cleanup = await startCancelWatcher(
      mockConfig({
        onGlobalShutdown: () => {
          fired = true;
        },
      }),
    );

    await createSentinel("CANCEL_ALL");
    await delay(150);

    expect(fired).toBe(true);
    cleanup();
  });

  it("DRAIN sentinel fires onDrain callback", async () => {
    let drained = false;
    const cleanup = await startCancelWatcher(
      mockConfig({
        onDrain: () => {
          drained = true;
        },
      }),
    );

    await createSentinel("DRAIN");
    await delay(150);

    expect(drained).toBe(true);
    cleanup();
  });

  it("per-game sentinel fires correct game callback", async () => {
    const firedGames: string[] = [];
    const gameShutdowns = new Map<string, () => void>([
      ["ct01", () => firedGames.push("ct01")],
      ["ft09", () => firedGames.push("ft09")],
    ]);

    const cleanup = await startCancelWatcher(
      mockConfig({ gameShutdowns }),
    );

    await createSentinel("CANCEL_ct01");
    await delay(150);

    expect(firedGames).toEqual(["ct01"]);
    // ft09 should NOT have fired
    expect(firedGames).not.toContain("ft09");
    cleanup();
  });

  it("per-model sentinel fires correct model callback", async () => {
    const firedModels: string[] = [];
    const modelShutdowns = new Map<string, () => void>([
      ["ct01_gpt-5.4", () => firedModels.push("ct01_gpt-5.4")],
      ["ct01_claude", () => firedModels.push("ct01_claude")],
    ]);

    const cleanup = await startCancelWatcher(
      mockConfig({ modelShutdowns }),
    );

    await createSentinel("CANCEL_ct01_gpt-5.4");
    await delay(150);

    expect(firedModels).toEqual(["ct01_gpt-5.4"]);
    cleanup();
  });
});

// ── startCancelWatcher: idempotency ─────────────────────────────────────────

describe("startCancelWatcher idempotency", () => {
  it("callbacks only fire once even across multiple polls", async () => {
    let globalCount = 0;
    const cleanup = await startCancelWatcher(
      mockConfig({
        onGlobalShutdown: () => {
          globalCount++;
        },
      }),
    );

    await createSentinel("CANCEL_ALL");
    // Wait for multiple poll cycles
    await delay(300);

    expect(globalCount).toBe(1);
    cleanup();
  });

  it("DRAIN callback fires only once", async () => {
    let drainCount = 0;
    const cleanup = await startCancelWatcher(
      mockConfig({
        onDrain: () => {
          drainCount++;
        },
      }),
    );

    await createSentinel("DRAIN");
    await delay(300);

    expect(drainCount).toBe(1);
    cleanup();
  });

  it("per-game callback fires only once per game", async () => {
    let ct01Count = 0;
    const gameShutdowns = new Map<string, () => void>([
      ["ct01", () => ct01Count++],
    ]);

    const cleanup = await startCancelWatcher(
      mockConfig({ gameShutdowns }),
    );

    await createSentinel("CANCEL_ct01");
    await delay(300);

    expect(ct01Count).toBe(1);
    cleanup();
  });
});

// ── cleanStaleSentinels ─────────────────────────────────────────────────────

describe("cleanStaleSentinels", () => {
  it("removes all files from sentinel directory", async () => {
    await createSentinel("CANCEL_ALL");
    await createSentinel("DRAIN");
    await createSentinel("CANCEL_ct01");

    const removed = await cleanStaleSentinels(tmpDir);
    expect(removed).toHaveLength(3);
    expect(removed).toContain("CANCEL_ALL");
    expect(removed).toContain("DRAIN");
    expect(removed).toContain("CANCEL_ct01");

    // Directory should be empty now
    const entries = await fs.readdir(tmpDir);
    expect(entries).toHaveLength(0);
  });

  it("returns empty array for non-existent directory", async () => {
    const removed = await cleanStaleSentinels(
      path.join(tmpDir, "nonexistent"),
    );
    expect(removed).toEqual([]);
  });

  it("returns empty array for empty directory", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    await fs.mkdir(emptyDir);

    const removed = await cleanStaleSentinels(emptyDir);
    expect(removed).toEqual([]);
  });
});
