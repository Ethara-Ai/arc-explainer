# ARC Evaluation Harness — Complete Requirement Specification


---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [CLI Interface](#2-cli-interface)
3. [Configuration System](#3-configuration-system)
4. [Model Registry](#4-model-registry)
5. [Provider Abstraction Layer](#5-provider-abstraction-layer)
6. [Game Adapter System](#6-game-adapter-system)
7. [Game Discovery and Loading](#7-game-discovery-and-loading)
8. [Orchestration Engine](#8-orchestration-engine)
9. [Evaluation Runner (Core Step Loop)](#9-evaluation-runner-core-step-loop)
10. [Prompt Builder](#10-prompt-builder)
11. [Context Manager](#11-context-manager)
12. [Notepad (Persistent Scratchpad)](#12-notepad-persistent-scratchpad)
13. [Retry and Error Recovery](#13-retry-and-error-recovery)
14. [Budget Tracking](#14-budget-tracking)
15. [Circuit Breaker](#15-circuit-breaker)
16. [Cancellation System](#16-cancellation-system)
17. [Graceful Shutdown](#17-graceful-shutdown)
18. [Session Resume](#18-session-resume)
19. [Data Schemas and Output Formats](#19-data-schemas-and-output-formats)
20. [JSONL Streaming Mode](#20-jsonl-streaming-mode)
21. [Trace Writer](#21-trace-writer)
22. [Pricing and Cost Calculation](#22-pricing-and-cost-calculation)
23. [Visualization (Plot Results)](#23-visualization-plot-results)
24. [Utility Scripts](#24-utility-scripts)
25. [TOML Configuration File](#25-toml-configuration-file)
26. [Test Suite](#26-test-suite)
27. [Dependencies](#27-dependencies)
28. [Exit Codes](#28-exit-codes)
29. [Directory Structure and File Layout](#29-directory-structure-and-file-layout)

---

## 1. System Overview

The evaluation harness is a multi-threaded Python CLI application that evaluates large language models (LLMs) against two task types:

- **ARC-AGI-2 (Arc2):** Static grid transformation tasks. The model builds an output grid cell-by-cell using cursor-based actions, then submits. Scoring is based on cell-level correctness.
- **ARC-AGI-3 (Arc3):** Interactive game environments powered by `arcengine`. The model navigates levels using directional/click actions. Scoring is based on levels completed out of total levels.

The system supports:
- Multiple LLM providers (OpenAI, Anthropic, Google Gemini, AWS Bedrock, OpenRouter, Moonshot/Kimi)
- Parallel execution across games, models, and runs
- Cost tracking with global and per-game budgets
- Automatic retry with tiered backoff strategies
- Circuit breakers per provider
- Session resume with incomplete-run truncation
- Real-time JSONL event streaming for external consumers
- Cancellation via file-based sentinel system
- Prompt caching awareness across all providers
- Vision/image support for capable models

### High-Level Flow

```
CLI (evaluate.py)
  -> Config Resolution (CLI args + TOML merge)
  -> Game Discovery (game_loader.py)
  -> Orchestrator (orchestrator.py)
       -> ThreadPoolExecutor (games x models)
            -> Eval Runner (eval_runner.py)
                 -> Step Loop:
                      Game.reset() -> observe -> prompt_builder -> provider.choose_action() -> game.step() -> record
                 -> Retry on failure (3 tiers)
                 -> Write step/run records, CSV, traces
  -> Budget checks, circuit breaker checks per step
  -> Session resume on restart
  -> Plot results (optional, post-hoc)
```

---

## 2. CLI Interface

**Entry point:** `scripts/evaluate/evaluate.py`

### Arguments

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--game` | `str[]` | all discovered games | One or more game IDs to evaluate. If omitted, all discovered games for the specified `--game-type` are used. |
| `--models` | `str[]` | **required** | One or more model keys from the MODEL_REGISTRY. |
| `--runs` | `int` | `3` | Number of independent evaluation runs per (game, model) pair. |
| `--max-steps` | `int` | `200` | Maximum steps per run before forced termination. |
| `--context-window` | `int` | `50` | Number of recent conversation turns retained in the sliding context window. |
| `--output-dir` | `str` | `data/puzzle-evals` | Base directory for output files. A timestamped session subdirectory is created. |
| `--seed` | `int` | `42` | Base seed for reproducibility. Actual seed per run = `seed_base + run_number`. |
| `--dry-run` | `flag` | `False` | Discover and list games without executing. Prints game list and exits. |
| `--list-games` | `flag` | `False` | Same as `--dry-run`: lists games and exits. |
| `--stdout-jsonl` | `flag` | `False` | Enables JSONL streaming mode. All logging redirects to stderr. stdout emits clean, newline-delimited JSON events. |
| `--verbose` | `flag` | `False` | Enables DEBUG-level logging. |
| `--sequential` | `flag` | `False` | Forces fully sequential execution: one game at a time, one model at a time. Overrides parallel flags. |
| `--parallel-games` | `int` | `1` | Maximum games evaluated concurrently. Hard cap: 20. |
| `--parallel-runs` | `int` | `1` | Maximum runs per (game, model) pair concurrently. Hard cap: 10. |
| `--budget-global` | `float` | `None` | Global USD spending limit across all games and models. |
| `--budget-per-game` | `float` | `None` | Per-game USD spending limit. |
| `--resume` | `flag` | `False` | Boolean flag. When set, automatically discovers the most recent session directory under `--output-dir`, scans for completed runs, and resumes incomplete work. The existing session directory is **reused** (no new timestamped directory is created). |
| `--config` | `str` | `None` | Path to TOML configuration file. Values are merged with CLI args (CLI wins on conflict). |
| `--with-images` | `flag` | `False` | Send PNG image observations to vision-capable models alongside text. |
| `--game-type` | `str` | `"arc3"` | Which game type to evaluate: `"arc2"` or `"arc3"`. Determines discovery path and adapter. |
| `--limit` | `int` | `None` | Maximum number of games to evaluate (after discovery, before execution). |
| `--save-raw-responses` | `flag` | `False` | Persist full raw LLM responses in step records. |
| `--exclude` | `str[]` | `None` | Game IDs to exclude from evaluation. |
| `--game-dir` | `str` | `None` | Override default game discovery directory. |

### Execution Modes

1. **Normal mode:** Output goes to log files and stdout (human-readable).
2. **JSONL mode (`--stdout-jsonl`):** All Python logging is redirected to stderr. stdout emits structured JSONL events, one per line. A thread-safe stdout lock serializes writes. Events include `session_start`, `session_end`, and per-step/per-run events.
3. **Dry-run mode (`--dry-run` or `--list-games`):** Discovers games, prints the list, and exits with code 0.

### Signal Handling

- **SIGINT (Ctrl+C):** Sets `shutdown_event`, triggering graceful drain. Exit code 130.
- **SIGTERM:** Same behavior as SIGINT.
- Both handlers are registered at startup via `signal.signal()`.

---

## 3. Configuration System

### EvalConfig Dataclass

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_steps` | `int` | `200` | Maximum steps per run. |
| `num_runs` | `int` | `3` | Runs per (game, model) pair. |
| `context_window` | `int` | `50` | Sliding context window size (conversation turns). |
| `seed_base` | `int` | `42` | Base seed. Per-run seed = `seed_base + run_number`. |
| `retry_attempts` | `int` | `50` | Maximum retry attempts per provider call before giving up on that step. |
| `retry_backoff_base` | `float` | `1.5` | Base for exponential backoff calculation. |
| `retry_max_wait` | `float` | `300.0` | Maximum wait time (seconds) for any single retry backoff. |
| `save_raw_responses` | `bool` | `False` | Whether to persist raw LLM responses. |
| `provider_max_concurrent` | `dict` | See below | Per-provider concurrency limits. |

### Provider Concurrency Defaults

| Provider Key | Max Concurrent Requests |
|-------------|------------------------|
| `bedrock-claude` | 8 |
| `anthropic` | 10 |
| `gemini` | 12 |
| `gemini-fallback` | 12 |
| `openrouter-gemini` | 12 |
| `openai` | 16 |
| `bedrock-kimi` | 32 |

These defaults are enforced via per-provider `threading.Semaphore` instances created by the orchestrator.

### ModelConfig Dataclass

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `str` | — | Human-readable display name. |
| `model_id` | `str` | — | API model identifier string sent to the provider. |
| `provider` | `str` | — | Provider key (e.g., `"openai"`, `"anthropic"`, `"gemini"`, `"bedrock-claude"`, `"bedrock-kimi"`, `"gemini-fallback"`, `"openrouter-gemini"`, `"kimi"`). |
| `env_key` | `str` | — | Environment variable name for the API key. |
| `base_url` | `str \| None` | `None` | Override base URL for the provider SDK. |
| `supports_vision` | `bool` | `True` | Whether the model accepts image inputs. |
| `max_context_tokens` | `int` | `128_000` | Maximum context window in tokens. |
| `reasoning_effort` | `str \| None` | `None` | Provider-specific reasoning effort hint (e.g., `"high"`, `"medium"`). |
| `pricing_model_id` | `str \| None` | `None` | Override key for the PRICING table if different from `model_id`. |
| `max_output_tokens` | `int` | `8192` | Reserved output tokens (subtracted from context budget for token-aware trimming). |
| `additional_headers` | `dict[str, str] \| None` | `None` | Extra HTTP headers merged into provider requests (currently Gemini-only). |
| `timeout_ms` | `int` | `600_000` | Per-request timeout in milliseconds (600s = 10 minutes). |
| `vertexai` | `bool` | `False` | Whether this model uses Vertex AI endpoints. |
| `gcp_project` | `str \| None` | `None` | GCP project ID for Vertex AI. |
| `gcp_location` | `str` | `"us-central1"` | GCP region for Vertex AI. |

### Config Merge Priority

1. CLI arguments (highest priority)
2. TOML config file (`--config`)
3. Hardcoded defaults (lowest priority)

The merge is performed by `merge_cli_over_toml()`: for every field, the CLI value wins if it was explicitly provided; otherwise the TOML value is used; otherwise the hardcoded default applies.

---

## 4. Model Registry

The `MODEL_REGISTRY` is a dictionary mapping string keys to `ModelConfig` instances. As of the current implementation, it contains **18 entries**:

| Key | Provider | Model ID | Vision | Notes |
|-----|----------|----------|--------|-------|
| `gemini-3.1` | `gemini-fallback` | `gemini-3.1-pro-preview` | yes | Fallback tier chain |
| `gemini-3.1-studio` | `gemini` | `gemini-3.1-pro-preview` | yes | Studio tier |
| `gemini-3.1-standard` | `gemini` | `gemini-3.1-pro-preview` | yes | Vertex Standard |
| `gemini-3.1-priority` | `gemini` | `gemini-3.1-pro-preview` | yes | Vertex Priority (pricing_model_id: `gemini-3.1-pro-preview-priority`) |
| `gemini-3.1-openrouter` | `openrouter-gemini` | `google/gemini-3.1-pro-preview` | yes | OpenRouter route |
| `gpt-5.4-thinking` | `openai` | `gpt-5.4` | yes | Reasoning model (`reasoning_effort: "high"`) |
| `claude-bedrock` | `bedrock-claude` | `global.anthropic.claude-opus-4-6-v1` | yes | Bedrock Converse API |
| `kimi-bedrock` | `bedrock-kimi` | `moonshotai.kimi-k2.5` | yes | Bedrock InvokeModel API |
| `claude-bedrock-arn` | `bedrock-claude` | env `BEDROCK_CLAUDE_ARN` | yes | Cross-region ARN (pricing_model_id: `global.anthropic.claude-opus-4-6-v1`) |
| `claude-bedrock-arn2` | `bedrock-claude` | env `BEDROCK_CLAUDE_ARN_2` | yes | Second ARN slot (pricing_model_id: `global.anthropic.claude-opus-4-6-v1`) |
| `kimi-bedrock-arn` | `bedrock-kimi` | env `BEDROCK_KIMI_ARN` | yes | Kimi ARN slot (pricing_model_id: `moonshotai.kimi-k2.5`) |
| `claude-a1` through `claude-a6` | `anthropic` | `claude-opus-4-6` | yes | 6 native Anthropic slots, each with a different `env_key` (`ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, ... `ANTHROPIC_API_KEY_6`) for load distribution |

### Provider Factory

`create_provider(model_config, eval_config)` performs lazy imports and returns the appropriate provider instance:

- `"openai"` -> `OpenAIProvider`
- `"anthropic"` -> `AnthropicClaudeProvider`
- `"gemini"` -> `GeminiProvider`
- `"bedrock-claude"` -> `BedrockClaudeProvider`
- `"bedrock-kimi"` -> `BedrockKimiProvider`
- `"gemini-fallback"` -> `GeminiFallbackProvider`
- `"openrouter-gemini"` -> `OpenRouterGeminiProvider`
- `"kimi"` -> `KimiProvider`

`MODEL_COLORS` is a companion dictionary mapping model keys to hex color strings, used by the plotting system for consistent chart theming.

---

## 5. Provider Abstraction Layer

### Base Provider

All providers inherit from `BaseProvider` (ABC) and implement:

```python
def choose_action(
    self,
    system_prompt: str,
    conversation_history: list[dict],
    current_observation: str,
    valid_actions: list[str],
    notepad: str,
    image_b64: str | None = None,
) -> ProviderResponse
```

**Note**: This is a **synchronous** method (not `async`). All providers use synchronous HTTP clients internally.

### ProviderResponse Dataclass

| Field | Type | Description |
|-------|------|-------------|
| `action` | `str` | The chosen action string (must be one of `available_actions` or `"SKIP"`). |
| `reasoning` | `str` | Model's reasoning/thinking text. |
| `notepad_update` | `str \| None` | Optional new content for the persistent notepad. |
| `input_tokens` | `int` | Input tokens consumed. |
| `output_tokens` | `int` | Output tokens generated (includes reasoning tokens for some providers). |
| `reasoning_tokens` | `int` | Reasoning/thinking-specific tokens (subset of output_tokens). |
| `cost_usd` | `float` | Computed cost for this single call. |
| `raw_response` | `Any \| None` | Full raw response object (only populated if `save_raw_responses` is enabled). |
| `cached_input_tokens` | `int` | Number of input tokens served from cache. |
| `cache_write_tokens` | `int` | Number of tokens written to cache. |
| `traffic_type` | `str \| None` | Provider-reported traffic classification (e.g., Gemini's `"ON_DEMAND"`, `"PRIORITY"`). |

### Action Parsing (`_parse_action_response`)

The base provider implements a multi-stage action extraction pipeline:

1. **JSON extraction** (`_extract_json_with_action`): Brace-depth parser scans the response text for JSON objects containing an `"action"` key. Handles nested braces correctly.
2. **Regex fallback**: If JSON extraction fails, regex patterns attempt to extract action strings.
3. **SKIP sentinel**: If all extraction methods fail, the action defaults to `"SKIP"`.

### Action Matching (`_match_action`)

Once an action string is extracted, it is validated against the list of available actions using a three-tier matching strategy:

1. **Exact match**: String equality.
2. **Case-insensitive match**: Lowercased comparison.
3. **Prefix match**: The extracted string starts with one of the available actions (handles cases like `"CLICK 3 5 - clicking on cell"` matching `"CLICK"`).

If no match is found, the action becomes `"SKIP"`.

### Provider Implementations

#### 5.1 OpenAI Provider (`openai_provider.py`)

- **Reasoning models** (detected by model ID pattern): Uses the **Responses API** (`/v1/responses`) with:
  - `input` array of `{role, content}` objects
  - `reasoning.effort` from `ModelConfig.reasoning_effort`
  - Tool definition: `play_action` function with `action` string parameter and `reasoning` string parameter
  - `store: False` for stateless evaluation (no server-side conversation persistence)
- **Non-reasoning models**: Uses the **Chat Completions API** with:
  - Standard `messages` array
  - Tool calling with function definition
- **Token extraction**: `input_tokens`, `output_tokens` from usage. Cached tokens from `input_tokens_details.cached_tokens`. Reasoning tokens from `output_tokens_details.reasoning_tokens`.
- **Response serialization**: `_serialize_response()` converts the response object to a JSON-safe dict for raw response storage.

#### 5.2 Gemini Provider (`gemini_provider.py`)

- Uses the **google-genai** Python SDK.
- **Function calling**: Tool defined in Gemini's native format (`FunctionDeclaration` with parameters schema).
- **Thinking tokens**: Always enabled for Pro models. `thoughts_token_count` is tracked and added to `output_tokens`.
- **Implicit caching**: Gemini automatically caches repeated prompt prefixes. `cached_content_token_count` extracted from usage metadata.
- **Traffic type**: Extracted from response metadata (e.g., `"ON_DEMAND"`, `"SERVED_FROM_CACHE"`).
- **Vertex AI support**: When `ModelConfig.vertexai = True`, patches the endpoint URL with `api_version = 'v1/publishers/google'` for priority tier routing via GCP project/location.

#### 5.3 Anthropic Claude Provider (Native) (`anthropic_claude_provider.py`)

- Uses the **Anthropic Messages API** directly.
- **Prompt caching**: 3 cache breakpoints strategically placed:
  1. Tool definition block (stable across all turns)
  2. System prompt (stable across all turns)
  3. Last message in conversation history (sliding window edge)
- **Adaptive thinking**: Enabled with `interleaved-thinking-2025-05-14` beta flag. `thinking.type = "enabled"`, `thinking.budget_tokens` calculated from model's max output.
- **Tool choice**: Set to `"auto"` (required when thinking is enabled).
- **Load distribution**: 6 separate API key environment variables (`ANTHROPIC_API_KEY` through `ANTHROPIC_API_KEY_6`) allow distributing load across multiple Anthropic accounts.
- **Token extraction**: `cache_read_input_tokens` and `cache_creation_input_tokens` from usage metadata.

#### 5.4 Bedrock Claude Provider (`bedrock_claude_provider.py`)

- **HTTP REST** to AWS Bedrock **Converse API** endpoint.
- **Authentication**: Bearer token from `boto3` STS/session credentials.
- **Prompt caching**: 3 `cachePoint` breakpoints (same strategy as native Anthropic):
  1. Tool config block
  2. System prompt
  3. Last conversation message
- **Adaptive thinking**: Same interleaved thinking beta as native.
- **Token extraction**: `cacheReadInputTokenCount` and `cacheWriteInputTokenCount` from Bedrock usage response.

#### 5.5 Bedrock Kimi Provider (`bedrock_kimi_provider.py`)

- **HTTP REST** to AWS Bedrock **InvokeModel API** (NOT Converse — Converse does not support images for Kimi).
- **Payload format**: OpenAI Chat Completions format (`messages` array with `role`/`content`).
- **No prompt caching**: Kimi on Bedrock does not support caching.
- **Image support**: Base64 images embedded directly in message content.

#### 5.6 Gemini Fallback Provider (`gemini_fallback_provider.py`)

- Wraps multiple Gemini tier providers and tries them in order:
  1. **Studio** (free/low-cost tier)
  2. **Vertex Standard** (paid tier)
  3. **Vertex Priority** (guaranteed capacity)
- **Retry logic**: `_is_retriable()` inspects HTTP status codes. Retriable errors (429, 500, 503, 504) cause immediate fallback to the next tier. Non-retriable errors bubble up immediately.
- Each tier is a fully configured `GeminiProvider` instance.

#### 5.7 OpenRouter Gemini Provider (`openrouter_gemini_provider.py`)

- Subclass of `OpenAIProvider`.
- Routes requests through the **OpenRouter API** (`https://openrouter.ai/api/v1`).
- Overrides `model_id` to use OpenRouter's model naming format (e.g., `google/gemini-2.5-pro`).

#### 5.8 Kimi Provider (`kimi_provider.py`)

- Subclass of `OpenAIProvider`.
- Routes requests through the **Moonshot API** (`https://api.moonshot.cn/v1`).

#### 5.9 Bedrock Utilities (`bedrock_utils.py`)

- `extract_arn_region(arn: str) -> str`: Extracts the AWS region from a Bedrock model ARN string (e.g., `arn:aws:bedrock:us-east-1:...` -> `"us-east-1"`).
- Used by Bedrock providers to determine the correct regional endpoint for API calls.

---

## 6. Game Adapter System

### BaseGameAdapter (ABC)

All game types implement this interface:

| Method/Property | Return Type | Description |
|----------------|-------------|-------------|
| `game_id` | `str` | Unique identifier for the game/task. |
| `game_type` | `str` | Either `"arc2"` or `"arc3"`. |
| `title` | `str` | Human-readable title. |
| `reset()` | `None` | Reset game to initial state. |
| `step(action: str)` | `str` | Execute an action, return text feedback. |
| `get_score()` | `float` | Current score (0.0 to 1.0). |
| `get_state()` | `dict` | Current game state dictionary. |
| `is_done()` | `bool` | Whether the game has reached a terminal state. |
| `get_available_actions()` | `list[str]` | List of valid action strings for the current state. |
| `render_text()` | `str` | Text representation of current game state. |
| `render_png_base64()` | `str \| None` | Base64-encoded PNG of current game state (if supported). |
| `level` | `int` | Current level (Arc3) or 0 (Arc2). |
| `total_levels` | `int` | Total levels in game (Arc3) or 1 (Arc2). |
| `levels_completed` | `int` | Number of levels completed. |
| `metadata` | `dict` | Game-specific metadata dictionary. |

### Arc3GameAdapter

Wraps an `arcengine.ARCBaseGame` instance.

**Available Actions:**
- `RESET` — Reset the game to level 1. Note: **GAME_OVER is NOT terminal**. The model can issue RESET after a GAME_OVER to start again.
- `UP`, `DOWN`, `LEFT`, `RIGHT` — Directional movement.
- `SELECT` — Select/interact with current cell.
- `CLICK x y` — Click at specific grid coordinates (parameterized action).
- `ACTION7` — Game-specific seventh action.

**Scoring:** `score = levels_completed / total_levels`

**Image Rendering:**
- 16-color palette mapping integer cell values to RGB tuples.
- NumPy array -> PIL Image conversion with scale factor 6 (each cell = 6x6 pixels).
- Output: base64-encoded PNG string.

**Feedback Capture:** Game feedback is captured by temporarily redirecting `sys.stdout` during `game.step()`.

### Arc2TaskAdapter

Wraps a JSON ARC-AGI-2 task file as an interactive grid-building environment.

**Available Actions:**
- `SET_CELL <color>` — Set the cell at cursor position to the given color (0-9). Cursor auto-advances to the next column (wraps to next row at end).
- `SET_ROW <c1> <c2> ... <cn>` — Set an entire row of cells at once.
- `MOVE_UP`, `MOVE_DOWN`, `MOVE_LEFT`, `MOVE_RIGHT` — Move cursor position.
- `SUBMIT` — Submit the current grid for scoring.
- `RESET_GRID` — Clear the output grid and reset cursor to (0, 0).

**Scoring:** `score = correct_cells / total_cells` (computed against ground-truth output grid).

**Color Palette:** Values 0-9, each mapped to a named color for display.

**Training Text:** The adapter renders all training input-output pairs as text on first call, then caches the result (`_cached_training_text`) for subsequent renders.

---

## 7. Game Discovery and Loading

### Discovery Paths

| Game Type | Base Path | Notes |
|-----------|-----------|-------|
| Arc3 | `puzzle-environments/ARC-AGI-3/environment_files/` | Handles version subdirectories (walks into child dirs that contain Python game modules) |
| Arc2 | `puzzle-environments/ARC-AGI-2/enviornment_files/` | **Typo is intentional and load-bearing** — the upstream dataset has this misspelling |

### Discovery Logic

1. `discover_games(game_type, game_dir_override)` scans the appropriate base path.
2. For Arc3: Each Python file in the environment directory (or version subdirectories) is a game module. The module is imported, and the game class (subclass of `ARCBaseGame`) is extracted.
3. For Arc2: Each JSON file is a task definition containing training and test pairs.
4. Results are cached via `@lru_cache` on the discovery function.

### Module Class Cache (Arc3)

`_MODULE_CLASS_CACHE` is a module-level dictionary that caches imported game classes by file path, avoiding redundant `importlib` calls for the same game module.

### Metadata

`build_metadata(game_adapter)` extracts basic metadata (game_id, game_type, title, total_levels).

`build_delivery_metadata(game_adapter)` returns a 12-field schema used for the `game_metadata.json` file written at session startup:

| Field | Description |
|-------|-------------|
| `game_id` | Unique identifier |
| `game_type` | `"arc2"` or `"arc3"` |
| `title` | Human-readable title |
| `total_levels` | Number of levels/test cases |
| `available_actions` | List of action strings |
| `grid_width` | Grid width (if applicable) |
| `grid_height` | Grid height (if applicable) |
| `num_training_pairs` | Number of training examples (Arc2) |
| `num_test_pairs` | Number of test cases (Arc2) |
| `has_image_support` | Whether PNG rendering is available |
| `version` | Game version string |
| `source_path` | File system path to the game source |

---

## 8. Orchestration Engine

### OrchestratorConfig Dataclass (frozen)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallel_games` | `int` | `1` | Max concurrent games (1=sequential, hard cap 20). |
| `budget_global_usd` | `float \| None` | `None` | Global USD spending limit. |
| `budget_per_game_usd` | `float \| None` | `None` | Per-game USD spending limit. |
| `circuit_threshold` | `int` | `10` | Consecutive failures before opening circuit breaker. |
| `circuit_half_open_seconds` | `float` | `300.0` | Seconds before circuit breaker transitions from OPEN to HALF-OPEN. |
| `sequential_models` | `bool` | `False` | Run models sequentially within a game (instead of parallel). |
| `parallel_runs` | `int` | `1` | Max concurrent runs within a (game, model) pair. |
| `resume_completed` | `tuple[tuple[tuple[str, str], tuple[int, ...]], ...]` | `()` | Mapping of `(game_id, safe_model_name)` to tuples of completed 1-indexed run numbers. Stored as tuple-of-tuples for frozen dataclass compatibility. |
| `cancel_sentinel_dir` | `Path \| None` | `None` | Directory to watch for cancellation sentinel files. |
| `with_images` | `bool` | `False` | Whether to send PNG image observations to vision-capable models. |

### Execution Architecture

```
run_all_games()
  |
  |-- Write game_metadata.json (build_delivery_metadata for all games)
  |
  |-- ThreadPoolExecutor (max_workers = parallel_games)
  |     |
  |     |-- For each game:
  |     |     |
  |     |     |-- For each model:
  |     |     |     |
  |     |     |     |-- _execute_model()
  |     |     |           |-- Check resume (skip completed runs)
  |     |     |           |-- Check circuit breaker
  |     |     |           |-- Check budget
  |     |     |           |-- Acquire provider semaphore
  |     |     |           |-- Call run_single_game()
  |     |     |           |-- Record cost to budget tracker
  |     |     |           |-- Record success/failure to circuit breaker
  |     |     |           |-- Return GameModelResult
```

### GameModelResult Dataclass (frozen)

| Field | Type | Description |
|-------|------|-------------|
| `game_id` | `str` | Game identifier. |
| `model_key` | `str` | Model registry key. |
| `run_steps` | `int` | Total steps across all runs. |
| `run_cost` | `float` | Total USD cost across all runs. |
| `avg_score` | `float` | Average score across runs. |
| `solved_count` | `int` | Number of runs that achieved a perfect score (1.0). |
| `total_runs` | `int` | Number of runs executed (including skipped). |
| `error` | `str \| None` | Error message if the model failed. |

### Provider Semaphores

For each unique provider key across all requested models, a `threading.Semaphore` is created with the concurrency limit from `EvalConfig.provider_max_concurrent`. Every provider API call acquires the semaphore before execution and releases it after completion. This prevents overwhelming any single provider's rate limits.

### Budget Trim Skip

`_NO_BUDGET_TRIM_PROVIDERS` is a frozenset of provider keys whose models have sufficiently large context windows that crude token budget trimming is unnecessary. The context manager's budget-aware trimming is bypassed for these providers (i.e., `token_budget` is set to `None`).

**Current members**: `"gemini"`, `"gemini-fallback"`, `"openrouter-gemini"`, `"bedrock-claude"`, `"anthropic"`, `"openai"`. This covers **all providers except `bedrock-kimi`**, which is the only provider that uses budget-aware context trimming. When `token_budget` is `None`, `get_context_within_budget()` in the context manager falls back to the simple sliding window (`get_context()`).

### Metadata Output

At session start, `run_all_games()` writes `game_metadata.json` to the session root directory containing the delivery metadata for every game being evaluated.

---

## 9. Evaluation Runner (Core Step Loop)

### Entry Point

`run_single_game(game_adapter, provider, eval_config, ...)` dispatches runs either sequentially or via `ThreadPoolExecutor(max_workers=parallel_runs)`.

### Per-Run Execution (`_execute_run`)

The core step loop for a single (game, model, run_number) combination:

```
1. game.reset()
2. Initialize conversation history = []
3. step = 0
4. While step < max_steps:
   a. observation = game.render_text()
   b. image = game.render_png_base64() if with_images and model supports vision
   c. available_actions = game.get_available_actions()
   d. prompt = build_turn_prompt(step, observation, available_actions, notepad)
   e. context = context_manager.get_context()
   f. response = _call_provider_with_retry(provider, system_prompt, context, current_observation, valid_actions, notepad, image)
   g. If response.action == "SKIP":
        - Feed error message back into conversation for self-correction
        - Record skip in skips.jsonl
        - Continue to next step
   h. notepad.update(response.notepad_update) if present
   i. feedback = game.step(response.action)
   j. score = game.get_score()
   k. Append (user prompt, assistant response) to conversation history
   l. Record StepRecord -> steps.jsonl
   m. Record CSV row -> token_usage.csv
   n. Record trace entry -> trace file
   o. Emit JSONL event (if streaming mode)
   p. If game.is_done(): break (terminates on ANY done state — solved, game over, etc.)
   q. If shutdown_event.is_set(): break (graceful drain)
   r. If budget exceeded: break
   s. step += 1
5. Record RunRecord -> runs.jsonl (solved = adapter.get_state() == "WIN")
6. Write token_usage_summary.csv
7. Return run result
```

### Reset Count Tracking

Each run tracks `reset_count` — the number of times the model issued a `RESET` action during the run. This is recorded in the `RunRecord`.

### I/O Synchronization

An `io_lock` (threading.Lock) serializes all file writes within a single (game, model) directory to prevent corruption from parallel runs writing to the same files.

### SKIP Handling

When the provider returns `"SKIP"` (either from parsing failure or explicit model choice):
1. The error/context is formatted into a user message and appended to the conversation.
2. This allows the model to self-correct on the next turn by seeing what went wrong.
3. The skip is recorded in `skips.jsonl` with full context.
4. There is **no hard abort** on consecutive skips — the model gets the full `max_steps` to recover.

### Game Feedback Capture

For Arc3 games, `game.step(action)` may print feedback to stdout. This is captured via `contextlib.redirect_stdout` to a `StringIO` buffer, then included in the step record.

---

## 10. Prompt Builder

### System Prompts (LRU-cached)

Two distinct system prompts are generated based on game type:

#### Arc3 System Prompt

Instructs the model to:
- Navigate grid-based puzzle environments
- Progress through levels by solving each grid puzzle
- Available actions: `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `CLICK x y`, `ACTION7`, `RESET`
- `RESET` restarts the game from level 1 (use strategically when stuck)
- The notepad is a persistent 4000-character scratchpad that survives context window truncation
- Respond in JSON format with `action`, `reasoning`, and optional `notepad_update`

#### Arc2 System Prompt

Instructs the model to:
- Study training input-output pairs to identify the transformation rule
- Build the output grid using cursor-based actions
- Available actions: `SET_CELL <color>`, `SET_ROW <c1 c2 ...>`, `MOVE_UP`, `MOVE_DOWN`, `MOVE_LEFT`, `MOVE_RIGHT`, `SUBMIT`, `RESET_GRID`
- Color values are integers 0-9
- `SUBMIT` checks the grid against the expected output
- Respond in JSON format with `action`, `reasoning`, and optional `notepad_update`

### Turn Prompt (`build_turn_prompt`)

Each turn prompt includes:
1. **Step counter**: "Step {N}/{max_steps}"
2. **Observation**: Current game state as text (from `render_text()`)
3. **Available actions**: List of valid actions for the current state
4. **Notepad contents**: Current persistent notepad state (if non-empty)

---

## 11. Context Manager

### Sliding Window

`ContextManager` is a **stateful class** initialized with `__init__(self, window_size: int = 10)`. It maintains `full_history: list[dict]` (all turns) and `window_size` (sliding window size).

- `add_turn(role, content)`: Appends a `{"role": role, "content": content}` dict to `full_history`.
- `get_context()`: Returns the last `self.window_size` messages from `full_history`. Takes **no arguments** — uses instance state.
- `total_turns` property: Returns `len(full_history)`.
- `clear()`: Clears all history.

### Budget-Aware Trimming

`get_context_within_budget(self, token_budget: int, system_prompt: str, current_observation: str)` adaptively reduces the context window when the estimated total tokens exceed the model's budget:

1. Start with the sliding window (`get_context()`).
2. Calculate **fixed tokens**: `estimate_tokens(system_prompt) + estimate_tokens(current_observation)` — these are always present and cannot be trimmed.
3. Calculate **history tokens**: sum of `estimate_tokens(m["content"])` for each message in the window.
4. Apply safety factor: `safe_budget = int(token_budget * _BUDGET_SAFETY_FACTOR)` where `_BUDGET_SAFETY_FACTOR = 0.90`.
5. If `fixed_tokens + history_tokens <= safe_budget`, return the full window unchanged.
6. Otherwise, drop the oldest turn pair (2 messages) and subtract their token estimate. Repeat until within budget or fewer than 2 messages remain.

---

## 12. Notepad (Persistent Scratchpad)

- Maximum size: **4000 characters**.
- The notepad persists across the entire run — it is **not** affected by context window truncation.
- The model can update it via the `notepad_update` field in its JSON response.
- The `update(content)` method stores the new content and maintains a history of all previous values.
- Current notepad contents are included in every turn prompt, giving the model a persistent memory mechanism.

---

## 13. Retry and Error Recovery

### `_call_provider_with_retry`

The retry system has **3 tiers**, checked in order on each failure:

#### Tier 1: Rate Limit Errors

**Detection** (`_is_rate_limit_error`): 5 strategies:
1. HTTP status code 429
2. Error message contains "rate limit" (case-insensitive)
3. Error message contains "quota exceeded"
4. Error message contains "too many requests"
5. Provider-specific rate limit exception types

**Recovery**: Wait until the next minute boundary plus random jitter.
- `_compute_minute_boundary_wait()`: Calculates seconds until the next full minute, adds 5-45 seconds of jitter.
- This aligns retries with provider rate limit reset windows.

#### Tier 2: Gemini Transient Errors

**Detection** (`_is_gemini_transient_error`): HTTP 503 or 504 errors from Gemini providers.

**Recovery**: Fixed cooldown of 30-60 seconds (random within range).

**Additional check** (`_is_gemini_quota_error`): Specific Gemini quota exhaustion errors that may require longer waits.

#### Tier 3: All Other Errors

**Recovery**: Exponential backoff with random jitter. Formula:
```
wait = min((retry_backoff_base ^ attempt) * (0.5 + random()), retry_max_wait)
```
Where `retry_backoff_base = 1.5`, `retry_max_wait = 300.0` seconds, and `random()` returns a uniform float in [0.0, 1.0). The `(0.5 + random())` multiplier adds 0.5x-1.5x jitter to prevent thundering herd on shared rate limits.

### Retry Limits

- Maximum attempts per provider call: `retry_attempts` (default 50).
- After exhausting all retries, the step produces a `"SKIP"` action.
- The sleep between retries uses `_interruptible_sleep()`, which checks the shutdown event periodically to allow graceful cancellation during long waits.

---

## 14. Budget Tracking

### BudgetTracker

Thread-safe cost accounting with `threading.Lock`.

| Method | Description |
|--------|-------------|
| `record_cost(game_id, cost_usd)` | Atomically adds cost to both global and per-game totals. Returns a `BudgetSnapshot`. |
| `check_budget(game_id)` | Returns a `BudgetSnapshot` for the given game without recording cost. |

### BudgetSnapshot Dataclass (frozen)

| Field | Type | Description |
|-------|------|-------------|
| `global_spent` | `float` | Total USD spent across all games. |
| `global_limit` | `float \| None` | Global budget limit. |
| `game_spent` | `float` | USD spent on this specific game. |
| `game_limit` | `float \| None` | Per-game budget limit. |
| `remaining_global` | `float \| None` | Remaining global budget (None if no limit). |
| `remaining_game` | `float \| None` | Remaining per-game budget (None if no limit). |
| `is_over_global` | `bool` | Property: True if global spending exceeds limit. |
| `is_over_game` | `bool` | Property: True if game spending exceeds limit. |

Budget is checked at the orchestrator level (before starting a model's run) via `check_budget()` and at the step level (after each LLM call) via the snapshot returned from `record_cost()`. Callers inspect `snap.is_over_global` / `snap.is_over_game` properties on the returned `BudgetSnapshot`. If the budget is exceeded, the current run terminates and exit code 2 is returned.

---

## 15. Circuit Breaker

Per-provider circuit breaker implementing a standard state machine:

### States

| State | Behavior |
|-------|----------|
| **CLOSED** | Normal operation. Failures are counted. |
| **OPEN** | All requests are immediately rejected without calling the provider. |
| **HALF-OPEN** | A single probe request is allowed through. Success closes the circuit; failure re-opens it. |

### Transitions

- **CLOSED -> OPEN**: When consecutive failures reach `circuit_breaker_threshold`.
- **OPEN -> HALF-OPEN**: After `circuit_breaker_timeout` seconds have elapsed.
- **HALF-OPEN -> CLOSED**: If the probe request succeeds.
- **HALF-OPEN -> OPEN**: If the probe request fails.

### Probe Guard

The `_probing` dictionary acts as a single-thread guard for half-open probes. Only one request at a time can be the probe request; all others are rejected while the probe is in flight.

### Integration

The orchestrator checks the circuit breaker state before executing any model. If the circuit is open, the model is skipped for that game with an appropriate error message.

---

## 16. Cancellation System

### Cancel Watcher

A daemon thread that polls a sentinel directory every **2 seconds** for cancellation files.

### Sentinel Files (Priority Order)

| File Name | Effect |
|-----------|--------|
| `CANCEL_ALL` | Sets the global shutdown event. All games and models stop. |
| `DRAIN` | Sets a drain flag. No new runs start, but in-progress runs complete. |
| `CANCEL_{game_id}` | Cancels all runs for a specific game. |
| `CANCEL_{game_id}_{model_key}` | Cancels runs for a specific (game, model) pair. |

**Priority**: `CANCEL_ALL` > `DRAIN` > per-game > per-model. Higher-priority sentinels are checked first.

### Usage

The cancel watcher runs as a background daemon thread. It sets `threading.Event` instances that are composed into the `CompositeShutdownEvent` checked by the step loop.

---

## 17. Graceful Shutdown

### CompositeShutdownEvent

Duck-types `threading.Event` with **OR semantics**: the composite event fires if ANY of its constituent events fire.

**Constituent events:**
- SIGINT/SIGTERM signal handler event
- Cancel watcher events (per sentinel type)
- Budget exceeded events

**Poll interval**: 100ms for `wait()` calls.

**`set()` behavior**: Targets the last event in the composition chain.

### Shutdown Flow

1. Signal/sentinel/budget triggers one of the constituent events.
2. `CompositeShutdownEvent.is_set()` returns `True`.
3. The step loop in `_execute_run` checks this after every step and breaks.
4. `_interruptible_sleep()` in retry logic checks this to abort waits.
5. The orchestrator's thread pool winds down naturally.
6. Exit code is determined by what triggered the shutdown.

---

## 18. Session Resume

### Completed Run Detection

`_is_run_complete(run_record)` classifies a run as complete if:
- `solved = True`, OR
- `error` is `None` AND `total_steps >= max_steps`

A run that errored out is NOT considered complete (it will be retried).

### Scanning

`scan_completed_runs(output_base, game_ids, model_keys, num_runs, max_sessions, session_dir, safe_model_names)` walks session directories:

| Parameter | Type | Description |
|-----------|------|-------------|
| `output_base` | `Path` | Base output directory (e.g., `data/puzzle-evals`). |
| `game_ids` | `list[str]` | Game IDs to check for completeness. |
| `model_keys` | `list[str]` | Model keys to check. |
| `num_runs` | `int` | Expected number of runs per (game, model). |
| `max_sessions` | `int` | Maximum number of past sessions to scan (default: `MAX_SESSIONS_TO_SCAN`). |
| `session_dir` | `Path \| None` | Specific session directory to scan (overrides auto-discovery). |
| `safe_model_names` | `frozenset[str] \| None` | Pre-computed safe model names for matching directory names. |

Returns: `dict[tuple[str, str], frozenset[int]]` mapping `(game_id, safe_model_name)` to frozensets of completed 1-indexed run numbers.

### Latest Session Discovery

`find_latest_session(output_dir)` scans the output directory for timestamped session subdirectories and returns the most recent one.

### Stale Data Truncation

`truncate_stale_data(session_dir, completed_runs)` removes data from incomplete runs before resuming:

For each (game, model) directory with incomplete runs:
1. **runs.jsonl**: Remove records for incomplete run numbers.
2. **steps.jsonl**: Remove step records belonging to incomplete runs.
3. **skips.jsonl**: Remove skip records belonging to incomplete runs.
4. **token_usage.csv**: Remove rows belonging to incomplete runs.
5. **traces**: Remove trace entries belonging to incomplete runs.

**Atomic writes**: All truncation uses a temp-file-then-`os.replace()` pattern to prevent data corruption on crash.

**Safety guard**: If `runs.jsonl` is empty after truncation (all runs were incomplete), satellite files (steps, skips, CSV) are NOT truncated — this prevents accidental data loss.

### Resume Integration

The `resume_completed` tuple is passed to `OrchestratorConfig`. In `_execute_model()`, the orchestrator computes `skip_runs = completed_runs.get((game_id, safe_model), frozenset())` and skips those run numbers.

---

## 19. Data Schemas and Output Formats

### StepRecord

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `run_id` | `str` | — | Unique run identifier (UUID). |
| `model` | `str` | — | Model key. |
| `game_id` | `str` | — | Game identifier. |
| `game_type` | `str` | — | `"arc2"` or `"arc3"`. |
| `run_number` | `int` | — | 1-indexed run number. |
| `step` | `int` | — | 1-indexed step number within the run. |
| `action` | `str` | — | Action taken by the model. |
| `score` | `float` | — | Score after this step (0.0-1.0). |
| `level` | `int \| None` | — | Current level number (Arc3 only). |
| `total_levels` | `int \| None` | — | Total levels in game (Arc3 only). |
| `done` | `bool` | — | Whether the game is in a terminal state after this step. |
| `state` | `str` | — | Game state string (`IN_PROGRESS`, `WIN`, `GAME_OVER`). |
| `cumulative_cost_usd` | `float` | — | Running total cost for this run up to this step. |
| `input_tokens` | `int` | — | Input tokens for this step's LLM call. |
| `output_tokens` | `int` | — | Output tokens for this step's LLM call. |
| `notepad_length` | `int` | — | Character length of the notepad at this step. |
| `reasoning` | `str` | — | Model's explanation for choosing this action (full trajectory field). |
| `notepad_contents` | `str` | — | Full notepad text at this step (full trajectory field). |
| `observation` | `str` | — | Text grid the model saw before acting (full trajectory field). |
| `game_feedback` | `str` | — | Captured stdout from game engine — clicks, level changes, errors (full trajectory field). |
| `score_pct` | `float` | — | `score * 100` for delivery CSV/JSONL. |
| `step_cost_usd` | `float` | — | Cost of this individual step (NOT cumulative). |
| `reasoning_tokens` | `int` | — | Reasoning tokens for this step. |
| `cached_input_tokens` | `int` | `0` | Tokens served from provider cache (discounted rate). |
| `cache_write_tokens` | `int` | `0` | Tokens written to cache (one-time write cost). |

**`to_event_dict()`**: Returns a lightweight dictionary for the JSONL stdout protocol (TypeScript bridge). Emits all fields **except** the four full trajectory text fields (`reasoning`, `notepad_contents`, `observation`, `game_feedback`) to keep the SSE stream small. Full data is still written to JSONL files on disk.

### RunRecord

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `run_id` | `str` | — | Unique run identifier (UUID). |
| `model` | `str` | — | Model key. |
| `game_id` | `str` | — | Game identifier. |
| `game_type` | `str` | — | `"arc2"` or `"arc3"`. |
| `run_number` | `int` | — | 1-indexed run number. |
| `total_steps` | `int` | — | Total steps executed in this run. |
| `max_steps` | `int` | — | Maximum steps configured for this run. |
| `final_score` | `float` | — | Score at the end of the run (0.0-1.0). |
| `solved` | `bool` | — | Whether score reached 1.0. |
| `levels_completed` | `int \| None` | — | Levels completed (Arc3 only). |
| `total_levels` | `int \| None` | — | Total levels (Arc3 only). |
| `cost_usd` | `float` | — | Total USD cost for this run. |
| `total_input_tokens` | `int` | — | Aggregate input tokens. |
| `total_output_tokens` | `int` | — | Aggregate output tokens. |
| `total_reasoning_tokens` | `int` | — | Aggregate reasoning tokens. |
| `elapsed_seconds` | `float` | — | Wall-clock duration of the run. |
| `notepad_final` | `str` | — | Final notepad contents at end of run. |
| `error` | `str \| None` | — | Error message if the run failed. |
| `model_id` | `str` | — | API model identifier (e.g., `"gemini-2.5-pro"`). |
| `seed` | `int` | — | Random seed used for this run. |
| `final_score_pct` | `float` | — | `final_score * 100` for delivery CSV/JSONL. |
| `total_cached_input_tokens` | `int` | `0` | Accumulated cached input tokens across all steps. |
| `total_cache_write_tokens` | `int` | `0` | Accumulated cache write tokens across all steps. |
| `reset_count` | `int` | `0` | Number of RESET actions taken during the run. |

**`to_event_dict()`**: Returns a dictionary for the JSONL stdout protocol. Includes all fields except `notepad_final` (large text). The event type is `"run_end"`.

### Output File Structure

```
{output_dir}/
  {timestamp}/                          # Session directory
    game_metadata.json                  # Delivery metadata for all games
    logs/
      eval_{timestamp}.log              # Full session log
    {game_id}/
      traces/
        {safe_model}_trace.jsonl        # Per-model trace records
      {safe_model}/
        steps.jsonl                     # One StepRecord per step
        runs.jsonl                      # One RunRecord per completed run
        skips.jsonl                     # SKIP action records with context
        token_usage.csv                 # Per-step token/cost CSV
        token_usage_summary.csv         # Aggregated summary CSV
```

### CSV Columns (token_usage.csv)

`run_id, model, game_id, run_number, step, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, cache_write_tokens, step_cost_usd, cumulative_cost_usd, action, score, state`

### CSV Columns (token_usage_summary.csv)

`run_id, model, game_id, run_number, total_input_tokens, total_output_tokens, total_reasoning_tokens, total_cached_input_tokens, total_cache_write_tokens, total_cost_usd, total_steps, final_score, solved, elapsed_seconds`

### JSONL Writer

`JsonlWriter` provides thread-safe append via an optional `threading.Lock`. The `json_default()` serializer is strict — it raises on non-serializable types rather than silently converting them.

---

## 20. JSONL Streaming Mode

When `--stdout-jsonl` is enabled:

1. All Python `logging` output is redirected to **stderr**.
2. A thread-safe stdout lock is acquired for every JSONL write.
3. **stdout** emits clean, newline-delimited JSON events.

### Event Types

| Event | When | Key Fields |
|-------|------|------------|
| `session_start` | Session begins | `session_dir`, `models`, `games`, `config` |
| `step` | After each step | StepRecord's `to_event_dict()` output |
| `run_complete` | After each run | RunRecord's `to_event_dict()` output |
| `skip` | On SKIP action | Step context, error info |
| `session_end` | Session finishes | `total_cost`, `total_runs`, `exit_code` |

This mode is designed for piping into external consumers (dashboards, databases, monitoring systems) that parse JSONL.

---

## 21. Trace Writer

Writes JSONL trace records for detailed per-model debugging:

### Record Types

| Type | When | Content |
|------|------|---------|
| `header` | Run starts | Model, game, run_number, seed, config |
| `step` | Each step | Full step details including prompt, response, action, reasoning |
| `summary` | Run ends | Final score, total steps, cost, solved status |

### File Location

`{game_id}/traces/{safe_model}_trace.jsonl`

All runs for the same (game, model) pair append to the same trace file, with headers delineating run boundaries.

---

## 22. Pricing and Cost Calculation

### TokenPricing Dataclass

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `input_per_m` | `float` | — | USD per 1M input tokens. |
| `output_per_m` | `float` | — | USD per 1M output tokens. |
| `reasoning_per_m` | `float` | `0.0` | USD per 1M reasoning tokens (if separate from output). |
| `cached_input_per_m` | `float` | `0.0` | USD per 1M cached input tokens (read from cache, discounted rate). |
| `cache_write_per_m` | `float` | `0.0` | USD per 1M tokens written to cache (one-time write cost). |
| `long_context_threshold` | `int` | `0` | Input token count above which long-context pricing applies. `0` = no tiered pricing. |
| `long_input_per_m` | `float` | `0.0` | Long-context input cost per 1M tokens. |
| `long_output_per_m` | `float` | `0.0` | Long-context output cost per 1M tokens. |
| `long_reasoning_per_m` | `float` | `0.0` | Long-context reasoning token cost per 1M tokens. |
| `long_cached_input_per_m` | `float` | `0.0` | Long-context cached input cost per 1M tokens. |
| `long_cache_write_per_m` | `float` | `0.0` | Long-context cache write cost per 1M tokens. |

### PRICING Table

The `PRICING` dictionary maps model/provider keys to `TokenPricing` instances. Entries exist for:
- `gpt-5.4`
- Gemini variants: base `gemini-3.1-pro-preview` pricing, plus `gemini-3.1-pro-preview-priority` derived via `_scale_pricing()`
- Claude: `global.anthropic.claude-opus-4-6-v1` (Bedrock) and `claude-opus-4-6` (native Anthropic)
- Kimi: `moonshotai.kimi-k2.5`

### `_scale_pricing(base_pricing, multiplier)`

Creates a new `TokenPricing` with all per-million rates multiplied by the given factor. Used for priority tier Gemini pricing.

### `compute_cost(pricing_key, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, cache_write_tokens)`

1. Look up `TokenPricing` from the PRICING table using `pricing_key` (or `pricing_model_id` override from ModelConfig).
2. **Long-context tier**: If `input_tokens > long_context_threshold` and long-context rates exist, use the long-context rates.
3. **Double-billing guard**: `text_output_tokens = output_tokens - reasoning_tokens`. This prevents double-counting reasoning tokens at both the output rate and the reasoning rate.
4. **Cost components**:
   - `input_cost = (input_tokens - cached_input_tokens) * input_per_million / 1_000_000`
   - `cached_cost = cached_input_tokens * cached_input_per_million / 1_000_000`
   - `cache_write_cost = cache_write_tokens * cache_write_per_million / 1_000_000`
   - `text_output_cost = text_output_tokens * output_per_million / 1_000_000`
   - `reasoning_cost = reasoning_tokens * reasoning_per_million / 1_000_000`
5. **Total** = sum of all components.

---

## 23. Visualization (Plot Results)

`plot_results.py` generates two chart types from evaluation output:

### Score Over Steps (Line Chart)

- X-axis: Step number
- Y-axis: Score (0.0-1.0)
- Per-model lines with mean score at each step
- Min/max bands showing score range across runs
- Dark theme background
- Colors from `MODEL_COLORS` registry

### Score vs Cost (Scatter Plot)

- X-axis: Cumulative cost (USD)
- Y-axis: Final score
- One point per (model, run) combination
- Colors from `MODEL_COLORS` registry
- Dark theme background

### Input Format

Reads output directories in two supported layouts:
1. **Per-model subdirs**: `{game_id}/{safe_model}/steps.jsonl`
2. **Flat layout**: `{game_id}/steps.jsonl`

---

## 24. Utility Scripts

### `cleanup_orphaned_steps.py` (276 lines)

Cleans orphaned data records that reference `run_id` values not present in `runs.jsonl`:

1. Scans `runs.jsonl` to build the set of valid `run_id` values.
2. For `steps.jsonl`, `skips.jsonl`, and `token_usage.csv`: removes any record whose `run_id` is not in the valid set.
3. Uses atomic writes (temp file + `os.replace()`).
4. Reports the number of orphaned records removed.

### `fix_score_overflow.py` (212 lines)

Retroactively fixes a historical bug where scores could exceed 1.0:

1. Scans all `steps.jsonl` and `runs.jsonl` files in a session.
2. Clamps any `score` or `final_score` value to the range [0.0, 1.0].
3. Rewrites affected files atomically.
4. Reports the number of records corrected.

### `cost_calculator.py` (121 lines)

Interactive CLI tool for cost estimation:

1. Prompts for model, input tokens, output tokens, reasoning tokens.
2. Optionally accepts cached token counts.
3. Computes cost using the `compute_cost()` function from the pricing module.
4. Displays itemized cost breakdown.

---

## 25. TOML Configuration File

### File: `eval.toml`

Three configuration sections:

#### `[eval]` Section

| Key | Type | Description |
|-----|------|-------------|
| `max_steps` | `int` | Maximum steps per run. |
| `num_runs` | `int` | Runs per (game, model). |
| `context_window` | `int` | Sliding context window size. |
| `seed_base` | `int` | Base seed for reproducibility. |
| `retry_attempts` | `int` | Max retries per LLM call. |
| `retry_backoff_base` | `float` | Exponential backoff base. |
| `retry_max_wait` | `float` | Maximum retry wait (seconds). |
| `save_raw_responses` | `bool` | Persist raw LLM responses. |

#### `[budget]` Section

| Key | Type | Description |
|-----|------|-------------|
| `global_usd` | `float` | Global USD budget. |
| `per_game_usd` | `float` | Per-game USD budget. |

#### `[circuit_breaker]` Section

| Key | Type | Description |
|-----|------|-------------|
| `threshold` | `int` | Consecutive failures to trip. |
| `half_open_seconds` | `float` | Seconds before half-open probe. |

### Validation

- Unknown sections generate warnings (not errors).
- Unknown keys within known sections generate warnings.
- `load_toml_config()` returns a `TomlEvalConfig` frozen dataclass.

### Merge Behavior

`merge_cli_over_toml(cli_args, toml_config)`: For each configuration field, the CLI value takes precedence if explicitly provided. Otherwise, the TOML value is used. If neither is set, the hardcoded default applies.

---

## 26. Test Suite

### Test Files (13 total)

| File | What It Tests |
|------|---------------|
| `test_budget.py` | BudgetTracker, BudgetSnapshot, thread safety, edge cases |
| `test_cancel_watcher.py` | Sentinel file detection, priority ordering, daemon thread behavior |
| `test_circuit_breaker.py` | State transitions (CLOSED/OPEN/HALF-OPEN), probe guard, reset |
| `test_client_spec_updates.py` | Client delivery schema validation |
| `test_integration_pipeline.py` | End-to-end pipeline with mock providers |
| `test_parallel_runs.py` | Concurrent run execution, thread safety |
| `test_resume.py` | Completed run detection, stale data truncation, atomic writes |
| `test_shutdown.py` | CompositeShutdownEvent, OR semantics, signal handling |
| `test_toml_config.py` | TOML parsing, section validation, merge behavior |
| `test_bedrock_arn.py` | ARN region extraction utility |
| `conftest.py` | Shared pytest fixtures and test helpers |

### Running Tests

```bash
cd scripts/evaluate
python -m pytest tests/ -v
```

Tests use `pytest` with `pytest-timeout` for hanging test protection.

---

## 27. Dependencies

### Required Packages

| Package | Minimum Version | Purpose |
|---------|----------------|---------|
| `arcengine` | `>=0.9.3` | ARC-AGI-3 game engine |
| `openai` | `>=1.50.0` | OpenAI API client (Responses + Chat Completions) |
| `anthropic` | `>=0.40.0` | Anthropic Messages API client |
| `google-genai` | `>=1.0.0` | Google Gemini API client |
| `pillow` | `>=10.0.0` | PNG image generation from NumPy arrays |
| `numpy` | `>=1.26.0` | Grid manipulation and image processing |
| `matplotlib` | `>=3.8.0` | Result visualization charts |
| `pytest` | `>=7.0.0` | Test runner |
| `pytest-timeout` | `>=2.0.0` | Test timeout protection |
| `boto3` | (implicit) | AWS Bedrock authentication |
| `python-dotenv` | (any) | `.env` file loading (`load_dotenv()` called at startup to load `{project_root}/.env`) |
| `toml` | (stdlib in 3.11+) | TOML configuration parsing |

### Additional Runtime Dependencies

- `importlib` — Dynamic game module loading (Arc3)
- `threading` — Parallel execution, locks, semaphores, events
- `concurrent.futures` — ThreadPoolExecutor for game/model/run parallelism
- `signal` — SIGINT/SIGTERM handlers
- `contextlib` — stdout redirection for game feedback capture

---

## 28. Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All games/models completed successfully. |
| `1` | Partial failure — some games/models failed but others succeeded. |
| `2` | Budget exceeded — global or per-game spending limit hit. |
| `3` | All games/models failed — no successful completions. |
| `130` | SIGINT received — user interrupted with Ctrl+C. |

---

## 29. Directory Structure and File Layout

```
scripts/evaluate/
  evaluate.py                           # CLI entry point (507 lines)
  orchestrator.py                       # Parallel game/model orchestration (419 lines)
  config.py                             # ModelConfig, EvalConfig, MODEL_REGISTRY (441 lines)
  game_adapter.py                       # BaseGameAdapter, Arc3GameAdapter, Arc2TaskAdapter (528 lines)
  game_loader.py                        # Game discovery and loading (352 lines)
  budget.py                             # Thread-safe budget tracking (91 lines)
  circuit_breaker.py                    # Per-provider circuit breaker (114 lines)
  cancel_watcher.py                     # File-based cancellation system (92 lines)
  shutdown.py                           # CompositeShutdownEvent (63 lines)
  resume.py                             # Session resume and stale data truncation (477 lines)
  toml_config.py                        # TOML config loading and merge (192 lines)
  plot_results.py                       # Visualization charts (384 lines)
  eval.toml                             # Example TOML configuration
  requirements.txt                      # Python dependencies
  
  runner/
    eval_runner.py                      # Core step loop and retry logic (886 lines)
    prompt_builder.py                   # System and turn prompt generation (152 lines)
    context_manager.py                  # Sliding window context management (111 lines)
    notepad.py                          # Persistent scratchpad (37 lines)
    trace_writer.py                     # JSONL trace output (73 lines)
  
  providers/
    base.py                             # BaseProvider ABC, ProviderResponse, action parsing (174 lines)
    pricing.py                          # TokenPricing, PRICING table, compute_cost (199 lines)
    openai_provider.py                  # OpenAI Responses/Chat Completions API (421 lines)
    gemini_provider.py                  # Google Gemini with Vertex AI support (298 lines)
    anthropic_claude_provider.py        # Native Anthropic Messages API (291 lines)
    bedrock_claude_provider.py          # AWS Bedrock Converse API for Claude (279 lines)
    bedrock_kimi_provider.py            # AWS Bedrock InvokeModel API for Kimi (220 lines)
    gemini_fallback_provider.py         # Multi-tier Gemini fallback chain (131 lines)
    openrouter_gemini_provider.py       # OpenRouter Gemini routing (58 lines)
    kimi_provider.py                    # Moonshot Kimi routing (37 lines)
    bedrock_utils.py                    # ARN region extraction (21 lines)
  
  data/
    schemas.py                          # StepRecord, RunRecord dataclasses (139 lines)
    writer.py                           # Thread-safe JSONL writer (82 lines)
  
  utility/
    cleanup_orphaned_steps.py           # Orphaned record cleanup (276 lines)
    fix_score_overflow.py               # Score overflow retroactive fix (212 lines)
    cost_calculator.py                  # Interactive cost estimation CLI (121 lines)
  
  tests/
    conftest.py                         # Shared fixtures
    test_budget.py
    test_cancel_watcher.py
    test_circuit_breaker.py
    test_client_spec_updates.py
    test_integration_pipeline.py
    test_parallel_runs.py
    test_resume.py
    test_shutdown.py
    test_toml_config.py
    test_bedrock_arn.py
```

---

## Appendix A: Key Behavioral Invariants

These behaviors are critical for faithful reimplementation:

1. **GAME_OVER is not terminal in Arc3.** The model can issue `RESET` after a `GAME_OVER` state to restart from level 1. The step loop does NOT break on `GAME_OVER` — it only breaks when `is_done()` returns True AND `score >= 1.0`.

2. **SKIP does not abort.** A `SKIP` action (from parsing failure or model refusal) feeds the error context back into the conversation for self-correction. There is no consecutive-skip abort threshold.

3. **Cursor auto-advances on SET_CELL.** In Arc2, after setting a cell, the cursor automatically moves to the next column. At the end of a row, it wraps to the beginning of the next row.

4. **The `enviornment_files` typo is load-bearing.** The ARC-AGI-2 dataset directory has this misspelling in the upstream dataset. Do not "fix" it.

5. **Reasoning tokens are subtracted from output tokens for cost calculation.** `text_output = output_tokens - reasoning_tokens` prevents double-billing when reasoning tokens have a separate rate.

6. **Resume classifies runs conservatively.** A run is "complete" only if `solved=True` OR (no error AND `total_steps >= max_steps`). Errored runs are always retried.

7. **Atomic file operations for resume truncation.** All file rewrites during stale data cleanup use temp-file + `os.replace()` to prevent corruption.

8. **Provider semaphores are per-provider-key, not per-model.** Multiple models sharing the same provider key share a single semaphore with the configured concurrency limit.

9. **Cache breakpoints are strategically ordered.** In Anthropic/Bedrock Claude, the 3 breakpoints are: (1) tool definition, (2) system prompt, (3) last history message. This maximizes cache hit rates as conversation grows.

10. **Bedrock Kimi uses InvokeModel, not Converse.** The Converse API does not support image inputs for Kimi models, so the provider uses InvokeModel with OpenAI Chat Completions payload format.

---

## Appendix B: Concurrency Model

```
Main Thread
  |
  |-- Signal Handlers (SIGINT, SIGTERM)
  |-- Cancel Watcher (daemon thread, 2s poll)
  |
  |-- Game ThreadPool (max_workers = parallel_games)
  |     |
  |     |-- Model execution (sequential within game, one model at a time)
  |     |     |
  |     |     |-- Provider Semaphore (per-provider concurrency limit)
  |     |     |
  |     |     |-- Run ThreadPool (max_workers = parallel_runs)
  |     |     |     |
  |     |     |     |-- Step Loop (sequential within run)
  |     |     |     |     |-- LLM call (with retry + backoff)
  |     |     |     |     |-- I/O Lock for file writes
  |     |     |     |     |-- Budget check
  |     |     |     |     |-- Circuit breaker check
  |     |     |     |     |-- Shutdown event check
```

All file I/O within a (game, model) directory is serialized via `io_lock`. Budget tracking and circuit breaker state are protected by their own internal locks.

---

*End of specification.*
