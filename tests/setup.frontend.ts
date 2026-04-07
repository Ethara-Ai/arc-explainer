/**
 * Author: Claude Sonnet 4.5
 * Date: 2026-01-04
 * PURPOSE: Setup file for frontend tests with React Testing Library
 *          Configures matchers and cleanup behavior
 * SRP/DRY check: Pass - Centralized test setup for all frontend tests
 */

import { expect, afterEach } from "vitest";
// @ts-expect-error -- @testing-library/react not installed in main tsconfig
import { cleanup } from "@testing-library/react";
// @ts-expect-error -- @testing-library/jest-dom not installed in main tsconfig
import * as matchers from "@testing-library/jest-dom/matchers";

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Cleanup after each test automatically
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia (commonly needed for responsive components)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // deprecated
    removeListener: () => {}, // deprecated
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }),
});

// Mock IntersectionObserver (needed for lazy-loading components)
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
} as any;
