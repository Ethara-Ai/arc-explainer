/*
Author: Sisyphus (Claude)
Date: 2026-04-07
PURPOSE: SDK-native callModelInputFilter that enforces a sliding context window
         on AgentInputItem[] to prevent context overflow on long ARC game sessions.
SRP/DRY check: Pass — single-purpose filter; no duplication with eval ContextManager (different item types).
*/

import type { AgentInputItem } from "@openai/agents";
import type { CallModelInputFilter } from "@openai/agents-core";
import { logger } from "../../../utils/logger.ts";

const DEFAULT_CONTEXT_WINDOW = 50;
const ITEMS_PER_TURN_MULTIPLIER = 4;

/**
 * Creates a callModelInputFilter that enforces a sliding context window.
 *
 * The filter keeps the first item (initial prompt) plus the last N items,
 * where N = contextWindow × ITEMS_PER_TURN_MULTIPLIER. After slicing, it
 * drops any orphaned function_call_result items whose matching function_call
 * was truncated.
 *
 * @param contextWindow - Number of "turns" to keep visible (default 50).
 *                        Each turn produces ~4 AgentInputItems on average
 *                        (reasoning + message + function_call + function_call_result).
 */
export function createContextWindowFilter(
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): CallModelInputFilter {
  const maxItems = contextWindow * ITEMS_PER_TURN_MULTIPLIER;

  return ({ modelData }) => {
    const { input, instructions } = modelData;

    if (input.length <= maxItems) {
      return modelData;
    }

    const firstItem = input[0];
    const tail = input.slice(-(maxItems - 1));
    const sliced = [firstItem, ...tail];

    const cleaned = dropOrphanedToolResults(sliced);

    logger.info(
      `[ContextWindowFilter] Truncated: ${input.length} → ${cleaned.length} items ` +
        `(window=${contextWindow} turns, maxItems=${maxItems}, orphans dropped=${sliced.length - cleaned.length})`,
      "arc3-agentsdk",
    );

    return { input: cleaned, instructions };
  };
}

function dropOrphanedToolResults(items: AgentInputItem[]): AgentInputItem[] {
  const callIds = new Set<string>();

  for (const item of items) {
    if (item.type === "function_call" && "callId" in item) {
      callIds.add((item as { callId: string }).callId);
    }
  }

  const result: AgentInputItem[] = [];
  let droppedCount = 0;

  for (const item of items) {
    if (item.type === "function_call_result" && "callId" in item) {
      const callId = (item as { callId: string }).callId;
      if (!callIds.has(callId)) {
        droppedCount++;
        continue;
      }
    }
    result.push(item);
  }

  if (droppedCount > 0) {
    logger.info(
      `[ContextWindowFilter] Dropped ${droppedCount} orphaned function_call_result item(s)`,
      "arc3-agentsdk",
    );
  }

  return result;
}
