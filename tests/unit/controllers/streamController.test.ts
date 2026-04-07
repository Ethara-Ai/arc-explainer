/**
 * Unit tests for streamController.
 * Tests: prepareAnalysisStream, cancel, startAnalysisStream + internal helpers
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies before imports
vi.mock("../../../server/services/streaming/analysisStreamService", () => ({
  analysisStreamService: {
    savePendingPayload: vi.fn().mockReturnValue("session-123"),
    getPendingPayload: vi.fn(),
    clearPendingPayload: vi.fn(),
    startStreaming: vi.fn().mockResolvedValue(undefined),
  },
  PENDING_SESSION_TTL_SECONDS: 300,
}));

vi.mock("../../../server/services/streaming/SSEStreamManager", () => ({
  sseStreamManager: {
    register: vi.fn().mockReturnValue({ createdAt: Date.now() }),
    sendEvent: vi.fn(),
    error: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("../../../server/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../../server/utils/environmentPolicy.js", () => ({
  requiresUserApiKey: vi.fn().mockReturnValue(false),
}));

import { streamController } from "../../../server/controllers/streamController";
import { analysisStreamService } from "../../../server/services/streaming/analysisStreamService";
import { sseStreamManager } from "../../../server/services/streaming/SSEStreamManager";
import { requiresUserApiKey } from "../../../server/utils/environmentPolicy.js";

function mockReqRes(body = {}, params = {}) {
  const req = { body, params } as any;
  let statusCode = 200;
  let jsonPayload: any;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      jsonPayload = payload;
      return this;
    },
  } as any;
  return { req, res, getStatus: () => statusCode, getJson: () => jsonPayload };
}

describe("streamController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requiresUserApiKey as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  // ---- prepareAnalysisStream ----
  describe("prepareAnalysisStream", () => {
    it("returns 400 when production requires API key and none provided", async () => {
      (requiresUserApiKey as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { req, res, getStatus, getJson } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(400);
      expect(getJson().error).toContain("API key");
    });

    it("returns 422 when taskId is missing", async () => {
      const { req, res, getStatus, getJson } = mockReqRes({
        modelKey: "gpt-4o",
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(422);
      expect(getJson().details).toContain(
        "taskId is required and must be a non-empty string.",
      );
    });

    it("returns 422 when modelKey is missing", async () => {
      const { req, res, getStatus, getJson } = mockReqRes({ taskId: "p1" });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(422);
      expect(getJson().details).toContain(
        "modelKey is required and must be a non-empty string.",
      );
    });

    it("returns sessionId on success", async () => {
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        expiresAt: Date.now() + 300000,
      });

      const { req, res, getStatus, getJson } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
        temperature: 0.5,
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(200);
      expect(getJson().sessionId).toBe("session-123");
      expect(getJson().expiresInSeconds).toBeGreaterThan(0);
      expect(analysisStreamService.savePendingPayload).toHaveBeenCalled();
    });

    it('allows API key bypass with "test" value in production', async () => {
      (requiresUserApiKey as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        expiresAt: Date.now() + 300000,
      });

      const { req, res, getStatus, getJson } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
        apiKey: "test",
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(200);
      expect(getJson().sessionId).toBe("session-123");
    });

    it("returns 500 on internal error", async () => {
      (
        analysisStreamService.savePendingPayload as ReturnType<typeof vi.fn>
      ).mockImplementation(() => {
        throw new Error("internal failure");
      });

      const { req, res, getStatus, getJson } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(500);
      expect(getJson().error).toContain("Failed to prepare");
    });

    it("parses boolean options correctly", async () => {
      (
        analysisStreamService.savePendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue("session-123");
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        expiresAt: Date.now() + 300000,
      });

      const { req, res, getStatus } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
        captureReasoning: "true",
        omitAnswer: false,
        retryMode: "yes",
        includeGridImages: "1",
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(200);
      const savedPayload = (
        analysisStreamService.savePendingPayload as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      expect(savedPayload.captureReasoning).toBe(true);
      expect(savedPayload.retryMode).toBe(true);
      expect(savedPayload.includeGridImages).toBe(true);
    });

    it("parses nested options and serviceOpts", async () => {
      (
        analysisStreamService.savePendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue("session-123");
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        expiresAt: Date.now() + 300000,
      });

      const { req, res, getStatus } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
        options: {
          emojiSetKey: "classic",
          temperature: 0.7,
          useStructuredOutput: true,
        },
        serviceOpts: {
          captureReasoning: true,
          reasoningEffort: "high",
          maxOutputTokens: 4096,
          store: false,
        },
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(200);
      const savedPayload = (
        analysisStreamService.savePendingPayload as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      expect(savedPayload.options.emojiSetKey).toBe("classic");
      expect(savedPayload.serviceOpts.reasoningEffort).toBe("high");
      expect(savedPayload.serviceOpts.maxOutputTokens).toBe(4096);
    });

    it("rejects invalid originalExplanation", async () => {
      const { req, res, getStatus, getJson } = mockReqRes({
        taskId: "p1",
        modelKey: "gpt-4o",
        originalExplanation: "not-json-string",
      });

      await streamController.prepareAnalysisStream(req, res);

      expect(getStatus()).toBe(422);
      expect(getJson().details).toContain(
        "originalExplanation must be a JSON object or JSON string.",
      );
    });
  });

  // ---- cancel ----
  describe("cancel", () => {
    it("returns 400 when sessionId is missing", async () => {
      const { req, res, getStatus, getJson } = mockReqRes({}, {});

      await streamController.cancel(req, res);

      expect(getStatus()).toBe(400);
      expect(getJson().error).toContain("Missing sessionId");
    });

    it("cancels session successfully", async () => {
      const { req, res, getJson } = mockReqRes({}, { sessionId: "s-1" });

      await streamController.cancel(req, res);

      expect(sseStreamManager.error).toHaveBeenCalledWith(
        "s-1",
        "CANCELLED_BY_USER",
        expect.any(String),
      );
      expect(sseStreamManager.close).toHaveBeenCalledWith(
        "s-1",
        expect.objectContaining({
          status: "aborted",
        }),
      );
      expect(analysisStreamService.clearPendingPayload).toHaveBeenCalledWith(
        "s-1",
      );
      expect(getJson().success).toBe(true);
      expect(getJson().data.status).toBe("cancelled");
    });

    it("returns 500 on cancel failure", async () => {
      (sseStreamManager.error as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("stream gone");
        },
      );

      const { req, res, getStatus, getJson } = mockReqRes(
        {},
        { sessionId: "s-1" },
      );

      await streamController.cancel(req, res);

      expect(getStatus()).toBe(500);
      expect(getJson().error).toContain("Failed to cancel");
    });
  });

  // ---- startAnalysisStream ----
  describe("startAnalysisStream", () => {
    it("returns 400 when params missing", async () => {
      const { req, res, getStatus, getJson } = mockReqRes({}, { taskId: "p1" });

      await streamController.startAnalysisStream(req, res);

      expect(getStatus()).toBe(400);
      expect(getJson().error).toContain("Missing");
    });

    it("returns 404 when no pending payload", async () => {
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue(undefined);

      const { req, res, getStatus, getJson } = mockReqRes(
        {},
        {
          taskId: "p1",
          modelKey: "gpt-4o",
          sessionId: "s-1",
        },
      );

      await streamController.startAnalysisStream(req, res);

      expect(getStatus()).toBe(404);
      expect(getJson().error).toContain("No pending");
    });

    it("returns 400 when session params mismatch", async () => {
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        taskId: "p2",
        modelKey: "gpt-4o",
      });

      const { req, res, getStatus, getJson } = mockReqRes(
        {},
        {
          taskId: "p1",
          modelKey: "gpt-4o",
          sessionId: "s-1",
        },
      );

      await streamController.startAnalysisStream(req, res);

      expect(getStatus()).toBe(400);
      expect(getJson().error).toContain("do not match");
      expect(analysisStreamService.clearPendingPayload).toHaveBeenCalledWith(
        "s-1",
      );
    });

    it("registers SSE connection and starts streaming", async () => {
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        taskId: "p1",
        modelKey: "gpt-4o",
        expiresAt: Date.now() + 300000,
      });

      const { req, res } = mockReqRes(
        {},
        {
          taskId: "p1",
          modelKey: "gpt-4o",
          sessionId: "s-1",
        },
      );

      await streamController.startAnalysisStream(req, res);

      expect(sseStreamManager.register).toHaveBeenCalledWith("s-1", res);
      expect(sseStreamManager.sendEvent).toHaveBeenCalledWith(
        "s-1",
        "stream.init",
        expect.objectContaining({
          sessionId: "s-1",
          taskId: "p1",
          modelKey: "gpt-4o",
        }),
      );
      expect(analysisStreamService.startStreaming).toHaveBeenCalled();
    });

    it("handles streaming init error gracefully", async () => {
      // Reset sseStreamManager.error to not throw (may have been set by cancel test)
      (sseStreamManager.error as ReturnType<typeof vi.fn>).mockImplementation(
        () => {},
      );
      (
        analysisStreamService.getPendingPayload as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        taskId: "p1",
        modelKey: "gpt-4o",
      });
      (
        analysisStreamService.startStreaming as ReturnType<typeof vi.fn>
      ).mockImplementation(() => {
        throw new Error("init failed");
      });

      const { req, res } = mockReqRes(
        {},
        {
          taskId: "p1",
          modelKey: "gpt-4o",
          sessionId: "s-1",
        },
      );

      await streamController.startAnalysisStream(req, res);

      expect(sseStreamManager.error).toHaveBeenCalledWith(
        "s-1",
        "STREAM_INIT_FAILED",
        expect.any(String),
      );
    });
  });
});
