import type { ProviderMessage, ContextManagerConfig } from "@shared/eval-types";
import { logger } from "../../../utils/logger";

// Token estimation uses a conservative ratio for ARC content.
// Grid data (numbers, brackets, commas) tokenizes at ~1.0-1.5 chars/token;
// natural language at ~3.5 chars/token. Using 1.2 errs on the side of
// overestimating tokens, which keeps us safely within provider limits.
const CHARS_PER_TOKEN = 1.2;
// Use only 90% of budget to account for estimation error and provider overhead.
const BUDGET_SAFETY_FACTOR = 0.9;

// Maximum messages to retain in fullHistory. Beyond the sliding window,
// older messages are only needed for post-run logging/analytics. Capping
// prevents unbounded memory growth on 200+ step runs (each step adds 2-3 msgs).
const MAX_HISTORY_MESSAGES = 2000;

/**
 * Estimate token count from text length.
 * Uses a blended ratio for ARC grid data + natural language mix.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Manages conversation history with sliding window and token-aware trimming.
 * Preserves recent history for logging while limiting LLM context to a window.
 *
 * Memory management: fullHistory is capped at MAX_HISTORY_MESSAGES to prevent
 * unbounded growth. Messages beyond the cap are discarded (oldest first).
 * The sliding window for LLM context is always within the retained history.
 */
export class ContextManager {
  private readonly windowSize: number;
  private readonly logger?: (
    level: "info" | "warn" | "debug",
    message: string,
  ) => void;
  private fullHistory: ProviderMessage[] = [];
  private totalAdded = 0;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.windowSize = config?.windowSize ?? 10;
    this.logger = config?.logger;
  }

  /**
   * Record a conversation turn (user or assistant).
   * Trims oldest messages when history exceeds MAX_HISTORY_MESSAGES.
   */
  addTurn(role: "user" | "assistant", content: string): void {
    this.fullHistory.push({ role, content });
    this.totalAdded++;

    // Cap history to prevent unbounded memory growth
    if (this.fullHistory.length > MAX_HISTORY_MESSAGES) {
      // Drop oldest messages in pairs (user+assistant turns)
      const excess = this.fullHistory.length - MAX_HISTORY_MESSAGES;
      // Round up to even number to keep turn pairs aligned
      const dropCount = excess + (excess % 2);
      this.fullHistory.splice(0, dropCount);
    }
  }

  /**
   * Return the last N messages for LLM consumption.
   * N is determined by windowSize (typically 10 turns = 20 messages).
   */
  getContext(): ProviderMessage[] {
    return this.fullHistory.slice(-this.windowSize);
  }

  /**
   * Return conversation history trimmed to fit within a token budget.
   * Starts with the full sliding window and drops oldest turn pairs
   * (user + assistant) until estimated tokens fit under budget.
   *
   * @param tokenBudget Maximum tokens available for conversation history
   * @param systemPrompt System prompt (fixed cost, not trimmed)
   * @param currentObservation Current game observation (fixed cost, not trimmed)
   * @returns Trimmed conversation history that fits within budget
   */
  getContextWithinBudget(
    tokenBudget: number,
    systemPrompt: string,
    currentObservation: string,
  ): ProviderMessage[] {
    const window = this.getContext();
    const safeBudget = Math.floor(tokenBudget * BUDGET_SAFETY_FACTOR);
    const fixedTokens =
      estimateTokens(systemPrompt) + estimateTokens(currentObservation);

    let historyTokens = window.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );
    let total = fixedTokens + historyTokens;

    if (total <= safeBudget) {
      return window;
    }

    // Trim: drop oldest turn pairs (2 messages = 1 game turn)
    const trimmed = [...window];
    const originalLen = trimmed.length;

    while (total > safeBudget && trimmed.length >= 2) {
      const droppedTokens =
        estimateTokens(trimmed[0].content) + estimateTokens(trimmed[1].content);
      trimmed.splice(0, 2);
      total -= droppedTokens;
    }

    const turnsDropped = (originalLen - trimmed.length) / 2;
    if (turnsDropped > 0) {
      const trimMsg =
        `[ContextManager] Token budget trim: dropped ${turnsDropped} oldest turns ` +
        `(${originalLen} -> ${trimmed.length} messages, ~${total} tokens)`;
      if (this.logger) {
        this.logger("info", trimMsg);
      } else {
        logger.info(trimMsg, 'eval-context');
      }
    }

    return trimmed;
  }

  /**
   * Total turns ever added (including those pruned from history).
   */
  get totalTurns(): number {
    return this.totalAdded;
  }

  /**
   * Current number of messages retained in history.
   */
  get retainedMessages(): number {
    return this.fullHistory.length;
  }

  /**
   * Clear all conversation history.
   */
  clear(): void {
    this.fullHistory = [];
    this.totalAdded = 0;
  }
}
