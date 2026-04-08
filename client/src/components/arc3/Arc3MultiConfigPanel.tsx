import React from "react";
import {
  Settings,
  Play,
  XCircle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Gamepad2,
  Hash,
  Brain,
  FileText,
  MessageSquare,
  Layers,
  Zap,
  DollarSign,
} from "lucide-react";
import type { ModelInfo } from "@/hooks/useMultiAgentStream";

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

interface Arc3ConfigurationPanelProps {
  // Game selection
  games: GameInfo[];
  gamesLoading: boolean;
  selectedGames: Set<string>;
  toggleGame: (id: string) => void;
  // Model selection
  models: ModelInfo[];
  selectedModels: Set<string>;
  toggleModel: (key: string) => void;
  // Prompts
  systemPrompt: string;
  setSystemPrompt: (v: string) => void;
  instructions: string;
  setInstructions: (v: string) => void;
  // Config
  reasoningEffort: string;
  setReasoningEffort: (v: string) => void;
  disableReasoningEffort?: boolean;
  reasoningEffortHelpText?: string;
  maxTurns: number;
  setMaxTurns: (v: number) => void;
  runsPerGame: number;
  setRunsPerGame: (v: number) => void;
  maxSteps: number;
  setMaxSteps: (v: number) => void;
  // Presets
  systemPromptPresetId: string;
  setSystemPromptPresetId: (v: string) => void;
  systemPromptPresets: PresetMeta[];
  // Parallelization
  parallelGames: number;
  setParallelGames: (v: number) => void;
  parallelRuns: number;
  setParallelRuns: (v: number) => void;
  sequentialModels: boolean;
  setSequentialModels: (v: boolean) => void;
  // Budget
  budgetGlobalUsd: number | null;
  setBudgetGlobalUsd: (v: number | null) => void;
  budgetPerGameUsd: number | null;
  setBudgetPerGameUsd: (v: number | null) => void;
  // Actions
  isRunning: boolean;
  onStart: () => void;
  onCancel: () => void;
}

const inputClass =
  "w-full bg-[#1a1a24] border border-[#2a2a3a] text-gray-200 text-xs px-2.5 py-2 rounded-lg focus:outline-none focus:border-blue-500/50 transition-colors disabled:opacity-40 placeholder:text-gray-600";

export const Arc3MultiConfigPanel: React.FC<Arc3ConfigurationPanelProps> = ({
  games,
  gamesLoading,
  selectedGames,
  toggleGame,
  models,
  selectedModels,
  toggleModel,
  systemPrompt,
  setSystemPrompt,
  instructions,
  setInstructions,
  reasoningEffort,
  setReasoningEffort,
  disableReasoningEffort = false,
  reasoningEffortHelpText,
  maxTurns,
  setMaxTurns,
  runsPerGame,
  setRunsPerGame,
  maxSteps,
  setMaxSteps,
  systemPromptPresetId,
  setSystemPromptPresetId,
  systemPromptPresets,
  parallelGames,
  setParallelGames,
  parallelRuns,
  setParallelRuns,
  sequentialModels,
  setSequentialModels,
  budgetGlobalUsd,
  setBudgetGlobalUsd,
  budgetPerGameUsd,
  setBudgetPerGameUsd,
  isRunning,
  onStart,
  onCancel,
}) => {
  const [gamesExpanded, setGamesExpanded] = React.useState(true);
  const [modelsExpanded, setModelsExpanded] = React.useState(true);
  const [parallelExpanded, setParallelExpanded] = React.useState(false);
  const [budgetExpanded, setBudgetExpanded] = React.useState(false);
  const [sysPromptExpanded, setSysPromptExpanded] = React.useState(false);
  const [userPromptExpanded, setUserPromptExpanded] = React.useState(false);

  const canStart =
    selectedGames.size > 0 && selectedModels.size > 0 && !isRunning;

  return (
    <div className="rounded-2xl border border-[#1e1e2e] bg-[#12121a] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[#1e1e2e]">
        <Settings className="h-4 w-4 text-blue-400" />
        <span className="text-sm font-semibold text-gray-200">
          Configuration
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* Game Selector */}
        <div className="space-y-2">
          <button
            onClick={() => setGamesExpanded(!gamesExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              <Gamepad2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-[11px] font-semibold text-gray-300">
                Games
              </span>
              {selectedGames.size > 0 && (
                <span className="text-[9px] font-medium text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">
                  {selectedGames.size}
                </span>
              )}
            </div>
            {gamesExpanded ? (
              <ChevronUp className="h-3 w-3 text-gray-600" />
            ) : (
              <ChevronDown className="h-3 w-3 text-gray-600" />
            )}
          </button>

          {gamesExpanded && (
            <div className="max-h-40 overflow-y-auto dark-scrollbar space-y-0.5 border border-[#1e1e2e] rounded-xl bg-[#0e0e16] p-2">
              {gamesLoading ? (
                <div className="text-[10px] text-gray-500 py-2 text-center">
                  Loading games...
                </div>
              ) : games.length === 0 ? (
                <div className="text-[10px] text-gray-500 py-2 text-center">
                  No games in puzzle /
                </div>
              ) : (
                games.map((g) => (
                  <label
                    key={g.game_id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-[11px] ${selectedGames.has(g.game_id) ? "bg-emerald-500/15 text-emerald-300" : "text-gray-400 hover:bg-[#1a1a24]"}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedGames.has(g.game_id)}
                      onChange={() => toggleGame(g.game_id)}
                      disabled={isRunning}
                      className="h-3.5 w-3.5 rounded border-gray-600 bg-[#1a1a24] text-emerald-500 focus:ring-0 focus:ring-offset-0"
                    />
                    <span className="truncate flex-1">
                      {g.title || g.game_id}
                    </span>
                    <span className="text-[9px] text-gray-600 shrink-0">
                      {g.game_id}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>

        {/* Model Selector (checkboxes) */}
        <div className="space-y-2">
          <button
            onClick={() => setModelsExpanded(!modelsExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5 text-purple-400" />
              <span className="text-[11px] font-semibold text-gray-300">
                Models
              </span>
              {selectedModels.size > 0 && (
                <span className="text-[9px] font-medium text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded-full">
                  {selectedModels.size}
                </span>
              )}
            </div>
            {modelsExpanded ? (
              <ChevronUp className="h-3 w-3 text-gray-600" />
            ) : (
              <ChevronDown className="h-3 w-3 text-gray-600" />
            )}
          </button>

          {modelsExpanded && (
            <div className="max-h-36 overflow-y-auto dark-scrollbar space-y-0.5 border border-[#1e1e2e] rounded-xl bg-[#0e0e16] p-2">
              {models.map((m) => (
                <label
                  key={m.key}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-[11px] ${selectedModels.has(m.key) ? "bg-purple-500/15 text-purple-300" : "text-gray-400 hover:bg-[#1a1a24]"}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedModels.has(m.key)}
                    onChange={() => toggleModel(m.key)}
                    disabled={isRunning}
                    className="h-3.5 w-3.5 rounded border-gray-600 bg-[#1a1a24] text-purple-500 focus:ring-0 focus:ring-offset-0"
                  />
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: m.color }}
                  />
                  <span className="truncate">{m.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Numeric configs */}
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-[10px] font-medium text-gray-400">
              <Hash className="h-2.5 w-2.5" /> Runs
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={runsPerGame}
              onChange={(e) =>
                setRunsPerGame(
                  Math.min(10, Math.max(1, Number(e.target.value))),
                )
              }
              disabled={isRunning}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-[10px] font-medium text-gray-400">
              <Layers className="h-2.5 w-2.5" /> Max Steps
            </label>
            <input
              type="number"
              min={1}
              max={200}
              value={maxSteps}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") return;
                const n = parseInt(raw, 10);
                if (!isNaN(n) && n >= 1) setMaxSteps(Math.min(200, n));
              }}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (isNaN(n) || n < 1) setMaxSteps(1);
                else if (n > 200) setMaxSteps(200);
              }}
              disabled={isRunning}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-[10px] font-medium text-gray-400">
              <Brain className="h-2.5 w-2.5" /> Reasoning
            </label>
            <select
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
              disabled={isRunning || disableReasoningEffort}
              className={inputClass}
            >
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            {reasoningEffortHelpText ? (
              <p className="text-[10px] text-gray-500">
                {reasoningEffortHelpText}
              </p>
            ) : null}
          </div>
        </div>

        {/* Parallelization (collapsible) */}
        <div className="space-y-2">
          <button
            onClick={() => setParallelExpanded(!parallelExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[11px] font-semibold text-gray-300">
                Parallelization
              </span>
              {(parallelGames > 1 || parallelRuns > 1 || sequentialModels) && (
                <span className="text-[9px] font-medium text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full">
                  custom
                </span>
              )}
            </div>
            {parallelExpanded ? (
              <ChevronUp className="h-3 w-3 text-gray-600" />
            ) : (
              <ChevronDown className="h-3 w-3 text-gray-600" />
            )}
          </button>

          {parallelExpanded && (
            <div className="space-y-3 border border-[#1e1e2e] rounded-xl bg-[#0e0e16] p-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-medium text-gray-400">
                    Parallel Games
                  </label>
                  <span className="text-[10px] font-mono text-amber-400">
                    {parallelGames}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={parallelGames}
                  onChange={(e) => setParallelGames(Number(e.target.value))}
                  disabled={isRunning}
                  className="w-full h-1.5 bg-[#1a1a24] rounded-lg appearance-none cursor-pointer accent-amber-400 disabled:opacity-40"
                />
                <div className="flex justify-between text-[9px] text-gray-600">
                  <span>1</span>
                  <span>20</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-medium text-gray-400">
                    Parallel Runs
                  </label>
                  <span className="text-[10px] font-mono text-amber-400">
                    {parallelRuns}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={parallelRuns}
                  onChange={(e) => setParallelRuns(Number(e.target.value))}
                  disabled={isRunning}
                  className="w-full h-1.5 bg-[#1a1a24] rounded-lg appearance-none cursor-pointer accent-amber-400 disabled:opacity-40"
                />
                <div className="flex justify-between text-[9px] text-gray-600">
                  <span>1</span>
                  <span>10</span>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sequentialModels}
                  onChange={(e) => setSequentialModels(e.target.checked)}
                  disabled={isRunning}
                  className="h-3.5 w-3.5 rounded border-gray-600 bg-[#1a1a24] text-amber-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-[10px] text-gray-400">
                  Sequential Models
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Budget (collapsible) */}
        <div className="space-y-2">
          <button
            onClick={() => setBudgetExpanded(!budgetExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              <DollarSign className="h-3.5 w-3.5 text-green-400" />
              <span className="text-[11px] font-semibold text-gray-300">
                Budget
              </span>
              {(budgetGlobalUsd !== null || budgetPerGameUsd !== null) && (
                <span className="text-[9px] font-medium text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded-full">
                  set
                </span>
              )}
            </div>
            {budgetExpanded ? (
              <ChevronUp className="h-3 w-3 text-gray-600" />
            ) : (
              <ChevronDown className="h-3 w-3 text-gray-600" />
            )}
          </button>

          {budgetExpanded && (
            <div className="space-y-3 border border-[#1e1e2e] rounded-xl bg-[#0e0e16] p-3">
              <div className="space-y-1.5">
                <label className="text-[10px] font-medium text-gray-400">
                  Global Limit ($)
                </label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  placeholder="No limit"
                  value={budgetGlobalUsd ?? ""}
                  disabled={isRunning}
                  onChange={(e) =>
                    setBudgetGlobalUsd(
                      e.target.value === ""
                        ? null
                        : Math.max(0, Number(e.target.value)),
                    )
                  }
                  className={inputClass}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-medium text-gray-400">
                  Per-Game Limit ($)
                </label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  placeholder="No limit"
                  value={budgetPerGameUsd ?? ""}
                  disabled={isRunning}
                  onChange={(e) =>
                    setBudgetPerGameUsd(
                      e.target.value === ""
                        ? null
                        : Math.max(0, Number(e.target.value)),
                    )
                  }
                  className={inputClass}
                />
              </div>
            </div>
          )}
        </div>

        {/* Prompt Preset */}
        {systemPromptPresets.length > 0 && (
          <div className="space-y-1">
            <label className="text-[10px] font-medium text-gray-400">
              Preset
            </label>
            <select
              value={systemPromptPresetId}
              onChange={(e) => setSystemPromptPresetId(e.target.value)}
              disabled={isRunning}
              className={inputClass}
            >
              {systemPromptPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* System Prompt (collapsible) */}
        <div className="space-y-1">
          <button
            onClick={() => setSysPromptExpanded(!sysPromptExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-1">
              <FileText className="h-2.5 w-2.5 text-blue-400" />
              <span className="text-[10px] font-medium text-gray-400">
                System Prompt
              </span>
              {systemPrompt && (
                <span className="text-[9px] font-mono text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">
                  {systemPrompt.length}c
                </span>
              )}
            </div>
            {sysPromptExpanded ? (
              <ChevronUp className="h-3 w-3 text-gray-600" />
            ) : (
              <ChevronDown className="h-3 w-3 text-gray-600" />
            )}
          </button>
          {sysPromptExpanded && (
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={isRunning}
              placeholder="Base system instructions..."
              rows={6}
              className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-[11px] font-mono px-2 py-1.5 rounded resize-y focus:outline-none focus:border-blue-500/60 transition-colors disabled:opacity-50 placeholder:text-gray-700 min-h-[6rem] max-h-[50vh]"
            />
          )}
        </div>

        {/* User Prompt (collapsible) */}
        <div className="space-y-1">
          <button
            onClick={() => setUserPromptExpanded(!userPromptExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-1">
              <MessageSquare className="h-2.5 w-2.5 text-emerald-400" />
              <span className="text-[10px] font-medium text-gray-400">
                User Prompt
              </span>
              {instructions && (
                <span className="text-[9px] font-mono text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded">
                  {instructions.length}c
                </span>
              )}
            </div>
            {userPromptExpanded ? (
              <ChevronUp className="h-3 w-3 text-gray-600" />
            ) : (
              <ChevronDown className="h-3 w-3 text-gray-600" />
            )}
          </button>
          {userPromptExpanded && (
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={isRunning}
              placeholder="Additional operator guidance..."
              rows={4}
              className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-[11px] font-mono px-2 py-1.5 rounded resize-y focus:outline-none focus:border-blue-500/60 transition-colors disabled:opacity-50 placeholder:text-gray-700 min-h-[4rem] max-h-[40vh]"
            />
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={onStart}
            disabled={!canStart}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl transition-all
              bg-white text-black hover:bg-white/90
              disabled:bg-[#1a1a24] disabled:text-gray-600 disabled:cursor-not-allowed"
          >
            <Play className="h-3.5 w-3.5" />
            Start ({selectedGames.size * selectedModels.size * runsPerGame})
          </button>

          {isRunning && (
            <button
              onClick={onCancel}
              className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-xl transition-all
                bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/40"
            >
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Arc3MultiConfigPanel;
