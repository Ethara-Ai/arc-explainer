import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ---- Types ----

export interface EvalSession {
  id: string;
  status: string;
  game_ids: string;
  model_keys: string;
  num_runs: number;
  max_steps: number;
  seed_base: number;
  total_runs: number | null;
  total_steps: number | null;
  total_cost_usd: string | null;
  started_at: string;
  completed_at: string | null;
}

/** Alias used by EvalOverview — same shape as EvalSession */
export type EvalSessionRow = EvalSession;

export interface EvalRun {
  id: string;
  session_id: string;
  model: string;
  model_key: string;
  game_id: string;
  game_type: string;
  run_number: number;
  seed: number;
  total_steps: number;
  max_steps: number;
  final_score: number | null;
  solved: boolean;
  levels_completed: number | null;
  total_levels: number | null;
  cost_usd: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  elapsed_seconds: number | null;
  error: string | null;
  created_at: string;
}

/** Alias used by EvalOverview — same shape as EvalRun */
export type EvalRunRow = EvalRun;

export interface EvalStep {
  id: number;
  run_id: string;
  step: number;
  action: string;
  score: number | null;
  level: number | null;
  total_levels: number | null;
  state: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  cumulative_cost_usd: number | null;
  created_at: string;
}

export interface EvalGame {
  game_id: string;
  game_type: string;
  title: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

async function fetchEvalApi<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
  if (!json.success) throw new Error("API returned unsuccessful response");
  return json.data;
}

// ---- Hooks ----

export function useEvalSessions(limit = 20) {
  return useQuery({
    queryKey: ["eval-sessions", limit],
    queryFn: async () => {
      // Use file-based endpoint — no database dependency.
      // Adapt FileEvalSession[] to the shape the dashboard expects.
      const result = await fetchEvalApi<{ sessions: FileEvalSession[] }>(
        "/api/eval/file-sessions",
      );
      const sessions: EvalSession[] = result.sessions
        .slice(0, limit)
        .map((fs) => {
          const allRuns = fs.games.flatMap((g) => g.runs);
          const totalCost = allRuns.reduce(
            (sum, r) => sum + Number(r.cost_usd ?? r.costUsd ?? 0),
            0,
          );
          return {
            id: fs.dir,
            status: "completed",
            game_ids: fs.games.map((g) => g.gameId).join(","),
            model_keys: "",
            num_runs: allRuns.length,
            max_steps: 0,
            seed_base: 0,
            total_runs: allRuns.length,
            total_steps: null,
            total_cost_usd: totalCost > 0 ? totalCost.toFixed(6) : null,
            started_at: fs.timestamp,
            completed_at: null,
          };
        });
      return { sessions, activeSessions: [] as string[] };
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function useEvalRuns(
  filters: { sessionId?: string; gameId?: string; model?: string } = {},
) {
  const params = new URLSearchParams();
  if (filters.sessionId) params.set("sessionId", filters.sessionId);
  if (filters.gameId) params.set("gameId", filters.gameId);
  if (filters.model) params.set("model", filters.model);
  const qs = params.toString();

  return useQuery({
    queryKey: ["eval-runs", filters],
    queryFn: async () => {
      const result = await fetchEvalApi<{ runs: EvalRun[] }>(
        `/api/eval/runs${qs ? `?${qs}` : ""}`,
      );
      return result.runs;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function useEvalSteps(runId: string | null) {
  return useQuery({
    queryKey: ["eval-steps", runId],
    queryFn: async () => {
      const result = await fetchEvalApi<{ steps: EvalStep[] }>(
        `/api/eval/runs/${runId}/steps`,
      );
      return result.steps;
    },
    enabled: !!runId,
    staleTime: 30_000,
    retry: 1,
  });
}

/** Fetch steps for multiple runs in parallel (capped at maxRuns to avoid request storms). */
export function useEvalMultiRunSteps(runIds: string[], maxRuns = 20) {
  const capped = runIds.slice(0, maxRuns);
  return useQueries({
    queries: capped.map((runId) => ({
      queryKey: ["eval-steps", runId],
      queryFn: async () => {
        const result = await fetchEvalApi<{ steps: EvalStep[] }>(
          `/api/eval/runs/${runId}/steps`,
        );
        return result.steps;
      },
      staleTime: 30_000,
      retry: 1,
    })),
  });
}

export function useEvalGames() {
  return useQuery({
    queryKey: ["eval-games"],
    queryFn: async () => {
      const result = await fetchEvalApi<{ games: EvalGame[] }>(
        "/api/eval/games",
      );
      return result.games;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useAllEvalRuns(limit = 500) {
  return useQuery({
    queryKey: ["eval", "all-runs", limit],
    queryFn: async () => {
      const result = await fetchEvalApi<{ runs: EvalRun[] }>(
        `/api/eval/runs?limit=${limit}`,
      );
      return result.runs;
    },
    staleTime: 30_000,
    retry: 1,
    refetchInterval: 15_000,
  });
}

export interface EvalModel {
  key: string;
  name: string;
  provider: string;
  supportsVision?: boolean;
}

export function useEvalModels() {
  return useQuery({
    queryKey: ["eval-models"],
    queryFn: async () => {
      const result = await fetchEvalApi<{ models: EvalModel[] }>(
        "/api/eval/models",
      );
      return result.models;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useStartEval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: {
      gameIds: string[];
      modelKeys: string[];
      numRuns?: number;
      maxSteps?: number;
      contextWindow?: number;
      seedBase?: number;
      parallelGames?: number;
      parallelRuns?: number;
      sequentialModels?: boolean;
      budgetGlobalUsd?: number | null;
      budgetPerGameUsd?: number | null;
    }) => {
      const res = await apiRequest("POST", "/api/eval/start", config);
      const json = await res.json();
      return json.data as { sessionId: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["eval-sessions"] });
    },
  });
}

export function useCancelEval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiRequest("POST", `/api/eval/cancel/${sessionId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["eval-sessions"] });
    },
  });
}

// ---- File-based eval types & hooks ----

export interface FileEvalGame {
  gameId: string;
  runs: Record<string, unknown>[];
  traceFiles: string[];
}

export interface FileEvalSession {
  dir: string;
  timestamp: string;
  games: FileEvalGame[];
}

export interface FileTraceRecord {
  type: "header" | "step" | "summary";
  [key: string]: unknown;
}

export function useFileEvalSessions() {
  return useQuery({
    queryKey: ["eval", "file-sessions"],
    queryFn: () =>
      fetchEvalApi<{ sessions: FileEvalSession[] }>("/api/eval/file-sessions"),
    staleTime: 30_000,
    retry: 1,
  });
}

export interface FileTraceParams {
  dir: string;
  gameId: string;
  model: string;
  run: number;
}

export function useFileTrace(params: FileTraceParams | null) {
  return useQuery({
    queryKey: ["eval", "file-trace", params],
    queryFn: () => {
      const p = params!;
      const qs = new URLSearchParams({
        dir: p.dir,
        gameId: p.gameId,
        model: p.model,
        run: String(p.run),
      });
      return fetchEvalApi<{ records: FileTraceRecord[]; tracePath: string }>(
        `/api/eval/file-trace?${qs}`,
      );
    },
    enabled: !!params,
    staleTime: 30_000,
    retry: 1,
  });
}
