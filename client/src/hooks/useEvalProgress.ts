import { useState, useEffect, useRef, useCallback } from "react";

export interface StepEvent {
  type: "step";
  session_id: string;
  run_id: string;
  model: string;
  model_key: string;
  game_id: string;
  game_type: string;
  run_number: number;
  step: number;
  action: string;
  score: number;
  score_pct: number;
  level: number | null;
  total_levels: number | null;
  done: boolean;
  state: string;
  grid?: number[][] | number[][][] | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  step_cost_usd: number;
  cumulative_cost_usd: number;
  reasoning?: string;
  notepad_contents?: string;
  timestamp: string;
}

export interface RunEvent {
  type: "run_end";
  session_id: string;
  run_id: string;
  model: string;
  model_key: string;
  game_id: string;
  game_type: string;
  run_number: number;
  total_steps: number;
  final_score: number;
  final_score_pct: number;
  solved: boolean;
  levels_completed: number | null;
  total_levels: number | null;
  cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  elapsed_seconds: number;
  error: string | null;
  timestamp: string;
}

export interface ModelDoneEvent {
  type: "model_done";
  model_key: string;
  status: "completed" | "failed";
  exit_code?: number;
  error?: string;
  completed_models: number;
  total_models: number;
}

export interface ModelStatus {
  modelKey: string;
  status: "running" | "completed" | "failed";
  stepCount: number;
  runCount: number;
  latestScore: number | null;
  latestStep: number | null;
}

type StreamStatus = "idle" | "connecting" | "connected" | "completed" | "error";

interface EvalProgressState {
  steps: StepEvent[];
  runs: RunEvent[];
  status: StreamStatus;
  error: string | null;
  logs: Array<{ level: string; message: string; timestamp: string }>;
  // Parallel model tracking
  modelStatuses: Map<string, ModelStatus>;
  totalModels: number;
  completedModels: number;
  allModelKeys: string[];
}

export function useEvalProgress(sessionId: string | null) {
  const [state, setState] = useState<EvalProgressState>({
    steps: [],
    runs: [],
    status: "idle",
    error: null,
    logs: [],
    modelStatuses: new Map(),
    totalModels: 0,
    completedModels: 0,
    allModelKeys: [],
  });
  const esRef = useRef<EventSource | null>(null);

  const reset = useCallback(() => {
    setState({
      steps: [],
      runs: [],
      status: "idle",
      error: null,
      logs: [],
      modelStatuses: new Map(),
      totalModels: 0,
      completedModels: 0,
      allModelKeys: [],
    });
  }, []);

  useEffect(() => {
    if (!sessionId) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      return;
    }

    setState((prev) => ({
      ...prev,
      status: "connecting",
      steps: [],
      runs: [],
      logs: [],
      modelStatuses: new Map(),
      totalModels: 0,
      completedModels: 0,
      allModelKeys: [],
    }));

    console.log(
      `[useEvalProgress] Creating EventSource for session=${sessionId}`,
    );
    const es = new EventSource(`/api/eval/stream/${sessionId}`);
    esRef.current = es;

    es.onopen = () => {
      console.log(`[useEvalProgress] SSE CONNECTED for session=${sessionId}`);
      setState((prev) => ({ ...prev, status: "connected" }));
    };

    // Session start -- initialize per-model tracking
    es.addEventListener("eval.session_start", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        console.log("[useEvalProgress] << eval.session_start", {
          session_id: data.session_id,
          parallel: data.parallel,
          models: data.models,
          model_keys: data.model_keys,
          keys: Object.keys(data),
        });
        if (data.parallel && data.models) {
          const models: string[] = data.models;
          const newStatuses = new Map<string, ModelStatus>();
          for (const mk of models) {
            newStatuses.set(mk, {
              modelKey: mk,
              status: "running",
              stepCount: 0,
              runCount: 0,
              latestScore: null,
              latestStep: null,
            });
          }
          setState((prev) => ({
            ...prev,
            modelStatuses: newStatuses,
            totalModels: models.length,
            allModelKeys: models,
          }));
        }
      } catch (err) {
        console.warn("[useEvalProgress] parse error in session_start:", err);
      }
    });

    es.addEventListener("eval.step", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as StepEvent;
        console.log("[useEvalProgress] << eval.step", {
          run_id: data.run_id,
          model: data.model,
          game_id: data.game_id,
          step: data.step,
          action: data.action,
          score: data.score,
          state: data.state,
          hasGrid: !!data.grid,
          gridShape: data.grid
            ? `${Array.isArray(data.grid) ? data.grid.length : "?"}`
            : "none",
          done: data.done,
        });
        setState((prev) => {
          // Update per-model stats — use model_key to match session_start keys
          const newStatuses = new Map(prev.modelStatuses);
          const modelKey = data.model_key ?? data.model;
          const existing = newStatuses.get(modelKey);
          if (existing) {
            newStatuses.set(modelKey, {
              ...existing,
              stepCount: existing.stepCount + 1,
              latestScore: data.score,
              latestStep: data.step,
            });
          }
          return {
            ...prev,
            steps: [...prev.steps, data],
            modelStatuses: newStatuses,
          };
        });
      } catch (err) {
        console.warn("[useEvalProgress] parse error in step:", err);
      }
    });

    es.addEventListener("eval.run_start", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        console.log("[useEvalProgress] << eval.run_start", {
          run_id: data.run_id,
          model: data.model,
          game_id: data.game_id,
          run_number: data.run_number,
          max_steps: data.max_steps,
        });
      } catch (err) {
        console.warn("[useEvalProgress] parse error in run_start:", err);
      }
    });

    es.addEventListener("eval.run_end", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as RunEvent;
        console.log("[useEvalProgress] << eval.run_end", {
          run_id: data.run_id,
          model: data.model,
          game_id: data.game_id,
          final_score: data.final_score,
          solved: data.solved,
          total_steps: data.total_steps,
          cost_usd: data.cost_usd,
        });
        setState((prev) => {
          const newStatuses = new Map(prev.modelStatuses);
          const modelKey = data.model_key ?? data.model;
          const existing = newStatuses.get(modelKey);
          if (existing) {
            newStatuses.set(modelKey, {
              ...existing,
              runCount: existing.runCount + 1,
            });
          }
          return {
            ...prev,
            runs: [...prev.runs, data],
            modelStatuses: newStatuses,
          };
        });
      } catch (err) {
        console.warn("[useEvalProgress] parse error in run_end:", err);
      }
    });

    // Per-model completion
    es.addEventListener("eval.model_done", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as ModelDoneEvent;
        setState((prev) => {
          const newStatuses = new Map(prev.modelStatuses);
          const existing = newStatuses.get(data.model_key);
          if (existing) {
            newStatuses.set(data.model_key, {
              ...existing,
              status: data.status,
            });
          }
          return {
            ...prev,
            modelStatuses: newStatuses,
            completedModels: data.completed_models,
          };
        });
      } catch (err) {
        console.warn("[useEvalProgress] parse error in model_done:", err);
      }
    });

    es.addEventListener("eval.error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const msg = data.message || "Unknown eval error";
        setState((prev) => {
          const newStatuses = new Map(prev.modelStatuses);
          if (data.model) {
            const existing = newStatuses.get(data.model);
            if (existing) {
              newStatuses.set(data.model, { ...existing, status: "failed" });
            }
          }
          return {
            ...prev,
            error: msg,
            modelStatuses: newStatuses,
            logs: [
              ...prev.logs,
              {
                level: "error",
                message: msg,
                timestamp: data.timestamp || new Date().toISOString(),
              },
            ],
          };
        });
      } catch (err) {
        console.warn("[useEvalProgress] parse error in eval.error:", err);
      }
    });

    es.addEventListener("eval.log", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setState((prev) => ({
          ...prev,
          logs: [
            ...prev.logs,
            {
              level: data.level || "info",
              message: data.message || "",
              timestamp: data.timestamp || new Date().toISOString(),
            },
          ],
        }));
      } catch (err) {
        console.warn("[useEvalProgress] parse error in eval.log:", err);
      }
    });

    es.addEventListener("eval.session_end", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        console.log("[useEvalProgress] << eval.session_end", data);
      } catch {
        console.log(
          "[useEvalProgress] << eval.session_end (no parseable data)",
        );
      }
      setState((prev) => ({ ...prev, status: "completed" }));
      es.close();
    });

    es.addEventListener("stream.end", () => {
      setState((prev) => ({
        ...prev,
        status: prev.status === "connected" ? "completed" : prev.status,
      }));
      es.close();
    });

    es.addEventListener("stream.error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setState((prev) => ({
          ...prev,
          status: "error",
          error: data.message || "Stream error",
        }));
      } catch {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: "Stream error",
        }));
      }
      es.close();
    });

    // Catch-all: log any event type we don't have a specific handler for
    es.onmessage = (e: MessageEvent) => {
      console.log(
        "[useEvalProgress] << UNHANDLED message event:",
        e.data?.slice?.(0, 200),
      );
    };

    es.onerror = () => {
      console.warn("[useEvalProgress] SSE ERROR event", {
        readyState: es.readyState,
        readyStateLabel:
          es.readyState === EventSource.CONNECTING
            ? "CONNECTING"
            : es.readyState === EventSource.OPEN
              ? "OPEN"
              : "CLOSED",
      });
      // EventSource auto-reconnects on error; only mark error if closed
      if (es.readyState === EventSource.CLOSED) {
        setState((prev) => {
          if (prev.status === "completed") return prev;
          return { ...prev, status: "error", error: "Connection lost" };
        });
      }
    };

    return () => {
      console.log(
        `[useEvalProgress] Cleanup: closing EventSource for session=${sessionId}`,
      );
      es.close();
      esRef.current = null;
    };
  }, [sessionId]);

  // Convert Map to array for easier consumption in components
  const modelStatusArray = Array.from(state.modelStatuses.values());

  return {
    ...state,
    modelStatusArray,
    reset,
  };
}
