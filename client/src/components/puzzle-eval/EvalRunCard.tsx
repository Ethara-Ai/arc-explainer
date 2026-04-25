/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Compact eval run card with live game grid visualization.
 *          Uses Arc3GridVisualization (same canvas renderer as the playground)
 *          to show the game state updating in real-time as the model plays.
 * SRP/DRY check: Pass
 */

import React, { useMemo } from "react";
import { Eye, ExternalLink } from "lucide-react";
import { Link } from "wouter";
/** Run progress shape expected by EvalRunCard */
export interface RunProgress {
  runId: string;
  model: string;
  modelKey: string;
  gameId: string;
  runNumber: number;
  step: number;
  maxSteps: number;
  scorePct: number;
  costUsd: number;
  status: "running" | "completed" | "error";
  solved?: boolean;
  latestGrid?: any;
}
import { Arc3GridVisualization } from "@/components/arc3/Arc3GridVisualization";

const MODEL_COLORS: Record<string, string> = {
  gemini: "#22C55E",
  gpt: "#3B82F6",
  claude: "#F59E0B",
  kimi: "#A855F7",
};

function getColor(model: string): string {
  const l = model.toLowerCase();
  for (const [k, c] of Object.entries(MODEL_COLORS))
    if (l.includes(k)) return c;
  return "#6B7280";
}

interface EvalRunCardProps {
  run: RunProgress;
  isSelected: boolean;
  onClick: () => void;
}

export const EvalRunCard: React.FC<EvalRunCardProps> = ({
  run,
  isSelected,
  onClick,
}) => {
  const pct =
    run.maxSteps > 0 ? Math.round((run.step / run.maxSteps) * 100) : 0;
  const color = getColor(run.model);

  const stateClass =
    run.status === "error"
      ? "bg-red-500/20 text-red-400"
      : run.status === "completed" && run.solved
        ? "bg-emerald-500/20 text-emerald-400"
        : run.status === "completed"
          ? "bg-blue-500/20 text-blue-400"
          : run.status === "running"
            ? "bg-emerald-500/10 text-emerald-400"
            : "bg-gray-700/30 text-gray-400";

  const stateLabel =
    run.status === "error"
      ? "ERROR"
      : run.status === "completed" && run.solved
        ? "SOLVED"
        : run.status === "completed"
          ? "DONE"
          : run.status === "running"
            ? "RUNNING"
            : "IDLE";

  // Normalize grid to 3D (Arc3GridVisualization expects number[][][])
  const grid3d = useMemo((): number[][][] | null => {
    if (!run.latestGrid) return null;
    const g = run.latestGrid;
    if (g.length === 0) return null;
    // If first element is a number, it's 2D -- wrap in outer array
    if (typeof g[0] === "number") return null; // 1D, skip
    if (Array.isArray(g[0]) && typeof (g[0] as any)[0] === "number") {
      // 2D: number[][] -> wrap as [grid]
      return [g as number[][]];
    }
    // Already 3D
    return g as number[][][];
  }, [run.latestGrid]);

  return (
    <div
      onClick={onClick}
      className={`bg-gray-900 rounded-xl border p-3 cursor-pointer transition-all ${
        isSelected
          ? "border-blue-500/50 ring-1 ring-blue-500/20"
          : "border-gray-800 hover:border-gray-700"
      }`}
    >
      {/* Header: model + state */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-xs font-bold text-white truncate">
            {run.model}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${stateClass}`}
          >
            {stateLabel}
          </span>
          {isSelected && <Eye size={10} className="text-blue-400" />}
        </div>
      </div>

      {/* Live game grid or score fallback */}
      <div className="bg-gray-950 rounded-lg overflow-hidden mb-2 flex items-center justify-center min-h-[100px] p-1.5">
        {grid3d ? (
          <Arc3GridVisualization
            grid={grid3d}
            frameIndex={grid3d.length - 1}
            cellSize={8}
            showGrid={false}
          />
        ) : (
          <div className="p-3 text-center">
            <div className="text-2xl font-mono font-bold" style={{ color }}>
              {run.scorePct.toFixed(1)}
              <span className="text-sm text-gray-500">%</span>
            </div>
            <div className="text-[9px] font-mono text-gray-600 mt-0.5">
              {run.status === "running" ? "waiting for grid..." : "score"}
            </div>
          </div>
        )}
      </div>

      {/* Step progress bar */}
      <div className="space-y-1 mb-2">
        <div className="flex items-center justify-between text-[9px] font-mono text-gray-500">
          <span>
            Step {run.step}/{run.maxSteps}
          </span>
          <span className="font-bold" style={{ color }}>
            {run.scorePct.toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
      </div>

      {/* Footer: game + run + cost */}
      <div className="flex items-center justify-between text-[9px] font-mono text-gray-500">
        <span className="text-emerald-400/80">{run.gameId}</span>
        <span>R{run.runNumber + 1}</span>
        <span>${(run.costUsd ?? 0).toFixed(4)}</span>
      </div>

      {/* Trajectory link when done */}
      {(run.status === "completed" || run.status === "error") && (
        <Link
          href={`/eval/trajectory/${run.runId}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="mt-2 flex items-center justify-center gap-1 py-1 text-[9px] font-mono text-blue-400 hover:text-blue-300 border border-blue-500/20 rounded hover:border-blue-500/40 transition-colors"
        >
          <ExternalLink className="h-2.5 w-2.5" />
          Trajectory
        </Link>
      )}
    </div>
  );
};

export default EvalRunCard;
