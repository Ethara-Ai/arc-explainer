# Evaluation Harness: Prompt Caching Implementation Plan


---

## 1. Problem Statement

### 1a. Claude Providers — Cache Breakpoints Not Effective

Both Claude providers (`anthropic_claude_provider.py` and `bedrock_claude_provider.py`) apply cache markers ONLY to the system prompt (~450 tokens). This is far below the **4,096-token minimum** caching threshold on both Anthropic native and Bedrock, so caching never activates. Currently, Bedrock Claude Opus returns 0 for both `cacheReadInputTokenCount` and `cacheWriteInputTokenCount` in every response — confirmed by user observation.

### 1b. All Providers — Sliding Window Kills Cache Hits After Step 50

This is the bigger problem. The `ContextManager` uses a simple sliding window that drops 1 turn per step after reaching `context_window` capacity. This changes the conversation prefix every single step, causing **100% cache misses from step 51 onward** — for EVERY provider:

- **Claude** (Anthropic + Bedrock): Explicit cache breakpoints become useless when prefix shifts every step
- **Gemini** (Studio/Vertex/OpenRouter): Implicit caching (auto at 4,096+ tokens) stops matching after step 50
- **OpenAI** (GPT-5.4): Implicit caching stops matching after step 50
- **Kimi** (Moonshot, both native and Bedrock): Does not support caching — confirmed out of scope

Each API call sends `tools + system_prompt + conversation_history + current_turn`. The conversation history grows with each step (up to 50 turns = ~50,000 tokens) and is resent in full every call. This is where the cost savings opportunity lies.

### Current cost structure (200-step run, ~1,000 tokens/turn, Claude pricing)

- Average input per call: ~25,000 tokens (growing from ~500 to ~50,000)
- Total input tokens: ~1.25M tokens
- Cost at $5/MTok: **~$6.25 per run** (input only)

### Target

- Cache the stable prefix (all previous turns) so only the new current turn is fresh input
- For Claude: cached tokens cost $0.50/MTok (90% discount) with a $6.25/MTok write premium (1.25x)
- For Gemini/OpenAI: implicit caching provides similar discounts automatically when prefix is stable
- **Target: 60-75% input cost reduction across all caching-capable providers**

---

## 2. Key Design Decisions (Confirmed with User)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Claude providers | **Both** (Anthropic native + Bedrock) | Both are used in production |
| Cache TTL | **5 minutes** (default) | Refreshed on each hit at no extra cost. Steps fire rapidly within a 2-3 hour run, so the 5-min timer never expires. Between runs, cache expires naturally (different games/seeds). |
| Caching mode | **Explicit breakpoints** (Claude only) | Full control over which content blocks are cached. Up to 4 breakpoints per request. Gemini/OpenAI use implicit caching automatically — no markers needed. |
| Context management | **Chunked windowing** (new, ALL providers) | Simple sliding window causes cache miss every step after the window fills. Chunked drops give 90%+ cache hit rate. This is provider-agnostic — benefits Claude, Gemini, and OpenAI equally. |
| Window constraint | **Soft 50** | `context_window=50` is a client requirement but temporarily exceeding to ~60 turns is acceptable for cache efficiency. |
| History location | **Keep in messages** (not system) | Moving history to system doesn't change cache behavior. Cache prefix order is `tools -> system -> messages` regardless. Keeping proper user/assistant roles in messages preserves the conversation structure the model expects. |
| Kimi | **Excluded** | Kimi (both Moonshot native and Bedrock) does not support prompt caching. Confirmed by user. |

---

## 3. Architecture: What Changes

### Files Modified (4 files)

| File | Change | Risk | Benefits |
|------|--------|------|----------|
| `scripts/evaluate/runner/context_manager.py` | Add chunked windowing (drop N turns at once instead of 1 per step) | Medium - changes context behavior | **ALL providers** (Claude, Gemini, OpenAI) |
| `scripts/evaluate/runner/eval_runner.py` | Pass `cache_chunk_size` to ContextManager constructor | Low - one-line change | **ALL providers** |
| `scripts/evaluate/providers/anthropic_claude_provider.py` | Add `cache_control` breakpoints on tool definition + last history message | Low - additive only | Claude (Anthropic native) only |
| `scripts/evaluate/providers/bedrock_claude_provider.py` | Add `cachePoint` on last history message | Low - additive only | Claude (Bedrock) only |

### Files NOT Modified (already support caching)

| File | Why no changes |
|------|----------------|
| `pricing.py` | Already computes costs with `cached_input_per_m` and `cache_write_per_m` for all caching-capable models |
| `schemas.py` | `StepRecord` and `RunRecord` already have `cached_input_tokens` / `cache_write_tokens` fields |
| `eval_runner.py` | Already accumulates `total_cached_input_tokens` and `total_cache_write_tokens` per run |
| `prompt_builder.py` | System prompt construction unchanged |
| `config.py` | No new config needed (chunk size is derived from context_window) |
| `openai_provider.py` | Already extracts `cached_tokens` from usage details — implicit caching works automatically when prefix is stable |
| `gemini_provider.py` | Already extracts `cached_content_token_count` — implicit caching works automatically when prefix is stable |
| `openrouter_gemini_provider.py` | Inherits Gemini implicit caching via OpenRouter passthrough |
| `kimi_provider.py` | No caching support — out of scope |
| `bedrock_kimi_provider.py` | No caching support (uses InvokeModel, not Converse) — out of scope |

---

## 4. Detailed Implementation

### 4.1 ContextManager: Chunked Windowing

**File:** `scripts/evaluate/runner/context_manager.py`

**Problem:** The current sliding window drops 1 turn pair per step after reaching capacity. This changes the prefix every step, causing 100% cache misses from step 51 onward.

**Solution:** Instead of dropping 1 pair when the window overflows, let it grow to `window_size + chunk_buffer` then drop `chunk_size` pairs at once. This keeps the prefix stable for `chunk_size` consecutive steps between each bulk drop.

**Parameters:**
- `chunk_size`: Number of turn pairs to drop at once. Default = 10 (derived from window, ~20% of context_window turns).
- `chunk_buffer`: `chunk_size * 2` messages (user + assistant per turn = 2 messages per pair).
- `max_messages`: `window_size + chunk_buffer` (the absolute most messages before a bulk drop).

**New `__init__` signature:**
```python
def __init__(self, window_size: int = 10, cache_chunk_size: int = 10):
    self.full_history: list[dict] = []
    self.window_size = window_size
    self._cache_chunk_size = cache_chunk_size
    self._chunk_messages = cache_chunk_size * 2  # 2 messages per turn pair
    self._drop_index = 0  # pointer into full_history: everything before this is "dropped"
```

**New `get_context()` logic:**
```python
def get_context(self) -> list[dict]:
    """Return recent turns for LLM consumption with cache-friendly chunked drops."""
    active = self.full_history[self._drop_index:]
    max_with_buffer = self.window_size + self._chunk_messages

    if len(active) > max_with_buffer:
        # Bulk drop one chunk from the front
        self._drop_index += self._chunk_messages
        active = self.full_history[self._drop_index:]
        logger.info(
            "Cache-friendly bulk drop: removed %d messages (%d turn pairs). "
            "Active window: %d messages.",
            self._chunk_messages,
            self._cache_chunk_size,
            len(active),
        )

    return active
```

**`get_context_within_budget()` change:** No changes needed. It already calls `self.get_context()` internally (line 72), so chunked windowing flows through automatically. Budget trimming on top of chunked output is the correct safety-net behavior.

**Backward compatibility:** If `cache_chunk_size=0` or `cache_chunk_size=1`, behavior degrades to the current per-step sliding window (no batching benefit). Default of 10 is a reasonable tradeoff (90% cache hits, window briefly grows to 60 turns max).

**Where `cache_chunk_size` is set:** In `eval_runner.py` when constructing the ContextManager. The runner already knows `config.context_window`. We'll compute `cache_chunk_size = max(1, config.context_window // 5)` so it scales with window size (50 -> chunk of 10, 20 -> chunk of 4, etc.).

```python
# eval_runner.py - existing line ~407:
# BEFORE:
ctx = ContextManager(window_size=config.context_window * 2)

# AFTER:
cache_chunk_size = max(1, config.context_window // 5)
ctx = ContextManager(
    window_size=config.context_window * 2,
    cache_chunk_size=cache_chunk_size,
)
```

**NOTE:** This means `eval_runner.py` gets a one-line change to pass `cache_chunk_size`. Adding this to the modified files list.

---

### 4.2 Anthropic Native Provider: Cache Breakpoints

**File:** `scripts/evaluate/providers/anthropic_claude_provider.py`

**Change A - Cache the tool definition (Breakpoint 1):**

```python
# BEFORE (line 164):
tools=[_PLAY_ACTION_TOOL],

# AFTER:
tools=[{**_PLAY_ACTION_TOOL, "cache_control": {"type": "ephemeral"}}],
```

Rationale: Tools are static across all calls and evaluated FIRST in Anthropic's cache prefix order (`tools -> system -> messages`). Caching them creates a stable prefix anchor.

**Change B - System prompt (already cached, no change):**

Lines 150-156 already apply `cache_control: {type: ephemeral}` on the system prompt block. This is Breakpoint 2. No change needed.

**Change C - Cache the last history message (Breakpoint 3):**

After building the `messages` list from `conversation_history` (lines 109-125), and before appending the current user turn (line 144), mark the last message's last content block:

```python
# NEW: Add cache breakpoint to the last history message.
# This caches the entire prefix (tools + system + all previous turns).
# On the next call, only the new current turn is fresh input.
if messages:
    last_msg = messages[-1]
    content = last_msg.get("content")
    if isinstance(content, list) and content:
        # Structured content blocks - add cache_control to the last block
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}
    elif isinstance(content, str):
        # Plain string content - convert to block format for cache_control
        last_msg["content"] = [
            {"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}
        ]
```

Insert this AFTER the history normalization loop (after line 125) and BEFORE the current user turn construction (before line 127).

**Breakpoint budget:** 3 of 4 slots used. 1 reserved.

---

### 4.3 Bedrock Provider: Cache Points

**File:** `scripts/evaluate/providers/bedrock_claude_provider.py`

**Change A - System prompt (already has cachePoint, no change):**

Lines 160-163 already have `{"cachePoint": {"type": "default"}}` after the system text. No change needed.

**Change B - Cache the last history message:**

After building the `messages` list from `conversation_history` (lines 127-132), and before appending the current user turn (line 150), add a cachePoint to the last message:

```python
# NEW: Add cachePoint to the last history message for prompt caching.
# This caches the entire prefix (system + all previous turns).
if messages:
    last_msg = messages[-1]
    content = last_msg.get("content")
    if isinstance(content, list):
        content.append({"cachePoint": {"type": "default"}})
    elif isinstance(content, str):
        # Shouldn't happen after normalization, but be safe
        last_msg["content"] = [
            {"text": content},
            {"cachePoint": {"type": "default"}},
        ]
```

Insert this AFTER the history normalization loop (after line 132) and BEFORE the current user turn construction (before line 135).

**Bedrock-specific notes:**
- Bedrock uses `cachePoint` blocks appended to content arrays (different from Anthropic's `cache_control` annotation)
- Bedrock minimum is **4,096 tokens** per cachePoint (same as Anthropic native). The system prompt alone (~450 tokens) is far below this — which is why cache metrics currently return 0.
- The existing `cacheReadInputTokenCount` / `cacheWriteInputTokenCount` extraction (lines 210-211) already handles this correctly
- Tool caching: Bedrock Converse API's `toolConfig` does NOT support `cachePoint` blocks. Caching only applies to `system` and `messages`. This is fine -- tools are small (~100 tokens) and always in the prefix.

---

## 5. Expected Behavior

### Cache lifecycle for a typical 200-step run (context_window=50, chunk_size=10)

> **Note:** The 4,096-token minimum applies to both Anthropic native and Bedrock Claude, as well as Gemini/OpenAI implicit caching. The key improvement is the chunked windowing after step 50 — this benefits ALL providers equally.

| Step Range | Window Size (turns) | Cache Behavior | Cache Hits |
|-----------|-------------------|----------------|------------|
| 1-2 | 1-2 (~500-2000 tok) | **Miss** - prefix below 4,096 threshold on all providers | 0 |
| 3-50 | 3-50 (growing) | **HIT** - prefix exceeds 4,096, grows each step. Cache read + small write. | 48 |
| 51-60 | 51-60 (buffer phase) | **HIT** - window grows beyond 50, prefix stays stable. | 10 |
| 61 | drops to 51 | **MISS** - bulk drop of 10 oldest turns changes prefix. Cache write. | 0 |
| 62-70 | 52-60 | **HIT** - prefix stable during accumulation. | 9 |
| 71 | drops to 51 | **MISS** - another bulk drop. | 0 |
| 72-80 | 52-60 | **HIT** | 9 |
| ... | repeating pattern | 9 hits, 1 miss per chunk cycle | ... |
| 191-200 | 52-60 | **HIT** (final accumulation cycle) | 9 |

**Summary:**
- Steps 1-2: 2 misses (below threshold)
- Steps 3-50: 48 hits (growing phase)
- Steps 51-200: 135 hits, 15 misses (chunk cycles: 9 hits per 1 miss)
- **Total: 183 hits / 200 steps = 91.5% cache hit rate**

### Cache invalidation events

| Event | Impact | Frequency |
|-------|--------|-----------|
| Chunked bulk drop | Full cache miss, followed by cache write | Every ~10 steps after step 50 |
| Budget trimming (safety fallback) | May drop extra pairs, causing cache miss | Rare - only if token estimate exceeds budget |
| Run boundary | Cache expires (5-min TTL) | Once per run - expected |
| Tool definition change | Invalidates entire prefix | Never during a run (tools are static) |

---

## 6. Cost Analysis

### Assumptions
- 200-step run, ~1,000 tokens per turn pair
- Average input per call: ~25,000 tokens (growing to ~50,000 at full window)
- Claude Opus 4.6 pricing: input=$5/MTok, cached_read=$0.50/MTok, cache_write=$6.25/MTok

### Without caching (current state)
- ~200 calls x avg ~25,000 input tokens = 5M total input tokens
- Cost: 5M x $5/MTok = **$25.00 input cost per run**

### With caching (after implementation)

For cache HIT steps (183 of 200):
- Cached prefix (avg ~25,000 tokens): $0.50/MTok = $0.0125/call
- Fresh input (current turn, ~1,000 tokens): $5/MTok = $0.005/call
- Per cache-hit call: ~$0.0175

For cache MISS steps (17 of 200):
- Full input (avg ~25,000 tokens): $5/MTok = $0.125/call
- Cache write premium on prefix: $6.25/MTok on ~25,000 tokens = $0.156/call
- Per cache-miss call: ~$0.281

**Total estimated input cost:**
- Cache hits: 183 x $0.0175 = $3.20
- Cache misses: 17 x $0.281 = $4.78
- **Total: ~$7.98 input cost per run**

### Savings
- Current: ~$25.00
- With caching: ~$7.98
- **Savings: ~$17.02 per run (~68% reduction)**

> Note: These are rough estimates. Actual savings depend on turn token counts, window behavior, and whether budget trimming triggers additional cache misses.

---

## 7. Open Questions / Risks

### 7.1 20-Block Lookback Window
Anthropic docs mention a 20-block lookback window for cache matching. With 50-60 turns of history (100-120 content blocks), the prefix may exceed 20 blocks between breakpoints. **Risk:** The system+tools breakpoints may not be "seen" by the cache system if there are >20 blocks between them and the history breakpoint. **Mitigation:** Test with actual runs and check `cache_creation_input_tokens` vs `cache_read_input_tokens` in the token usage logs. If cache hits are unexpectedly low, add intermediate breakpoints (we have 1 unused slot).

### 7.2 Images in Conversation History
The `choose_action` signature accepts `image_b64`. Images must be bit-identical for cache prefix matching. **Question:** Are images currently included in conversation history turns, or only in the current turn? If images are stored in history, they affect cache stability (any change = miss). **Mitigation:** From code review, `context_manager.add_turn()` only stores plain strings (not image data). Images appear to be added only to the current user turn. This should be safe, but needs verification.

### 7.3 Bedrock Cross-Region Cache Misses
Existing code comment warns: `global.` model ID prefix may cause cross-region cache misses. **Risk:** Bedrock routes requests to different regions, and cache is region-local. If requests alternate regions, cache never warms up. **Mitigation:** This is a pre-existing issue, not introduced by this change. Monitor Bedrock cache hit rates separately.

### 7.4 Concurrent Requests Within a Run
The orchestrator uses ThreadPoolExecutor for parallel runs of the same game. If `parallel_runs > 1`, multiple threads send requests with different conversation histories simultaneously. **Risk:** No cache sharing between parallel runs (different histories). **Impact:** None - each run maintains its own cache prefix. No interference.

---

## 8. Implementation Order

1. **context_manager.py** - Add chunked windowing (`cache_chunk_size` parameter, bulk drop logic)
2. **eval_runner.py** - Pass `cache_chunk_size` to ContextManager constructor (one-line change)
3. **anthropic_claude_provider.py** - Add cache breakpoints on tools + last history message
4. **bedrock_claude_provider.py** - Add cachePoint on last history message
5. **Test** - Run a short evaluation (5-10 steps) and verify `cache_read_input_tokens > 0` in token usage logs

---

## 9. Verification Plan

After implementation, verify with short test runs per provider:

### 9.1 Claude (Anthropic native + Bedrock)
1. **Check token usage CSV** (`token_usage.csv`): `cached_input_tokens` should be > 0 starting from step 3-4 (currently always 0 — this is the primary success signal)
2. **Check that `cache_creation_input_tokens`** appears on cache miss steps (step 1-2, and bulk drop steps)
3. **Check `cache_read_input_tokens`** appears on all other steps

### 9.2 Gemini / OpenAI
4. **Check token usage CSV**: `cached_input_tokens` should be > 0 from step 3-4 onward
5. **Verify cache hits persist past step 50** — this is the key metric. Before this change, cache hits dropped to 0 after step 50. After chunked windowing, they should stay at ~90% hit rate.

### 9.3 All Providers
6. **Verify cost reduction** in `token_usage_summary.csv` - compare with a non-cached baseline
7. **Verify correctness** - game behavior and scores should be identical (caching doesn't affect model output)
8. **Verify chunked windowing** - log messages should show bulk drops every ~10 steps after step 50

---

## 10. Rollback

All changes are additive. To disable caching without reverting code:
- Set `cache_chunk_size=1` in the ContextManager constructor (reverts to per-step sliding)
- Cache breakpoints on providers are harmless even without chunked windowing (they just won't cache efficiently)
- No database changes, no schema changes, no new dependencies
