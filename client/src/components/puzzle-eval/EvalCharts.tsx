/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Score-over-Steps line chart and Score-vs-Cost scatter chart for eval dashboard.
 *          Uses Recharts. Model colors: gemini=green, gpt=blue, claude=amber, kimi=purple.
 * SRP/DRY check: Pass
 */

import React, { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ZAxis,
} from "recharts";
import type { StepEvent } from "@/hooks/useEvalProgress";
import type { EvalRunRow } from "@/hooks/useEvalRuns";

/** Union of SSE event types used by ScoreOverStepsChart */
type EvalEvent = StepEvent & { score_pct: number };

/** Run progress shape from live streaming */
interface RunProgress {
  model: string;
  finalScore?: number;
  costUsd?: number;
  gameId?: string;
  runNumber?: number;
}

/* ------------------------------------------------------------------ */
/*  Model colors                                                       */
/* ------------------------------------------------------------------ */

const MODEL_COLORS: Record<string, string> = {
  gemini: "#22C55E",
  gpt: "#3B82F6",
  claude: "#F59E0B",
  kimi: "#A855F7",
};

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return "#6B7280";
}

/* ------------------------------------------------------------------ */
/*  Score over Steps                                                   */
/* ------------------------------------------------------------------ */

interface ScoreOverStepsProps {
  events: EvalEvent[];
  height?: number;
}

export const ScoreOverStepsChart: React.FC<ScoreOverStepsProps> = ({
  events,
  height = 280,
}) => {
  const { data, models } = useMemo(() => {
    const stepEvents = events.filter((e): e is EvalEvent => e.type === "step");
    const modelSet = new Set<string>();
    // Group by step, aggregate per model (avg score at each step across runs)
    const byStep: Record<
      number,
      Record<string, { sum: number; count: number }>
    > = {};

    for (const e of stepEvents) {
      modelSet.add(e.model);
      if (!byStep[e.step]) byStep[e.step] = {};
      if (!byStep[e.step][e.model])
        byStep[e.step][e.model] = { sum: 0, count: 0 };
      byStep[e.step][e.model].sum += e.score_pct;
      byStep[e.step][e.model].count += 1;
    }

    const models = Array.from(modelSet).sort();
    const data = Object.entries(byStep)
      .map(([step, vals]) => {
        const row: Record<string, number> = { step: Number(step) };
        for (const m of models) {
          row[m] = vals[m]
            ? Math.round((vals[m].sum / vals[m].count) * 100) / 100
            : 0;
        }
        return row;
      })
      .sort((a, b) => a.step - b.step);

    return { data, models };
  }, [events]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-[11px] font-mono text-gray-600">
        No step data yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
        <XAxis
          dataKey="step"
          tick={{ fontSize: 10, fill: "#6B7280" }}
          stroke="#374151"
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#6B7280" }}
          stroke="#374151"
          domain={[0, 100]}
          unit="%"
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#111827",
            border: "1px solid #374151",
            borderRadius: "6px",
            fontSize: 11,
            fontFamily: "monospace",
          }}
          labelStyle={{ color: "#9CA3AF" }}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace" }} />
        {models.map((m) => (
          <Line
            key={m}
            type="monotone"
            dataKey={m}
            stroke={getModelColor(m)}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
};

/* ------------------------------------------------------------------ */
/*  Score vs Cost                                                      */
/* ------------------------------------------------------------------ */

interface ScoreVsCostProps {
  runs: EvalRunRow[] | RunProgress[];
  height?: number;
}

export const ScoreVsCostChart: React.FC<ScoreVsCostProps> = ({
  runs,
  height = 280,
}) => {
  const { data, models } = useMemo(() => {
    const modelSet = new Set<string>();
    const points: Array<{
      model: string;
      score: number;
      cost: number;
      game: string;
      run: number;
    }> = [];

    for (const r of runs) {
      const model = "model" in r ? r.model : "";
      const score =
        "finalScore" in r
          ? (r.finalScore ?? 0) * 100
          : ((r as EvalRunRow).final_score ?? 0) * 100;
      const cost =
        "costUsd" in r
          ? typeof r.costUsd === "number"
            ? r.costUsd
            : Number(r.costUsd) || 0
          : ((r as EvalRunRow).cost_usd ?? 0);
      const game =
        "gameId" in r ? (r as any).gameId : (r as EvalRunRow).game_id || "";
      const run =
        "runNumber" in r
          ? (r as any).runNumber
          : (r as EvalRunRow).run_number || 0;

      if (model) {
        modelSet.add(model);
        points.push({ model, score, cost, game, run });
      }
    }

    const models = Array.from(modelSet).sort();
    const byModel: Record<string, typeof points> = {};
    for (const m of models) byModel[m] = points.filter((p) => p.model === m);

    return { data: byModel, models };
  }, [runs]);

  if (models.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-[11px] font-mono text-gray-600">
        No run data yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
        <XAxis
          dataKey="cost"
          name="Cost"
          unit="$"
          tick={{ fontSize: 10, fill: "#6B7280" }}
          stroke="#374151"
          type="number"
        />
        <YAxis
          dataKey="score"
          name="Score"
          unit="%"
          tick={{ fontSize: 10, fill: "#6B7280" }}
          stroke="#374151"
          domain={[0, 100]}
        />
        <ZAxis range={[40, 200]} />
        <Tooltip
          contentStyle={{
            backgroundColor: "#111827",
            border: "1px solid #374151",
            borderRadius: "6px",
            fontSize: 11,
            fontFamily: "monospace",
          }}
          formatter={(val: number, name: string) => {
            if (name === "Cost") return [`$${val.toFixed(4)}`, name];
            return [`${val.toFixed(1)}%`, name];
          }}
        />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace" }} />
        {models.map((m) => (
          <Scatter key={m} name={m} data={data[m]} fill={getModelColor(m)} />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
};
