#!/usr/bin/env python3
"""
LIFECYCLE & BOOTSTRAP TEST — All Games
=======================================
Standalone equivalent of: harness_verify_all_games.ts + harness_deep_test.ts

Tests the full PuzzleEnvironment lifecycle for every discovered game:
  T1. BOOTSTRAP       — instantiate PuzzleEnvironment, validate class
  T2. RESET           — state=IN_PROGRESS, score=0, actions non-empty, text non-empty
  T3. ALL ACTIONS     — step() with every available action, validate score/state
  T4. CLICK COORDS    — click 5 5, click 0 0, bare click
  T5. RAPID FIRE      — 15 random actions
  T6. UNDO            — step("undo") if available
  T7. TRIPLE RESET    — 3× reset → all give score=0 state=IN_PROGRESS
  T8. SELECT          — step("select") if available
  T9. GRID VALIDATE   — non-null, rectangular, values 0-15
  T10. GAME_OVER      — drive to GAME_OVER, verify reset recovers
  T11. METADATA       — game_id, total_levels, actions consistent
  T12. SCORE MONOTONIC — score never decreases within uninterrupted play
  T13. DISPOSE        — clean shutdown

Usage:
  python tests/standalone/test_lifecycle.py
"""

import random
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from game_loader import discover_games, GameAdapter

VALID_STATES = {"IN_PROGRESS", "WIN", "GAME_OVER", "NOT_PLAYED"}


def test_game(game) -> dict:
    result = {
        "game_id": game.game_id,
        "tests": [],
        "overall": "PASS",
        "warnings": [],
        "duration_ms": 0,
    }
    start = time.monotonic()
    adapter = None
    aborted = False

    def add(name, status, detail):
        nonlocal aborted
        result["tests"].append({"test": name, "status": status, "detail": detail})
        if status == "FAIL":
            result["overall"] = "FAIL"
            aborted = True
        if status == "WARN":
            result["warnings"].append(f"{name}: {detail}")

    # T1: BOOTSTRAP
    try:
        adapter = GameAdapter(game.game_id, game.py_file)
        add("T1_BOOTSTRAP", "PASS", f"game_id={game.game_id}")
    except Exception as e:
        add("T1_BOOTSTRAP", "FAIL", str(e))

    if aborted or not adapter:
        result["duration_ms"] = int((time.monotonic() - start) * 1000)
        return result

    # T2: RESET
    try:
        adapter.reset()
        state = adapter.get_state()
        score = adapter.get_score()
        actions = adapter.get_available_actions()
        text = adapter.render_text()
        issues = []
        if state != "IN_PROGRESS":
            issues.append(f"state={state}")
        if score != 0:
            issues.append(f"score={score}")
        if not actions:
            issues.append("no actions")
        if not text:
            issues.append("empty text")
        if issues:
            add("T2_RESET", "WARN", "; ".join(issues))
        else:
            add("T2_RESET", "PASS", f"actions=[{','.join(actions[:5])}] score={score}")
    except Exception as e:
        add("T2_RESET", "FAIL", str(e))

    if aborted:
        _safe_dispose(adapter)
        result["duration_ms"] = int((time.monotonic() - start) * 1000)
        return result

    # T3: ALL ACTIONS
    try:
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        failed_actions = []
        for action in non_reset:
            try:
                adapter.reset()
                adapter.step(action)
                s = adapter.get_state()
                sc = adapter.get_score()
                if sc < 0 or sc > 1:
                    failed_actions.append(f"{action}: score={sc}")
                elif s not in VALID_STATES:
                    failed_actions.append(f"{action}: state={s}")
            except Exception as e:
                failed_actions.append(f"{action}: {e}")
        if failed_actions:
            add("T3_ALL_ACTIONS", "FAIL", f"{len(failed_actions)}/{len(non_reset)} failed: {'; '.join(failed_actions[:3])}")
        else:
            add("T3_ALL_ACTIONS", "PASS", f"{len(non_reset)} actions OK")
    except Exception as e:
        add("T3_ALL_ACTIONS", "FAIL", str(e))

    if aborted:
        _safe_dispose(adapter)
        result["duration_ms"] = int((time.monotonic() - start) * 1000)
        return result

    # T4: CLICK COORDS
    try:
        adapter.reset()
        actions = adapter.get_available_actions()
        has_click = any(a.lower() == "click" for a in actions)
        if has_click:
            issues = []
            for label, act in [("coords", "click 5 5"), ("origin", "click 0 0"), ("bare", "click")]:
                try:
                    adapter.reset()
                    adapter.step(act)
                except Exception as e:
                    issues.append(f"{label}: {e}")
            if issues:
                add("T4_CLICK", "FAIL", "; ".join(issues))
            else:
                add("T4_CLICK", "PASS", "click 5 5, click 0 0, bare click OK")
        else:
            add("T4_CLICK", "SKIP", "no click action")
    except Exception as e:
        add("T4_CLICK", "FAIL", str(e))

    if aborted:
        _safe_dispose(adapter)
        result["duration_ms"] = int((time.monotonic() - start) * 1000)
        return result

    # T5: RAPID FIRE
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        fails = 0
        ok = 0
        for _ in range(15):
            act = random.choice(non_reset) if non_reset else "up"
            try:
                adapter.step(act)
                ok += 1
                s = adapter.get_state()
                if s in ("GAME_OVER", "WIN"):
                    adapter.reset()
            except Exception:
                fails += 1
                break
        if fails > 0:
            add("T5_RAPID_FIRE", "FAIL", f"{ok} OK, {fails} failed")
        else:
            add("T5_RAPID_FIRE", "PASS", f"{ok} steps OK")
    except Exception as e:
        add("T5_RAPID_FIRE", "FAIL", str(e))

    if aborted:
        _safe_dispose(adapter)
        result["duration_ms"] = int((time.monotonic() - start) * 1000)
        return result

    # T6: UNDO
    try:
        adapter.reset()
        actions = adapter.get_available_actions()
        if any(a.lower() == "undo" for a in actions):
            adapter.step("up")
            adapter.step("undo")
            add("T6_UNDO", "PASS", "up→undo OK")
        else:
            add("T6_UNDO", "SKIP", "undo not available")
    except Exception as e:
        add("T6_UNDO", "FAIL", str(e))

    # T7: TRIPLE RESET
    try:
        scores, states = [], []
        for _ in range(3):
            adapter.reset()
            scores.append(adapter.get_score())
            states.append(adapter.get_state())
        all_zero = all(s == 0 for s in scores)
        all_ip = all(s == "IN_PROGRESS" for s in states)
        if not all_zero or not all_ip:
            add("T7_TRIPLE_RESET", "WARN", f"scores={scores} states={states}")
        else:
            add("T7_TRIPLE_RESET", "PASS", "3× clean resets")
    except Exception as e:
        add("T7_TRIPLE_RESET", "FAIL", str(e))

    # T8: SELECT
    try:
        adapter.reset()
        actions = adapter.get_available_actions()
        if any(a.lower() == "select" for a in actions):
            adapter.step("select")
            add("T8_SELECT", "PASS", f"select → state={adapter.get_state()}")
        else:
            add("T8_SELECT", "SKIP", "select not available")
    except Exception as e:
        add("T8_SELECT", "FAIL", str(e))

    # T9: GRID VALIDATE
    try:
        adapter.reset()
        grid = adapter.get_grid()
        issues = []
        if grid is None:
            issues.append("grid is null")
        elif isinstance(grid, list) and len(grid) > 0:
            if isinstance(grid[0], list) and len(grid[0]) > 0 and isinstance(grid[0][0], (int, float)):
                h, w = len(grid), len(grid[0])
                if h == 0 or w == 0:
                    issues.append(f"zero dimension {w}x{h}")
                widths = set(len(r) for r in grid)
                if len(widths) > 1:
                    issues.append(f"inconsistent widths: {widths}")
                vals = [c for r in grid for c in r]
                if any(v < 0 or v > 15 for v in vals):
                    issues.append("values outside 0-15")
                if not all(isinstance(v, int) for v in vals):
                    issues.append("non-integer values")
        if issues:
            add("T9_GRID", "WARN", "; ".join(issues))
        else:
            add("T9_GRID", "PASS", "grid valid")
    except Exception as e:
        add("T9_GRID", "FAIL", str(e))

    # T10: GAME_OVER RECOVERY
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        hit_go = False
        for _ in range(50):
            act = random.choice(non_reset) if non_reset else "up"
            try:
                adapter.step(act)
            except Exception:
                break
            s = adapter.get_state()
            if s == "GAME_OVER":
                hit_go = True
                break
            if s == "WIN":
                break
        if hit_go:
            go_actions = adapter.get_available_actions()
            adapter.reset()
            after = adapter.get_state()
            if after != "IN_PROGRESS":
                add("T10_GAMEOVER", "WARN", f"after reset: state={after}")
            else:
                only_reset = len(go_actions) == 1 and go_actions[0] == "reset"
                add("T10_GAMEOVER", "PASS", f"GAME_OVER → reset → IN_PROGRESS, onlyReset={only_reset}")
        else:
            add("T10_GAMEOVER", "SKIP", "did not reach GAME_OVER in 50 steps")
    except Exception as e:
        add("T10_GAMEOVER", "FAIL", str(e))

    # T11: METADATA
    try:
        adapter.reset()
        meta = getattr(adapter._last_state, "metadata", {}) or {}
        issues = []
        if adapter.total_levels is None or adapter.total_levels <= 0:
            issues.append(f"total_levels={adapter.total_levels}")
        if not adapter.get_available_actions():
            issues.append("no actions")
        if issues:
            add("T11_METADATA", "WARN", "; ".join(issues))
        else:
            add("T11_METADATA", "PASS", f"total_levels={adapter.total_levels}")
    except Exception as e:
        add("T11_METADATA", "FAIL", str(e))

    # T12: SCORE MONOTONIC
    try:
        adapter.reset()
        prev = adapter.get_score()
        decreased = False
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        for _ in range(20):
            act = random.choice(non_reset) if non_reset else "up"
            try:
                adapter.step(act)
            except Exception:
                break
            cur = adapter.get_score()
            if cur < prev:
                decreased = True
            prev = cur
            s = adapter.get_state()
            if s in ("WIN", "GAME_OVER"):
                break
        if decreased:
            add("T12_SCORE_MONO", "WARN", "score decreased during play")
        else:
            add("T12_SCORE_MONO", "PASS", "score non-decreasing")
    except Exception as e:
        add("T12_SCORE_MONO", "FAIL", str(e))

    # T13: DISPOSE
    try:
        adapter.dispose()
        add("T13_DISPOSE", "PASS", "clean shutdown")
    except Exception as e:
        add("T13_DISPOSE", "WARN", f"dispose error: {e}")

    result["duration_ms"] = int((time.monotonic() - start) * 1000)
    return result


def _safe_dispose(adapter):
    if adapter:
        try:
            adapter.dispose()
        except Exception:
            pass


def main():
    print("=" * 80)
    print("  LIFECYCLE & BOOTSTRAP TEST — All Games (Standalone)")
    print("=" * 80)
    print()

    games = discover_games()
    print(f"Discovered {len(games)} games\n")

    if not games:
        print("ERROR: No games discovered.")
        sys.exit(1)

    print(f"{'GAME':<8} {'STATUS':<8} {'TESTS':<8} {'PASS':<6} {'FAIL':<6} {'WARN':<6} {'MS':<10} NOTES")
    print("-" * 100)

    results = []
    total_pass = total_fail = total_warn = total_tests = 0

    for game in games:
        r = test_game(game)
        results.append(r)
        p = sum(1 for t in r["tests"] if t["status"] == "PASS")
        f = sum(1 for t in r["tests"] if t["status"] == "FAIL")
        w = sum(1 for t in r["tests"] if t["status"] == "WARN")
        total_tests += len(r["tests"])
        total_pass += p
        total_fail += f
        total_warn += w
        notes = f"{w} warnings" if w > 0 else ""
        print(f"{r['game_id']:<8} {r['overall']:<8} {len(r['tests']):<8} {p:<6} {f:<6} {w:<6} {r['duration_ms']:<10} {notes}")

    games_pass = sum(1 for r in results if r["overall"] == "PASS")
    games_fail = sum(1 for r in results if r["overall"] == "FAIL")

    print()
    print("=" * 100)
    print(f"GAMES: {len(results)}  PASS: {games_pass}  FAIL: {games_fail}")
    print(f"TESTS: {total_tests}  PASS: {total_pass}  FAIL: {total_fail}  WARN: {total_warn}")

    if games_fail > 0:
        print("\nFailed games:")
        for r in results:
            if r["overall"] == "FAIL":
                ft = next((t for t in r["tests"] if t["status"] == "FAIL"), None)
                print(f"  {r['game_id']}: {ft['test']} — {ft['detail'][:80]}" if ft else f"  {r['game_id']}")

    sys.exit(1 if games_fail > 0 else 0)


if __name__ == "__main__":
    main()
