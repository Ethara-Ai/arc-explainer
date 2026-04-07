/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Reasoning viewer — refined with warmer colors, better visual hierarchy, smooth scroll.
 * SRP/DRY check: Pass
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Brain, MessageSquare, Copy, Check } from 'lucide-react';

interface TimelineEntry { index: number; type: 'assistant_message' | 'tool_call' | 'tool_result' | 'reasoning'; label: string; content: string; gameId?: string; }

interface Arc3ReasoningViewerProps {
  timeline: TimelineEntry[];
  isPlaying: boolean;
  streamingMessage?: string;
  streamingReasoning?: string;
  className?: string;
  gameId?: string;
}

export const Arc3ReasoningViewer: React.FC<Arc3ReasoningViewerProps> = ({ timeline, isPlaying, streamingMessage, streamingReasoning, className = '',gameId }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = React.useState(false);

  useEffect(() => { const el = scrollRef.current; if (el) setTimeout(() => { if (el) el.scrollTop = el.scrollHeight; }, 0); }, [timeline, streamingReasoning]);

  const handleCopy = useCallback(() => {
    const entries = timeline.filter(e => e.type === 'reasoning' || e.type === 'assistant_message');
    const text = entries.map(e => `[${e.type}] ${e.label}\n${e.content}`).join('\n\n');
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }, [timeline]);

  const combined = timeline.filter(e => e.type === 'reasoning' || e.type === 'assistant_message');

  return (
    <div className={`rounded-2xl border border-[#1e1e2e] bg-[#12121a] overflow-hidden flex flex-col h-[500px] ${className}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e2e] shrink-0">
        <div className="flex items-center gap-2.5">
          <Brain className="h-4 w-4 text-blue-400" />
          <span className="text-xs font-semibold text-gray-200">Reasoning</span>
          {isPlaying && <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />}
          {combined.length > 0 && <span className="text-[10px] text-gray-500">{combined.length}</span>}
        </div>
        <button onClick={handleCopy} className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {combined.length === 0 && !isPlaying ? (
          <div className="flex items-center justify-center h-full"><span className="text-xs text-gray-600">No reasoning yet</span></div>
        ) : (
          <>
            {combined.map((entry, idx) => {
              const isReasoning = entry.type === 'reasoning';
              return (
                <div key={idx} className={`rounded-xl px-3.5 py-2.5 ${isReasoning ? 'bg-blue-500/[0.06] border border-blue-500/15' : 'bg-emerald-500/[0.06] border border-emerald-500/15'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {isReasoning ? <Brain className="h-3 w-3 text-blue-400/70" /> : <MessageSquare className="h-3 w-3 text-emerald-400/70" />}
                    {(entry.gameId || gameId) && <span className="text-[9px] font-mono font-semibold text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 rounded">{entry.gameId || gameId}</span>}
                    <span className={`text-[10px] font-semibold ${isReasoning ? 'text-blue-400/80' : 'text-emerald-400/80'}`}>{isReasoning ? 'Thinking' : 'Message'}</span>
                    <span className="text-[9px] text-gray-600 truncate">{entry.label}</span>
                  </div>
                  {entry.content && <p className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap pl-5">{entry.content}</p>}
                </div>
              );
            })}
            {isPlaying && (
              <div className="rounded-xl px-3.5 py-2.5 bg-blue-500/[0.04] border border-blue-500/10 animate-pulse">
                <div className="flex items-center gap-2 mb-1">
                  <Brain className="h-3 w-3 text-blue-400/50" />
                  <span className="text-[10px] font-semibold text-blue-400/60">Thinking</span>
                  <span className="text-[9px] text-white/20">{streamingMessage || 'Reasoning...'}</span>
                </div>
                {streamingReasoning && <p className="text-[11px] text-white/40 leading-relaxed whitespace-pre-wrap pl-5">{streamingReasoning}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default Arc3ReasoningViewer;
