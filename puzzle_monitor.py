"""
╔══════════════════════════════════════════════════════════╗
║  Puzzle-Eval Monitor (ARC runs)                          ║
║  Reads data/puzzle-evals/<timestamp>/<game>/<model>/*    ║
╚══════════════════════════════════════════════════════════╝

Browser dashboard (recommended):
    python puzzle_monitor.py --serve
        → opens http://localhost:8765 with live-refreshing grid of runs

Default (aggregate leaderboard in terminal):
    python puzzle_monitor.py

Single run (terminal):
    python puzzle_monitor.py --run data/puzzle-evals/20260425_003439_900

Live terminal refresh:
    python puzzle_monitor.py --run <path> --watch [--refresh 3]

Flags:
    --serve           Launch browser dashboard
    --port N          Dashboard port (default: 8765)
    --host HOST       Dashboard host (default: 127.0.0.1)
    --no-open         Don't auto-open browser with --serve
    --run PATH        Single run directory (a timestamped dir)
    --root PATH       Root of puzzle-evals (default: data/puzzle-evals)
    --watch           Live-refresh terminal mode
    --refresh N       Refresh interval seconds (default: 5)
    --brief           One-line-per-run summary only
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

DEFAULT_ROOT = Path("data/puzzle-evals")

SYM_PASS = "✅"
SYM_FAIL = "❌"
SYM_PART = "🟡"
SYM_CLOCK = "⏱"

@dataclass
class RunData:
    run_dir: Path
    game_id: str
    model_name: str
    model_dir: Path
    game_meta: dict = field(default_factory=dict)
    game_level_meta: dict = field(default_factory=dict)
    runs: list[dict] = field(default_factory=list)
    steps: list[dict] = field(default_factory=list)
    timing: list[dict] = field(default_factory=list)
    skips: list[dict] = field(default_factory=list)
    summary_rows: list[dict] = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"{self.run_dir.name}/{self.game_id}/{self.model_name}"

def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return out

def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with path.open() as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}

def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        with path.open() as f:
            return list(csv.DictReader(f))
    except OSError:
        return []

def discover_runs(root: Path) -> Iterator[RunData]:
    if not root.exists():
        return
    for run_dir in sorted(root.iterdir()):
        if not run_dir.is_dir():
            continue
        game_meta = _read_json(run_dir / "game_metadata.json")
        for game_dir in sorted(run_dir.iterdir()):
            if not game_dir.is_dir() or game_dir.name == "logs":
                continue
            game_meta_local = _read_json(game_dir / "metadata.json")
            for model_dir in sorted(game_dir.iterdir()):
                if not model_dir.is_dir() or model_dir.name == "traces":
                    continue
                if not any(model_dir.iterdir()):
                    continue
                yield load_run_data(
                    run_dir=run_dir,
                    game_id=game_dir.name,
                    model_name=model_dir.name,
                    model_dir=model_dir,
                    game_meta=game_meta,
                    game_level_meta=game_meta_local,
                )

def load_run_data(
    run_dir: Path,
    game_id: str,
    model_name: str,
    model_dir: Path,
    game_meta: dict | None = None,
    game_level_meta: dict | None = None,
) -> RunData:
    return RunData(
        run_dir=run_dir,
        game_id=game_id,
        model_name=model_name,
        model_dir=model_dir,
        game_meta=game_meta or _read_json(run_dir / "game_metadata.json"),
        game_level_meta=game_level_meta or _read_json(model_dir.parent / "metadata.json"),
        runs=_read_jsonl(model_dir / "runs.jsonl"),
        steps=_read_jsonl(model_dir / "steps.jsonl"),
        timing=_read_jsonl(model_dir / "timing.jsonl"),
        skips=_read_jsonl(model_dir / "skips.jsonl"),
        summary_rows=_read_csv(model_dir / "token_usage_summary.csv"),
    )

def load_single_run(run_dir: Path) -> list[RunData]:
    results: list[RunData] = []
    if not run_dir.is_dir():
        return results
    game_meta = _read_json(run_dir / "game_metadata.json")
    for game_dir in sorted(run_dir.iterdir()):
        if not game_dir.is_dir() or game_dir.name == "logs":
            continue
        game_level_meta = _read_json(game_dir / "metadata.json")
        for model_dir in sorted(game_dir.iterdir()):
            if not model_dir.is_dir() or model_dir.name == "traces":
                continue
            if not any(model_dir.iterdir()):
                continue
            results.append(
                load_run_data(
                    run_dir=run_dir,
                    game_id=game_dir.name,
                    model_name=model_dir.name,
                    model_dir=model_dir,
                    game_meta=game_meta,
                    game_level_meta=game_level_meta,
                )
            )
    return results

def _fmt_money(x: float) -> str:
    return f"${x:.4f}" if x < 1 else f"${x:.2f}"

def _fmt_int(x: int | float | None) -> str:
    if x is None:
        return "—"
    return f"{int(x):,}"

def _fmt_pct(x: float | None) -> str:
    if x is None:
        return "—"
    return f"{x:.0f}%"

def _status_symbol(solved: bool, score_pct: float) -> str:
    if solved:
        return SYM_PASS
    if score_pct > 0:
        return SYM_PART
    return SYM_FAIL

def _percentiles(values: list[float]) -> tuple[float, float, float]:
    """Return (p50, p95, max). Empty → zeros."""
    if not values:
        return 0.0, 0.0, 0.0
    s = sorted(values)
    p50 = statistics.median(s)
    p95_idx = max(0, int(round(0.95 * (len(s) - 1))))
    return p50, s[p95_idx], s[-1]

def render_header(rd: RunData) -> Panel:
    gm = rd.game_meta
    lm = rd.game_level_meta
    game_block = {}
    for gb in gm.get("games", []) or []:
        if gb.get("gameId") == rd.game_id:
            game_block = gb
            break

    lines: list[Text] = []
    lines.append(Text(f"{rd.run_dir.name}   ·   {rd.game_id}   ·   {rd.model_name}", style="bold cyan"))

    session_id = gm.get("sessionId", "—")
    status = gm.get("status", "—")
    ts = gm.get("timestamp", "—")
    status_style = "green" if status == "completed" else "yellow"
    lines.append(Text.assemble(
        ("session: ", "dim"), (session_id, "white"),
        ("   status: ", "dim"), (status, status_style),
        ("   started: ", "dim"), (ts, "white"),
    ))

    max_steps = lm.get("maxSteps", "?")
    num_runs = lm.get("numRuns", "?")
    seed = lm.get("seedBase", "?")
    lines.append(Text.assemble(
        ("runs: ", "dim"), (str(num_runs), "white"),
        ("   max_steps: ", "dim"), (str(max_steps), "white"),
        ("   seed_base: ", "dim"), (str(seed), "white"),
    ))

    total_cost = gm.get("totalCost", 0.0)
    total_tokens = gm.get("totalTokens", 0)
    total_dur = gm.get("totalDuration", 0.0)
    lines.append(Text.assemble(
        ("total: ", "dim"),
        (_fmt_money(total_cost), "bold yellow"), ("  ·  ", "dim"),
        (f"{_fmt_int(total_tokens)} tok", "bold magenta"), ("  ·  ", "dim"),
        (f"{total_dur:.1f}s", "bold blue"),
    ))

    return Panel(Group(*lines), title="[bold]Puzzle Eval[/bold]", border_style="cyan")

def render_runs_table(rd: RunData) -> Table:
    t = Table(title="Per-Run Summary", expand=True, show_lines=False)
    t.add_column("#", justify="right")
    t.add_column("Status")
    t.add_column("Score", justify="right")
    t.add_column("Levels", justify="right")
    t.add_column("Steps", justify="right")
    t.add_column("Elapsed", justify="right")
    t.add_column("In Tok", justify="right")
    t.add_column("Out Tok", justify="right")
    t.add_column("Cost", justify="right")
    t.add_column("Reset", justify="right")
    t.add_column("Error")

    for r in rd.runs:
        solved = bool(r.get("solved", False))
        score_pct = float(r.get("final_score_pct", 0))
        sym = _status_symbol(solved, score_pct)
        lvl = f"{r.get('levels_completed', 0)}/{r.get('total_levels', 0)}"
        t.add_row(
            str(r.get("run_number", "?")),
            sym,
            _fmt_pct(score_pct),
            lvl,
            str(r.get("total_steps", 0)),
            f"{float(r.get('elapsed_seconds', 0)):.1f}s",
            _fmt_int(r.get("total_input_tokens")),
            _fmt_int(r.get("total_output_tokens")),
            _fmt_money(float(r.get("cost_usd", 0))),
            str(r.get("reset_count", 0)),
            str(r.get("error") or "—"),
        )
    return t

def render_steps_table(rd: RunData, limit: int = 40) -> Table:
    t = Table(title=f"Steps (last {limit})", expand=True)
    t.add_column("Run", justify="right")
    t.add_column("Step", justify="right")
    t.add_column("Action")
    t.add_column("Score", justify="right")
    t.add_column("Level", justify="right")
    t.add_column("State")
    t.add_column("Step $", justify="right")
    t.add_column("Cum $", justify="right")
    t.add_column("In", justify="right")
    t.add_column("Out", justify="right")

    steps = rd.steps[-limit:]
    for s in steps:
        state = s.get("state", "—")
        state_style = {
            "WIN": "green",
            "NOT_FINISHED": "white",
            "GAME_OVER": "red",
        }.get(state, "dim")
        t.add_row(
            str(s.get("run_number", "?")),
            str(s.get("step", "?")),
            str(s.get("action", "—")),
            _fmt_pct(s.get("score_pct")),
            f"{s.get('level', 0)}/{s.get('total_levels', 0)}",
            Text(state, style=state_style),
            _fmt_money(float(s.get("step_cost_usd", 0))),
            _fmt_money(float(s.get("cumulative_cost_usd", 0))),
            _fmt_int(s.get("input_tokens")),
            _fmt_int(s.get("output_tokens")),
        )
    return t

def render_timing_panel(rd: RunData) -> Panel:
    api_vals = [float(t.get("api_call_ms", 0)) for t in rd.timing if t.get("api_call_ms") is not None]
    game_vals = [float(t.get("game_step_ms", 0)) for t in rd.timing if t.get("game_step_ms") is not None]

    api_p50, api_p95, api_max = _percentiles(api_vals)
    g_p50, g_p95, g_max = _percentiles(game_vals)

    total_api = sum(api_vals) / 1000.0
    total_game = sum(game_vals) / 1000.0

    lines = [
        Text.assemble((f"{SYM_CLOCK} Timing  ", "bold cyan"), (f"({len(api_vals)} api calls)", "dim")),
        Text.assemble(
            ("  API   ", "dim"),
            (f"p50={api_p50:>7.0f}ms  ", "white"),
            (f"p95={api_p95:>7.0f}ms  ", "yellow"),
            (f"max={api_max:>7.0f}ms  ", "red"),
            (f"total={total_api:.1f}s", "bold"),
        ),
        Text.assemble(
            ("  Game  ", "dim"),
            (f"p50={g_p50:>7.1f}ms  ", "white"),
            (f"p95={g_p95:>7.1f}ms  ", "yellow"),
            (f"max={g_max:>7.1f}ms  ", "red"),
            (f"total={total_game:.2f}s", "bold"),
        ),
    ]
    return Panel(Group(*lines), border_style="blue")

def render_tokens_panel(rd: RunData) -> Panel:
    total_in = sum(int(r.get("total_input_tokens", 0) or 0) for r in rd.summary_rows)
    total_out = sum(int(r.get("total_output_tokens", 0) or 0) for r in rd.summary_rows)
    total_reason = sum(int(r.get("total_reasoning_tokens", 0) or 0) for r in rd.summary_rows)
    total_cached = sum(int(r.get("total_cached_input_tokens", 0) or 0) for r in rd.summary_rows)
    total_cw = sum(int(r.get("total_cache_write_tokens", 0) or 0) for r in rd.summary_rows)
    total_cost = sum(float(r.get("total_cost_usd", 0) or 0) for r in rd.summary_rows)
    total_steps = sum(int(r.get("total_steps", 0) or 0) for r in rd.summary_rows)

    cost_per_step = (total_cost / total_steps) if total_steps else 0.0
    tok_per_step_in = (total_in / total_steps) if total_steps else 0.0

    lines = [
        Text.assemble(("Tokens & Cost", "bold cyan")),
        Text.assemble(
            ("  input:    ", "dim"), (_fmt_int(total_in), "magenta"),
            ("   cached: ", "dim"), (_fmt_int(total_cached), "magenta"),
            ("   cache-write: ", "dim"), (_fmt_int(total_cw), "magenta"),
        ),
        Text.assemble(
            ("  output:   ", "dim"), (_fmt_int(total_out), "green"),
            ("   reasoning: ", "dim"), (_fmt_int(total_reason), "green"),
        ),
        Text.assemble(
            ("  cost:     ", "dim"), (_fmt_money(total_cost), "bold yellow"),
            ("   per-step: ", "dim"), (_fmt_money(cost_per_step), "yellow"),
            ("   in-tok/step: ", "dim"), (f"{tok_per_step_in:,.0f}", "magenta"),
        ),
    ]
    return Panel(Group(*lines), border_style="magenta")

def render_skips_panel(rd: RunData) -> Panel | None:
    if not rd.skips:
        return None
    t = Table(title=f"Skips / Parse Errors ({len(rd.skips)})", expand=True)
    t.add_column("Step", justify="right")
    t.add_column("Action")
    t.add_column("Reasoning (snippet)")
    for s in rd.skips[:10]:
        reasoning = str(s.get("reasoning", ""))[:120].replace("\n", " ")
        t.add_row(
            str(s.get("attemptedStep", "?")),
            str(s.get("action", "—")),
            reasoning,
        )
    return Panel(t, border_style="red")

def render_full_report(runs: list[RunData], brief: bool = False) -> Group:
    if not runs:
        return Group(Panel("No runs found.", border_style="red"))

    if brief:
        return Group(render_brief_table(runs))

    blocks: list[Any] = []
    for i, rd in enumerate(runs):
        if i > 0:
            blocks.append(Text(""))
        blocks.append(render_header(rd))
        blocks.append(render_runs_table(rd))
        blocks.append(render_timing_panel(rd))
        blocks.append(render_tokens_panel(rd))
        skips = render_skips_panel(rd)
        if skips:
            blocks.append(skips)
        blocks.append(render_steps_table(rd))
    return Group(*blocks)

def render_brief_table(runs: list[RunData]) -> Table:
    t = Table(title="Puzzle Eval Leaderboard", expand=True)
    t.add_column("Run Dir")
    t.add_column("Game")
    t.add_column("Model")
    t.add_column("Status", justify="center")
    t.add_column("Solved", justify="right")
    t.add_column("Avg %", justify="right")
    t.add_column("Steps", justify="right")
    t.add_column("Cost", justify="right")
    t.add_column("Tokens", justify="right")
    t.add_column("Elapsed", justify="right")

    for rd in runs:
        n_solved = sum(1 for r in rd.runs if r.get("solved"))
        n_total = len(rd.runs)
        avg_pct = (sum(float(r.get("final_score_pct", 0)) for r in rd.runs) / n_total) if n_total else 0.0
        total_steps = sum(int(r.get("total_steps", 0)) for r in rd.runs)
        total_cost = sum(float(r.get("cost_usd", 0)) for r in rd.runs)
        total_tok = sum(
            int(r.get("total_input_tokens", 0)) + int(r.get("total_output_tokens", 0))
            for r in rd.runs
        )
        total_elapsed = sum(float(r.get("elapsed_seconds", 0)) for r in rd.runs)
        status = rd.game_meta.get("status", "—")
        status_cell = Text(
            SYM_PASS if n_solved == n_total and n_total > 0 else (SYM_PART if n_solved > 0 else SYM_FAIL),
        )

        t.add_row(
            rd.run_dir.name,
            rd.game_id,
            rd.model_name,
            status_cell,
            f"{n_solved}/{n_total}",
            _fmt_pct(avg_pct),
            str(total_steps),
            _fmt_money(total_cost),
            _fmt_int(total_tok),
            f"{total_elapsed:.1f}s",
        )
    return t

def _run_summary_dict(rd: RunData) -> dict:
    n_solved = sum(1 for r in rd.runs if r.get("solved"))
    n_total = len(rd.runs)
    avg_pct = (sum(float(r.get("final_score_pct", 0)) for r in rd.runs) / n_total) if n_total else 0.0
    total_steps = sum(int(r.get("total_steps", 0)) for r in rd.runs)
    total_cost = sum(float(r.get("cost_usd", 0)) for r in rd.runs)
    total_in = sum(int(r.get("total_input_tokens", 0) or 0) for r in rd.runs)
    total_out = sum(int(r.get("total_output_tokens", 0) or 0) for r in rd.runs)
    total_elapsed = sum(float(r.get("elapsed_seconds", 0)) for r in rd.runs)

    if n_total > 0 and n_solved == n_total:
        status = "pass"
    elif n_solved > 0 or avg_pct > 0:
        status = "partial"
    else:
        status = "fail"

    return {
        "run_dir": rd.run_dir.name,
        "run_path": str(rd.run_dir),
        "game_id": rd.game_id,
        "model_name": rd.model_name,
        "session_id": rd.game_meta.get("sessionId"),
        "session_status": rd.game_meta.get("status"),
        "timestamp": rd.game_meta.get("timestamp"),
        "status": status,
        "solved": n_solved,
        "total_runs": n_total,
        "avg_score_pct": round(avg_pct, 2),
        "total_steps": total_steps,
        "total_cost": round(total_cost, 6),
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "total_tokens": total_in + total_out,
        "elapsed_seconds": round(total_elapsed, 2),
        "max_steps": rd.game_level_meta.get("maxSteps"),
        "num_runs_config": rd.game_level_meta.get("numRuns"),
        "seed_base": rd.game_level_meta.get("seedBase"),
    }


def _run_detail_dict(rd: RunData) -> dict:
    api_vals = [float(t.get("api_call_ms", 0)) for t in rd.timing if t.get("api_call_ms") is not None]
    game_vals = [float(t.get("game_step_ms", 0)) for t in rd.timing if t.get("game_step_ms") is not None]
    api_p50, api_p95, api_max = _percentiles(api_vals)
    g_p50, g_p95, g_max = _percentiles(game_vals)

    total_in = sum(int(r.get("total_input_tokens", 0) or 0) for r in rd.summary_rows)
    total_out = sum(int(r.get("total_output_tokens", 0) or 0) for r in rd.summary_rows)
    total_reason = sum(int(r.get("total_reasoning_tokens", 0) or 0) for r in rd.summary_rows)
    total_cached = sum(int(r.get("total_cached_input_tokens", 0) or 0) for r in rd.summary_rows)
    total_cw = sum(int(r.get("total_cache_write_tokens", 0) or 0) for r in rd.summary_rows)
    total_cost = sum(float(r.get("total_cost_usd", 0) or 0) for r in rd.summary_rows)
    total_steps_sum = sum(int(r.get("total_steps", 0) or 0) for r in rd.summary_rows)

    return {
        **_run_summary_dict(rd),
        "game_meta": rd.game_meta,
        "game_level_meta": rd.game_level_meta,
        "runs": rd.runs,
        "steps": rd.steps,
        "timing": rd.timing,
        "skips": rd.skips,
        "summary_rows": rd.summary_rows,
        "timing_stats": {
            "api_call_count": len(api_vals),
            "api_p50_ms": round(api_p50, 1),
            "api_p95_ms": round(api_p95, 1),
            "api_max_ms": round(api_max, 1),
            "api_total_s": round(sum(api_vals) / 1000.0, 2),
            "game_p50_ms": round(g_p50, 2),
            "game_p95_ms": round(g_p95, 2),
            "game_max_ms": round(g_max, 2),
            "game_total_s": round(sum(game_vals) / 1000.0, 3),
        },
        "token_totals": {
            "input": total_in,
            "cached_input": total_cached,
            "cache_write": total_cw,
            "output": total_out,
            "reasoning": total_reason,
            "cost_usd": round(total_cost, 6),
            "total_steps": total_steps_sum,
            "cost_per_step": round(total_cost / total_steps_sum, 6) if total_steps_sum else 0.0,
            "in_tokens_per_step": round(total_in / total_steps_sum, 1) if total_steps_sum else 0.0,
        },
    }


def collect_dashboard_payload(root: Path) -> dict:
    runs = list(discover_runs(root))
    summaries = [_run_summary_dict(rd) for rd in runs]
    summaries.sort(key=lambda s: s.get("timestamp") or s["run_dir"], reverse=True)

    models = sorted({s["model_name"] for s in summaries})
    games = sorted({s["game_id"] for s in summaries})

    totals = {
        "runs": len(summaries),
        "solved": sum(1 for s in summaries if s["status"] == "pass"),
        "partial": sum(1 for s in summaries if s["status"] == "partial"),
        "failed": sum(1 for s in summaries if s["status"] == "fail"),
        "total_cost": round(sum(s["total_cost"] for s in summaries), 4),
        "total_tokens": sum(s["total_tokens"] for s in summaries),
        "total_elapsed_s": round(sum(s["elapsed_seconds"] for s in summaries), 1),
    }

    return {
        "root": str(root),
        "runs": summaries,
        "models": models,
        "games": games,
        "totals": totals,
        "server_time": time.time(),
    }


def collect_run_detail_payload(run_dir: Path) -> dict:
    runs = load_single_run(run_dir)
    return {
        "run_path": str(run_dir),
        "run_dir": run_dir.name,
        "found": len(runs),
        "entries": [_run_detail_dict(rd) for rd in runs],
        "server_time": time.time(),
    }


DASHBOARD_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Puzzle Eval Monitor</title>
<style>
  :root {
    --bg: #0b1020;
    --bg-2: #121933;
    --bg-3: #1a2346;
    --fg: #e6ecff;
    --fg-dim: #8a94b8;
    --accent: #7aa2f7;
    --pass: #9ece6a;
    --partial: #e0af68;
    --fail: #f7768e;
    --border: #283050;
    --card: #141a33;
    --code: #0f1426;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { position: sticky; top: 0; z-index: 10; background: var(--bg-2);
    border-bottom: 1px solid var(--border); padding: 14px 24px;
    display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: 0.3px; }
  header h1 .sub { color: var(--fg-dim); font-weight: 400; margin-left: 8px; font-size: 13px; }
  .totals { display: flex; gap: 18px; flex-wrap: wrap; color: var(--fg-dim); font-size: 13px; }
  .totals b { color: var(--fg); margin-left: 4px; }
  .totals .pass { color: var(--pass); }
  .totals .partial { color: var(--partial); }
  .totals .fail { color: var(--fail); }
  .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-left: auto; }
  .controls input, .controls select {
    background: var(--bg-3); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .controls input:focus, .controls select:focus { outline: 1px solid var(--accent); }
  .refresh-pill { color: var(--fg-dim); font-size: 12px; padding: 4px 10px;
    border: 1px solid var(--border); border-radius: 12px; }
  .refresh-pill.live::before { content: "● "; color: var(--pass); }
  main { padding: 20px 24px 60px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px; cursor: pointer; transition: transform 0.08s, border-color 0.08s; }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .card .row1 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .card .run-dir { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg); font-size: 13px; font-weight: 600; word-break: break-all; }
  .card .status { font-size: 20px; flex-shrink: 0; }
  .card .meta { color: var(--fg-dim); font-size: 12px; margin-top: 6px; }
  .card .meta .pill { display: inline-block; background: var(--bg-3); color: var(--fg);
    padding: 2px 8px; border-radius: 10px; margin-right: 4px; font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .card .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    margin-top: 12px; }
  .card .stat { background: var(--bg-3); border-radius: 6px; padding: 8px; text-align: center; }
  .card .stat .v { font-size: 14px; font-weight: 600; color: var(--fg); }
  .card .stat .l { font-size: 10px; color: var(--fg-dim); text-transform: uppercase;
    letter-spacing: 0.5px; margin-top: 2px; }
  .status-pass { color: var(--pass); }
  .status-partial { color: var(--partial); }
  .status-fail { color: var(--fail); }
  .empty { color: var(--fg-dim); text-align: center; padding: 60px; font-size: 14px; }
  .modal { position: fixed; inset: 0; background: rgba(4, 7, 20, 0.75);
    display: none; align-items: flex-start; justify-content: center;
    padding: 40px 20px; overflow-y: auto; z-index: 100; }
  .modal.open { display: flex; }
  .modal-inner { background: var(--bg-2); border: 1px solid var(--border);
    border-radius: 12px; max-width: 1200px; width: 100%; padding: 22px 26px; }
  .modal-inner h2 { margin: 0 0 10px; font-size: 18px; display: flex;
    gap: 14px; align-items: baseline; }
  .modal-inner h2 .close { margin-left: auto; color: var(--fg-dim); cursor: pointer;
    font-size: 22px; line-height: 1; }
  .modal-inner h2 .close:hover { color: var(--fail); }
  .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px; margin-top: 14px; }
  .detail-box { background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; }
  .detail-box h3 { margin: 0 0 8px; font-size: 13px; color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.4px; }
  .detail-box dl { margin: 0; display: grid; grid-template-columns: auto 1fr;
    gap: 4px 12px; font-size: 12px; }
  .detail-box dt { color: var(--fg-dim); }
  .detail-box dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  table th, table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  table th { color: var(--fg-dim); font-weight: 500; text-transform: uppercase;
    font-size: 10px; letter-spacing: 0.5px; }
  table td.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table tbody tr:hover { background: var(--bg-3); }
  .state-WIN { color: var(--pass); }
  .state-GAME_OVER { color: var(--fail); }
  .state-NOT_FINISHED { color: var(--fg); }
  .section { margin-top: 18px; }
  .section h3 { margin: 0 0 6px; font-size: 13px; color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.4px; }
  .loading { color: var(--fg-dim); padding: 20px; text-align: center; }
  .err { color: var(--fail); padding: 20px; text-align: center; }
  .reasoning { max-width: 520px; color: var(--fg-dim); font-size: 11px;
    white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<header>
  <h1>Puzzle Eval Monitor <span class="sub" id="rootLabel"></span></h1>
  <div class="totals" id="totals"></div>
  <div class="controls">
    <input id="search" type="search" placeholder="Search run/session…" />
    <select id="modelFilter"><option value="">All models</option></select>
    <select id="gameFilter"><option value="">All games</option></select>
    <select id="statusFilter">
      <option value="">All status</option>
      <option value="pass">✅ Pass</option>
      <option value="partial">🟡 Partial</option>
      <option value="fail">❌ Fail</option>
    </select>
    <select id="sortBy">
      <option value="timestamp">Newest first</option>
      <option value="timestamp_asc">Oldest first</option>
      <option value="cost_desc">Cost ↓</option>
      <option value="cost_asc">Cost ↑</option>
      <option value="score_desc">Score ↓</option>
      <option value="score_asc">Score ↑</option>
      <option value="elapsed_desc">Elapsed ↓</option>
    </select>
    <span class="refresh-pill live" id="refreshPill">auto-refresh</span>
  </div>
</header>
<main>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty" style="display:none">No runs found.</div>
</main>
<div id="modal" class="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal-inner" id="modalInner"></div>
</div>
<script>
const REFRESH_MS = 5000;
let state = { runs: [], models: [], games: [], totals: {}, root: "" };
let openPath = null;

async function fetchRuns() {
  try {
    const res = await fetch("/api/runs");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state = data;
    render();
    if (openPath) refreshOpenDetail();
    setPill(true);
  } catch (e) {
    setPill(false);
    console.error(e);
  }
}

function setPill(live) {
  const p = document.getElementById("refreshPill");
  p.classList.toggle("live", live);
  p.textContent = live ? "auto-refresh" : "reconnecting…";
}

function populateFilter(id, values) {
  const sel = document.getElementById(id);
  const current = sel.value;
  const first = sel.querySelector("option");
  sel.innerHTML = "";
  sel.appendChild(first);
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  sel.value = current;
}

function render() {
  document.getElementById("rootLabel").textContent = "— " + state.root;
  const t = state.totals || {};
  document.getElementById("totals").innerHTML =
    `<span>runs<b>${t.runs || 0}</b></span>` +
    `<span class="pass">pass<b>${t.solved || 0}</b></span>` +
    `<span class="partial">partial<b>${t.partial || 0}</b></span>` +
    `<span class="fail">fail<b>${t.failed || 0}</b></span>` +
    `<span>cost<b>$${(t.total_cost || 0).toFixed(4)}</b></span>` +
    `<span>tokens<b>${(t.total_tokens || 0).toLocaleString()}</b></span>` +
    `<span>elapsed<b>${(t.total_elapsed_s || 0).toFixed(1)}s</b></span>`;

  populateFilter("modelFilter", state.models || []);
  populateFilter("gameFilter", state.games || []);

  const q = document.getElementById("search").value.toLowerCase();
  const mf = document.getElementById("modelFilter").value;
  const gf = document.getElementById("gameFilter").value;
  const sf = document.getElementById("statusFilter").value;
  const sort = document.getElementById("sortBy").value;

  let runs = (state.runs || []).filter(r => {
    if (mf && r.model_name !== mf) return false;
    if (gf && r.game_id !== gf) return false;
    if (sf && r.status !== sf) return false;
    if (q) {
      const blob = `${r.run_dir} ${r.model_name} ${r.game_id} ${r.session_id || ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  const cmp = {
    timestamp: (a, b) => (b.timestamp || b.run_dir).localeCompare(a.timestamp || a.run_dir),
    timestamp_asc: (a, b) => (a.timestamp || a.run_dir).localeCompare(b.timestamp || b.run_dir),
    cost_desc: (a, b) => b.total_cost - a.total_cost,
    cost_asc: (a, b) => a.total_cost - b.total_cost,
    score_desc: (a, b) => b.avg_score_pct - a.avg_score_pct,
    score_asc: (a, b) => a.avg_score_pct - b.avg_score_pct,
    elapsed_desc: (a, b) => b.elapsed_seconds - a.elapsed_seconds,
  }[sort] || ((a, b) => 0);
  runs.sort(cmp);

  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  document.getElementById("empty").style.display = runs.length ? "none" : "block";

  for (const r of runs) {
    const statusIcon = { pass: "✅", partial: "🟡", fail: "❌" }[r.status] || "·";
    const statusCls = "status-" + r.status;
    const el = document.createElement("div");
    el.className = "card";
    el.onclick = () => openModal(r.run_path);
    el.innerHTML = `
      <div class="row1">
        <div class="run-dir">${r.run_dir}</div>
        <div class="status ${statusCls}">${statusIcon}</div>
      </div>
      <div class="meta">
        <span class="pill">${r.game_id}</span>
        <span class="pill">${r.model_name}</span>
        ${r.session_status ? `<span style="color:var(--fg-dim)">· ${r.session_status}</span>` : ""}
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${r.avg_score_pct.toFixed(0)}%</div><div class="l">Score</div></div>
        <div class="stat"><div class="v">${r.solved}/${r.total_runs}</div><div class="l">Solved</div></div>
        <div class="stat"><div class="v">${r.total_steps}</div><div class="l">Steps</div></div>
        <div class="stat"><div class="v">$${r.total_cost.toFixed(4)}</div><div class="l">Cost</div></div>
        <div class="stat"><div class="v">${(r.total_tokens / 1000).toFixed(1)}k</div><div class="l">Tokens</div></div>
        <div class="stat"><div class="v">${r.elapsed_seconds.toFixed(0)}s</div><div class="l">Elapsed</div></div>
      </div>`;
    grid.appendChild(el);
  }
}

async function openModal(path) {
  openPath = path;
  document.getElementById("modal").classList.add("open");
  document.getElementById("modalInner").innerHTML = `<div class="loading">Loading ${path}…</div>`;
  await refreshOpenDetail();
}

async function refreshOpenDetail() {
  if (!openPath) return;
  try {
    const res = await fetch("/api/run?path=" + encodeURIComponent(openPath));
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    renderDetail(data);
  } catch (e) {
    document.getElementById("modalInner").innerHTML =
      `<div class="err">Failed to load: ${e.message}</div>`;
  }
}

function closeModal() {
  openPath = null;
  document.getElementById("modal").classList.remove("open");
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

function fmtInt(n) { return (n == null ? "—" : Number(n).toLocaleString()); }
function fmtMs(n) { return n == null ? "—" : Number(n).toFixed(0) + "ms"; }
function fmtMoney(n) { if (n == null) return "—"; return n < 1 ? "$" + n.toFixed(4) : "$" + n.toFixed(2); }

function renderDetail(data) {
  if (!data.entries || !data.entries.length) {
    document.getElementById("modalInner").innerHTML =
      `<h2>${data.run_dir} <span class="close" onclick="closeModal()">×</span></h2>
       <div class="err">No run data in this directory.</div>`;
    return;
  }
  let html = `<h2>${data.run_dir} <span class="close" onclick="closeModal()">×</span></h2>`;
  for (const e of data.entries) {
    const ts = e.timing_stats, tok = e.token_totals;
    html += `
      <div class="section">
        <h3>${e.game_id} / ${e.model_name} — ${{pass:"✅",partial:"🟡",fail:"❌"}[e.status]} ${e.avg_score_pct.toFixed(0)}%</h3>
        <div class="detail-grid">
          <div class="detail-box"><h3>Session</h3><dl>
            <dt>session</dt><dd>${e.session_id || "—"}</dd>
            <dt>status</dt><dd>${e.session_status || "—"}</dd>
            <dt>started</dt><dd>${e.timestamp || "—"}</dd>
            <dt>runs</dt><dd>${e.solved}/${e.total_runs} solved</dd>
            <dt>max steps</dt><dd>${e.max_steps ?? "—"}</dd>
            <dt>seed</dt><dd>${e.seed_base ?? "—"}</dd>
          </dl></div>
          <div class="detail-box"><h3>Timing</h3><dl>
            <dt>api calls</dt><dd>${ts.api_call_count}</dd>
            <dt>api p50</dt><dd>${fmtMs(ts.api_p50_ms)}</dd>
            <dt>api p95</dt><dd>${fmtMs(ts.api_p95_ms)}</dd>
            <dt>api max</dt><dd>${fmtMs(ts.api_max_ms)}</dd>
            <dt>api total</dt><dd>${ts.api_total_s}s</dd>
            <dt>game total</dt><dd>${ts.game_total_s}s</dd>
          </dl></div>
          <div class="detail-box"><h3>Tokens & Cost</h3><dl>
            <dt>input</dt><dd>${fmtInt(tok.input)}</dd>
            <dt>cached in</dt><dd>${fmtInt(tok.cached_input)}</dd>
            <dt>cache-write</dt><dd>${fmtInt(tok.cache_write)}</dd>
            <dt>output</dt><dd>${fmtInt(tok.output)}</dd>
            <dt>reasoning</dt><dd>${fmtInt(tok.reasoning)}</dd>
            <dt>cost</dt><dd>${fmtMoney(tok.cost_usd)}</dd>
            <dt>per-step</dt><dd>${fmtMoney(tok.cost_per_step)}</dd>
            <dt>in-tok/step</dt><dd>${fmtInt(Math.round(tok.in_tokens_per_step))}</dd>
          </dl></div>
        </div>`;

    if (e.runs && e.runs.length) {
      html += `<div class="section"><h3>Per-Run</h3>
        <table><thead><tr><th>#</th><th>Status</th><th class="num">Score</th>
          <th>Levels</th><th class="num">Steps</th><th class="num">Elapsed</th>
          <th class="num">In</th><th class="num">Out</th><th class="num">Cost</th>
          <th>Error</th></tr></thead><tbody>`;
      for (const r of e.runs) {
        const icon = r.solved ? "✅" : ((r.final_score_pct || 0) > 0 ? "🟡" : "❌");
        html += `<tr>
          <td>${r.run_number ?? "?"}</td><td>${icon}</td>
          <td class="num">${(r.final_score_pct || 0).toFixed(0)}%</td>
          <td>${r.levels_completed || 0}/${r.total_levels || 0}</td>
          <td class="num">${r.total_steps || 0}</td>
          <td class="num">${(r.elapsed_seconds || 0).toFixed(1)}s</td>
          <td class="num">${fmtInt(r.total_input_tokens)}</td>
          <td class="num">${fmtInt(r.total_output_tokens)}</td>
          <td class="num">${fmtMoney(r.cost_usd)}</td>
          <td style="color:var(--fg-dim)">${r.error || "—"}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }

    if (e.steps && e.steps.length) {
      const steps = e.steps.slice(-60);
      html += `<div class="section"><h3>Steps (last ${steps.length})</h3>
        <table><thead><tr><th>Run</th><th>Step</th><th>Action</th>
          <th class="num">Score</th><th>Level</th><th>State</th>
          <th class="num">Step $</th><th class="num">Cum $</th>
          <th class="num">In</th><th class="num">Out</th></tr></thead><tbody>`;
      for (const s of steps) {
        html += `<tr>
          <td>${s.run_number ?? "?"}</td>
          <td>${s.step ?? "?"}</td>
          <td>${s.action || "—"}</td>
          <td class="num">${(s.score_pct ?? 0).toFixed ? s.score_pct.toFixed(0) + "%" : (s.score_pct || 0) + "%"}</td>
          <td>${s.level || 0}/${s.total_levels || 0}</td>
          <td class="state-${s.state}">${s.state || "—"}</td>
          <td class="num">${fmtMoney(s.step_cost_usd)}</td>
          <td class="num">${fmtMoney(s.cumulative_cost_usd)}</td>
          <td class="num">${fmtInt(s.input_tokens)}</td>
          <td class="num">${fmtInt(s.output_tokens)}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }

    if (e.skips && e.skips.length) {
      html += `<div class="section"><h3>Skips / Parse Errors (${e.skips.length})</h3>
        <table><thead><tr><th>Step</th><th>Action</th><th>Reasoning</th></tr></thead><tbody>`;
      for (const s of e.skips.slice(0, 20)) {
        const reason = String(s.reasoning || "").slice(0, 400);
        html += `<tr>
          <td>${s.attemptedStep ?? "?"}</td>
          <td>${s.action || "—"}</td>
          <td class="reasoning">${reason.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }

    html += `</div>`;
  }
  document.getElementById("modalInner").innerHTML = html;
}

["search", "modelFilter", "gameFilter", "statusFilter", "sortBy"]
  .forEach(id => document.getElementById(id).addEventListener("input", render));

fetchRuns();
setInterval(fetchRuns, REFRESH_MS);
</script>
</body>
</html>
"""


class _DashboardHandler(BaseHTTPRequestHandler):
    server_version = "PuzzleEvalMonitor/1.0"
    root: Path = DEFAULT_ROOT

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("[server] %s - %s\n" % (self.address_string(), format % args))

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            self._send(200, DASHBOARD_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return

        if path == "/api/runs":
            try:
                payload = collect_dashboard_payload(self.root)
                self._send_json(payload)
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/api/run":
            qs = parse_qs(parsed.query)
            raw = (qs.get("path") or [""])[0]
            if not raw:
                self._send_json({"error": "missing ?path=<run-dir>"}, status=400)
                return
            candidate = Path(raw).resolve()
            root_resolved = self.root.resolve()
            try:
                candidate.relative_to(root_resolved)
            except ValueError:
                self._send_json({"error": "path outside root"}, status=400)
                return
            if not candidate.is_dir():
                self._send_json({"error": "not a directory"}, status=404)
                return
            try:
                payload = collect_run_detail_payload(candidate)
                self._send_json(payload)
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        self._send(404, b"not found", "text/plain")


def serve_dashboard(root: Path, host: str, port: int, open_browser: bool) -> int:
    handler = type("Handler", (_DashboardHandler,), {"root": root})
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host}:{port}/"
    console = Console()
    console.print(f"[bold cyan]Puzzle Eval Dashboard[/bold cyan] → [green]{url}[/green]")
    console.print(f"[dim]root:[/dim] {root.resolve()}")
    console.print(f"[dim]ctrl+c to stop[/dim]")

    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        console.print("\n[yellow]shutting down…[/yellow]")
    finally:
        server.server_close()
    return 0


def build_view(args: argparse.Namespace) -> Group:
    if args.run:
        runs = load_single_run(Path(args.run))
        return render_full_report(runs, brief=args.brief)
    root = Path(args.root)
    runs = list(discover_runs(root))
    if args.brief or not args.run:
        return Group(render_brief_table(runs))
    return render_full_report(runs, brief=False)

def main() -> int:
    p = argparse.ArgumentParser(description="Puzzle-Eval Monitor")
    p.add_argument("--run", type=str, default=None,
                   help="Single timestamped run directory (e.g. data/puzzle-evals/20260425_003439_900)")
    p.add_argument("--root", type=str, default=str(DEFAULT_ROOT),
                   help=f"Root puzzle-evals dir (default: {DEFAULT_ROOT})")
    p.add_argument("--watch", action="store_true", help="Live-refresh terminal mode")
    p.add_argument("--refresh", type=float, default=5.0, help="Refresh seconds (default 5)")
    p.add_argument("--brief", action="store_true", help="Brief one-line-per-run table")
    p.add_argument("--serve", action="store_true", help="Launch browser dashboard")
    p.add_argument("--host", type=str, default="127.0.0.1", help="Dashboard host (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8765, help="Dashboard port (default 8765)")
    p.add_argument("--no-open", dest="no_open", action="store_true",
                   help="Don't auto-open browser with --serve")
    args = p.parse_args()

    if args.serve:
        return serve_dashboard(
            root=Path(args.root),
            host=args.host,
            port=args.port,
            open_browser=not args.no_open,
        )

    console = Console()

    if args.watch:
        try:
            with Live(build_view(args), console=console, refresh_per_second=4, screen=False) as live:
                while True:
                    time.sleep(max(0.5, args.refresh))
                    live.update(build_view(args))
        except KeyboardInterrupt:
            return 0
    else:
        console.print(build_view(args))
    return 0

if __name__ == "__main__":
    sys.exit(main())
