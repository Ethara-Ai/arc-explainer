"""
Standalone game loader — discovers and loads PuzzleEnvironment classes
from ARC-AGI-3 game files without any TS harness dependency.

Usage:
    from game_loader import discover_games, load_game
    games = discover_games()
    pe = load_game("bb01")
"""

import importlib.util
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Discovery ────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
ENV_FILES_DIR = PROJECT_ROOT / "puzzle-environments" / "ARC-AGI-3" / "environment_files"


@dataclass(frozen=True)
class DiscoveredGame:
    game_id: str
    game_dir: str
    py_file: str
    metadata: Dict[str, Any]


def discover_games(env_dir: Optional[str] = None) -> List[DiscoveredGame]:
    """Scan environment_files/ to find all games with metadata.json + .py file."""
    root = Path(env_dir) if env_dir else ENV_FILES_DIR
    if not root.exists():
        return []

    games: List[DiscoveredGame] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith((".", "_")):
            continue

        # Check for version subdirectories (v1, v2, ...) — pick latest
        resolved_dir = None
        version_dirs = sorted(
            d for d in entry.iterdir()
            if d.is_dir() and d.name.startswith("v") and not d.name.startswith("_")
        )
        if version_dirs:
            candidate = version_dirs[-1]
            if (candidate / "metadata.json").exists():
                resolved_dir = candidate

        # Fallback: metadata.json directly in game folder
        if not resolved_dir and (entry / "metadata.json").exists():
            resolved_dir = entry

        if not resolved_dir:
            continue

        # Load metadata
        try:
            metadata = json.loads((resolved_dir / "metadata.json").read_text())
        except Exception:
            continue

        game_id = metadata.get("game_id", entry.name)

        # Find Python file
        py_file = None
        for candidate_name in [f"{game_id}.py"]:
            candidate_path = resolved_dir / candidate_name
            if candidate_path.exists():
                py_file = str(candidate_path)
                break

        if not py_file:
            class_name = metadata.get("class_name", "")
            if class_name:
                candidate_path = resolved_dir / f"{class_name.lower()}.py"
                if candidate_path.exists():
                    py_file = str(candidate_path)

        if not py_file:
            py_files = sorted(resolved_dir.glob("*.py"))
            if py_files:
                py_file = str(py_files[0])

        if not py_file:
            continue

        games.append(DiscoveredGame(
            game_id=game_id,
            game_dir=str(resolved_dir),
            py_file=py_file,
            metadata=metadata,
        ))

    return games


# ── Loading ──────────────────────────────────────────────────────────────────

def load_puzzle_env_class(py_file: str):
    """Load the PuzzleEnvironment class from a game file."""
    mod_name = f"_arc_standalone_{os.path.basename(py_file).replace('.py', '')}"
    spec = importlib.util.spec_from_file_location(mod_name, py_file)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load spec from {py_file}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    pe_cls = getattr(module, "PuzzleEnvironment", None)
    if pe_cls is None or not isinstance(pe_cls, type):
        raise ImportError(f"No PuzzleEnvironment class in {py_file}")
    return pe_cls


def load_game(game_id: str, seed: int = 0, env_dir: Optional[str] = None):
    """Discover + instantiate a PuzzleEnvironment by game_id."""
    games = discover_games(env_dir)
    found = next((g for g in games if g.game_id == game_id), None)
    if not found:
        available = [g.game_id for g in games]
        raise ValueError(f"Game '{game_id}' not found. Available: {available}")
    cls = load_puzzle_env_class(found.py_file)
    return cls(seed=seed)


# ── Adapter (mirrors Arc3GameAdapter logic) ──────────────────────────────────

class GameAdapter:
    """
    Standalone adapter wrapping PuzzleEnvironment with the EXACT same logic
    as the TS Arc3GameAdapter — score calculation, state machine, isDone, etc.

    This is what the TS harness tests exercise. By replicating the logic here,
    standalone tests validate the same invariants without the TS harness.
    """

    def __init__(self, game_id: str, py_file: str, seed: int = 0):
        self.game_id = game_id
        self._cls = load_puzzle_env_class(py_file)
        self._pe = self._cls(seed=seed)
        self._last_state = None
        self._cumulative_reward = 0.0
        self._done = False
        self._step_count = 0
        self._total_levels_from_info = None

    def reset(self):
        """Reset game. Returns GameState."""
        self._last_state = self._pe.reset()
        self._done = False
        self._cumulative_reward = 0.0
        self._step_count = 0
        meta = getattr(self._last_state, "metadata", {}) or {}
        if self._total_levels_from_info is None:
            self._total_levels_from_info = meta.get("total_levels")
        return self._last_state

    def step(self, action: str):
        """Execute action. Returns StepResult."""
        if action.lower() == "reset":
            self.reset()
            return None
        result = self._pe.step(action)
        self._last_state = result.state
        self._cumulative_reward += result.reward
        self._done = result.done
        self._step_count += 1
        return result

    def get_actions(self) -> List[str]:
        """Available actions from PuzzleEnvironment."""
        return list(self._pe.get_actions())

    def get_available_actions(self) -> List[str]:
        """Available actions, matching TS adapter behavior."""
        if self._last_state is None:
            return ["up", "down", "left", "right", "select", "reset", "click", "undo"]
        meta = getattr(self._last_state, "metadata", {}) or {}
        is_game_over = bool(meta.get("game_over", False))
        if self._done and is_game_over:
            return ["reset"]
        actions = list(self._pe.get_actions())
        if "reset" not in actions:
            actions.append("reset")
        return actions

    @property
    def total_levels(self) -> Optional[int]:
        if self._last_state:
            meta = getattr(self._last_state, "metadata", {}) or {}
            tl = meta.get("total_levels")
            if tl is not None:
                return tl
        return self._total_levels_from_info

    @property
    def levels_completed(self) -> int:
        if self._last_state is None:
            return 0
        meta = getattr(self._last_state, "metadata", {}) or {}
        return meta.get("levels_completed", 0) or 0

    @property
    def level(self) -> Optional[int]:
        if self._last_state is None:
            return None
        meta = getattr(self._last_state, "metadata", {}) or {}
        return (meta.get("level_index", 0) or 0) + 1

    def get_score(self) -> float:
        """Score = levels_completed / total_levels, clamped to [0, 1]."""
        if self._last_state is None:
            return 0.0
        total = max(self.total_levels or 1, 1)
        return min(self.levels_completed / total, 1.0)

    def get_state(self) -> str:
        """Returns IN_PROGRESS, WIN, GAME_OVER, or NOT_PLAYED."""
        if self._last_state is None:
            return "NOT_PLAYED"
        total = self.total_levels or 0
        if total > 0 and self.levels_completed >= total:
            return "WIN"
        meta = getattr(self._last_state, "metadata", {}) or {}
        is_game_over = bool(meta.get("game_over", False))
        if self._done and is_game_over:
            return "GAME_OVER"
        if self._done:
            return "WIN"
        return "IN_PROGRESS"

    def is_done(self) -> bool:
        """True when game is truly finished (WIN or all levels completed)."""
        if self._last_state is None:
            return False
        total = self.total_levels or 0
        if total > 0 and self.levels_completed >= total:
            return True
        return self.get_state() == "WIN"

    def render_text(self) -> str:
        """Text representation of current state."""
        if self._last_state is None:
            return "(no state — call reset() first)"
        return getattr(self._last_state, "text_observation", "") or ""

    def get_grid(self):
        """Get 2D color grid from engine."""
        try:
            engine = getattr(self._pe, "_engine", None) or getattr(self._pe, "_game", None)
            if engine is None:
                return None
            cam = engine.camera
            sprites = engine.current_level.get_sprites()
            grid = cam.render(sprites)
            if hasattr(grid, "tolist"):
                return grid.tolist()
            return grid
        except Exception:
            return None

    def dispose(self):
        """Clean up."""
        if hasattr(self._pe, "close"):
            self._pe.close()


def create_adapter(game_id: str, env_dir: Optional[str] = None, seed: int = 0) -> GameAdapter:
    """Create a GameAdapter for a game_id (convenience factory)."""
    games = discover_games(env_dir)
    found = next((g for g in games if g.game_id == game_id), None)
    if not found:
        available = [g.game_id for g in games]
        raise ValueError(f"Game '{game_id}' not found. Available: {available}")
    return GameAdapter(found.game_id, found.py_file, seed=seed)
