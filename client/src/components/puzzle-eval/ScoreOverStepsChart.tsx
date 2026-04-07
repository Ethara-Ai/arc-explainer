

import {
  LineChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

const MODEL_COLORS: Record<string, string> = {
  "Gemini 3.1": "#4A7C59",
  "GPT 5.4 Thinking": "#5B8BA0",
  "Claude Opus 4.6": "#C97B5D",
  "Kimi k2.5": "#7E5F9A",
};

export interface StepRaw {
  run_id: string;
  model: string;
  step: number;
  score: number;
}

interface ScoreOverStepsChartProps {
  steps: StepRaw[];
}

/** Aggregate raw step data into per-step mean/min/max per model. */
function aggregateSteps(steps: StepRaw[]) {
  const models = [...new Set(steps.map((s) => s.model))];
  const maxStep = Math.max(...steps.map((s) => s.step), 0);

  // Group by (model, step) -> list of scores
  const grouped: Record<string, Record<number, number[]>> = {};
  for (const m of models) grouped[m] = {};
  for (const s of steps) {
    if (!grouped[s.model][s.step]) grouped[s.model][s.step] = [];
    grouped[s.model][s.step].push(s.score * 100);
  }

  const data: Record<string, number | undefined>[] = [];
  for (let step = 0; step <= maxStep; step++) {
    const point: Record<string, number | undefined> = { step };
    for (const m of models) {
      const scores = grouped[m][step];
      if (scores && scores.length > 0) {
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        const key = m.replace(/\s+/g, "_");
        point[`${key}_mean`] = Math.round(mean * 100) / 100;
        point[`${key}_min`] = Math.round(min * 100) / 100;
        point[`${key}_max`] = Math.round(max * 100) / 100;
      }
    }
    data.push(point);
  }

  return { data, models };
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const meanEntries = payload.filter((p) => p.name.endsWith("_mean"));
  return (
    <div className="bg-background border border-border rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold mb-1">Step {label}</p>
      {meanEntries.map((entry) => {
        const modelName = entry.name.replace(/_mean$/, "").replace(/_/g, " ");
        return (
          <p
            key={entry.name}
            style={{ color: entry.color }}
            className="text-sm"
          >
            {modelName}: {entry.value?.toFixed(1)}%
          </p>
        );
      })}
    </div>
  );
}

export function ScoreOverStepsChart({ steps }: ScoreOverStepsChartProps) {
  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] text-muted-foreground">
        No step data available
      </div>
    );
  }

  const { data, models } = aggregateSteps(steps);

  return (
    <ResponsiveContainer width="100%" height={400}>
      <LineChart
        data={data}
        margin={{ top: 10, right: 20, bottom: 40, left: 20 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="step"
          type="number"
          label={{
            value: "Steps",
            position: "insideBottom",
            offset: -10,
            className: "fill-muted-foreground text-xs",
          }}
        />
        <YAxis
          domain={[0, 100]}
          label={{
            value: "Score (%)",
            angle: -90,
            position: "insideLeft",
            offset: 10,
            className: "fill-muted-foreground text-xs",
          }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend verticalAlign="top" height={36} />

        {models.map((model) => {
          const key = model.replace(/\s+/g, "_");
          const color = MODEL_COLORS[model] || "#888888";
          return (
            <Area
              key={`${key}_band`}
              dataKey={`${key}_max`}
              stroke="none"
              fill={color}
              fillOpacity={0.12}
              type="monotone"
              name={`${key}_band`}
              legendType="none"
              isAnimationActive={false}
            />
          );
        })}

        {models.map((model) => {
          const key = model.replace(/\s+/g, "_");
          const color = MODEL_COLORS[model] || "#888888";
          return (
            <Line
              key={`${key}_mean`}
              dataKey={`${key}_mean`}
              stroke={color}
              strokeWidth={2}
              dot={false}
              type="monotone"
              name={`${key}_mean`}
              isAnimationActive={false}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}
