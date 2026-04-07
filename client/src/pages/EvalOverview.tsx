/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Central eval overview — intentional, human-crafted dashboard design.
 *          Gradient hero, bento stat grid, timeline sessions, model leaderboard,
 *          rich run cards with colored accents, and performance charts.
 * SRP/DRY check: Pass
 */

import React, { useState, useMemo } from "react";
import { Link } from "wouter";
import {
  Play,
  Activity,
  BarChart3,
  DollarSign,
  Zap,
  CheckCircle,
  ExternalLink,
  Gamepad2,
  Loader2,
  Trophy,
  Clock,
  ChevronRight,
  TrendingUp,
  Layers,
  Target,
  ArrowUpRight,
} from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import {
  useEvalSessions,
  useAllEvalRuns,
  type EvalSessionRow,
  type EvalRunRow,
} from "@/hooks/useEvalRuns";
import { ScoreVsCostChart } from "@/components/puzzle-eval/EvalCharts";

const MODEL_COLORS: Record<string, string> = {
  gemini: "#22C55E",
  gpt: "#3B82F6",
  claude: "#F59E0B",
  kimi: "#A855F7",
};
function getColor(name: string): string {
  const l = name.toLowerCase();
  for (const [k, c] of Object.entries(MODEL_COLORS))
    if (l.includes(k)) return c;
  return "#6B7280";
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function EvalOverview() {
  usePageMeta({
    title: "Eval Overview",
    description: "Central dashboard for ARC evaluation runs",
    canonicalPath: "/eval",
  });

  const { data: sessionsData, isLoading: sessionsLoading } = useEvalSessions();
  const { data: runsData, isLoading: runsLoading } = useAllEvalRuns();

  const sessions = sessionsData?.sessions || [];
  const activeSessions = sessionsData?.activeSessions || [];
  const allRuns = runsData || [];

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );

  const runsBySession = useMemo(() => {
    const map: Record<string, EvalRunRow[]> = {};
    for (const r of allRuns) {
      if (!map[r.session_id]) map[r.session_id] = [];
      map[r.session_id].push(r);
    }
    return map;
  }, [allRuns]);

  const stats = useMemo(() => {
    const totalRuns = allRuns.length;
    const completedRuns = allRuns.filter((r) => r.final_score !== null).length;
    const solvedRuns = allRuns.filter((r) => r.solved).length;
    const totalCost = allRuns.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    const totalSteps = allRuns.reduce(
      (sum, r) => sum + (r.total_steps || 0),
      0,
    );
    const uniqueModels = new Set(allRuns.map((r) => r.model)).size;
    const uniqueGames = new Set(allRuns.map((r) => r.game_id)).size;
    const solveRate =
      completedRuns > 0 ? (solvedRuns / completedRuns) * 100 : 0;
    return {
      totalRuns,
      completedRuns,
      solvedRuns,
      totalCost,
      totalSteps,
      uniqueModels,
      uniqueGames,
      solveRate,
    };
  }, [allRuns]);

  const displayRuns = selectedSessionId
    ? runsBySession[selectedSessionId] || []
    : allRuns;

  const chartRuns = useMemo(
    () =>
      displayRuns.map((r) => ({
        runId: r.id,
        model: r.model,
        modelKey: r.model_key,
        gameId: r.game_id,
        runNumber: r.run_number,
        step: r.total_steps || 0,
        maxSteps: r.max_steps,
        score: r.final_score ?? 0,
        scorePct: (r.final_score ?? 0) * 100,
        state: r.solved ? "WIN" : "DONE",
        costUsd: r.cost_usd ?? 0,
        status: (r.error
          ? "error"
          : r.final_score !== null
            ? "completed"
            : "running") as "running" | "completed" | "error",
      })),
    [displayRuns],
  );

  // Model leaderboard
  const modelBoard = useMemo(() => {
    const map: Record<
      string,
      {
        model: string;
        runs: number;
        solved: number;
        avgScore: number;
        totalCost: number;
        bestScore: number;
      }
    > = {};
    for (const r of allRuns) {
      if (!map[r.model])
        map[r.model] = {
          model: r.model,
          runs: 0,
          solved: 0,
          avgScore: 0,
          totalCost: 0,
          bestScore: 0,
        };
      const m = map[r.model];
      m.runs++;
      if (r.solved) m.solved++;
      const score = (r.final_score ?? 0) * 100;
      m.avgScore += score;
      if (score > m.bestScore) m.bestScore = score;
      m.totalCost += r.cost_usd ?? 0;
    }
    return Object.values(map)
      .map((m) => ({ ...m, avgScore: m.runs > 0 ? m.avgScore / m.runs : 0 }))
      .sort((a, b) => b.avgScore - a.avgScore);
  }, [allRuns]);

  const isLoading = sessionsLoading || runsLoading;

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* ============================================================= */}
      {/*  HERO HEADER with gradient mesh                                */}
      {/* ============================================================= */}
      <div className="relative overflow-hidden border-b border-white/5">
        {/* Gradient mesh background */}
        <div className="absolute inset-0 opacity-40">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-[120px]" />
          <div className="absolute top-0 right-1/4 w-96 h-96 bg-blue-500/15 rounded-full blur-[120px]" />
          <div className="absolute -bottom-20 left-1/2 w-96 h-96 bg-emerald-500/10 rounded-full blur-[120px]" />
        </div>

        <div className="relative max-w-[1400px] mx-auto px-6 py-8">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[11px] font-medium tracking-[0.2em] uppercase text-purple-400/80 mb-2">
                Evaluation Harness
              </p>
              <h1 className="text-3xl font-bold text-white tracking-tight">
                Eval Overview
              </h1>
              <p className="text-sm text-white/40 mt-1 max-w-md">
                Multi-provider model benchmarking with live game visualization,
                trajectory replay, and comparative analytics.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href="/eval/run"
                className="group flex items-center gap-2 px-5 py-2.5 rounded-lg bg-white text-black text-sm font-semibold hover:bg-white/90 transition-all shadow-lg shadow-white/5"
              >
                <Play className="h-4 w-4" />
                New Evaluation
                <ArrowUpRight className="h-3.5 w-3.5 opacity-50 group-hover:opacity-100 transition-opacity" />
              </Link>
              <Link
                href="/arc3/agentsdk-playground"
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg border border-white/10 text-white/70 text-sm font-medium hover:bg-white/5 hover:text-white transition-all"
              >
                <Gamepad2 className="h-4 w-4" />
                Playground
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
        {/* ============================================================= */}
        {/*  BENTO STATS GRID -- varied sizes, colored accents             */}
        {/* ============================================================= */}
        <div className="grid grid-cols-4 gap-3">
          {/* Large: Total Runs */}
          <div className="col-span-1 bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/10 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <BarChart3 className="h-5 w-5 text-blue-400" />
              <span className="text-[10px] font-medium tracking-wider uppercase text-blue-400/60">
                Runs
              </span>
            </div>
            <div className="text-3xl font-bold text-white tracking-tight">
              {stats.totalRuns}
            </div>
            <div className="text-xs text-white/30 mt-1">
              {stats.completedRuns} completed
            </div>
          </div>

          {/* Solve rate */}
          <div className="col-span-1 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/10 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <Target className="h-5 w-5 text-emerald-400" />
              <span className="text-[10px] font-medium tracking-wider uppercase text-emerald-400/60">
                Solve Rate
              </span>
            </div>
            <div className="text-3xl font-bold text-white tracking-tight">
              {stats.solveRate.toFixed(0)}%
            </div>
            <div className="text-xs text-white/30 mt-1">
              {stats.solvedRuns} of {stats.completedRuns} solved
            </div>
          </div>

          {/* Cost */}
          <div className="col-span-1 bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/10 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <DollarSign className="h-5 w-5 text-amber-400" />
              <span className="text-[10px] font-medium tracking-wider uppercase text-amber-400/60">
                Total Cost
              </span>
            </div>
            <div className="text-3xl font-bold text-white tracking-tight">
              ${stats.totalCost.toFixed(2)}
            </div>
            <div className="text-xs text-white/30 mt-1">
              {stats.totalSteps.toLocaleString()} total steps
            </div>
          </div>

          {/* Coverage */}
          <div className="col-span-1 bg-gradient-to-br from-purple-500/10 to-purple-500/5 border border-purple-500/10 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <Layers className="h-5 w-5 text-purple-400" />
              <span className="text-[10px] font-medium tracking-wider uppercase text-purple-400/60">
                Coverage
              </span>
            </div>
            <div className="text-3xl font-bold text-white tracking-tight">
              {stats.uniqueModels}
              <span className="text-lg text-white/30 mx-1">x</span>
              {stats.uniqueGames}
            </div>
            <div className="text-xs text-white/30 mt-1">
              models x games tested
            </div>
          </div>
        </div>

        {/* ============================================================= */}
        {/*  ACTIVE SESSIONS -- prominent animated banner                  */}
        {/* ============================================================= */}
        {activeSessions.length > 0 && (
          <div className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-r from-emerald-500/5 via-emerald-500/10 to-emerald-500/5">
            <div className="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-pulse" />
            <div className="px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="h-3 w-3 rounded-full bg-emerald-400 animate-pulse" />
                  <div className="absolute inset-0 h-3 w-3 rounded-full bg-emerald-400 animate-ping opacity-30" />
                </div>
                <div>
                  <span className="text-sm font-semibold text-white">
                    {activeSessions.length} evaluation
                    {activeSessions.length > 1 ? "s" : ""} in progress
                  </span>
                  <p className="text-xs text-emerald-300/50">
                    Models are actively playing games right now
                  </p>
                </div>
              </div>
              <Link
                href="/eval/run"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/30 transition-all"
              >
                Watch Live <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        )}

        {/* ============================================================= */}
        {/*  MAIN CONTENT -- 2 columns                                     */}
        {/* ============================================================= */}
        <div className="flex gap-6 items-start">
          {/* LEFT: Sessions + Model Leaderboard */}
          <div className="w-80 shrink-0 space-y-4">
            {/* Model Leaderboard */}
            {modelBoard.length > 0 && (
              <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
                <div className="px-5 py-3.5 border-b border-white/5 flex items-center gap-2.5">
                  <Trophy className="h-4 w-4 text-amber-400" />
                  <span className="text-sm font-semibold text-white">
                    Model Leaderboard
                  </span>
                </div>
                <div className="p-3 space-y-1">
                  {modelBoard.map((m, rank) => {
                    const maxScore = modelBoard[0]?.avgScore || 1;
                    const barWidth =
                      maxScore > 0 ? (m.avgScore / maxScore) * 100 : 0;
                    return (
                      <div
                        key={m.model}
                        className="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.03] transition-colors"
                      >
                        <span className="text-xs font-bold text-white/20 w-5 text-right">
                          {rank + 1}
                        </span>
                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: getColor(m.model) }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-white truncate">
                              {m.model}
                            </span>
                            <span
                              className="text-xs font-bold tabular-nums"
                              style={{ color: getColor(m.model) }}
                            >
                              {m.avgScore.toFixed(1)}%
                            </span>
                          </div>
                          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${barWidth}%`,
                                backgroundColor: getColor(m.model),
                                opacity: 0.7,
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-white/25">
                            <span>{m.runs} runs</span>
                            <span>{m.solved} solved</span>
                            <span>${m.totalCost.toFixed(3)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Session Timeline */}
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Clock className="h-4 w-4 text-white/40" />
                  <span className="text-sm font-semibold text-white">
                    Sessions
                  </span>
                </div>
                <span className="text-[10px] text-white/20">
                  {sessions.length}
                </span>
              </div>
              <div className="max-h-[400px] overflow-y-auto">
                {/* All filter */}
                <button
                  onClick={() => setSelectedSessionId(null)}
                  className={`w-full text-left px-5 py-3 border-b border-white/[0.03] transition-colors ${!selectedSessionId ? "bg-purple-500/5" : "hover:bg-white/[0.02]"}`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-semibold ${!selectedSessionId ? "text-purple-300" : "text-white/50"}`}
                    >
                      All sessions
                    </span>
                    <span className="text-[10px] text-white/20">
                      {allRuns.length} runs
                    </span>
                  </div>
                </button>

                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-white/20" />
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="py-8 text-center text-xs text-white/20">
                    No sessions yet
                  </div>
                ) : (
                  sessions.map((s: EvalSessionRow) => {
                    const runCount = runsBySession[s.id]?.length || 0;
                    const isActive = activeSessions.includes(s.id);
                    const isSelected = selectedSessionId === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedSessionId(s.id)}
                        className={`w-full text-left px-5 py-3 border-b border-white/[0.03] transition-colors ${isSelected ? "bg-purple-500/5" : "hover:bg-white/[0.02]"}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            {isActive && (
                              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            )}
                            <span
                              className={`text-xs font-medium truncate ${isSelected ? "text-purple-300" : "text-white/60"}`}
                            >
                              {s.id.slice(5, 28)}
                            </span>
                          </div>
                          <span
                            className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                              isActive
                                ? "bg-emerald-500/10 text-emerald-400"
                                : s.status === "completed"
                                  ? "bg-blue-500/10 text-blue-400/70"
                                  : "bg-white/5 text-white/30"
                            }`}
                          >
                            {isActive ? "live" : s.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-white/20">
                          <span>{runCount} runs</span>
                          {s.total_cost_usd && (
                            <span>
                              ${parseFloat(s.total_cost_usd).toFixed(3)}
                            </span>
                          )}
                          <span className="ml-auto">
                            {timeAgo(s.started_at)}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: Run cards + Charts */}
          <div className="flex-1 min-w-0 space-y-5">
            {/* Filter bar */}
            {selectedSessionId && (
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-purple-500/5 border border-purple-500/10">
                <Activity className="h-3.5 w-3.5 text-purple-400" />
                <span className="text-xs text-purple-300">
                  Filtered: {selectedSessionId.slice(5, 30)}
                </span>
                <span className="text-[10px] text-white/20">
                  {displayRuns.length} runs
                </span>
                <button
                  onClick={() => setSelectedSessionId(null)}
                  className="ml-auto text-[10px] text-white/30 hover:text-white transition-colors"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Run cards */}
            {displayRuns.length > 0 ? (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {displayRuns.map((r: EvalRunRow) => {
                  const score = (r.final_score ?? 0) * 100;
                  const cost = r.cost_usd ?? 0;
                  const color = getColor(r.model);
                  const isDone = r.final_score !== null;
                  const hasError = !!r.error;
                  const progress =
                    r.max_steps > 0
                      ? ((r.total_steps || 0) / r.max_steps) * 100
                      : 0;

                  return (
                    <Link
                      key={r.id}
                      href={`/eval/trajectory/${r.id}`}
                      className="group relative rounded-2xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-all overflow-hidden"
                    >
                      {/* Colored top accent */}
                      <div
                        className="h-1 w-full"
                        style={{
                          background: `linear-gradient(90deg, ${color}40, ${color}10)`,
                        }}
                      />

                      <div className="p-4">
                        {/* Header */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2.5">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <span className="text-sm font-semibold text-white">
                              {r.model}
                            </span>
                          </div>
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                              hasError
                                ? "bg-red-500/10 text-red-400"
                                : r.solved
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : isDone
                                    ? "bg-blue-500/10 text-blue-400/70"
                                    : "bg-amber-500/10 text-amber-400"
                            }`}
                          >
                            {hasError
                              ? "error"
                              : r.solved
                                ? "solved"
                                : isDone
                                  ? "done"
                                  : "running"}
                          </span>
                        </div>

                        {/* Score */}
                        <div className="text-center py-3">
                          <div
                            className="text-4xl font-bold tracking-tight"
                            style={{ color }}
                          >
                            {score.toFixed(0)}
                            <span className="text-lg text-white/20">%</span>
                          </div>
                        </div>

                        {/* Progress bar */}
                        <div className="mb-3">
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${progress}%`,
                                backgroundColor: color,
                                opacity: 0.6,
                              }}
                            />
                          </div>
                          <div className="flex justify-between mt-1 text-[10px] text-white/20">
                            <span>
                              {r.total_steps || 0}/{r.max_steps} steps
                            </span>
                            <span>${cost.toFixed(4)}</span>
                          </div>
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-emerald-400/50 font-medium">
                            {r.game_id}
                          </span>
                          <span className="text-white/15">
                            R{r.run_number + 1}
                          </span>
                          {r.elapsed_seconds != null && (
                            <span className="text-white/15">
                              {r.elapsed_seconds.toFixed(0)}s
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Hover CTA */}
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 py-2 bg-gradient-to-t from-[#0a0a0f] to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                        <ExternalLink className="h-3 w-3 text-white/40" />
                        <span className="text-[10px] font-medium text-white/40">
                          Open trajectory
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 p-16 text-center">
                <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/5 flex items-center justify-center mx-auto mb-4">
                  <TrendingUp className="h-7 w-7 text-white/15" />
                </div>
                <p className="text-sm font-medium text-white/40 mb-1">
                  {isLoading ? "Loading runs..." : "No evaluation runs yet"}
                </p>
                <p className="text-xs text-white/20 mb-4">
                  Start an evaluation to see model performance data here
                </p>
                <Link
                  href="/eval/run"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-xs font-medium text-white/60 hover:bg-white/10 hover:text-white transition-all"
                >
                  <Play className="h-3.5 w-3.5" /> Start evaluation
                </Link>
              </div>
            )}

            {/* Charts */}
            {chartRuns.length > 0 && (
              <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
                <div className="px-5 py-3.5 border-b border-white/5 flex items-center gap-2.5">
                  <BarChart3 className="h-4 w-4 text-white/40" />
                  <span className="text-sm font-semibold text-white">
                    Score vs Cost
                  </span>
                </div>
                <div className="p-4">
                  <ScoreVsCostChart runs={chartRuns} height={280} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
