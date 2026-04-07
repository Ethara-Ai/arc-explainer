/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Multi-session agent stream hook for ARC3 Playground.
 *          Manages N concurrent SSE sessions (one per model+game pair),
 *          with per-session state (frames, reasoning, notepad) and shared logs.
 *          Reuses the existing /api/arc3/stream/prepare + EventSource pattern.
 * SRP/DRY check: Pass — encapsulates all multi-session SSE orchestration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import {
  applyArc3ActionExecuted,
  applyArc3FrameUpdate,
  type Arc3FrameAction,
} from "@/lib/arc3StreamFrameState";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FrameData {
  guid?: string;
  game_id?: string;
  frame: number[][][];
  score: number;
  state: string;
  action_counter: number;
  max_actions: number;
  full_reset: boolean;
  win_score?: number;
  available_actions?: (string | number)[];
  action?: Arc3FrameAction;
}

export interface TimelineEntry {
  index: number;
  type: "assistant_message" | "tool_call" | "tool_result" | "reasoning";
  label: string;
  content: string;
}

export interface CostSnapshot {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  stepCount: number;
}

export interface AgentSession {
  id: string; // `${modelKey}::${gameId}::${runIndex}`
  modelKey: string;
  modelName: string;
  modelColor: string;
  gameId: string;
  runIndex: number; // 0-based run number
  status: "idle" | "starting" | "running" | "completed" | "error";
  sseSessionId?: string; // backend streaming session ID
  gameGuid?: string;
  frames: FrameData[];
  currentFrameIndex: number;
  timeline: TimelineEntry[];
  streamingReasoning?: string;
  streamingMessage?: string;
  notepad: string;
  error?: string;
  turnCount: number;
  stepCount: number; // actions executed (for maxSteps enforcement)
  summary?: any;
  usage?: any;
  cost?: CostSnapshot; // Per-step cost tracking from StepLoopEngine
  retrying?: { attempt: number; maxAttempts: number; tier: string }; // Active retry info
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
}

export interface ModelInfo {
  key: string;
  name: string;
  color: string;
  provider: string;
}

export interface MultiAgentConfig {
  games: string[];
  models: ModelInfo[];
  runsPerGame: number;
  maxSteps: number;
  systemPrompt: string;
  instructions: string;
  reasoningEffort: string;
  maxTurns: number;
  systemPromptPresetId: string;
  skipDefaultSystemPrompt: boolean;
  apiKey?: string;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useMultiAgentStream(apiPrefix: string = "/api/arc3") {
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [globalStatus, setGlobalStatus] = useState<
    "idle" | "running" | "completed" | "cancelled" | "error"
  >("idle");

  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
  const activeCountRef = useRef(0);
  const totalCountRef = useRef(0);

  /* ---- helpers ---- */

  const addLog = useCallback(
    (level: LogEntry["level"], source: string, message: string) => {
      setLogs((prev) => [
        ...prev,
        { timestamp: Date.now(), level, source, message },
      ]);
    },
    [],
  );

  const updateSession = useCallback(
    (id: string, updater: (s: AgentSession) => AgentSession) => {
      setSessions((prev) => {
        const session = prev[id];
        if (!session) return prev;
        return { ...prev, [id]: updater(session) };
      });
    },
    [],
  );

  const appendNotepad = useCallback(
    (id: string, line: string) => {
      updateSession(id, (s) => ({
        ...s,
        notepad: s.notepad ? `${s.notepad}\n${line}` : line,
      }));
    },
    [updateSession],
  );

  const closeEventSource = useCallback((key: string) => {
    const es = eventSourcesRef.current.get(key);
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
      eventSourcesRef.current.delete(key);
    }
  }, []);

  const closeAll = useCallback(() => {
    for (const [key] of eventSourcesRef.current) {
      closeEventSource(key);
    }
  }, [closeEventSource]);

  // Cleanup all EventSources on unmount to prevent leaks
  useEffect(() => {
    return () => {
      for (const [, es] of eventSourcesRef.current) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
      eventSourcesRef.current.clear();
    };
  }, []);

  // Track session completion to determine global status
  const markSessionDone = useCallback(() => {
    activeCountRef.current -= 1;
    if (activeCountRef.current <= 0) {
      setGlobalStatus("completed");
    }
  }, []);

  /* ---- attach SSE event listeners for one session ---- */

  const attachListeners = useCallback(
    (
      es: EventSource,
      sessionKey: string,
      modelName: string,
      gameId: string,
      runIndex: number,
      maxSteps: number,
    ) => {
      const src = `${modelName} / ${gameId} / R${runIndex + 1}`;

      es.addEventListener("stream.init", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            status: "running",
            streamingMessage: "Initialized",
          }));
          addLog(
            "info",
            src,
            `Session initialized (game: ${p.gameId || gameId})`,
          );
        } catch {
          /* ignore parse errors */
        }
      });

      es.addEventListener("stream.status", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: p.message || s.streamingMessage,
          }));
          addLog("info", src, p.message || "Status update");
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.starting", (evt) => {
        try {
          JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            status: "running",
            streamingMessage: "Agent analyzing...",
          }));
          addLog("info", src, "Agent starting");
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.ready", () => {
        addLog("info", src, "Agent ready");
      });

      es.addEventListener("agent.tool_call", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: `Called ${p.tool}`,
            timeline: [
              ...s.timeline,
              {
                index: s.timeline.length,
                type: "tool_call" as const,
                label: `Agent called ${p.tool}`,
                content: JSON.stringify(p.arguments, null, 2),
              },
            ],
          }));
          addLog(
            "info",
            src,
            `Tool: ${p.tool}(${JSON.stringify(p.arguments || {}).slice(0, 80)})`,
          );
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.tool_result", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: `Result from ${p.tool}`,
            timeline: [
              ...s.timeline,
              {
                index: s.timeline.length,
                type: "tool_result" as const,
                label: `Result from ${p.tool}`,
                content: JSON.stringify(p.result, null, 2),
              },
            ],
          }));
          addLog("info", src, `Result: ${p.tool}`);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.reasoning", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: "Reasoning...",
            streamingReasoning: p.content || "",
          }));
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.reasoning_complete", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          const content = p.finalContent || "";
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingReasoning: content,
            timeline: [
              ...s.timeline,
              {
                index: s.timeline.length,
                type: "reasoning" as const,
                label: "Reasoning",
                content,
              },
            ],
          }));
          addLog("info", src, `Reasoning complete (${content.length} chars)`);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.message", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: "Agent message",
            timeline: [
              ...s.timeline,
              {
                index: s.timeline.length,
                type: "assistant_message" as const,
                label: `${p.agentName || modelName}`,
                content: p.content,
              },
            ],
          }));
          appendNotepad(
            sessionKey,
            `[Message] ${(p.content || "").slice(0, 200)}`,
          );
          addLog("info", src, `Message: ${(p.content || "").slice(0, 100)}`);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.loop_hint", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: p.message || "Rethinking strategy...",
            timeline: [
              ...s.timeline,
              {
                index: s.timeline.length,
                type: "assistant_message" as const,
                label: "Loop hint",
                content:
                  p.message || "No score change; trying alternate strategy.",
              },
            ],
          }));
          addLog("warn", src, p.message || "Loop detected");
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("game.started", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            streamingMessage: "Game started",
            frames: [...s.frames, p.initialFrame],
            currentFrameIndex: s.frames.length,
          }));
          appendNotepad(
            sessionKey,
            `[Start] Score: ${p.initialFrame?.score ?? 0}`,
          );
          addLog(
            "info",
            src,
            `Game started (score: ${p.initialFrame?.score ?? 0})`,
          );
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("game.action_executed", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => {
            const newStepCount = s.stepCount + 1;
            const frameState = applyArc3ActionExecuted(
              {
                frames: s.frames,
                currentFrameIndex: s.currentFrameIndex,
              },
              { newFrame: p.newFrame },
            );
            // Enforce maxSteps: if reached, mark as completed and close
            if (maxSteps > 0 && newStepCount >= maxSteps) {
              addLog("warn", src, `Max steps (${maxSteps}) reached — stopping`);
              appendNotepad(
                sessionKey,
                `\n--- MAX STEPS (${maxSteps}) REACHED ---\nScore: ${p.newFrame?.score ?? p.score ?? "?"}, State: ${p.newFrame?.state ?? p.state ?? "?"}`,
              );
              setTimeout(() => {
                closeEventSource(sessionKey);
                markSessionDone();
              }, 0);
              return {
                ...s,
                status: "completed",
                streamingMessage: `Max steps reached (${maxSteps})`,
                frames: [...frameState.frames],
                currentFrameIndex: frameState.currentFrameIndex,
                turnCount: s.turnCount + 1,
                stepCount: newStepCount,
              };
            }
            return {
              ...s,
              streamingMessage: `Executed ${p.action}`,
              frames: [...frameState.frames],
              currentFrameIndex: frameState.currentFrameIndex,
              turnCount: s.turnCount + 1,
              stepCount: newStepCount,
            };
          });
          appendNotepad(
            sessionKey,
            `[${p.action}] Score: ${p.newFrame?.score ?? p.score ?? "?"}, State: ${p.newFrame?.state ?? p.state ?? "?"}`,
          );
          addLog(
            "info",
            src,
            `Action: ${p.action} -> score=${p.newFrame?.score ?? p.score ?? "?"} state=${p.newFrame?.state ?? p.state ?? "?"}`,
          );
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("game.frame_update", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => {
            const frameState = applyArc3FrameUpdate(
              {
                frames: s.frames,
                currentFrameIndex: s.currentFrameIndex,
              },
              {
                frameIndex: p.frameIndex,
                frameData: p.frameData,
                action: p.action,
              },
            );

            return {
              ...s,
              frames: [...frameState.frames],
              currentFrameIndex: frameState.currentFrameIndex,
            };
          });
        } catch {
          /* ignore */
        }
      });

      // ── Cost tracking (Phase 2) ──────────────────────────────────
      es.addEventListener("agent.cost_update", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            cost: {
              totalCostUsd: p.totalCostUsd ?? 0,
              totalInputTokens: p.totalInputTokens ?? 0,
              totalOutputTokens: p.totalOutputTokens ?? 0,
              totalReasoningTokens: p.totalReasoningTokens ?? 0,
              totalCachedInputTokens: p.totalCachedInputTokens ?? 0,
              totalCacheWriteTokens: p.totalCacheWriteTokens ?? 0,
              stepCount: p.stepCount ?? 0,
            },
          }));
        } catch {
          /* ignore */
        }
      });

      // ── Retry events (Phase 5) ─────────────────────────────────
      es.addEventListener("agent.retry", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            retrying: {
              attempt: p.attempt,
              maxAttempts: p.maxAttempts,
              tier: p.tier,
            },
          }));
          addLog(
            "warn",
            src,
            `Retry ${p.attempt}/${p.maxAttempts} (${p.tier}): waiting ${Math.round((p.waitMs || 0) / 1000)}s`,
          );
        } catch {
          /* ignore */
        }
      });

      // ── Notepad updates (Phase 3) ──────────────────────────────
      es.addEventListener("agent.notepad_updated", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          if (p.content != null) {
            updateSession(sessionKey, (s) => ({
              ...s,
              notepad: String(p.content),
            }));
          }
        } catch {
          /* ignore */
        }
      });

      // ── Step recorded (Phase 4) ────────────────────────────────
      es.addEventListener("agent.step_recorded", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          // Clear retry indicator after successful step
          updateSession(sessionKey, (s) => ({
            ...s,
            retrying: undefined,
          }));
          addLog(
            "info",
            src,
            `Step ${p.step}: ${p.action} → score=${p.score} ($${(p.cumulativeCostUsd ?? 0).toFixed(4)})`,
          );
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("agent.completed", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            status: "completed",
            streamingMessage: "Completed",
            gameGuid: p.gameGuid || s.gameGuid,
            summary: p.summary,
            usage: p.usage,
            retrying: undefined,
          }));
          const score = p.summary?.score ?? "?";
          const state = p.summary?.state ?? "done";
          appendNotepad(
            sessionKey,
            `\n--- COMPLETED ---\nFinal Score: ${score}\nState: ${state}\nSteps: ${p.summary?.stepsTaken ?? "?"}`,
          );
          addLog("info", src, `Completed: score=${score} state=${state}`);
        } catch {
          /* ignore */
        }
        closeEventSource(sessionKey);
        markSessionDone();
      });

      es.addEventListener("stream.complete", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            status: s.status === "completed" ? s.status : "completed",
            streamingMessage: "Stream done",
            summary: p.summary || s.summary,
            usage: p.usage || s.usage,
          }));
          addLog("info", src, "Stream complete");
        } catch {
          /* ignore */
        }
        closeEventSource(sessionKey);
        markSessionDone();
      });

      es.addEventListener("stream.error", (evt) => {
        try {
          const p = JSON.parse((evt as MessageEvent).data);
          updateSession(sessionKey, (s) => ({
            ...s,
            status: "error",
            streamingMessage: p.message || "Error",
            error: p.message || "Unknown error",
          }));
          addLog("error", src, p.message || "Stream error");
        } catch {
          /* ignore */
        }
        closeEventSource(sessionKey);
        markSessionDone();
      });

      es.onerror = () => {
        updateSession(sessionKey, (s) => ({
          ...s,
          status: "error",
          streamingMessage: "Connection lost",
          error: "Connection lost",
        }));
        addLog("error", src, "EventSource connection lost");
        closeEventSource(sessionKey);
        markSessionDone();
      };
    },
    [updateSession, addLog, appendNotepad, closeEventSource, markSessionDone],
  );

  /* ---- start a single session ---- */

  const startSession = useCallback(
    async (
      sessionKey: string,
      modelInfo: ModelInfo,
      gameId: string,
      runIndex: number,
      config: MultiAgentConfig,
    ) => {
      const src = `${modelInfo.name} / ${gameId} / R${runIndex + 1}`;

      try {
        updateSession(sessionKey, (s) => ({
          ...s,
          status: "starting",
          streamingMessage: "Preparing...",
        }));
        addLog("info", src, "Preparing session...");

        const resp = await apiRequest("POST", `${apiPrefix}/stream/prepare`, {
          game_id: gameId,
          agentName: `${modelInfo.name} Agent`,
          systemPrompt: config.systemPrompt,
          instructions: config.instructions,
          model: modelInfo.key,
          maxTurns: config.maxTurns,
          reasoningEffort: config.reasoningEffort,
          systemPromptPresetId: config.systemPromptPresetId,
          skipDefaultSystemPrompt: config.skipDefaultSystemPrompt,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });

        const data = await resp.json();
        const sseSessionId = data.data?.sessionId;

        if (!sseSessionId) {
          throw new Error("No sessionId returned from prepare");
        }

        updateSession(sessionKey, (s) => ({ ...s, sseSessionId }));
        addLog(
          "info",
          src,
          `Session prepared (${sseSessionId.slice(0, 8)}...)`,
        );

        // Open EventSource
        const es = new EventSource(`${apiPrefix}/stream/${sseSessionId}`);
        eventSourcesRef.current.set(sessionKey, es);
        attachListeners(
          es,
          sessionKey,
          modelInfo.name,
          gameId,
          runIndex,
          config.maxSteps,
        );
      } catch (err: any) {
        const msg = err?.message || "Failed to start session";
        updateSession(sessionKey, (s) => ({
          ...s,
          status: "error",
          error: msg,
          streamingMessage: msg,
        }));
        addLog("error", src, msg);
        markSessionDone();
      }
    },
    [updateSession, addLog, attachListeners, markSessionDone],
  );

  /* ---- public API ---- */

  const startAll = useCallback(
    async (config: MultiAgentConfig) => {
      // Close any existing
      closeAll();

      const runsPerGame = Math.max(1, config.runsPerGame);

      // Build session records: model x game x run
      const newSessions: Record<string, AgentSession> = {};
      const pairs: Array<{
        key: string;
        model: ModelInfo;
        gameId: string;
        runIndex: number;
      }> = [];

      for (const model of config.models) {
        for (const gameId of config.games) {
          for (let r = 0; r < runsPerGame; r++) {
            const key = `${model.key}::${gameId}::${r}`;
            newSessions[key] = {
              id: key,
              modelKey: model.key,
              modelName: model.name,
              modelColor: model.color,
              gameId,
              runIndex: r,
              status: "idle",
              frames: [],
              currentFrameIndex: 0,
              timeline: [],
              notepad: "",
              turnCount: 0,
              stepCount: 0,
            };
            pairs.push({ key, model, gameId, runIndex: r });
          }
        }
      }

      totalCountRef.current = pairs.length;
      activeCountRef.current = pairs.length;

      setSessions(newSessions);
      setLogs([]);
      setGlobalStatus("running");

      addLog(
        "info",
        "system",
        `Starting ${pairs.length} sessions (${config.models.length} models x ${config.games.length} games x ${runsPerGame} runs, max ${config.maxSteps} steps/run)`,
      );

      // Fire all in parallel
      await Promise.allSettled(
        pairs.map((p) =>
          startSession(p.key, p.model, p.gameId, p.runIndex, config),
        ),
      );
    },
    [closeAll, addLog, startSession],
  );

  const cancelAll = useCallback(async () => {
    // Notify backend to abort in-flight LLM calls for each active session
    const activeSessions = Object.values(sessions).filter(
      (s) =>
        (s.status === "running" || s.status === "starting") && s.sseSessionId,
    );
    for (const s of activeSessions) {
      apiRequest("POST", `${apiPrefix}/stream/cancel/${s.sseSessionId}`).catch(
        () => {
          /* best-effort */
        },
      );
    }

    closeAll();

    setSessions((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].status === "running" || next[key].status === "starting") {
          next[key] = {
            ...next[key],
            status: "error",
            error: "Cancelled",
            streamingMessage: "Cancelled",
          };
        }
      }
      return next;
    });

    setGlobalStatus("cancelled");
    addLog("warn", "system", "All sessions cancelled");
  }, [closeAll, addLog, sessions, apiPrefix]);

  const reset = useCallback(() => {
    closeAll();
    setSessions({});
    setLogs([]);
    setGlobalStatus("idle");
    activeCountRef.current = 0;
    totalCountRef.current = 0;
  }, [closeAll]);

  const isRunning = globalStatus === "running";
  const sessionList = Object.values(sessions);

  return {
    sessions,
    sessionList,
    logs,
    globalStatus,
    isRunning,
    startAll,
    cancelAll,
    reset,
  };
}

export default useMultiAgentStream;
