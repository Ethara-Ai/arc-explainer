# LiteLLM Integration Plan for Python Eval Harness


---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Harness Architecture](#2-current-harness-architecture)
3. [Why LiteLLM Was Previously Removed (and Why Now Is Different)](#3-why-litellm-was-previously-removed-and-why-now-is-different)
4. [Feature-by-Feature Mapping](#4-feature-by-feature-mapping)
5. [Migration Blockers & Workarounds](#5-migration-blockers--workarounds)
6. [Recommended Architecture](#6-recommended-architecture)
7. [What Gets Deleted](#7-what-gets-deleted)
8. [What Stays As-Is](#8-what-stays-as-is)
9. [Implementation Phases](#9-implementation-phases)
10. [Risk Assessment](#10-risk-assessment)
11. [Decision Matrix](#11-decision-matrix)

---

## 1. Executive Summary

The eval harness currently maintains **8 provider classes** (~1,200 lines) across 8 files, a **custom pricing engine** (199 lines), a **3-tier retry system** with provider-specific error detection (~60 lines), and a **circuit breaker** (114 lines). LiteLLM v1.82.x can replace **most** of this — approximately **1,500 lines of provider-specific code** — with a single `litellm.Router` integration, while preserving the eval harness's domain logic (step loops, prompt building, JSONL output, budget tracking, context management).

However, there are **5 material blockers** that prevent a clean drop-in replacement. This plan maps each one and proposes workarounds.

**Bottom line:** LiteLLM can eliminate ~70% of provider code and ~90% of retry/rate-limit logic. The remaining 30% requires either custom LiteLLM provider wrappers or retained direct SDK calls for edge cases.

---

## 2. Current Harness Architecture

### Provider Stack (8 classes, ~1,200 lines)

| Provider | File | Lines | SDK/API | Special Features |
|---|---|---|---|---|
| OpenAIProvider | `openai_provider.py` | 386 | Responses API + Chat Completions | Dual-API routing, reasoning_effort |
| AnthropicClaudeProvider | `anthropic_claude_provider.py` | 230 | Anthropic Messages API | Prompt caching, cache_control blocks |
| GeminiProvider | `gemini_provider.py` | 298 | google-genai SDK | thoughts_token_count, priority routing, private SDK patches |
| GeminiFallbackProvider | `gemini_fallback_provider.py` | ~80 | Wraps 3 GeminiProvider tiers | Studio → Standard → Priority fallback chain |
| OpenRouterGeminiProvider | `openrouter_gemini_provider.py` | ~120 | OpenRouter via openai SDK | Standard OpenAI-compatible |
| BedrockClaudeProvider | `bedrock_claude_provider.py` | 284 | Bedrock Converse (raw HTTP) | Bearer token auth, adaptive thinking, cachePoint |
| BedrockKimiProvider | `bedrock_kimi_provider.py` | ~150 | Bedrock InvokeModel (raw HTTP) | Bearer token auth, image via InvokeModel |
| KimiProvider | `kimi_provider.py` | ~50 | Moonshot AI via openai SDK | Subclasses OpenAIProvider |

### Supporting Infrastructure

| Component | File | Lines | Purpose |
|---|---|---|---|
| Custom pricing | `pricing.py` | 199 | Long-context tiers, cached tokens, write premiums, double-billing prevention |
| 3-tier retry | `eval_runner.py:195-254` | ~60 | Minute-boundary alignment, Gemini transient cooldowns, exponential backoff |
| Error detectors | `eval_runner.py:255-310` | ~55 | `_is_rate_limit_error()`, `_is_gemini_quota_error()`, `_is_gemini_transient_error()` |
| Circuit breaker | `circuit_breaker.py` | 114 | Per-provider CLOSED→OPEN→HALF-OPEN |
| Config/registry | `config.py` | 429 | ModelConfig, MODEL_REGISTRY (18 entries), create_provider() factory |

### What Does NOT Touch LLM APIs (untouched by migration)

- `base.py` — `BaseProvider` ABC, `_parse_action_response()` (response parsing is provider-agnostic)
- `runner/eval_runner.py` — step loop, SKIP handling, thread-safe I/O, parallel runs (only retry logic changes)
- `runner/prompt_builder.py`, `context_manager.py`, `notepad.py`, `trace_writer.py`
- `data/schemas.py`, `data/writer.py` — JSONL I/O, StepRecord/RunRecord
- `budget.py` — per-game budget tracking (stays, but fed by LiteLLM cost data)
- `game_loader.py`, `game_adapter.py`, `shutdown.py`, `resume.py`
- `orchestrator.py`, `evaluate.py` — CLI and orchestration layer

---

## 3. Why LiteLLM Was Previously Removed (and Why Now Is Different)

### The November 2025 Removal (Poetiq Solver, NOT Eval Harness)

LiteLLM was removed from `solver/poetiq/` in CHANGELOG v5.32.0 for 5 reasons:

| Original Reason | Still Valid? | What Changed |
|---|---|---|
| 1. No Responses API support | **Partially** — still not natively supported, but workaround exists (see §5.1) | LiteLLM now supports `reasoning_effort` param mapping |
| 2. Provider-specific features needed | **Mostly resolved** — `extra_headers`, `extra_body`, `drop_params=True` cover most cases | LiteLLM v1.82.x has much better provider-specific passthrough |
| 3. Architecture consistency with TS services | **N/A** — eval harness is Python-only, no TS consistency requirement | Eval harness is standalone |
| 4. Simpler dependency tree | **Still valid** — LiteLLM is a large dependency (~200+ transitive deps) | Trade-off: one big dep vs. 8 provider SDKs |
| 5. Easier debugging | **Partially valid** — LiteLLM adds abstraction layer | `litellm.set_verbose = True` helps; callbacks give full visibility |

### Why Re-evaluate Now

1. **The eval harness has grown to 8 providers** — maintenance burden is real. Each new provider requires a full class implementation (150-300 lines).
2. **LiteLLM v1.82.x Router** provides retry, fallback, rate-limiting, and cooldowns that directly replace our 3-tier custom retry + circuit breaker (~170 lines).
3. **Cost tracking** has become more important — LiteLLM's callback-based costing could replace our custom `pricing.py` (199 lines), though accuracy needs verification.
4. **The eval harness conversation format is already OpenAI-compatible** — `[{"role": ..., "content": ...}]` is exactly what `litellm.completion()` expects.

---

## 4. Feature-by-Feature Mapping

### 4.1 Provider Unification

| Current | LiteLLM Equivalent | Confidence | Notes |
|---|---|---|---|
| `OpenAIProvider` (Chat Completions path) | `litellm.completion(model="gpt-5.4", ...)` | **HIGH** | Direct mapping |
| `OpenAIProvider` (Responses API path) | ❌ Not supported | **BLOCKER** | See §5.1 |
| `AnthropicClaudeProvider` | `litellm.completion(model="anthropic/claude-opus-4-6", ...)` | **HIGH** | Prompt caching via `extra_headers` |
| `GeminiProvider` (Studio) | `litellm.completion(model="gemini/gemini-3.1-pro-preview", ...)` | **MEDIUM** | `thoughts_token_count` extraction unclear |
| `GeminiProvider` (Vertex) | `litellm.completion(model="vertex_ai/gemini-3.1-pro-preview", ...)` | **MEDIUM** | Priority endpoint patching not supported |
| `GeminiFallbackProvider` | `litellm.Router` with `fallbacks=[...]` | **HIGH** | Native fallback chain support |
| `OpenRouterGeminiProvider` | `litellm.completion(model="openrouter/google/gemini-3.1-pro-preview", ...)` | **HIGH** | Direct mapping |
| `BedrockClaudeProvider` | `litellm.completion(model="bedrock/anthropic.claude-opus-4-6-v1", ...)` | **LOW** | Uses boto3/IAM auth, not Bearer token |
| `BedrockKimiProvider` | ❌ Likely not supported | **BLOCKER** | Kimi via Bedrock InvokeModel is non-standard |
| `KimiProvider` (Moonshot) | `litellm.completion(model="openai/kimi-k2.5", api_base="https://api.moonshot.cn/v1", ...)` | **HIGH** | OpenAI-compatible endpoint |

### 4.2 Retry & Error Handling

| Current | LiteLLM Equivalent | Confidence |
|---|---|---|
| 3-tier retry with 50 attempts | `Router` retry with `RetryPolicy` | **HIGH** — RetryPolicy supports per-exception-type retries |
| Minute-boundary alignment for rate limits | ❌ Not directly available | **GAP** — LiteLLM uses exponential backoff, not minute-boundary alignment |
| Gemini transient error cooldown (30-60s) | Router cooldown per-deployment | **MEDIUM** — configurable `cooldown_time` but not random jitter |
| `_is_rate_limit_error()` universal detector | Built-in — LiteLLM normalizes all rate limits to `RateLimitError` | **HIGH** |
| `_is_gemini_quota_error()` | Built-in — Gemini 429s mapped to `RateLimitError` | **HIGH** |
| `_is_gemini_transient_error()` | Built-in — 503/504 → `ServiceUnavailableError` | **HIGH** |

### 4.3 Cost Tracking

| Current | LiteLLM Equivalent | Confidence |
|---|---|---|
| `TokenPricing` with 11 fields | `completion_cost()` auto-lookup | **MEDIUM** — no long-context tiers, no write premium tracking |
| Long-context tier pricing (128K+ threshold) | ❌ Not supported | **GAP** — LiteLLM uses flat per-model pricing |
| Double-billing prevention (reasoning vs output) | Unclear | **LOW** — needs testing with GPT-5.4 responses |
| Cached token costing (different rate) | `response._hidden_params["response_cost"]` may include it | **MEDIUM** — depends on provider |
| Per-game budget tracking | Keep `budget.py`, feed it LiteLLM cost data | **HIGH** — just change the cost source |

### 4.4 Circuit Breaker

| Current | LiteLLM Equivalent | Confidence |
|---|---|---|
| CLOSED→OPEN→HALF-OPEN per-provider | Router cooldowns per-deployment | **MEDIUM** — similar but not identical semantics |
| 10 consecutive failures → open | `AllowedFailsPolicy(allowed_fails=10)` | **HIGH** |
| 300s half-open cooldown | `cooldown_time=300` per-deployment | **HIGH** |
| Thread-safe probe slot | Built-in to Router | **HIGH** |

### 4.5 Tool Calling

| Current | LiteLLM Equivalent | Confidence |
|---|---|---|
| `_CHAT_COMPLETIONS_TOOL` (OpenAI format) | Pass-through — LiteLLM uses OpenAI tool format | **HIGH** |
| `_RESPONSES_API_TOOL` (flat format) | ❌ Not supported | **BLOCKER** — see §5.1 |
| Anthropic `input_schema` tool format | Auto-converted by LiteLLM | **HIGH** |
| Bedrock `toolSpec/inputSchema/json` | Auto-converted by LiteLLM | **HIGH** |
| Gemini `FunctionDeclaration` | Auto-converted by LiteLLM | **HIGH** |

---

## 5. Migration Blockers & Workarounds

### 5.1 BLOCKER: OpenAI Responses API (`/v1/responses`)

**Problem:** GPT-5.4 with `reasoning_effort` requires the Responses API, which uses `instructions` + `input` instead of `messages`, and a flat tool format instead of the nested Chat Completions format. LiteLLM does not support `/v1/responses`.

**Workaround Options:**

| Option | Effort | Risk | Recommendation |
|---|---|---|---|
| **A: Keep OpenAIProvider for Responses API path only** | Low | Low | ✓ **Recommended** — hybrid approach, keep working code |
| B: Use Chat Completions API for all OpenAI calls | Low | Medium | Loses reasoning_effort support for thinking models |
| C: Write custom LiteLLM provider plugin | High | Medium | Complex, maintenance burden |
| D: Wait for LiteLLM to add Responses API support | Zero | High | Unknown timeline |

**Recommendation:** Option A. Keep `openai_provider.py` for the Responses API code path only (when `reasoning_effort` is set). Route all other OpenAI calls through LiteLLM. This preserves working code for thinking models while getting LiteLLM benefits for everything else.

### 5.2 BLOCKER: Bedrock Bearer Token Auth

**Problem:** Our Bedrock providers use raw HTTP with Bearer token auth (`BEDROCK_API_KEY` header). LiteLLM's Bedrock integration uses boto3 with IAM credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION_NAME).

**Workaround Options:**

| Option | Effort | Risk | Recommendation |
|---|---|---|---|
| **A: Switch to IAM auth** | Medium | Low | ✓ **Recommended** — standard AWS pattern |
| B: Keep Bedrock providers as direct SDK calls | Low | Low | Hybrid approach, retains 2 provider files |
| C: Custom LiteLLM Bedrock provider with Bearer auth | High | Medium | Non-standard, fragile |

**Recommendation:** Option A if you control the Bedrock access setup. Option B as fallback — keep `bedrock_claude_provider.py` and `bedrock_kimi_provider.py` alongside LiteLLM.

### 5.3 BLOCKER: Bedrock Kimi (InvokeModel API)

**Problem:** `BedrockKimiProvider` uses Bedrock's `InvokeModel` endpoint (not Converse) because Kimi image handling requires it. LiteLLM's Bedrock integration uses the Converse API exclusively.

**Workaround:** Keep `bedrock_kimi_provider.py` as a direct provider. It's only ~150 lines and handles a genuinely non-standard integration path.

### 5.4 CONCERN: Gemini Priority Tier + Private SDK Patching

**Problem:** `GeminiProvider` patches `_client._api_client._http_options.api_version` to route to the priority endpoint. LiteLLM's Vertex AI integration doesn't support this.

**Workaround Options:**

| Option | Effort | Risk | Recommendation |
|---|---|---|---|
| **A: Use `extra_headers` / `api_base` override** | Low | Medium | ✓ **Try first** — may work via `vertex_ai_location` + `vertex_ai_project` |
| B: Keep GeminiProvider for priority tier only | Low | Low | Fallback — retain one file |
| C: Use OpenRouter for priority routing instead | Low | Low | Alternative routing path |

**Recommendation:** Try Option A first. If LiteLLM's Vertex AI params can target the priority endpoint, great. Otherwise, fall back to Option B.

### 5.5 CONCERN: Pricing Accuracy

**Problem:** Our `pricing.py` handles:
- Long-context tier pricing (different rates above 128K tokens)
- Cache write premium pricing
- Double-billing prevention (reasoning tokens vs output tokens)
- Per-provider cached token extraction

LiteLLM's `completion_cost()` uses flat per-model pricing from a JSON file fetched at import time. It does not handle long-context tiers or cache write premiums.

**Workaround:** Run **both** pricing systems in parallel during migration. Compare costs per-call in a callback. Once LiteLLM's costs are verified accurate (or close enough), deprecate `pricing.py`. If LiteLLM consistently under-reports, keep `pricing.py` as the source of truth and use LiteLLM only for provider unification.

---

## 6. Recommended Architecture

### Hybrid Approach: LiteLLM Router + Retained Direct Providers

```
                    ┌─────────────────────────────────────┐
                    │          EvalRunner                   │
                    │  _call_provider_with_retry()          │
                    │  (simplified — delegates retry to     │
                    │   Router or direct provider)          │
                    └──────────────┬────────────────────────┘
                                   │
                    ┌──────────────┴────────────────────────┐
                    │           LiteLLMProvider              │
                    │   (new, extends BaseProvider)          │
                    │   wraps litellm.Router                 │
                    │   handles tool format + response       │
                    │   normalization to ProviderResponse    │
                    └──────────────┬────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────────┐
              │                    │                         │
     litellm.Router          Direct Providers          Direct Providers
     (manages most)          (Responses API)           (Bedrock non-standard)
              │                    │                         │
    ┌─────────┼─────────┐    OpenAIProvider           BedrockKimiProvider
    │         │         │    (reasoning_effort         (InvokeModel API)
  Anthropic  Gemini   Kimi    path only)
  (native)  (Studio)  (Moonshot)
             OpenRouter
             Vertex AI (if priority works)
```

### LiteLLM Router Configuration

```python
from litellm import Router

router = Router(
    model_list=[
        # Anthropic Claude — multiple accounts for rate limit distribution
        {
            "model_name": "claude-opus",
            "litellm_params": {
                "model": "anthropic/claude-opus-4-6",
                "api_key": os.environ["ANTHROPIC_API_KEY_1"],
            },
            "model_info": {"rpm": 50, "tpm": 200000},
        },
        {
            "model_name": "claude-opus",  # Same model_name = load-balanced
            "litellm_params": {
                "model": "anthropic/claude-opus-4-6",
                "api_key": os.environ["ANTHROPIC_API_KEY_2"],
            },
            "model_info": {"rpm": 50, "tpm": 200000},
        },
        # ... accounts 3-6 ...

        # Gemini — fallback chain via Router fallbacks
        {
            "model_name": "gemini-studio",
            "litellm_params": {
                "model": "gemini/gemini-3.1-pro-preview",
                "api_key": os.environ["GEMINI_STUDIO_API_KEY"],
            },
        },
        {
            "model_name": "gemini-vertex",
            "litellm_params": {
                "model": "vertex_ai/gemini-3.1-pro-preview",
                "vertex_project": "my-project",
                "vertex_location": "us-central1",
            },
        },
        {
            "model_name": "gemini-openrouter",
            "litellm_params": {
                "model": "openrouter/google/gemini-3.1-pro-preview",
                "api_key": os.environ["OPENROUTER_API_KEY"],
            },
        },

        # Kimi (Moonshot) — OpenAI-compatible
        {
            "model_name": "kimi",
            "litellm_params": {
                "model": "openai/kimi-k2.5",
                "api_key": os.environ["MOONSHOT_API_KEY"],
                "api_base": "https://api.moonshot.cn/v1",
            },
        },
    ],

    # Gemini fallback chain (replaces GeminiFallbackProvider)
    fallbacks=[
        {"gemini-studio": ["gemini-vertex", "gemini-openrouter"]},
    ],

    # Retry policy (replaces 3-tier retry)
    retry_policy=RetryPolicy(
        RateLimitErrorRetries=5,
        TimeoutErrorRetries=3,
        InternalServerErrorRetries=3,
        ContentPolicyViolationErrorRetries=0,
        AuthenticationErrorRetries=0,
    ),

    # Cooldowns (replaces circuit breaker)
    allowed_fails=10,
    cooldown_time=300,  # 5 min, matches current circuit breaker

    # Rate limiting
    routing_strategy="simple-shuffle",

    # Drop unsupported params silently
    set_verbose=False,
)
```

### LiteLLMProvider Class (new file: `providers/litellm_provider.py`)

```python
"""
Author: Claude Opus 4
Date: 2026-03-16
PURPOSE: LiteLLM-based provider that wraps litellm.Router for unified
         multi-provider LLM access. Extends BaseProvider to fit into
         the eval harness's existing architecture.
SRP/DRY check: Pass — single responsibility (LLM call + response normalization)
"""

from providers.base import BaseProvider, ProviderResponse

class LiteLLMProvider(BaseProvider):
    """Unified provider using litellm.Router for retry, fallback, rate limiting."""

    def __init__(self, router: Router, model_name: str, model_id: str,
                 supports_vision: bool = False, pricing_model_id: str = None):
        self._router = router
        self._model_name = model_name
        self._model_id = model_id
        self._supports_vision = supports_vision
        self._pricing_model_id = pricing_model_id

    def choose_action(self, system_prompt, conversation_history,
                      current_observation, valid_actions, notepad,
                      image_b64=None):
        # 1. Build messages array (already OpenAI-compatible format)
        # 2. Add tool definition (_CHAT_COMPLETIONS_TOOL format)
        # 3. Call router.completion(model=self._model_name, ...)
        # 4. Extract tool call or parse text response
        # 5. Build ProviderResponse with token counts + cost
        ...
```

---

## 7. What Gets Deleted

| File | Lines | Why It Can Go |
|---|---|---|
| `anthropic_claude_provider.py` | 230 | → `litellm.completion(model="anthropic/...")` |
| `gemini_provider.py` | 298 | → `litellm.completion(model="gemini/...")` (if priority works) |
| `gemini_fallback_provider.py` | ~80 | → Router `fallbacks=[...]` |
| `openrouter_gemini_provider.py` | ~120 | → `litellm.completion(model="openrouter/...")` |
| `kimi_provider.py` | ~50 | → `litellm.completion(model="openai/...", api_base=...)` |
| `circuit_breaker.py` | 114 | → Router `allowed_fails` + `cooldown_time` |
| Retry logic in `eval_runner.py` | ~60 | → Router `RetryPolicy` (simplify to thin wrapper) |
| Error detectors in `eval_runner.py` | ~55 | → LiteLLM normalizes all errors |
| **Total deleted** | **~1,007 lines** | |

### Conditionally Deleted (depends on blocker resolution)

| File | Lines | Condition |
|---|---|---|
| `pricing.py` | 199 | Delete after parallel-run validation confirms LiteLLM accuracy |
| `gemini_provider.py` | 298 | Keep if priority tier patching can't be done via LiteLLM |
| `bedrock_claude_provider.py` | 284 | Delete if IAM auth migration happens |

---

## 8. What Stays As-Is

| Component | Why |
|---|---|
| `base.py` | ABC interface + response parsing are provider-agnostic |
| `openai_provider.py` (Responses API path) | LiteLLM doesn't support `/v1/responses` |
| `bedrock_kimi_provider.py` | InvokeModel API is non-standard |
| `bedrock_claude_provider.py` (if Bearer auth kept) | LiteLLM expects IAM auth |
| `budget.py` | Per-game granularity, just change cost input source |
| `config.py` | Extend with LiteLLM Router config, keep ModelConfig |
| All runner/ files | Domain logic, prompt building, context, notepad, trace |
| All data/ files | JSONL I/O, schemas — no LLM dependency |
| `evaluate.py`, `orchestrator.py` | CLI and orchestration — no LLM dependency |
| `shutdown.py`, `resume.py` | Run management — no LLM dependency |
| `game_loader.py`, `game_adapter.py` | Game data — no LLM dependency |

---

## 9. Implementation Phases

### Phase 0: Validation Spike (1-2 hours)

**Goal:** Confirm LiteLLM works for at least one provider before committing to migration.

1. Install `litellm` in eval harness virtualenv
2. Write standalone test script: call `litellm.completion()` for Anthropic Claude with the exact tool definition from `_CHAT_COMPLETIONS_TOOL`
3. Verify: tool call parsed correctly, token counts present, cost computed
4. Test with Gemini (Studio) and Kimi (Moonshot) — confirm basic call works
5. **Decision gate:** If any provider fails basic completion+tools, reassess scope

### Phase 1: LiteLLMProvider + Router Setup (2-3 hours)

1. Create `providers/litellm_provider.py` extending `BaseProvider`
2. Build Router configuration in `config.py` (model_list, fallbacks, retry policy)
3. Add `"litellm"` provider type to `create_provider()` factory
4. Add `litellm` to `requirements.txt`
5. Wire up a single model (Anthropic Claude) through LiteLLMProvider
6. **Test:** Run a single game with Claude via LiteLLM, compare ProviderResponse to direct SDK

### Phase 2: Multi-Provider Rollout (2-3 hours)

1. Add Gemini Studio → LiteLLM Router
2. Add OpenRouter Gemini → LiteLLM Router  
3. Add Kimi/Moonshot → LiteLLM Router
4. Configure Gemini fallback chain in Router (Studio → Vertex → OpenRouter)
5. Add Anthropic account round-robin (6 API keys → 6 Router deployments)
6. **Test:** Run evaluation suite across all LiteLLM-routed models

### Phase 3: Cost Validation (1-2 hours)

1. Add custom callback that logs both LiteLLM `response_cost` and our `compute_cost()` side-by-side
2. Run 50-100 calls per provider, compare costs
3. Document discrepancies (especially long-context tier, cached tokens)
4. **Decision gate:** If LiteLLM costs are within 5% → deprecate `pricing.py`. Otherwise, keep ours.

### Phase 4: Cleanup (1-2 hours)

1. Delete replaced provider files (see §7)
2. Delete `circuit_breaker.py`
3. Simplify `_call_provider_with_retry()` to thin wrapper (LiteLLM handles retry for Router-based models, keep direct retry for retained providers)
4. Remove provider-specific error detectors
5. Update MODEL_REGISTRY entries to use `provider: "litellm"` type
6. Update `requirements.txt` — remove SDKs only needed by deleted providers (careful: keep `openai` for Responses API path)

### Phase 5: Bedrock Resolution (separate, optional)

1. Investigate IAM auth migration for Bedrock Claude
2. If feasible → migrate → delete `bedrock_claude_provider.py`
3. `bedrock_kimi_provider.py` stays regardless (InvokeModel requirement)

---

## 10. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| LiteLLM pricing inaccurate for our models | Medium | **High** | Phase 3 parallel validation; keep pricing.py as fallback |
| LiteLLM import-time GitHub fetch fails (offline/broken JSON) | High | Low | Pin litellm version; set `LITELLM_LOCAL_MODEL_COST_MAP` env var |
| Gemini thoughts_token_count not exposed by LiteLLM | Medium | **High** | Check `response._hidden_params` or fall back to Gemini provider |
| Router retry semantics differ from minute-boundary alignment | Low | **High** | Minute-boundary was a heuristic; exponential backoff is standard and likely equivalent |
| Prompt caching tokens not reported correctly | Medium | Medium | Validate in Phase 3; cached token extraction may need custom callback |
| LiteLLM major version breaks API | High | Low | Pin to specific version in requirements.txt |
| Bedrock Bearer auth incompatible | High | **Certain** | Keep Bedrock providers as direct SDK (§5.2 Option B) |
| Performance overhead from LiteLLM abstraction layer | Low | Low | Router is in-process, no HTTP overhead |

---

## 11. Decision Matrix

**These decisions need your input before implementation begins:**

| # | Decision | Options | My Recommendation |
|---|---|---|---|
| 1 | **Scope** — which providers to migrate? | A: All possible via LiteLLM, keep direct for blockers<br>B: Only Anthropic + Gemini (highest value)<br>C: Full migration, solve all blockers | **A** — pragmatic hybrid |
| 2 | **Bedrock auth** — migrate to IAM? | A: Yes, migrate to boto3/IAM<br>B: No, keep Bearer token providers | Depends on your AWS setup |
| 3 | **Pricing** — trust LiteLLM or keep ours? | A: LiteLLM only (simpler)<br>B: Ours only, LiteLLM for providers only<br>C: Both in parallel, then decide | **C** — validate first |
| 4 | **Gemini priority tier** — how to handle? | A: Try LiteLLM Vertex AI params<br>B: Keep GeminiProvider for priority only<br>C: Drop priority tier | **A**, fall back to **B** |
| 5 | **GPT-5.4 Responses API** — keep direct? | A: Keep OpenAIProvider (Responses API only)<br>B: Use Chat Completions for everything<br>C: Write LiteLLM custom provider | **A** — proven, working code |
| 6 | **Retry semantics** — accept LiteLLM's approach? | A: Yes, Router retry + cooldowns<br>B: Keep our 3-tier retry, use LiteLLM for providers only | **A** — Router retry is more battle-tested |

---

## Summary: What LiteLLM Buys You

| Metric | Before | After |
|---|---|---|
| Provider files | 8 files, ~1,200 lines | 1 LiteLLMProvider (~150 lines) + 2-3 retained |
| Retry/error handling | ~170 lines custom | Router config (~30 lines) |
| Adding a new provider | Write 150-300 line class | Add 5-line Router entry |
| Circuit breaker | 114 lines custom | Router config (2 params) |
| Fallback chains | Custom GeminiFallbackProvider | Router `fallbacks=[...]` |
| Rate limit distribution | Manual (6 Anthropic keys in config) | Router load-balancing |
| Cost tracking | 199 lines custom pricing.py | `completion_cost()` (pending validation) |
| **Net code reduction** | | **~1,000-1,500 lines eliminated** |
| **Trade-off** | Full SDK control | LiteLLM dependency (~200 transitive deps) |
