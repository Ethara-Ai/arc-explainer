#!/usr/bin/env python3


import json
import math
import random
import signal
import sys
import threading
import time
import traceback
from typing import Any


# ---------------------------------------------------------------------------
# NDJSON event emission (matches arc3_openrouter_runner.py protocol)
# ---------------------------------------------------------------------------

def emit_event(event_type: str, data: dict[str, Any] | None = None) -> None:
    """Emit a single NDJSON event line to stdout."""
    event = {"type": event_type}
    if data:
        event.update(data)
    print(json.dumps(event), flush=True)


def emit_error(message: str, code: str = "RUNNER_ERROR") -> None:
    """Emit a stream.error event."""
    emit_event("stream.error", {"error": message, "code": code})


# ---------------------------------------------------------------------------
# Rate limit detection (mirrors eval_runner.py logic, locally implemented
# to avoid importing the full eval_runner module with its heavy deps)
# ---------------------------------------------------------------------------

def _is_rate_limit_error(error: Exception) -> bool:
    """Detect rate limit errors across all supported providers.

    Checks for: Gemini (429 + RESOURCE_EXHAUSTED), OpenAI (RateLimitError),
    Anthropic (RateLimitError), Bedrock (RuntimeError with 429), generic 429.
    """
    error_str = str(error).lower()
    # Common rate limit indicators
    if "429" in error_str or "rate_limit" in error_str or "rate limit" in error_str:
        return True
    if "resource_exhausted" in error_str:
        return True
    # Check for status_code attribute (many HTTP clients expose this)
    if hasattr(error, "status_code") and getattr(error, "status_code") == 429:
        return True
    # Check for response attribute with status_code
    resp = getattr(error, "response", None)
    if resp is not None and hasattr(resp, "status_code") and resp.status_code == 429:
        return True
    return False


def _is_gemini_transient_error(error: Exception) -> bool:
    """Detect Gemini transient errors (504 DEADLINE_EXCEEDED, 503 UNAVAILABLE)."""
    error_str = str(error).lower()
    return any(x in error_str for x in ["deadline_exceeded", "unavailable", "504", "503"])


def _compute_minute_boundary_wait() -> float:
    """Compute wait time aligned to the next clock minute + random jitter.

    Many rate limiters reset on minute boundaries. Aligning retries to these
    boundaries increases the chance of getting through on the first retry.
    """
    now = time.time()
    next_minute = math.ceil(now / 60) * 60
    jitter = random.uniform(5, 45)
    return max(1.0, (next_minute - now) + jitter)


def _interruptible_sleep(seconds: float, shutdown_event: threading.Event) -> bool:
    """Sleep that can be interrupted by a shutdown event.

    Returns True if shutdown was requested, False if the sleep completed normally.
    """
    return shutdown_event.wait(seconds)


# ---------------------------------------------------------------------------
# Retry wrapper (bridges eval harness retry logic with NDJSON event emission)
# ---------------------------------------------------------------------------

# Providers that handle their own context trimming (no crude token-budget trim)
_NO_BUDGET_TRIM_PROVIDERS = frozenset({
    "gemini", "gemini-fallback", "openrouter-gemini",
    "bedrock-claude", "anthropic", "openai", "bedrock-kimi",
})

# Retry configuration defaults
_RETRY_ATTEMPTS = 20        # Fewer than eval harness (50) since this is interactive
_RETRY_BACKOFF_BASE = 1.5
_RETRY_MAX_WAIT = 180.0     # 3 minutes max wait (vs eval's 5 min)


def _call_with_retry(
    provider: Any,
    system_prompt: str,
    conversation_history: list[dict[str, str]],
    current_observation: str,
    valid_actions: list[str],
    notepad_text: str,
    image_b64: str | None,
    shutdown_event: threading.Event,
    turn: int,
    retry_attempts: int = _RETRY_ATTEMPTS,
) -> Any:
    """Call provider.choose_action with retry logic matching eval harness patterns.

    3-tier backoff:
    - Tier 1 (rate limit): Wait until next minute boundary + jitter
    - Tier 2 (Gemini transient 504/503): Wait 30-60s
    - Tier 3 (all other errors): Exponential backoff (1.5^attempt, capped at 180s)

    Emits NDJSON retry events for frontend visibility.
    Returns the ProviderResponse on success, raises on exhausted retries.
    """
    last_error = None

    for attempt in range(retry_attempts):
        if shutdown_event.is_set():
            raise InterruptedError("Shutdown requested")

        try:
            return provider.choose_action(
                system_prompt=system_prompt,
                conversation_history=conversation_history,
                current_observation=current_observation,
                valid_actions=valid_actions,
                notepad=notepad_text,
                image_b64=image_b64,
            )
        except Exception as e:
            last_error = e

            if attempt >= retry_attempts - 1:
                # Last attempt — give up
                break

            # Classify error and compute wait time
            if _is_rate_limit_error(e):
                wait = _compute_minute_boundary_wait()
                tier = "rate_limit"
            elif _is_gemini_transient_error(e):
                wait = random.uniform(30, 60)
                tier = "gemini_transient"
            else:
                # Exponential backoff
                wait = min(_RETRY_BACKOFF_BASE ** attempt, _RETRY_MAX_WAIT)
                tier = "general"

            emit_event("stream.status", {
                "state": "retrying",
                "message": f"Turn {turn}: {tier} error, retry {attempt + 1}/{retry_attempts} "
                           f"in {wait:.0f}s — {type(e).__name__}: {str(e)[:200]}",
                "attempt": attempt + 1,
                "max_attempts": retry_attempts,
                "wait_seconds": round(wait, 1),
                "tier": tier,
            })

            # Wait (interruptible)
            if _interruptible_sleep(wait, shutdown_event):
                raise InterruptedError("Shutdown requested during retry wait")

    # Exhausted all retries
    raise RuntimeError(
        f"Provider call failed after {retry_attempts} attempts: {last_error}"
    ) from last_error


# ---------------------------------------------------------------------------
# Command handlers (list_games, list_models)
# ---------------------------------------------------------------------------

def handle_list_games() -> None:
    """Emit available games as a single NDJSON event."""
    from scripts.evaluate.game_loader import discover_games

    games = discover_games()
    # Convert Path objects to strings for JSON serialization
    serializable = []
    for g in games:
        serializable.append({
            "game_id": g["game_id"],
            "game_type": g["game_type"],
            "title": g["title"],
            "path": str(g["path"]),
        })
    emit_event("games.list", {"games": serializable, "count": len(serializable)})


def handle_list_models() -> None:
    """Emit available model keys as a single NDJSON event."""
    from scripts.evaluate.config import MODEL_REGISTRY

    models = []
    for key, cfg in MODEL_REGISTRY.items():
        models.append({
            "key": key,
            "name": cfg.name,
            "provider": cfg.provider,
            "model_id": cfg.model_id,
            "supports_vision": cfg.supports_vision,
        })
    emit_event("models.list", {"models": models, "count": len(models)})


# ---------------------------------------------------------------------------
# Main game runner
# ---------------------------------------------------------------------------

def run_game(config: dict[str, Any], shutdown_event: threading.Event) -> None:
    """Run a puzzle-environments game with an eval harness provider.

    Config keys:
        game_id (str, required): Game identifier (e.g., "cc01", "task_001")
        model_key (str, required): Model registry key (e.g., "claude-bedrock")
        max_turns (int, default 200): Maximum actions before stopping
        system_prompt (str|None): Override system prompt (uses prompt_builder default)
        seed (int, default 0): Random seed for ARC3 game instantiation
        context_window (int, default 50): Number of recent turns to keep in conversation
        with_images (bool, default False): Include PNG screenshots in observations
        agent_name (str|None): Display name for the agent (for UI labeling)
        retry_attempts (int, default 20): Max retries per provider call
        max_consecutive_skips (int, default 10): Max SKIP/invalid actions before aborting
    """
    from scripts.evaluate.game_loader import load_game
    from scripts.evaluate.config import create_provider, get_model_config
    from scripts.evaluate.runner.prompt_builder import build_system_prompt, build_turn_prompt
    from scripts.evaluate.runner.context_manager import ContextManager
    from scripts.evaluate.runner.notepad import Notepad

    game_id = config.get("game_id")
    model_key = config.get("model_key")
    max_turns = config.get("max_turns", 200)
    seed = config.get("seed", 0)
    context_window = config.get("context_window", 50)
    with_images = config.get("with_images", False)
    agent_name = config.get("agent_name", None)
    custom_system_prompt = config.get("system_prompt", None)
    retry_attempts = config.get("retry_attempts", _RETRY_ATTEMPTS)
    max_consecutive_skips = config.get("max_consecutive_skips", 10)

    if not game_id:
        emit_error("game_id is required", "INPUT_ERROR")
        return
    if not model_key:
        emit_error("model_key is required", "INPUT_ERROR")
        return

    # --- Phase 1: Initialize provider ---
    emit_event("agent.starting", {
        "game_id": game_id,
        "model_key": model_key,
        "agent_name": agent_name or model_key,
        "max_turns": max_turns,
    })

    try:
        model_cfg = get_model_config(model_key)
        provider = create_provider(model_key)
        emit_event("agent.ready", {
            "model": model_cfg.name,
            "model_id": model_cfg.model_id,
            "provider": model_cfg.provider,
        })
    except Exception as e:
        emit_error(f"Failed to create provider for '{model_key}': {e}", "PROVIDER_ERROR")
        return

    # --- Phase 2: Load game ---
    try:
        emit_event("stream.status", {"state": "running", "message": f"Loading game: {game_id}"})
        adapter = load_game(game_id, seed=seed)
        emit_event("stream.status", {
            "state": "running",
            "message": f"Game loaded: {adapter.title} (type={adapter.game_type})",
        })
    except FileNotFoundError as e:
        emit_error(str(e), "GAME_NOT_FOUND")
        return
    except Exception as e:
        emit_error(f"Failed to load game '{game_id}': {e}", "GAME_ERROR")
        return

    # --- Phase 3: Build system prompt ---
    if custom_system_prompt:
        system_prompt = custom_system_prompt
    else:
        system_prompt = build_system_prompt(
            game_type=adapter.game_type,
            max_steps=max_turns,
            context_window=context_window,
            with_images=with_images,
        )

    # --- Phase 4: Initialize context manager + notepad (DRY: from eval harness) ---
    context_mgr = ContextManager(window_size=context_window)
    notepad = Notepad(max_chars=4000)

    # Compute token budget based on model config (matches orchestrator.py logic)
    token_budget = None
    if model_cfg.provider not in _NO_BUDGET_TRIM_PROVIDERS:
        max_ctx = model_cfg.max_context_tokens or 128_000
        max_out = model_cfg.max_output_tokens or 16_000
        token_budget = max_ctx - max_out

    # --- Phase 5: Reset game and get initial state ---
    try:
        adapter.reset()

        # Build frame data in a format compatible with the frontend
        frame_data = _build_frame_data(adapter, game_id, action_counter=0)
        emit_event("game.frame_update", {"frameData": frame_data, "frameIndex": 0})
    except Exception as e:
        emit_error(f"Failed to reset game: {e}", "GAME_ERROR")
        return

    # --- Phase 6: Game loop ---
    turn = 0
    step = 0              # Steps count only successful actions (excludes SKIPs/invalids)
    consecutive_skips = 0  # Tracks SKIP + invalid actions for self-correction limit
    final_state = "IN_PROGRESS"
    total_cost_usd = 0.0
    total_input_tokens = 0
    total_output_tokens = 0
    total_reasoning_tokens = 0

    while step < max_turns:
        turn += 1

        # Check for shutdown between turns
        if shutdown_event.is_set():
            final_state = "CANCELLED"
            emit_event("stream.status", {"state": "cancelled", "message": "Shutdown requested"})
            break

        # Check terminal state from previous action
        state = adapter.get_state()
        if state == "WIN":
            final_state = "WIN"
            emit_event("stream.status", {"state": "completed", "message": "Game won!"})
            break
        if state == "GAME_OVER" and adapter.game_type == "arc2":
            # For ARC2, GAME_OVER is terminal (SUBMIT was wrong)
            final_state = "GAME_OVER"
            emit_event("stream.status", {
                "state": "completed",
                "message": "Game over (incorrect submission)",
            })
            break
        # For ARC3, GAME_OVER means the level failed — can RESET (not terminal)

        # Build observation for this turn
        observation = adapter.render_text()
        available_actions = adapter.get_available_actions()
        turn_prompt = build_turn_prompt(
            observation=observation,
            available_actions=available_actions,
            notepad=notepad.read(),
            step=step,          # 0-indexed for prompt_builder
            max_steps=max_turns,
        )

        # Get image if vision is enabled
        image_b64 = None
        if with_images and adapter.game_type == "arc3":
            try:
                image_b64 = adapter.render_png_base64()
            except Exception:
                pass  # Vision is optional; degrade gracefully

        # Get conversation history (with token budget trimming if needed)
        if token_budget is not None:
            conversation_history = context_mgr.get_context_within_budget(
                token_budget=token_budget,
                system_prompt=system_prompt,
                current_observation=turn_prompt,
            )
        else:
            conversation_history = context_mgr.get_context()

        # --- Call provider with retry ---
        emit_event("agent.tool_call", {"tool": "choose_action", "turn": turn, "step": step})

        try:
            response = _call_with_retry(
                provider=provider,
                system_prompt=system_prompt,
                conversation_history=conversation_history,
                current_observation=turn_prompt,
                valid_actions=available_actions,
                notepad_text=notepad.read(),
                image_b64=image_b64,
                shutdown_event=shutdown_event,
                turn=turn,
                retry_attempts=retry_attempts,
            )

            action = response.action
            reasoning = response.reasoning or ""
            notepad_update = response.notepad_update

            # Track costs
            total_cost_usd += response.cost_usd or 0.0
            total_input_tokens += response.input_tokens or 0
            total_output_tokens += response.output_tokens or 0
            total_reasoning_tokens += response.reasoning_tokens or 0

            # Update notepad if provider returned an update (DRY: using Notepad class)
            if notepad_update and notepad_update.strip():
                notepad.update(notepad_update)

            emit_event("agent.reasoning", {
                "reasoning": reasoning,
                "action": action,
                "turn": turn,
                "step": step,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "reasoning_tokens": response.reasoning_tokens,
                "cost_usd": response.cost_usd,
            })

        except InterruptedError:
            final_state = "CANCELLED"
            emit_event("stream.status", {"state": "cancelled", "message": "Shutdown during provider call"})
            break
        except Exception as e:
            emit_event("stream.status", {
                "state": "error",
                "message": f"Provider call failed after retries on turn {turn}: {e}",
            })
            traceback.print_exc(file=sys.stderr)
            final_state = "PROVIDER_FAILURE"
            break

        # --- SKIP handling: reject SKIP actions, feed error back into conversation ---
        if not action or action.strip().upper() == "SKIP":
            consecutive_skips += 1
            skip_msg = (
                f"ERROR: Your action '{action or '(empty)'}' is not valid. "
                f"You MUST choose from: {', '.join(available_actions)}. "
                f"Do not output SKIP."
            )
            emit_event("stream.status", {
                "state": "warning",
                "message": f"Turn {turn}: SKIP/empty action — "
                           f"consecutive_skips={consecutive_skips}/{max_consecutive_skips}",
            })

            # Feed rejection back into conversation for self-correction
            context_mgr.add_turn("user", turn_prompt)
            context_mgr.add_turn("assistant", json.dumps({"action": action or "SKIP", "reasoning": reasoning}))
            context_mgr.add_turn("user", skip_msg)

            if consecutive_skips >= max_consecutive_skips:
                emit_event("stream.status", {
                    "state": "error",
                    "message": f"Aborting: {consecutive_skips} consecutive SKIP/invalid actions",
                })
                final_state = "SKIP_LIMIT_REACHED"
                break

            # Exponential backoff between skips (capped at 10s)
            backoff = min(2.0 ** (consecutive_skips - 1), 10.0)
            time.sleep(backoff)
            continue  # Don't increment step, don't execute action

        # --- Execute action ---
        emit_event("agent.tool_call", {"tool": action, "reasoning": reasoning, "turn": turn, "step": step})

        try:
            adapter.step(action)
            emit_event("agent.tool_result", {"tool": action, "result": "executed", "turn": turn, "step": step})

            # Build and emit frame update
            frame_data = _build_frame_data(adapter, game_id, action_counter=step + 1)
            emit_event("game.frame_update", {"frameData": frame_data, "frameIndex": step + 1})

            # Successful action — reset consecutive_skips
            consecutive_skips = 0
            step += 1

        except (ValueError, RuntimeError) as e:
            # --- Invalid action recovery: feed rejection back, don't increment step ---
            consecutive_skips += 1
            invalid_msg = (
                f"ERROR: Action '{action}' was rejected by the game: {e}. "
                f"Valid actions are: {', '.join(available_actions)}. "
                f"Choose a different action."
            )
            emit_event("agent.tool_result", {
                "tool": action,
                "result": f"rejected: {e}",
                "turn": turn,
                "step": step,
            })
            emit_event("stream.status", {
                "state": "warning",
                "message": f"Turn {turn}: invalid action '{action}' — "
                           f"consecutive_skips={consecutive_skips}/{max_consecutive_skips}",
            })

            # Feed rejection into conversation for self-correction
            context_mgr.add_turn("user", turn_prompt)
            context_mgr.add_turn("assistant", json.dumps({"action": action, "reasoning": reasoning}))
            context_mgr.add_turn("user", invalid_msg)

            if consecutive_skips >= max_consecutive_skips:
                emit_event("stream.status", {
                    "state": "error",
                    "message": f"Aborting: {consecutive_skips} consecutive SKIP/invalid actions",
                })
                final_state = "SKIP_LIMIT_REACHED"
                break

            # Exponential backoff between invalid actions (capped at 10s)
            backoff = min(2.0 ** (consecutive_skips - 1), 10.0)
            time.sleep(backoff)
            continue  # Don't increment step, retry with correction feedback

        except Exception as e:
            # Unexpected error from adapter — log but continue
            emit_event("agent.tool_result", {"tool": action, "result": f"error: {e}", "turn": turn})
            emit_event("stream.status", {
                "state": "warning",
                "message": f"Action '{action}' caused unexpected error on turn {turn}: {e}",
            })
            traceback.print_exc(file=sys.stderr)
            step += 1  # Count as attempted, move on

        # Update conversation history (only for successful actions and unexpected errors)
        context_mgr.add_turn("user", turn_prompt)
        context_mgr.add_turn("assistant", json.dumps({
            "action": action,
            "reasoning": reasoning,
            "notepad_update": notepad_update,
        }))

        # Small delay to avoid rate limiting (less aggressive than retry waits)
        time.sleep(0.3)

    # --- Phase 7: Emit completion ---
    final_game_state = adapter.get_state()
    if final_game_state == "WIN":
        final_state = "WIN"
    elif step >= max_turns and final_state == "IN_PROGRESS":
        final_state = "MAX_TURNS_REACHED"

    final_score = adapter.get_score()
    levels_completed = getattr(adapter, "levels_completed", None)
    total_levels = getattr(adapter, "total_levels", None)

    emit_event("agent.completed", {
        "finalState": final_state,
        "totalTurns": turn,
        "totalSteps": step,
        "game_id": game_id,
        "model_key": model_key,
        "model_name": model_cfg.name,
        "score": final_score,
        "levels_completed": levels_completed,
        "total_levels": total_levels,
        "total_cost_usd": total_cost_usd,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "total_reasoning_tokens": total_reasoning_tokens,
        "consecutive_skips_at_end": consecutive_skips,
    })


def _build_frame_data(adapter: Any, game_id: str, action_counter: int) -> dict[str, Any]:
    """Build a frame data dict compatible with frontend expectations.

    Maps BaseGameAdapter state to the FrameData format used by
    Arc3ApiClient and the frontend game viewer.
    """
    score = adapter.get_score()
    state = adapter.get_state()
    available_actions = adapter.get_available_actions()

    # Parse the text observation to extract grid data if possible
    observation_text = adapter.render_text()

    # Attempt to get PNG for the frame
    image_b64 = None
    try:
        image_b64 = adapter.render_png_base64()
    except Exception:
        pass

    return {
        "game_id": game_id,
        "score": score,
        "state": state,
        "action_counter": action_counter,
        "available_actions": available_actions,
        "observation": observation_text,
        "image_b64": image_b64,
        "levels_completed": getattr(adapter, "levels_completed", None),
        "total_levels": getattr(adapter, "total_levels", None),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Global shutdown event for signal-driven graceful cancellation
_shutdown_event = threading.Event()


def _signal_handler(signum: int, frame: Any) -> None:
    """Handle SIGTERM/SIGINT by setting shutdown event."""
    _shutdown_event.set()


def main() -> None:
    """Entry point -- read JSON config from stdin, dispatch command or run game."""
    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    try:
        input_data = sys.stdin.read()
        if not input_data.strip():
            emit_error("No input provided. Send JSON config via stdin.", "INPUT_ERROR")
            return

        config = json.loads(input_data)

        # Check for meta-commands (list_games, list_models)
        command = config.get("command")
        if command == "list_games":
            handle_list_games()
            return
        if command == "list_models":
            handle_list_models()
            return

        # Default: run a game
        run_game(config, _shutdown_event)

    except json.JSONDecodeError as e:
        emit_error(f"Invalid JSON input: {e}", "INPUT_ERROR")
    except KeyboardInterrupt:
        emit_event("stream.status", {"state": "cancelled", "message": "Interrupted by user"})
        sys.exit(0)
    except Exception as e:
        emit_error(f"Unexpected error: {e}", "RUNNER_ERROR")
        traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
