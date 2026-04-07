
import React, { useEffect, useRef } from 'react';
import { Activity, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, MousePointer2, Zap, SkipForward } from 'lucide-react';
import type { FrameData } from '@/hooks/useMultiAgentStream';

interface Arc3ActionLogProps {
  frames: FrameData[];
  isPlaying: boolean;
  modelName: string;
  modelColor: string;
  className?: string;
  gameId?: string;
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  UP: <ArrowUp className="h-3 w-3" />,
  DOWN: <ArrowDown className="h-3 w-3" />,
  LEFT: <ArrowLeft className="h-3 w-3" />,
  RIGHT: <ArrowRight className="h-3 w-3" />,
  SELECT: <Zap className="h-3 w-3" />,
  SKIP: <SkipForward className="h-3 w-3" />,
};

function getActionIcon(action: string | undefined): React.ReactNode {
  if (!action) return <Activity className="h-3 w-3" />;
  const upper = action.toUpperCase();
  if (upper.startsWith('CLICK')) return <MousePointer2 className="h-3 w-3" />;
  return ACTION_ICONS[upper] || <Activity className="h-3 w-3" />;
}

function getStateColor(state: string | undefined): string {
  if (!state) return 'text-gray-500';
  if (state === 'WIN') return 'text-emerald-400';
  if (state === 'GAME_OVER' || state === 'LOSE') return 'text-red-400';
  return 'text-amber-400/70';
}

export const Arc3ActionLog: React.FC<Arc3ActionLogProps> = ({ frames, isPlaying, modelName, modelColor, className = '',gameId }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) setTimeout(() => { if (el) el.scrollTop = el.scrollHeight; }, 0);
  }, [frames.length]);

  const actionFrames = frames
    .map((f, i) => ({ frame: f, index: i }))
    .filter(({ frame }) => frame.action);

  return (
    <div className={`rounded-2xl border border-[#1e1e2e] bg-[#12121a] overflow-hidden flex flex-col h-[280px] ${className}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e2e] shrink-0">
        <div className="flex items-center gap-2.5">
          <Activity className="h-4 w-4" style={{ color: modelColor }} />
          <span className="text-xs font-semibold text-gray-200">Actions</span>
          {isPlaying && <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: modelColor }} />}
          {actionFrames.length > 0 && <span className="text-[10px] text-gray-500">{actionFrames.length}</span>}
        </div>
        <span className="text-[10px] text-gray-600 truncate max-w-[120px]">{modelName}</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-1">
        {actionFrames.length === 0 && !isPlaying ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-gray-600">No actions yet</span>
          </div>
        ) : (
          <>
            {actionFrames.map(({ frame, index }, i) => {
              const prevFrame = index > 0 ? frames[index - 1] : null;
              const scoreDelta = prevFrame ? frame.score - prevFrame.score : 0;
              const actionStr = typeof frame.action === 'object'
                ? frame.action.type + (frame.action.coordinates ? ` ${frame.action.coordinates[0]},${frame.action.coordinates[1]}` : '')
                : String(frame.action);

              return (
                <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors group">
                  <span className="text-[9px] text-gray-600 w-5 text-right shrink-0 font-mono">{i + 1}</span>
                  {(frame.game_id || gameId) && <span className="text-[9px] font-mono font-semibold text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 rounded shrink-0">{frame.game_id || gameId}</span>}
                  <span className="text-gray-400 shrink-0">{getActionIcon(actionStr)}</span>
                  <span className="text-[11px] text-gray-200 font-medium truncate">{actionStr}</span>
                  <span className="ml-auto flex items-center gap-2 shrink-0">
                    {scoreDelta !== 0 && (
                      <span className={`text-[10px] font-mono ${scoreDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {scoreDelta > 0 ? '+' : ''}{scoreDelta}
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-gray-500">{frame.score}</span>
                    {frame.state && frame.state !== 'NOT_FINISHED' && (
                      <span className={`text-[9px] font-semibold uppercase ${getStateColor(frame.state)}`}>{frame.state}</span>
                    )}
                  </span>
                </div>
              );
            })}
            {isPlaying && (
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.02] animate-pulse">
                <span className="text-[9px] text-gray-600 w-5 text-right shrink-0 font-mono">{actionFrames.length + 1}</span>
                <Activity className="h-3 w-3 text-gray-500" />
                <span className="text-[11px] text-gray-500">Waiting for action...</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default Arc3ActionLog;
