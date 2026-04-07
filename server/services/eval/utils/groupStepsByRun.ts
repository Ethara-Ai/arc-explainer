

import { readFileSync, writeFileSync, existsSync } from "fs";

export interface GroupedRun {
  run_id: string;
  model: unknown;
  game_id: unknown;
  game_type: unknown;
  run_number: unknown;
  total_steps: number;
  final_score: unknown;
  solved: boolean;
  levels_completed: unknown;
  total_levels: unknown;
  cost_usd: unknown;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  steps: Record<string, unknown>[];
}

export function groupStepsByRun(inputPath: string, outputPath: string): GroupedRun[] {
  if (!existsSync(inputPath)) {
    return [];
  }

  const raw = readFileSync(inputPath, "utf-8");
  const inputLines = raw.trim().split("\n").filter(Boolean);

  if (inputLines.length === 0) return [];

  const grouped = new Map<string, Record<string, unknown>[]>();

  for (const line of inputLines) {
    const step = JSON.parse(line) as Record<string, unknown>;
    const runId = step.run_id as string;
    if (!grouped.has(runId)) grouped.set(runId, []);
    grouped.get(runId)!.push(step);
  }

  const outputLines: string[] = [];
  const results: GroupedRun[] = [];

  for (const [runId, steps] of grouped) {
    steps.sort((a, b) => (a.step as number) - (b.step as number));

    const first = steps[0]!;
    const last = steps[steps.length - 1]!;

    const runLine: GroupedRun = {
      run_id: runId,
      model: first.model,
      game_id: first.game_id,
      game_type: first.game_type,
      run_number: first.run_number,
      total_steps: steps.length,
      final_score: last.score,
      solved: last.state === "WIN",
      levels_completed: last.level,
      total_levels: last.total_levels,
      cost_usd: last.cumulative_cost_usd,
      total_input_tokens: steps.reduce((s, r) => s + (r.input_tokens as number), 0),
      total_output_tokens: steps.reduce((s, r) => s + (r.output_tokens as number), 0),
      total_reasoning_tokens: steps.reduce((s, r) => s + ((r.reasoning_tokens as number) ?? 0), 0),
      steps,
    };

    outputLines.push(JSON.stringify(runLine));
    results.push(runLine);
  }

  writeFileSync(outputPath, outputLines.join("\n") + "\n", "utf-8");

  return results;
}
