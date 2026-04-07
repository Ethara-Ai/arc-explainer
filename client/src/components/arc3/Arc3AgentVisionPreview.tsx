/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Dark terminal-styled agent vision preview for ARC3 Agent Playground.
 *          Shows the base64 image preview of what the vision-enabled agent sees
 *          when inspecting the game state.
 * SRP/DRY check: Pass — isolates agent vision preview display.
 */

import React from 'react';
import { Eye } from 'lucide-react';

interface Arc3AgentVisionPreviewProps {
  frameImage: string | null;
  width?: number;
  height?: number;
  className?: string;
}

export const Arc3AgentVisionPreview: React.FC<Arc3AgentVisionPreviewProps> = ({
  frameImage,
  width = 256,
  height = 256,
  className = '',
}) => {
  if (!frameImage) {
    return null;
  }

  return (
    <div className={`border border-gray-800 bg-gray-900 rounded-lg overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
        <Eye className="h-3.5 w-3.5 text-purple-400" />
        <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-gray-300">
          Agent's View
        </span>
        <span className="text-[9px] font-mono text-gray-600 ml-auto">
          Vision model input
        </span>
      </div>

      {/* Image */}
      <div className="p-3 bg-gray-950">
        <div className="border border-gray-700 rounded-lg overflow-hidden">
          <img
            src={frameImage}
            alt="Agent's visual inspection of game state"
            style={{ width: `${width}px`, height: `${height}px` }}
            className="object-contain w-full"
          />
        </div>
      </div>
    </div>
  );
};

export default Arc3AgentVisionPreview;
