/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Dark terminal-styled tool timeline for ARC3 Agent Playground.
 *          Matches eval runner UI aesthetic. Shows tool_call/tool_result entries
 *          with auto-scroll and loading indicator during active tool calls.
 * SRP/DRY check: Pass — isolates tool timeline display from page layout.
 */

import React, { useEffect, useRef } from 'react';
import { Wrench, RefreshCw, Zap } from 'lucide-react';

export interface Arc3ToolTimelineEntry {
  label: string;
  content: string;
}

interface Arc3ToolTimelineProps {
  entries: Arc3ToolTimelineEntry[];
  isPlaying: boolean;
  streamingMessage?: string;
  className?: string;
}

export const Arc3ToolTimeline: React.FC<Arc3ToolTimelineProps> = ({
  entries,
  isPlaying,
  streamingMessage,
  className = '',
}) => {
  const hasActiveToolCall =
    isPlaying && (streamingMessage?.includes('called') ?? false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom whenever new tool entries arrive
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    setTimeout(() => {
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }, 0);
  }, [entries]);

  return (
    <div className={`border border-gray-800 bg-gray-900 rounded-lg overflow-hidden flex flex-col ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800 shrink-0">
        <Wrench className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-gray-300">
          Tool Calls
        </span>
        {hasActiveToolCall && (
          <div className="flex items-center gap-1 ml-auto">
            <RefreshCw className="h-3 w-3 animate-spin text-blue-400" />
            <span className="text-[9px] font-mono text-blue-400">Calling API...</span>
          </div>
        )}
        {entries.length > 0 && !hasActiveToolCall && (
          <span className="text-[9px] font-mono text-gray-600 ml-auto">
            {entries.length} calls
          </span>
        )}
      </div>

      {/* Scrollable entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-2 space-y-1.5 max-h-[calc(100vh-18rem)]"
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center py-6">
            <span className="text-[10px] font-mono text-gray-600">
              No tool calls yet
            </span>
          </div>
        ) : (
          entries.map((entry, idx) => {
            const isResult = entry.label.toLowerCase().startsWith('result from');
            const isLatestActive = idx === entries.length - 1 && hasActiveToolCall;

            return (
              <div
                key={idx}
                className={`border rounded px-2.5 py-2 ${
                  isResult
                    ? 'bg-emerald-400/5 border-emerald-500/20'
                    : 'bg-indigo-400/5 border-indigo-500/20'
                } ${isLatestActive ? 'ring-1 ring-blue-500/30' : ''}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <Zap className={`h-2.5 w-2.5 shrink-0 ${isResult ? 'text-emerald-400' : 'text-indigo-400'}`} />
                  <span className={`text-[10px] font-mono font-semibold ${isResult ? 'text-emerald-400' : 'text-indigo-400'}`}>
                    {entry.label}
                  </span>
                </div>
                <pre className="text-[10px] leading-relaxed text-gray-300 overflow-x-auto whitespace-pre-wrap font-mono bg-gray-950 border border-gray-800 rounded px-2 py-1.5">
                  {entry.content}
                </pre>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default Arc3ToolTimeline;
