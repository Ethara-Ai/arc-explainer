import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AppError,
  errorHandler,
} from "../../../server/middleware/errorHandler";
import type { Request, Response, NextFunction } from "express";

function mockReqRes(url = "/api/test", method = "GET") {
  const req = { url, method } as Request;
  let statusCode = 200;
  let jsonPayload: any;
  const res = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      jsonPayload = payload;
      return this;
    },
    end: vi.fn(),
  } as any;
  const next = vi.fn() as NextFunction;
  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getJson: () => jsonPayload,
  };
}

describe("errorHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("AppError", () => {
    it("defaults to 500 status", () => {
      const err = new AppError("Something failed");
      expect(err.statusCode).toBe(500);
      expect(err.message).toBe("Something failed");
      expect(err.errorCode).toBeUndefined();
    });

    it("accepts custom status code and error code", () => {
      const err = new AppError("Not found", 404, "RESOURCE_NOT_FOUND");
      expect(err.statusCode).toBe(404);
      expect(err.errorCode).toBe("RESOURCE_NOT_FOUND");
    });

    it("extends Error", () => {
      const err = new AppError("test");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("middleware", () => {
    it("logs structured error details", () => {
      const { req, res, next } = mockReqRes("/api/puzzles", "POST");
      const error = new Error("db connection lost");

      errorHandler(error, req, res, next);

      expect(console.error).toHaveBeenCalledWith(
        "Request failed:",
        expect.objectContaining({
          url: "/api/puzzles",
          method: "POST",
          error: "db connection lost",
          statusCode: 500,
        }),
      );
    });

    it("calls res.end() when headers already sent", () => {
      const { req, res, next } = mockReqRes();
      res.headersSent = true;
      const error = new Error("late error");

      errorHandler(error, req, res, next);

      expect(res.end).toHaveBeenCalled();
    });

    it("handles AppError with custom status and error code", () => {
      const { req, res, next, getStatus, getJson } = mockReqRes();
      const error = new AppError("Item not found", 404, "ITEM_NOT_FOUND");

      errorHandler(error, req, res, next);

      expect(getStatus()).toBe(404);
      expect(getJson()).toEqual({
        success: false,
        error: "ITEM_NOT_FOUND",
        message: "Item not found",
      });
    });

    it("uses APPLICATION_ERROR when AppError has no errorCode", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = new AppError("Generic app error", 422);

      errorHandler(error, req, res, next);

      expect(getJson().error).toBe("APPLICATION_ERROR");
    });

    it("handles AI provider errors with MODEL_UNAVAILABLE", () => {
      const { req, res, next, getStatus, getJson } = mockReqRes();
      const error = Object.assign(new Error("Rate limited"), {
        statusCode: 429,
        provider: "openai",
        modelKey: "gpt-4o",
      });

      errorHandler(error, req, res, next);

      expect(getStatus()).toBe(429);
      expect(getJson()).toEqual({
        success: false,
        error: "MODEL_UNAVAILABLE",
        message: "Rate limited",
        provider: "openai",
        modelKey: "gpt-4o",
        retryable: true,
      });
    });

    it("marks 500+ errors as retryable for provider errors", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = Object.assign(new Error("Server error"), {
        statusCode: 503,
        provider: "anthropic",
        modelKey: "claude-3",
      });

      errorHandler(error, req, res, next);

      expect(getJson().retryable).toBe(true);
    });

    it("marks 400 errors as not retryable for provider errors", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = Object.assign(new Error("Bad request"), {
        statusCode: 400,
        provider: "gemini",
        modelKey: "gemini-pro",
      });

      errorHandler(error, req, res, next);

      expect(getJson().retryable).toBe(false);
    });

    it("returns BAD_REQUEST for 400 status", () => {
      const { req, res, next, getStatus, getJson } = mockReqRes();
      const error = Object.assign(new Error("bad"), { statusCode: 400 });

      errorHandler(error, req, res, next);

      expect(getStatus()).toBe(400);
      expect(getJson().error).toBe("BAD_REQUEST");
    });

    it("returns NOT_FOUND for 404 status", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = Object.assign(new Error("not found"), { statusCode: 404 });

      errorHandler(error, req, res, next);

      expect(getJson().error).toBe("NOT_FOUND");
    });

    it("returns RATE_LIMITED for 429 status", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = Object.assign(new Error("rate limited"), {
        statusCode: 429,
      });

      errorHandler(error, req, res, next);

      expect(getJson().error).toBe("RATE_LIMITED");
    });

    it("returns SERVICE_UNAVAILABLE for 500+ status", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = Object.assign(new Error("down"), { statusCode: 502 });

      errorHandler(error, req, res, next);

      expect(getJson().error).toBe("SERVICE_UNAVAILABLE");
    });

    it("returns SERVICE_UNAVAILABLE for plain Error (defaults to 500)", () => {
      const { req, res, next, getJson } = mockReqRes();
      const error = new Error("unknown");

      errorHandler(error, req, res, next);

      // Plain Error has no statusCode, defaults to 500 which is in the >= 500 range
      expect(getJson().error).toBe("SERVICE_UNAVAILABLE");
    });
  });
});
