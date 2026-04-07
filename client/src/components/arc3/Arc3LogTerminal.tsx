/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Shared terminal — refined with subtle prompt styling, warm colors, proper word wrap.
 * SRP/DRY check: Pass
 */

import React, { useRef, useEffect, useMemo } from 'react';
import { Terminal } from 'lucide-react';
import type { LogEntry } from '@/hooks/useMultiAgentStream';

interface Arc3LogTerminalProps { logs: LogEntry[] }

const MAX_VISIBLE = 500;

export const Arc3LogTerminal: React.FC<Arc3LogTerminalProps> = ({ logs }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => logs.length > MAX_VISIBLE ? logs.slice(-MAX_VISIBLE) : logs, [logs]);

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [visible.length]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
  };

  return (
    <div className="rounded-2xl border border-[#1e1e2e] bg-[#0a0a10] overflow-hidden flex flex-col h-[240px]">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e1e2e] bg-[#0e0e16] shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <span className="text-xs font-medium text-gray-400 ml-1">Terminal</span>
        </div>
        <span className="text-[10px] text-gray-600">{logs.length} lines</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-0">
        {visible.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[11px] text-gray-600">Waiting for events...</div>
        ) : visible.map((log, i) => {
          const isError = log.level === 'error';
          const isWarn = log.level === 'warn';
          return (
            <div key={i} className="flex items-start gap-2.5 py-[3px]">
              <span className="text-[10px] font-mono text-gray-600 shrink-0 tabular-nums">{formatTime(log.timestamp)}</span>
              <span className={`text-[10px] font-mono shrink-0 min-w-[90px] max-w-[140px] truncate ${isError ? 'text-red-400' : isWarn ? 'text-amber-400' : 'text-purple-400/70'}`}>{log.source}</span>
              <span className={`text-[11px] font-mono leading-relaxed break-all ${isError ? 'text-red-300' : isWarn ? 'text-amber-300/80' : 'text-gray-400'}`}>{log.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Arc3LogTerminal;
