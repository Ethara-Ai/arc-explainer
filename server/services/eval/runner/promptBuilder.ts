

import type { GameType } from "@shared/eval-types";

const systemPromptCache = new Map<string, string>();

export function buildSystemPrompt(
  gameType: GameType,
  maxSteps: number = 200,
  contextWindow: number = 50,
  withImages: boolean = false,
): string {
  const cacheKey = `${gameType}:${maxSteps}:${contextWindow}:${withImages}`;
  const cached = systemPromptCache.get(cacheKey);
  if (cached) return cached;

  let prompt: string;
  if (gameType === "arc3") {
    prompt = buildArc3SystemPrompt(maxSteps, contextWindow, withImages);
  } else if (gameType === "arc2") {
    prompt = buildArc2SystemPrompt(maxSteps, contextWindow);
  } else {
    throw new Error(
      `Unknown gameType: "${gameType}". Expected 'arc2' or 'arc3'.`,
    );
  }

  systemPromptCache.set(cacheKey, prompt);
  return prompt;
}

export function buildTurnPrompt(
  observation: string,
  availableActions: string[],
  notepad: string,
  step: number,
  maxSteps: number,
): string {
  // Cap display to 30 actions to avoid huge lists
  let actionsStr = availableActions.slice(0, 30).join(", ");
  if (availableActions.length > 30) {
    actionsStr += ` ... (${availableActions.length} total)`;
  }

  const notepadDisplay = notepad.trim() ? notepad : "(empty)";

  return `=== STEP ${step + 1}/${maxSteps} ===

${observation}

Available actions: ${actionsStr}

=== YOUR NOTEPAD ===
${notepadDisplay}

Choose your next action. Respond with JSON:
{"action": "<action>", "reasoning": "<why>", "notepad_update": "<updated notepad>"}`;
}

function buildArc3SystemPrompt(
  maxSteps: number,
  contextWindow: number,
  withImages: boolean,
): string {
  const imageLine = withImages
    ? "\n- A screenshot image of the game board"
    : "";
  return `You are an abstract reasoning agent that is attempting to solve turn-based interactive environments. All games have simple abtract graphics and problems that can be  solved using nothing but core knowledge.

== HOW TO PLAY ==
Each turn you will see:
- The current game grid ${imageLine}
- Available actions
- Your notepad (persistent notes)

Check "Available actions" for available actions each turn.

CRITICAL RULES:
1. You MUST choose one action from the list.
2. Do NOT use any actions that are not in the list.
3. If the desired action doesn't map perfectly, choose the closest matching action.
4. For click, format as: "click 10 15" (with x y coordinates).
5. You MUST respond in English only. All fields ("reasoning", "notepad_update", etc.) must be written in English.

Respond with JSON:
{"action": "<action>", "reasoning": "<brief explanation>", "notepad_update": "<updated notepad>"}

== NOTEPAD ==
- Use your notepad to record discovered rules, patterns, and strategies.
- The notepad persists across all turns even when old conversation is forgotten.
- You MUST always include "notepad_update" in your response. Repeat current contents to keep unchanged.
- Max 8000 characters.`;
}

function buildArc2SystemPrompt(
  maxSteps: number,
  contextWindow: number,
): string {
  return `You are an AI agent solving an ARC-AGI-2 pattern recognition task.
You are shown training examples (input -> output grid pairs) and must figure out
the transformation rule, then apply it to build the correct test output grid.

== HOW IT WORKS ==
Each turn you will see:
- Training examples: input grids and their correct output grids
- The test input grid
- Your current output grid (which you are building)
- Available actions
- Your notepad

Actions:
  SET_CELL <color> - Set the cell at cursor position to color (0-9), advance cursor
  SET_ROW <c1> <c2> ... - Set entire current row to the given colors
  MOVE_UP, MOVE_DOWN, MOVE_LEFT, MOVE_RIGHT - Move cursor
  SUBMIT - Finalize your answer and get scored
  RESET_GRID - Clear your output grid back to zeros

Respond with JSON:
{"action": "<action>", "reasoning": "<brief explanation>", "notepad_update": "<updated notepad>"}

CRITICAL: You MUST respond in English only. All fields ("reasoning", "notepad_update", etc.) must be written in English.

== GRID COLORS ==
0=black, 1=blue, 2=red, 3=green, 4=yellow, 5=gray, 6=pink, 7=orange, 8=light blue, 9=dark red

== SCORING ==
- Score = cells correct / total cells (computed continuously as you build).
- SUBMIT finalizes your answer. You WIN if score = 100%, otherwise GAME OVER.
- You have a maximum of ${maxSteps} actions.
- You can only see your last ${contextWindow} turns of conversation.

== NOTEPAD ==
- Use your notepad to record the transformation rule you discover.
- The notepad persists across all turns even when old conversation is forgotten.
- You MUST always include "notepad_update" in your response.
- Max 8000 characters.

== STRATEGY ==
- Study ALL training examples carefully before placing any cells.
- Identify the transformation rule: how does each input become its output?
- Record the rule in your notepad.
- Apply the rule to the test input to determine what the output should be.
- Use SET_ROW for efficiency when you know an entire row.
- Only SUBMIT when you are confident in your answer.`;
}
