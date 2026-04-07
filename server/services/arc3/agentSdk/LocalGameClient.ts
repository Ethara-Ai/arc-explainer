import { randomUUID } from "node:crypto";
import { GameBridge } from "../../eval/adapters/gameBridge.ts";
import type { BridgeFrameResponse } from "../../eval/adapters/types.ts";
import type { FrameData, GameAction } from "../Arc3ApiClient.ts";
import { getGameById } from "../shared/gameDiscovery.ts";
import { logger } from "../../../utils/logger.ts";
import type { GameClient } from "./GameClient.ts";

/* ------------------------------------------------------------------ */
/*  Public: isLocalGame                                                */
/* ------------------------------------------------------------------ */

/**
 * Check whether a game ID corresponds to a local puzzle-environments game.
 */
export function isLocalGame(gameId: string): boolean {
  return getGameById(gameId) !== null;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a mapping from ACTION1-6 tool names to local action strings.
 *
 * The first 5 non-coordinate actions map to ACTION1-5.
 * The first coordinate-capable action (contains "click") maps to ACTION6.
 */
function buildActionMap(
  availableActions: readonly string[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  let simpleIndex = 1;

  for (const action of availableActions) {
    if (simpleIndex > 5) break;
    // Skip coordinate-based actions for simple slots
    if (action.toLowerCase() === "click") continue;
    map.set(`ACTION${simpleIndex}`, action);
    simpleIndex++;
  }

  // ACTION6 is the coordinate-based action
  const clickAction = availableActions.find(
    (a) => a.toLowerCase() === "click",
  );
  if (clickAction) {
    map.set("ACTION6", clickAction);
  }

  return map;
}

/**
 * Resolve a GameAction (ACTION1-6) to a local action string for GameBridge.
 */
function resolveLocalAction(
  action: GameAction,
  actionMap: ReadonlyMap<string, string>,
): string {
  if (action.action === "RESET") {
    return "reset";
  }

  const localName = actionMap.get(action.action);
  if (!localName) {
    const available = [...actionMap.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    throw new Error(
      `[LocalGameClient] No mapping for ${action.action}. Available: ${available}`,
    );
  }

  // ACTION6 with coordinates → "click 10 15"
  if (action.action === "ACTION6" && action.coordinates) {
    return `${localName} ${action.coordinates[0]} ${action.coordinates[1]}`;
  }

  return localName;
}

/**
 * Convert a BridgeFrameResponse (2D grid) to FrameData (3D grid).
 */
function bridgeFrameToFrameData(
  bridge: BridgeFrameResponse,
  guid: string,
  gameId: string,
  actionMap: ReadonlyMap<string, string>,
): FrameData {
  return {
    guid,
    game_id: gameId,
    frame: [bridge.frame], // Wrap 2D → 3D (single layer)
    score: bridge.score,
    state: bridge.state,
    action_counter: bridge.action_counter,
    max_actions: bridge.max_actions,
    win_score: bridge.win_score,
    available_actions: [...actionMap.keys()],
  };
}

/* ------------------------------------------------------------------ */
/*  Session state (immutable record)                                   */
/* ------------------------------------------------------------------ */

interface LocalGameSession {
  readonly bridge: GameBridge;
  readonly guid: string;
  readonly gameId: string;
  readonly actionMap: ReadonlyMap<string, string>;
}

/* ------------------------------------------------------------------ */
/*  LocalGameClient                                                    */
/* ------------------------------------------------------------------ */

/**
 * Adapter that implements the GameClient interface using a local
 * GameBridge subprocess instead of the remote ARC Prize API.
 *
 * Scorecard operations are no-ops. Actions are mapped from ACTION1-6
 * tool names to the local game's descriptive action strings.
 */
export class LocalGameClient implements GameClient {
  private session: LocalGameSession | null = null;

  async openScorecard(
    _tags?: string[],
    _sourceUrl?: string,
    _metadata?: unknown,
  ): Promise<string> {
    return `local-${randomUUID().slice(0, 8)}`;
  }

  async closeScorecard(_cardId?: string): Promise<void> {
    // no-op for local games
  }

  async startGame(
    gameId: string,
    seedFrame?: FrameData,
    _cardIdOverride?: string,
  ): Promise<FrameData> {
    if (seedFrame && seedFrame.game_id === gameId) {
      return seedFrame;
    }

    const bridge = GameBridge.fromGameId(gameId);
    await bridge.start();
    const resetResponse = await bridge.reset();

    const guid = randomUUID();
    const actionMap = buildActionMap(resetResponse.available_actions);

    this.session = { bridge, guid, gameId, actionMap };

    logger.info(
      `[LocalGameClient] Started local game ${gameId} — ` +
        `actions: ${resetResponse.available_actions.join(", ")} → ` +
        `mapped: ${[...actionMap.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`,
      "arc3-agentsdk",
    );

    return bridgeFrameToFrameData(resetResponse, guid, gameId, actionMap);
  }

  async executeAction(
    gameId: string,
    _guid: string,
    action: GameAction,
    _reasoning?: unknown,
    _cardIdOverride?: string,
  ): Promise<FrameData> {
    if (!this.session) {
      throw new Error(
        `[LocalGameClient] No active session for game ${gameId}`,
      );
    }

    // RESET: restart the game via bridge.reset()
    if (action.action === "RESET") {
      const resetResponse = await this.session.bridge.reset();
      const newGuid = randomUUID();
      const newActionMap = buildActionMap(resetResponse.available_actions);

      this.session = {
        ...this.session,
        guid: newGuid,
        actionMap: newActionMap,
      };

      return bridgeFrameToFrameData(
        resetResponse,
        newGuid,
        gameId,
        newActionMap,
      );
    }

    // Regular action: map ACTION1-6 to local action string
    const localAction = resolveLocalAction(action, this.session.actionMap);

    logger.debug(
      `[LocalGameClient] ${action.action} → "${localAction}"`,
      "arc3-agentsdk",
    );

    const response = await this.session.bridge.action(localAction);

    // Rebuild action map in case available_actions changed (e.g., level transition)
    const updatedActionMap = buildActionMap(response.available_actions);
    this.session = { ...this.session, actionMap: updatedActionMap };

    return bridgeFrameToFrameData(
      response,
      this.session.guid,
      gameId,
      updatedActionMap,
    );
  }

  async cleanup(): Promise<void> {
    if (this.session?.bridge) {
      try {
        await this.session.bridge.quit();
      } catch (err) {
        logger.warn(
          `[LocalGameClient] Bridge cleanup error: ${err instanceof Error ? err.message : String(err)}`,
          "arc3-agentsdk",
        );
      }
      this.session = null;
    }
  }
}
