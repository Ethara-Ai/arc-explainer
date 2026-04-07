

import {
  ScatterChart,
  Scatter,
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

export interface RunRaw {
  run_id: string;
  model: string;
  final_score: number;
  cost_usd: number;
  total_steps: number;
  solved: boolean;
}

interface ScoreVsCostChartProps {
  runs: RunRaw[];
}

interface PlotPoint {
  x: number;
  y: number;
  run_id: string;
  model: string;
  steps: number;
  solved: boolean;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PlotPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-background border border-border rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold mb-1">{d.model}</p>
      <p className="text-muted-foreground">Score: {d.y.toFixed(1)}%</p>
      <p className="text-muted-foreground">Cost: ${d.x.toFixed(4)}</p>
      <p className="text-muted-foreground">Steps: {d.steps}</p>
      <p className="text-muted-foreground">Solved: {d.solved ? "Yes" : "No"}</p>
      <p className="text-muted-foreground text-xs mt-1">{d.run_id}</p>
    </div>
  );
}

export function ScoreVsCostChart({ runs }: ScoreVsCostChartProps) {
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] text-muted-foreground">
        No run data available
      </div>
    );
  }

  // Group runs by model for separate Scatter series
  const models = [...new Set(runs.map((r) => r.model))];

  const grouped: Record<string, PlotPoint[]> = {};
  for (const r of runs) {
    if (!grouped[r.model]) grouped[r.model] = [];
    grouped[r.model].push({
      x: r.cost_usd,
      y: r.final_score * 100,
      run_id: r.run_id,
      model: r.model,
      steps: r.total_steps,
      solved: r.solved,
    });
  }

  return (
    <ResponsiveContainer width="100%" height={400}>
      <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          type="number"
          dataKey="x"
          name="Cost"
          unit="$"
          label={{
            value: "Cost ($)",
            position: "insideBottom",
            offset: -10,
            className: "fill-muted-foreground text-xs",
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name="Score"
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
          const color = MODEL_COLORS[model] || "#888888";
          return (
            <Scatter
              key={model}
              name={model}
              data={grouped[model]}
              fill={color}
              fillOpacity={0.8}
              isAnimationActive={false}
            />
          );
        })}
      </ScatterChart>
    </ResponsiveContainer>
  );
}
