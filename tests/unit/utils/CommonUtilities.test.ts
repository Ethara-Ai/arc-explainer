import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../server/utils/logger.ts", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../server/utils/JsonParser.js", () => ({
  jsonParser: {
    parse: vi.fn().mockReturnValue({ success: true, data: {} }),
  },
}));

import {
  safeJsonParse,
  safeJsonStringify,
  normalizeConfidence,
  processHints,
  normalizeTemperature,
  normalizeTokenCount,
  normalizeCost,
  cleanString,
  normalizeProcessingTime,
  isNonEmptyArray,
  isValidObject,
  getTimestamp,
  formatBytes,
  sanitizeGridData,
  sanitizeMultipleGrids,
  debounce,
} from "../../../server/utils/CommonUtilities";

import { jsonParser } from "../../../server/utils/JsonParser.js";

describe("CommonUtilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- safeJsonParse ---
  describe("safeJsonParse", () => {
    it("returns fallback for null", () => {
      expect(safeJsonParse(null)).toBeNull();
    });

    it("returns fallback for undefined", () => {
      expect(safeJsonParse(undefined)).toBeNull();
    });

    it("returns object as-is", () => {
      const obj = { a: 1 };
      expect(safeJsonParse(obj)).toBe(obj);
    });

    it("returns fallback for empty string", () => {
      expect(safeJsonParse("")).toBeNull();
    });

    it("parses valid JSON string", () => {
      (jsonParser.parse as ReturnType<typeof vi.fn>).mockReturnValue({
        success: true,
        data: { key: "val" },
      });
      expect(safeJsonParse('{"key":"val"}')).toEqual({ key: "val" });
    });

    it("returns fallback on parse failure", () => {
      (jsonParser.parse as ReturnType<typeof vi.fn>).mockReturnValue({
        success: false,
        error: "bad json",
      });
      expect(safeJsonParse("not-json")).toBeNull();
    });

    it("uses custom fallback", () => {
      expect(safeJsonParse(null, undefined, "default")).toBe("default");
    });
  });

  // --- safeJsonStringify ---
  describe("safeJsonStringify", () => {
    it("stringifies object", () => {
      expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
    });

    it("returns null on circular ref", () => {
      const obj: any = {};
      obj.self = obj;
      expect(safeJsonStringify(obj)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(safeJsonStringify(undefined)).toBeNull();
    });
  });

  // --- normalizeConfidence ---
  // Returns 0-100 integer scale, rounds to nearest int
  describe("normalizeConfidence", () => {
    it("scales fractional 0.75 to 75", () => {
      expect(normalizeConfidence(0.75)).toBe(75);
    });

    it("clamps above 100 to 100", () => {
      expect(normalizeConfidence(150)).toBe(100);
    });

    it("clamps below 0 to 0", () => {
      expect(normalizeConfidence(-0.5)).toBe(0);
    });

    it("parses string fraction to percentage", () => {
      expect(normalizeConfidence("0.5")).toBe(50);
    });

    it("returns 50 for non-numeric string", () => {
      expect(normalizeConfidence("not-a-number")).toBe(50);
    });

    it("returns 50 for null (default)", () => {
      expect(normalizeConfidence(null)).toBe(50);
    });

    it("keeps 75 as 75", () => {
      expect(normalizeConfidence(75)).toBe(75);
    });
  });

  // --- processHints ---
  describe("processHints", () => {
    it("returns empty array for null", () => {
      expect(processHints(null)).toEqual([]);
    });

    it("wraps single string in array", () => {
      expect(processHints("hint one")).toEqual(["hint one"]);
    });

    it("returns string array as-is", () => {
      expect(processHints(["a", "b"])).toEqual(["a", "b"]);
    });

    it("parses JSON string array", () => {
      (jsonParser.parse as ReturnType<typeof vi.fn>).mockReturnValue({
        success: true,
        data: ["h1", "h2"],
      });
      expect(processHints('["h1","h2"]')).toEqual(["h1", "h2"]);
    });

    it("converts number to string hint", () => {
      expect(processHints(123)).toEqual(["123"]);
    });
  });

  // --- normalizeTemperature ---
  describe("normalizeTemperature", () => {
    it("returns valid temperature", () => {
      expect(normalizeTemperature(0.5)).toBe(0.5);
    });

    it("returns null for null", () => {
      expect(normalizeTemperature(null)).toBeNull();
    });

    it("parses string", () => {
      expect(normalizeTemperature("0.8")).toBe(0.8);
    });

    it("returns null for NaN", () => {
      expect(normalizeTemperature("abc")).toBeNull();
    });
  });

  // --- normalizeTokenCount ---
  describe("normalizeTokenCount", () => {
    it("returns valid token count", () => {
      expect(normalizeTokenCount(1000)).toBe(1000);
    });

    it("returns null for negative", () => {
      expect(normalizeTokenCount(-1)).toBeNull();
    });

    it("returns null for null", () => {
      expect(normalizeTokenCount(null)).toBeNull();
    });

    it("accepts non-integer", () => {
      expect(normalizeTokenCount(10.7)).toBe(10.7);
    });
  });

  // --- normalizeCost ---
  describe("normalizeCost", () => {
    it("returns valid cost", () => {
      expect(normalizeCost(0.05)).toBe(0.05);
    });

    it("returns null for negative", () => {
      expect(normalizeCost(-1)).toBeNull();
    });

    it("returns null for NaN string", () => {
      expect(normalizeCost("abc")).toBeNull();
    });
  });

  // --- cleanString ---
  describe("cleanString", () => {
    it("returns trimmed string", () => {
      expect(cleanString("  hello  ")).toBe("hello");
    });

    it("truncates at maxLength", () => {
      expect(cleanString("abcdef", 3)).toBe("abc");
    });

    it("returns null for null", () => {
      expect(cleanString(null)).toBeNull();
    });

    it("converts non-string to string", () => {
      expect(cleanString(123)).toBe("123");
    });

    it("returns null for empty string", () => {
      expect(cleanString("")).toBeNull();
    });
  });

  // --- normalizeProcessingTime ---
  describe("normalizeProcessingTime", () => {
    it("returns valid time", () => {
      expect(normalizeProcessingTime(500)).toBe(500);
    });

    it("returns null for negative", () => {
      expect(normalizeProcessingTime(-10)).toBeNull();
    });

    it("returns null for null", () => {
      expect(normalizeProcessingTime(null)).toBeNull();
    });
  });

  // --- isNonEmptyArray ---
  describe("isNonEmptyArray", () => {
    it("returns true for non-empty array", () => {
      expect(isNonEmptyArray([1])).toBe(true);
    });

    it("returns false for empty array", () => {
      expect(isNonEmptyArray([])).toBe(false);
    });

    it("returns false for non-array", () => {
      expect(isNonEmptyArray("abc")).toBe(false);
    });
  });

  // --- isValidObject ---
  describe("isValidObject", () => {
    it("returns true for plain object", () => {
      expect(isValidObject({ a: 1 })).toBe(true);
    });

    it("returns false for null", () => {
      expect(isValidObject(null)).toBe(false);
    });

    it("returns false for array", () => {
      expect(isValidObject([1, 2])).toBe(false);
    });
  });

  // --- getTimestamp ---
  describe("getTimestamp", () => {
    it("returns ISO string", () => {
      const ts = getTimestamp();
      expect(() => new Date(ts)).not.toThrow();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // --- formatBytes ---
  describe("formatBytes", () => {
    it("formats 0 bytes", () => {
      expect(formatBytes(0)).toBe("0 Bytes");
    });

    it("formats bytes", () => {
      expect(formatBytes(500)).toBe("500 Bytes");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1024)).toBe("1 KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(1048576)).toBe("1 MB");
    });

    it("formats gigabytes", () => {
      expect(formatBytes(1073741824)).toBe("1 GB");
    });
  });

  // --- sanitizeGridData ---
  describe("sanitizeGridData", () => {
    it("returns valid grid", () => {
      const grid = [
        [1, 2],
        [3, 4],
      ];
      expect(sanitizeGridData(grid)).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it("returns null for null input", () => {
      expect(sanitizeGridData(null)).toBeNull();
    });

    it("returns null for non-array", () => {
      expect(sanitizeGridData("not-a-grid")).toBeNull();
    });

    it("returns null for empty array", () => {
      expect(sanitizeGridData([])).toBeNull();
    });

    it("handles string values by parsing to int", () => {
      const result = sanitizeGridData([
        ["1", "2"],
        ["3", "4"],
      ]);
      expect(result).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it("replaces NaN with 0", () => {
      const result = sanitizeGridData([
        ["abc", 2],
        [3, null],
      ]);
      expect(result).toEqual([
        [0, 2],
        [3, 0],
      ]);
    });

    it("clamps negative values to 0", () => {
      const result = sanitizeGridData([[-1, 2]]);
      expect(result).toEqual([[0, 2]]);
    });

    it("clamps values above 9 to 9", () => {
      const result = sanitizeGridData([[15, 5]]);
      expect(result).toEqual([[9, 5]]);
    });
  });

  // --- sanitizeMultipleGrids ---
  describe("sanitizeMultipleGrids", () => {
    it("returns array of sanitized grids", () => {
      const grids = [[[1, 2]], [[3, 4]]];
      expect(sanitizeMultipleGrids(grids)).toEqual([[[1, 2]], [[3, 4]]]);
    });

    it("returns null for null input", () => {
      expect(sanitizeMultipleGrids(null)).toBeNull();
    });

    it("returns null for non-array", () => {
      expect(sanitizeMultipleGrids("not-grids")).toBeNull();
    });
  });

  // --- debounce ---
  describe("debounce", () => {
    it("delays function execution", () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("only calls once for rapid invocations", () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced();
      debounced();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
