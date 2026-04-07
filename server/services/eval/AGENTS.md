# server/services/eval/AGENTS.md

> Eval harness subsystem conventions. This is the TypeScript port of the Python eval engine.
> For global rules, see root `AGENTS.md`. For server patterns, see `server/AGENTS.md`.

## What This Is

A TypeScript port of `puzzle-eval-harness/scripts/evaluate/` (~5000 lines Python) that runs LLM agents against ARC3 game puzzles, recording step-by-step trajectories for analysis.

**Source repos** (READ-ONLY reference):
- `puzzle-eval-harness/` — Python eval engine (primary port source)
- `arc3-ansh/` — Multi-provider agent loop (best TS provider pattern)
- `arc3-shubham/` — Grid visualization + NDJSON streaming

## Team Ownership

| Team | Owned Files | Domain |
|------|------------|--------|
| **Forge** | `adapters/`, `runner/contextManager.ts`, `runner/notepad.ts`, `runner/promptBuilder.ts`, `validation/` | Game adapters + runner utils |
| **Crucible** | `runner/evalRunner.ts`, `evalOrchestrator.ts`, `data/`, `../../evalService.ts`, `../../controllers/evalController.ts`, `../../../repositories/EvalRepository.ts` | Core engine + data pipeline |
| **Conduit** | `shared/providers/`, `shared/config/llmConfig.ts` | Providers + pricing + config |
| **Prism** | `client/src/pages/PuzzleEvalDashboard.tsx`, `client/src/components/puzzle-eval/`, `client/src/hooks/useEval*` | Frontend UI |

**Rule**: Only touch files your team owns. Cross-team changes require BOTH teams to review.

## Directory Structure

```
server/services/eval/
  adapters/
    types.ts                # Game adapter interfaces (GameAdapter, GameState, GameType)
    arc3GameAdapter.ts      # ARC3 arcengine bridge (Python subprocess)
    gameBridge.ts           # Python subprocess JSONL protocol
  runner/
    index.ts                # Entry point (npm run eval)
    evalRunner.ts           # THE HEART — step loop (873 lines)
    contextManager.ts       # Sliding window + token budget (119 lines)
    notepad.ts              # Persistent notepad across turns (60 lines)
    promptBuilder.ts        # System + turn prompts (155 lines)
  data/
    traceWriter.ts          # JSONL trace file writer (243 lines)
  validation/
    gameValidator.ts        # Pre-run game validation (187 lines)
  shutdown/
    shutdownManager.ts      # Graceful shutdown (169 lines)
    cancelWatcher.ts        # Cancellation signal (93 lines)
  resume/
    resumeManager.ts        # Resume interrupted runs (610 lines)
  config/
    tomlConfig.ts           # TOML config parser (316 lines)
  scripts/
    cleanupOrphanedSteps.ts # DB cleanup utility (428 lines)
  evalOrchestrator.ts       # Multi-model parallel execution
```

**Related files outside this directory**:
- `shared/providers/` — 9 LLM provider implementations (2,008 lines)
- `shared/config/llmConfig.ts` — MODEL_REGISTRY + createProvider() factory (389 lines)
- `shared/types/index.ts` — EvalProviderType, EvalModelConfig, EvalConfig, BaseEvalProvider
- `shared/eval-types.ts` — Eval domain types (701 lines)
- `server/services/evalService.ts` — HTTP service layer
- `server/controllers/evalController.ts` — API routes
- `server/repositories/EvalRepository.ts` — Database persistence

## Core Interfaces

### GameAdapter (Forge owns)

```typescript
// Defined in: adapters/types.ts
interface GameAdapter {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly title: string;
  reset(): Promise<void>;
  step(action: string): Promise<void>;
  getScore(): number;
  getState(): GameState;   // 'NOT_PLAYED' | 'IN_PROGRESS' | 'WIN' | 'GAME_OVER'
  isDone(): boolean;
  getAvailableActions(): string[];
  renderText(): string;
  renderPngBase64(): Promise<string | null>;
  readonly level?: number;
  readonly totalLevels?: number;
}
```

### BaseEvalProvider (Conduit owns)

```typescript
// Defined in: shared/types/index.ts
interface BaseEvalProvider {
  readonly modelName: string;
  chooseAction(
    systemPrompt: string,
    conversationHistory: ProviderMessage[],
    currentObservation: string,
    validActions: string[],
    notepad: Notepad,
    imageB64?: string | null,
  ): Promise<ProviderResponse>;
}
```

### API Contract (Crucible → Prism)

```
POST /api/eval/start       → { sessionId: string }
GET  /api/eval/stream/:id  → SSE (EvalEvent discriminated union)
GET  /api/eval/sessions    → EvalSession[]
GET  /api/eval/runs        → EvalRun[]
GET  /api/eval/runs/:id/steps → EvalStep[]
POST /api/eval/cancel/:id  → { success: boolean }
GET  /api/eval/games       → GameInfo[]
GET  /api/eval/models      → ModelConfig[]
```

## The Step Loop (evalRunner.ts)

The core loop in `evalRunner.ts` (873 lines):

```
1. Initialize game adapter + provider
2. Reset game → get initial observation
3. Loop (maxSteps or game done):
   a. Build prompt (system + context window + current observation)
   b. Call provider.chooseAction() → get action + reasoning
   c. Execute action via adapter.step(action)
   d. Record step (score, action, tokens, cost)
   e. Emit SSE event (eval.step)
   f. Update context window + notepad
4. Emit eval.run_end with final score
```

## Context Manager

- Sliding window: default 10 turns
- Token estimation: 4 chars = 1 token (rough heuristic, matches Python)
- Handles orphaned tool results when window slices
- Token budget for adaptive trimming

## Notepad

- Persistent text across all turns (survives context window trimming)
- 4000 character max
- Included in every turn prompt when non-empty
- Agent can write observations to preserve across window

## Game Adapters (ARC3)

- Games from `arcengine` pip package (`arcengine>=0.9.3`), NOT filesystem
- Python subprocess: `from arcengine.games.official.{game_id} import {GameClass}`
- Known games: ct01, ct03, ft09, gw01, gw02, ls20, vc33, ws03, ws04
- JSONL-over-stdout protocol (see `gameBridge.ts`)
- Actions: RESET, UP, DOWN, LEFT, RIGHT, SELECT, CLICK x y, ACTION7
- Score: `levels_completed / total_levels`

## Providers (9 implementations)

| Provider | API | Lines | Critical Notes |
|----------|-----|-------|---------------|
| OpenAI GPT-5.4 | Responses API (`/v1/responses`) | 294 | NEVER Chat Completions |
| Gemini 3.1 | Google GenAI SDK | 197 | 429 needs 10-12 min cooldown |
| Bedrock Claude | Converse API | 199 | Bearer token auth, ARN variants |
| Bedrock Kimi K2.5 | InvokeModel API | 196 | NOT Converse — InvokeModel for vision |
| Anthropic Claude | Native SDK | 186 | Direct Anthropic API |
| Kimi | Moonshot API | 38 | Native Kimi |
| OpenRouter Gemini | OpenRouter | 44 | Gemini via OpenRouter |
| Gemini Fallback | Multi-tier | 91 | Fallback chain |
| LiteLLM | LiteLLM proxy | 220 | Universal proxy |

Shared response parser handles: brace-depth JSON extraction, case-insensitive action fallback, prefix matching for compound actions, fallback chain (valid JSON → keyword scan → SKIP).

## SSE Events

- Namespace: `eval.${type}`
- Field naming: **snake_case** (`run_id`, `game_type`, `cost_usd`)
- Event types: `session_start`, `run_start`, `step`, `run_end`, `session_end`, `model_done`, `error`, `log`

## Database Tables

3 tables in `shared/schema.ts`:
- `eval_sessions` — Groups multiple runs (one CLI invocation)
- `eval_runs` — Individual model x game x seed runs
- `eval_steps` — Per-step data (needs index on `run_id` at scale)

## No-Go Zones

- **DO NOT** modify `shared/types.ts` (1740 lines of existing types)
- **DO NOT** modify existing features (RE-ARC, SnakeBench, Worm Arena, solvers)
- **DO NOT** modify existing provider services (`server/services/openai/`, etc.)
- **DO NOT** use worker threads — use `Promise.all()` + `p-limit`
- **DO NOT** spawn Python subprocess for eval logic (TS port is the point)
- **DO NOT** touch files outside your team's ownership without cross-team review

## Git Protocol

- Branch: `main` only, direct push
- Before starting: `git pull`
- Commit message: `feat(eval): T{N} - {short description}`
- MD updates: separate commit after code
- **NEVER** force push
