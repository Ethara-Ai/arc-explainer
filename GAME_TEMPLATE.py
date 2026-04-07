"""
ARC-AGI-3 Game Template
========================
Canonical code template for building ARC-AGI-3 games.
Every game MUST follow this structure to pass the eval harness QC checks.

NAMING CONVENTION:
  Game ID:    "xx00"  (2 lowercase letters + 2 digits)
  Class name: "Xx00"  (first letter capitalized, rest as-is)
  File:       xx00/xx00.py
  Metadata:   xx00/metadata.json

ARCHITECTURE (4 layers):
  1. Engine class (ARCBaseGame subclass)      — game logic, levels, sprites
  2. PuzzleEnvironment                        — text + image wrapper, action strings
  3. ArcGameEnv (gymnasium.Env subclass)      — standard RL interface
  4. Dataclasses (GameState, StepResult)      — data transfer objects

HOW THE EVAL HARNESS WORKS:
  The TypeScript eval harness spawns a Python subprocess that imports your
  PuzzleEnvironment class and communicates via JSON-line stdin/stdout.
  The bridge reads GameState.metadata to determine:
    - State:  done=True + game_over=True  → "GAME_OVER"
              done=True + game_over=False → "WIN"
              done=False                  → "IN_PROGRESS"
    - Score:  levels_completed / total_levels  (clamped to [0, 1])
    - Grid:   camera.render(sprites)  → 2D array of color indices 0-15
  GAME_OVER is NOT terminal — the agent can call "reset" to retry.
  Only WIN (all levels completed) ends the evaluation run.
"""

# ═══════════════════════════════════════════════════════════════════
# IMPORTS  —  Only these are allowed. NO: requests, urllib, http,
#             socket, subprocess, shutil, ctypes, pickle, PIL, Pillow
# ═══════════════════════════════════════════════════════════════════
import random
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import gymnasium as gym
import numpy as np
from gymnasium import spaces
from arcengine import (
    ActionInput,
    ARCBaseGame,
    Camera,
    GameAction,
    Level,
    Sprite,
    # Optional imports (use only if needed by your game):
    # RenderableUserDisplay,   # for custom HUD overlays
    # ToggleableUserDisplay,   # for on/off HUD elements (e.g. lives)
)

# Optional: For PNG encoding (if providing image_observation)
# import io, struct, zlib


# ═══════════════════════════════════════════════════════════════════
# §1  DATACLASSES  —  GameState and StepResult
# ═══════════════════════════════════════════════════════════════════
# REQUIRED: Both must exist as module-level classes.
# Fields and types must match exactly.

@dataclass
class GameState:
    text_observation: str                       # Human-readable board description
    image_observation: Optional[bytes]           # PNG bytes or None
    valid_actions: Optional[List[str]]           # None when game is over
    turn: int                                    # Total turns taken
    metadata: dict = field(default_factory=dict) # See §1a below


@dataclass
class StepResult:
    state: GameState    # Current game state after action
    reward: float       # 0.0 normally; 1.0/total_levels on level complete
    done: bool          # True when game_over or game_won
    info: dict = field(default_factory=dict)  # Extra step info


# ═══════════════════════════════════════════════════════════════════
# §1a  GameState.metadata REQUIRED KEYS
# ═══════════════════════════════════════════════════════════════════
#
# The metadata dict inside GameState MUST contain ALL of these keys.
# The eval harness bridge reads them to determine game state and score.
#
#   "total_levels":     int   — total number of levels (MUST == len(engine._levels))
#   "level_index":      int   — current level index (0-based)
#   "levels_completed": int   — number of levels beaten (from engine._score)
#   "game_over":        bool  — True ONLY when game ended in failure (lose/death)
#   "done":             bool  — True when episode is over (win OR game_over)
#   "info":             dict  — additional info (can be {})
#
# CRITICAL — How the bridge uses these to determine state:
#   if done=True  AND game_over=True  → state = "GAME_OVER"  (agent lost)
#   if done=True  AND game_over=False → state = "WIN"         (agent won)
#   if done=False                     → state = "IN_PROGRESS" (still playing)
#
# CRITICAL — How the adapter computes score:
#   score = min(levels_completed / total_levels, 1.0)
#   This means levels_completed MUST accurately track completed levels.
#   engine._score increments by 1 each time next_level() is called.
#   NEVER manually set engine._score. NEVER call next_level() more than
#   once per level completion — it would inflate levels_completed and
#   break the score formula.


# ═══════════════════════════════════════════════════════════════════
# §2  ARC COLOR PALETTE  —  16-color standard
# ═══════════════════════════════════════════════════════════════════
# Index → RGB mapping used for rendering.
# All games use the same 16-color ARC palette.
# Grid cell values MUST be integers in range [0, 15].

ARC_PALETTE = np.array([
    [0,   0,   0],     # 0  Black
    [0,   116, 217],   # 1  Blue
    [255, 65,  54],    # 2  Red
    [46,  204, 64],    # 3  Green
    [255, 220, 0],     # 4  Yellow
    [170, 170, 170],   # 5  Grey
    [240, 18,  190],   # 6  Magenta
    [255, 133, 27],    # 7  Orange
    [127, 219, 255],   # 8  Cyan
    [135, 12,  37],    # 9  Maroon
    [0,   48,  73],    # 10 Dark Teal
    [106, 76,  48],    # 11 Brown
    [255, 182, 193],   # 12 Pink
    [80,  80,  80],    # 13 Dark Grey
    [50,  205, 50],    # 14 Lime
    [128, 0,   128],   # 15 Purple
], dtype=np.uint8)


# ═══════════════════════════════════════════════════════════════════
# §3  SPRITES  —  Define all game sprites
# ═══════════════════════════════════════════════════════════════════
# Sprites are defined at MODULE level using Sprite(...).
# Use .clone().set_position(x, y) when adding to levels.
#
# Sprite(
#     pixels=[[color_index]],   # 2D list of ARC palette indices (0-15 ONLY)
#     name="sprite_name",
#     visible=True,
#     collidable=True/False,
#     layer=int,                # Higher layer renders on top
#     tags=["tag1", "tag2"],    # For querying sprites by tag
# )

sprites = {
    "player": Sprite(
        pixels=[[3]],           # Green
        name="player",
        visible=True,
        collidable=True,
        layer=2,
        tags=["player"],
    ),
    "wall": Sprite(
        pixels=[[5]],           # Grey
        name="wall",
        visible=True,
        collidable=True,
        layer=1,
        tags=["wall"],
    ),
    "goal": Sprite(
        pixels=[[4]],           # Yellow
        name="goal",
        visible=True,
        collidable=False,
        layer=0,
        tags=["goal"],
    ),
    "floor": Sprite(
        pixels=[[0]],           # Black
        name="floor",
        visible=True,
        collidable=False,
        layer=-1,
        tags=["floor"],
    ),
}


# ═══════════════════════════════════════════════════════════════════
# §4  LEVELS  —  Build Level objects
# ═══════════════════════════════════════════════════════════════════
# Each level is a Level(sprites=..., grid_size=..., name=..., data=...)
# Minimum 4 levels required (baseline_actions must have >=4 entries).
#
# Level data is arbitrary dict accessible via level.get_data("key").
# grid_size = (width, height), values between 3 and 64.
#
# IMPORTANT: The number of Level objects you create here MUST exactly
# match "total_levels" in metadata.json. A mismatch breaks the score
# formula: score = levels_completed / total_levels.

def make_level_1():
    gw, gh = 9, 9
    s = []
    # ... build sprites ...
    s.append(sprites["player"].clone().set_position(1, 1))
    s.append(sprites["goal"].clone().set_position(7, 7))
    return Level(
        sprites=s,
        grid_size=(gw, gh),
        name="Level 1",
        data={"gw": gw, "gh": gh, "max_moves": 50},
    )


# Repeat for levels 2-5 (minimum 4 levels required)
# def make_level_2(): ...
# def make_level_3(): ...
# def make_level_4(): ...


# ═══════════════════════════════════════════════════════════════════
# §5  OPTIONAL: HUD CLASSES
# ═══════════════════════════════════════════════════════════════════
# If your game needs custom UI overlays (move bars, life indicators),
# subclass RenderableUserDisplay:
#
# class MyHUD(RenderableUserDisplay):
#     def __init__(self, game_ref):
#         self._game = game_ref
#
#     def render_interface(self, frame: np.ndarray) -> np.ndarray:
#         # frame is the camera-rendered 2D index grid
#         # Draw directly on frame, return it
#         return frame
#
# Or use ToggleableUserDisplay for on/off slot displays (e.g. lives):
#   life_pairs = [(on_sprite, off_sprite), ...]
#   hud = ToggleableUserDisplay(life_pairs)
#   hud.enable(slot) / hud.disable(slot)


# ═══════════════════════════════════════════════════════════════════
# §6  ENGINE CLASS  —  ARCBaseGame subclass
# ═══════════════════════════════════════════════════════════════════
# NAMING: Class name = game_id with first letter capitalized.
#   "xx00" → Xx00
#
# REQUIRED:
#   - __init__(self, seed: int = 0) with super().__init__(game_id, levels, camera, available_actions)
#   - on_set_level(self, level: Level) — called when level changes
#   - step(self) — game logic; EVERY return path must call self.complete_action()
#   - If game has lives: self._lives, self.lose()
#   - If game has level completion: self.next_level()
#   - If game has undo (ACTION7): maintain an undo stack/history
#   - If game has handle_reset: manage 2-tier reset logic
#
# ALLOWED ACTIONS (pick a subset):
#   0 = reset (REQUIRED), 1 = up, 2 = down, 3 = left, 4 = right,
#   5 = select, 6 = click, 7 = undo
#
# RANDOMNESS: Use random.Random(seed) — NEVER use bare random.* or np.random.*
#   self._rng = random.Random(seed)
#
# SCORING RULES:
#   - engine._score tracks levels completed (managed by ARCBaseGame)
#   - next_level() increments _score by 1 and advances to the next level
#   - NEVER manually set or modify _score
#   - NEVER call next_level() more than once per level solve
#   - lose() triggers GAME_OVER state in the engine

class Xx00(ARCBaseGame):

    def __init__(self, seed: int = 0) -> None:
        self._rng = random.Random(seed)

        self._lives = 3                     # If game uses lives
        self._history: List[Dict] = []      # If game uses undo (ACTION7)

        game_levels = [
            make_level_1(),
            # make_level_2(), make_level_3(), make_level_4(), ...
        ]

        # Camera: x, y, width, height, background, letter_box, interfaces
        # width/height must match the level grid_size (or be overridden in on_set_level)
        camera = Camera(
            x=0, y=0,
            width=9, height=9,
            background=0,     # ARC palette index for background
            letter_box=0,     # ARC palette index for letterbox/padding
            interfaces=[],    # List of RenderableUserDisplay / ToggleableUserDisplay
        )

        # super().__init__() — MUST pass all 4 required args
        super().__init__(
            "xx00",                          # game_id (MUST match folder name)
            game_levels,                     # levels list
            camera,                          # Camera object
            available_actions=[0, 1, 2, 3, 4, 7],  # subset of {0,1,2,3,4,5,6,7}
            # NOTE: 0 (reset) MUST always be included
        )

    def on_set_level(self, level: Level) -> None:
        gw = self.current_level.get_data("gw")
        gh = self.current_level.get_data("gh")

        # Get sprites by tag
        # self.player = self.current_level.get_sprites_by_tag("player")[0]

        # Reset per-level state
        self._history = []

        # Update camera if grid size changes per level
        self.camera.width = gw
        self.camera.height = gh

    # CRITICAL: Every code path MUST call self.complete_action() before return
    def step(self) -> None:
        # Reset is handled automatically by arcengine.
        # If you need custom reset logic, override handle_reset() instead.
        if self.action.id == GameAction.RESET:
            self.complete_action()
            return

        # Handle UNDO (ACTION7)
        if self.action.id == GameAction.ACTION7:
            self._restore_from_undo()
            self.complete_action()
            return

        # Handle DIRECTIONAL ACTIONS (ACTION1-4)
        dx, dy = 0, 0
        if self.action.id == GameAction.ACTION1:    # up
            dx, dy = 0, -1
        elif self.action.id == GameAction.ACTION2:  # down
            dx, dy = 0, 1
        elif self.action.id == GameAction.ACTION3:  # left
            dx, dy = -1, 0
        elif self.action.id == GameAction.ACTION4:  # right
            dx, dy = 1, 0

        # Handle SELECT (ACTION5)
        if self.action.id == GameAction.ACTION5:
            pass  # selection logic

        # Handle CLICK (ACTION6)
        # The bridge sends click coordinates as space-separated:
        #   "click 5 10" → ActionInput(id=ACTION6, data={"x": 5, "y": 10})
        # if self.action.id == GameAction.ACTION6:
        #     display_x = self.action.data.get("x", None)
        #     display_y = self.action.data.get("y", None)
        #     if display_x is not None and display_y is not None:
        #         grid_coords = self.camera.display_to_grid(display_x, display_y)
        #         ...

        # Save undo state BEFORE making changes
        self._save_state()

        # Apply movement / game logic
        # ...

        # Check win condition — call next_level() EXACTLY ONCE per level solve
        if self._check_win():
            self.next_level()       # Increments _score by 1, advances level
            self.complete_action()
            return

        # Check lose condition (if using lives)
        # if self._lives <= 0:
        #     self.lose()           # Triggers GAME_OVER state in engine
        #     self.complete_action()
        #     return

        self.complete_action()      # MUST call — every path ends here

    # OPTIONAL: Custom 2-tier reset logic
    # Override handle_reset() to implement:
    #   - First reset  → restart current level
    #   - Second consecutive reset (no actions between) → full game reset
    # About half the games use this pattern.
    def handle_reset(self) -> None:
        # Pattern A: Track _action_count
        # if self._action_count == 0 or self._state == EngineGameState.WIN:
        #     self.full_reset()
        # else:
        #     self.level_reset()
        pass

    # Undo helpers (if ACTION7 is in available_actions)
    def _save_state(self) -> None:
        self._history.append({
            # Save whatever game state needs restoring
            # "player_pos": (self.player.x, self.player.y),
        })

    def _restore_from_undo(self) -> None:
        if not self._history:
            return
        state = self._history.pop()
        # Restore state from snapshot
        # self.player.set_position(*state["player_pos"])

    def _check_win(self) -> bool:
        # Return True when current level is solved
        return False

    # Lives helper (if game uses lives)
    # IMPORTANT: Always decrement by 1: self._lives -= 1
    # NEVER set self._lives = 0 directly
    def _lose_life(self) -> None:
        self._lives -= 1
        if self._lives <= 0:
            self.lose()             # Triggers GAME_OVER in engine
        else:
            self._restore_level()   # Reset current level, keep lives


# ═══════════════════════════════════════════════════════════════════
# §7  PUZZLE ENVIRONMENT  —  String-action wrapper
# ═══════════════════════════════════════════════════════════════════
# Wraps the engine class with string-based actions and text/image obs.
# This is the primary interface consumed by the eval harness bridge.
#
# REQUIRED METHODS:
#   __init__(self, seed: int = 0)
#   reset() -> GameState
#   step(action: str) -> StepResult
#   get_actions() -> List[str]
#   is_done() -> bool
#   render(mode: str = "rgb_array") -> np.ndarray
#   close() -> None
#
# HOW THE BRIDGE CALLS THIS CLASS:
#   1. pe = PuzzleEnvironment(seed=0)
#   2. state = pe.reset()               — bridge reads state.metadata
#   3. result = pe.step("up")           — bridge reads result.state.metadata
#   4. actions = pe.get_actions()        — bridge reads available actions
#   5. pe.close()                        — cleanup
#
# The bridge also reaches into pe._engine.camera.render(sprites)
# to get the 2D color-index grid for rendering. The engine attribute
# MUST be named _engine (not _game or anything else).
#
# ACTION STRING FORMAT:
#   The bridge sends all action strings in LOWERCASE.
#   For click actions, the bridge reconstructs "click x y" (space-separated).
#   Example: "click 5 10" — NOT "click:5,10" or "click_5_10".
#   Your _ACTION_MAP keys and step() parsing MUST use this format.

class PuzzleEnvironment:

    # Action name → GameAction mapping
    # Keys MUST be lowercase. MUST include "reset".
    # MUST match available_actions from engine.
    _ACTION_MAP: Dict[str, GameAction] = {
        "reset": GameAction.RESET,
        "up":    GameAction.ACTION1,
        "down":  GameAction.ACTION2,
        "left":  GameAction.ACTION3,
        "right": GameAction.ACTION4,
        # "select": GameAction.ACTION5,    # uncomment if game uses select
        # "click":  GameAction.ACTION6,    # uncomment if game uses click
        "undo":  GameAction.ACTION7,
    }

    _VALID_ACTIONS = list(_ACTION_MAP.keys())

    def __init__(self, seed: int = 0) -> None:
        # Engine attribute MUST be named _engine (bridge accesses pe._engine)
        self._engine = Xx00(seed=seed)
        self._total_turns = 0
        self._done = False
        self._game_won = False
        self._game_over = False

        # Two-tier reset tracking (RECOMMENDED)
        # Prevents accidental full resets on first reset call.
        self._last_action_was_reset = False

    def reset(self) -> GameState:
        e = self._engine

        # Two-tier reset logic:
        #   consecutive reset or post-win → full reset (2 resets → full_reset)
        #   otherwise → level reset (1 reset → level_reset)
        if self._game_won or self._last_action_was_reset:
            e.perform_action(ActionInput(id=GameAction.RESET))
            e.perform_action(ActionInput(id=GameAction.RESET))
        else:
            e.perform_action(ActionInput(id=GameAction.RESET))

        self._total_turns = 0
        self._done = False
        self._last_action_was_reset = True
        self._game_won = False
        self._game_over = False

        return self._build_game_state()

    def get_actions(self) -> List[str]:
        # When done (WIN or GAME_OVER), only "reset" is available.
        # The adapter layer enforces ["reset"] for GAME_OVER specifically,
        # but the game should also return it here for consistency.
        if self._done:
            return ["reset"]
        return list(self._VALID_ACTIONS)

    def is_done(self) -> bool:
        return self._done

    def step(self, action: str) -> StepResult:
        e = self._engine

        # Handle "reset" action
        if action == "reset":
            state = self.reset()
            return StepResult(
                state=state, reward=0.0, done=False, info={"action": "reset"}
            )

        # Handle click with coordinates: "click x y" (space-separated)
        # The bridge sends "click 5 10" as a single action string.
        # Parse it to extract coordinates for ActionInput.
        click_data: Dict[str, Any] = {}
        base_action = action
        if action.startswith("click "):
            parts = action.split()
            base_action = "click"
            if len(parts) >= 3:
                try:
                    click_data = {"x": int(parts[1]), "y": int(parts[2])}
                except (ValueError, IndexError):
                    pass

        # Validate action
        if base_action not in self._ACTION_MAP:
            raise ValueError(
                f"Invalid action '{action}'. "
                f"Must be one of {list(self._ACTION_MAP.keys())}"
            )

        self._last_action_was_reset = False
        self._total_turns += 1

        game_action = self._ACTION_MAP[base_action]
        info: Dict = {"action": action}

        level_before = e.level_index

        # Perform the action
        # raw=True returns frame with .state attribute for WIN/GAME_OVER detection
        if click_data:
            action_input = ActionInput(id=game_action, data=click_data)
        else:
            action_input = ActionInput(id=game_action)
        frame = e.perform_action(action_input, raw=True)

        # Detect game state from engine frame
        # frame.state.name is set by arcengine after step():
        #   "WIN"       — all levels completed (after final next_level())
        #   "GAME_OVER" — lose() was called and lives exhausted
        #   other       — still playing
        state_name = frame.state.name if frame and frame.state else ""
        game_won = state_name == "WIN"
        game_over = state_name == "GAME_OVER"

        # Compute reward: 1.0 / total_levels per level completion
        # This ensures score = levels_completed / total_levels at the adapter
        total_levels = len(self._engine._levels)
        level_reward = 1.0 / total_levels

        if game_won:
            self._done = True
            self._game_won = True
            self._game_over = False
            info["reason"] = "game_complete"
            return StepResult(
                state=self._build_game_state(done=True),
                reward=level_reward,
                done=True,
                info=info,
            )

        if game_over:
            self._done = True
            self._game_won = False
            self._game_over = True
            info["reason"] = "game_over"
            return StepResult(
                state=self._build_game_state(done=True),
                reward=0.0,
                done=True,
                info=info,
            )

        # Level advanced? (next_level() was called but game not fully won yet)
        reward = 0.0
        if e.level_index != level_before:
            reward = level_reward
            info["reason"] = "level_complete"

        return StepResult(
            state=self._build_game_state(done=False),
            reward=reward,
            done=False,
            info=info,
        )

    def render(self, mode: str = "rgb_array") -> np.ndarray:
        if mode != "rgb_array":
            raise ValueError(f"Unsupported render mode: {mode}")
        e = self._engine
        index_grid = e.camera.render(e.current_level.get_sprites())
        h, w = index_grid.shape[:2]
        rgb = np.zeros((h, w, 3), dtype=np.uint8)
        for idx in range(len(ARC_PALETTE)):
            mask = index_grid == idx
            if mask.ndim == 3:
                mask = mask[:, :, 0]
            rgb[mask] = ARC_PALETTE[idx]
        out_size = 64
        if h != out_size or w != out_size:
            scale_y = out_size / h
            scale_x = out_size / w
            ys = (np.arange(out_size) / scale_y).astype(int)
            xs = (np.arange(out_size) / scale_x).astype(int)
            ys = np.clip(ys, 0, h - 1)
            xs = np.clip(xs, 0, w - 1)
            rgb = rgb[np.ix_(ys, xs)]
        return rgb

    def close(self) -> None:
        self._engine = None

    # ── PRIVATE: Build text observation ──
    # The eval harness adapter builds its OWN header line for renderText()
    # using frame metadata (grid size, level, score, state). This method
    # provides the game-specific text that agents use to understand the
    # board. Include: grid state, player position, lives, moves remaining,
    # and any other relevant game info.
    #
    # EXAMPLE OUTPUT:
    #   "Level 1 | Lives 3 | Moves 5/50\n"
    #   "  0 1 2 3 4 5 6 7 8\n"
    #   "0 . . # # # # # . .\n"
    #   "1 . P . . . . . . .\n"
    #   "2 . . . # . # . . .\n"
    #   "...\n"
    #   "7 . . . . . . . G .\n"
    #   "8 . . # # # # # . ."
    def _build_text_observation(self) -> str:
        e = self._engine
        level_num = e.level_index + 1
        total = len(e._levels)
        # Build a grid-based text representation
        # Replace this placeholder with actual grid rendering
        lines = [f"Level {level_num}/{total}"]
        # Example: render the camera grid as text
        # grid = e.camera.render(e.current_level.get_sprites())
        # for row in grid:
        #     lines.append(" ".join(str(int(c)) for c in row))
        return "\n".join(lines)

    # ── PRIVATE: Build full GameState ──
    # CRITICAL: The bridge reads metadata to determine state and score.
    # The metadata keys and their values MUST be correct:
    #
    #   game_over:        True when agent LOST (lose() called, lives exhausted)
    #                     False when agent WON or still playing
    #                     The bridge uses: done=True + game_over=True → "GAME_OVER"
    #                                      done=True + game_over=False → "WIN"
    #
    #   levels_completed: engine._score (incremented by next_level())
    #                     The adapter computes: score = levels_completed / total_levels
    #
    #   total_levels:     len(engine._levels) — MUST match metadata.json
    #
    #   level_index:      engine.level_index (0-based current level)
    def _build_game_state(self, done: bool = False) -> GameState:
        e = self._engine
        valid_actions = self.get_actions() if not done else None
        return GameState(
            text_observation=self._build_text_observation(),
            image_observation=None,
            valid_actions=valid_actions,
            turn=self._total_turns,
            metadata={
                "total_levels": len(e._levels),
                "level_index": e.level_index,
                "levels_completed": getattr(e, "_score", 0),
                "game_over": self._game_over,
                "done": done,
                "info": {},
            },
        )


# ═══════════════════════════════════════════════════════════════════
# §8  ARC GAME ENV  —  Gymnasium wrapper
# ═══════════════════════════════════════════════════════════════════
# Standard gymnasium.Env interface for RL training.
# This class is IDENTICAL across all games except for ACTION_LIST.
#
# REQUIRED:
#   - Class-level metadata dict with render_modes
#   - ACTION_LIST matching PuzzleEnvironment's action names
#   - __init__, reset, step, render, close
#   - _get_obs, _resize_nearest, _build_info helpers
#   - observation_space, action_space
#   - _action_to_string, _string_to_action mappings
#   - render_mode handling
#   - GymEnv super().__init__() must have NO arguments

class ArcGameEnv(gym.Env):

    metadata: Dict[str, Any] = {
        "render_modes": ["rgb_array"],
        "render_fps": 5,
    }

    # ACTION_LIST: ordered string actions
    # MUST match the actions in PuzzleEnvironment._ACTION_MAP
    # MUST include "reset"
    # Only allowed names: reset, up, down, left, right, select, click, undo
    ACTION_LIST: List[str] = [
        "reset",
        "up",
        "down",
        "left",
        "right",
        # "select",    # include if game uses select
        # "click",     # include if game uses click
        "undo",
    ]

    OBS_HEIGHT: int = 64
    OBS_WIDTH: int = 64

    def __init__(
        self,
        seed: int = 0,
        render_mode: Optional[str] = None,
    ) -> None:
        super().__init__()

        if render_mode is not None and render_mode not in self.metadata["render_modes"]:
            raise ValueError(
                f"Unsupported render_mode '{render_mode}'. "
                f"Supported: {self.metadata['render_modes']}"
            )
        self.render_mode: Optional[str] = render_mode

        self._action_to_string: Dict[int, str] = {
            i: a for i, a in enumerate(self.ACTION_LIST)
        }
        self._string_to_action: Dict[str, int] = {
            a: i for i, a in enumerate(self.ACTION_LIST)
        }

        self.observation_space: spaces.Space = spaces.Box(
            low=0,
            high=255,
            shape=(self.OBS_HEIGHT, self.OBS_WIDTH, 3),
            dtype=np.uint8,
        )
        self.action_space: spaces.Space = spaces.Discrete(len(self.ACTION_LIST))

        self._seed: int = seed
        self._env: Any = None

    def reset(
        self,
        *,
        seed: Optional[int] = None,
        options: Optional[Dict[str, Any]] = None,
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        super().reset(seed=seed)

        if seed is not None:
            self._seed = seed

        self._env = PuzzleEnvironment(seed=self._seed)
        state = self._env.reset()

        return self._get_obs(), self._build_info(state)

    def step(self, action: int) -> Tuple[np.ndarray, float, bool, bool, Dict[str, Any]]:
        action_str: str = self._action_to_string[int(action)]
        result: StepResult = self._env.step(action_str)

        obs = self._get_obs()
        reward: float = result.reward
        terminated: bool = result.done
        truncated: bool = False    # MUST always be False
        info = self._build_info(result.state, result.info)

        return obs, reward, terminated, truncated, info

    def render(self) -> Optional[np.ndarray]:
        if self.render_mode == "rgb_array":
            return self._get_obs()
        return None

    def close(self) -> None:
        if self._env is not None:
            self._env.close()
            self._env = None

    def action_mask(self) -> np.ndarray:
        mask = np.zeros(len(self.ACTION_LIST), dtype=np.int8)
        if self._env is not None:
            for a in self._env.get_actions():
                idx = self._string_to_action.get(a)
                if idx is not None:
                    mask[idx] = 1
        return mask

    def _get_obs(self) -> np.ndarray:
        frame = self._env.render(mode="rgb_array")
        if frame.shape[0] != self.OBS_HEIGHT or frame.shape[1] != self.OBS_WIDTH:
            frame = self._resize_nearest(frame, self.OBS_HEIGHT, self.OBS_WIDTH)
        return frame

    @staticmethod
    def _resize_nearest(img: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
        src_h, src_w = img.shape[0], img.shape[1]
        row_idx = (np.arange(target_h) * src_h // target_h).astype(int)
        col_idx = (np.arange(target_w) * src_w // target_w).astype(int)
        return img[np.ix_(row_idx, col_idx)].astype(np.uint8)

    def _build_info(
        self, state: GameState, step_info: Optional[Dict] = None
    ) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "text_observation": state.text_observation,
            "valid_actions": state.valid_actions,
            "turn": state.turn,
            "game_metadata": state.metadata,
        }
        if step_info:
            info["step_info"] = step_info
        return info


# ═══════════════════════════════════════════════════════════════════
# §9  MAIN BLOCK  —  Optional self-test
# ═══════════════════════════════════════════════════════════════════
# The main block is OUTSIDE the game code scope and is allowed to
# use print(), imports, etc. Keep it minimal.

if __name__ == "__main__":
    from gymnasium.utils.env_checker import check_env

    env = ArcGameEnv(seed=0, render_mode="rgb_array")
    check_env(env.unwrapped, skip_render_check=True)

    obs, info = env.reset()
    mask = env.action_mask()
    valid_indices = np.where(mask == 1)[0]
    if len(valid_indices) > 0:
        obs, reward, term, trunc, info = env.step(valid_indices[0])

    env.close()


# ═══════════════════════════════════════════════════════════════════
# §10  METADATA.JSON TEMPLATE  (separate file: xx00/metadata.json)
# ═══════════════════════════════════════════════════════════════════
#
# {
#   "game_id": "xx00",                          // MUST match folder name
#   "total_levels": 5,                           // MUST match len(levels) in code
#   "default_fps": 5,
#   "baseline_actions": [10, 15, 20, 25, 30],   // One per level, >=4 entries, all positive ints
#   "tags": ["puzzle", "grid", "movement"],      // Descriptive tags
#   "local_dir": "environment_files/xx00",
#   "available_actions": [
#     {
#       "id": 0,
#       "name": "reset",
#       "type": "system",                        // id=0 MUST be type "system"
#       "description": "Reset current level or full game on consecutive reset"
#     },
#     {
#       "id": 1,
#       "name": "up",
#       "type": "simple",
#       "description": "Move player up"
#     },
#     // ... more actions ...
#     // If click (id=6) is used:
#     // {
#     //   "id": 6,
#     //   "name": "click",
#     //   "type": "complex",                    // id=6 MUST be type "complex"
#     //   "description": "Click a grid position",
#     //   "data_schema": { "x": "int (0-63)", "y": "int (0-63)" }  // REQUIRED for complex
#     // }
#   ],
#   "levels": [
#     {
#       "level": 1,                              // 1-indexed, sequential
#       "grid_size": [9, 9],                     // [width, height], each 3-64
#       "camera_size": [9, 9],                   // Must match Camera(width, height) in code
#       "display_size": [9, 9],                  // Must not exceed camera_size
#       "mechanics": ["wall", "movement"]        // List of mechanics used
#     },
#     // ... one entry per level ...
#   ]
# }
#
# VALIDATION RULES:
#   - game_id matches folder name
#   - total_levels == len(levels) == len(baseline_actions) == len(game_levels in code)
#   - baseline_actions: >=4 entries, all positive integers
#   - available_actions: unique ids, id=0 present with type="system"
#   - id=6 (click) has type="complex" with data_schema
#   - levels: sequential 1-indexed
#   - Each level has: grid_size, camera_size, display_size, mechanics
#   - display_size <= camera_size per dimension
#   - grid_size values between 3 and 64
#   - camera_size matches Camera(width, height) in code
#   - ALLOWED top-level fields ONLY:
#     game_id, total_levels, default_fps, baseline_actions,
#     tags, local_dir, available_actions, levels
#   - Action IDs MUST be unique. No duplicates.


# ═══════════════════════════════════════════════════════════════════
# CHECKLIST  —  Verify before submission
# ═══════════════════════════════════════════════════════════════════
#
# STRUCTURE:
#   [] File: xx00/xx00.py and xx00/metadata.json exist
#   [] No BOM in .py file
#   [] No syntax errors
#   [] No comments in game code (comments only allowed in __main__ block)
#   [] No docstrings in game code
#   [] No print() in game code
#   [] No input() calls
#   [] No global statements
#   [] No forbidden imports (requests, urllib, http, socket, subprocess, etc.)
#   [] No forbidden builtins (eval, exec, compile, __import__, open)
#   [] No solution-leak variable names (solution, optimal, winning, cheat, etc.)
#
# CLASSES:
#   [] GameState dataclass with: text_observation, image_observation, valid_actions, turn, metadata
#   [] StepResult dataclass with: state, reward, done, info
#   [] Engine class (Xx00) extends ARCBaseGame
#   [] PuzzleEnvironment class (NOT inheriting engine)
#   [] ArcGameEnv class extends gymnasium.Env
#
# ENGINE (Xx00):
#   [] __init__(self, seed: int = 0) with super().__init__(game_id, levels, camera, available_actions)
#   [] on_set_level(self, level) implemented
#   [] step(self) implemented — every return path calls complete_action()
#   [] Uses random.Random(seed) — no bare random.* or np.random.*
#   [] next_level() called EXACTLY ONCE per level solve — never more
#   [] lose() called on game over (if using _lives)
#   [] _lives decremented by 1, never set to 0 directly
#   [] _score is NEVER manually modified (managed by next_level())
#
# PUZZLE ENVIRONMENT:
#   [] __init__(self, seed: int = 0) — creates engine as self._engine (name matters!)
#   [] reset() -> GameState — clears _done, _game_won, _game_over, _total_turns
#   [] step(action: str) -> StepResult — handles "reset", click parsing, invalid actions
#   [] get_actions() -> List[str] — returns ["reset"] when _done is True
#   [] is_done() -> bool
#   [] render(mode="rgb_array") -> np.ndarray (has mode parameter)
#   [] close() -> None (sets _engine = None)
#   [] Two-tier reset tracking (_last_action_was_reset)
#   [] Reward = 1.0 / len(engine._levels) per level (NOT hardcoded float)
#   [] No negative rewards
#   [] _game_over flag set True ONLY on lose, False on win and reset
#   [] _game_won flag set True ONLY on win, False on lose and reset
#   [] Click actions parsed as "click x y" (space-separated, NOT "click:x,y")
#
# METADATA (GameState.metadata):
#   [] "total_levels" == len(engine._levels)
#   [] "level_index" == engine.level_index (0-based)
#   [] "levels_completed" == getattr(engine, "_score", 0)
#   [] "game_over" == self._game_over (True only on lose, False on win/playing)
#   [] "done" == done parameter
#   [] "info" == {} or additional dict
#
# HARNESS CONTRACT:
#   [] Bridge state: done=True + game_over=True → GAME_OVER
#   [] Bridge state: done=True + game_over=False → WIN
#   [] Bridge state: done=False → IN_PROGRESS
#   [] GAME_OVER is NOT terminal — agent can reset to retry
#   [] Only WIN ends the evaluation run (isDone() = true)
#   [] Score = levels_completed / total_levels (adapter computes this)
#   [] Score is monotonically non-decreasing within uninterrupted play
#   [] Score is in [0.0, 1.0] at all times
#   [] After reset: state=IN_PROGRESS, score=0 (on fresh PuzzleEnvironment)
#   [] Grid: 2D array of integers in [0, 15], rectangular, non-empty
#
# ARC GAME ENV:
#   [] Class-level metadata dict with "render_modes": ["rgb_array"]
#   [] ACTION_LIST with "reset" included; only allowed names
#   [] super().__init__() with NO arguments
#   [] observation_space = Box(0, 255, (64, 64, 3), uint8)
#   [] action_space = Discrete(len(ACTION_LIST))
#   [] _action_to_string and _string_to_action mappings
#   [] render_mode handling in __init__
#   [] reset() recreates PuzzleEnvironment, calls super().reset(seed=seed)
#   [] step() returns (obs, reward, terminated, truncated=False, info)
#   [] render() has NO mode parameter
#   [] close() sets _env = None
#   [] _get_obs() and _resize_nearest() helpers present
#   [] _build_info() helper present
#
# METADATA.JSON:
#   [] game_id matches folder name
#   [] total_levels matches len(levels), len(baseline_actions), AND len(game_levels) in code
#   [] baseline_actions: >=4 entries, all positive integers
#   [] available_actions: unique ids, id=0 present with type="system"
#   [] id=6 (click) has type="complex" with data_schema
#   [] levels: sequential 1-indexed, each has grid_size, camera_size, display_size, mechanics
#   [] display_size <= camera_size
#   [] grid_size values between 3 and 64
#   [] camera_size matches Camera(width, height) in code
#   [] No extra top-level fields beyond allowed set
