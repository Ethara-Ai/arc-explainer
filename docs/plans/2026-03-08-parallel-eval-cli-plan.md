# Parallel Model Execution in Python CLI


## Problem

The Python CLI (`python -m scripts.evaluate.evaluate`) runs models **sequentially**:

```python
for gid in game_ids:
    for mk in model_keys:          # <-- one at a time
        run_single_game(...)       # blocks until complete
```

Running 5 models x 1 game x 5 runs = 25 sequential runs. Each run can take 2-10+ minutes (mostly waiting for LLM API responses). Total: 50-250+ minutes sequential, vs ~10-50 minutes parallel.

The TypeScript bridge already runs models in parallel (one subprocess per model). The Python CLI should match.

## Solution: `ThreadPoolExecutor` with Per-Model Subdirectories

### Why ThreadPoolExecutor

| Approach | Pros | Cons |
|---|---|---|
| **ThreadPoolExecutor** | Simple, shared memory, GIL released during I/O | GIL for CPU-bound work (negligible here) |
| ProcessPoolExecutor | True parallelism | Can't share event_emitter, stdout fragmented, complex IPC |
| asyncio | Best for I/O-bound | Requires rewriting ALL providers to async |
| subprocess | Process isolation | Output fragmented, complex aggregation |

The workload is 99% I/O-bound (waiting for LLM APIs). GIL is released during network and file I/O.

### File I/O Strategy: Per-Model Subdirectories

Instead of file locking, each model writes to its own subdirectory inside the game directory. **Zero shared state, zero contention.**

| File | Old Location | New Location | Conflict? |
|---|---|---|---|
| steps.jsonl | `{game_id}/` | `{game_id}/{model_name}/` | Eliminated |
| runs.jsonl | `{game_id}/` | `{game_id}/{model_name}/` | Eliminated |
| token_usage.csv | `{game_id}/` | `{game_id}/{model_name}/` | Eliminated |
| token_usage_summary.csv | `{game_id}/` | `{game_id}/{model_name}/` | Eliminated |
| metadata.json | `{game_id}/` | `{game_id}/` (unchanged) | None (idempotent) |
| traces/{model}_trace.jsonl | `{game_id}/traces/` | `{game_id}/traces/` (unchanged) | None (per-model) |
| stdout JSONL | shared | shared | One lock (trivial) |

### New Output Structure

```
data/puzzle-evals/{timestamp}/
  logs/eval_{timestamp}.log
  game_metadata.json
  {game_id}/
    metadata.json                           # shared, written once
    GPT_5.2/                                # per-model subdirectory
      steps.jsonl
      runs.jsonl
      token_usage.csv
      token_usage_summary.csv
    Gemini_3.1/
      steps.jsonl
      runs.jsonl
      token_usage.csv
      token_usage_summary.csv
    Claude_Opus_4.6_(Bedrock)/
      ...
    traces/                                 # stays at game level
      GPT_5.2_trace.jsonl
      Gemini_3.1_trace.jsonl
      Claude_Opus_4.6_(Bedrock)_trace.jsonl
```

## Changes

### 1. `eval_runner.py` -- Per-model subdirectories

```python
# Before:
game_dir = output_dir / game_id

# After:
safe_model = provider.model_name.replace(" ", "_").replace("/", "_")
game_base_dir = output_dir / game_id        # for metadata + traces
game_dir = game_base_dir / safe_model       # for JSONL + CSV
```

- `metadata.json` stays at `game_base_dir` (shared, idempotent)
- `traces/` stays at `game_base_dir` (already per-model by filename)
- `steps.jsonl`, `runs.jsonl`, CSVs go to `game_dir` (per-model)

### 2. `evaluate.py` -- ThreadPoolExecutor

- Add `--sequential` flag (opt-in for debugging; default = parallel when >1 model)
- Thread-safe JSONL emitter: one `threading.Lock` for stdout writes only
- `ThreadPoolExecutor(max_workers=len(model_keys))`
- Per game: submit all models, wait for all to complete, then aggregate

### 3. `plot_results.py` -- Read from model subdirectories

- Glob `{game_dir}/*/steps.jsonl` to find per-model files
- Merge all model data before plotting
- Backward-compatible: also checks for flat `{game_dir}/steps.jsonl`

### 4. No changes needed

- `writer.py` -- no locking needed (per-model isolation)
- `trace_writer.py` -- already per-model files
- `providers/*` -- each thread gets its own provider instance
- `game_adapter.py` -- each thread loads its own game instance
- TypeScript layer (`evalService.ts`) -- spawns separate processes, unaffected

## Execution Order

```
Game cc01:  [gemini-3.1] [gpt-5.2] [claude-4.6] [kimi-k2.5]  -- parallel
            \____________ all finish _______________/
Game ls20:  [gemini-3.1] [gpt-5.2] [claude-4.6] [kimi-k2.5]  -- parallel
            \____________ all finish _______________/
```

Models run in parallel per game. Games run sequentially.

## Backward Compatibility

- **Default behavior changes**: Multiple models run in parallel (faster)
- **`--sequential` flag**: Opt-in for old sequential behavior
- **Single model**: No threading overhead (runs directly)
- **Output structure changes**: Per-model subdirectories (new)
- **`--stdout-jsonl` mode**: Events interleave across models (TS bridge handles this)
- **plot_results.py**: Updated to read both old flat and new per-model structures
