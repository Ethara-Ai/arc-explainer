import React, { useState, useEffect, useCallback } from "react";
import { Gamepad2, ArrowLeft, X, Monitor } from "lucide-react";
import { Link } from "wouter";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/queryClient";
import {
  useMultiAgentStream,
  type ModelInfo,
} from "@/hooks/useMultiAgentStream";
import { Arc3MultiConfigPanel } from "@/components/arc3/Arc3MultiConfigPanel";
import { Arc3SessionCard } from "@/components/arc3/Arc3SessionCard";
import { Arc3LogTerminal } from "@/components/arc3/Arc3LogTerminal";
import { Arc3ReasoningViewer } from "@/components/arc3/Arc3ReasoningViewer";
import { Arc3Notepad } from "@/components/arc3/Arc3Notepad";
import { Arc3ActionLog } from "@/components/arc3/Arc3ActionLog";
import { Arc3GridVisualization } from "@/components/arc3/Arc3GridVisualization";

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

const FALLBACK_MODELS: ModelInfo[] = [
  {
    key: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    color: "#D946EF",
    provider: "Cloud",
  },
  {
    key: "kimi-k2.5",
    name: "Kimi K2.5",
    color: "#8B5CF6",
    provider: "Cloud",
  },
  {
    key: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    color: "#3B82F6",
    provider: "Vertex AI",
  },
  {
    key: "gpt-5.4",
    name: "GPT 5.4 Thinking",
    color: "#10B981",
    provider: "OpenAI",
  },
];

const API_PREFIX = "/api/arc3-agentsdk";

export default function ARC3AgentSdkPlayground() {
  usePageMeta({
    title: "ARC3 AgentSDK Playground",
    description:
      "Multi-provider agents playing ARC-3 games via OpenAI Agents SDK",
    canonicalPath: "/arc3/agentsdk-playground",
  });

  const {
    sessions,
    sessionList,
    logs,
    globalStatus,
    isRunning,
    startAll,
    cancelAll,
    reset,
  } = useMultiAgentStream(API_PREFIX);

  const [availableModels, setAvailableModels] =
    useState<ModelInfo[]>(FALLBACK_MODELS);
  const [games, setGames] = useState<GameInfo[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [selectedGames, setSelectedGames] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [systemPrompt, setSystemPrompt] = useState("Loading default prompt...");
  const [instructions, setInstructions] = useState(
    "Explore the game systematically. Inspect the game state and try different actions to learn the rules.",
  );
  const [reasoningEffort, setReasoningEffort] = useState("high");
  const [maxTurns, setMaxTurns] = useState(100000);
  const [runsPerGame, setRunsPerGame] = useState(1);
  const [maxSteps, setMaxSteps] = useState(200);
  const [presets, setPresets] = useState<PresetMeta[]>([]);
  const [presetId, setPresetId] = useState<string>("playbook");
  const [bootstrapWarnings, setBootstrapWarnings] = useState<string[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const selectedSession = selectedSessionId
    ? (sessions[selectedSessionId] ?? null)
    : null;
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(
    null,
  );
  const expandedSession = expandedSessionId
    ? (sessions[expandedSessionId] ?? null)
    : null;

  useEffect(() => {
    if (!expandedSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedSessionId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedSessionId]);

  // Load games and prompts from the existing ARC3 API (shared data)
  useEffect(() => {
    const pushBootstrapWarning = (message: string) => {
      setBootstrapWarnings((prev) =>
        prev.includes(message) ? prev : [...prev, message],
      );
    };

    (async () => {
      setGamesLoading(true);
      try {
        const r = await apiRequest("GET", "/api/arc3/local-games");
        const d = await r.json();
        if (d.success && Array.isArray(d.data)) setGames(d.data);
      } catch {
        pushBootstrapWarning("Failed to load local ARC3 games.");
      } finally {
        setGamesLoading(false);
      }
    })();
    apiRequest("GET", `${API_PREFIX}/models`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && Array.isArray(d.data) && d.data.length > 0) {
          setAvailableModels(
            d.data.map((m: any) => ({
              key: m.key,
              name: m.displayName,
              color: m.color,
              provider: m.providerKind,
            })),
          );
        }
      })
      .catch(() => pushBootstrapWarning("Failed to load AgentSDK model list."));
    apiRequest("GET", "/api/arc3/default-prompt")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.prompt) setSystemPrompt(d.data.prompt);
      })
      .catch(() =>
        pushBootstrapWarning("Failed to load the default ARC3 prompt."),
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
      .catch(() =>
        pushBootstrapWarning("Failed to load system prompt presets."),
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
      .catch(() =>
        setBootstrapWarnings((prev) =>
          prev.includes("Failed to load the selected system prompt preset.")
            ? prev
            : [...prev, "Failed to load the selected system prompt preset."],
        ),
      );
  }, [presetId]);

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

  const handleStart = useCallback(() => {
    const chosenModels = availableModels.filter((m) =>
      selectedModels.has(m.key),
    );
    startAll({
      games: Array.from(selectedGames),
      models: chosenModels,
      runsPerGame,
      maxSteps,
      systemPrompt,
      instructions,
      reasoningEffort,
      maxTurns,
      systemPromptPresetId: presetId,
      skipDefaultSystemPrompt: presetId === "none",
    });
    if (chosenModels.length > 0 && selectedGames.size > 0)
      setSelectedSessionId(
        `${chosenModels[0].key}::${Array.from(selectedGames)[0]}::0`,
      );
  }, [
    selectedGames,
    selectedModels,
    systemPrompt,
    instructions,
    reasoningEffort,
    maxTurns,
    runsPerGame,
    maxSteps,
    presetId,
    startAll,
  ]);

  const activeCount = sessionList.filter(
    (s) => s.status === "running" || s.status === "starting",
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
      {/* Hero Header */}
      <div className="relative overflow-hidden border-b border-white/5">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-0 left-1/3 w-80 h-80 bg-violet-500/20 rounded-full blur-[100px]" />
          <div className="absolute top-0 right-1/3 w-80 h-80 bg-fuchsia-500/15 rounded-full blur-[100px]" />
        </div>
        <div className="relative max-w-[1400px] mx-auto px-6 py-6">
          <div className="flex items-end justify-between">
            <div>
              <Link
                href="/"
                className="inline-flex items-center gap-1 text-[11px] text-white/30 hover:text-white/60 transition-colors mb-3"
              >
                <ArrowLeft className="h-3 w-3" /> ARC-3
              </Link>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-white/10 flex items-center justify-center">
                  <Gamepad2 className="h-5 w-5 text-violet-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-white tracking-tight">
                    AgentSDK Playground
                  </h1>
                  <p className="text-sm text-white/30">
                    Multi-provider agents via OpenAI Agents SDK + LiteLLM
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
                    {activeCount} running
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
              {(globalStatus === "completed" ||
                globalStatus === "cancelled" ||
                globalStatus === "error") && (
                <button
                  onClick={reset}
                  className="text-xs text-white/30 hover:text-white px-3 py-1.5 rounded-full border border-white/10 hover:bg-white/5 transition-all"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          {bootstrapWarnings.length > 0 && (
            <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                Bootstrap Warnings
              </p>
              <div className="mt-2 space-y-1">
                {bootstrapWarnings.map((warning) => (
                  <p key={warning} className="text-xs text-amber-100/80">
                    {warning}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main 3-column layout */}
      <div className="flex gap-5 items-start p-5 min-w-8x mx-auto">
        {/* LEFT: Config */}
        <div className="w-72 shrink-0">
          <Arc3MultiConfigPanel
            games={games}
            gamesLoading={gamesLoading}
            selectedGames={selectedGames}
            toggleGame={toggleGame}
            models={availableModels}
            selectedModels={selectedModels}
            toggleModel={toggleModel}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            instructions={instructions}
            setInstructions={setInstructions}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={setReasoningEffort}
            disableReasoningEffort
            reasoningEffortHelpText="AgentSDK LiteLLM runs currently use fixed high reasoning."
            maxTurns={maxTurns}
            setMaxTurns={setMaxTurns}
            runsPerGame={runsPerGame}
            setRunsPerGame={setRunsPerGame}
            maxSteps={maxSteps}
            setMaxSteps={setMaxSteps}
            systemPromptPresetId={presetId}
            setSystemPromptPresetId={setPresetId}
            systemPromptPresets={presets}
            parallelGames={1}
            setParallelGames={() => {}}
            parallelRuns={1}
            setParallelRuns={() => {}}
            sequentialModels={false}
            setSequentialModels={() => {}}
            budgetGlobalUsd={null}
            setBudgetGlobalUsd={() => {}}
            budgetPerGameUsd={null}
            setBudgetPerGameUsd={() => {}}
            isRunning={isRunning}
            onStart={handleStart}
            onCancel={cancelAll}
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
                <Gamepad2 className="h-6 w-6 text-gray-600" />
              </div>
              <p className="text-sm font-medium text-gray-400 mb-1">
                Ready to play
              </p>
              <p className="text-xs text-gray-500">
                Select games and models in the config panel, then hit Start
              </p>
            </div>
          )}
          <Arc3LogTerminal logs={logs} />
        </div>

        {/* RIGHT: Reasoning + Notepad */}
        <div className="w-80 shrink-0 space-y-3">
          {selectedSession ? (
            <>
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
              <Arc3ReasoningViewer
                timeline={selectedSession.timeline}
                isPlaying={
                  selectedSession.status === "running" ||
                  selectedSession.status === "starting"
                }
                streamingMessage={selectedSession.streamingMessage}
                streamingReasoning={selectedSession.streamingReasoning}
              />
              <Arc3ActionLog
                frames={selectedSession.frames}
                isPlaying={
                  selectedSession.status === "running" ||
                  selectedSession.status === "starting"
                }
                modelName={selectedSession.modelName}
                modelColor={selectedSession.modelColor}
              />
              <Arc3Notepad
                content={selectedSession.notepad}
                modelName={selectedSession.modelName}
                modelColor={selectedSession.modelColor}
                gameId={selectedSession.gameId}
              />
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

      {/* Expanded Grid Modal */}
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
                    <span className="text-white/10">|</span>
                    <span className="text-sm text-white/30">
                      Run {expandedSession.runIndex + 1}
                    </span>
                    {frame && (
                      <span
                        className={`text-[10px] font-semibold uppercase px-2.5 py-1 rounded-full border border-white/10 ${stColor}`}
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
                  <div className="flex items-center justify-between px-5 py-3 border-t border-white/5 text-xs">
                    <div className="flex items-center gap-5 text-white/30">
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
