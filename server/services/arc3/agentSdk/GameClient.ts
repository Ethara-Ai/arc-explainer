import type { FrameData, GameAction } from "../Arc3ApiClient.ts";

/**
 * Common interface for game API clients.
 *
 * Both Arc3ApiClient (remote ARC Prize API) and LocalGameClient (local
 * puzzle-environments via GameBridge) satisfy this interface.  Tools in
 * Arc3ToolFactory depend only on `executeAction`; the runner also calls
 * `openScorecard`, `closeScorecard`, and `startGame`.
 */
export interface GameClient {
  openScorecard(
    tags?: string[],
    sourceUrl?: string,
    metadata?: unknown,
  ): Promise<string>;

  closeScorecard(cardId?: string): Promise<void>;

  startGame(
    gameId: string,
    seedFrame?: FrameData,
    cardIdOverride?: string,
  ): Promise<FrameData>;

  executeAction(
    gameId: string,
    guid: string,
    action: GameAction,
    reasoning?: unknown,
    cardIdOverride?: string,
  ): Promise<FrameData>;

  /** Optional teardown (e.g. quit the GameBridge subprocess). */
  cleanup?(): Promise<void>;
}
