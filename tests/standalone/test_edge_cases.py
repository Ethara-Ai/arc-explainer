#!/usr/bin/env python3
"""
ULTRA EDGE-CASE TEST — All Games (Standalone)
==============================================
Standalone equivalent of: harness_edge_cases.ts

Tests:
  T0.  BOOTSTRAP            — create + reset
  T1.  MALFORMED ACTIONS    — empty, whitespace, NUL, control chars
  T2.  CLICK COORD EDGES    — negative, huge, float, missing coords
  T3.  CASE SENSITIVITY     — UP vs up vs Up
  T4.  UNICODE & SPECIALS   — emoji, CJK, SQL injection, JSON, XML
  T5.  VERY LONG STRINGS    — 1K+ char action strings
  T6.  RAPID STEP/RESET     — 100 rapid alternations
  T7.  STATE AFTER GARBAGE   — state recovers after bad inputs
  T8.  REWARD BOUNDS         — 200 steps, all scores valid
  T9.  ACTIONS STABILITY     — get_actions consistent across calls
  T10. REPEATED SAME ACTION  — same action 100x in a row
  T11. DISPOSE               — clean shutdown

Usage:
  python tests/standalone/test_edge_cases.py
"""

import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from game_loader import discover_games, GameAdapter


def seeded_random(seed: int):
    s = seed
    def rng():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0x7FFFFFFF
        return s / 0x7FFFFFFF
    return rng


def safe_step(adapter, action):
    """Try stepping; return (ok, crashed)."""
    try:
        adapter.step(action)
        return True, False
    except Exception:
        try:
            adapter.get_state()
            return False, False
        except Exception:
            return False, True


def test_game(game) -> dict:
    result = {"game_id": game.game_id, "tests": [], "overall": "PASS", "warnings": [], "duration_ms": 0}
    start = time.monotonic()
    adapter = None
    aborted = False

    def add(name, status, detail):
        nonlocal aborted
        result["tests"].append({"test": name, "status": status, "detail": detail})
        if status == "FAIL": result["overall"] = "FAIL"; aborted = True
        if status == "WARN": result["warnings"].append(f"{name}: {detail}")

    # T0: BOOTSTRAP
    try:
        adapter = GameAdapter(game.game_id, game.py_file)
        adapter.reset()
        add("T0_BOOTSTRAP", "PASS", "adapter created + reset")
    except Exception as e:
        add("T0_BOOTSTRAP", "FAIL", str(e))

    if aborted or not adapter:
        result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T1: MALFORMED ACTION STRINGS
    try:
        malformed = [("empty", ""), ("space", " "), ("multi_space", "     "), ("tab", "\t"),
                     ("newline", "\n"), ("crlf", "\r\n"), ("nul", "\x00"), ("bell", "\x07")]
        crashes = 0
        for label, inp in malformed:
            try: adapter.reset()
            except Exception: break
            _, crashed = safe_step(adapter, inp)
            if crashed:
                crashes += 1
                try: adapter.reset()
                except Exception: break
        add("T1_MALFORMED", "FAIL" if crashes else "PASS",
            f"{crashes}/{len(malformed)} crashed" if crashes else f"{len(malformed)} handled gracefully")
    except Exception as e:
        add("T1_MALFORMED", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T2: CLICK COORDINATE EDGES
    try:
        actions = adapter.get_available_actions()
        has_click = any(a.lower() == "click" for a in actions)
        if not has_click:
            add("T2_CLICK_EDGES", "SKIP", "no click action")
        else:
            variants = [("no_coords", "click"), ("one_coord", "click 5"), ("negative", "click -1 -1"),
                        ("huge", "click 99999 99999"), ("zero", "click 0 0"), ("float", "click 1.5 2.5"),
                        ("string_coords", "click abc def"), ("extra_args", "click 1 2 3 4"), ("comma_sep", "click 5,5")]
            crashes = 0
            for label, inp in variants:
                try: adapter.reset()
                except Exception: break
                _, crashed = safe_step(adapter, inp)
                if crashed:
                    crashes += 1
                    try: adapter.reset()
                    except Exception: break
            add("T2_CLICK_EDGES", "FAIL" if crashes else "PASS",
                f"{crashes}/{len(variants)} crashed" if crashes else f"{len(variants)} variants handled")
    except Exception as e:
        add("T2_CLICK_EDGES", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T3: CASE SENSITIVITY
    try:
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        if not non_reset:
            add("T3_CASE", "SKIP", "no non-reset actions")
        else:
            base = non_reset[0]
            variants = [base.upper(), base.lower(), base[0].upper() + base[1:]]
            crashes = 0
            for v in variants:
                try: adapter.reset()
                except Exception: break
                _, crashed = safe_step(adapter, v)
                if crashed:
                    crashes += 1
                    try: adapter.reset()
                    except Exception: break
            add("T3_CASE", "FAIL" if crashes else "PASS",
                f"{crashes} case variants of '{base}' crashed" if crashes else f"case variants of '{base}' handled")
    except Exception as e:
        add("T3_CASE", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T4: UNICODE & SPECIAL STRINGS
    try:
        specials = [("\U0001F600", "emoji"), ("\u4e2d\u6587", "cjk"), ("42", "number"), ("-1", "negative"),
                    ("true", "true"), ("null", "null"), ('{"action":"up"}', "json"), ("<action>up</action>", "xml"),
                    ("'; DROP TABLE--", "sql"), ("../../../etc/passwd", "path"), ("<script>alert(1)</script>", "html"),
                    ("up | down", "pipe"), ("`up`", "backtick"), ("*", "asterisk"), ("...", "dots")]
        crashes = 0
        for inp, label in specials:
            try: adapter.reset()
            except Exception: break
            _, crashed = safe_step(adapter, inp)
            if crashed:
                crashes += 1
                try: adapter.reset()
                except Exception: break
        add("T4_UNICODE", "FAIL" if crashes else "PASS",
            f"{crashes}/{len(specials)} crashed" if crashes else f"{len(specials)} special inputs handled")
    except Exception as e:
        add("T4_UNICODE", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T5: VERY LONG STRINGS
    try:
        longs = [("100", "a" * 100), ("1000", "x" * 1000), ("spaces", " " * 1000), ("repeated", ("up " * 500).strip())]
        crashes = 0
        for label, inp in longs:
            try: adapter.reset()
            except Exception: break
            _, crashed = safe_step(adapter, inp)
            if crashed:
                crashes += 1
                try: adapter.reset()
                except Exception: break
        add("T5_LONG", "FAIL" if crashes else "PASS",
            f"{crashes}/{len(longs)} crashed" if crashes else f"{len(longs)} long strings handled")
    except Exception as e:
        add("T5_LONG", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T6: RAPID STEP/RESET CYCLING
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(42)
        crashes = 0
        for _ in range(100):
            try:
                c = rng()
                if c < 0.25:
                    adapter.reset()
                elif c < 0.5:
                    adapter.step(non_reset[int(rng() * len(non_reset))])
                    if adapter.get_state() in ("GAME_OVER", "WIN"): adapter.reset()
                elif c < 0.75:
                    adapter.step(non_reset[int(rng() * len(non_reset))])
                    adapter.reset()
                else:
                    adapter.reset(); adapter.reset()
            except Exception:
                crashes += 1
                if crashes >= 5: break
                try: adapter.reset()
                except Exception: break
        add("T6_RAPID", "FAIL" if crashes else "PASS",
            f"{crashes} crashes in 100 cycles" if crashes else "100 rapid cycles OK")
    except Exception as e:
        add("T6_RAPID", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T7: STATE AFTER GARBAGE
    try:
        adapter.reset()
        acts_before = set(adapter.get_available_actions())
        for g in ["", " ", "ZZZZ_INVALID", "a" * 500]:
            safe_step(adapter, g)
        adapter.reset()
        acts_after = set(adapter.get_available_actions())
        state_after = adapter.get_state()
        issues = []
        if state_after != "IN_PROGRESS": issues.append(f"state={state_after}")
        if acts_before != acts_after: issues.append("actions changed")
        add("T7_GARBAGE", "WARN" if issues else "PASS",
            "; ".join(issues) if issues else "state clean after garbage + reset")
    except Exception as e:
        add("T7_GARBAGE", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T8: REWARD BOUNDS EXTENDED
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        rng = seeded_random(77)
        violations = []
        for i in range(200):
            try:
                act = non_reset[int(rng() * len(non_reset))]
                adapter.step(act)
                sc = adapter.get_score()
                if not isinstance(sc, (int, float)) or math.isnan(sc) or not math.isfinite(sc):
                    violations.append(f"step {i}: invalid score={sc}"); break
                if sc < 0 or sc > 1: violations.append(f"step {i}: score={sc}")
                if adapter.get_state() in ("GAME_OVER", "WIN"): adapter.reset()
            except Exception:
                try: adapter.reset()
                except Exception: break
        add("T8_REWARD", "WARN" if violations else "PASS",
            "; ".join(violations[:3]) if violations else "200 steps, all scores valid")
    except Exception as e:
        add("T8_REWARD", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T9: ACTIONS STABILITY
    try:
        adapter.reset()
        baseline = set(adapter.get_available_actions())
        stable = True
        for _ in range(10):
            if set(adapter.get_available_actions()) != baseline: stable = False; break
        safe_step(adapter, "ZZZZ_INVALID_12345")
        adapter.reset()
        after = set(adapter.get_available_actions())
        if baseline != after:
            add("T9_STABILITY", "WARN", "actions changed after invalid + reset")
        elif not stable:
            add("T9_STABILITY", "WARN", "actions inconsistent across calls")
        else:
            add("T9_STABILITY", "PASS", "actions consistent")
    except Exception as e:
        add("T9_STABILITY", "FAIL", str(e))

    if aborted: _safe(adapter); result["duration_ms"] = int((time.monotonic() - start) * 1000); return result

    # T10: REPEATED SAME ACTION
    try:
        adapter.reset()
        non_reset = [a for a in adapter.get_available_actions() if a.lower() != "reset"]
        if not non_reset:
            add("T10_REPEAT", "SKIP", "no non-reset actions")
        else:
            act = non_reset[0]
            crashes = 0
            for _ in range(100):
                try:
                    adapter.step(act)
                    if adapter.get_state() in ("GAME_OVER", "WIN"): adapter.reset()
                except Exception:
                    crashes += 1
                    if crashes >= 3: break
                    try: adapter.reset()
                    except Exception: break
            add("T10_REPEAT", "FAIL" if crashes else "PASS",
                f"{crashes} crashes repeating '{act}' 100x" if crashes else f"'{act}' repeated 100x OK")
    except Exception as e:
        add("T10_REPEAT", "FAIL", str(e))

    # T11: DISPOSE
    try:
        adapter.dispose(); adapter = None
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
    print("  ULTRA EDGE-CASE TEST — All Games (Standalone)")
    print("=" * 80)
    print()

    games = discover_games()
    print(f"Discovered {len(games)} games\n")
    if not games:
        print("ERROR: No games discovered."); sys.exit(1)

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
    tt = sum(len(r["tests"]) for r in results)
    tp = sum(sum(1 for t in r["tests"] if t["status"] == "PASS") for r in results)
    tf = sum(sum(1 for t in r["tests"] if t["status"] == "FAIL") for r in results)
    tw = sum(sum(1 for t in r["tests"] if t["status"] == "WARN") for r in results)

    print(f"\n{'=' * 100}")
    print(f"GAMES: {len(results)}  PASS: {gp}  FAIL: {gf}")
    print(f"TESTS: {tt}  PASS: {tp}  FAIL: {tf}  WARN: {tw}")
    sys.exit(1 if gf > 0 else 0)


if __name__ == "__main__":
    main()
