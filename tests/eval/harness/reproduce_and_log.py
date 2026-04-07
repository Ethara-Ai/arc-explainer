#!/usr/bin/env python3
"""
Reproduce every confirmed bug in the 21+5 failing ARC-AGI-3 games.
Logs exact reproduction steps + live tracebacks to a persistent markdown file.
"""
import importlib.util
import sys
import os
import traceback
from datetime import datetime
from pathlib import Path

GAMES_DIR = str(Path(__file__).resolve().parent.parent.parent.parent / "puzzle-environments" / "ARC-AGI-3" / "environment_files")
VENV_PYTHON = "/Users/piyush/github/arc-explainer2/arc-explainer/venv/bin/python3"
OUTPUT_FILE = "/Users/piyush/github/arc-explainer2/arc-explainer/BUG_REPRODUCTION_LOG.md"


def load_game(game_id):
    py_file = os.path.join(GAMES_DIR, game_id, f"{game_id}.py")
    mod_name = f"_repro_{game_id}"
    # Clean up previous import if any
    if mod_name in sys.modules:
        del sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, py_file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return getattr(module, "PuzzleEnvironment")


class GameRunner:
    """Holds mutable state for a game reproduction run."""
    def __init__(self):
        self.pe_cls = None
        self.pe = None
        self.state = None

    def load(self, gid):
        self.pe_cls = load_game(gid)
        return self.pe_cls

    def init(self):
        self.pe = self.pe_cls(seed=0)
        return self.pe

    def reset(self):
        self.state = self.pe.reset()
        return self.state

    def get_actions(self):
        return list(self.pe.get_actions())

    def step(self, action="up"):
        return self.pe.step(action)

    def render(self, mode="rgb_array"):
        return self.pe.render(mode=mode)


def run_steps(runner, steps, log_lines):
    """Run a list of (description, callable) steps, logging results."""
    for desc, fn in steps:
        try:
            result = fn()
            log_lines.append(f"   - `{desc}` → **OK**")
            if isinstance(result, list):
                log_lines.append(f"     - returned: `{result}`")
        except Exception:
            tb = traceback.format_exc()
            log_lines.append(f"   - `{desc}` → **FAIL**")
            log_lines.append(f"     ```")
            for line in tb.strip().split("\n"):
                log_lines.append(f"     {line}")
            log_lines.append(f"     ```")
            return False
    return True


lines = []
lines.append("# Bug Reproduction Log: ARC-AGI-3 Games")
lines.append("")
lines.append(f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
lines.append(f"**Python:** `{VENV_PYTHON}` (same as `PYTHON_BIN` in `.env`)")
lines.append("**arcengine:** 0.9.3 (pip) / 0.1.0 (`__version__`)")
lines.append(f"**Games directory:** `{GAMES_DIR}`")
lines.append("")
lines.append("Each section shows the exact Python commands needed to reproduce the bug,")
lines.append("followed by the live output captured during this run.")
lines.append("")
lines.append("---")
lines.append("")

# ============================================================
# BOOTSTRAP FAILURES
# ============================================================
BOOTSTRAP_FAILURES = ["bx02", "cp01", "gv19", "ms02", "pi01", "pm14", "rp01", "sl77", "st88", "th01"]

lines.append("## Phase 1: BOOTSTRAP Failures (subprocess crashes on startup)")
lines.append("")
lines.append("These games crash during `PuzzleEnvironment(seed=0)` or the initial `pe.reset()`.")
lines.append("In the TS harness, the Python subprocess exits with code 1 before any commands can be sent.")
lines.append("")

for gid in BOOTSTRAP_FAILURES:
    lines.append(f"### {gid}")
    lines.append("")
    lines.append("**To reproduce** (copy-paste into terminal):")
    lines.append("```bash")
    lines.append(f'{VENV_PYTHON} -c "')
    lines.append("import importlib.util, sys")
    lines.append(f"spec = importlib.util.spec_from_file_location('{gid}', '{GAMES_DIR}/{gid}/{gid}.py')")
    lines.append("mod = importlib.util.module_from_spec(spec)")
    lines.append(f"sys.modules['{gid}'] = mod")
    lines.append("spec.loader.exec_module(mod)")
    lines.append("pe = mod.PuzzleEnvironment(seed=0)")
    lines.append("state = pe.reset()")
    lines.append("print('SUCCESS')")
    lines.append('"')
    lines.append("```")
    lines.append("")
    lines.append("**Live output:**")
    lines.append("")

    r = GameRunner()
    run_steps(r, [
        (f"load('{gid}.py')", lambda: r.load(gid)),
        ("PuzzleEnvironment(seed=0)", lambda: r.init()),
        ("pe.reset()", lambda: r.reset()),
    ], lines)

    lines.append("")
    lines.append("---")
    lines.append("")

# ============================================================
# RESET FAILURES
# ============================================================
RESET_FAILURES = ["gs01", "mz47", "pd01"]

lines.append("## Phase 2: RESET Failures (bootstrap OK, reset command crashes)")
lines.append("")
lines.append("These games bootstrap successfully, but crash when `pe.reset()` is called again")
lines.append("(simulating the harness sending a `{\"type\": \"reset\"}` command).")
lines.append("")

for gid in RESET_FAILURES:
    lines.append(f"### {gid}")
    lines.append("")
    lines.append("**To reproduce:**")
    lines.append("```bash")
    lines.append(f'{VENV_PYTHON} -c "')
    lines.append("import importlib.util, sys")
    lines.append(f"spec = importlib.util.spec_from_file_location('{gid}', '{GAMES_DIR}/{gid}/{gid}.py')")
    lines.append("mod = importlib.util.module_from_spec(spec)")
    lines.append(f"sys.modules['{gid}'] = mod")
    lines.append("spec.loader.exec_module(mod)")
    lines.append("pe = mod.PuzzleEnvironment(seed=0)")
    lines.append("state = pe.reset()     # bootstrap reset - should work")
    lines.append("print('Bootstrap OK')")
    lines.append("state2 = pe.reset()    # harness reset command - crashes")
    lines.append("print('Reset OK')")
    lines.append('"')
    lines.append("```")
    lines.append("")
    lines.append("**Live output:**")
    lines.append("")

    r = GameRunner()
    run_steps(r, [
        (f"load('{gid}.py')", lambda: r.load(gid)),
        ("PuzzleEnvironment(seed=0)", lambda: r.init()),
        ("pe.reset() [bootstrap]", lambda: r.reset()),
        ("pe.reset() [harness reset cmd]", lambda: r.reset()),
    ], lines)

    lines.append("")
    lines.append("---")
    lines.append("")

# ============================================================
# ACTION FAILURES
# ============================================================
ACTION_FAILURES = ["bb01", "dq42", "dr07", "em01", "gf42", "ms01", "ps42", "tk01"]

lines.append("## Phase 3: ACTION Failures (bootstrap + reset OK, first step crashes)")
lines.append("")
lines.append("These games start fine and reset OK, but crash on the first `pe.step('up')` call.")
lines.append("")

for gid in ACTION_FAILURES:
    lines.append(f"### {gid}")
    lines.append("")
    lines.append("**To reproduce:**")
    lines.append("```bash")
    lines.append(f'{VENV_PYTHON} -c "')
    lines.append("import importlib.util, sys")
    lines.append(f"spec = importlib.util.spec_from_file_location('{gid}', '{GAMES_DIR}/{gid}/{gid}.py')")
    lines.append("mod = importlib.util.module_from_spec(spec)")
    lines.append(f"sys.modules['{gid}'] = mod")
    lines.append("spec.loader.exec_module(mod)")
    lines.append("pe = mod.PuzzleEnvironment(seed=0)")
    lines.append("state = pe.reset()")
    lines.append("print('Reset OK, actions:', list(pe.get_actions()))")
    lines.append("result = pe.step('up')")
    lines.append("print('Step OK')")
    lines.append('"')
    lines.append("```")
    lines.append("")
    lines.append("**Live output:**")
    lines.append("")

    r = GameRunner()
    run_steps(r, [
        (f"load('{gid}.py')", lambda: r.load(gid)),
        ("PuzzleEnvironment(seed=0)", lambda: r.init()),
        ("pe.reset()", lambda: r.reset()),
        ("pe.get_actions()", lambda: r.get_actions()),
        ("pe.step('up')", lambda: r.step("up")),
    ], lines)

    lines.append("")
    lines.append("---")
    lines.append("")

# ============================================================
# LATENT FAILURES
# ============================================================
lines.append("## Phase 4: LATENT Failures (pass basic cycle, fail under specific triggers)")
lines.append("")
lines.append("These games pass the basic info/reset/step('up') cycle but fail when specific")
lines.append("actions or game states are triggered during actual gameplay.")
lines.append("")

# cc51, gb49 — bare click
for gid in ["cc51", "gb49"]:
    lines.append(f"### {gid} (trigger: bare `click` without coordinates)")
    lines.append("")
    lines.append("**To reproduce:**")
    lines.append("```bash")
    lines.append(f'{VENV_PYTHON} -c "')
    lines.append("import importlib.util, sys")
    lines.append(f"spec = importlib.util.spec_from_file_location('{gid}', '{GAMES_DIR}/{gid}/{gid}.py')")
    lines.append("mod = importlib.util.module_from_spec(spec)")
    lines.append(f"sys.modules['{gid}'] = mod")
    lines.append("spec.loader.exec_module(mod)")
    lines.append("pe = mod.PuzzleEnvironment(seed=0)")
    lines.append("pe.reset()")
    lines.append("print('Reset OK')")
    lines.append("pe.step('click')  # bare click without x y coordinates")
    lines.append("print('Step OK')")
    lines.append('"')
    lines.append("```")
    lines.append("")
    lines.append("**Live output:**")
    lines.append("")

    r = GameRunner()
    run_steps(r, [
        (f"load('{gid}.py')", lambda: r.load(gid)),
        ("PuzzleEnvironment(seed=0)", lambda: r.init()),
        ("pe.reset()", lambda: r.reset()),
        ("pe.step('click')", lambda: r.step("click")),
    ], lines)

    lines.append("")
    lines.append("---")
    lines.append("")

# mx07 — click with Camera.grid_to_display
lines.append("### mx07 (trigger: `click` action hits missing `Camera.grid_to_display`)")
lines.append("")
lines.append("**To reproduce:**")
lines.append("```bash")
lines.append(f'{VENV_PYTHON} -c "')
lines.append("import importlib.util, sys")
lines.append(f"spec = importlib.util.spec_from_file_location('mx07', '{GAMES_DIR}/mx07/mx07.py')")
lines.append("mod = importlib.util.module_from_spec(spec)")
lines.append("sys.modules['mx07'] = mod")
lines.append("spec.loader.exec_module(mod)")
lines.append("pe = mod.PuzzleEnvironment(seed=0)")
lines.append("pe.reset()")
lines.append("print('Reset OK')")
lines.append("pe.step('click')  # triggers Camera.grid_to_display path")
lines.append("print('Step OK')")
lines.append('"')
lines.append("```")
lines.append("")
lines.append("**Live output:**")
lines.append("")

r = GameRunner()
run_steps(r, [
    ("load('mx07.py')", lambda: r.load("mx07")),
    ("PuzzleEnvironment(seed=0)", lambda: r.init()),
    ("pe.reset()", lambda: r.reset()),
    ("pe.step('click')", lambda: r.step("click")),
], lines)

lines.append("")
lines.append("---")
lines.append("")

# ms04 — render() path
lines.append("### ms04 (trigger: `pe.render()` accesses `._current_level`)")
lines.append("")
lines.append("**To reproduce:**")
lines.append("```bash")
lines.append(f'{VENV_PYTHON} -c "')
lines.append("import importlib.util, sys")
lines.append(f"spec = importlib.util.spec_from_file_location('ms04', '{GAMES_DIR}/ms04/ms04.py')")
lines.append("mod = importlib.util.module_from_spec(spec)")
lines.append("sys.modules['ms04'] = mod")
lines.append("spec.loader.exec_module(mod)")
lines.append("pe = mod.PuzzleEnvironment(seed=0)")
lines.append("pe.reset()")
lines.append("print('Reset OK')")
lines.append("frame = pe.render(mode='rgb_array')  # triggers ._current_level access")
lines.append("print('Render OK')")
lines.append('"')
lines.append("```")
lines.append("")
lines.append("**Live output:**")
lines.append("")

r = GameRunner()
run_steps(r, [
    ("load('ms04.py')", lambda: r.load("ms04")),
    ("PuzzleEnvironment(seed=0)", lambda: r.init()),
    ("pe.reset()", lambda: r.reset()),
    ("pe.render(mode='rgb_array')", lambda: r.render()),
], lines)

lines.append("")
lines.append("---")
lines.append("")

# pd41 — code-level only (needs actual puzzle solve)
lines.append("### pd41 (trigger: level completion — code-level evidence)")
lines.append("")
lines.append("**Bug location:** `pd41.py` lines 617 and 623")
lines.append("```python")
lines.append("# Line 617 — executes when engine_state == WIN:")
lines.append("reward = 1.0 / len(self._engine.levels)   # AttributeError: no 'levels'")
lines.append("")
lines.append("# Line 623 — executes when level index advances:")
lines.append("reward = 1.0 / len(self._engine.levels)   # AttributeError: no 'levels'")
lines.append("```")
lines.append("")
lines.append("**Why basic test passes:** The `.levels` access is inside a conditional branch")
lines.append("that only runs when the agent solves a level (level_index increases) or wins.")
lines.append("Random `up` actions never trigger level completion.")
lines.append("")
lines.append("**Static verification:**")
lines.append("```bash")
lines.append(f"{VENV_PYTHON} -c \"from arcengine.base_game import ARCBaseGame; print('has .levels:', hasattr(ARCBaseGame, 'levels'))\"")
lines.append("# Output: has .levels: False")
lines.append("```")
lines.append("")
lines.append("---")
lines.append("")

# ============================================================
# SUMMARY TABLE
# ============================================================
lines.append("## Summary")
lines.append("")
lines.append("| # | Phase | Count | Games |")
lines.append("|---|-------|-------|-------|")
lines.append(f"| 1 | BOOTSTRAP (crash on init/reset) | 10 | {', '.join(BOOTSTRAP_FAILURES)} |")
lines.append(f"| 2 | RESET (crash on 2nd reset) | 3 | {', '.join(RESET_FAILURES)} |")
lines.append(f"| 3 | ACTION (crash on first step) | 8 | {', '.join(ACTION_FAILURES)} |")
lines.append("| 4 | LATENT (specific trigger) | 5 | cc51, gb49, mx07, ms04, pd41 |")
lines.append("| | **Total affected** | **26** | |")
lines.append("| | **Fully passing** | **28** | |")
lines.append("")
lines.append("## Environment Used for This Run")
lines.append("")
lines.append("```")
lines.append(f"Python executable:  {sys.executable}")
lines.append(f"Python version:     {sys.version}")
lines.append(f"arcengine (pip):    0.9.3")
lines.append(f"arcengine (__ver):  0.1.0")
lines.append(f"PYTHON_BIN (.env):  {VENV_PYTHON}")
lines.append(f"Games directory:    {GAMES_DIR}")
lines.append(f"Timestamp:          {datetime.now().isoformat()}")
lines.append("```")

content = "\n".join(lines)
with open(OUTPUT_FILE, "w") as f:
    f.write(content)

print(f"Reproduction log written to: {OUTPUT_FILE}")
print(f"Lines: {len(lines)}")
