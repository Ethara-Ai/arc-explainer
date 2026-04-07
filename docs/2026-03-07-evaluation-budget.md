# ARC-AGI Evaluation Budget

**Date:** 2026-03-08
**Prepared by:** Claude Opus 4.6

---

## Budget Summary

| Model | Provider | Data Source | Input (M tokens/step) | Output (M tokens/step) | Reasoning (M tokens/step) | Cost/Step | Total Budget ($) | Share (%) |
|-------|----------|------------|----------------------:|------------------------:|-------------------------:|---------:|-----------------:|----------:|
| Kimi K2.5 | AWS Bedrock | 1,000 measured steps | 0.075 | 0.000231 | 0 | $0.046 | $2,467.42 | 6.74% |
| GPT 5.4 | OpenAI | 20 measured steps (5.2 baseline) | 0.076 | 0.0012 | 0.001525 | $0.230 | $12,420.00 | 33.92% |
| Gemini 3.1 | Google AI | 30 measured steps | 0.054 | 0.00015 | 0 | $0.110 | $5,929.20 | 16.19% |
| Claude Opus 4.6 | AWS Bedrock | 20 measured steps | 0.055 | 0.0007 | 0 | $0.293 | $15,795.00 | 43.14% |
| **TOTAL** | | | | | | **$0.679** | **$36,611.62** | **100%** |

---

## Model Pricing

Per 1M tokens, as of March 2026.

| Model | Provider | Input | Output (incl. thinking) |
|-------|----------|-------|------------------------|
| Kimi K2.5 | AWS Bedrock | $0.60 | $3.00 |
| GPT 5.4 | OpenAI | $2.50 | $15.00 |
| Gemini 3.1 | Google AI | $2.00 | $12.00 |
| Claude Opus 4.6 | AWS Bedrock | $5.00 | $25.00 |

---

## Evaluation Scope

| Parameter | Value |
|-----------|-------|
| Tasks | 54 |
| Runs per task per model | 5 |
| Steps per run | 200 (max) |
| Steps per task | 1,000 |
| Models under evaluation | 4 |
| Total steps per model | 54,000 |
| **Total API calls (all models)** | **216,000** |

---

## Methodology

1. **Kimi k2.5** -- Cost derived from **1,000 measured steps** across 5 complete 200-step evaluation runs. Highest-confidence estimate.

2. **Claude Opus 4.6, GPT 5.4, Gemini 3.1** -- Extrapolated from **20-30 step runs**. Input tokens plateau after step 5 as the context window fills. Per-step cost stabilizes and scales linearly.

3. **GPT 5.4** -- Token usage based on GPT 5.2 Thinking baseline (same architecture). Reasoning tokens (1,525/step) billed at the output rate ($15.00/M).

4. **Gemini 3.1** -- Standard tier pricing ($2.00/$12.00) since all observed prompts remained under 200K tokens.

---

## Risks and Assumptions

| Risk | Potential Impact | Likelihood |
|------|-----------------|------------|
| Claude Opus 4.6 costs exceed projection | +$2,000 to $5,000 | Low |
| Gemini input token spikes (105-157K observed in some steps) | +$1,000 to $3,000 | Medium |
| GPT 5.4 uses more reasoning tokens than 5.2 baseline | +$1,000 to $2,000 | Medium |
| Models solve tasks early (< 200 steps) | 10-30% savings | Task-dependent |

### Key Assumptions

- Step count is fixed at 200 max per run (models that solve early will cost less)
- Token usage patterns from measured runs are representative of all 54 tasks
- No prompt caching is used (cached input would reduce costs significantly)
- All runs complete without errors requiring retries
- Pricing based on direct API rates; AWS Bedrock may carry additional markup
