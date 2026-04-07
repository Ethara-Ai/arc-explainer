/*
 * Author: Claude Opus 4
 * Date: 2026-03-24
 * PURPOSE: Dark terminal-styled game panel for ARC3 Agent Playground.
 *          Matches eval runner UI aesthetic. Grid visualization, action buttons,
 *          frame/layer navigation, color legend, ACTION6 coordinate picker.
 * SRP/DRY check: Pass — isolates game state visualization and manual action controls
 */

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Monitor, Gamepad2, Layers, Activity } from 'lucide-react';
import { Arc3GridVisualization } from './Arc3GridVisualization';
import { ARC3_COLORS_HEX, ARC3_COLOR_NAMES } from '@shared/config/arc3Colors';

interface FrameData {
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
  action?: {
    type: string;
    coordinates?: [number, number];
  };
}

interface ToolEntry {
  label: string;
  content: string;
}

interface Arc3GamePanelProps {
  currentFrame: FrameData | null;
  frames: FrameData[];
  currentFrameIndex: number;
  executeManualAction: (action: string, coords?: [number, number]) => Promise<void>;
  isPendingManualAction: boolean;
  isPlaying: boolean;
  streamingMessage: string | undefined;
  toolEntries: ToolEntry[];
  gameGuid: string | undefined;
  gameId: string | undefined;
  error: string | undefined;
  setCurrentFrame: (index: number) => void;
  normalizedAvailableActions: Set<string> | null;
}

// Normalize available_actions tokens from the API
const normalizeAvailableActionName = (token: string | number | null | undefined): string | null => {
  if (token === null || token === undefined) {
    return null;
  }

  if (typeof token === 'number' && Number.isFinite(token)) {
    if (token === 0) return 'RESET';
    if (token >= 1 && token <= 7) return `ACTION${token}`;
    return null;
  }

  if (typeof token === 'string') {
    const trimmed = token.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    const canonical = upper.replace(/[\s_-]+/g, '');
    if (canonical === 'RESET') return 'RESET';
    if (canonical.startsWith('ACTION')) {
      const suffix = canonical.slice(6);
      if (!suffix) return null;
      const parsed = parseInt(suffix, 10);
      if (Number.isNaN(parsed)) return null;
      if (parsed === 0) return 'RESET';
      if (parsed >= 1 && parsed <= 7) return `ACTION${parsed}`;
    }
    if (/^\d+$/.test(canonical)) {
      const parsed = parseInt(canonical, 10);
      if (parsed === 0) return 'RESET';
      if (parsed >= 1 && parsed <= 7) return `ACTION${parsed}`;
    }
  }

  return null;
};

export const Arc3GamePanel: React.FC<Arc3GamePanelProps> = ({
  currentFrame,
  frames,
  currentFrameIndex,
  executeManualAction,
  isPendingManualAction,
  isPlaying,
  streamingMessage,
  toolEntries,
  gameGuid,
  gameId,
  error,
  setCurrentFrame,
  normalizedAvailableActions,
}) => {
  const [showCoordinatePicker, setShowCoordinatePicker] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualLayerIndex, setManualLayerIndex] = useState<number | null>(null);
  const [animatingLayerIndex, setAnimatingLayerIndex] = useState<number | null>(null);
  const animationTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  const resolveFrameLayers = (frameData: FrameData | null) => {
    if (!frameData) return null;
    return frameData.frame as number[][][];
  };

  const resolvedCurrentFrame = resolveFrameLayers(currentFrame);

  // Auto-animate through layers when new frame arrives
  React.useEffect(() => {
    if (animationTimerRef.current) {
      clearInterval(animationTimerRef.current);
      animationTimerRef.current = null;
    }

    setManualLayerIndex(null);

    if (resolvedCurrentFrame && resolvedCurrentFrame.length > 1) {
      let currentLayer = 0;
      setAnimatingLayerIndex(0);

      animationTimerRef.current = setInterval(() => {
        currentLayer += 1;
        if (currentLayer >= resolvedCurrentFrame.length) {
          if (animationTimerRef.current) {
            clearInterval(animationTimerRef.current);
            animationTimerRef.current = null;
          }
          setAnimatingLayerIndex(null);
        } else {
          setAnimatingLayerIndex(currentLayer);
        }
      }, 120);
    } else {
      setAnimatingLayerIndex(null);
    }

    return () => {
      if (animationTimerRef.current) {
        clearInterval(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
  }, [currentFrameIndex, resolvedCurrentFrame?.length]);

  const currentLayerIndex = React.useMemo(() => {
    if (manualLayerIndex !== null && resolvedCurrentFrame && manualLayerIndex < resolvedCurrentFrame.length) {
      if (animationTimerRef.current) {
        clearInterval(animationTimerRef.current);
        animationTimerRef.current = null;
      }
      return manualLayerIndex;
    }
    if (animatingLayerIndex !== null && resolvedCurrentFrame && animatingLayerIndex < resolvedCurrentFrame.length) {
      return animatingLayerIndex;
    }
    if (resolvedCurrentFrame && resolvedCurrentFrame.length > 0) {
      return resolvedCurrentFrame.length - 1;
    }
    return 0;
  }, [manualLayerIndex, animatingLayerIndex, resolvedCurrentFrame, resolvedCurrentFrame?.length]);

  const handleActionClick = async (actionName: string) => {
    if (actionName === 'ACTION6') {
      setShowCoordinatePicker(true);
    } else {
      try {
        setActionError(null);
        await executeManualAction(actionName);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to execute action';
        setActionError(msg);
        console.error(`Failed to execute ${actionName}:`, error);
      }
    }
  };

  // State badge color logic
  const stateColor = currentFrame?.state === 'WIN'
    ? 'text-emerald-400'
    : currentFrame?.state === 'GAME_OVER' || currentFrame?.state === 'LOSE'
      ? 'text-red-400'
      : 'text-amber-400';

  const stateBg = currentFrame?.state === 'WIN'
    ? 'bg-emerald-400/10 border-emerald-500/30'
    : currentFrame?.state === 'GAME_OVER' || currentFrame?.state === 'LOSE'
      ? 'bg-red-400/10 border-red-500/30'
      : 'bg-amber-400/10 border-amber-500/30';

  return (
    <div className="space-y-3">
      {/* Action Error Display */}
      {actionError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
          <span className="text-[11px] font-mono font-semibold text-red-400">Action Error:</span>
          <span className="text-[11px] font-mono text-red-300">{actionError}</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="border border-gray-800 bg-gray-900 rounded-lg overflow-hidden">
        <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2">
          <Gamepad2 className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-gray-300">
            Actions
          </span>
        </div>
        <div className="p-3">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {['RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'].map((actionName) => {
              const usedCount = toolEntries.filter(e => e.label.includes(actionName)).length;
              const isActive = isPlaying && streamingMessage?.includes(actionName);
              const displayName = actionName === 'RESET' ? 'Reset' : actionName.replace('ACTION', 'A');
              const isAvailable = !normalizedAvailableActions || normalizedAvailableActions.has(actionName);
              const isDisabled = !gameGuid || !gameId || !isAvailable || isPendingManualAction;

              return (
                <button
                  key={actionName}
                  onClick={() => handleActionClick(actionName)}
                  disabled={isDisabled}
                  title={
                    isPendingManualAction
                      ? 'Another action is in progress. Please wait...'
                      : !isAvailable
                      ? `${actionName} is not available in this game state`
                      : `Execute ${actionName}`
                  }
                  className={`px-3 py-1 rounded text-[10px] font-mono font-semibold transition-all border ${
                    isActive
                      ? 'bg-emerald-600 text-white border-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.3)]'
                      : !isAvailable
                      ? 'bg-gray-950 text-gray-700 border-gray-800 opacity-50 cursor-not-allowed'
                      : usedCount > 0
                      ? 'bg-blue-500/10 text-blue-300 border-blue-500/30 hover:bg-blue-500/20 cursor-pointer'
                      : 'bg-gray-950 text-gray-400 border-gray-700 hover:border-gray-500 hover:text-gray-200 cursor-pointer'
                  } ${isDisabled && isAvailable ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {displayName}
                  {usedCount > 0 && <span className="ml-1 text-[9px] text-gray-500">x{usedCount}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="border border-gray-800 bg-gray-900 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Monitor className="h-3.5 w-3.5 text-blue-400" />
            <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-gray-300">
              Game Grid
            </span>
          </div>
          {currentFrame && (
            <span className={`text-[10px] font-mono font-semibold uppercase px-2 py-0.5 rounded border ${stateBg} ${stateColor}`}>
              {currentFrame.state === 'NOT_FINISHED' ? 'Playing' : currentFrame.state}
            </span>
          )}
        </div>

        {/* Grid content */}
        <div className="p-4 bg-gray-950">
          {error && (
            <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-[11px] font-mono text-red-300">
              <span className="font-semibold text-red-400">Error:</span>
              <span>{error}</span>
            </div>
          )}

          {resolvedCurrentFrame ? (
            <div className="space-y-3">
              <div className="flex justify-center">
                <Arc3GridVisualization
                  key={`frame-${currentFrameIndex}-${currentLayerIndex}-${currentFrame?.score}`}
                  grid={resolvedCurrentFrame}
                  frameIndex={currentLayerIndex}
                  cellSize={20}
                  showGrid={true}
                  lastAction={currentFrame?.action}
                />
              </div>

              {/* Layer/Timestep Navigation */}
              {resolvedCurrentFrame.length > 1 && (
                <div className="space-y-1 p-2 bg-amber-400/5 border border-amber-500/20 rounded">
                  <label className="text-[10px] font-mono text-amber-300">
                    Timestep: {currentLayerIndex + 1} / {resolvedCurrentFrame.length}
                    <span className="ml-2 text-[9px] text-amber-400/60">
                      ({resolvedCurrentFrame.length} intermediate states)
                    </span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max={resolvedCurrentFrame.length - 1}
                    value={currentLayerIndex}
                    onChange={(e) => setManualLayerIndex(Number(e.target.value))}
                    className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-amber-400"
                  />
                </div>
              )}

              {/* Frame Navigation */}
              {frames.length > 1 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-mono text-gray-400">
                    Frame: {currentFrameIndex + 1} / {frames.length}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max={frames.length - 1}
                    value={currentFrameIndex}
                    onChange={(e) => setCurrentFrame(Number(e.target.value))}
                    className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-400"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-16">
              <Gamepad2 className="mx-auto h-10 w-10 text-gray-700 mb-3" />
              <p className="text-gray-500 text-sm font-mono">No grid loaded</p>
              <p className="text-[10px] font-mono text-gray-600 mt-1">Select a game to start</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {currentFrame && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-800 text-[10px] font-mono">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-gray-500">
                <Layers className="h-2.5 w-2.5" />
                <span>Score: {currentFrame.score}</span>
              </div>
              <div className="flex items-center gap-1 text-gray-500">
                <Activity className="h-2.5 w-2.5" />
                <span className={stateColor}>{currentFrame.state}</span>
              </div>
            </div>
            <span className="text-gray-600">
              Actions: {currentFrame.action_counter}/{currentFrame.max_actions}
            </span>
          </div>
        )}
      </div>

      {/* Color Legend */}
      {resolvedCurrentFrame && (
        <div className="border border-gray-800 bg-gray-900 rounded-lg overflow-hidden">
          <div className="p-2">
            <div className="grid grid-cols-4 gap-1 text-[9px]">
              {Object.entries(ARC3_COLORS_HEX).map(([value, hex]) => (
                <div key={value} className="flex items-center gap-1">
                  <div
                    className="w-3 h-3 rounded-sm border border-gray-700"
                    style={{ backgroundColor: hex }}
                  />
                  <span className="text-gray-500 truncate font-mono">
                    {value}: {ARC3_COLOR_NAMES[Number(value)]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ACTION6 Coordinate Picker Dialog */}
      <Dialog open={showCoordinatePicker} onOpenChange={setShowCoordinatePicker}>
        <DialogContent className="max-w-3xl bg-gray-900 border-gray-800 text-gray-200">
          <DialogHeader>
            <DialogTitle className="text-white font-bold">Action 6: Select Coordinates</DialogTitle>
            <DialogDescription className="text-gray-400 text-sm font-mono">
              Click on any cell in the grid to execute ACTION6 at that position
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-center py-4 bg-gray-950 rounded-lg">
            {resolvedCurrentFrame && (
              <Arc3GridVisualization
                key={`picker-frame-${currentFrameIndex}`}
                grid={resolvedCurrentFrame}
                frameIndex={Math.max(0, resolvedCurrentFrame.length - 1)}
                cellSize={20}
                showGrid={true}
                lastAction={currentFrame?.action}
                onCellClick={async (x, y) => {
                  try {
                    setActionError(null);
                    await executeManualAction('ACTION6', [x, y]);
                    setShowCoordinatePicker(false);
                  } catch (error) {
                    const msg = error instanceof Error ? error.message : 'Failed to execute ACTION6';
                    setActionError(msg);
                    console.error('Failed to execute ACTION6:', error);
                  }
                }}
              />
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowCoordinatePicker(false)}
              className="px-4 py-2 text-[11px] font-mono text-gray-400 border border-gray-700 rounded hover:border-gray-500 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Arc3GamePanel;
