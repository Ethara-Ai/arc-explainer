/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Per-session notepad — refined with warm amber accents, flash animation, clean layout.
 * SRP/DRY check: Pass
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StickyNote, Copy, Check } from 'lucide-react';

interface Arc3NotepadProps { content: string; modelName: string; modelColor: string; gameId: string }

export const Arc3Notepad: React.FC<Arc3NotepadProps> = ({ content, modelName, modelColor, gameId }) => {
  const [flash, setFlash] = useState(false);
  const [copied, setCopied] = useState(false);
  const prevRef = useRef(content);

  useEffect(() => {
    if (content !== prevRef.current && content) { setFlash(true); const t = setTimeout(() => setFlash(false), 600); prevRef.current = content; return () => clearTimeout(t); }
    prevRef.current = content;
  }, [content]);

  const handleCopy = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }, [content]);

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all duration-300 ${flash ? 'border-amber-500/40 shadow-lg shadow-amber-500/10' : 'border-[#1e1e2e]'} bg-[#12121a]`}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e1e2e]">
        <div className="flex items-center gap-2.5">
          <StickyNote className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-xs font-semibold text-gray-200">Notepad</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-gray-500 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: modelColor }} />{modelName} | {gameId}
          </span>
          <button onClick={handleCopy} disabled={!content} className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-30">
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
      <div className="bg-[#0a0a10] p-3.5 min-h-[100px] max-h-[250px] overflow-y-auto">
        {content ? (
          <pre className="text-[11px] font-mono text-gray-400 leading-relaxed whitespace-pre-wrap break-words">{content}</pre>
        ) : (
          <div className="flex items-center justify-center h-16"><span className="text-[10px] text-gray-600">Empty</span></div>
        )}
      </div>
    </div>
  );
};

export default Arc3Notepad;
