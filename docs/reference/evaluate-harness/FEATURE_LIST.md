# Evaluation Harness: Feature List for Stakeholders

**What this is**: A plain-language summary of every capability in the Python evaluation harness (`scripts/evaluate/`).  
**Companion to**: [FEATURE_SPEC.md](./FEATURE_SPEC.md) (full technical specification)  
**Date**: 2026-03-22

---

## What Does It Do?

The evaluation harness answers one question: **"How well can an AI model solve ARC puzzles?"**

It takes a puzzle, gives it to an AI model, watches the model try to solve it step-by-step, and records everything that happens: the model's moves, its score, how long it took, and how much it cost. It can test many models on many puzzles at the same time.

---

## Feature List

### 1. Multi-Model Testing

Run the same puzzle against many different AI models simultaneously to compare their performance. Currently supports **18 model configurations** across 6 AI providers:

- **Google Gemini** (5 configurations including fallback tiers and routing options)
- **OpenAI GPT-5.4** (with advanced reasoning mode)
- **Anthropic Claude** (6 separate accounts for high throughput)
- **AWS Bedrock** (Claude and Kimi models via Amazon's cloud)
- **Moonshot Kimi** (direct API access)
- **OpenRouter** (Gemini access via third-party routing)

Each model can be tested with its own settings (context size, reasoning level, timeout).

---

### 2. Two Puzzle Formats

Supports both generations of ARC puzzles:

- **ARC-AGI-3 (Interactive)**: The AI navigates a game environment using actions like moving a cursor, selecting cells, and clicking. The puzzle has multiple levels to complete. The AI can see a visual screenshot of the game (optional). If it fails a level, it can reset and try again.

- **ARC-AGI-2 (Grid Tasks)**: The AI fills in a grid by setting individual cells or entire rows. It analyzes training examples to discover the pattern, builds the output grid, and submits its answer. Scoring reflects how many cells match the correct answer.

---

### 3. Parallel Execution

Tests run simultaneously at three levels to save time:

- **Multiple puzzles** run at the same time (up to 20)
- **Multiple models** test the same puzzle at the same time (all models in parallel)
- **Multiple attempts** per model run at the same time (up to 10)

For example: 5 puzzles x 4 models x 3 runs = 60 evaluations, many running simultaneously.

---

### 4. Cost Tracking and Budget Controls

Every API call is metered. The system tracks:

- Input tokens (what we send to the model)
- Output tokens (what the model responds with)
- Reasoning tokens (internal "thinking" by advanced models)
- Cached tokens (discounted repeat content)
- Dollar cost per step, per run, and per session

**Budget limits** can be set globally (total spend cap) or per-puzzle. When a limit is hit, evaluation stops gracefully instead of wasting money.

---

### 5. Crash Recovery and Resume

If an evaluation is interrupted (power failure, network issue, manual stop):

- The system automatically finds the most recent session
- Identifies which runs already finished successfully
- Skips completed work and only re-runs what's missing
- Cleans up partially-written data to avoid corruption

This means you never have to re-run expensive evaluations from scratch.

---

### 6. Graceful Shutdown

Multiple ways to stop evaluation cleanly without losing data:

- **Ctrl+C**: Stops everything after the current step finishes
- **Drop a file**: Create a `CANCEL_ALL` file in the cancel folder to stop remotely
- **Per-puzzle cancel**: Create `CANCEL_{puzzle_name}` to stop just one puzzle
- **Per-model cancel**: Create `CANCEL_{puzzle}_{model}` for even finer control
- **Drain mode**: Finish current runs but don't start new ones

All methods ensure data is saved properly before stopping.

---

### 7. Automatic Retry and Error Recovery

When an AI provider has a temporary problem (rate limits, server errors, timeouts), the system automatically retries with intelligent waiting:

- **Rate limits**: Waits until the next minute boundary (when limits typically reset) plus a small random delay to avoid thundering herd
- **Google-specific hiccups**: 30-60 second cooldown for known transient errors
- **General errors**: Exponential backoff (waits longer each retry, up to 5 minutes)

Up to 50 retries per API call before giving up.

---

### 8. Circuit Breaker

If a particular AI provider keeps failing repeatedly (10+ consecutive failures), the system temporarily stops sending it requests. After a 5-minute cooldown, it lets one test request through. If that succeeds, normal operation resumes. This prevents wasting money on a provider that's down.

---

### 9. Self-Correction Mechanism

When the AI gives an unparseable response (no valid action found):

- The invalid response is fed back to the AI with a helpful error message
- The AI sees what went wrong and can try a different approach
- The game state doesn't change (no penalty for bad formatting)
- These "skipped" steps are logged separately for analysis

This lets models learn from their mistakes within a single run.

---

### 10. Detailed Data Recording

Every step of every run is recorded in multiple formats:

| What's Saved | Format | Purpose |
|---|---|---|
| Every step | JSONL | Machine-readable step-by-step log |
| Token usage | CSV | Spreadsheet-friendly cost analysis |
| Complete trajectories | JSONL traces | Full conversation replay (prompts, responses, reasoning) |
| Run summaries | JSONL | One record per completed run with totals |
| Skipped steps | JSONL | Failed parses for debugging |
| Game metadata | JSON | Puzzle properties (size, difficulty, level count) |
| Raw API responses | JSONL (optional) | Exact provider responses for deep debugging |

---

### 11. Real-Time Event Stream

When launched in bridge mode (`--stdout-jsonl`), the harness emits a live stream of structured events that the web application can display:

- **session_start**: Evaluation began, here's what we're testing
- **run_start / run_end**: A specific model-puzzle-attempt started/finished
- **step**: The model just took an action (lightweight summary, no giant text blobs)
- **session_end**: Everything's done, here's the exit status
- **error / log**: Something noteworthy happened

This is how the TypeScript web server shows live evaluation progress to users.

---

### 12. Visualization

Automatically generates two charts after evaluation:

- **Score Over Steps**: Shows how each model's score improves (or doesn't) as it takes more actions. Includes average, minimum, and maximum across runs.
- **Score vs Cost**: Scatter plot comparing final score against total cost per run. Shows which models give the best bang for the buck.

Both use a dark theme with green accent colors.

---

### 13. Smart Context Management

AI models have limited memory (context window). The system manages this by:

- **Sliding window**: Only shows the model its N most recent conversation turns (default: 50)
- **Token budget trimming**: If the conversation still exceeds the model's capacity, drops the oldest exchanges until it fits (with a 10% safety margin)
- **Full history preservation**: The complete conversation is always saved to disk, even if the model only sees a window of it

---

### 14. Notepad / Scratchpad

Each model gets a persistent 4,000-character notepad that persists across steps within a run. The model can write notes to itself (strategies, observations, hypotheses) that survive even as older conversation turns scroll out of the context window. The notepad is versioned so you can see how the model's thinking evolved.

---

### 15. Prompt Caching Optimization

All providers use prompt caching to reduce costs when the same content is sent repeatedly:

- **Anthropic/Bedrock Claude**: Three strategic cache breakpoints (tool definition, system prompt, last conversation message)
- **Google Gemini**: Automatic content caching
- **OpenAI**: Automatic prefix caching

The system carefully tracks cached vs. non-cached tokens to ensure accurate cost calculations.

---

### 16. Configuration Flexibility

Three ways to configure evaluations, from quick to thorough:

- **Command-line flags**: Quick overrides for single runs (`--runs 5 --max-steps 100`)
- **TOML config file**: Saved configurations for repeatable experiments
- **Smart merging**: CLI flags override TOML values, TOML overrides defaults

---

### 17. Dry Run Mode

The `--dry-run` flag validates everything (configuration, game discovery, model setup) without making any API calls. Useful for checking that an expensive evaluation is set up correctly before spending money.

---

### 18. Game Discovery

Automatically scans puzzle environment directories to find available games. Handles:

- Multiple game versions (picks the latest)
- Mixed ARC-2 and ARC-3 puzzles
- Filtering by game type or specific IDs
- Caching for fast repeated lookups

---

### 19. Per-Model Scoring

Each puzzle type has its own scoring:

- **ARC-3**: Score = levels completed / total levels (0 to 100%)
- **ARC-2**: Score = correct cells / total cells (0 to 100%, continuous)

Scores are tracked at every step so you can see the model's progress over time, not just its final answer.

---

### 20. Comprehensive Test Suite

~3,500 lines of automated tests covering:

- Resume and crash recovery (corrupt data, partial writes, concurrent access)
- Parallel execution correctness (thread safety, no data corruption)
- Budget tracking (edge cases: negative costs, NaN, concurrent writes)
- Circuit breaker state transitions
- Cancellation system (file-based signals, race conditions)
- Full integration pipeline (run, interrupt, resume, verify)

---

### 21. Data Integrity Safeguards

- **Atomic file writes**: Uses temp files + rename to prevent corruption during crashes
- **Thread-safe I/O**: All file writes go through locks to prevent interleaving
- **Strict JSON serialization**: Rejects unknown types instead of silently converting
- **Run ID tracking**: Each execution gets a unique ID to prevent data mixing during resume

---

### 22. Cost Estimation Tool

A standalone calculator that estimates costs before running evaluations. Input the model and expected token counts, get an itemized breakdown of input, output, reasoning, and caching costs. Helps plan budgets for large-scale evaluations.

---

## Summary Statistics

| Metric | Value |
|---|---|
| Production code | ~8,900 lines |
| Test code | ~4,200 lines |
| Total | ~13,100 lines |
| AI providers supported | 6 (8 provider backends) |
| Model configurations | 18 |
| Puzzle formats | 2 (ARC-AGI-2 grid, ARC-AGI-3 interactive) |
| Output formats | JSONL, CSV, JSON, PNG charts |
| Python version required | 3.11+ |
| External dependencies | 9 packages |

---

*For technical details, API-level documentation, data schemas, and implementation specifics, see [FEATURE_SPEC.md](./FEATURE_SPEC.md).*
