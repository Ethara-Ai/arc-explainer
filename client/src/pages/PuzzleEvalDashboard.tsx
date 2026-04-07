import { useState, useMemo, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ScoreOverStepsChart,
  type StepRaw,
} from "@/components/puzzle-eval/ScoreOverStepsChart";
import {
  ScoreVsCostChart,
  type RunRaw,
} from "@/components/puzzle-eval/ScoreVsCostChart";
import {
  useEvalSessions,
  useEvalRuns,
  useEvalMultiRunSteps,
  useEvalGames,
  useStartEval,
  useCancelEval,
  useEvalModels,
} from "@/hooks/useEvalRuns";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useEvalProgress, type ModelStatus } from "@/hooks/useEvalProgress";

// Model color mapping for visual distinction — keys match ALL_MODEL_KEYS in llmConfig.ts
const MODEL_COLORS: Record<string, string> = {
  "claude-opus": "bg-amber-600",
  "kimi-k2.5": "bg-purple-600",
  "gemini-3.1-standard": "bg-green-600",
  "gemini-3.1-priority": "bg-green-700",
  "gpt-5.4-thinking": "bg-blue-700",
};

function getModelColor(modelKey: string): string {
  return MODEL_COLORS[modelKey] ?? "bg-gray-500";
}

function getModelStatusBadge(status: ModelStatus["status"]) {
  switch (status) {
    case "running":
      return (
        <Badge
          variant="outline"
          className="border-blue-500 text-blue-600 animate-pulse"
        >
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="outline" className="border-green-600 text-green-700">
          Done
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
  }
}

export default function PuzzleEvalDashboard() {
  const [selectedSession, setSelectedSession] = useState<string>("");
  const [selectedGame, setSelectedGame] = useState<string>("");
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);

  // Start eval form state
  const [showStartForm, setShowStartForm] = useState(false);
  const [selectedGames, setSelectedGames] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [formNumRuns, setFormNumRuns] = useState(5);
  const [formMaxSteps, setFormMaxSteps] = useState(200);
  const [formContextWindow, setFormContextWindow] = useState(10);
  const [formSeedBase, setFormSeedBase] = useState(42);
  const [gamesPopoverOpen, setGamesPopoverOpen] = useState(false);
  const [modelsPopoverOpen, setModelsPopoverOpen] = useState(false);

  // Data fetching
  const sessionsQuery = useEvalSessions(20);
  const gamesQuery = useEvalGames();
  const modelsQuery = useEvalModels();
  const runsQuery = useEvalRuns({
    sessionId: selectedSession || undefined,
    gameId: selectedGame || undefined,
  });

  // Mutations
  const startEval = useStartEval();
  const cancelEval = useCancelEval();

  // For step detail: pick first run to show steps
  const allRuns = runsQuery.data ?? [];

  // Collect steps for all runs in current view (for ScoreOverSteps chart)
  const runIdsForSteps = useMemo(
    () => allRuns.slice(0, 20).map((r) => r.id),
    [allRuns],
  );
  const multiStepQueries = useEvalMultiRunSteps(runIdsForSteps);

  // Live streaming
  const liveProgress = useEvalProgress(liveSessionId);

  const handleStartEval = useCallback(async () => {
    const gameIds = selectedGames.length === 0 ? ["all"] : selectedGames;
    const modelKeys = selectedModels.length === 0 ? ["all"] : selectedModels;

    try {
      const result = await startEval.mutateAsync({
        gameIds,
        modelKeys,
        numRuns: formNumRuns,
        maxSteps: formMaxSteps,
        contextWindow: formContextWindow,
        seedBase: formSeedBase,
      });
      setLiveSessionId(result.sessionId);
      setShowStartForm(false);
    } catch {
      // Error handled by mutation state
    }
  }, [
    selectedGames,
    selectedModels,
    formNumRuns,
    formMaxSteps,
    formContextWindow,
    formSeedBase,
    startEval,
  ]);

  const handleCancelSession = useCallback(async () => {
    if (liveSessionId) {
      await cancelEval.mutateAsync(liveSessionId);
      setLiveSessionId(null);
    }
  }, [liveSessionId, cancelEval]);

  // Merge live data with DB data
  const effectiveRuns = useMemo(() => {
    const dbRuns = allRuns.map((r) => ({
      run_id: r.id,
      model: r.model,
      final_score: r.final_score ?? 0,
      cost_usd: r.cost_usd ?? 0,
      total_steps: r.total_steps ?? 0,
      solved: r.solved ?? false,
    }));
    const liveRuns = liveProgress.runs.map((r) => ({
      run_id: r.run_id,
      model: r.model,
      final_score: r.final_score,
      cost_usd: r.cost_usd,
      total_steps: r.total_steps,
      solved: r.solved,
    }));
    return [...dbRuns, ...liveRuns];
  }, [allRuns, liveProgress.runs]);

  const effectiveSteps = useMemo(() => {
    // Flatten steps from all per-run queries
    const dbSteps = multiStepQueries.flatMap((q) =>
      (q.data ?? []).map((s) => ({
        run_id: s.run_id,
        model: allRuns.find((r) => r.id === s.run_id)?.model ?? "Unknown",
        step: s.step,
        score: s.score ?? 0,
      })),
    );
    const liveSteps = liveProgress.steps.map((s) => ({
      run_id: s.run_id,
      model: s.model,
      step: s.step,
      score: s.score,
    }));
    return [...dbSteps, ...liveSteps];
  }, [multiStepQueries, allRuns, liveProgress.steps]);

  // Summary stats
  const stats = useMemo(() => {
    if (effectiveRuns.length === 0) return null;
    const models = [...new Set(effectiveRuns.map((r) => r.model))];
    const avgScore =
      effectiveRuns.reduce((s, r) => s + r.final_score, 0) /
      effectiveRuns.length;
    const avgCost =
      effectiveRuns.reduce((s, r) => s + r.cost_usd, 0) / effectiveRuns.length;
    const solvedCount = effectiveRuns.filter((r) => r.solved).length;
    return {
      totalRuns: effectiveRuns.length,
      models: models.length,
      modelNames: models,
      avgScore: (avgScore * 100).toFixed(1),
      avgCost: avgCost.toFixed(4),
      solvedCount,
      solvedPct: ((solvedCount / effectiveRuns.length) * 100).toFixed(0),
    };
  }, [effectiveRuns]);

  const isLoading = sessionsQuery.isLoading || runsQuery.isLoading;
  const error = sessionsQuery.error || runsQuery.error;
  const isLiveAndConnected = liveProgress.status === "connected";
  const hasParallelModels = liveProgress.modelStatusArray.length > 0;

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Puzzle Evaluation</h1>
          <p className="text-muted-foreground text-sm">
            LLM performance across ARC puzzle environments
          </p>
          {isLiveAndConnected && (
            <p className="text-sm text-green-600 mt-1">
              Live evaluation in progress
              {hasParallelModels &&
                ` -- ${liveProgress.completedModels}/${liveProgress.totalModels} models done`}{" "}
              -- {liveProgress.steps.length} steps, {liveProgress.runs.length}{" "}
              runs
            </p>
          )}
          {liveProgress.status === "completed" && (
            <p className="text-sm text-muted-foreground mt-1">
              Evaluation complete -- {liveProgress.runs.length} runs finished
            </p>
          )}
          {liveProgress.status === "error" && (
            <p className="text-sm text-red-600 mt-1">
              Stream error: {liveProgress.error}
            </p>
          )}
        </div>

        <div className="flex gap-2 items-center">
          {/* Start / Cancel eval */}
          {liveSessionId && isLiveAndConnected ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleCancelSession}
              disabled={cancelEval.isPending}
            >
              {cancelEval.isPending ? "Cancelling..." : "Cancel Eval"}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowStartForm(!showStartForm)}
            >
              {showStartForm ? "Hide" : "Start Eval"}
            </Button>
          )}

          {/* Session selector */}
          {sessionsQuery.data?.sessions &&
            sessionsQuery.data.sessions.length > 0 && (
              <select
                value={selectedSession}
                onChange={(e) => setSelectedSession(e.target.value)}
                className="border border-border rounded-md px-3 py-2 text-sm bg-background"
              >
                <option value="">All Sessions</option>
                {sessionsQuery.data.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id.slice(0, 8)} ({s.status})
                  </option>
                ))}
              </select>
            )}

          {/* Game filter */}
          {gamesQuery.data && gamesQuery.data.length > 0 && (
            <select
              value={selectedGame}
              onChange={(e) => setSelectedGame(e.target.value)}
              className="border border-border rounded-md px-3 py-2 text-sm bg-background"
            >
              <option value="">All Games</option>
              {gamesQuery.data.map((g) => (
                <option key={g.game_id} value={g.game_id}>
                  {g.game_id}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Start Eval Form */}
      {showStartForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Start New Evaluation</CardTitle>
            <CardDescription>
              Launch the Python eval harness against ARC games. Multiple models
              run in parallel -- one subprocess per model.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Row 1: Game + Model multi-select dropdowns */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Games multi-select */}
              <div className="space-y-1.5">
                <Label>Games</Label>
                <Popover
                  open={gamesPopoverOpen}
                  onOpenChange={setGamesPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between font-normal"
                      disabled={gamesQuery.isLoading}
                    >
                      {gamesQuery.isLoading ? (
                        <span className="text-muted-foreground">
                          Loading games...
                        </span>
                      ) : selectedGames.length === 0 ? (
                        <span className="text-muted-foreground">All games</span>
                      ) : (
                        <span>
                          {selectedGames.length} game
                          {selectedGames.length !== 1 ? "s" : ""} selected
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[300px] p-0" align="start">
                    <div className="p-2 border-b">
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                        onClick={() => {
                          if (
                            selectedGames.length ===
                            (gamesQuery.data?.length ?? 0)
                          ) {
                            setSelectedGames([]);
                          } else {
                            setSelectedGames(
                              gamesQuery.data?.map((g) => g.game_id) ?? [],
                            );
                          }
                        }}
                      >
                        {selectedGames.length === (gamesQuery.data?.length ?? 0)
                          ? "Clear all"
                          : "Select all"}
                      </button>
                    </div>
                    <div className="max-h-[240px] overflow-y-auto p-1">
                      {(gamesQuery.data ?? []).map((g) => (
                        <label
                          key={g.game_id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedGames.includes(g.game_id)}
                            onCheckedChange={(checked) => {
                              setSelectedGames((prev) =>
                                checked
                                  ? [...prev, g.game_id]
                                  : prev.filter((id) => id !== g.game_id),
                              );
                            }}
                          />
                          <span className="text-sm">{g.game_id}</span>
                          <Badge
                            variant="secondary"
                            className="ml-auto text-[10px] px-1.5 py-0"
                          >
                            {g.game_type}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  Leave empty for all games
                </p>
              </div>

              {/* Models multi-select */}
              <div className="space-y-1.5">
                <Label>Models</Label>
                <Popover
                  open={modelsPopoverOpen}
                  onOpenChange={setModelsPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between font-normal"
                      disabled={modelsQuery.isLoading}
                    >
                      {modelsQuery.isLoading ? (
                        <span className="text-muted-foreground">
                          Loading models...
                        </span>
                      ) : selectedModels.length === 0 ? (
                        <span className="text-muted-foreground">
                          All models
                        </span>
                      ) : (
                        <span>
                          {selectedModels.length} model
                          {selectedModels.length !== 1 ? "s" : ""} selected
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[320px] p-0" align="start">
                    <div className="p-2 border-b">
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                        onClick={() => {
                          if (
                            selectedModels.length ===
                            (modelsQuery.data?.length ?? 0)
                          ) {
                            setSelectedModels([]);
                          } else {
                            setSelectedModels(
                              modelsQuery.data?.map((m) => m.key) ?? [],
                            );
                          }
                        }}
                      >
                        {selectedModels.length ===
                        (modelsQuery.data?.length ?? 0)
                          ? "Clear all"
                          : "Select all"}
                      </button>
                    </div>
                    <div className="max-h-[240px] overflow-y-auto p-1">
                      {(modelsQuery.data ?? []).map((m) => (
                        <label
                          key={m.key}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedModels.includes(m.key)}
                            onCheckedChange={(checked) => {
                              setSelectedModels((prev) =>
                                checked
                                  ? [...prev, m.key]
                                  : prev.filter((k) => k !== m.key),
                              );
                            }}
                          />
                          <div className="flex flex-col">
                            <span className="text-sm">{m.name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {m.provider}
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  Leave empty for all models. Each runs in parallel.
                </p>
              </div>
            </div>

            {/* Row 2: Numeric config fields */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
              <div className="space-y-1.5">
                <Label htmlFor="numRuns">Runs per model</Label>
                <Input
                  id="numRuns"
                  type="number"
                  min={1}
                  max={50}
                  value={formNumRuns}
                  onChange={(e) => setFormNumRuns(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="maxSteps">Max steps</Label>
                <Input
                  id="maxSteps"
                  type="number"
                  min={10}
                  max={1000}
                  value={formMaxSteps}
                  onChange={(e) => setFormMaxSteps(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contextWindow">Context window</Label>
                <Input
                  id="contextWindow"
                  type="number"
                  min={1}
                  max={50}
                  value={formContextWindow}
                  onChange={(e) => setFormContextWindow(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Turns visible to model
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seedBase">Seed</Label>
                <Input
                  id="seedBase"
                  type="number"
                  min={0}
                  max={99999}
                  value={formSeedBase}
                  onChange={(e) => setFormSeedBase(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Base random seed
                </p>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <Button onClick={handleStartEval} disabled={startEval.isPending}>
                {startEval.isPending ? "Starting..." : "Launch Evaluation"}
              </Button>
              <Button variant="outline" onClick={() => setShowStartForm(false)}>
                Cancel
              </Button>
            </div>
            {startEval.isError && (
              <p className="mt-2 text-sm text-destructive">
                {startEval.error instanceof Error
                  ? startEval.error.message
                  : "Failed to start evaluation"}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Parallel Model Progress Tracks -- visible during live evaluation */}
      {hasParallelModels &&
        (isLiveAndConnected || liveProgress.status === "completed") && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">
                Model Progress
                {isLiveAndConnected && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({liveProgress.completedModels}/{liveProgress.totalModels}{" "}
                    complete)
                  </span>
                )}
              </CardTitle>
              <CardDescription>
                {liveProgress.totalModels} models running in parallel -- each
                has its own subprocess
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {liveProgress.modelStatusArray.map((ms) => {
                  // Calculate per-model runs from live data
                  const modelRuns = liveProgress.runs.filter(
                    (r) => r.model === ms.modelKey,
                  );
                  const modelSolved = modelRuns.filter((r) => r.solved).length;
                  const modelAvgScore =
                    modelRuns.length > 0
                      ? (
                          (modelRuns.reduce((s, r) => s + r.final_score, 0) /
                            modelRuns.length) *
                          100
                        ).toFixed(0)
                      : null;

                  return (
                    <div
                      key={ms.modelKey}
                      className="relative border rounded-lg p-3 space-y-2"
                    >
                      {/* Color bar at top */}
                      <div
                        className={`absolute top-0 left-0 right-0 h-1 rounded-t-lg ${getModelColor(ms.modelKey)}`}
                      />

                      {/* Model name + status */}
                      <div className="flex items-center justify-between pt-1">
                        <span
                          className="text-sm font-semibold truncate"
                          title={ms.modelKey}
                        >
                          {ms.modelKey}
                        </span>
                        {getModelStatusBadge(ms.status)}
                      </div>

                      {/* Live stats */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div>
                          <span className="text-muted-foreground">Steps:</span>{" "}
                          <span className="font-mono">{ms.stepCount}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Runs:</span>{" "}
                          <span className="font-mono">{ms.runCount}</span>
                        </div>
                        {ms.latestScore !== null && (
                          <div>
                            <span className="text-muted-foreground">
                              Score:
                            </span>{" "}
                            <span className="font-mono">
                              {(ms.latestScore * 100).toFixed(0)}%
                            </span>
                          </div>
                        )}
                        {modelRuns.length > 0 && (
                          <div>
                            <span className="text-muted-foreground">
                              Solved:
                            </span>{" "}
                            <span className="font-mono">
                              {modelSolved}/{modelRuns.length}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Avg score when runs exist */}
                      {modelAvgScore !== null && (
                        <div className="text-xs text-muted-foreground">
                          Avg: {modelAvgScore}%
                        </div>
                      )}

                      {/* Progress animation for running models */}
                      {ms.status === "running" && (
                        <div className="h-0.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 animate-pulse rounded-full"
                            style={{ width: "60%" }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

      {/* Error state */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-destructive">
            {error instanceof Error
              ? error.message
              : "Failed to load evaluation data"}
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          Loading evaluation data...
        </div>
      )}

      {/* No data state */}
      {!isLoading &&
        effectiveRuns.length === 0 &&
        !showStartForm &&
        !hasParallelModels && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <p className="text-lg mb-2">No evaluation data found</p>
              <p className="text-sm mb-4">
                Click "Start Eval" above or run the harness manually:
              </p>
              <code className="bg-muted px-3 py-1.5 rounded text-xs">
                python -m scripts.evaluate.evaluate --game cc01 --models all
                --stdout-jsonl
              </code>
            </CardContent>
          </Card>
        )}

      {/* Charts */}
      {!isLoading && effectiveRuns.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Score Over Steps</CardTitle>
              <CardDescription>
                How score progresses per step (mean + range across runs)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScoreOverStepsChart steps={effectiveSteps as StepRaw[]} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Score vs Cost</CardTitle>
              <CardDescription>
                Each dot = one run. Higher is better, left is cheaper.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScoreVsCostChart runs={effectiveRuns as RunRaw[]} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Summary stats */}
      {stats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Summary{selectedGame ? ` -- ${selectedGame}` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-2xl font-bold">{stats.totalRuns}</p>
                <p className="text-xs text-muted-foreground">Total Runs</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.models}</p>
                <p className="text-xs text-muted-foreground">Models</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.avgScore}%</p>
                <p className="text-xs text-muted-foreground">Avg Score</p>
              </div>
              <div>
                <p className="text-2xl font-bold">${stats.avgCost}</p>
                <p className="text-xs text-muted-foreground">Avg Cost/Run</p>
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {stats.solvedCount}/{stats.totalRuns}
                </p>
                <p className="text-xs text-muted-foreground">
                  Solved ({stats.solvedPct}%)
                </p>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <p className="text-sm font-medium">Models evaluated:</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {stats.modelNames.map((m) => (
                    <span
                      key={m}
                      className="inline-block px-2 py-0.5 rounded text-xs bg-muted text-muted-foreground"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Run history table */}
      {effectiveRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Run History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4">Score</th>
                    <th className="pb-2 pr-4">Steps</th>
                    <th className="pb-2 pr-4">Cost</th>
                    <th className="pb-2 pr-4">Solved</th>
                  </tr>
                </thead>
                <tbody>
                  {effectiveRuns.slice(0, 50).map((r) => (
                    <tr key={r.run_id} className="border-b border-border/50">
                      <td className="py-1.5 pr-4 font-medium">{r.model}</td>
                      <td className="py-1.5 pr-4">
                        {(r.final_score * 100).toFixed(1)}%
                      </td>
                      <td className="py-1.5 pr-4">{r.total_steps}</td>
                      <td className="py-1.5 pr-4">${r.cost_usd.toFixed(4)}</td>
                      <td className="py-1.5 pr-4">{r.solved ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
