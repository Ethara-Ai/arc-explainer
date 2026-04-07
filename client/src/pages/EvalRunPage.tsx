import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  FlaskConical,
  ArrowLeft,
  Loader2,
  X,
  Monitor,
  Layers,
  Activity,
} from "lucide-react";
import { Link } from "wouter";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/queryClient";
import {
  useEvalProgress,
  type StepEvent,
  type RunEvent,
} from "@/hooks/useEvalProgress";
import {
  useStartEval,
  useCancelEval,
  useEvalModels,
} from "@/hooks/useEvalRuns";
import type {
  AgentSession,
  FrameData,
  LogEntry,
} from "@/hooks/useMultiAgentStream";
import type { ModelInfo } from "@/hooks/useMultiAgentStream";
import { Arc3MultiConfigPanel } from "@/components/arc3/Arc3MultiConfigPanel";
import { Arc3SessionCard } from "@/components/arc3/Arc3SessionCard";
import { Arc3LogTerminal } from "@/components/arc3/Arc3LogTerminal";
import { Arc3ReasoningViewer } from "@/components/arc3/Arc3ReasoningViewer";
import { Arc3Notepad } from "@/components/arc3/Arc3Notepad";
import { Arc3ActionLog } from "@/components/arc3/Arc3ActionLog";
import { Arc3GridVisualization } from "@/components/arc3/Arc3GridVisualization";
import { any } from "zod/v4";

interface GameInfo {
  game_id: string;
  title: string;
  tags?: string[];
}
interface PresetMeta {
  id: "twitch" | "playbook" | "none";
  label: string;
  description: string;
  isDefault: boolean;
}

const MODEL_COLORS: Record<string, string> = {
  gemini: "#22C55E",
  gpt: "#3B82F6",
  claude: "#F59E0B",
  kimi: "#A855F7",
};
function getModelColor(name: string): string {
  const l = name.toLowerCase();
  for (const [k, c] of Object.entries(MODEL_COLORS))
    if (l.includes(k)) return c;
  return "#6B7280";
}

/* ---- Convert eval SSE data to playground component shapes ---- */

function buildSessionsFromSteps(
  steps: StepEvent[],
  runs: RunEvent[],
): {
  sessions: Record<string, AgentSession>;
  sessionList: AgentSession[];
  logs: LogEntry[];
} {
  const sessMap: Record<string, AgentSession> = {};
  const logs: LogEntry[] = [];

  if (steps.length > 0 || runs.length > 0) {
    console.log(
      `[EvalRunPage] buildSessionsFromSteps: ${steps.length} steps, ${runs.length} runs`,
    );
  }

  // Build sessions from steps grouped by run_id
  for (const s of steps) {
    const key = s.run_id;
    if (!sessMap[key]) {
      sessMap[key] = {
        id: key,
        modelKey: s.model,
        modelName: s.model,
        modelColor: getModelColor(s.model),
        gameId: s.game_id,
        runIndex: s.run_number,
        status: "running",
        frames: [],
        currentFrameIndex: 0,
        timeline: [],
        notepad: "",
        turnCount: 0,
        stepCount: 0,
      };
    }
    const sess = sessMap[key];

    // Build grid frame if step has grid data
    if (s.grid) {
      const grid = s.grid;
      const grid3d: number[][][] =
        Array.isArray(grid[0]) && Array.isArray((grid[0] as number[][])[0])
          ? (grid as number[][][])
          : [grid as number[][]];
      console.log(
        `[EvalRunPage] Grid frame: step=${s.step} run=${s.run_id} gridLayers=${grid3d.length} rows=${grid3d[0]?.length ?? 0}`,
      );
      sess.frames.push({
        frame: grid3d,
        score: s.score,
        state: s.state,
        action_counter: s.step,
        max_actions: 999,
        full_reset: false,
        action: { type: s.action },
      });
      sess.currentFrameIndex = sess.frames.length - 1;
    } else {
      console.log(
        `[EvalRunPage] Step ${s.step} run=${s.run_id} has NO grid data`,
      );
    }

    // Timeline entry — reasoning first (if available), then action summary
    if (s.reasoning) {
      sess.timeline.push({
        index: sess.timeline.length,
        type: "reasoning",
        label: `Step ${s.step}: Thinking`,
        content: s.reasoning,
      });
    }
    sess.timeline.push({
      index: sess.timeline.length,
      type: "assistant_message",
      label: `Step ${s.step}: ${s.action}`,
      content: `Action: ${s.action}\nScore: ${(s.score * 100).toFixed(1)}% | State: ${s.state}\nTokens: in=${s.input_tokens} out=${s.output_tokens} | Cost: $${s.cumulative_cost_usd.toFixed(4)}`,
    });

    sess.notepad = s.notepad_contents || sess.notepad;
    sess.stepCount = s.step;
    sess.turnCount = s.step;
    sess.streamingMessage = `Step ${s.step}: ${s.action} ${(s.score * 100).toFixed(0)}%`;

    // Log entry
    logs.push({
      timestamp: Date.now(),
      level: "info",
      source: `${s.model} / ${s.game_id}`,
      message: `S${s.step} ${s.action} -> ${(s.score * 100).toFixed(0)}% ${s.state}`,
    });
  }

  // Mark completed runs
  for (const r of runs) {
    const sess = sessMap[r.run_id];
    if (sess) {
      sess.status = r.solved ? "completed" : "completed";
      sess.streamingMessage = undefined;
      logs.push({
        timestamp: Date.now(),
        level: "info",
        source: `${r.model} / ${r.game_id}`,
        message: `R${r.run_number + 1} done: ${(r.final_score * 100).toFixed(0)}% ${r.solved ? "SOLVED" : ""} $${r.cost_usd.toFixed(4)}`,
      });
    }
  }

  return { sessions: sessMap, sessionList: Object.values(sessMap), logs };
}

const MODEL_PALETTE = [
  "#D946EF",
  "#8B5CF6",
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#06B6D4",
  "#84CC16",
  "#F97316",
  "#EC4899",
];

/* ---- Component ---- */

export default function EvalRunPage() {
  usePageMeta({
    title: "Eval Runner",
    description: "Live multi-model evaluation with game grids",
    canonicalPath: "/eval/run",
  });

  /* ---- eval session ---- */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const evalProgress = useEvalProgress(sessionId);
  const startEvalMutation = useStartEval();
  const cancelEvalMutation = useCancelEval();

  /* ---- games from puzzle-environments/ (same source as playground) ---- */
  const [games, setGames] = useState<GameInfo[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setGamesLoading(true);
      try {
        const r = await apiRequest("GET", "/api/arc3/local-games");
        const d = await r.json();
        if (d.success && Array.isArray(d.data)) setGames(d.data);
      } catch {
      } finally {
        setGamesLoading(false);
      }
    })();
  }, []);

  /* ---- models (fetched from registry API) ---- */
  const evalModelsQuery = useEvalModels();
  const evalModels: ModelInfo[] = useMemo(() => {
    if (!evalModelsQuery.data) return [];
    return evalModelsQuery.data.map((m, i) => ({
      key: m.key,
      name: m.name,
      color: MODEL_PALETTE[i % MODEL_PALETTE.length],
      provider: m.provider,
    }));
  }, [evalModelsQuery.data]);

  /* ---- selection state ---- */
  const [selectedGames, setSelectedGames] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [runsPerGame, setRunsPerGame] = useState(1);
  const [maxSteps, setMaxSteps] = useState(200);
  const [reasoningEffort, setReasoningEffort] = useState("low");
  const [maxTurns, setMaxTurns] = useState(100000);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [presets, setPresets] = useState<PresetMeta[]>([]);
  const [presetId, setPresetId] = useState<string>("playbook");

  /* ---- parallelization & budget state ---- */
  const [parallelGames, setParallelGames] = useState(1);
  const [parallelRuns, setParallelRuns] = useState(1);
  const [sequentialModels, setSequentialModels] = useState(false);
  const [budgetGlobalUsd, setBudgetGlobalUsd] = useState<number | null>(null);
  const [budgetPerGameUsd, setBudgetPerGameUsd] = useState<number | null>(null);

  /* ---- selected / expanded session ---- */
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(
    null,
  );
  const [clientLogs, setClientLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback(
    (level: LogEntry["level"], source: string, message: string) => {
      setClientLogs((prev) => [
        ...prev,
        { timestamp: Date.now(), level, source, message },
      ]);
    },
    [],
  );

  useEffect(() => {
    if (!expandedSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedSessionId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedSessionId]);

  /* ---- init prompts ---- */
  useEffect(() => {
    apiRequest("GET", "/api/arc3/default-prompt")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.prompt) setSystemPrompt(d.data.prompt);
      })
      .catch((err: unknown) =>
        console.error("[EvalRunPage] init fetch failed:", err),
      );
    apiRequest("GET", "/api/arc3/system-prompts")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && Array.isArray(d.data)) {
          setPresets(d.data);
          const def =
            d.data.find((p: PresetMeta) => p.isDefault) ||
            d.data.find((p: PresetMeta) => p.id === "playbook");
          if (def) setPresetId(def.id);
        }
      })
      .catch((err: unknown) =>
        console.error("[EvalRunPage] init fetch failed:", err),
      );
  }, []);

  useEffect(() => {
    if (presetId === "none") {
      setSystemPrompt("");
      return;
    }
    apiRequest("GET", `/api/arc3/system-prompts/${presetId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.body) setSystemPrompt(d.data.body);
      })
      .catch((err: unknown) =>
        console.error("[EvalRunPage] init fetch failed:", err),
      );
  }, [presetId]);

  /* ---- toggles ---- */
  const toggleGame = useCallback((id: string) => {
    setSelectedGames((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);
  const toggleModel = useCallback((key: string) => {
    setSelectedModels((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }, []);

  /* ---- start via eval harness (multi-provider) ---- */
  const handleStart = useCallback(async () => {
    addLog(
      "info",
      "system",
      `Starting eval: ${selectedGames.size} games x ${selectedModels.size} models x ${runsPerGame} runs (max ${maxSteps} steps)`,
    );
    try {
      const result = await startEvalMutation.mutateAsync({
        gameIds: Array.from(selectedGames),
        modelKeys: Array.from(selectedModels),
        numRuns: runsPerGame,
        maxSteps,
        parallelGames,
        parallelRuns,
        sequentialModels,
        budgetGlobalUsd,
        budgetPerGameUsd,
      });
      console.log("[EvalRunPage] startEval response:", result);
      if (result.sessionId) {
        addLog("info", "system", `Session created: ${result.sessionId}`);
        console.log(
          `[EvalRunPage] Setting sessionId=${result.sessionId} — this triggers EventSource`,
        );
        setSessionId(result.sessionId);
        setSelectedSessionId(null);
      } else {
        console.warn("[EvalRunPage] startEval returned no sessionId:", result);
        addLog("error", "system", "No sessionId in response");
      }
    } catch (e: any) {
      let errMsg = e?.message || "Failed to start eval";
      // Parse "400: {json}" format from apiRequest
      try {
        const colonIdx = errMsg.indexOf(": ");
        if (colonIdx > 0) {
          const parsed = JSON.parse(errMsg.slice(colonIdx + 2));
          errMsg = parsed.message || parsed.error || errMsg;
        }
      } catch {
        /* keep raw */
      }
      addLog("error", "system", errMsg);
    }
  }, [
    selectedGames,
    selectedModels,
    runsPerGame,
    maxSteps,
    parallelGames,
    parallelRuns,
    sequentialModels,
    budgetGlobalUsd,
    budgetPerGameUsd,
    startEvalMutation,
    addLog,
  ]);

  const handleCancel = useCallback(() => {
    if (sessionId) cancelEvalMutation.mutate(sessionId);
    addLog("warn", "system", "Evaluation cancelled");
    setSessionId(null);
    evalProgress.reset();
  }, [sessionId, cancelEvalMutation, evalProgress, addLog]);

  const handleReset = useCallback(() => {
    setSessionId(null);
    evalProgress.reset();
    setSelectedSessionId(null);
    setExpandedSessionId(null);
    setClientLogs([]);
  }, [evalProgress]);

  /* ---- Debug: log evalProgress state changes ---- */
  useEffect(() => {
    console.log("[EvalRunPage] evalProgress state:", {
      status: evalProgress.status,
      stepsCount: evalProgress.steps.length,
      runsCount: evalProgress.runs.length,
      error: evalProgress.error,
      totalModels: evalProgress.totalModels,
      completedModels: evalProgress.completedModels,
      modelStatusArray: evalProgress.modelStatusArray.map((m) => ({
        key: m.modelKey,
        status: m.status,
        steps: m.stepCount,
        runs: m.runCount,
      })),
    });
  }, [
    evalProgress.status,
    evalProgress.steps.length,
    evalProgress.runs.length,
    evalProgress.error,
    evalProgress.totalModels,
    evalProgress.completedModels,
    evalProgress.modelStatusArray,
  ]);

  /* ---- Convert eval data to playground shapes ---- */
  const { sessions, sessionList, logs } = useMemo(
    () => buildSessionsFromSteps(evalProgress.steps, evalProgress.runs),
    [evalProgress.steps, evalProgress.runs],
  );

  const selectedSession = selectedSessionId
    ? (sessions[selectedSessionId] ?? null)
    : null;
  const expandedSession = expandedSessionId
    ? (sessions[expandedSessionId] ?? null)
    : null;
  const mergedTimeline = useMemo(() => {
    const entries: Array<{ index: number; type: 'assistant_message' | 'tool_call' | 'tool_result' | 'reasoning'; label: string; content: string; gameId: string }> = [];
    for (const s of sessionList) {
      for (const t of s.timeline) {
        entries.push({ ...t, gameId: s.gameId });
      }
    }
    return entries;
  }, [sessionList]);

  const mergedFrames = useMemo(() => {
    const frames: import("@/hooks/useMultiAgentStream").FrameData[] = [];
    for (const s of sessionList) {
      for (const f of s.frames) {
        frames.push({ ...f, game_id: s.gameId });
      }
    }
    return frames;
  }, [sessionList]);

  const anySessionPlaying = useMemo(
    () => sessionList.some(s => s.status === "running" || s.status === "starting"),
    [sessionList],
  );

  const gameNotepads = useMemo(() => {
    const map = new Map<string, { content: string; modelName: string; modelColor: string; stepCount: number }>();
    for (const s of sessionList) {
      if (s.notepad) {
        const existing = map.get(s.gameId);
        if (!existing || s.stepCount > existing.stepCount) {
          map.set(s.gameId, { content: s.notepad, modelName: s.modelName, modelColor: s.modelColor, stepCount: s.stepCount });
        }
      }
    }
    return map;
  }, [sessionList]);

  // Auto-select first session
  useEffect(() => {
    if (sessionList.length > 0 && !selectedSessionId)
      setSelectedSessionId(sessionList[0].id);
  }, [sessionList, selectedSessionId]);

  /* ---- Add system logs ---- */
  const allLogs = useMemo(() => {
    const extraLogs: LogEntry[] = [];
    if (evalProgress.status === "connecting")
      extraLogs.push({
        timestamp: Date.now(),
        level: "info",
        source: "system",
        message: "Connecting to eval session...",
      });
    if (evalProgress.status === "connected")
      extraLogs.push({
        timestamp: Date.now(),
        level: "info",
        source: "system",
        message: `Session connected. ${evalProgress.totalModels} models running in parallel.`,
      });
    if (evalProgress.status === "completed")
      extraLogs.push({
        timestamp: Date.now(),
        level: "info",
        source: "system",
        message: `Session complete. ${evalProgress.runs.length} runs finished.`,
      });
    if (evalProgress.error)
      extraLogs.push({
        timestamp: Date.now(),
        level: "error",
        source: "system",
        message: evalProgress.error,
      });
    return [...clientLogs, ...extraLogs, ...logs];
  }, [
    evalProgress.status,
    evalProgress.totalModels,
    evalProgress.runs.length,
    evalProgress.error,
    logs,
    clientLogs,
  ]);

  const isRunning =
    evalProgress.status === "connecting" || evalProgress.status === "connected";
  const globalStatus =
    evalProgress.status === "connected"
      ? "running"
      : evalProgress.status === "completed"
        ? "completed"
        : evalProgress.status === "error"
          ? "error"
          : evalProgress.status === "connecting"
            ? "running"
            : "idle";

  const activeCount = evalProgress.modelStatusArray.filter(
    (m) => m.status === "running",
  ).length;
  const gridCols =
    sessionList.length === 1
      ? "grid-cols-1"
      : sessionList.length === 2
        ? "grid-cols-2"
        : sessionList.length <= 4
          ? "grid-cols-2"
          : sessionList.length <= 6
            ? "grid-cols-3"
            : "grid-cols-4";

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* ── Hero Header ── */}
      <div className="relative overflow-hidden border-b border-white/5">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-0 left-1/3 w-80 h-80 bg-purple-500/20 rounded-full blur-[100px]" />
          <div className="absolute top-0 right-1/3 w-80 h-80 bg-blue-500/15 rounded-full blur-[100px]" />
        </div>
        <div className="relative max-w-[1400px] mx-auto px-6 py-6">
          <div className="flex items-end justify-between">
            <div>
              <Link
                href="/eval"
                className="inline-flex items-center gap-1 text-[11px] text-white/30 hover:text-white/60 transition-colors mb-3"
              >
                <ArrowLeft className="h-3 w-3" /> Overview
              </Link>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center">
                  <FlaskConical className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-white tracking-tight">
                    Eval Runner
                  </h1>
                  <p className="text-sm text-white/30">
                    Each model uses its native API (multi-provider)
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {isRunning && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                  <div className="relative">
                    <div className="h-2 w-2 rounded-full bg-emerald-400" />
                    <div className="absolute inset-0 h-2 w-2 rounded-full bg-emerald-400 animate-ping opacity-40" />
                  </div>
                  <span className="text-xs font-medium text-emerald-300">
                    {activeCount} models
                  </span>
                </div>
              )}
              <span
                className={`text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 rounded-full border ${
                  globalStatus === "running"
                    ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-400"
                    : globalStatus === "completed"
                      ? "border-blue-500/20 bg-blue-500/5 text-blue-400"
                      : globalStatus === "error"
                        ? "border-red-500/20 bg-red-500/5 text-red-400"
                        : "border-white/10 bg-white/[0.02] text-white/30"
                }`}
              >
                {globalStatus}
              </span>
              {(globalStatus === "completed" || globalStatus === "error") && (
                <button
                  onClick={handleReset}
                  className="text-xs text-white/30 hover:text-white px-3 py-1.5 rounded-full border border-white/10 hover:bg-white/5 transition-all"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Main 3-column layout ── */}
      <div className="flex gap-5 items-start p-5 min-w-8x mx-auto">
        {/* LEFT: Config */}
        <div className="w-72 shrink-0">
          <Arc3MultiConfigPanel
            games={games}
            gamesLoading={gamesLoading}
            selectedGames={selectedGames}
            toggleGame={toggleGame}
            models={evalModels}
            selectedModels={selectedModels}
            toggleModel={toggleModel}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            instructions={instructions}
            setInstructions={setInstructions}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={setReasoningEffort}
            maxTurns={maxTurns}
            setMaxTurns={setMaxTurns}
            runsPerGame={runsPerGame}
            setRunsPerGame={setRunsPerGame}
            maxSteps={maxSteps}
            setMaxSteps={setMaxSteps}
            systemPromptPresetId={presetId}
            setSystemPromptPresetId={setPresetId}
            systemPromptPresets={presets}
            parallelGames={parallelGames}
            setParallelGames={setParallelGames}
            parallelRuns={parallelRuns}
            setParallelRuns={setParallelRuns}
            sequentialModels={sequentialModels}
            setSequentialModels={setSequentialModels}
            budgetGlobalUsd={budgetGlobalUsd}
            setBudgetGlobalUsd={setBudgetGlobalUsd}
            budgetPerGameUsd={budgetPerGameUsd}
            setBudgetPerGameUsd={setBudgetPerGameUsd}
            isRunning={isRunning}
            onStart={handleStart}
            onCancel={handleCancel}
          />
        </div>

        {/* CENTER: Cards + Terminal */}
        <div className="flex-1 min-w-0 space-y-4">
          {sessionList.length > 0 ? (
            <div className={`grid gap-3 ${gridCols}`}>
              {sessionList.map((s) => (
                <Arc3SessionCard
                  key={s.id}
                  session={s}
                  isSelected={selectedSessionId === s.id}
                  onClick={() => setSelectedSessionId(s.id)}
                  onExpand={() => setExpandedSessionId(s.id)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[#2a2a3a] p-16 text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#12121a] border border-[#1e1e2e] flex items-center justify-center mx-auto mb-4">
                <FlaskConical className="h-6 w-6 text-gray-600" />
              </div>
              <p className="text-sm font-medium text-gray-400 mb-1">
                Ready to evaluate
              </p>
              <p className="text-xs text-gray-500">
                Select games and models, then click Start. Each model uses its
                native API.
              </p>
            </div>
          )}
          <Arc3LogTerminal logs={allLogs} />
        </div>

        {/* RIGHT: Reasoning + Actions + Notepad */}
        <div className="w-80 shrink-0 space-y-3">
          {sessionList.length > 0 ? (
            <>
            {selectedSession && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#12121a] border border-[#1e1e2e]">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: selectedSession.modelColor }}
                />
                <span className="text-xs font-semibold text-gray-100">
                  {selectedSession.modelName}
                </span>
                <span className="text-[#2a2a3a]">|</span>
                <span className="text-xs text-emerald-400">
                  {selectedSession.gameId}
                </span>
                <span className="text-[#2a2a3a]">|</span>
                <span className="text-[10px] text-gray-500">
                  Run {selectedSession.runIndex + 1}
                </span>
              </div>
              )}
              <Arc3ReasoningViewer
                timeline={mergedTimeline}
                isPlaying={anySessionPlaying}
                streamingMessage={selectedSession?.streamingMessage}
                streamingReasoning={selectedSession?.streamingReasoning}
              />
              <Arc3ActionLog
                frames={mergedFrames}
                isPlaying={anySessionPlaying}
                modelName={selectedSession?.modelName ?? "All Models"}
                modelColor={selectedSession?.modelColor ?? "#6B7280"}
              />
              {Array.from(gameNotepads.entries()).map(([gId, data]) => (
              <Arc3Notepad
                key={gId}
                content={data.content}
                modelName={data.modelName}
                modelColor={data.modelColor ?? "#6B7280"}
                gameId={gId}
              />
              ))}
              {gameNotepads.size === 0 && selectedSession && (
              <Arc3Notepad
                content={selectedSession?.notepad}
                modelName={selectedSession?.modelName ?? "All Models"}
                modelColor={selectedSession?.modelColor ?? "#6B7280"}
                gameId={selectedSession?.gameId}
              />
              )}
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-[#2a2a3a] p-10 text-center">
              <p className="text-xs text-gray-500">
                {sessionList.length > 0
                  ? "Click a card to inspect"
                  : "Detail panel"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Expanded Grid Modal ── */}
      {expandedSession &&
        (() => {
          const frame =
            expandedSession.frames[expandedSession.currentFrameIndex] || null;
          const grid = frame?.frame || null;
          const stColor =
            frame?.state === "WIN"
              ? "text-emerald-400"
              : frame?.state === "GAME_OVER" || frame?.state === "LOSE"
                ? "text-red-400"
                : "text-amber-400";
          return (
            <div
              className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-8"
              onClick={() => setExpandedSessionId(null)}
            >
              <div
                className="bg-[#0e0e15] border border-white/10 rounded-2xl max-w-[85vw] max-h-[85vh] overflow-auto shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 sticky top-0 bg-[#0e0e15] z-10">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: expandedSession.modelColor }}
                    />
                    <span className="text-sm font-semibold text-white">
                      {expandedSession.modelName}
                    </span>
                    <span className="text-white/10">|</span>
                    <span className="text-sm text-emerald-400/70">
                      {expandedSession.gameId}
                    </span>
                    {frame && (
                      <span
                        className={`text-[10px] font-semibold uppercase px-2.5 py-1 rounded-full border border-white/10 ml-2 ${stColor}`}
                      >
                        {frame.state === "NOT_FINISHED"
                          ? "Playing"
                          : frame.state}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setExpandedSessionId(null)}
                    className="p-2 rounded-xl text-white/30 hover:text-white hover:bg-white/5 transition-all"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex items-center justify-center p-10 bg-black/30">
                  {grid ? (
                    <Arc3GridVisualization
                      grid={grid}
                      frameIndex={grid.length > 0 ? grid.length - 1 : 0}
                      cellSize={24}
                      showGrid={true}
                    />
                  ) : (
                    <div className="text-center py-20">
                      <Monitor className="mx-auto h-10 w-10 text-white/10 mb-3" />
                      <p className="text-sm text-white/20">No grid data</p>
                    </div>
                  )}
                </div>
                {frame && (
                  <div className="flex items-center justify-between px-5 py-3 border-t border-white/5 text-xs text-white/30">
                    <div className="flex items-center gap-5">
                      <span>
                        Score:{" "}
                        <span className="text-white font-semibold">
                          {frame.score}
                        </span>
                      </span>
                      <span>
                        State: <span className={stColor}>{frame.state}</span>
                      </span>
                      <span>Steps: {expandedSession.stepCount}</span>
                    </div>
                    <span className="text-white/15 text-[10px]">
                      ESC to close
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
