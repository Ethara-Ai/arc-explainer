#!/usr/bin/env python3
"""
STRESS & STATE-MACHINE TEST — All Games (Standalone)
====================================================
Standalone equivalent of: harness_stress_test.ts

Tests:
  T1. BOOTSTRAP           — instantiate + info validation
  T2. STATE AFTER RESET   — score=0, state=IN_PROGRESS, actions non-empty
  T3. ALL ACTIONS         — every action works without crash
  T4. REWARD INVARIANTS   — 100 random steps, reward in [0,1], no NaN
  T5. ACTION FLOOD        — 200 random steps without crash (auto-reset on done)
  T6. TRIPLE RESET        — 3 sequential resets produce clean state
  T7. STATE AFTER DONE    — stepping after game ends is safe
  T8. STEP-RESET INTERLEAVE — random mix of step/reset 50x
  T9. METADATA CONSISTENCY — state/score types stable across steps
  T10. DETERMINISTIC RESET — two resets produce same state
  T11. DISPOSE            — clean shutdown

Usage:
  python tests/standalone/test_stress.py
"""

import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from game_loader import discover_games, GameAdapter

VALID_STATES = {"IN_PROGRESS", "WIN", "GAME_OVER", "NOT_PLAYED"}


def seeded_random(seed: int):
    s = seed
    def rng():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0x7FFFFFFF
        return s / 0x7FFFFFFF
    return rng


def test_game(game) -> dict:
    result = {"game_id": game.game_id, "tests": [], "overall": "PASS", "warnings": [], "duration_ms": 0}
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

    # T2: STATE AFTER RESET
    try:
        adapter.reset()
        state = adapter.get_state()
        score = adapter.get_score()
        actions = adapter.get_available_actions()
        text = adapter.render_text()
        issues = []
        if state != "IN_PROGRESS": issues.append(f"state={state}")
        if score != 0: issues.append(f"score={score}")
        if not actions: issues.append("no actions")
        if not text: issues.append("empty text")
        add("T2_RESET_STATE", "WARN" if issues else "PASS",
            "; ".join(issues) if issues else f"actions=[{','.join(actions[:5])}] score={score}")
    except Exception as e:
        add("T2_RESET_STATE", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T3: ALL ACTIONS
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        failed = []
        for act in non_reset:
            try:
                adapter.reset()
                adapter.step(act)
                sc = adapter.get_score()
                st = adapter.get_state()
                if sc < 0 or sc > 1: failed.append(f"{act}: score={sc}")
                elif st not in VALID_STATES: failed.append(f"{act}: state={st}")
            except Exception as e:
                failed.append(f"{act}: {e}")
        if failed:
            add("T3_ALL_ACTIONS", "FAIL", f"{len(failed)}/{len(non_reset)}: {'; '.join(failed[:3])}")
        else:
            add("T3_ALL_ACTIONS", "PASS", f"{len(non_reset)} actions OK")
    except Exception as e:
        add("T3_ALL_ACTIONS", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T4: REWARD INVARIANTS
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(77)
        violations = []
        for i in range(100):
            try:
                act = non_reset[int(rng() * len(non_reset))]
                adapter.step(act)
                sc = adapter.get_score()
                if not isinstance(sc, (int, float)): violations.append(f"step {i}: type={type(sc).__name__}"); break
                if math.isnan(sc) or math.isinf(sc): violations.append(f"step {i}: NaN/Inf"); break
                if sc < 0 or sc > 1: violations.append(f"step {i}: score={sc}")
                st = adapter.get_state()
                if st in ("GAME_OVER", "WIN"): adapter.reset()
            except Exception:
                try: adapter.reset()
                except Exception: break
        add("T4_REWARD", "WARN" if violations else "PASS",
            "; ".join(violations[:3]) if violations else "100 steps, all scores in [0,1]")
    except Exception as e:
        add("T4_REWARD", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T5: ACTION FLOOD (200 steps)
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(99)
        crashes = 0
        done_count = 0
        for _ in range(200):
            try:
                act = non_reset[int(rng() * len(non_reset))]
                adapter.step(act)
                st = adapter.get_state()
                if st in ("GAME_OVER", "WIN"): done_count += 1; adapter.reset()
            except Exception:
                crashes += 1
                if crashes >= 5: break
                try: adapter.reset()
                except Exception: break
        if crashes > 0:
            add("T5_FLOOD", "FAIL", f"{crashes} crashes in 200 steps ({done_count} resets)")
        else:
            add("T5_FLOOD", "PASS", f"200 steps OK ({done_count} completions)")
    except Exception as e:
        add("T5_FLOOD", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T6: TRIPLE RESET
    try:
        scores, states = [], []
        for _ in range(3):
            adapter.reset()
            scores.append(adapter.get_score())
            states.append(adapter.get_state())
        all_zero = all(s == 0 for s in scores)
        all_ip = all(s == "IN_PROGRESS" for s in states)
        if not all_zero or not all_ip:
            add("T6_TRIPLE_RESET", "WARN", f"scores={scores} states={states}")
        else:
            add("T6_TRIPLE_RESET", "PASS", "3x clean resets")
    except Exception as e:
        add("T6_TRIPLE_RESET", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T7: STATE AFTER DONE
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(42)
        reached_done = False
        for _ in range(500):
            try:
                act = non_reset[int(rng() * len(non_reset))]
                adapter.step(act)
                st = adapter.get_state()
                if st in ("GAME_OVER", "WIN"): reached_done = True; break
            except Exception: break
        if not reached_done:
            add("T7_AFTER_DONE", "SKIP", "could not reach done in 500 steps")
        else:
            issues = []
            for act in non_reset[:3]:
                try:
                    adapter.step(act)
                    st = adapter.get_state()
                    if st not in VALID_STATES: issues.append(f"{act}: invalid state={st}")
                except Exception as e:
                    issues.append(f"{act}: {e}")
            try:
                adapter.reset()
                if adapter.get_state() != "IN_PROGRESS": issues.append(f"reset: state={adapter.get_state()}")
            except Exception as e:
                issues.append(f"reset crashed: {e}")
            add("T7_AFTER_DONE", "WARN" if issues else "PASS",
                "; ".join(issues[:3]) if issues else "steps after done safe, reset recovers")
    except Exception as e:
        add("T7_AFTER_DONE", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T8: STEP-RESET INTERLEAVE
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(77)
        crashes = 0
        for _ in range(50):
            try:
                if rng() < 0.3:
                    adapter.reset()
                else:
                    act = non_reset[int(rng() * len(non_reset))]
                    adapter.step(act)
                    st = adapter.get_state()
                    if st in ("GAME_OVER", "WIN"): adapter.reset()
            except Exception:
                crashes += 1
                if crashes >= 3: break
                try: adapter.reset()
                except Exception: break
        if crashes > 0:
            add("T8_INTERLEAVE", "FAIL", f"{crashes} crashes in 50 ops")
        else:
            add("T8_INTERLEAVE", "PASS", "50 step/reset interleaves OK")
    except Exception as e:
        add("T8_INTERLEAVE", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T9: METADATA CONSISTENCY
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(88)
        issues = []
        for i in range(30):
            try:
                act = non_reset[int(rng() * len(non_reset))]
                adapter.step(act)
                st = adapter.get_state()
                sc = adapter.get_score()
                if st not in VALID_STATES: issues.append(f"step {i}: state={st}")
                if not isinstance(sc, (int, float)) or math.isnan(sc): issues.append(f"step {i}: score={sc}")
                if st in ("GAME_OVER", "WIN"): adapter.reset()
            except Exception:
                try: adapter.reset()
                except Exception: break
        add("T9_METADATA", "WARN" if issues else "PASS",
            "; ".join(issues[:3]) if issues else "30 steps, all states/scores valid")
    except Exception as e:
        add("T9_METADATA", "FAIL", str(e))

    if aborted:
        _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T10: DETERMINISTIC RESET
    try:
        adapter.reset()
        text1 = adapter.render_text()
        score1 = adapter.get_score()
        state1 = adapter.get_state()
        adapter.reset()
        text2 = adapter.render_text()
        score2 = adapter.get_score()
        state2 = adapter.get_state()
        issues = []
        if text1 != text2: issues.append("text differs")
        if score1 != score2: issues.append(f"score: {score1} vs {score2}")
        if state1 != state2: issues.append(f"state: {state1} vs {state2}")
        add("T10_DETERMINISTIC", "WARN" if issues else "PASS",
            "; ".join(issues) if issues else "consecutive resets produce identical state")
    except Exception as e:
        add("T10_DETERMINISTIC", "FAIL", str(e))

    # T11: DISPOSE
    try:
        adapter.dispose()
        adapter = None
        add("T11_DISPOSE", "PASS", "clean shutdown")
    except Exception as e:
        add("T11_DISPOSE", "FAIL", str(e))

    _safe(adapter)
    result["duration_ms"] = int((time.monotonic() - start) * 1000)
    return result


def _safe(adapter):
    if adapter:
        try: adapter.dispose()
        except Exception: pass


def main():
    print("=" * 80)
    print("  STRESS & STATE-MACHINE TEST — All Games (Standalone)")
    print("=" * 80)
    print()

    games = discover_games()
    print(f"Discovered {len(games)} games\n")
    if not games:
        print("ERROR: No games discovered.")
        sys.exit(1)

    print(f"{'GAME':<9}{'STATUS':<9}{'TESTS':<9}{'PASS':<7}{'FAIL':<7}{'WARN':<7}{'MS':<11}NOTES")
    print("-" * 100)

    results = []
    for game in games:
        r = test_game(game)
        results.append(r)
        p = sum(1 for t in r["tests"] if t["status"] == "PASS")
        f = sum(1 for t in r["tests"] if t["status"] == "FAIL")
        w = sum(1 for t in r["tests"] if t["status"] == "WARN")
        notes = f"{w} warnings" if w else ""
        print(f"{r['game_id']:<9}{r['overall']:<9}{len(r['tests']):<9}{p:<7}{f:<7}{w:<7}{r['duration_ms']:<11}{notes}")

    gp = sum(1 for r in results if r["overall"] == "PASS")
    gf = sum(1 for r in results if r["overall"] == "FAIL")
    tp = sum(sum(1 for t in r["tests"] if t["status"] == "PASS") for r in results)
    tf = sum(sum(1 for t in r["tests"] if t["status"] == "FAIL") for r in results)
    tw = sum(sum(1 for t in r["tests"] if t["status"] == "WARN") for r in results)
    tt = sum(len(r["tests"]) for r in results)

    print(f"\n{'=' * 100}")
    print(f"GAMES: {len(results)}  PASS: {gp}  FAIL: {gf}")
    print(f"TESTS: {tt}  PASS: {tp}  FAIL: {tf}  WARN: {tw}")

    sys.exit(1 if gf > 0 else 0)


if __name__ == "__main__":
    main()
