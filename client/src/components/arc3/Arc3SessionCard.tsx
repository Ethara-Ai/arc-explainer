/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Session card — refined design with colored accent, proportional grid, warm hover.
 * SRP/DRY check: Pass
 */

import React from 'react';
import { Maximize2 } from 'lucide-react';
import type { AgentSession } from '@/hooks/useMultiAgentStream';
import { Arc3GridVisualization } from './Arc3GridVisualization';

interface Arc3SessionCardProps {
  session: AgentSession;
  isSelected: boolean;
  onClick: () => void;
  onExpand: () => void;
}

export const Arc3SessionCard: React.FC<Arc3SessionCardProps> = ({ session, isSelected, onClick, onExpand }) => {
  const lastFrame = session.frames[session.currentFrameIndex] || null;
  const resolvedGrid = lastFrame?.frame || null;

  const stateLabel =
    lastFrame?.state === 'WIN' ? 'won' :
    lastFrame?.state === 'GAME_OVER' || lastFrame?.state === 'LOSE' ? 'lost' :
    session.status === 'error' ? 'error' :
    session.status === 'running' ? 'playing' :
    session.status === 'starting' ? 'starting' :
    session.status === 'completed' ? 'done' : 'idle';

  const stateClass =
    stateLabel === 'won' ? 'bg-emerald-500/10 text-emerald-400' :
    stateLabel === 'lost' || stateLabel === 'error' ? 'bg-red-500/10 text-red-400' :
    stateLabel === 'playing' || stateLabel === 'starting' ? 'bg-blue-500/10 text-blue-400' :
    'bg-white/5 text-white/30';

  return (
    <div
      onClick={onClick}
      className={`group relative rounded-2xl border overflow-hidden cursor-pointer transition-all duration-200 ${
        isSelected
          ? 'border-blue-500/30 bg-[#14141e] shadow-lg shadow-blue-500/5'
          : 'border-[#1e1e2e] bg-[#12121a] hover:bg-[#16161f] hover:border-[#2a2a3a]'
      }`}
    >
      {/* Colored top accent */}
      <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, ${session.modelColor}, ${session.modelColor}30)` }} />

      <div className="p-3.5">
        {/* Header */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: session.modelColor }} />
            <span className="text-[13px] font-semibold text-gray-100 truncate">{session.modelName}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {resolvedGrid && (
              <button onClick={(e) => { e.stopPropagation(); onExpand(); }}
            className="p-1 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-[#1e1e2e] transition-all opacity-0 group-hover:opacity-100">
                <Maximize2 size={12} />
              </button>
            )}
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${stateClass}`}>{stateLabel}</span>
          </div>
        </div>

        {/* Grid area — click to expand */}
        <div
          className="flex items-center justify-center bg-[#0a0a10] rounded-xl p-2 min-h-[90px] cursor-zoom-in hover:ring-1 hover:ring-white/10 transition-all"
          onClick={(e) => { e.stopPropagation(); if (resolvedGrid) onExpand(); }}
        >
          {resolvedGrid ? (
            <Arc3GridVisualization grid={resolvedGrid} frameIndex={resolvedGrid.length > 0 ? resolvedGrid.length - 1 : 0} cellSize={8} showGrid={false} />
          ) : (
            <span className="text-[10px] text-gray-600">{session.status === 'starting' ? 'Loading...' : 'No grid'}</span>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-2.5 text-[10px]">
          <span className="text-emerald-400/70 font-medium">{session.gameId}</span>
          <span className="text-gray-500">R{session.runIndex + 1}</span>
          <span className="text-gray-500">{session.stepCount} steps</span>
          <span className="text-gray-400">Score: {lastFrame?.score ?? 0}</span>
        </div>

        {/* Streaming indicator */}
        {(session.status === 'running' || session.status === 'starting') && session.streamingMessage && (
          <div className="mt-2 text-[9px] text-blue-400/40 truncate">{session.streamingMessage}</div>
        )}
      </div>
    </div>
  );
};

export default Arc3SessionCard;
