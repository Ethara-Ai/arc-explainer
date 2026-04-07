#!/usr/bin/env python3
"""
Run all standalone tests sequentially.

Usage:
  python tests/standalone/run_all.py
  python tests/standalone/run_all.py --quick    # lifecycle only
"""

import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
TESTS = [
    ("Lifecycle & Bootstrap", "test_lifecycle.py"),
    ("Stress & State-Machine", "test_stress.py"),
    ("Ultra Edge-Cases", "test_edge_cases.py"),
    ("Comprehensive Audit", "test_audit.py"),
]


def main():
    quick = "--quick" in sys.argv
    tests_to_run = TESTS[:1] if quick else TESTS

    print("=" * 80)
    print("  ARC-AGI-3 STANDALONE TEST SUITE")
    print("=" * 80)
    print()
    print(f"Tests to run: {len(tests_to_run)}")
    print()

    results = []
    overall_start = time.monotonic()

    for name, script in tests_to_run:
        print(f"\n{'#' * 80}")
        print(f"# {name}")
        print(f"{'#' * 80}\n")

        start = time.monotonic()
        proc = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / script)],
            cwd=str(SCRIPT_DIR.parent.parent),
        )
        elapsed = time.monotonic() - start
        status = "PASS" if proc.returncode == 0 else "FAIL"
        results.append((name, status, elapsed))

    total_elapsed = time.monotonic() - overall_start

    print(f"\n\n{'=' * 80}")
    print("  FINAL SUMMARY")
    print(f"{'=' * 80}\n")

    for name, status, elapsed in results:
        print(f"  {status:<6} {name:<40} ({elapsed:.1f}s)")

    passed = sum(1 for _, s, _ in results if s == "PASS")
    failed = sum(1 for _, s, _ in results if s == "FAIL")
    print(f"\n  TOTAL: {passed} PASS / {failed} FAIL  ({total_elapsed:.1f}s)")

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
