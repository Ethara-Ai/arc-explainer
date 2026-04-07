# ARC Evaluation Platform

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture](#architecture)
3. [TS Eval Harness CLI](#ts-eval-harness-cli)
4. [Cancel Sentinels](#cancel-sentinels)
5. [JSONL Event Protocol](#jsonl-event-protocol)
6. [Dashboard &amp; Web UI](#dashboard--web-ui)
7. [API Reference](#api-reference)
8. [Game System](#game-system)
9. [Provider System](#provider-system)
10. [Token Optimization &amp; Cost Control](#token-optimization--cost-control)
11. [Configuration](#configuration)
12. [Project Structure](#project-structure)
13. [Output Files &amp; Trace Format](#output-files--trace-format)
14. [Testing](#testing)
15. [Troubleshooting](#troubleshooting)
16. [Development](#development)
17. [Extension Guide](#extension-guide)

---

## Quick Start

### Prerequisites

| Dependency | Version | Verify                |
| ---------- | ------- | --------------------- |
| Node.js    | 20+     | `node -v`           |
| Python     | 3.11+   | `python3 --version` |
| PostgreSQL | 14+     | `psql --version`    |
| pip        | latest  | `pip --version`     |
| Git        | 2.x+    | `git --version`     |

### Setup

```bash
git clone https://github.com/ethara-ai/arc-explainer.git
cd arc-explainer

# 1. Initialize puzzle-environments submodule
git submodule update --init puzzle-environments

# 2. Install Node dependencies
npm install

# 3. Create Python virtual environment and install dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 4. Verify key packages are installed
python3 -c "import arcengine; print('arcengine OK')"
python3 -c "import litellm; print('litellm OK')"

# 5. Create database and configure environment
createdb arc_explainer  # or use your preferred method
cp .env.example .env
# Edit .env: set DATABASE_URL and at least one AI provider key (see Configuration section)

# 6. Apply database schema
npm run db:push

# 7. Start dev server
npm run dev
```

The dev server starts two processes:

- **Express API** on the port defined by `PORT` env var (default 3000)
- **Vite dev server** on http://localhost:5173 (frontend with HMR)

### First Eval Run

```bash
# List available games
npm run eval -- --list-games

# List available models (shows which have API keys configured)
npm run eval -- --list-models

# Run a single model on one game
npm run eval -- --game ct01 --models gpt-5.4-thinking --runs 3

# Dry run (validate config without API calls)
npm run eval -- --dry-run --game ct01 --models gpt-5.4-thinking

# Or use the dashboard: navigate to http://localhost:5173/eval
```

> **Note**: `--game` and `--models` accept space-separated values, not comma-separated.

---

## Architecture

```
React Frontend (Vite + TanStack Query)
  ├─ EvalOverview / TrajectoryViewer / Charts
  └─ SSE client (live step/run/session events)
         ↓ HTTP + SSE
Express Backend (TypeScript)
  ├─ evalController  →  evalService  →  EvalOrchestrator (TypeScript)
  ├─ SSEStreamManager (event buffering, heartbeat)
  ├─ EvalRepository (PostgreSQL via Drizzle ORM)
  └─ Shared providers + config
         ↓ EvalRunner calls providers directly (TypeScript)
         ↓ GameBridge spawns Python subprocess (one per game)
LLM Providers (TypeScript SDKs)          Python Game Engine (arcengine)
  ├─ OpenAI (Responses API)               ├─ reset()
  ├─ Gemini (Google GenAI SDK)             ├─ step(action) → frame + score
  ├─ Anthropic (native SDK)                ├─ getScore()
  ├─ Cloud providers (Claude, Kimi)        └─ renderText() / renderPngBase64()
  ├─ OpenRouter
  └─ LiteLLM (proxy + SDK)
```

### Eval Pipeline

```
POST /api/eval/start (or CLI: npm run eval)
  ↓
EvalOrchestrator (TypeScript)
  ├─ Validates config + API keys (fails fast before any LLM calls)
  ├─ Generates task cross-product: models × games × runs
  ├─ Executes tasks with per-provider concurrency limits
  │   └─ EvalRunner (one per model-game-run combination)
  │       ├─ 1. Build system prompt (cached across steps)
  │       ├─ 2. Create ContextManager (sliding window) + Notepad (persistent)
  │       ├─ 3. Reset game via GameBridge → Python arcengine subprocess
  │       ├─ 4. Step loop (up to maxSteps):
  │       │     ├─ Observe: get grid state + available actions from game
  │       │     ├─ Build turn prompt (observation + actions + notepad)
  │       │     ├─ Call LLM provider (TypeScript SDK) → action + reasoning
  │       │     ├─ Execute action in game → new state + score
  │       │     ├─ Record step (JSONL trace + SSE event + PostgreSQL)
  │       │     └─ Repeat until game won, game over, or max steps
  │       └─ 5. Build RunRecord with final score, cost, token counts
  ├─ Aggregates results per model-game combination
  ├─ Emits SSE events: session_start → run_start → step → run_end → model_done → session_end
  └─ Returns SessionResult
```

---

## TS Eval Harness CLI

### Entry Point

```bash
npm run eval -- [options]
```

Source: `server/services/eval/runner/index.ts`

### Game & Model Selection

| Flag         | Value                   | Default        | Description                                           |
| ------------ | ----------------------- | -------------- | ----------------------------------------------------- |
| `--game`   | `<id...>` or `all`  | *(required)* | Game IDs to evaluate. Space-separated for multiple.   |
| `--models` | `<key...>` or `all` | `all`        | Model keys to evaluate. Space-separated for multiple. |

### Execution Configuration

| Flag                 | Value   | Default | Description                             |
| -------------------- | ------- | ------- | --------------------------------------- |
| `--runs`           | `<n>` | `3`   | Runs per model-game pair                |
| `--max-steps`      | `<n>` | `200` | Max steps allowed per run               |
| `--context-window` | `<n>` | `50`  | Conversation turns visible to the model |
| `--seed`           | `<n>` | `42`  | Base random seed for reproducibility    |

### Output Configuration

| Flag                   | Value         | Default               | Description                                    |
| ---------------------- | ------------- | --------------------- | ---------------------------------------------- |
| `--output-dir`       | `<path>`    | `data/puzzle-evals` | Directory to save results                      |
| `--jsonl`            | *(boolean)* | `false`             | Emit JSONL events to stdout instead of console |
| `--verbose` / `-v` | *(boolean)* | `false`             | Enable verbose step-by-step logging            |

### Budget & Cost Control

| Flag                  | Value     | Default   | Description                              |
| --------------------- | --------- | --------- | ---------------------------------------- |
| `--budget-global`   | `<usd>` | unlimited | Global USD budget cap for entire session |
| `--budget-per-game` | `<usd>` | unlimited | Per-game USD budget cap                  |

### Parallelization

| Flag                 | Value         | Default   | Range | Description                               |
| -------------------- | ------------- | --------- | ----- | ----------------------------------------- |
| `--parallel-games` | `<n>`       | `1`     | 1–20 | Games to run concurrently                 |
| `--parallel-runs`  | `<n>`       | `1`     | 1–10 | Runs per model to run concurrently        |
| `--sequential`     | *(boolean)* | `false` | —    | Run models sequentially (not in parallel) |

### Circuit Breaker (Fault Tolerance)

| Flag                    | Value     | Default | Description                                 |
| ----------------------- | --------- | ------- | ------------------------------------------- |
| `--circuit-threshold` | `<n>`   | `10`  | Consecutive failures to trip the breaker    |
| `--circuit-half-open` | `<sec>` | `300` | Seconds before retrying after breaker trips |

### Advanced Options

| Flag              | Value         | Default                  | Description                              |
| ----------------- | ------------- | ------------------------ | ---------------------------------------- |
| `--dry-run`     | *(boolean)* | `false`                | Validate config without making API calls |
| `--with-images` | *(boolean)* | `false`                | Include PNG screenshots in prompts       |
| `--game-dir`    | `<path>`    | `puzzle-environments/` | Override game discovery directory        |

### Information Commands

These print information and exit immediately:

| Flag              | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `--list-models` | List all available models with key, name, and provider |
| `--list-games`  | List all discovered ARC-AGI-3 games                    |

### Default Configuration Reference

From `DEFAULT_EVAL_CONFIG` in `shared/config/llmConfig.ts`:

| Parameter                 | Default                   | Description                          |
| ------------------------- | ------------------------- | ------------------------------------ |
| `maxSteps`              | `200`                   | Max steps per run                    |
| `numRuns`               | `3`                     | Runs per model-game pair             |
| `contextWindow`         | `50`                    | Visible conversation turns           |
| `seedBase`              | `42`                    | Base random seed                     |
| `outputDir`             | `data/puzzle-evals`     | Result output directory              |
| `dryRun`                | `false`                 | Skip API calls                       |
| `retryAttempts`         | `10`                    | Retry attempts on failure            |
| `retryBackoffBase`      | `1.5`                   | Exponential backoff base             |
| `retryMaxWait`          | `60.0`                  | Max wait between retries (sec)       |
| `maxConsecutiveSkips`   | `10`                    | Max consecutive skip actions         |
| `saveRawResponses`      | `true`                  | Save raw model responses             |
| `tokenBudget`           | `0`                     | Token budget (0 = unlimited)         |
| `providerMaxConcurrent` | `{ "litellm-sdk": 16 }` | Max concurrent requests per provider |

### CLI Usage Examples

```bash
# Run a single game with all models
npm run eval -- --game ct01

# Run specific games with a specific model, 5 runs each
npm run eval -- --game ct01 ct03 bw01 --models gpt-5.4-thinking --runs 5

# Dry-run to validate config (no API calls)
npm run eval -- --game all --dry-run

# Parallel execution: 4 games concurrently, 3 runs per model concurrently
npm run eval -- --game all --parallel-games 4 --parallel-runs 3

# Run with a $50 global budget cap and verbose output
npm run eval -- --game all --budget-global 50.00 --verbose

# Pipe JSONL events for programmatic consumption
npm run eval -- --game bb01 --models claude-opus --jsonl > eval.jsonl

# Custom output directory with images enabled
npm run eval -- --game ct01 --output-dir /tmp/eval-run --with-images

# Run models sequentially with custom seed
npm run eval -- --game bb01 --sequential --seed 99

# Budget per game with custom step limit
npm run eval -- --game all --budget-per-game 5.00 --max-steps 100

# Quick test: limit to 10 steps per run (validates setup)
npm run eval -- --game ct01 --models gpt-5.4-thinking --runs 1 --max-steps 10
```

---

## Cancel Sentinels

Create sentinel files in `{output-dir}/cancel/` to control a running session:

| Sentinel File                  | Effect                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `CANCEL_ALL`                 | Stop everything immediately                                      |
| `DRAIN`                      | Finish in-progress games, skip new ones                          |
| `CANCEL_{gameId}`            | Cancel a specific game (e.g.,`CANCEL_bb01`)                    |
| `CANCEL_{gameId}_{modelKey}` | Cancel a specific model on a game (e.g.,`CANCEL_bb01_gpt-5.4`) |

```bash
# Example: cancel everything
touch data/puzzle-evals/cancel/CANCEL_ALL
```

---

## JSONL Event Protocol

When using `--jsonl`, events are emitted to stdout as newline-delimited JSON. The TypeScript service also emits these as SSE events (prefixed with `eval.`).

### Event Types

#### session_start

```json
{
  "type": "session_start",
  "session_id": "eval_20260306_143000",
  "games": ["cc01"],
  "models": ["gpt-5.4-thinking", "claude-opus"],
  "num_runs": 3,
  "max_steps": 200,
  "seed_base": 42,
  "total_runs_planned": 6
}
```

#### run_start

```json
{
  "type": "run_start",
  "run_id": "GPT 5.4 Thinking_cc01_run1",
  "model": "GPT 5.4 Thinking",
  "game_id": "cc01",
  "game_type": "arc3",
  "run_number": 1,
  "seed": 42,
  "total_levels": 5
}
```

#### step

```json
{
  "type": "step",
  "run_id": "GPT 5.4 Thinking_cc01_run1",
  "step": 0,
  "action": "RIGHT",
  "score": 0.0,
  "level": 1,
  "total_levels": 5,
  "done": false,
  "state": "IN_PROGRESS",
  "cumulative_cost_usd": 0.0012,
  "input_tokens": 1523,
  "output_tokens": 87,
  "cost_usd": 0.0012,
  "notepad_length": 0
}
```

#### run_end

```json
{
  "type": "run_end",
  "run_id": "GPT 5.4 Thinking_cc01_run1",
  "model": "GPT 5.4 Thinking",
  "game_id": "cc01",
  "final_score": 0.8,
  "solved": false,
  "total_steps": 47,
  "cost_usd": 0.0891,
  "elapsed_seconds": 142.3,
  "levels_completed": 4,
  "total_levels": 5,
  "total_input_tokens": 72340,
  "total_output_tokens": 4120,
  "total_reasoning_tokens": 0
}
```

#### model_done

```json
{
  "type": "model_done",
  "model": "GPT 5.4 Thinking",
  "game_id": "cc01",
  "avg_score_pct": 60.0,
  "solved_count": 1,
  "total_runs": 3
}
```

#### session_end

```json
{
  "type": "session_end",
  "session_id": "eval_20260306_143000",
  "total_runs": 6,
  "total_steps": 423,
  "total_cost_usd": 0.8934,
  "elapsed_seconds": 1423.5
}
```

#### error

```json
{
  "type": "error",
  "run_id": "GPT 5.4 Thinking_cc01_run3",
  "step": 15,
  "code": "PROVIDER_ERROR",
  "message": "API rate limit exceeded"
}
```

#### log

```json
{"type": "log", "level": "info", "message": "Starting game: cc01"}
```

---

## Dashboard & Web UI

### Routes

| Route                       | Page             | Description                                                    |
| --------------------------- | ---------------- | -------------------------------------------------------------- |
| `/eval`                   | EvalOverview     | Main eval dashboard with session list, launch form, and charts |
| `/eval/run`               | EvalRunPage      | Detailed run view                                              |
| `/eval/trajectory/:runId` | TrajectoryViewer | Step-by-step trajectory replay for a single run                |

### EvalOverview Features

- **Launch form**: Select games, models, configure runs/steps/seed, start evaluation
- **Live progress cards**: Color-coded per model, shows step count, run count, latest score, status badge
- **Score over Steps chart**: Line chart with mean + min/max confidence bands per model
- **Score vs Cost chart**: Scatter chart, one dot per run, colored by model
- **Run history table**: Filterable by session, game, and model
- **Session selector**: Switch between current and past sessions

### Hooks

| Hook                    | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `useEvalProgress`     | SSE streaming — tracks per-model status, accumulates live step/run events    |
| `useEvalRuns`         | TanStack Query hooks for sessions, runs, steps, games, start/cancel mutations |
| `useArc2EvalProgress` | ARC2-specific eval progress tracking                                          |

---

## API Reference

### Eval Endpoints

| Method   | Path                            | Description                                                                                                                                                             |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/eval/start`             | Start evaluation session. Body:`{ gameIds, modelKeys, numRuns, maxSteps, seedBase, contextWindow, withImages }`                                                       |
| `GET`  | `/api/eval/stream/:sessionId` | SSE stream. Events:`eval.session_start`, `eval.run_start`, `eval.step`, `eval.run_end`, `eval.model_done`, `eval.session_end`, `eval.error`, `eval.log` |
| `POST` | `/api/eval/cancel/:sessionId` | Cancel a running evaluation                                                                                                                                             |
| `GET`  | `/api/eval/sessions`          | List past eval sessions (paginated:`?limit=20&offset=0`)                                                                                                              |
| `GET`  | `/api/eval/runs`              | List runs with optional filters:`?sessionId=&gameId=&model=`                                                                                                          |
| `GET`  | `/api/eval/runs/:runId/steps` | Step-by-step data for a run                                                                                                                                             |
| `GET`  | `/api/eval/games`             | List available games                                                                                                                                                    |
| `GET`  | `/api/eval/models`            | List available models                                                                                                                                                   |

### SSE Event Conventions

- Namespace: `eval.{type}` (e.g., `eval.step`, `eval.run_end`)
- Field naming: `snake_case` (e.g., `run_id`, `cost_usd`, `game_type`)
- Heartbeat: every 15 seconds (SSE comment)
- Late-connecting clients receive buffered events

### Other Platform Endpoints

| Path              | Description                              |
| ----------------- | ---------------------------------------- |
| `/api/puzzle/*` | Puzzle browser and AI analysis           |
| `/api/arc3/*`   | ARC3 game playground                     |
| `/api/models/*` | Model management                         |
| `/api/stream/*` | Streaming analysis                       |
| `/api/config`   | Environment-aware frontend configuration |
| `/api/health`   | Health check                             |

---

## Game System

ARC-AGI-3 games run via the `arcengine` Python package. The TypeScript `GameBridge` spawns a Python subprocess per game and communicates via JSON-line protocol over stdin/stdout.

### Game Discovery

Games are discovered from `puzzle-environments/ARC-AGI-3/environment_files/`. Each game directory contains a `metadata.json` with game info.

```bash
# List all available games
npm run eval -- --list-games
```

### Actions

| Action                                | Description                  |
| ------------------------------------- | ---------------------------- |
| `UP`, `DOWN`, `LEFT`, `RIGHT` | Directional movement         |
| `SELECT`                            | Select current cell          |
| `RESET`                             | Reset to current level start |
| `CLICK x y`                         | Click at coordinates (x, y)  |
| `ACTION7`                           | Game-specific action         |

### Scoring

- Score = `levels_completed / total_levels` (0.0–1.0)
- A run is `solved` when the agent completes all levels (score = 1.0)
- `GAME_OVER` is **not terminal** — the agent can `RESET` to retry the current level

### GameAdapter Interface

```typescript
interface GameAdapter {
  gameId: string;
  gameType: "arc3";
  title: string;
  reset(): Promise<void>;
  step(action: string): Promise<void>;
  getScore(): number;
  getState(): "NOT_PLAYED" | "IN_PROGRESS" | "WIN" | "GAME_OVER";
  isDone(): boolean;
  getAvailableActions(): string[];
  renderText(): string;
  renderPngBase64(): string | null;
  level: number | null;
  totalLevels: number | null;
  metadata: Record<string, unknown>;
}
```

---

## Provider System

All LLM providers are implemented in TypeScript under `shared/providers/`. Model registry is in `shared/config/llmConfig.ts`. All models are routed through the LiteLLM SDK provider, which handles provider-specific API differences.

### Available Models

| Model Key               | Model           | Notes                                          |
| ----------------------- | --------------- | ---------------------------------------------- |
| `claude-opus`         | Claude Opus 4.6 | Thinking enabled, 1M context window            |
| `kimi-k2.5`           | Kimi K2.5       | Vision-capable, 256K context window            |
| `gemini-3.1-standard` | Gemini 3.1 Pro  | Thinking enabled, 1M context window            |
| `gpt-5.4-thinking`    | ChatGPT 5.4     | `reasoning_effort="high"`, 1M context window |

All eval models use the `litellm-sdk` provider, configured via environment variables for model IDs and routing.

### Adding a New Model

```typescript
// In MODEL_REGISTRY (shared/config/llmConfig.ts):
'my-new-model': {
  name: 'My New Model',
  modelId: 'provider-specific-model-id',
  provider: 'litellm-sdk',
  envKey: 'MY_MODEL_API_KEY',
  litellmModel: 'litellm/routing-string',
  maxContextTokens: 128_000,
  maxOutputTokens: 8192,
  enableThinking: true,
  providerHint: 'openai',
},
```

Then configure the corresponding environment variables for model ID and LiteLLM routing string.

---

## Token Optimization & Cost Control

### Four Layers of Optimization

| Layer                            | Implementation                              | Details                                                                                                               |
| -------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Sliding context window** | `contextManager.ts`                       | Only the last N turns (default 50) are sent to the LLM. Full history preserved for logging.                           |
| **Token-budget trimming**  | `contextManager.getContextWithinBudget()` | Drops oldest turn pairs when approaching model's token limit. Uses 90% safety factor. (Only for Kimi)                 |
| **Persistent notepad**     | `notepad.ts`                              | 8000-char scratchpad that survives across turns even when old conversation is trimmed. Model can update it each step. |
| **System prompt caching**  | `promptBuilder.ts`                        | System prompt is computed once per (gameType, maxSteps, contextWindow, withImages) tuple and reused across all steps. |

### Cost & Safety Features

| Feature                        | File                                          | Behavior                                                                                                  |
| ------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Token pricing**        | `shared/providers/pricing.ts`               | Per-model rates with long-context tiering and prompt caching discounts                                    |
| **Budget tracker**       | `shared/utils/budget.ts`                    | Tracks global + per-game USD spend. Eval stops when limit exceeded.                                       |
| **Circuit breaker**      | `shared/utils/circuitBreaker.ts`            | Trips after N consecutive provider failures (default 10). Half-open probe after 300s. Per-provider state. |
| **Retry with backoff**   | `DEFAULT_EVAL_CONFIG`                       | Up to 10 retries, 1.5x exponential backoff, 60s max wait                                                  |
| **Provider concurrency** | `DEFAULT_EVAL_CONFIG.providerMaxConcurrent` | Per-provider limits (e.g.,`litellm-sdk: 16`)                                                            |
| **Abort controller**     | `evalRunner.ts`                             | Graceful run cancellation via `POST /api/eval/cancel/:sessionId`                                        |

### Reproducibility

Each run gets a deterministic seed: `seedBase + runIndex`. With the same seed, model, game, and prompt configuration, the game will produce identical initial states. LLM responses may still vary due to model non-determinism.

---

### tmux (Recommended for Long Eval Runs)

```bash
brew install tmux

# Start a new session
tmux new -s eval

# Run eval inside tmux, then detach with Ctrl+b d
npm run eval -- --game all --models all --parallel-games 3

# Reattach later
tmux attach -t eval
```

---

## Project Structure

```
arc-explainer/
├── client/src/
│   ├── pages/
│   │   ├── EvalOverview.tsx              # Main eval dashboard
│   │   ├── EvalRunPage.tsx               # Detailed run view
│   │   ├── TrajectoryViewer.tsx          # Step-by-step replay
│   │   ├── ARC3AgentSdkPlayground.tsx    # AgentSDK playground
│   │   └── PuzzleEvalDashboard.tsx       # Legacy dashboard
│   ├── hooks/
│   │   ├── useEvalProgress.ts            # SSE streaming + per-model tracking
│   │   ├── useEvalRuns.ts                # TanStack Query hooks for sessions/runs/steps
│   │   ├── useMultiAgentStream.ts        # Multi-agent SSE streaming
│   │   └── useArc2EvalProgress.ts        # ARC2-specific progress
│   └── components/
│       └── puzzle-eval/
│           ├── EvalCharts.tsx            # Chart container
│           ├── EvalRunCard.tsx           # Per-run card component
│           ├── ScoreOverStepsChart.tsx   # Score vs steps line chart
│           └── ScoreVsCostChart.tsx      # Score vs cost scatter chart
├── server/
│   ├── services/
│   │   ├── eval/
│   │   │   ├── evalOrchestrator.ts       # Multi-model orchestration + concurrency
│   │   │   ├── cancelWatcher.ts          # Sentinel file watcher
│   │   │   ├── compositeAbort.ts         # Composite abort logic
│   │   │   ├── runner/
│   │   │   │   ├── index.ts              # CLI entry point (argument parsing)
│   │   │   │   ├── evalRunner.ts         # Single-run step loop
│   │   │   │   ├── contextManager.ts     # Sliding window + token trimming
│   │   │   │   ├── notepad.ts            # Persistent scratchpad
│   │   │   │   └── promptBuilder.ts      # System + turn prompts
│   │   │   ├── adapters/
│   │   │   │   ├── arc3GameAdapter.ts    # ARC3 game interface
│   │   │   │   ├── gameBridge.ts         # Python subprocess JSON-line bridge
│   │   │   │   └── types.ts             # Game types + discovery
│   │   │   ├── data/
│   │   │   │   └── traceWriter.ts        # JSONL trace file I/O
│   │   │   ├── config/
│   │   │   │   └── tomlConfig.ts         # TOML configuration support
│   │   │   ├── validation/
│   │   │   │   └── gameValidator.ts      # Game validation logic
│   │   │   ├── resume/                   # Resume functionality
│   │   │   ├── shutdown/                 # Shutdown logic
│   │   │   └── utils/
│   │   │       └── groupStepsByRun.ts    # Utility for grouping steps
│   │   ├── evalService.ts                # Express ↔ orchestrator bridge
│   │   └── streaming/
│   │       └── SSEStreamManager.ts       # SSE connection management
│   ├── controllers/
│   │   └── evalController.ts             # REST + SSE endpoints
│   ├── repositories/
│   │   └── EvalRepository.ts             # PostgreSQL CRUD + in-memory fallback
│   └── routes.ts
├── shared/
│   ├── providers/
│   │   ├── base.ts                       # BaseProvider interface
│   │   ├── openaiProvider.ts             # OpenAI Responses API
│   │   ├── geminiFallbackProvider.ts     # Multi-tier Gemini retry
│   │   ├── anthropicClaudeProvider.ts    # Anthropic native SDK
│   │   ├── claudeCloudProvider.ts        # Cloud-hosted Claude provider
│   │   ├── kimiCloudProvider.ts          # Cloud-hosted Kimi provider
│   │   ├── regionUtils.ts               # Cloud region utilities
│   │   ├── openrouterGeminiProvider.ts   # OpenRouter
│   │   ├── litellmSdkProvider.ts         # LiteLLM SDK provider
│   │   ├── litellmBridge.py              # LiteLLM Python bridge
│   │   ├── PythonBridgeProcess.ts        # Shared Python subprocess manager
│   │   ├── kimiProvider.ts               # Kimi direct API
│   │   └── pricing.ts                    # Token pricing + cost calculation
│   ├── config/
│   │   ├── llmConfig.ts                  # MODEL_REGISTRY + DEFAULT_EVAL_CONFIG
│   │   └── cloudModels.ts               # Cloud model definitions
│   ├── utils/
│   │   ├── budget.ts                     # Global + per-game USD budget tracker
│   │   └── circuitBreaker.ts             # Per-provider failure circuit breaker
│   ├── eval-types.ts                     # Eval domain types (StepRecord, RunRecord, etc.)
│   └── schema.ts                         # Drizzle tables (evalSessions, evalRuns, evalSteps)
├── tests/
│   └── eval/
│       ├── contextManager.test.ts        # Context manager tests
│       ├── evalRunner.test.ts            # Runner tests
│       ├── evalTypes.test.ts             # Type tests
│       ├── litellmProvider.test.ts       # LiteLLM provider tests
│       ├── notepad.test.ts               # Notepad tests
│       ├── promptBuilder.test.ts         # Prompt builder tests
│       ├── traceWriter.test.ts           # Trace writer tests
│       ├── adapters/                     # Adapter tests
│       └── harness/                      # Comprehensive harness verification
│           ├── harness_verify_all_games.ts
│           ├── harness_comprehensive_audit.ts
│           ├── harness_deep_behavioral_test.ts
│           ├── harness_deep_test.ts
│           ├── test_all_models_harness.ts
│           ├── test_new_games.py
│           └── reproduce_and_log.py
├── puzzle-environments/                  # ARC3 game environment files
├── scripts/evaluate/                     # Legacy Python eval harness
└── data/                                 # ARC-AGI datasets + eval traces
```

---

## Output Files & Trace Format

Results are organized in **timestamped session directories**. Each CLI invocation creates a new `{YYYYMMDD_HHMMSS_ffffff}/` subdirectory under the output root.

```
data/puzzle-evals/
  {timestamp}/
    logs/
      eval_{timestamp}.log         # Full DEBUG-level log
    game_metadata.json             # Delivery-schema metadata for all games
    {game_id}/
      metadata.json                # Game info (title, levels, tags)
      runs.jsonl                   # One JSON line per run (RunRecord)
      steps.jsonl                  # One JSON line per step (StepRecord)
      token_usage.csv              # Per-step token counts
      token_usage_summary.csv      # Per-run token aggregates
      traces/
        {Model_Name}_trace.jsonl   # Full debug trace per model
```

### Trace File Structure

Each trace file contains repeating groups of JSONL records:

```
Run 1:  header -> step -> step -> ... -> step -> summary
Run 2:  header -> step -> step -> ... -> step -> summary
```

**Trace steps include full data** that SSE events omit: `reasoning`, `notepad_contents`, `observation`, `game_feedback`, `image_sent`.

---

## Testing

### Unit Tests (Vitest)

```bash
npm run test             # Run all tests
npm run test:unit        # Unit tests with coverage
npm run test:frontend    # Frontend tests
npm run test:e2e         # Playwright E2E tests
```

### Harness Verification Scripts

```bash
# Basic lifecycle test (BOOTSTRAP → RESET → ACTIONS → DISPOSE)
npx tsx tests/eval/harness/harness_verify_all_games.ts

# Comprehensive audit of all games (score formula, state machine, etc.)
npx tsx tests/eval/harness/harness_comprehensive_audit.ts

# Edge-case behavioral tests (GAME_OVER, click coords, repeated resets)
npx tsx tests/eval/harness/harness_deep_behavioral_test.ts

# Deep test (rapid-fire actions, undo, triple reset, score monotonicity)
npx tsx tests/eval/harness/harness_deep_test.ts

# Python game validation
python tests/eval/harness/test_new_games.py
```

---

## Troubleshooting

| Symptom                             | Cause                                            | Fix                                                                                 |
| ----------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `API key not set: GEMINI_API_KEY` | Gemini model requires `GEMINI_API_KEY`         | Set the key in `.env`                                                             |
| Gemini 429 errors, eval stalls      | Gemini rate limits require 10-12 min cooldown    | Use the fallback provider which handles this automatically                          |
| `Unknown model: ...`              | Model key not in `MODEL_REGISTRY`              | Run `npm run eval -- --list-models` to see available keys                         |
| Python subprocess crash             | `arcengine` not installed or wrong Python      | Run `python3 -c "import arcengine"`. Needs Python 3.11+.                          |
| Database connection error           | PostgreSQL not running or `DATABASE_URL` wrong | Verify with `psql $DATABASE_URL -c "SELECT 1"`. Run `npm run db:push`.          |
| No SSE events in dashboard          | Connecting to wrong port                         | Dashboard: Vite port (5173 dev). API:`PORT` env var. Vite proxies API calls.      |
| Cost unexpectedly high              | Context window too large or too many runs        | Use `--budget-global 10.0` to cap spend. Check `--context-window` (default 50). |
| Circuit breaker tripping            | Provider returning consecutive errors            | Check API key validity. Circuit resets after 300s.                                  |
| Charts show no data                 | No session/game selected                         | Select a session and game in the dropdown filters                                   |
| In-memory fallback warnings         | PostgreSQL not connected                         | Eval data won't persist across server restarts                                      |

---

## Development

### npm Scripts

```bash
npm run dev              # Start Express + Vite dev servers
npm run eval -- [flags]  # CLI eval runner
npm run build            # Production build (Vite + esbuild)
npm run check            # TypeScript type check
npm run test             # Run tests (Vitest)
npm run db:push          # Apply Drizzle schema to database
```

### Code Style

**TypeScript**: Strict mode, ESM imports, PascalCase interfaces/types, UPPER_SNAKE_CASE constants, camelCase files. No `as any` or `@ts-ignore`.

**React/Frontend**: Functional components, hooks for state/effects, TanStack Query for server state, Wouter for routing, shadcn/ui + Tailwind.

**Python**: Python 3.11+, type hints on all signatures, f-strings only.

### Architecture Patterns

| Layer        | Pattern                                                   |
| ------------ | --------------------------------------------------------- |
| Backend      | Controller → Service → Repository                       |
| Frontend     | Pages → Hooks → Components                              |
| Eval Harness | Orchestrator → Runner → Provider + Adapter              |
| Streaming    | SSE with `eval.{type}` namespace, `snake_case` fields |

---

## Extension Guide

### Adding a New Game

1. Place game files in `puzzle-environments/ARC-AGI-3/environment_files/{game_id}/{version}/`
2. `discoverGames()` in `server/services/eval/adapters/types.ts` picks it up automatically
3. Verify: `npm run eval -- --list-games`

### Adding a New Chart

1. Create component in `client/src/components/puzzle-eval/`
2. Import in the appropriate page component
3. Bind to run/step data from hooks

### Database Schema

Three tables (`eval_sessions`, `eval_runs`, `eval_steps`) defined in `shared/schema.ts`. Run `npm run db:push` to create/update.

Scale estimate: 200 steps x 3 runs x 5 models x 50 games = 150,000 rows per full eval. Manageable for PostgreSQL.
