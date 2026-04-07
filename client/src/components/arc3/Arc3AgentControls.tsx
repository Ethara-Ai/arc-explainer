/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Dark terminal-styled user message injection for ARC3 Agent Playground.
 *          Allows user to send follow-up messages after agent pauses/completes.
 * SRP/DRY check: Pass — isolates message injection controls from page orchestration.
 */

import React from 'react';
import { MessageSquare, Send } from 'lucide-react';

interface Arc3AgentControlsProps {
  userMessage: string;
  setUserMessage: (value: string) => void;
  onSubmit: () => void;
}

export const Arc3AgentControls: React.FC<Arc3AgentControlsProps> = ({
  userMessage,
  setUserMessage,
  onSubmit,
}) => {
  return (
    <div className="border border-amber-500/30 bg-amber-400/5 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-amber-500/20">
        <MessageSquare className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-amber-300">
          Send Message
        </span>
      </div>

      <div className="p-3 space-y-2">
        <p className="text-[10px] font-mono text-amber-400/70">
          Chain your message to the agent for continued exploration:
        </p>
        <textarea
          value={userMessage}
          onChange={(e) => setUserMessage(e.target.value)}
          placeholder="Send new guidance or observation..."
          rows={3}
          className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-[11px] font-mono px-2 py-1.5 rounded resize-none focus:outline-none focus:border-amber-500/60 transition-colors placeholder:text-gray-700"
        />
        <button
          onClick={onSubmit}
          disabled={!userMessage.trim()}
          className="w-full flex items-center justify-center gap-2 py-2 text-[11px] font-mono font-semibold uppercase tracking-widest rounded transition-all
            bg-amber-600 hover:bg-amber-500 text-white
            disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed"
        >
          <Send className="h-3 w-3" />
          Send
        </button>
      </div>
    </div>
  );
};

export default Arc3AgentControls;
