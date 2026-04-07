# Feature Specification: Python Evaluation Harness


---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Purpose & Context](#2-system-purpose--context)
3. [Architecture Overview](#3-architecture-overview)
4. [Module Inventory](#4-module-inventory)
5. [CLI Interface](#5-cli-interface)
6. [Configuration System](#6-configuration-system)
7. [Game Adapters](#7-game-adapters)
8. [Provider System](#8-provider-system)
9. [Execution Engine](#9-execution-engine)
10. [Concurrency Model](#10-concurrency-model)
11. [Cost & Budget Management](#11-cost--budget-management)
12. [Resilience Subsystems](#12-resilience-subsystems)
13. [Resume & Recovery](#13-resume--recovery)
14. [Data Schemas & Output Format](#14-data-schemas--output-format)
15. [JSONL Stdout Protocol (TS Bridge)](#15-jsonl-stdout-protocol-ts-bridge)
16. [Prompt Engineering](#16-prompt-engineering)
17. [Scoring Semantics](#17-scoring-semantics)
18. [Visualization & Utilities](#18-visualization--utilities)
19. [Test Suite](#19-test-suite)
20. [External Dependencies](#20-external-dependencies)
21. [Environment Variables](#21-environment-variables)
22. [Known Architectural Constraints](#22-known-architectural-constraints)
23. [Appendix A: Complete File Inventory](#appendix-a-complete-file-inventory)
24. [Appendix B: Model Registry](#appendix-b-model-registry)
25. [Appendix C: Configuration Constants](#appendix-c-configuration-constants)

---

## 1. Executive Summary

The Python Evaluation Harness is a multi-model, multi-game benchmarking system that evaluates LLM performance on ARC-AGI puzzle tasks (both ARC-AGI-2 grid tasks and ARC-AGI-3 interactive environment games). It orchestrates parallel evaluation runs across multiple AI providers (OpenAI, Anthropic, Google Gemini, AWS Bedrock, Moonshot Kimi, OpenRouter), tracks token usage and costs, supports graceful shutdown and resume, and outputs structured JSONL/CSV data for analysis.

**Key capabilities:**
- Evaluate 18+ model configurations across 8 distinct provider backends
- Three-level nested parallelism: games x models x runs
- Crash-safe resume with run-level granularity
- Thread-safe per-step data persistence (JSONL, CSV, traces)
- Real-time JSONL event stream for TypeScript bridge integration
- Budget enforcement (global + per-game USD limits)
- Circuit breaker and 3-tier retry with provider-aware backoff
- File-based graceful cancellation (no signal dependency)
- Prompt caching optimization across all providers

---

## 2. System Purpose & Context

### What It Does

The harness answers the question: **"How well can model X solve ARC-AGI puzzles?"**

For each (game, model, run) triple, it:
1. Loads a puzzle game (ARC-AGI-2 grid task or ARC-AGI-3 environment)
2. Presents observations to an LLM via provider-specific APIs
3. Parses the LLM's chosen action from structured JSON/tool-call responses
4. Executes the action in the game environment
5. Records the resulting score, token usage, cost, and full trajectory
6. Repeats until the game is solved, max steps reached, or budget exhausted

### Where It Lives

```
scripts/evaluate/
  evaluate.py              # CLI entry point
  config.py                # Model registry + configuration
  orchestrator.py          # Parallel game/model dispatch
  game_adapter.py          # Game environment abstraction
  game_loader.py           # Game discovery + loading
  budget.py                # Cost tracking
  circuit_breaker.py       # Provider fault tolerance
  shutdown.py              # Composite shutdown events
  cancel_watcher.py        # File-based cancellation
  resume.py                # Crash recovery
  toml_config.py           # TOML configuration
  cost_calculator.py       # Standalone cost estimator
  plot_results.py          # Visualization
  fix_score_overflow.py    # One-off data fix
  cleanup_orphaned_steps.py # One-off maintenance
  runner/
    eval_runner.py         # Core step loop
    prompt_builder.py      # System/turn prompt construction
    context_manager.py     # Sliding window + token budget
    notepad.py             # Persistent scratchpad
    trace_writer.py        # Full trajectory logging
  providers/
    base.py                # Provider ABC + response parsing
    pricing.py             # Token cost calculation
    openai_provider.py     # OpenAI (Responses API + Chat Completions)
    anthropic_claude_provider.py  # Native Anthropic
    gemini_provider.py     # Google Gemini (genai SDK)
    gemini_fallback_provider.py   # Gemini tier fallback
    openrouter_gemini_provider.py # Gemini via OpenRouter
    bedrock_claude_provider.py    # Claude via AWS Bedrock
    bedrock_kimi_provider.py      # Kimi via AWS Bedrock
    kimi_provider.py       # Kimi direct (Moonshot AI)
    bedrock_utils.py       # ARN parsing utility
  data/
    schemas.py             # StepRecord + RunRecord dataclasses
    writer.py              # Thread-safe JSONL writer
  tests/                   # ~3,500 lines of pytest tests
  eval.toml                # TOML config template
  requirements.txt         # Python dependencies
```

### Integration with TypeScript Server

The harness communicates with the TypeScript server (Express) via the `--stdout-jsonl` flag. When active, Python emits structured JSONL events on stdout (one JSON line per event), while all logs go to stderr. The TypeScript server spawns the Python process, reads stdout line-by-line, and forwards events to clients via SSE.

---

## 3. Architecture Overview

### Data Flow

```
CLI args + eval.toml
        |
        v
evaluate.py::main()
  - Parse args, merge TOML config
  - Resolve game_ids + model_keys
  - Create timestamped session directory
  - Start cancel_watcher daemon thread
  - Set up signal handlers (SIGINT/SIGTERM)
  - Emit session_start event (bridge mode)
        |
        v
orchestrator.py::run_all_games()
  - Create BudgetTracker + CircuitBreaker
  - Build per-provider semaphores
  - Outer ThreadPoolExecutor (games, max 20)
        |
        +-- For each game (parallel):
        |     orchestrator._run_game()
        |       - Write metadata.json
        |       - Inner ThreadPoolExecutor (models, all parallel)
        |             |
        |             v
        |       orchestrator._execute_model()
        |         - Resume check (skip completed runs)
        |         - Circuit breaker gate
        |         - Budget pre-check
        |         - Create provider instance
        |         - Call run_single_game(...)
        |               |
        |               v
        |         eval_runner.run_single_game()
        |           - Set up file writers (JSONL, CSV, traces)
        |           - Dispatch N runs (sequential or parallel)
        |                 |
        |                 v
        |           _execute_run(run_num):
        |             1. load_game(game_id, seed)
        |             2. adapter.reset()
        |             3. build_system_prompt()
        |             4. write_trace_header()
        |             5. STEP LOOP (while step < max_steps):
        |                  a. Observe (text + optional PNG)
        |                  b. Build turn prompt
        |                  c. Get context within budget
        |                  d. Call provider with retry
        |                  e. Update notepad
        |                  f. Execute action in game
        |                  g. Record step (JSONL + CSV + trace)
        |                  h. Emit step event (bridge mode)
        |                  i. Check: game done? budget exceeded? shutdown?
        |             6. Write run record + trace footer
        |             7. Emit run_end event
        |
        v
evaluate.py: emit session_end event
```

### Dependency Graph (Import Relationships)

```
evaluate.py
  +-- config.py
  +-- game_loader.py
  +-- orchestrator.py
  |     +-- budget.py
  |     +-- circuit_breaker.py
  |     +-- shutdown.py
  |     +-- runner/eval_runner.py
  |     |     +-- runner/prompt_builder.py
  |     |     +-- runner/context_manager.py
  |     |     +-- runner/notepad.py
  |     |     +-- runner/trace_writer.py
  |     |     +-- providers/base.py
  |     |     +-- data/schemas.py
  |     |     +-- data/writer.py
  |     |     +-- game_adapter.py
  |     +-- game_loader.py
  +-- resume.py
  +-- cancel_watcher.py
  +-- toml_config.py
  +-- data/writer.py

config.py::create_provider()  [lazy imports]
  +-- providers/openai_provider.py
  +-- providers/gemini_provider.py
  +-- providers/gemini_fallback_provider.py
  +-- providers/anthropic_claude_provider.py
  +-- providers/bedrock_claude_provider.py
  +-- providers/bedrock_kimi_provider.py
  +-- providers/kimi_provider.py
  +-- providers/openrouter_gemini_provider.py

All providers
  +-- providers/base.py
  +-- providers/pricing.py
  +-- providers/bedrock_utils.py  [Bedrock providers only]
```

---

## 4. Module Inventory

### Root Modules (16 files)

| File | Lines | Responsibility |
|---|---|---|
| `evaluate.py` | 507 | CLI entry point, argument parsing, session setup, signal handling, JSONL bridge |
| `config.py` | 441 | Model registry (18 entries), `ModelConfig` / `EvalConfig` dataclasses, provider factory |
| `orchestrator.py` | 419 | Nested parallel execution (games x models), budget/circuit integration |
| `game_adapter.py` | 528 | `BaseGameAdapter` ABC, `Arc3GameAdapter`, `Arc2TaskAdapter` |
| `game_loader.py` | 352 | Game discovery, loading, metadata extraction, module caching |
| `resume.py` | 477 | Run completion scanning, stale data truncation, atomic file writes |
| `budget.py` | 91 | Thread-safe budget tracking (global + per-game) |
| `cancel_watcher.py` | 92 | File-based cancellation daemon (sentinel polling) |
| `circuit_breaker.py` | 114 | Per-provider circuit breaker (CLOSED/OPEN/HALF-OPEN) |
| `shutdown.py` | 63 | `CompositeShutdownEvent` with OR semantics |
| `toml_config.py` | 192 | TOML config loading and CLI merge |
| `cost_calculator.py` | 121 | Standalone cost estimation CLI |
| `plot_results.py` | 384 | PNG chart generation (score-over-steps, score-vs-cost) |
| `fix_score_overflow.py` | 212 | One-off fix for score > 1.0 data corruption |
| `cleanup_orphaned_steps.py` | 276 | One-off orphaned record cleanup |
| `eval.toml` | 22 | TOML config template (all values commented out) |

### runner/ Subpackage (5 modules)

| File | Lines | Responsibility |
|---|---|---|
| `eval_runner.py` | 886 | Core step loop, 3-tier retry, SKIP handling, parallel run dispatch |
| `prompt_builder.py` | 152 | System/turn prompt construction for ARC2/ARC3 |
| `context_manager.py` | 111 | Sliding window + token-budget adaptive trimming |
| `notepad.py` | 37 | 4000-char persistent scratchpad with versioning |
| `trace_writer.py` | 73 | Full trajectory JSONL logging (header/step/footer) |

### providers/ Subpackage (10 modules)

| File | Lines | Responsibility |
|---|---|---|
| `base.py` | 174 | `BaseProvider` ABC, `ProviderResponse` dataclass, JSON/regex action parsing |
| `pricing.py` | 199 | Token pricing with long-context tiers and caching discounts |
| `openai_provider.py` | 421 | OpenAI Responses API + Chat Completions dual-path |
| `anthropic_claude_provider.py` | 291 | Native Anthropic with 3-point prompt caching and adaptive thinking |
| `gemini_provider.py` | 298 | Google Gemini via genai SDK with Vertex AI priority patching |
| `gemini_fallback_provider.py` | 131 | Tier fallback: Studio -> Vertex Standard -> Vertex Priority |
| `openrouter_gemini_provider.py` | 58 | Gemini via OpenRouter (OpenAI-compatible) |
| `bedrock_claude_provider.py` | 279 | Claude via Bedrock Converse API (raw HTTP, no boto3) |
| `bedrock_kimi_provider.py` | 220 | Kimi via Bedrock InvokeModel API (NOT Converse) |
| `kimi_provider.py` | 37 | Kimi direct via Moonshot AI (OpenAI-compatible) |
| `bedrock_utils.py` | 21 | ARN region extraction utility |

### data/ Subpackage (2 modules)

| File | Lines | Responsibility |
|---|---|---|
| `schemas.py` | 139 | `StepRecord` (24+ fields), `RunRecord` (21+ fields), `to_event_dict()` |
| `writer.py` | 82 | Thread-safe `JsonlWriter` with strict JSON serialization |

### tests/ Subpackage (10 files, ~3,500 lines)

See [Section 19: Test Suite](#19-test-suite).

---

## 5. CLI Interface

### Primary Entry Point

```bash
python -m scripts.evaluate.evaluate [flags]
```

### Arguments

| Flag | Type | Default | Description |
|---|---|---|---|
| `--game` | str (repeatable) | *required* | Game ID(s) or `all` |
| `--models` | str (repeatable) | `all` | Model key(s) from registry or `all` |
| `--runs` | int | `3` | Number of evaluation runs per (game, model) |
| `--max-steps` | int | `200` | Maximum steps per run |
| `--context-window` | int | `50` | Conversation turns visible to the model |
| `--output-dir` | str | `data/puzzle-evals` | Base output directory |
| `--seed` | int | `42` | Base seed (run N uses seed + N) |
| `--dry-run` | flag | off | Validate configuration, no API calls |
| `--list-games` | flag | off | Print available games and exit |
| `--stdout-jsonl` | flag | off | JSONL bridge mode: events on stdout, logs on stderr |
| `--verbose` | flag | off | Debug-level logging |
| `--sequential` | flag | off | Run models sequentially (not parallel) |
| `--parallel-games` | int | `1` | Concurrent game workers (max 20) |
| `--parallel-runs` | int | `1` | Concurrent run workers per model (max 10) |
| `--budget-global` | float | none | Global USD spending cap |
| `--budget-per-game` | float | none | Per-game USD spending cap |
| `--resume` | flag | off | Resume from latest session, skip completed runs |
| `--config` | str | none | Path to TOML config file |
| `--with-images` | flag | off | Include PNG screenshots in ARC3 prompts |
| `--game-type` | str | none | Filter games by type (`arc2`, `arc3`) |
| `--limit` | int | none | Cap number of games to evaluate |
| `--save-raw-responses` | flag | off | Write full API responses to JSONL |
| `--exclude` | str (repeatable) | none | Game IDs to skip |

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | All runs completed successfully |
| `1` | Partial completion (some runs failed) |
| `2` | Budget exhausted |
| `3` | All runs failed |
| `130` | Interrupted by SIGINT |

### TOML Configuration

The `--config` flag loads a TOML file that can set any CLI parameter. CLI flags always override TOML values when explicitly provided (not default). See `eval.toml` for the template.

```toml
[eval]
game = ["game1", "game2"]
models = ["gemini-3.1", "gpt-5.4-thinking"]
runs = 5
max_steps = 150
context_window = 30
with_images = true

[budget]
budget_global = 50.0
budget_per_game = 10.0

[circuit_breaker]
circuit_threshold = 15
circuit_half_open_seconds = 600.0
```

---

## 6. Configuration System

### ModelConfig Dataclass (15 fields)

```python
@dataclass(frozen=True)
class ModelConfig:
    name: str                    # Display name
    model_id: str                # API model identifier
    provider: str                # Provider type key
    env_key: str                 # Environment variable for API key
    base_url: str | None         # Custom API endpoint
    supports_vision: bool        # Can accept PNG screenshots
    max_context_tokens: int      # Provider's context window size
    reasoning_effort: str | None # "high", "medium", "low", or None
    pricing_model_id: str | None # Override for cost calculation
    max_output_tokens: int       # Output token limit (default: 8192)
    additional_headers: dict     # Extra HTTP headers
    timeout_ms: int              # Request timeout (default: 600_000ms)
    vertexai: bool               # Use Vertex AI endpoint
    gcp_project: str | None      # GCP project ID
    gcp_location: str            # GCP region (default: "us-central1")
```

### EvalConfig Dataclass (11 fields)

```python
@dataclass
class EvalConfig:
    max_steps: int = 200
    num_runs: int = 3
    context_window: int = 50
    seed_base: int = 42
    output_dir: Path = Path("data/puzzle-evals")
    dry_run: bool = False
    retry_attempts: int = 50
    retry_backoff_base: float = 1.5
    retry_max_wait: float = 300.0
    save_raw_responses: bool = False
    provider_max_concurrent: dict = field(default_factory=lambda: {
        "bedrock-claude": 8,
        "anthropic": 10,
        "gemini": 12,
        "gemini-fallback": 12,
        "openrouter-gemini": 12,
        "openai": 16,
        "bedrock-kimi": 32,
    })
```

### Provider Factory

`create_provider(model_key)` uses lazy imports to instantiate the correct provider class based on `ModelConfig.provider`:

| Provider Key | Class | Import Path |
|---|---|---|
| `openai` | `OpenAIProvider` | `providers.openai_provider` |
| `openrouter-gemini` | `OpenRouterGeminiProvider` | `providers.openrouter_gemini_provider` |
| `gemini` | `GeminiProvider` | `providers.gemini_provider` |
| `gemini-fallback` | `GeminiFallbackProvider` | `providers.gemini_fallback_provider` |
| `kimi` | `KimiProvider` | `providers.kimi_provider` |
| `bedrock-claude` | `BedrockClaudeProvider` | `providers.bedrock_claude_provider` |
| `bedrock-kimi` | `BedrockKimiProvider` | `providers.bedrock_kimi_provider` |
| `anthropic` | `AnthropicClaudeProvider` | `providers.anthropic_claude_provider` |

### OrchestratorConfig (frozen dataclass)

Defined in `orchestrator.py`. Passed from `evaluate.py` to `run_all_games()`:

```python
@dataclass(frozen=True)
class OrchestratorConfig:
    parallel_games: int
    budget_global_usd: float | None
    budget_per_game_usd: float | None
    circuit_threshold: int = 10
    circuit_half_open_seconds: float = 300.0
    sequential_models: bool = False
    parallel_runs: int = 1
    resume_completed: tuple[tuple[str, str, frozenset[int]], ...] = ()
    cancel_sentinel_dir: Path | None = None
    with_images: bool = False
```

### GameModelResult (frozen dataclass)

Also in `orchestrator.py`. Returned per (game, model) execution:

```python
@dataclass(frozen=True)
class GameModelResult:
    game_id: str
    model_key: str
    runs_completed: int
    error: str | None
```

### MODEL_COLORS (`config.py`)

Maps model keys to hex color strings for chart rendering in `plot_results.py`. Example entries:
- `"gemini-3.1": "#4A7C59"` (forest green)
- `"gpt-5.4-thinking": "#D4A843"` (gold)
- `"claude-bedrock": "#C75B5B"` (coral red)

---

## 7. Game Adapters

### BaseGameAdapter (ABC)

All game types implement this interface:

```python
class BaseGameAdapter(ABC):
    # Properties
    game_id: str               # Unique puzzle identifier
    game_type: str             # "arc2" or "arc3"
    title: str                 # Human-readable name
    level: int                 # Current level (1-indexed)
    total_levels: int          # Total levels in puzzle
    levels_completed: int      # Levels solved so far
    
    # Lifecycle
    reset() -> None            # Reset game to initial state
    step(action: str) -> None  # Execute action in game environment
    is_done() -> bool          # True if all levels complete
    
    # Observation
    get_score() -> float       # 0.0 - 1.0, current progress
    get_state() -> str         # Machine-readable state
    get_available_actions() -> list[str]  # Valid actions this step
    render_text() -> str       # Human-readable observation
    render_png_base64() -> str | None  # Optional screenshot
    
    # Metadata
    @property
    metadata -> dict           # Game configuration summary (property, not method)
```

### Arc3GameAdapter

Wraps `arcengine.ARCBaseGame` for ARC-AGI-3 interactive puzzle environments.

- **Actions**: `RESET`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `CLICK x y`, `ACTION7`
- **Score**: `levels_completed / total_levels` (0.0 to 1.0)
- **Terminal condition**: `is_done()` when all levels complete. Note: `GAME_OVER` state is NOT terminal — the model can issue `RESET` to retry.
- **Rendering**: 16-color palette (`_ARC3_LUT`), numpy array -> PIL Image -> base64 PNG at 6x scale
- **Lazy imports**: `arcengine` only imported when an ARC3 game is loaded

### Arc2TaskAdapter

Interactive grid-builder for ARC-AGI-2 JSON grid tasks.

- **Actions**: `SET_CELL row col value`, `SET_ROW row v0 v1 v2 ...`, `MOVE_UP/DOWN/LEFT/RIGHT`, `SUBMIT`, `RESET_GRID`
- **Score**: `correct_cells / total_cells` (continuous 0.0 to 1.0). Each cell matching the ground truth contributes.
- **Terminal condition**: `SUBMIT` action triggers completion check. Returns feedback on correctness.
- **Rendering**: 10-color ARC2 palette, text-based grid display with cursor position
- **Performance**: `_cached_training_text` avoids re-rendering training examples every step

---

## 8. Provider System

### Provider Abstraction

All providers implement `BaseProvider.choose_action()`:

```python
def choose_action(
    self,
    system_prompt: str,
    conversation_history: list[dict],  # [{"role": "user"|"assistant", "content": str}]
    current_observation: str,
    valid_actions: list[str],
    notepad: str,
    image_b64: str | None = None,
) -> ProviderResponse
```

### ProviderResponse Dataclass (11 fields)

```python
@dataclass
class ProviderResponse:
    action: str                    # Parsed action or "SKIP"
    reasoning: str                 # Model's reasoning text
    notepad_update: str | None     # New notepad content (None = no change)
    input_tokens: int              # Non-cached input tokens consumed
    output_tokens: int             # Output tokens (includes reasoning)
    reasoning_tokens: int          # Dedicated reasoning tokens (subset of output)
    cost_usd: float                # Step cost in USD
    raw_response: dict | None      # Full API response (if save_raw_responses)
    cached_input_tokens: int = 0   # Tokens served from cache
    cache_write_tokens: int = 0    # Tokens written to cache
    traffic_type: str | None = None # Gemini traffic type metadata
```

### Response Parsing Pipeline

`_parse_action_response()` in `base.py` (a `@staticmethod`):

1. **Brace-depth JSON extraction**: Scans for `{` ... `}` matching braces, attempts `json.loads()` on each candidate
2. **Regex fallback**: Patterns for `"action": "VALUE"` extraction
3. **Action matching** (`_match_action()`): exact match -> case-insensitive -> prefix match
4. **SKIP sentinel**: If no valid action can be extracted, returns `"SKIP"`. The SKIP is **never injected as a game action** — instead, a rejection message is fed back into the conversation for self-correction.

### Tool Calling

All providers use function/tool calling to structure the LLM's response. The tool description is built dynamically each step via `build_action_description(valid_actions)` (standalone function in `base.py`):

```python
# Dynamic tool description built per step
{
    "name": "take_action",
    "description": "Execute a game action",
    "parameters": {
        "action": {"type": "string", "enum": [...valid_actions...]},
        "reasoning": {"type": "string"},
        "notepad": {"type": "string"}  # optional
    }
}
```

### Provider-Specific Details

#### OpenAI (`openai_provider.py`)
- **Dual-path routing**: If `reasoning_effort` is set → Responses API (`/v1/responses`); otherwise → Chat Completions API
- **Responses API**: Uses `instructions` field (not system message), `input` array, `tool_choice: "required"`, `store: false`
- **Chat Completions**: Uses `messages` array, `temperature: 0.3`
- **Caching**: Extracts `cached_input_tokens` from usage, subtracts from total input
- **Cost**: Prefers API-reported cost when available (future-proofing)

#### Anthropic Claude (`anthropic_claude_provider.py`)
- **SDK**: Native `anthropic` package
- **3 cache_control breakpoints**:
  1. Tool definition dict → `cache_control: {"type": "ephemeral"}`
  2. System prompt text block → `cache_control: {"type": "ephemeral"}`
  3. Last conversation history message → `cache_control: {"type": "ephemeral"}`
- **Thinking**: Adaptive thinking enabled (`type: "adaptive"`), `interleaved-thinking-2025-05-14` beta header
- **Tool choice**: `{"type": "auto"}` (dict, not bare string; required when thinking is enabled; `"required"`/`"any"` not compatible)
- **Token extraction**: Separate `cache_read_input_tokens` and `cache_creation_input_tokens`
- **Parsing**: Skips `thinking` blocks when extracting action from response
- **Note**: `reasoning_tokens` is always reported as `0` — the Anthropic SDK doesn't expose a dedicated reasoning_tokens field. Cost is still correct because Claude bills reasoning and output tokens at the same per-token price.

#### Gemini (`gemini_provider.py`)
- **SDK**: `google-genai` (`genai.Client`)
- **Function calling**: `types.Tool` with `FunctionDeclaration`, `FunctionCallingConfig(mode="ANY")` (string value)
- **Parameters**: `temperature: 0.3`, `max_output_tokens: 8192`
- **Token extraction**: `thoughts_token_count` (added to output_tokens), `cached_content_token_count` (subtracted from prompt_token_count)
- **Vertex AI Priority patching**: Post-init monkey-patch of `_client._api_client._http_options.api_version` to `"v1/publishers/google"`. Has stability guard that raises if SDK internals change.
- **Traffic type**: Extracted from `usage_metadata` for billing tier identification

#### Gemini Fallback (`gemini_fallback_provider.py`)
- **Tier order**: AI Studio → Vertex Standard → Vertex Priority
- **Retriable errors**: Network errors, HTTP 429/>=500, gRPC `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/`DEADLINE_EXCEEDED`/`INTERNAL`
- **Non-retriable**: 4xx errors (except 429) raise immediately to the caller
- **Exhaustion**: All tiers fail → raises last error for eval_runner's 3-tier retry to handle

#### OpenRouter Gemini (`openrouter_gemini_provider.py`)
- Thin `OpenAIProvider` subclass
- `base_url`: `https://openrouter.ai/api/v1`
- Extra headers: `HTTP-Referer`, `X-Title`
- Extra body: `provider.order: ["google-ai-studio"]`, `reasoning.effort: "high"`
- Forces Chat Completions path (`reasoning_effort=None`)

#### Bedrock Claude (`bedrock_claude_provider.py`)
- **API**: Raw HTTP to Bedrock Converse API (`POST /model/{id}/converse`). No boto3 dependency.
- **Auth**: Bearer token (`BEDROCK_API_KEY`)
- **3 cachePoint breakpoints**: System prompt, last history message, tool definitions
- **Thinking**: Adaptive + interleaved thinking beta
- **Tool choice**: `{"auto": {}}` (Bedrock format, dict structure)
- **Token extraction**: `inputTokens` = non-cached only; separate `cacheReadInputTokenCount`/`cacheWriteInputTokenCount`
- **ARN support**: `extract_arn_region()` for ARN-based model IDs, URL-encoded via `quote(model_id, safe='')`

#### Bedrock Kimi (`bedrock_kimi_provider.py`)
- **API**: Bedrock InvokeModel API (`POST /model/{id}/invoke`), NOT Converse. Converse API rejects images for Kimi models.
- **Payload format**: OpenAI Chat Completions JSON (Kimi accepts this format)
- **Auth**: Bearer token (`BEDROCK_API_KEY`)
- **Parameters**: `temperature: 0.3`, `max_tokens: 8192`
- **Vision**: `image_url` content blocks with base64 data URIs

#### Kimi Direct (`kimi_provider.py`)
- Thin `OpenAIProvider` subclass
- `base_url`: `https://api.moonshot.ai/v1`
- Auth: `MOONSHOT_API_KEY`

### Pricing System (`pricing.py`)

```python
@dataclass(frozen=True)
class TokenPricing:
    input_per_m: float            # USD per 1M input tokens
    output_per_m: float           # USD per 1M output tokens
    reasoning_per_m: float        # USD per 1M reasoning tokens (if separate)
    cached_input_per_m: float     # USD per 1M cached input tokens (read from cache)
    cache_write_per_m: float      # USD per 1M tokens written to cache
    long_context_threshold: int   # Token count triggering long-context tier
    long_input_per_m: float       # Long-context input tier
    long_output_per_m: float      # Long-context output tier
    long_reasoning_per_m: float   # Long-context reasoning tier
    long_cached_input_per_m: float # Long-context cached input tier
    long_cache_write_per_m: float  # Long-context cache write tier
```

**Key pricing entries:**
| Model | Input/1M | Output/1M | Long-Context Threshold |
|---|---|---|---|
| GPT-5.4 | $2.50 | $15.00 | 272,000 tokens |
| Gemini 3.1 Pro (Standard) | $2.00 | $12.00 | 200,000 tokens |
| Gemini 3.1 Pro (Priority) | 1.8x Standard | 1.8x Standard | 200,000 tokens |
| Claude Opus 4.6 | $5.00 | $25.00 | N/A |
| Claude Opus 4.6 (cached) | $0.50/1M read | $6.25/1M write | N/A |
| Kimi | $0.72 | $3.60 | N/A |

> **Notes**:
> - Gemini has no cache write premium (`cache_write_per_m=0.0`), unlike Anthropic which charges for cache writes.
> - Gemini Priority pricing is 1.8x Standard across all fields (computed via `_scale_pricing()` helper).

**Cost calculation logic** (`compute_cost()`):
1. Check if total input tokens exceed long-context threshold → use long-context tier
2. Separate `text_output = output_tokens - reasoning_tokens` to prevent double-billing
3. Calculate: `input_cost + output_cost + reasoning_cost + cached_read_cost + cache_write_cost`
4. If API reports a cost directly, prefer that value (future-proofing)

---

## 9. Execution Engine

### Core Step Loop (`eval_runner.py::_execute_run()`)

For each run:

```
1. Load game with seed (seed_base + run_number)
2. Reset game, get initial observation
3. Build system prompt (cached via lru_cache)
4. Initialize ContextManager, Notepad, trace writer
5. FOR step in range(max_steps):
   a. text_obs = adapter.render_text()
   b. image_b64 = adapter.render_png_base64()  [if with_images]
   c. valid_actions = adapter.get_available_actions()
   d. turn_prompt = build_turn_prompt(text_obs, actions, notepad, step)
   e. context = ctx.get_context_within_budget(max_context_tokens)
   f. response = _call_provider_with_retry(provider, system, context, obs, actions, notepad, image)
   g. IF response.action == "SKIP":
        - Write to skips.jsonl
        - Feed rejection + error into conversation: "Your response could not be parsed. Try again."
        - Continue to next step (no game state change)
   h. TRY adapter.step(response.action):
        - On ValueError: feed error back, apply backoff
   i. new_score = adapter.get_score()
   j. Update conversation context
   k. Accumulate tokens + cost
   l. Write StepRecord to steps.jsonl, CSV, trace
   m. Emit step event (bridge mode)
   n. IF adapter.is_done() OR shutdown_event.is_set() OR budget_exceeded: BREAK
6. Write RunRecord to runs.jsonl, CSV summary, trace footer
7. Emit run_end event
```

### 3-Tier Retry (`_call_provider_with_retry()`)

Each API call is wrapped in a retry loop with up to `retry_attempts` (default 50) retries:

| Tier | Trigger | Wait Strategy | Rationale |
|---|---|---|---|
| 1. Rate Limit | HTTP 429, `RateLimitError`, `RESOURCE_EXHAUSTED`, quota strings | `_compute_minute_boundary_wait()`: aligns to next clock minute + 5-45s random jitter | API rate limits typically reset on minute boundaries |
| 2. Gemini Transient | HTTP 504/503, `DEADLINE_EXCEEDED`, `UNAVAILABLE` (only for Gemini provider classes) | 30-60s random wait | Google infrastructure hiccups resolve quickly |
| 3. General | All other exceptions | Exponential backoff: `backoff_base^attempt * (0.5 + random())`, capped at `retry_max_wait` (300s) | Standard exponential backoff for unknown failures |

The `_is_rate_limit_error()` detector is **universal** (provider-agnostic): checks exception class names, HTTP status codes, gRPC status strings, and error message content.

`_interruptible_sleep()` checks `shutdown_event.is_set()` periodically during waits.

### SKIP Handling

When the provider returns an unparseable response (no valid action extracted):
1. `response.action` is set to `"SKIP"`
2. The step is written to `skips.jsonl` (not `steps.jsonl`)
3. A rejection message is added to the conversation: `"Your response could not be parsed as a valid action. Valid actions are: [...]. Please respond with a JSON object containing an 'action' field."`
4. The game state does NOT change
5. Cost and tokens ARE still recorded

This enables **self-correction**: the model sees its mistake and the valid action list in context.

### Invalid Action Handling

If `adapter.step(action)` raises `ValueError` (action is parseable but illegal in current game state):
1. The error message is fed back into conversation context
2. A brief backoff is applied
3. The step continues (game state does NOT change)

---

## 10. Concurrency Model

### Three-Level Nested Parallelism

```
Level 1: Games          ThreadPoolExecutor(max_workers=min(parallel_games, 20))
  Level 2: Models       ThreadPoolExecutor(max_workers=len(model_keys)) per game
    Level 3: Runs       ThreadPoolExecutor(max_workers=min(parallel_runs, 10)) per model
```

### Thread Safety Mechanisms

| Mechanism | Scope | Purpose |
|---|---|---|
| `io_lock` (threading.Lock) | Per model within a game | Serializes all file writes (JSONL, CSV, traces) |
| `provider_semaphores` | Per provider type | Limits concurrent API calls (e.g., 16 for Anthropic) |
| `BudgetTracker._lock` | Global | Thread-safe cost accumulation |
| `CircuitBreaker._lock` | Per instance | Thread-safe state transitions |
| `JsonlWriter(lock=io_lock)` | Per writer | Thread-safe JSONL appends |
| `JSONL emitter lock` | Global (bridge mode) | Thread-safe stdout writes |

### Provider Semaphore Limits

```python
provider_max_concurrent = {
    "bedrock-claude": 8,
    "anthropic": 10,
    "gemini": 12,
    "gemini-fallback": 12,
    "openrouter-gemini": 12,
    "openai": 16,
    "bedrock-kimi": 32,
}
```

Multiple model keys sharing a provider type (e.g., `claude-a1` through `claude-a6` all → `"anthropic"`) share ONE semaphore.

---

## 11. Cost & Budget Management

### BudgetTracker (`budget.py`)

Thread-safe tracker with global + per-game USD limits.

```python
tracker = BudgetTracker(global_limit=50.0, per_game_limit=10.0)
tracker.record_cost("game_123", 0.05)
snapshot = tracker.check_budget("game_123")
# snapshot.is_over_global, snapshot.is_over_game, snapshot.global_remaining, etc.
```

### BudgetSnapshot (frozen dataclass)

```python
@dataclass(frozen=True)
class BudgetSnapshot:
    global_spent: float
    global_limit: float | None
    game_spent: float
    game_limit: float | None
    
    @property
    def global_remaining(self) -> float | None
    @property
    def game_remaining(self) -> float | None
    @property
    def is_over_global(self) -> bool
    @property
    def is_over_game(self) -> bool
```

### Budget Integration Points

1. **Pre-run check** (orchestrator): Before starting a model's runs, checks if budget is already exceeded
2. **Per-step accumulation** (eval_runner): After each API call, records cost via `event_emitter` callback
3. **Post-step check** (eval_runner): After recording cost, checks budget; breaks step loop if exceeded
4. **Exit code 2**: CLI exits with code 2 if budget caused termination

### _NO_BUDGET_TRIM_PROVIDERS

Defined in `orchestrator.py` as a `frozenset`. Large-context models (Gemini 1M, Claude 1M, OpenAI 1M) skip the context-budget token trimming since they're unlikely to exceed their context window. The sliding window (`--context-window`) still applies.

```python
_NO_BUDGET_TRIM_PROVIDERS = frozenset({
    "gemini", "gemini-fallback", "openrouter-gemini",
    "bedrock-claude", "anthropic", "openai"
})
```

When a model's provider is in this set, `token_budget` is set to `None`, effectively disabling the `context_manager.py` token-budget trimming.

---

## 12. Resilience Subsystems

### Circuit Breaker (`circuit_breaker.py`)

Per-provider circuit breaker prevents cascading failures:

```
CLOSED ──(threshold consecutive failures)──> OPEN
OPEN ──(half_open_seconds elapsed)──> HALF-OPEN
HALF-OPEN ──(single probe succeeds)──> CLOSED
HALF-OPEN ──(probe fails)──> OPEN
```

**Parameters:**
- `threshold`: 10 consecutive failures (configurable)
- `half_open_seconds`: 300.0s cooldown (configurable)
- Single-probe guard: Only one thread can probe in HALF-OPEN state (via `_probing` dict)

### Graceful Shutdown (`shutdown.py`)

`CompositeShutdownEvent` — OR semantics across multiple `threading.Event` objects:

```python
# Hierarchy: global → game → model
composite = CompositeShutdownEvent([global_event, game_event, model_event])
composite.is_set()  # True if ANY event is set
composite.set()     # Sets the LAST (most-specific) event
composite.wait(timeout)  # Polls at 100ms intervals
```

### File-Based Cancellation (`cancel_watcher.py`)

Daemon thread polls the `cancel/` directory every 2 seconds for sentinel files:

| Sentinel File | Effect |
|---|---|
| `CANCEL_ALL` | Sets global shutdown event |
| `DRAIN` | Sets drain event (finish current runs, don't start new ones) |
| `CANCEL_{game_id}` | Sets per-game shutdown event |
| `CANCEL_{game_id}_{model_key}` | Sets per-model shutdown event |

**Priority**: `CANCEL_ALL` > `DRAIN` > per-game > per-model

### Signal Handling (`evaluate.py`)

- `SIGINT` (Ctrl+C): Sets global shutdown event, exit code 130
- `SIGTERM`: Sets global shutdown event, exit code 130

---

## 13. Resume & Recovery

### Resume Flow (`--resume` flag)

1. `find_latest_session(output_dir)` → locates most recent session directory by timestamp
2. `scan_completed_runs(session_dir, num_runs)` → returns `dict[(game_id, safe_model), frozenset[int]]` mapping each (game, model) pair to its set of completed 1-indexed run numbers
3. `truncate_stale_data(session_dir, completed_runs)` → atomic cleanup of incomplete/error run data
4. Resume evaluation with `skip_runs` parameter → only executes missing run numbers

### Run Completion Criteria (`_is_run_complete()`)

A run is "complete" if:
- `solved == True`, OR
- `error` is absent AND `total_steps >= max_steps` (exhausted all steps)

A run is "incomplete" (will be retried) if:
- `error` is present, OR
- `total_steps < max_steps` AND `solved == False` (early exit, e.g., shutdown)

### Truncation (`truncate_stale_data()`)

For incomplete runs detected during resume:
1. Purge incomplete/error run records from `runs.jsonl`
2. Collect `run_id` values of purged runs
3. Filter `steps.jsonl`, `skips.jsonl`, CSV files, and traces to remove records matching purged `run_id`s
4. All writes use **atomic file operations**: write to temp file → `os.replace()` → original is safely replaced

### Scoping

`truncate_stale_data()` accepts optional `game_ids` and `safe_model_names` parameters for scoped cleanup, enabling parallel terminal sessions to clean different subsets without conflicts.

---

## 14. Data Schemas & Output Format

### StepRecord (24+ fields)

```python
@dataclass
class StepRecord:
    run_id: str                # Unique per-execution identifier: "{model_name}_{game_id}_run{N}" (e.g., "GPT 5.4 Thinking_cc01_run1")
    model: str                 # Model display name
    game_id: str               # Game identifier
    game_type: str             # "arc2" or "arc3"
    run_number: int            # 1-indexed run number
    step: int                  # 0-indexed step number
    action: str                # Action taken (or "SKIP")
    score: float               # Score after this step
    level: int                 # Current level
    total_levels: int          # Total levels
    done: bool                 # Game complete?
    state: str                 # Machine-readable game state
    cumulative_cost_usd: float # Running cost total
    input_tokens: int          # Non-cached input tokens
    output_tokens: int         # Output tokens (includes reasoning)
    notepad_length: int        # Current notepad size
    reasoning: str             # Model's reasoning text
    notepad_contents: str      # Full notepad text
    observation: str           # Text observation shown to model
    game_feedback: str         # Feedback from game.step()
    score_pct: float           # Score as percentage
    step_cost_usd: float       # Cost of this step
    reasoning_tokens: int      # Dedicated reasoning tokens
    cached_input_tokens: int = 0    # Tokens from cache
    cache_write_tokens: int = 0     # Tokens written to cache
```

### RunRecord (21+ fields)

```python
@dataclass
class RunRecord:
    run_id: str
    model: str
    game_id: str
    game_type: str
    run_number: int
    total_steps: int           # Steps taken this run
    max_steps: int             # Step limit
    final_score: float         # Final score (0.0-1.0)
    solved: bool               # Did model solve the puzzle?
    levels_completed: int      # Levels completed
    cost_usd: float            # Total run cost
    total_input_tokens: int
    total_output_tokens: int
    total_reasoning_tokens: int
    elapsed_seconds: float     # Wall-clock time
    notepad_final: str         # Final notepad state
    error: str | None          # Error message if run failed
    model_id: str              # API model identifier
    seed: int                  # Seed used for this run
    final_score_pct: float     # Score as percentage
    total_cached_input_tokens: int = 0
    total_cache_write_tokens: int = 0
    reset_count: int = 0       # Times model issued RESET
```

### to_event_dict()

Both `StepRecord` and `RunRecord` have `to_event_dict()` methods that produce lightweight dictionaries for SSE transmission:
- **Omits** large text fields: `reasoning`, `notepad_contents`, `observation`, `game_feedback`, `notepad_final`
- **Includes** all numeric fields, token counts, caching metrics, costs

### Output File Structure

```
data/puzzle-evals/{YYYYMMDD_HHMMSS_ffffff}/
  logs/
    eval_{timestamp}.log               # Full debug log
  game_metadata.json                   # Array of delivery-schema metadata for all games
  cancel/                              # Sentinel directory for cancellation
  {game_id}/
    metadata.json                      # Game info: title, levels, tags, difficulty
    {safe_model_name}/
      runs.jsonl                       # One RunRecord per run
      steps.jsonl                      # One StepRecord per step (all runs)
      skips.jsonl                      # SKIP sentinel records
      token_usage.csv                  # Per-step: run_id, model, game_id, run_number, step,
                                       #   input_tokens, output_tokens, reasoning_tokens,
                                       #   cached_input_tokens, cache_write_tokens,
                                       #   step_cost_usd, cumulative_cost_usd, action, score, state
      token_usage_summary.csv          # Per-run: run_id through elapsed_seconds
    traces/
      {safe_model_name}_trace.jsonl    # Full trajectory: header -> step -> ... -> summary per run
      {safe_model_name}_raw_responses.jsonl  # Full API responses (optional, --save-raw-responses)
```

### Game Metadata Schema (12 fields)

Written to `game_metadata.json` by `build_delivery_metadata()`:

```json
{
  "game_id": "abc123",
  "game_type": "arc3",
  "title": "Puzzle Name",
  "tags": ["spatial", "color"],
  "total_levels": 3,
  "difficulty": "medium",
  "baseline_actions": 45,
  "grid_width": 10,
  "grid_height": 10,
  "grid_cells": 100,
  "available_actions": ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "RESET", "CLICK x y"],
  "human_solve_time_seconds": 120.0,
  "human_turns_per_level": 15.0
}
```

---

## 15. JSONL Stdout Protocol (TS Bridge)

When `--stdout-jsonl` is active, all Python logs redirect to stderr, and structured events emit on stdout (one JSON object per line, thread-safe via lock).

### Event Types

| Event | Payload | When |
|---|---|---|
| `session_start` | `{session_id, games, models, num_runs, max_steps, seed_base, total_runs_planned, parallel_games, parallel_runs}` | Once at startup |
| `games_list` | `[{game_id, game_type, title, ...}]` | Only with `--list-games` |
| `run_start` | `{game_id, model, run_number, seed}` | Before each run |
| `step` | `StepRecord.to_event_dict()` (lightweight) | After each LLM call |
| `run_end` | `RunRecord.to_event_dict()` | After each run completes |
| `session_end` | `{session_id, total_runs, total_steps, total_cost_usd, elapsed_seconds, exit_code}` | After all runs |
| `error` | `{game_id, model, run_number, error}` | On unrecoverable failure |
| `log` | `{level, message}` | Informational messages |

### Event Format

```json
{"type": "step", "data": {"run_id": "...", "model": "...", "game_id": "...", "step": 5, "action": "UP", "score": 0.33, "input_tokens": 1500, ...}}
```

### Integration Contract

The TypeScript server (`server/`) spawns the Python process, reads stdout line-by-line, and forwards events to browser clients via Server-Sent Events (SSE). Changes to this protocol require coordinated updates to both the Python emitter and the TypeScript consumer.

---

## 16. Prompt Engineering

### System Prompt (`prompt_builder.py::build_system_prompt()`)

Cached via `lru_cache(maxsize=16)` — one per (game_type, max_steps, context_window, with_images) combination.

#### ARC3 System Prompt

Instructs the model to:
- Play an interactive puzzle game with multi-level progression
- Use 16 colors (0-15) in grid observations
- Available actions: `RESET`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `CLICK x y`, `ACTION7`
- Use the notepad (4000 chars) for persistent notes across steps
- Respond in JSON format: `{"action": "...", "reasoning": "...", "notepad": "..."}`
- If `--with-images`: mentions that a screenshot is attached

#### ARC2 System Prompt

Instructs the model to:
- Identify the pattern in training input/output pairs
- Apply the pattern to construct the test output grid
- Use 10 colors (0-9) in the grid
- Available actions: `SET_CELL row col value`, `SET_ROW row v0 v1 ...`, `MOVE_*`, `SUBMIT`, `RESET_GRID`
- Use `SUBMIT` when confident the output grid is correct

### Turn Prompt (`build_turn_prompt()`)

Each step prompt includes:
1. Step counter: `"Step {n}/{max_steps}"`
2. Current observation (text rendering of game state)
3. Available actions (capped at 30 displayed, with overflow note)
4. Current notepad contents
5. Expected response format (JSON with action, reasoning, optional notepad)

---

## 17. Scoring Semantics

### ARC3 Scoring

- `score = levels_completed / total_levels`
- Range: 0.0 to 1.0
- A game is "solved" when `score == 1.0` (all levels completed)
- Scoring is by level progression, not per-step correctness

### ARC2 Scoring

- `score = correct_cells / total_cells`
- Range: 0.0 to 1.0 (continuous)
- Each cell matching the ground truth output contributes equally
- `SUBMIT` finalizes the answer but doesn't affect score calculation (score is always the current grid correctness)

### Relationship to Official ARC-AGI Scoring

**Important**: The harness's per-step scoring is for evaluation tracking purposes. The official ARC-AGI competition scoring (as defined in `arc-agi-benchmarking/scoring.py`) works differently:

- Official: 2 attempts per test case, binary pass/fail per test case (either attempt matches ground truth = solved), task score = solved_cases / total_cases, submission score = average across tasks
- Harness: Continuous score tracking per step, multiple runs per game for statistical robustness, cost tracking

The harness scoring provides a richer signal (how close did the model get?) whereas official scoring is binary (did it get the exact answer?).

---

## 18. Visualization & Utilities

### Plot Generation (`plot_results.py`)

Generates 2 PNG charts per session:

**Plot 1: Score Over Steps**
- X-axis: step number
- Y-axis: score (0.0-1.0)
- Lines: mean score per model with min/max confidence bands
- Dark theme: `#0a0a0a` background, `#00ff41` accent

**Plot 2: Score vs Cost**
- X-axis: cumulative cost (USD)
- Y-axis: final score
- Points: one dot per run, colored by model
- Same dark theme

CLI: `python -m scripts.evaluate.plot_results --latest` or `--session {prefix}`

### Cost Calculator (`cost_calculator.py`)

Interactive standalone CLI for estimating evaluation costs before running:
- Input: model, expected tokens
- Output: itemized cost breakdown (input, output, reasoning, caching)

### Fix Scripts (One-Off)

- `fix_score_overflow.py`: Fixes GPT-5.4 data where score exceeded 1.0. Truncates steps after first score >= 1.0, caps all scores, fixes runs/CSV/traces atomically.
- `cleanup_orphaned_steps.py`: Removes step/skip/CSV records whose `run_id` doesn't appear in `runs.jsonl`. Handles both eval session and delivery export layouts. Supports `--dry-run`.

---

## 19. Test Suite

### Overview

10 test files, ~3,500 total lines. Run with:

```bash
pytest scripts/evaluate/tests/ -v
```

### Test Files

| File | Lines | Coverage Area |
|---|---|---|
| `conftest.py` | 227 | Shared fixtures (`tmp_output_dir`, `sample_session_dir`), mock providers (`_FailingProvider`, `_SlowProvider`, `_MalformedResponseProvider`, `_IntermittentProvider`), `_make_run_record()` helper |
| `test_resume.py` | 979 | `_is_run_complete` (8 classification cases), `scan_completed_runs` (frozenset return, session scoping, cross-session union, num_runs cap), truncation (steps/CSV/traces cleanup), atomic write safety, adversarial inputs (corrupt JSONL, binary garbage, empty lines, wrong types, missing fields, negative/duplicate run_numbers, readonly dirs) |
| `test_parallel_runs.py` | 1,038 | Correctness (count, unique numbers, all solved), file I/O (JSONL integrity, steps per run, CSV row counts, trace header/footer counts), skip_runs exclusion, shutdown (before-start -> 0 runs, mid-execution -> partial), thread safety (8 parallel, no corruption), event emitter counts, sequential fallback, provider failure modes (always-fail, intermittent, slow+shutdown, negative cost, None action) |
| `test_integration_pipeline.py` | 500 | Full pipeline: run -> scan -> truncate -> re-run with skip. Simulated interruption recovery. Error run truncation. Parallel pipeline (5 runs -> scan -> re-run=0). Corrupt JSONL recovery. |
| `test_budget.py` | 162 | `BudgetSnapshot` property tests, `BudgetTracker` accumulation, concurrent writes, adversarial (negative/zero/NaN/Inf cost, empty game_id) |
| `test_circuit_breaker.py` | 185 | CLOSED -> OPEN -> HALF-OPEN full cycle, success resets, probe slot exclusivity, independent providers, rapid open/close 10x, 10 concurrent threads |
| `test_cancel_watcher.py` | 231 | CANCEL_ALL/game/model sentinel detection, isolation, None model_shutdowns, watcher exit, adversarial (directory sentinel, rapid create/delete race) |
| `test_shutdown.py` | 145 | CompositeShutdownEvent OR semantics, set targets last, wait timeout/wakeup, single event, adversarial (double set, zero/negative timeout) |
| `test_toml_config.py` | 184 | TOML parsing, CLI merge (CLI wins), frozen dataclass, adversarial (binary, wrong types, negative values, empty, unknown keys, unicode) |
| `test_bedrock_arn.py` | 225 | ARN extraction, URL encoding, `pricing_model_id` registry verification, API cost preference over local compute, adversarial (empty/wrong-prefix/missing-region ARN, unknown model pricing) |
| `test_client_spec_updates.py` | 283 | `num_runs` default=3, `context_window` default=50, text-only default (no image reference in prompt), `--with-images` flag, `cache_write_tokens` in StepRecord/RunRecord/event_dict, CLI defaults, no-image integration spy |

### Mock Providers (conftest.py)

| Mock | Behavior |
|---|---|
| `_FailingProvider` | Always raises exception |
| `_SlowProvider` | Sleeps before responding (tests shutdown during API calls) |
| `_MalformedResponseProvider` | Returns unparseable JSON (tests SKIP handling) |
| `_IntermittentProvider` | Alternates between success and failure (tests retry/recovery) |

---

## 20. External Dependencies

### requirements.txt

```
arcengine>=0.9.3          # ARC-AGI-3 game environments
openai>=1.50.0            # OpenAI API client
anthropic>=0.40.0         # Anthropic API client
google-genai>=1.0.0       # Google Gemini genai SDK
pillow>=10.0.0            # PNG image rendering
numpy>=1.26.0             # Array operations for game rendering
matplotlib>=3.8.0         # Chart generation
pytest>=7.0.0             # Test framework
pytest-timeout>=2.0.0     # Test timeout safety
```

### Implicit Dependencies

| Library | Source | Used For |
|---|---|---|
| `requests` | stdlib-adjacent | Bedrock HTTP calls (raw, no boto3) |
| `tomllib` | stdlib (Python 3.11+) | TOML config parsing |
| `importlib` | stdlib | Dynamic game module loading |
| `concurrent.futures` | stdlib | ThreadPoolExecutor for parallelism |
| `threading` | stdlib | Locks, Events, daemon threads |
| `json` | stdlib | JSONL serialization |
| `csv` | stdlib | CSV writing |
| `pathlib` | stdlib | File path handling |
| `argparse` | stdlib | CLI argument parsing |
| `logging` | stdlib | Structured logging |
| `signal` | stdlib | SIGINT/SIGTERM handling |
| `hashlib` | Not used | (Referenced in official ARC-AGI benchmarking, not in this harness) |

---

## 21. Environment Variables

| Variable | Required By | Purpose |
|---|---|---|
| `GEMINI_STUDIO_API_KEY` | `gemini-3.1`, `gemini-3.1-studio` | Google AI Studio API key |
| `GEMINI_API_KEY` | `gemini-3.1-standard`, `gemini-3.1-priority`, fallback tiers 2/3 | Vertex AI API key |
| `OPENROUTER_API_KEY` | `gemini-3.1-openrouter` | OpenRouter API key |
| `GPT_API_KEY` | `gpt-5.4-thinking` | OpenAI API key |
| `BEDROCK_API_KEY` | All `bedrock-*` models | AWS Bedrock bearer token |
| `AWS_REGION` | Bedrock providers | AWS region (default: `us-east-1`) |
| `BEDROCK_CLAUDE_ARN` | `claude-bedrock-arn` | Application Inference Profile ARN |
| `BEDROCK_CLAUDE_ARN_2` | `claude-bedrock-arn2` | Second ARN for load distribution |
| `BEDROCK_KIMI_ARN` | `kimi-bedrock-arn` | Kimi ARN for Bedrock |
| `ANTHROPIC_API_KEY_1` .. `_6` | `claude-a1` .. `claude-a6` | 6 Anthropic accounts for load distribution |
| `MOONSHOT_API_KEY` | `KimiProvider` (direct) | Moonshot AI API key |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI (optional) | GCP project ID |

All variables are loaded via `dotenv` from the project root `.env` file.

---

## 22. Known Architectural Constraints

### 1. Bedrock Kimi Uses InvokeModel, NOT Converse
The Bedrock Converse API rejects image content blocks for Kimi models. `BedrockKimiProvider` uses the lower-level InvokeModel API with OpenAI Chat Completions payload format instead. This is a hard constraint, not a design choice.

### 2. Gemini Priority Tier Requires SDK Monkey-Patching
Vertex AI Priority endpoint requires patching `_client._api_client._http_options.api_version` to `"v1/publishers/google"` post-initialization. A stability guard (`assert hasattr(...)`) will raise if the google-genai SDK changes its internal structure. This is fragile by necessity.

### 3. ARC2 Environment Path Has a Typo
The ARC-AGI-2 environment files live at `puzzle-environments/ARC-AGI-2/enviornment_files/` (note: "enviornment" is misspelled). This typo is **load-bearing** — the path must match the actual directory name.

### 4. Anthropic tool_choice Must Be "auto" With Thinking
When adaptive thinking is enabled, Anthropic's API requires `tool_choice: "auto"`. The `"required"` or `"any"` values are not compatible with thinking mode. This means the model may choose not to call the tool, requiring fallback parsing.

### 5. GAME_OVER Is NOT Terminal in ARC3
When an ARC3 game enters `GAME_OVER` state, the model can issue `RESET` to retry. This is intentional — it allows the model to learn from failure and try alternative approaches within the same run.

### 6. Module Class Caching vs Instance Separation
`_MODULE_CLASS_CACHE` in `game_loader.py` caches imported module classes and metadata but **never caches game instances**. This is critical for parallel execution — each run must get a fresh game instance with its own seed and state.

### 7. Context Window vs Token Budget
Two independent mechanisms limit what the model sees:
- **Context window** (`--context-window`): Sliding window of N most recent conversation turns (messages)
- **Token budget** (`max_context_tokens` from model config): Adaptive trimming that drops oldest turn pairs until estimated tokens fit within 90% of the model's context window

Both are applied in sequence: sliding window first, then token budget trimming.

### 8. Resume Uses run_id, Not run_number
The resume system's `truncate_stale_data()` filters by `run_id` (format: `"{model_name}_{game_id}_run{N}"`, unique per execution), not `run_number` (1-indexed, reused across resume cycles). This prevents false matches when a run_number is reused in a new execution.

---

## Appendix A: Complete File Inventory

```
scripts/evaluate/
  __init__.py                          # Empty
  evaluate.py                          # 507 lines - CLI entry point
  config.py                            # 441 lines - Model registry + config
  orchestrator.py                      # 419 lines - Parallel dispatch
  game_adapter.py                      # 528 lines - Game environment abstraction
  game_loader.py                       # 352 lines - Game discovery + loading
  resume.py                            # 477 lines - Crash recovery
  budget.py                            # 91 lines  - Cost tracking
  cancel_watcher.py                    # 92 lines  - File-based cancellation
  circuit_breaker.py                   # 114 lines - Provider fault tolerance
  shutdown.py                          # 63 lines  - Composite shutdown events
  toml_config.py                       # 192 lines - TOML config loading
  cost_calculator.py                   # 121 lines - Standalone cost estimator
  plot_results.py                      # 384 lines - Visualization
  fix_score_overflow.py                # 212 lines - One-off data fix
  cleanup_orphaned_steps.py            # 276 lines - One-off maintenance
  eval.toml                            # 22 lines  - Config template
  requirements.txt                     # 9 lines   - Dependencies
  
  runner/
    __init__.py                        # Empty
    eval_runner.py                     # 886 lines - Core step loop
    prompt_builder.py                  # 152 lines - Prompt construction
    context_manager.py                 # 111 lines - Sliding window + token budget
    notepad.py                         # 37 lines  - Persistent scratchpad
    trace_writer.py                    # 73 lines  - Trajectory logging
  
  providers/
    __init__.py                        # Empty
    base.py                            # 174 lines - Provider ABC + parsing
    pricing.py                         # 199 lines - Token cost calculation
    openai_provider.py                 # 421 lines - OpenAI (dual-path)
    anthropic_claude_provider.py       # 291 lines - Native Anthropic
    gemini_provider.py                 # 298 lines - Google Gemini
    gemini_fallback_provider.py        # 131 lines - Gemini tier fallback
    openrouter_gemini_provider.py      # 58 lines  - Gemini via OpenRouter
    bedrock_claude_provider.py         # 279 lines - Claude via Bedrock
    bedrock_kimi_provider.py           # 220 lines - Kimi via Bedrock
    kimi_provider.py                   # 37 lines  - Kimi direct
    bedrock_utils.py                   # 21 lines  - ARN utility
  
  data/
    __init__.py                        # Empty
    schemas.py                         # 139 lines - StepRecord + RunRecord
    writer.py                          # 82 lines  - JSONL writer
  
  tests/
    __init__.py                        # Empty
    conftest.py                        # 227 lines - Fixtures + mock providers
    test_resume.py                     # 979 lines
    test_parallel_runs.py              # 1,038 lines
    test_integration_pipeline.py       # 500 lines
    test_budget.py                     # 162 lines
    test_circuit_breaker.py            # 185 lines
    test_cancel_watcher.py             # 231 lines
    test_shutdown.py                   # 145 lines
    test_toml_config.py                # 184 lines
    test_bedrock_arn.py                # 225 lines
    test_client_spec_updates.py        # 283 lines
```

**Total**: ~8,900 lines of production code + ~4,200 lines of tests = ~13,100 lines

---

## Appendix B: Model Registry

18 model configurations in `config.py::MODEL_REGISTRY`:

| Key | Model ID | Provider | Context | Vision | Reasoning |
|---|---|---|---|---|---|
| `gemini-3.1` | `gemini-3.1-pro-preview` | gemini-fallback | 1M | Yes | None |
| `gemini-3.1-studio` | `gemini-3.1-pro-preview` | gemini | 1M | Yes | None |
| `gemini-3.1-standard` | `gemini-3.1-pro-preview` | gemini | 1M | Yes | None |
| `gemini-3.1-priority` | `gemini-3.1-pro-preview` | gemini | 1M | Yes | None |
| `gemini-3.1-openrouter` | `google/gemini-3.1-pro-preview` | openrouter-gemini | 1M | Yes | None |
| `gpt-5.4-thinking` | `gpt-5.4` | openai | 1M | Yes | high |
| `claude-bedrock` | `global.anthropic.claude-opus-4-6-v1` | bedrock-claude | 1M | Yes | None |
| `claude-bedrock-arn` | `{BEDROCK_CLAUDE_ARN}` | bedrock-claude | 1M | Yes | None |
| `claude-bedrock-arn2` | `{BEDROCK_CLAUDE_ARN_2}` | bedrock-claude | 1M | Yes | None |
| `kimi-bedrock` | `moonshotai.kimi-k2.5` | bedrock-kimi | 1M | Yes | None |
| `kimi-bedrock-arn` | `{BEDROCK_KIMI_ARN}` | bedrock-kimi | 256K | Yes | None |
| `claude-a1` | `claude-opus-4-6` | anthropic | 1M | Yes | None |
| `claude-a2` | `claude-opus-4-6` | anthropic | 1M | Yes | None |
| `claude-a3` | `claude-opus-4-6` | anthropic | 1M | Yes | None |
| `claude-a4` | `claude-opus-4-6` | anthropic | 1M | Yes | None |
| `claude-a5` | `claude-opus-4-6` | anthropic | 1M | Yes | None |
| `claude-a6` | `claude-opus-4-6` | anthropic | 1M | Yes | None |

---

## Appendix C: Configuration Constants

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `EvalConfig.max_steps` | 200 | config.py | Default steps per run |
| `EvalConfig.num_runs` | 3 | config.py | Default runs per model per game |
| `EvalConfig.context_window` | 50 | config.py | Default conversation turns visible |
| `EvalConfig.seed_base` | 42 | config.py | Base random seed |
| `EvalConfig.retry_attempts` | 50 | config.py | Max API call retries |
| `EvalConfig.retry_backoff_base` | 1.5 | config.py | Exponential backoff base |
| `EvalConfig.retry_max_wait` | 300.0 | config.py | Max backoff wait (seconds) |
| `OrchestratorConfig.circuit_threshold` | 10 | orchestrator.py | Failures to trip circuit breaker |
| `OrchestratorConfig.circuit_half_open_seconds` | 300.0 | orchestrator.py | Circuit breaker cooldown |
| `Notepad.max_chars` | 4000 | runner/notepad.py | Notepad character limit |
| `_MAX_PARALLEL_GAMES` | 20 | orchestrator.py | Hard cap on game parallelism |
| `_MAX_PARALLEL_RUNS` | 10 | evaluate.py | Hard cap on run parallelism |
| `MAX_SESSIONS_TO_SCAN` | 20 | resume.py | Resume session discovery limit |
| `_CHARS_PER_TOKEN` | 1.2 | context_manager.py | Token estimation ratio |
| `_BUDGET_SAFETY_FACTOR` | 0.90 | context_manager.py | Context budget safety margin |
| `cancel_watcher poll interval` | 2.0s | cancel_watcher.py | Sentinel polling frequency |
| `CompositeShutdownEvent poll` | 0.1s | shutdown.py | Shutdown check interval |

---

*End of Feature Specification*
