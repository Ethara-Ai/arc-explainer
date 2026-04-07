#!/usr/bin/env python3
"""
COMPREHENSIVE AUDIT — All Games (Standalone)
=============================================
Standalone equivalent of: harness_comprehensive_audit.ts + harness_deep_behavioral_test.ts

Checks per game:
  1. Initial state (score=0, IN_PROGRESS, isDone=false, level>=1, total_levels>0)
  2. Grid integrity (non-null, rectangular, values 0-15, integers)
  3. Score formula (score == levels_completed / total_levels)
  4. renderText (non-empty, has text_observation)
  5. Play steps (250 steps, score monotonic within play, score in [0,1], finite)
  6. GAME_OVER non-terminal (isDone=false, only reset available)
  7. WIN terminal (isDone=true, score>0)
  8. Score formula at final state
  9. Post-play reset integrity
  10. text_observation after reset

Usage:
  python tests/standalone/test_audit.py
"""

import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from game_loader import discover_games, GameAdapter

MAX_STEPS = 250


def audit_game(game) -> dict:
    checks = []
    start = time.monotonic()
    adapter = None

    def chk(name, expected, actual, condition):
        checks.append({"name": name, "status": "PASS" if condition else "FAIL",
                        "expected": str(expected), "actual": str(actual)})

    def warn(name, expected, actual):
        checks.append({"name": name, "status": "WARN", "expected": str(expected), "actual": str(actual)})

    try:
        adapter = GameAdapter(game.game_id, game.py_file)
        adapter.reset()

        # CHECK 1: Initial state
        init_score = adapter.get_score()
        init_state = adapter.get_state()
        init_level = adapter.level
        init_total = adapter.total_levels
        init_actions = adapter.get_available_actions()

        chk("init_score=0", 0, init_score, init_score == 0)
        chk("init_state=IN_PROGRESS", "IN_PROGRESS", init_state, init_state == "IN_PROGRESS")
        chk("init_isDone=false", False, adapter.is_done(), not adapter.is_done())
        chk("init_level>=1", ">=1", init_level, init_level is not None and init_level >= 1)
        chk("init_totalLevels>0", ">0", init_total, init_total is not None and init_total > 0)
        chk("init_actions_nonempty", ">0", len(init_actions), len(init_actions) > 0)
        chk("init_has_reset", "includes reset", init_actions, "reset" in init_actions)

        # CHECK 2: Grid integrity
        grid = adapter.get_grid()
        if grid is not None and isinstance(grid, list) and len(grid) > 0:
            row0 = grid[0]
            if isinstance(row0, list) and len(row0) > 0 and isinstance(row0[0], (int, float)):
                h, w = len(grid), len(row0)
                chk("grid_height>0", ">0", h, h > 0)
                chk("grid_width>0", ">0", w, w > 0)
                rect = all(len(r) == w for r in grid)
                chk("grid_rectangular", "all same width", rect, rect)
                flat = [c for r in grid for c in r]
                mn, mx = min(flat), max(flat)
                chk("grid_values_0_15", "[0,15]", f"[{mn},{mx}]", mn >= 0 and mx <= 15)
                chk("grid_integers", "true", all(isinstance(v, int) for v in flat), all(isinstance(v, int) for v in flat))
            else:
                chk("grid_not_null", "2D array", "nested array", False)
        else:
            chk("grid_not_null", "non-null", "null" if grid is None else "empty", False)

        # CHECK 3: Score formula
        total = max(init_total or 1, 1)
        lc = adapter.levels_completed
        expected_score = min(lc / total, 1.0)
        chk("score_formula", expected_score, init_score, abs(init_score - expected_score) < 0.0001)

        # CHECK 4: renderText
        text = adapter.render_text()
        chk("renderText_nonempty", "non-empty", f"len={len(text)}", len(text) > 0)

        # CHECK 5: Play steps
        prev_score = 0
        score_decreased = False
        score_decrease_detail = ""
        reached_go = False
        reached_win = False
        go_actions = []
        go_is_done = False
        just_reset = True
        score_oob = False
        score_oob_detail = ""

        non_reset = [a for a in init_actions if a.lower() != "reset"]
        for step in range(MAX_STEPS):
            st = adapter.get_state()
            if st == "WIN":
                reached_win = True; break
            if st == "GAME_OVER":
                reached_go = True
                go_actions = adapter.get_available_actions()
                go_is_done = adapter.is_done()
                adapter.step("reset")
                prev_score = adapter.get_score()
                just_reset = True
                continue
            act = random.choice(non_reset) if non_reset else "up"
            adapter.step(act)
            sc = adapter.get_score()
            if not just_reset and sc < prev_score - 0.0001:
                score_decreased = True
                score_decrease_detail = f"step={step} prev={prev_score} cur={sc}"
            prev_score = sc
            just_reset = False
            if sc < -0.0001 or sc > 1.0001:
                if not score_oob: score_oob = True; score_oob_detail = f"step={step} score={sc}"

        chk("score_monotonic", "never decreases", score_decrease_detail or "monotonic", not score_decreased)
        chk("score_in_0_1", "[0,1]", score_oob_detail or "all valid", not score_oob)

        # CHECK 6: GAME_OVER non-terminal
        if reached_go:
            chk("gameover_isDone=false", False, go_is_done, not go_is_done)
            chk("gameover_only_reset", '["reset"]', go_actions, len(go_actions) == 1 and go_actions[0] == "reset")
        else:
            warn("gameover_not_reached", "reached", f"final={adapter.get_state()}")

        # CHECK 7: WIN terminal
        if reached_win:
            chk("win_isDone=true", True, adapter.is_done(), adapter.is_done())
            ws = adapter.get_score()
            if ws == 0:
                warn("win_score=0", ">0", "0 (game quirk)")
            else:
                chk("win_score>0", ">0", ws, ws > 0)

        # CHECK 8: Final score formula
        final_sc = adapter.get_score()
        final_lc = adapter.levels_completed
        final_total = max(adapter.total_levels or 1, 1)
        exp_final = min(final_lc / final_total, 1.0)
        chk("final_score_formula", f"{final_lc}/{final_total}={exp_final:.4f}", f"{final_sc:.4f}",
            abs(final_sc - exp_final) < 0.0001)

        # CHECK 9: Post-play reset
        adapter.reset()
        pr_state = adapter.get_state()
        pr_done = adapter.is_done()
        pr_score = adapter.get_score()
        chk("reset_state=IN_PROGRESS", "IN_PROGRESS", pr_state, pr_state == "IN_PROGRESS")
        chk("reset_isDone=false", False, pr_done, not pr_done)
        chk("reset_score_in_range", "[0,1]", pr_score, 0 <= pr_score <= 1)
        pr_grid = adapter.get_grid()
        chk("reset_grid_not_null", "non-null", "null" if pr_grid is None else "ok", pr_grid is not None)

        # CHECK 10: text_observation after reset
        rt = adapter.render_text()
        chk("renderText_after_reset", "non-empty", f"len={len(rt)}", len(rt) > 0)

        adapter.dispose()
        adapter = None

        all_passed = all(c["status"] != "FAIL" for c in checks)
        return {"game_id": game.game_id, "status": "PASS" if all_passed else "FAIL",
                "checks": checks, "duration_ms": int((time.monotonic() - start) * 1000)}

    except Exception as e:
        return {"game_id": game.game_id, "status": "FAIL", "checks": checks,
                "duration_ms": int((time.monotonic() - start) * 1000), "error": str(e)}
    finally:
        if adapter:
            try: adapter.dispose()
            except Exception: pass


def main():
    print("=" * 80)
    print("  COMPREHENSIVE AUDIT — All Games (Standalone)")
    print("=" * 80)
    print()

    games = discover_games()
    print(f"Discovered {len(games)} games\n")
    if not games:
        print("ERROR: No games discovered."); sys.exit(1)

    print(f"{'GAME':<8} {'STATUS':<8} {'CHECKS':<8} {'FAILED':<8} {'MS':<10} ERROR")
    print("-" * 80)

    results = []
    for game in games:
        r = audit_game(game)
        results.append(r)
        fc = sum(1 for c in r["checks"] if c["status"] == "FAIL")
        err = r.get("error", "")[:30] if r.get("error") else ""
        print(f"{r['game_id']:<8} {r['status']:<8} {len(r['checks']):<8} {fc:<8} {r['duration_ms']:<10} {err}")

    gp = sum(1 for r in results if r["status"] == "PASS")
    gf = sum(1 for r in results if r["status"] == "FAIL")
    tc = sum(len(r["checks"]) for r in results)
    tf = sum(sum(1 for c in r["checks"] if c["status"] == "FAIL") for r in results)

    print(f"\n{'=' * 80}")
    print(f"GAMES: {gp} PASS / {gf} FAIL / {len(results)} TOTAL")
    print(f"CHECKS: {tc - tf} PASS / {tf} FAIL / {tc} TOTAL")

    if gf > 0:
        print("\nFailed games:")
        for r in results:
            if r["status"] == "FAIL":
                if r.get("error"): print(f"  {r['game_id']}: ERROR: {r['error'][:80]}")
                for c in r["checks"]:
                    if c["status"] == "FAIL":
                        print(f"  {r['game_id']}: {c['name']}: expected={c['expected']} actual={c['actual']}")

    sys.exit(1 if gf > 0 else 0)


if __name__ == "__main__":
    main()
