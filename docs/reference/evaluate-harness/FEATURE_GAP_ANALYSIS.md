# Feature Gap Analysis: Python Eval Harness vs TypeScript Harnesses

**Author**: Claude Opus 4.6
**Date**: 2026-03-27
**Companion to**: [FEATURE_LIST.md](./FEATURE_LIST.md) | [FEATURE_SPEC.md](./FEATURE_SPEC.md)
**Purpose**: Reference checklist mapping all 22 Python eval harness features against the two TypeScript harnesses, with gap descriptions and an implementation roadmap.

---

## Harness Key

| Abbreviation | Harness | Key Files |
|---|---|---|
| **PY** | Python eval harness | `scripts/evaluate/` (~8,900 lines) |
| **TS-NS** | TypeScript Non-SDK | `Arc3StreamService`, `Arc3RealGameRunner`, `Arc3OpenAIStreamService` |
| **TS-SDK** | TypeScript Agent SDK | `agentSdk/AgentSdkRunner`, `AgentSdkStreamService`, `providerRegistry` |

## Status Icons

| Icon | Meaning |
|---|---|
| :white_check_mark: | Done — feature parity achieved |
| :large_orange_diamond: | Partial — core functionality exists but missing sub-features |
| :twisted_rightwards_arrows: | Different — solved via an alternative approach |
| :x: | Missing — not implemented |

---

## Master Comparison Table

| # | Feature | PY | TS-NS | TS-SDK | Priority |
|---|---------|:---:|:---:|:---:|:---:|
| 1 | Multi-Model Testing | :white_check_mark: | :white_check_mark: | :white_check_mark: | — |
| 2 | Two Puzzle Formats (ARC2+ARC3) | :white_check_mark: | :x: | :x: | P2 |
| 3 | 3-Level Parallel Execution | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P1 |
| 4 | Cost Tracking + Budget Controls | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P1 |
| 5 | Crash Recovery + Resume | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P2 |
| 6 | Graceful Shutdown | :white_check_mark: | :x: | :x: | P1 |
| 7 | 3-Tier Retry + Error Recovery | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P2 |
| 8 | Circuit Breaker | :white_check_mark: | :x: | :x: | P2 |
| 9 | Self-Correction (SKIP re-prompt) | :white_check_mark: | :twisted_rightwards_arrows: | :twisted_rightwards_arrows: | P3 |
| 10 | Detailed Data Recording | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P1 |
| 11 | Real-Time Event Stream | :white_check_mark: | :white_check_mark: | :white_check_mark: | — |
| 12 | Visualization (PNG charts) | :white_check_mark: | :x: | :x: | P3 |
| 13 | Smart Context Management | :white_check_mark: | :x: | :x: | P2 |
| 14 | Notepad / Scratchpad | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P3 |
| 15 | Prompt Caching Optimization | :white_check_mark: | :twisted_rightwards_arrows: | :twisted_rightwards_arrows: | P3 |
| 16 | Config Flexibility (CLI+TOML) | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P2 |
| 17 | Dry Run Mode | :white_check_mark: | :x: | :x: | P3 |
| 18 | Game Discovery | :white_check_mark: | :x: | :x: | P2 |
| 19 | Per-Model Scoring | :white_check_mark: | :white_check_mark: | :white_check_mark: | — |
| 20 | Test Suite (~3,500 lines) | :white_check_mark: | :x: | :x: | P1 |
| 21 | Data Integrity Safeguards | :white_check_mark: | :large_orange_diamond: | :large_orange_diamond: | P2 |
| 22 | Cost Estimation Tool | :white_check_mark: | :x: | :x: | P3 |

**Summary**: 3 Done, 8 Partial, 3 Different, 8 Missing across both TS harnesses.

---

## Per-Feature Gap Analysis

### Feature 1: Multi-Model Testing

**Python capability**: 18 model configurations across 6 providers (OpenAI, Anthropic, Google Gemini, AWS Bedrock, Moonshot Kimi, OpenRouter). Runs same puzzle against many models simultaneously.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :white_check_mark: Done | Supports OpenAI models via Responses API. Model selection via `config.model` parameter. |
| TS-SDK | :white_check_mark: Done | 4 models in `providerRegistry.ts`: Claude Opus 4.6 (Bedrock), Kimi K2.5 (Bedrock), Gemini 3.1 Pro (Vertex), GPT 5.4 (OpenAI). Uses `aisdk()` wrapper. |

**Gap**: None for core functionality. TS-SDK covers fewer provider configs (4 vs 18) but the architecture supports adding more via `MODEL_REGISTRY`.

---

### Feature 2: Two Puzzle Formats (ARC2 + ARC3)

**Python capability**: `Arc3GameAdapter` for interactive ARC-AGI-3 games, `Arc2TaskAdapter` for grid-based ARC-AGI-2 tasks. Each has distinct actions, scoring, and rendering.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | Only supports ARC-AGI-3 interactive games via `Arc3ApiClient`. No `Arc2TaskAdapter` equivalent. |
| TS-SDK | :x: Missing | Same — only ARC-AGI-3 via `Arc3ApiClient`. |

**Gap**: Both TS harnesses only support ARC-AGI-3. Porting requires:
- [ ] Implement `Arc2TaskAdapter` in TypeScript (grid builder with `SET_CELL`, `SET_ROW`, `SUBMIT`, `RESET_GRID` actions)
- [ ] Add ARC-2 JSON task loading (read training/test pairs from `data/`)
- [ ] Add continuous cell-level scoring (`correct_cells / total_cells`)
- [ ] Add ARC-2 system/turn prompt builder
- [ ] Add ARC-2 text rendering (10-color palette)

**Reference**: `game_adapter.py:Arc2TaskAdapter` (lines 200-528)

---

### Feature 3: 3-Level Parallel Execution

**Python capability**: Three nested `ThreadPoolExecutor` levels: games (max 20) x models (all parallel) x runs (max 10). Per-provider semaphores limit concurrent API calls.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | Client-side can launch multiple sessions concurrently. No server-side orchestration of parallel games/models/runs. Each SSE session runs one (game, model) pair. |
| TS-SDK | :large_orange_diamond: Partial | Same architecture — one session = one (game, model) pair. Parallelism is client-driven. |

**Gap**: Server-side parallel orchestration is missing. Porting requires:
- [ ] `EvalOrchestrator` service: accepts game IDs + model keys + run count, dispatches in parallel
- [ ] Per-provider concurrency limiters (semaphores / `p-limit`)
- [ ] Aggregation of results across parallel runs
- [ ] Worker pool management with configurable limits

**Reference**: `orchestrator.py` (419 lines), specifically `run_all_games()` and `_execute_model()`

---

### Feature 4: Cost Tracking + Budget Controls

**Python capability**: `BudgetTracker` with thread-safe global + per-game USD limits. Tracks input, output, reasoning, cached, and cache-write tokens. Budget checked pre-run and post-step. Exit code 2 on budget exhaustion.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | Token counts tracked via Agents SDK `usage` (inputTokens, outputTokens, totalTokens). No budget enforcement — runs until completion or maxTurns. No per-step cost accumulation. No cached/reasoning token breakdown. |
| TS-SDK | :large_orange_diamond: Partial | Same — usage tracked via `result.state._context.usage`. No budget caps, no per-step cost recording, no pricing model. |

**Gap**: Cost is tracked but budgets are not enforced. Porting requires:
- [ ] `BudgetTracker` service with global + per-game USD limits
- [ ] Per-step cost calculation using a pricing model (port `pricing.py`)
- [ ] Budget pre-check before starting a run
- [ ] Budget post-step check with graceful termination
- [ ] Separate tracking: input, output, reasoning, cached_input, cache_write tokens
- [ ] Cost breakdown in run summaries and SSE events

**Reference**: `budget.py` (91 lines), `providers/pricing.py` (199 lines)

---

### Feature 5: Crash Recovery + Resume

**Python capability**: `--resume` flag finds latest session, scans completed runs, skips them, truncates stale/partial data atomically, re-runs only missing runs.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | Supports session continuation via `existingGameGuid` + `previousResponseId` + `seedFrame`. This is conversation chaining, not crash recovery — cannot resume a batch of interrupted eval runs. |
| TS-SDK | :large_orange_diamond: Partial | Same continuation mechanism. No scan-and-resume across multiple runs. |

**Gap**: Both harnesses support continuing a single game session, but lack:
- [ ] Session directory scanning (`find_latest_session`)
- [ ] Run completion detection (`_is_run_complete` — check solved vs error vs steps exhausted)
- [ ] Stale data truncation (atomic JSONL/CSV filtering by `run_id`)
- [ ] Skip-completed-runs logic in orchestrator
- [ ] Atomic file operations (temp file + rename pattern)

**Reference**: `resume.py` (477 lines)

---

### Feature 6: Graceful Shutdown

**Python capability**: Ctrl+C sets global shutdown event. File-based cancellation via sentinel files (`CANCEL_ALL`, `CANCEL_{game}`, `CANCEL_{game}_{model}`, `DRAIN`). `CompositeShutdownEvent` with OR semantics across hierarchy.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | Sessions can be cancelled individually via `cancelSession(sessionId)` which tears down SSE. No global shutdown coordination, no file-based cancellation, no drain mode. |
| TS-SDK | :x: Missing | Same — individual `cancelSession()` only. |

**Gap**: No coordinated shutdown mechanism. Porting requires:
- [ ] `ShutdownCoordinator` service with global/per-game/per-model event hierarchy
- [ ] `SIGINT`/`SIGTERM` handlers that set global shutdown
- [ ] File-based cancellation watcher (sentinel directory polling)
- [ ] Drain mode (finish current, don't start new)
- [ ] Integration with step loop to check `shutdownEvent.isSet()` between steps

**Reference**: `shutdown.py` (63 lines), `cancel_watcher.py` (92 lines), `evaluate.py` signal handling

---

### Feature 7: 3-Tier Retry + Error Recovery

**Python capability**: Up to 50 retries per API call with 3 tiers: rate-limit (minute-boundary wait + jitter), Gemini-transient (30-60s), general (exponential backoff capped at 300s). `_interruptible_sleep()` checks shutdown during waits.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | Relies on provider SDK built-in retries. `Arc3RealGameRunner` has basic try/catch per run but no configurable retry loop with backoff. ~10 retries max via SDK defaults. |
| TS-SDK | :large_orange_diamond: Partial | Agents SDK handles retries internally. No application-level retry wrapper with tiered strategy. |

**Gap**: Application-level retry orchestration is missing. Porting requires:
- [ ] `callProviderWithRetry()` wrapper with configurable attempts (default 50)
- [ ] Tier 1: Rate-limit detection (HTTP 429, `RateLimitError`, quota strings) + minute-boundary wait
- [ ] Tier 2: Provider-specific transient errors (504, 503, `DEADLINE_EXCEEDED`)
- [ ] Tier 3: General exponential backoff (`base^attempt * jitter`, capped at `retry_max_wait`)
- [ ] `interruptibleSleep()` that checks shutdown events
- [ ] Universal error classifier (`isRateLimitError()`)

**Reference**: `runner/eval_runner.py` `_call_provider_with_retry()` (lines 350-450)

---

### Feature 8: Circuit Breaker

**Python capability**: Per-provider circuit breaker with CLOSED/OPEN/HALF-OPEN states. 10 consecutive failures trip the breaker. 300s cooldown. Single-probe guard in HALF-OPEN.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | No circuit breaker. Failed providers keep receiving requests. |
| TS-SDK | :x: Missing | Same — no circuit breaker. |

**Gap**: Full implementation needed. Porting requires:
- [ ] `CircuitBreaker` class with configurable threshold and cooldown
- [ ] State machine: CLOSED -> OPEN -> HALF-OPEN -> CLOSED
- [ ] Thread-safe (mutex for state transitions)
- [ ] Per-provider instances
- [ ] Integration with orchestrator: check breaker before dispatching to provider

**Reference**: `circuit_breaker.py` (114 lines)

---

### Feature 9: Self-Correction (SKIP Re-prompt)

**Python capability**: When no valid action is parsed from LLM response, returns `"SKIP"`. Rejection message fed back into conversation with valid action list. Game state unchanged. Cost still tracked.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :twisted_rightwards_arrows: Different | Uses Agents SDK tool-calling. Invalid tool calls are rejected by the SDK framework, which re-prompts the model automatically. No explicit SKIP handling needed. |
| TS-SDK | :twisted_rightwards_arrows: Different | Same — SDK-native tool validation handles malformed responses. The SDK re-prompts automatically on tool call failures. |

**Gap**: Architecturally different. Python uses a raw JSON response + parsing pipeline; TS uses tool-calling where the SDK handles validation. The self-correction effect is achieved through different means. No porting needed unless moving away from tool-calling.

**Note**: If a non-tool-calling mode is added (e.g., for providers that don't support tool calling), the SKIP mechanism would need to be ported.

---

### Feature 10: Detailed Data Recording

**Python capability**: 7 output formats per (game, model): `steps.jsonl` (24+ field StepRecord per step), `runs.jsonl` (21+ field RunRecord per run), `skips.jsonl`, `token_usage.csv`, `token_usage_summary.csv`, `traces/{model}_trace.jsonl`, optional `raw_responses.jsonl`.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | DB persistence (sessions, frames via `sessionManager` + `framePersistence`). JSONL traces via `PlaygroundTraceSession` (header/frame/event/summary records). No CSV output. No per-step StepRecord equivalent. No skips log. |
| TS-SDK | :large_orange_diamond: Partial | Same architecture — DB + JSONL traces. Trace records include fewer fields than Python's StepRecord. No CSV, no skips, no raw response logging. |

**Gap**: Recording exists but is less granular. Porting requires:
- [ ] `StepRecord` dataclass (24+ fields including per-step cost, token breakdown, notepad state)
- [ ] `RunRecord` dataclass (21+ fields including aggregated costs, elapsed time, error state)
- [ ] Thread-safe `JsonlWriter` for `steps.jsonl`, `runs.jsonl`, `skips.jsonl`
- [ ] CSV writer for `token_usage.csv` (per-step) and `token_usage_summary.csv` (per-run)
- [ ] Optional raw response logging (`--save-raw-responses`)
- [ ] Structured session directory output (`{timestamp}/{game_id}/{model}/`)

**Reference**: `data/schemas.py` (139 lines), `data/writer.py` (82 lines), `runner/trace_writer.py` (73 lines)

---

### Feature 11: Real-Time Event Stream

**Python capability**: JSONL stdout protocol with 8 event types (`session_start`, `games_list`, `run_start`, `step`, `run_end`, `session_end`, `error`, `log`).

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :white_check_mark: Done | SSE via `SSEStreamManager` with rich event types: `stream.init`, `stream.status`, `game.started`, `agent.starting/ready/reasoning/tool_call/tool_result/completed`, `model.stream_event`, `scorecard.closed`. |
| TS-SDK | :white_check_mark: Done | Same SSE architecture with identical event types plus provider-specific metadata. |

**Gap**: None. TS harnesses have richer event types than Python's JSONL protocol.

---

### Feature 12: Visualization (PNG Charts)

**Python capability**: `plot_results.py` generates 2 PNG charts — score-over-steps (mean + min/max bands) and score-vs-cost scatter. Dark theme with green accent. CLI: `--latest` or `--session`.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | No chart generation. Results are displayed in the web UI but no server-side PNG export. |
| TS-SDK | :x: Missing | Same — no chart generation. |

**Gap**: Server-side visualization is absent. Options:
- [ ] Port using a Node.js charting library (e.g., `chartjs-node-canvas`, `vega-lite`)
- [ ] Or generate charts client-side (React + Recharts/D3) from existing SSE data
- [ ] Add CLI/API endpoint: `GET /api/eval/charts/{sessionId}`
- [ ] Dark theme config to match Python output

**Reference**: `plot_results.py` (384 lines)

---

### Feature 13: Smart Context Management

**Python capability**: Two-stage context trimming: (1) sliding window of N most recent turns, (2) token-budget trimming drops oldest turn pairs until estimated tokens fit within 90% of model's context window. Full history always preserved to disk.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | No context management. Agents SDK manages conversation internally. Full conversation sent to model each turn (within SDK limits). |
| TS-SDK | :x: Missing | Same — SDK handles context implicitly. No application-level sliding window or token budget. |

**Gap**: Application-level context management is absent. Porting requires:
- [ ] `ContextManager` class with configurable sliding window (default 50 turns)
- [ ] Token budget calculation (`chars / 1.2` estimation, 90% safety factor)
- [ ] Adaptive trimming: drop oldest turn pairs until within budget
- [ ] Full conversation preserved separately from what's sent to model
- [ ] Per-model `maxContextTokens` config in model registry

**Note**: The Agents SDK manages its own context. This feature is most relevant if building a non-SDK step loop or if models start hitting context limits with long games.

**Reference**: `runner/context_manager.py` (111 lines)

---

### Feature 14: Notepad / Scratchpad

**Python capability**: 4,000-char persistent notepad per run. Model writes notes (strategies, observations) that survive context window trimming. Versioned — history of notepad states tracked.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | No explicit notepad. The Agents SDK maintains full conversation history within a run, so short-term memory persists naturally. No versioned scratchpad survives context trimming (because there's no context trimming). |
| TS-SDK | :large_orange_diamond: Partial | Same — no notepad tool. Memory persists through conversation context, but if context management is added, notes would be lost. |

**Gap**: The notepad becomes critical when context management (Feature 13) is implemented. Porting requires:
- [ ] `Notepad` class with configurable max chars (default 4,000)
- [ ] `write_notes` tool for the agent to update the notepad
- [ ] Versioning: store history of notepad states per step
- [ ] Include notepad contents in turn prompt even after context trimming
- [ ] Record `notepad_length` and `notepad_contents` in StepRecord

**Reference**: `runner/notepad.py` (37 lines)

---

### Feature 15: Prompt Caching Optimization

**Python capability**: Provider-specific caching strategies. Anthropic: 3 `cache_control` breakpoints (tool def, system prompt, last message). Gemini: automatic content caching. OpenAI: automatic prefix caching. Separate tracking of cached vs non-cached tokens.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :twisted_rightwards_arrows: Different | Caching handled by the Agents SDK and underlying provider SDKs. No application-level cache breakpoint management. Works implicitly via `store: true` and Responses API. |
| TS-SDK | :twisted_rightwards_arrows: Different | Same — `aisdk()` wrapper delegates caching to provider SDKs (Bedrock, Vertex, OpenAI). No explicit cache breakpoint injection. |

**Gap**: Architecturally different. Python manages cache breakpoints directly because it constructs raw API payloads. TS harnesses delegate to SDKs. This is acceptable unless cost analysis shows significant cache miss rates.

**Potential improvement**: Track cached vs non-cached token counts from provider responses (currently not extracted from SDK usage).

---

### Feature 16: Config Flexibility (CLI + TOML)

**Python capability**: Three configuration layers: CLI flags (25+ options), TOML config file, smart merging (CLI overrides TOML overrides defaults). Supports `--dry-run`, `--verbose`, `--sequential`, parallel workers, budget caps, resume, image toggle.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | Configuration via UI payload only (`StreamArc3Payload`): game_id, model, instructions, maxTurns, reasoningEffort. No CLI, no config file, no TOML. Limited parameter set. |
| TS-SDK | :large_orange_diamond: Partial | Same — `AgentSdkStreamPayload` with similar parameters. No CLI or config file support. |

**Gap**: No CLI or config file support. Porting requires:
- [ ] CLI entry point (e.g., `ts-node scripts/eval.ts --game X --models Y`)
- [ ] Config file support (JSON or TOML)
- [ ] Config merging: CLI > config file > defaults
- [ ] Full parameter set: runs, maxSteps, contextWindow, seed, parallelGames, parallelRuns, budget caps, verbose, sequential, withImages, gameType, limit, exclude
- [ ] Expose config via API endpoint for UI-driven configuration

**Reference**: `evaluate.py` CLI (lines 1-100), `toml_config.py` (192 lines)

---

### Feature 17: Dry Run Mode

**Python capability**: `--dry-run` validates configuration, game discovery, and model setup without making API calls. Confirms setup correctness before spending money.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | No dry run. Starting a session immediately calls the API. |
| TS-SDK | :x: Missing | Same — no dry run. |

**Gap**: Full implementation needed:
- [ ] `dryRun` flag in config/payload
- [ ] Validate: model keys resolve, API keys present, games discoverable
- [ ] Report: planned runs, estimated cost, model configurations
- [ ] Return validation result without starting games or calling LLM APIs

**Reference**: `evaluate.py` dry-run logic (lines 350-400)

---

### Feature 18: Game Discovery

**Python capability**: `game_loader.py` automatically scans puzzle environment directories, handles multiple game versions (picks latest), mixed ARC-2/ARC-3 puzzles, filtering by type or ID, and caches module classes for performance.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | Game ID is user-specified in the payload. No auto-discovery of available games. |
| TS-SDK | :x: Missing | Same — game ID from payload only. |

**Gap**: No server-side game discovery. Porting requires:
- [ ] `GameDiscoveryService` that scans puzzle environment directories
- [ ] Version handling (pick latest game version)
- [ ] Type filtering (`arc2`, `arc3`)
- [ ] Caching of discovered games for fast repeated lookups
- [ ] API endpoint: `GET /api/eval/games` (list available games)
- [ ] Optional: `--list-games` CLI flag

**Reference**: `game_loader.py` (352 lines)

---

### Feature 19: Per-Model Scoring

**Python capability**: ARC-3: `levels_completed / total_levels`. ARC-2: `correct_cells / total_cells`. Tracked at every step.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :white_check_mark: Done | Score from `FrameData.score` (provided by ARC3 API). Emitted via SSE events and stored in traces. |
| TS-SDK | :white_check_mark: Done | Same — score from `FrameData.score`. |

**Gap**: None for ARC-3. ARC-2 scoring would need implementation alongside Feature 2.

---

### Feature 20: Test Suite (~3,500 lines)

**Python capability**: 10 test files covering resume/crash recovery, parallel execution correctness, budget tracking, circuit breaker states, cancellation, shutdown, TOML config, ARN handling, and full integration pipeline. Mock providers for failure simulation.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | No tests for the eval harness components. |
| TS-SDK | :x: Missing | No tests for AgentSdk runner, stream service, or provider registry. |

**Gap**: Full test suite needed. Priority areas:
- [ ] Provider registry tests (model creation, env validation, error messages)
- [ ] Stream service tests (session lifecycle, TTL expiration, continuation flow)
- [ ] Runner tests (frame persistence, scorecard management, streaming events)
- [ ] Integration tests (start -> stream -> continue -> complete pipeline)
- [ ] Mock providers for failure simulation (always-fail, intermittent, slow)
- [ ] Budget tracking tests (if budget feature is implemented)
- [ ] Circuit breaker tests (if circuit breaker is implemented)

**Reference**: `tests/` directory (10 files, ~3,500 lines)

---

### Feature 21: Data Integrity Safeguards

**Python capability**: Atomic file writes (temp + rename), thread-safe I/O (locks per writer), strict JSON serialization (rejects unknown types), unique run IDs prevent data mixing.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :large_orange_diamond: Partial | DB persistence provides transactional integrity. JSONL trace writer (`PlaygroundTraceSession`) uses `JsonlWriter` which appends sequentially. No atomic file writes for trace data. Unique session IDs via `nanoid`. |
| TS-SDK | :large_orange_diamond: Partial | Same — DB + `PlaygroundTraceSession`. No atomic writes for disk traces. |

**Gap**: DB provides some integrity, but disk-based recording lacks safeguards:
- [ ] Atomic file writes for JSONL/CSV (write to temp, then `fs.rename`)
- [ ] Writer-level locks for thread safety (relevant when parallel runs write to same file)
- [ ] Strict JSON serializer that rejects `undefined`, `NaN`, `Infinity`
- [ ] Run ID uniqueness enforcement in data files

**Reference**: `data/writer.py` (82 lines), `resume.py` atomic write pattern

---

### Feature 22: Cost Estimation Tool

**Python capability**: Standalone CLI tool (`cost_calculator.py`) that estimates costs before running evaluations. Input model + expected token counts, get itemized breakdown.

| Harness | Status | Notes |
|---|---|---|
| TS-NS | :x: Missing | No cost estimation tool. |
| TS-SDK | :x: Missing | No cost estimation tool. |

**Gap**: Full implementation needed:
- [ ] Pricing model for all supported providers (port from `pricing.py`)
- [ ] Cost calculator function: `estimateCost(model, inputTokens, outputTokens, reasoningTokens, cachedTokens)`
- [ ] API endpoint: `POST /api/eval/estimate-cost`
- [ ] Optional CLI tool
- [ ] Support long-context pricing tiers

**Reference**: `cost_calculator.py` (121 lines), `providers/pricing.py` (199 lines)

---

## Implementation Roadmap

### Phase 1: Critical Infrastructure (P1)

Core features that enable meaningful batch evaluation runs.

| # | Feature | Effort | Dependencies |
|---|---------|--------|-------------|
| 3 | 3-Level Parallel Execution | High | — |
| 4 | Cost Tracking + Budget Controls | Medium | Pricing model (new) |
| 6 | Graceful Shutdown | Medium | Parallel execution |
| 10 | Detailed Data Recording | Medium | StepRecord/RunRecord schemas |
| 20 | Test Suite | High | All P1 features |

**Outcome**: Server can orchestrate batch eval runs across multiple models with cost control and data recording.

### Phase 2: Resilience & Recovery (P2)

Features that make long-running evaluations robust and repeatable.

| # | Feature | Effort | Dependencies |
|---|---------|--------|-------------|
| 2 | Two Puzzle Formats | High | Game adapter abstraction |
| 5 | Crash Recovery + Resume | High | Data recording (F10) |
| 7 | 3-Tier Retry | Medium | — |
| 8 | Circuit Breaker | Low | — |
| 13 | Smart Context Management | Medium | — |
| 16 | Config Flexibility | Medium | — |
| 18 | Game Discovery | Medium | — |
| 21 | Data Integrity Safeguards | Low | Data recording (F10) |

**Outcome**: Evaluations survive crashes, handle provider outages gracefully, and support configuration-driven repeatability.

### Phase 3: Quality of Life (P3)

Nice-to-have features that improve UX and analysis.

| # | Feature | Effort | Dependencies |
|---|---------|--------|-------------|
| 9 | Self-Correction (SKIP) | Low | Only if non-SDK mode added |
| 12 | Visualization | Medium | Data recording (F10) |
| 14 | Notepad / Scratchpad | Low | Context management (F13) |
| 15 | Prompt Caching | Low | Provider-specific |
| 17 | Dry Run Mode | Low | Config (F16), game discovery (F18) |
| 22 | Cost Estimation Tool | Low | Pricing model (F4) |

**Outcome**: Full feature parity with Python harness.

---

## Architectural Considerations

### Shared Code Opportunities

Several Python modules have near-direct TypeScript analogues that could be shared:

| Python Module | Potential TS Location | Notes |
|---|---|---|
| `budget.py` | `server/services/eval/BudgetTracker.ts` | Thread-safe cost tracking |
| `circuit_breaker.py` | `server/services/eval/CircuitBreaker.ts` | State machine, works with any async provider |
| `shutdown.py` | `server/services/eval/ShutdownCoordinator.ts` | Event hierarchy |
| `data/schemas.py` | `shared/types/evalRecords.ts` | Shared between server and client |
| `data/writer.py` | `server/services/eval/data/JsonlWriter.ts` | Already exists partially as `traceWriter.ts` |

### Design Decision: SDK vs Raw API

The Python harness uses raw API calls, giving full control over caching, retry, and context. The TS harnesses use the OpenAI Agents SDK, which handles many of these concerns internally. This means:

- Features 7 (retry), 9 (self-correction), 13 (context), 15 (caching) work differently
- A "raw mode" step loop (bypassing the Agents SDK) would be needed for exact parity
- The SDK approach is simpler but less controllable

**Recommendation**: Keep SDK-based approach for interactive playground. Build a separate "eval mode" step loop for batch evaluation that gives full control (closer to Python's architecture).

### Shared vs Separate Harness

Both TS harnesses (Non-SDK and Agent SDK) share identical gaps. Implementing features in a shared `server/services/eval/` module would benefit both:

```
server/services/eval/
  EvalOrchestrator.ts      # Parallel dispatch (Feature 3)
  BudgetTracker.ts         # Cost tracking (Feature 4)
  CircuitBreaker.ts        # Provider fault tolerance (Feature 8)
  ShutdownCoordinator.ts   # Graceful shutdown (Feature 6)
  ContextManager.ts        # Sliding window + token budget (Feature 13)
  GameDiscovery.ts         # Game scanning (Feature 18)
  data/
    StepRecord.ts          # Per-step schema (Feature 10)
    RunRecord.ts           # Per-run schema (Feature 10)
    JsonlWriter.ts         # Thread-safe writer (Feature 10)
    CsvWriter.ts           # CSV output (Feature 10)
  config/
    EvalConfig.ts          # Configuration (Feature 16)
    TomlLoader.ts          # TOML config (Feature 16)
```

---

*End of Feature Gap Analysis*
