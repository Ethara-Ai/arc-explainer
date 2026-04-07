import { describe, it, expect } from "vitest";
import { EvalRunner } from "../../server/services/eval/runner/evalRunner";
import {
  isRateLimitError,
  isGeminiQuotaError,
  isGeminiTransientError,
  isNonTransientError,
} from "../../server/services/eval/runner/errorClassifiers";
import type {
  GameAdapter,
  BaseEvalProvider,
  EvalConfig,
} from "../../shared/eval-types";

// ── Minimal mocks (just enough to construct EvalRunner) ─────────────────────

function mockGame(): GameAdapter {
  return {
    gameId: "ct01",
    gameType: "arc3",
    title: "CT01",
    level: null,
    totalLevels: null,
    winScore: 1.0,
    reset: async () => {},
    step: async () => {},
    getScore: () => 0,
    getState: () => "NOT_PLAYED",
    isDone: () => false,
    getAvailableActions: () => ["UP", "DOWN"],
    renderText: () => "grid state",
    renderPngBase64: async () => null,
    getGrid: () => null,
  };
}

function mockProvider(): BaseEvalProvider {
  return {
    modelName: "Test Model",
    modelId: "test-model-v1",
    chooseAction: async () => ({
      action: "UP",
      reasoning: "testing",
      notepadUpdate: null,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      costUsd: 0.001,
      rawResponse: null,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      trafficType: null,
      thinkingText: null,
    }),
  };
}

function mockConfig(): EvalConfig {
  return {
    maxSteps: 10,
    numRuns: 1,
    contextWindow: 5,
    seedBase: 42,
    outputDir: "",
    dryRun: false,
    retryAttempts: 3,
    retryBackoffBase: 1.5,
    retryMaxWait: 60,
    maxConsecutiveSkips: 10,
    saveRawResponses: false,
    tokenBudget: 0,
    providerMaxConcurrent: {},
  };
}

// ── Helper: create bridge-shaped errors (mirrors PythonBridgeProcess) ────────

interface BridgeErrorOpts {
  message: string;
  status_code?: number;
  llm_provider?: string;
  error_type?: string;
}

function makeBridgeError(opts: BridgeErrorOpts): Error {
  const err = new Error(opts.message) as Error & Record<string, unknown>;
  if (opts.status_code !== undefined) err.status_code = opts.status_code;
  if (opts.llm_provider !== undefined) err.llm_provider = opts.llm_provider;
  if (opts.error_type !== undefined) err.error_type = opts.error_type;
  return err;
}

// ── Error classification tests ──────────────────────────────────────────────

describe("EvalRunner error classification", () => {
  // ── isRateLimitError ────────────────────────────────────────────────────

  describe("isRateLimitError", () => {
    it('detects "rate_limit" in error message', () => {
      expect(isRateLimitError(new Error("rate_limit exceeded"))).toBe(true);
    });

    it('detects "rate limit" (with space) in error message', () => {
      expect(isRateLimitError(new Error("rate limit hit for this model"))).toBe(
        true,
      );
    });

    it('detects "quota" in error message', () => {
      expect(isRateLimitError(new Error("quota exceeded for project"))).toBe(
        true,
      );
    });

    it("detects bridge status_code=429", () => {
      const err = makeBridgeError({
        message: "RateLimitError: Too Many Requests",
        status_code: 429,
        llm_provider: "vertex_ai",
        error_type: "RateLimitError",
      });
      expect(isRateLimitError(err)).toBe(true);
    });

    it("detects HTTP 429 via .status (backward compat)", () => {
      const err = new Error("Too Many Requests");
      (err as unknown as Record<string, number>).status = 429;
      expect(isRateLimitError(err)).toBe(true);
    });

    it("detects HTTP 429 via .statusCode (backward compat)", () => {
      const err = new Error("Too Many Requests");
      (err as unknown as Record<string, number>).statusCode = 429;
      expect(isRateLimitError(err)).toBe(true);
    });

    it("returns false for non-Error values", () => {
      expect(isRateLimitError("string error")).toBe(false);
      expect(isRateLimitError(42)).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
    });

    it("returns false for generic errors", () => {
      expect(isRateLimitError(new Error("Connection timeout"))).toBe(false);
    });
  });

  // ── isGeminiQuotaError ──────────────────────────────────────────────────

  describe("isGeminiQuotaError", () => {
    it("detects bridge vertex_ai 429", () => {
      const err = makeBridgeError({
        message: "RateLimitError: RESOURCE_EXHAUSTED",
        status_code: 429,
        llm_provider: "vertex_ai",
        error_type: "RateLimitError",
      });
      expect(isGeminiQuotaError(err)).toBe(true);
    });

    it("detects bridge gemini provider 429", () => {
      const err = makeBridgeError({
        message: "Rate limit exceeded",
        status_code: 429,
        llm_provider: "gemini",
      });
      expect(isGeminiQuotaError(err)).toBe(true);
    });

    it("detects vertex_ai-* subprovider 429", () => {
      const err = makeBridgeError({
        message: "quota exceeded",
        status_code: 429,
        llm_provider: "vertex_ai-anthropic_models",
      });
      expect(isGeminiQuotaError(err)).toBe(true);
    });

    it("detects 429 + RESOURCE_EXHAUSTED in message without llm_provider", () => {
      const err = new Error("RESOURCE_EXHAUSTED: quota limit");
      (err as unknown as Record<string, number>).status_code = 429;
      expect(isGeminiQuotaError(err)).toBe(true);
    });

    it("returns false for non-Gemini provider with 429", () => {
      const err = makeBridgeError({
        message: "Too Many Requests",
        status_code: 429,
        llm_provider: "openai",
      });
      expect(isGeminiQuotaError(err)).toBe(false);
    });

    it("returns false for Gemini provider without 429", () => {
      const err = makeBridgeError({
        message: "Internal server error",
        status_code: 500,
        llm_provider: "vertex_ai",
      });
      expect(isGeminiQuotaError(err)).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isGeminiQuotaError("not an error")).toBe(false);
    });
  });

  // ── isGeminiTransientError ──────────────────────────────────────────────

  describe("isGeminiTransientError", () => {
    it("detects bridge vertex_ai 504", () => {
      const err = makeBridgeError({
        message: "Timeout: gateway timeout",
        status_code: 504,
        llm_provider: "vertex_ai",
        error_type: "Timeout",
      });
      expect(isGeminiTransientError(err)).toBe(true);
    });

    it("detects bridge vertex_ai 503", () => {
      const err = makeBridgeError({
        message: "ServiceUnavailableError: service unavailable",
        status_code: 503,
        llm_provider: "vertex_ai",
      });
      expect(isGeminiTransientError(err)).toBe(true);
    });

    it("detects bridge gemini provider with DEADLINE_EXCEEDED in message", () => {
      const err = makeBridgeError({
        message: "DEADLINE_EXCEEDED for operation",
        status_code: 504,
        llm_provider: "gemini",
      });
      expect(isGeminiTransientError(err)).toBe(true);
    });

    it("detects UNAVAILABLE in message for Gemini provider", () => {
      const err = makeBridgeError({
        message: "UNAVAILABLE: backend not ready",
        llm_provider: "vertex_ai",
      });
      expect(isGeminiTransientError(err)).toBe(true);
    });

    it("returns false for non-Gemini provider with 504", () => {
      const err = makeBridgeError({
        message: "gateway timeout",
        status_code: 504,
        llm_provider: "openai",
      });
      expect(isGeminiTransientError(err)).toBe(false);
    });

    it("returns false for errors without llm_provider", () => {
      const err = new Error("gateway timeout");
      (err as unknown as Record<string, number>).status_code = 504;
      expect(isGeminiTransientError(err)).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isGeminiTransientError(42)).toBe(false);
    });
  });

  // ── isNonTransientError ─────────────────────────────────────────────────

  describe("isNonTransientError", () => {
    it("detects bridge status_code=401", () => {
      const err = makeBridgeError({
        message: "AuthenticationError: invalid key",
        status_code: 401,
        llm_provider: "openai",
        error_type: "AuthenticationError",
      });
      expect(isNonTransientError(err)).toBe(true);
    });

    it("detects bridge status_code=403", () => {
      const err = makeBridgeError({
        message: "PermissionError: forbidden",
        status_code: 403,
        llm_provider: "vertex_ai",
      });
      expect(isNonTransientError(err)).toBe(true);
    });

    it("detects bridge status_code=400", () => {
      const err = makeBridgeError({
        message: "BadRequestError: invalid input",
        status_code: 400,
        llm_provider: "cloud",
      });
      expect(isNonTransientError(err)).toBe(true);
    });

    it("detects .status=404 (backward compat)", () => {
      const err = new Error("Not Found");
      (err as unknown as Record<string, number>).status = 404;
      expect(isNonTransientError(err)).toBe(true);
    });

    it("detects auth keywords in message", () => {
      expect(isNonTransientError(new Error("invalid api key"))).toBe(true);
      expect(isNonTransientError(new Error("api key not set"))).toBe(true);
      expect(isNonTransientError(new Error("access denied"))).toBe(true);
      expect(isNonTransientError(new Error("Unauthorized request"))).toBe(true);
    });

    it("detects bridge failure messages", () => {
      expect(isNonTransientError(new Error("bridge exited with code 1"))).toBe(
        true,
      );
      expect(isNonTransientError(new Error("bridge crashed"))).toBe(true);
      expect(isNonTransientError(new Error("bridge did not send ready"))).toBe(
        true,
      );
    });

    it("returns false for transient errors", () => {
      expect(isNonTransientError(new Error("Connection timeout"))).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isNonTransientError("string error")).toBe(false);
    });
  });
});

// ── Abort mechanism ─────────────────────────────────────────────────────────

describe("EvalRunner abort", () => {
  it("abort() causes run to exit early with error message", async () => {
    const game = mockGame();
    // Game never finishes on its own
    game.isDone = () => false;
    game.getScore = () => 0;
    game.getState = () => "IN_PROGRESS";
    game.getAvailableActions = () => ["UP"];
    game.renderText = () => "grid";

    let callCount = 0;
    const provider = mockProvider();
    provider.chooseAction = async () => {
      callCount++;
      // Abort after first call
      if (callCount === 1) {
        runner.abort();
      }
      return {
        action: "UP",
        reasoning: "test",
        notepadUpdate: null,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        costUsd: 0.001,
        rawResponse: null,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        trafficType: null,
        thinkingText: null,
      };
    };

    const config = mockConfig();
    config.maxSteps = 100; // Would run 100 steps without abort

    const runner = new EvalRunner(game, provider, config);
    const result = await runner.runGame(0);

    // Should have stopped very early
    expect(result.totalSteps).toBeLessThanOrEqual(2);
    expect(result.error).toContain("abort");
  });
});

// ── Dry run mode ────────────────────────────────────────────────────────────

describe("EvalRunner dry run", () => {
  it("dryRun=true skips API calls and finishes immediately", async () => {
    const game = mockGame();
    game.isDone = () => false;
    game.getState = () => "IN_PROGRESS";

    let apiCalled = false;
    const provider = mockProvider();
    provider.chooseAction = async () => {
      apiCalled = true;
      throw new Error("Should not be called in dry run");
    };

    const config = mockConfig();
    config.dryRun = true;
    config.maxSteps = 200;

    const events: Array<{ type: string }> = [];
    const emitter = (event: { type: string }) => events.push(event);

    const runner = new EvalRunner(game, provider, config, emitter as any);
    const result = await runner.runGame(0);

    expect(apiCalled).toBe(false);
    expect(result.totalSteps).toBe(1); // Only the initial step
    expect(result.error).toBeNull();
  });
});
