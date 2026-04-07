
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Eval harness reuse (game loading + prompt building)
# ---------------------------------------------------------------------------
# Add project root to sys.path so `scripts.evaluate` resolves when running
# this file directly (e.g. `python scripts/gemini_priority_interactive.py`).
_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from scripts.evaluate.game_loader import discover_games, load_game
from scripts.evaluate.runner.prompt_builder import build_system_prompt, build_turn_prompt

# ---------------------------------------------------------------------------
# Gemini function calling setup (mirrors gemini_provider.py exactly)
# ---------------------------------------------------------------------------
_PLAY_ACTION_DECL = types.FunctionDeclaration(
    name="play_action",
    description="Choose your next action in the puzzle game.",
    parameters=types.Schema(
        type=types.Type.OBJECT,
        properties={
            "action": types.Schema(
                type=types.Type.STRING,
                description="Action to take (e.g. UP, DOWN, LEFT, RIGHT, SELECT, CLICK 10 15, SET_CELL 3)",
            ),
            "reasoning": types.Schema(
                type=types.Type.STRING,
                description="Brief explanation of why you chose this action",
            ),
            "notepad_update": types.Schema(
                type=types.Type.STRING,
                description="New notepad contents, or empty string to keep current",
            ),
        },
        required=["action", "reasoning"],
    ),
)

_TOOL = types.Tool(function_declarations=[_PLAY_ACTION_DECL])


# ---------------------------------------------------------------------------
# Gemini Priority client setup (mirrors GeminiProvider.__init__)
# ---------------------------------------------------------------------------
_PRIORITY_HEADERS = {
    "X-Vertex-AI-LLM-Request-Type": "shared",
    "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
}

_MODEL_ID = "gemini-3.1-pro-preview"
_BASE_URL = "https://aiplatform.googleapis.com/"
_TIMEOUT_MS = 180_000  # 3 min


def _create_client(api_key: str) -> genai.Client:
    """Create a Gemini Priority client routed through Vertex AI global endpoint."""
    client = genai.Client(
        api_key=api_key,
        http_options={
            "timeout": _TIMEOUT_MS,
            "headers": _PRIORITY_HEADERS,
            "base_url": _BASE_URL,
        },
    )

    # Patch api_version for Vertex AI publisher endpoint
    # (same stability guard as gemini_provider.py and test_priority.py)
    if not (
        hasattr(client, "_api_client")
        and hasattr(client._api_client, "_http_options")
        and hasattr(client._api_client._http_options, "api_version")
    ):
        raise RuntimeError(
            "google-genai SDK internal structure changed: "
            "_api_client._http_options.api_version not found. "
            "Pin google-genai to a known-good version or update the priority patch."
        )
    client._api_client._http_options.api_version = "v1/publishers/google"
    return client


# ---------------------------------------------------------------------------
# Response serialization
# ---------------------------------------------------------------------------
def _serialize_response(response: types.GenerateContentResponse) -> dict:
    """Serialize full API response to a JSON-serializable dict."""
    try:
        return response.to_json_dict()
    except Exception:
        return {"_serialization_error": True, "text": str(response)}


def _save_response(raw: dict, output_dir: Path, step: int) -> Path:
    """Write the raw response JSON to disk. Returns the file path."""
    path = output_dir / f"step_{step:04d}.json"
    with open(path, "w") as f:
        json.dump(raw, f, indent=2, default=str)
    return path


# ---------------------------------------------------------------------------
# Response parsing (extract action/reasoning from function call)
# ---------------------------------------------------------------------------
def _parse_response(response: types.GenerateContentResponse) -> dict[str, Any]:
    """Extract action, reasoning, notepad_update from the Gemini response.

    Returns a dict with keys: action, reasoning, notepad_update.
    Falls back to raw text if no function call found.
    """
    result: dict[str, Any] = {"action": None, "reasoning": "", "notepad_update": None}

    func_calls = response.function_calls
    if func_calls:
        for fc in func_calls:
            if fc.name == "play_action":
                args = dict(fc.args) if fc.args else {}
                result["action"] = str(args.get("action", "")).strip() or None
                result["reasoning"] = str(args.get("reasoning", "")).strip()
                nu = args.get("notepad_update")
                if nu is not None and str(nu).strip():
                    result["notepad_update"] = str(nu).strip()
                break

    # Fallback: show raw text if no function call
    if result["action"] is None and response.text:
        result["reasoning"] = f"(raw text, no function call): {response.text[:500]}"

    return result


# ---------------------------------------------------------------------------
# Usage metadata extraction
# ---------------------------------------------------------------------------
def _extract_usage(response: types.GenerateContentResponse) -> dict[str, Any]:
    """Extract token counts and traffic_type from usage_metadata."""
    info: dict[str, Any] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cached_tokens": 0,
        "traffic_type": None,
    }
    um = response.usage_metadata
    if not um:
        return info
    info["input_tokens"] = um.prompt_token_count or 0
    info["output_tokens"] = um.candidates_token_count or 0
    if hasattr(um, "thoughts_token_count"):
        info["reasoning_tokens"] = um.thoughts_token_count or 0
    if hasattr(um, "cached_content_token_count"):
        info["cached_tokens"] = um.cached_content_token_count or 0
    if hasattr(um, "traffic_type"):
        info["traffic_type"] = str(um.traffic_type) if um.traffic_type else None
    return info


# ---------------------------------------------------------------------------
# Game selection UI
# ---------------------------------------------------------------------------
def _select_game(game_id: str | None) -> str:
    """If game_id is provided, validate it. Otherwise, list games and prompt."""
    games = discover_games()
    if not games:
        print("No games found. Check puzzle-environments/ directory.")
        sys.exit(1)

    if game_id:
        ids = [g["game_id"] for g in games]
        if game_id not in ids:
            print(f"Game '{game_id}' not found. Available: {ids}")
            sys.exit(1)
        return game_id

    # Interactive selection
    print("\n=== Available Games ===")
    for i, g in enumerate(games, 1):
        print(f"  {i:2d}. [{g['game_type']}] {g['game_id']} - {g['title']}")
    print()

    while True:
        choice = input("Select game (number or ID): ").strip()
        if not choice:
            continue
        # Try as number
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(games):
                return games[idx]["game_id"]
        except ValueError:
            pass
        # Try as ID
        for g in games:
            if g["game_id"] == choice:
                return g["game_id"]
        print(f"Invalid choice '{choice}'. Try again.")


# ---------------------------------------------------------------------------
# Interactive step loop
# ---------------------------------------------------------------------------
def run_interactive(
    game_id: str,
    seed: int = 0,
    max_steps: int = 200,
    context_window: int = 75,
    output_dir: Path | None = None,
    temperature: float = 0.3,
) -> None:
    """Main interactive loop: load game, call Gemini, let user control each step."""

    # Resolve API key
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        print("GEMINI_API_KEY environment variable is required.")
        sys.exit(1)

    # Create output directory
    if output_dir is None:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        output_dir = _PROJECT_ROOT / "output" / "interactive" / f"{game_id}_{ts}"
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"Saving raw responses to: {output_dir}")

    # Create Gemini client
    print(f"Connecting to Gemini Priority ({_MODEL_ID})...")
    client = _create_client(api_key)

    # Load and reset game
    print(f"Loading game: {game_id} (seed={seed})")
    adapter = load_game(game_id, seed=seed)
    adapter.reset()

    game_type = adapter.game_type
    title = adapter.title
    total_levels = adapter.total_levels
    print(f"Game: {title} (type={game_type}, levels={total_levels})")

    # Build system prompt
    system_prompt = build_system_prompt(
        game_type=game_type,
        max_steps=max_steps,
        context_window=context_window,
    )

    # Conversation history (sliding window)
    conversation: list[types.Content] = []
    notepad = ""

    # Session metadata (saved alongside responses)
    session_meta = {
        "game_id": game_id,
        "game_type": game_type,
        "title": title,
        "seed": seed,
        "model": _MODEL_ID,
        "max_steps": max_steps,
        "temperature": temperature,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(output_dir / "session.json", "w") as f:
        json.dump(session_meta, f, indent=2)

    print(f"\n{'=' * 60}")
    print("INTERACTIVE MODE")
    print(f"{'=' * 60}")
    print("Controls:")
    print("  [Enter]       Accept the model's suggested action")
    print("  <action>      Type a custom action (e.g. UP, CLICK 5 3)")
    print("  skip / s      Skip this step (don't execute any action)")
    print("  quit / q      End the session")
    print("  notepad / n   View current notepad")
    print("  actions / a   List available actions")
    print("  state         Show raw game state")
    print(f"{'=' * 60}\n")

    step = 0
    total_cost_approx = 0.0

    while step < max_steps:
        # Check if game is done
        if adapter.is_done():
            final_score = adapter.get_score()
            print(f"\n  GAME OVER -- Score: {final_score:.1%}")
            break

        # Render current state
        text_obs = adapter.render_text()
        available = adapter.get_available_actions()
        score = adapter.get_score()

        level_info = ""
        if hasattr(adapter, "level") and adapter.level is not None:
            level_info = f" | Level {adapter.level + 1}/{total_levels}"

        print(f"\n{'=' * 60}")
        print(f"  STEP {step + 1}/{max_steps} | Score: {score:.1%}{level_info}")
        print(f"{'=' * 60}")
        print(text_obs)

        # Build turn prompt
        turn_prompt = build_turn_prompt(
            observation=text_obs,
            available_actions=available,
            notepad=notepad,
            step=step,
            max_steps=max_steps,
        )

        # Build contents for API call (system prompt goes in config, not contents)
        # Apply sliding window: keep last context_window*2 messages
        window_size = context_window * 2
        windowed_conversation = conversation[-window_size:] if len(conversation) > window_size else list(conversation)

        # Add current observation as user turn
        current_contents = windowed_conversation + [
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=turn_prompt)],
            )
        ]

        # Call Gemini API
        print("\n  Calling Gemini Priority...", end="", flush=True)
        t0 = time.time()

        config = types.GenerateContentConfig(
            system_instruction=system_prompt,
            tools=[_TOOL],
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="ANY",
                    allowed_function_names=["play_action"],
                ),
            ),
            temperature=temperature,
            max_output_tokens=65536,
        )

        try:
            response = client.models.generate_content(
                model=_MODEL_ID,
                contents=current_contents,
                config=config,
            )
        except Exception as e:
            elapsed = time.time() - t0
            print(f" ERROR ({elapsed:.1f}s)")
            print(f"  API Error: {type(e).__name__}: {e}")
            choice = input("\n  [Enter] to retry, 'q' to quit: ").strip().lower()
            if choice in ("q", "quit"):
                break
            continue  # retry same step

        elapsed = time.time() - t0
        print(f" done ({elapsed:.1f}s)")

        # Serialize and save the FULL raw response
        raw = _serialize_response(response)
        saved_path = _save_response(raw, output_dir, step)
        print(f"  Saved: {saved_path.name}")

        # Extract usage info
        usage = _extract_usage(response)
        print(f"  Tokens: in={usage['input_tokens']}, out={usage['output_tokens']}, "
              f"think={usage['reasoning_tokens']}, cached={usage['cached_tokens']}")
        print(f"  Traffic: {usage['traffic_type']}")

        # Parse the model's suggestion
        parsed = _parse_response(response)
        suggested_action = parsed["action"]
        reasoning = parsed["reasoning"]
        notepad_update = parsed["notepad_update"]

        print(f"\n  Model suggests: {suggested_action}")
        print(f"  Reasoning: {reasoning}")
        if notepad_update:
            print(f"  Notepad update: {notepad_update[:200]}{'...' if len(notepad_update or '') > 200 else ''}")

        # User control loop
        while True:
            choice = input(f"\n  Action [{suggested_action}]: ").strip()

            if choice.lower() in ("q", "quit"):
                print("\n  Session ended by user.")
                # Save final session state
                session_meta["ended_at"] = datetime.now(timezone.utc).isoformat()
                session_meta["total_steps"] = step
                session_meta["final_score"] = adapter.get_score()
                session_meta["ended_by"] = "user_quit"
                with open(output_dir / "session.json", "w") as f:
                    json.dump(session_meta, f, indent=2)
                return

            if choice.lower() in ("s", "skip"):
                print("  Skipping step (no action executed).")
                # Still add to conversation so the model sees its own response
                conversation.append(types.Content(
                    role="user",
                    parts=[types.Part.from_text(text=turn_prompt)],
                ))
                if suggested_action:
                    conversation.append(types.Content(
                        role="model",
                        parts=[types.Part.from_text(
                            text=json.dumps({"action": suggested_action, "reasoning": reasoning}),
                        )],
                    ))
                step += 1
                break

            if choice.lower() in ("n", "notepad"):
                print(f"\n  === NOTEPAD ===\n  {notepad if notepad else '(empty)'}\n")
                continue

            if choice.lower() in ("a", "actions"):
                print(f"\n  Available actions: {', '.join(available[:30])}")
                if len(available) > 30:
                    print(f"  ... ({len(available)} total)")
                continue

            if choice.lower() == "state":
                print(f"\n  === RAW STATE ===\n  {adapter.get_state()}\n")
                continue

            # Determine final action
            if choice == "":
                # Accept model's suggestion
                action = suggested_action
                if action is None:
                    print("  Model had no suggestion. Type an action or 'skip'.")
                    continue
            else:
                # User typed a custom action
                action = choice.upper()
                # Don't validate strictly -- let the game engine handle it

            # Apply notepad update (if accepting model's suggestion)
            if choice == "" and notepad_update:
                notepad = notepad_update

            # Execute the action
            try:
                adapter.step(action)
            except (ValueError, Exception) as e:
                print(f"  Action failed: {e}")
                print("  Try a different action.")
                continue

            new_score = adapter.get_score()
            score_delta = new_score - score
            delta_str = f" ({'+' if score_delta >= 0 else ''}{score_delta:.1%})" if score_delta != 0 else ""
            print(f"  Executed: {action} | Score: {new_score:.1%}{delta_str}")

            # Add to conversation history
            conversation.append(types.Content(
                role="user",
                parts=[types.Part.from_text(text=turn_prompt)],
            ))
            conversation.append(types.Content(
                role="model",
                parts=[types.Part.from_text(
                    text=json.dumps({"action": action, "reasoning": reasoning}),
                )],
            ))

            step += 1
            break

    # Game ended (max steps or game over)
    final_score = adapter.get_score()
    print(f"\n{'=' * 60}")
    print(f"  SESSION COMPLETE")
    print(f"  Game: {title}")
    print(f"  Steps: {step}/{max_steps}")
    print(f"  Final Score: {final_score:.1%}")
    print(f"  Responses saved to: {output_dir}")
    print(f"{'=' * 60}")

    session_meta["ended_at"] = datetime.now(timezone.utc).isoformat()
    session_meta["total_steps"] = step
    session_meta["final_score"] = final_score
    session_meta["ended_by"] = "game_over" if adapter.is_done() else "max_steps"
    with open(output_dir / "session.json", "w") as f:
        json.dump(session_meta, f, indent=2)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interactive Gemini Priority ARC game player. "
                    "Saves full raw API responses at each step.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List available games, then pick interactively:
  python scripts/gemini_priority_interactive.py

  # Play a specific ARC3 game:
  python scripts/gemini_priority_interactive.py --game cc01

  # Play with custom settings:
  python scripts/gemini_priority_interactive.py --game ls20 --seed 42 --max-steps 100

  # Save to a specific directory:
  python scripts/gemini_priority_interactive.py --game cc01 --output ./my_session

Environment:
  GEMINI_API_KEY   Required. Your Gemini API key for Priority PayGo.
""",
    )
    parser.add_argument("--game", "-g", type=str, default=None,
                        help="Game ID to play (e.g. cc01, ls20, game_001). "
                             "If omitted, shows interactive game picker.")
    parser.add_argument("--seed", "-s", type=int, default=0,
                        help="Random seed for game instantiation (default: 0)")
    parser.add_argument("--max-steps", "-m", type=int, default=200,
                        help="Maximum steps before session ends (default: 200)")
    parser.add_argument("--context-window", "-w", type=int, default=75,
                        help="Conversation turns to keep in context (default: 75)")
    parser.add_argument("--output", "-o", type=str, default=None,
                        help="Output directory for raw responses. "
                             "Default: output/interactive/<game_id>_<timestamp>")
    parser.add_argument("--temperature", "-t", type=float, default=0.3,
                        help="Gemini temperature (default: 0.3)")
    parser.add_argument("--list-games", action="store_true",
                        help="List available games and exit")

    args = parser.parse_args()

    if args.list_games:
        games = discover_games()
        if not games:
            print("No games found.")
            return
        print(f"\nAvailable games ({len(games)}):")
        for g in games:
            print(f"  [{g['game_type']}] {g['game_id']} - {g['title']}")
        return

    game_id = _select_game(args.game)
    output_dir = Path(args.output) if args.output else None

    run_interactive(
        game_id=game_id,
        seed=args.seed,
        max_steps=args.max_steps,
        context_window=args.context_window,
        output_dir=output_dir,
        temperature=args.temperature,
    )


if __name__ == "__main__":
    main()
