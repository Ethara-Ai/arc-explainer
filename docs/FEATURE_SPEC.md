# ARC-AGI Explainer — Complete Feature Specification

**Version:** 7.4.0  
**Production:** https://arc.markbarney.net  
**Staging:** arc-explainer-staging.up.railway.app (branch `ARC3`)  
**Author:** Mark Barney  
**License:** MIT  
**Last Updated:** March 21, 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Data Model & Storage](#4-data-model--storage)
5. [AI Provider Integrations](#5-ai-provider-integrations)
6. [Model Registry](#6-model-registry)
7. [Prompt System](#7-prompt-system)
8. [Solver Strategies](#8-solver-strategies)
9. [Streaming Infrastructure](#9-streaming-infrastructure)
10. [Feature Areas](#10-feature-areas)
    - [10.1 Core Puzzle Analysis](#101-core-puzzle-analysis)
    - [10.2 AI Solvers](#102-ai-solvers)
    - [10.3 RE-ARC Benchmarking](#103-re-arc-benchmarking)
    - [10.4 Worm Arena (SnakeBench)](#104-worm-arena-snakebench)
    - [10.5 ARC3 Community Platform](#105-arc3-community-platform)
    - [10.6 Rankings & Analytics](#106-rankings--analytics)
    - [10.7 Model Debate & LLM Council](#107-model-debate--llm-council)
    - [10.8 LLM Reasoning Explorer](#108-llm-reasoning-explorer)
    - [10.9 Feedback System](#109-feedback-system)
    - [10.10 Fun & Community](#1010-fun--community)
    - [10.11 Admin & Data Ingestion](#1011-admin--data-ingestion)
    - [10.12 Landing & About](#1012-landing--about)
11. [Full Route Map](#11-full-route-map)
12. [API Surface](#12-api-surface)
13. [Environment & Configuration](#13-environment--configuration)
14. [External Systems & Submodules](#14-external-systems--submodules)
15. [Link Unfurling & OG Images](#15-link-unfurling--og-images)
16. [Version History Highlights](#16-version-history-highlights)

---

## 1. Project Overview

ARC-AGI Explainer is a personal research platform for exploring the ARC-AGI benchmark — a collection of abstract reasoning puzzles used to measure AI general intelligence. The platform serves ~4–5 users as a hobby project with production-quality standards.

**Core purpose:**
- Browse, analyze, and solve ARC-AGI puzzles using multiple AI models
- Benchmark AI solver strategies against standardized datasets (RE-ARC)
- Pit AI models against each other in competitive games (Worm Arena / SnakeBench)
- Build community tools for ARC puzzle creation and sharing (ARC3)
- Track model performance with Elo ratings, leaderboards, and analytics

**Key design principles:**
- BYOK (Bring Your Own Key) in production — users supply their own API keys
- Repository pattern for all data access (20 repository classes)
- BaseAIService abstraction across all AI providers
- SSE streaming with two-step handshake for real-time solver output
- Python subprocess bridges for specialized solvers and game engines

---

## 2. Technology Stack

### Frontend
| Technology | Purpose |
|---|---|
| React 18 | UI framework |
| TypeScript | Type safety |
| Vite | Build tool + dev server |
| TailwindCSS + DaisyUI | Styling |
| shadcn/ui | Component library |
| Wouter | Client-side routing |
| TanStack Query | Server state management |
| Recharts 2.15 | Data visualization |
| framer-motion | Animations |
| KaTeX | Math rendering |
| Twemoji | Emoji rendering |
| Pyodide | Client-side Python (WebAssembly) for ARC3 community games |

### Backend
| Technology | Purpose |
|---|---|
| Express.js | HTTP server (TypeScript, ESM) |
| PostgreSQL | Primary database |
| Drizzle ORM | Schema management (3 tables) + raw SQL for app data |
| WebSocket (ws) | Saturn solver real-time communication |
| SSE | Streaming for all solvers and evaluations |
| sharp | Image processing (OG images, grid rendering) |
| ffmpeg-static | Media conversion |
| ts-trueskill | TrueSkill ranking for Worm Arena |

### AI SDKs
| SDK | Version | Provider |
|---|---|---|
| openai | v6.5 | OpenAI (GPT-5 family, o3/o4) |
| @anthropic-ai/sdk | v0.56 | Anthropic (Claude 4.x family) |
| @google/genai | v1.9 | Google (Gemini 2.x/3.x) |
| @ai-sdk/xai | v2.0 | xAI (Grok-4) |
| @openai/agents | v0.1.11 | OpenAI Agents SDK |
| undici | — | Raw HTTP/SSE transport for Grok |

### Python
| Component | Purpose |
|---|---|
| Saturn solver | Visual multi-phase ARC solver |
| RE-ARC library | Dataset generation + verification |
| SnakeBench engine | LLM snake game engine |
| ARCEngine | ARC task execution engine |
| llm-council | Multi-model consensus system |
| Heuristic solver | Pure Python rule-based solver |

### Deployment
| Service | Role |
|---|---|
| Railway | Hosting (Docker) + PostgreSQL |
| Docker | Containerization |
| Auto-deploy | From `main` branch |

---

## 3. Architecture

```
├── client/                  # React frontend (Vite + TS)
│   └── src/
│       ├── pages/           # 67 page components
│       ├── components/      # 30+ component directories + shadcn/ui
│       ├── hooks/           # 58 custom hooks
│       ├── services/        # API client services
│       └── contexts/        # Global state providers
├── server/                  # Express backend (TypeScript, ESM)
│   ├── controllers/         # 25 controllers (HTTP handlers)
│   ├── services/            # 59 service entries
│   │   ├── base/            # BaseAIService abstraction
│   │   ├── openai/          # OpenAI provider + payload builder
│   │   ├── streaming/       # SSE infrastructure (7 files)
│   │   ├── arc3/            # ARC3 playground (19 entries)
│   │   ├── arc3Community/   # Community game platform
│   │   ├── beetree/         # Ensemble solver
│   │   ├── poetiq/          # Community code-gen solver
│   │   ├── snakeBench/      # Snake game services (8 entries)
│   │   ├── wormArena/       # Arena reporting
│   │   ├── reArc/           # RE-ARC benchmarking
│   │   ├── council/         # Multi-model consensus
│   │   ├── prompts/         # Composable prompt system
│   │   └── schemas/         # JSON schema definitions
│   ├── repositories/        # 20 repository classes + utils
│   ├── routes/              # Express route definitions
│   ├── config/              # Model registry (1408 lines)
│   ├── middleware/          # Meta tag injection, etc.
│   └── python/              # Python subprocess bridges
├── shared/                  # Shared types + schemas
│   ├── types.ts             # 1740 lines — all domain types
│   ├── schema.ts            # Drizzle ORM schema (3 tables)
│   ├── routes.ts            # Route meta tags for unfurling
│   └── config/              # Shared configuration
├── external/                # Git submodules
│   ├── ARCEngine/           # ARC task execution
│   ├── re-arc/              # RE-ARC generation (Python)
│   └── SnakeBench/          # Snake game engine (Python)
├── data/                    # ARC puzzle datasets
│   ├── training/            # ARC-AGI-1 training (~400 puzzles)
│   ├── evaluation/          # ARC-AGI-1 evaluation (~400 puzzles)
│   ├── training2/           # ARC-AGI-2 training (~1000 puzzles)
│   └── evaluation2/         # ARC-AGI-2 evaluation (~120 puzzles)
├── solver/                  # Saturn visual solver (Python)
├── scripts/                 # CLI tools, data ingestion
├── llm-council/             # Multi-model consensus (submodule)
└── dist/                    # Production build output
```

### Key Patterns

- **Repository Pattern**: 20 repository classes provide clean data access separation. Domain repositories: Accuracy, Analytics, BatchAnalysis, CommunityGame, Contributor, Cost, Curation, Elo, Explanation, Feedback, GameRead, GameWrite, Leaderboard, Metrics, ModelDataset, ModelOverride, ReArc, Trustworthiness, WormArenaSession + snakebenchSqlHelpers
- **BaseAIService Abstraction**: All 6 AI providers extend a common base providing `buildPromptPackage()`, `buildStandardResponse()`, `calculateResponseCost()`, `detectResponseTruncation()`, and `StreamingHarness` interface
- **AI Service Factory**: Singleton with multi-pattern model routing — prefix matching (`claude-` → Anthropic, `grok-` → xAI, etc.), pattern matching (`includes('/')` → OpenRouter, `startsWith('meta-')` → OpenRouter), and `openai/` prefix stripping via `canonicalizeModelKey()`
- **Python Subprocess Bridges**: TypeScript ↔ Python communication for Saturn, SnakeBench, ARCEngine, RE-ARC, Council, and Heuristic solver
- **SSE Two-Step Handshake**: POST to start analysis → GET to receive event stream
- **Conversation Chaining**: OpenAI/Saturn persist `provider_response_id` for multi-turn analysis

---

## 4. Data Model & Storage

### Drizzle ORM Tables (shared/schema.ts)

| Table | Fields | Purpose |
|---|---|---|
| `users` | id, username, password | Authentication |
| `wormArenaSessions` | sessionId (PK), modelA, modelB, status, createdAt, expiresAt, completedAt, gameId | Arena match sessions |
| `visitorStats` | id, page (unique), count | Page view analytics |

### Application Data (PostgreSQL, raw SQL via repositories)

The bulk of application data lives in PostgreSQL tables managed outside Drizzle — via raw SQL queries in the 20 repository classes. Key data domains:

- **Explanations** (`ExplanationRepository`): 33-field records — puzzle analysis results with pattern descriptions, strategies, confidence scores, predicted outputs, multi-test results, token/cost tracking, reasoning logs, provider response IDs, Saturn visual data
- **Puzzles** (`PuzzleRepository`): ARC task metadata, grid data, source categorization across 6 datasets
- **Accuracy** (`AccuracyRepository`): Correctness aggregation per model per puzzle
- **Elo Ratings** (`EloRepository`): Model comparison votes + Elo rating calculations
- **Feedback** (`FeedbackRepository`): User feedback with types, comments, sessions, reference chains
- **RE-ARC** (`ReArcRepository`): Benchmark submissions, scores, leaderboard data, SHA-256 hashes
- **Worm Arena** (`GameReadRepository`, `GameWriteRepository`, `WormArenaSessionRepository`): Game state, replays, TrueSkill ratings
- **Community Games** (`CommunityGameRepository`): User-created ARC3 games
- **Analytics** (`AnalyticsRepository`, `MetricsRepository`): Aggregated model/puzzle performance data
- **Cost** (`CostRepository`): API cost tracking per model per analysis
- **Batch Analysis** (`BatchAnalysisRepository`): Bulk analysis job tracking
- **Trustworthiness** (`TrustworthinessRepository`): Score aggregation (confusing name — verify intent before modifying)

### Key Types (shared/types.ts — 1740 lines)

| Type | Fields | Purpose |
|---|---|---|
| `ARCTask` | train, test examples | Core puzzle structure |
| `PuzzleMetadata` | id, source (`ARC1 \| ARC1-Eval \| ARC2 \| ARC2-Eval \| ARC-Heavy \| ConceptARC`), grid sizes | Puzzle classification |
| `DatabaseExplanation` | 35 fields (id → status) | Full DB explanation record |
| `ExplanationRecord` | camelCase mirror of above | Frontend-friendly version |
| `PuzzleAnalysis` | pattern, strategy, confidence, predictedOutput, trustworthiness | Analysis result |
| `Feedback` / `FeedbackStats` | type, comment, session, trends, model breakdowns | Feedback system |
| `EloVoteData` / `ComparisonOutcome` | a_wins, b_wins, tie, skip | Elo voting |
| `PromptTemplate` | mode, template, emoji map | Prompt configuration |
| `PoetiqPromptData` / `PoetiqAgentTimelineItem` | agent timeline, reasoning deltas, cost | Poetiq telemetry |

---

## 5. AI Provider Integrations

### Provider Service Map

| Provider | Service File | SDK / Transport | Structured Output | Conversation Chaining |
|---|---|---|---|---|
| **OpenAI** | `openai.ts` | openai SDK v6.5, Responses API | JSON Schema | Yes (`previous_response_id`) |
| **Anthropic** | `anthropic.ts` | @anthropic-ai/sdk, Messages API | Tool Use API | No |
| **xAI (Grok)** | `grok.ts` | undici raw SSE + OpenAI types | JSON Schema (no min/max) | Via Responses API endpoint |
| **Google (Gemini)** | `gemini.ts` | @google/genai SDK | No (prompt-based) | No |
| **DeepSeek** | `deepseek.ts` | OpenAI-compat SDK | No (prompt-based) | No |
| **OpenRouter** | `openrouter.ts` | openai SDK (base URL override) | Varies by model | No |

### Provider Details

**OpenAI**: Primary provider. Uses `/v1/responses` endpoint with `input` array (NOT legacy `messages`). Supports GPT-5 family, o3/o4 reasoning models. Conversation chaining via `previous_response_id`. Reasoning config: `effort ≥ medium`, `summary = 'detailed'`. Structured output via `response_format.json_schema`.

**Anthropic**: Messages API with extended thinking support. Structured output achieved via Tool Use API (not JSON schema). No conversation chaining — full context must be resent. Supports Claude Sonnet 4/4.5, Opus 4.5, Haiku 4.5.

**xAI (Grok)**: Uses xAI Responses API (`https://api.x.ai/v1/responses`) via undici raw SSE transport for streaming. Imports OpenAI SDK types (`ResponseStreamEvent`) for SSE event typing but does NOT use the OpenAI SDK for HTTP transport. JSON Schema structured output but without `minLength`/`maxLength`/`minItems`/`maxItems` constraints.

**Google (Gemini)**: Google GenAI SDK. No native structured output — uses prompt-based JSON extraction. Thinking config is gated (not all models support it). Supports Gemini 2.x/3.x family.

**DeepSeek**: OpenAI-compatible SDK with custom `reasoning_content` field for chain-of-thought. Prompt-based JSON extraction.

**OpenRouter**: OpenAI SDK with base URL override. Routes to 100+ models across all providers. BYOK support. Dynamic model catalog from `openrouter-catalog.json`.

### BYOK (Bring Your Own Key)
- Production enforces user-supplied API keys — server never stores them
- Dev mode allows server-side fallback keys for testing
- Keys passed per-request, never persisted

---

## 6. Model Registry

**Location:** `server/config/models.ts` (1408 lines)

Static registry of 40+ models across 7 providers, dynamically extended at runtime with OpenRouter catalog models. The final `MODELS` export filters out static OpenRouter entries and replaces them with `buildOpenRouterModels()` output from the dynamic catalog.

### Per-Model Configuration
Each model entry includes: key, name, color, premium flag, cost (input/output per token), supportsTemperature, supportsStreaming, supportsVision, provider, responseTime, isReasoning, apiModelName, modelType, contextWindow, maxOutputTokens, releaseDate, notes.

### Provider Breakdown

| Provider | Notable Models |
|---|---|
| OpenAI | GPT-5.1, GPT-5/Mini/Nano/Chat, GPT-4.1 Nano/Mini/Full, GPT-4o Mini, o3, o3-mini, o4-mini, GPT-5.1 Codex/Codex Mini |
| Anthropic | Claude Sonnet 4/4.5, Claude Opus 4.5, Claude 3.7/3.5 Sonnet, Claude 3.5/3 Haiku, Claude Haiku 4.5 |
| Google | Gemini 3 Pro/Flash Preview, Gemini 2.5 Pro/Flash/Flash-Lite, Gemini 2.0 Flash/Flash-Lite |
| xAI | Grok-4 (+ fast-reasoning variant) |
| DeepSeek | DeepSeek models |
| OpenRouter | Dynamic catalog (100+ models) |
| Internal | Heuristic, Saturn, Grover, Beetree, Poetiq |

---

## 7. Prompt System

**Location:** `server/services/prompts/`

Composable prompt architecture with 9 modes, modifiers, and context-aware generation.

### Prompt Modes (9 total)

| Mode | Purpose |
|---|---|
| `solver` | Direct puzzle solving (predict output) |
| `poetiq` | Poetiq community solver prompts |
| `standardExplanation` | Standard pattern analysis |
| `alienCommunication` | Creative alien perspective |
| `educationalApproach` | Teaching-oriented explanation |
| `gepa` | GEPA framework analysis |
| `debate` | Model vs model debate |
| `discussion` | Multi-turn discussion |
| `custom` | User-defined prompt template |

### Components
- `PromptContext.ts` — Builds context object (puzzle data, mode, history)
- `systemPrompts.ts` — System prompt map (9 entries)
- `userTemplates.ts` — User message templates
- `components/` — Composable prompt fragments
- `modifiers/` — Continuation/retry modifiers for follow-up analysis

### Features
- Test-count-aware JSON instructions (adapts schema to number of test cases)
- Context detection for initial vs continuation analysis
- Emoji map support for creative modes

---

## 8. Solver Strategies

### Saturn — Visual Multi-Phase Solver

**Files:** `saturnService.ts`, `saturnVisualService.ts` (DEPRECATED v4.6.0)

Multi-phase visual solver using Python subprocess:
- **Phase 1** → **Phase 2** → **Phase 2.5** → **Phase 3** (escalating complexity)
- Conversation chaining across phases via `previousResponseId`
- WebSocket + SSE streaming for real-time visual output
- Image generation during solving process
- Supports both legacy `saturn-*` prefix model keys AND direct model keys (e.g., `gpt-5-nano-2025-08-07`, `grok-4`) via passthrough routing

### Grover — Iterative Code-Generation Solver

**File:** `grover.ts` (692 lines)

"Quantum-inspired amplitude amplification through iterative grading and context saturation":
- Uses Responses API for code generation
- Python execution sandbox for validation against training examples
- Iterative refinement: generate → grade → refine → repeat
- Models: `grover-grok-4-fast-reasoning`, `grover-gpt-5-nano` (→ `gpt-5-nano-2025-08-07`), `grover-gpt-5-mini` (→ `gpt-5-mini-2025-08-07`)
- Extends BaseAIService

### Beetree — Multi-Model Ensemble Solver

**Files:** `beetree/stageOrchestrator.ts`, `consensusAnalyzer.ts`, `costTracker.ts`

5-stage ensemble pipeline (production mode):
1. **Step 1 — Shallow Search**: Quick initial attempts
2. **Step 2 — Evaluation**: Grade Step 1 results
3. **Step 3 — Extended Search**: Deeper exploration
4. **Step 4 — Evaluation**: Grade Step 3 results
5. **Step 5 — Full Search**: Maximum effort

Key features:
- Multiple models per stage (GPT-5.1, Claude Sonnet 4.5, Gemini 3 — with reasoning-level suffixes like `-high`, `-low`, `-thinking-60000`)
- Consensus detection at 80% agreement threshold
- Cost limit: $50 max per run
- Time limit: 45 minutes
- Early termination when consensus reached
- Testing mode disables Steps 3–5

### Poetiq — Community Code-Generation Solver

**Files:** `poetiq/poetiqService.ts`, `PoetiqAgentsRunner.ts`

Iterative code generation with parallel expert voting:
- N parallel "experts" generate Python `transform()` functions
- Each function validated against training examples in sandbox
- Voting mechanism selects best solution
- Supports all 5 providers via BYOK (OpenAI, Anthropic, Gemini, OpenRouter, xAI)
- Rich telemetry: per-expert cost/token tracking, agent timeline, reasoning deltas
- Python subprocess-based execution

### Heuristic — Rule-Based Solver

Pure Python heuristic solver — no LLM calls. Uses pattern matching rules.

---

## 9. Streaming Infrastructure

**Location:** `server/services/streaming/` (7 files)

### Core: SSEStreamManager

Central SSE connection registry managing:
- Session lifecycle (create → emit → teardown)
- Heartbeat keepalive (15-second interval)
- Event emission with typed event names
- Graceful connection cleanup

### Two-Step Handshake Protocol
1. **POST** `/api/stream/analyze` — Initiates analysis, returns session ID
2. **GET** `/api/stream/events/:sessionId` — Opens SSE event stream

### Per-Solver Stream Services

| Service | Solver | Event Types |
|---|---|---|
| `analysisStreamService.ts` | Standard analysis | text deltas, reasoning, tokens, completion |
| `beetreeStreamService.ts` | Beetree ensemble | stage progress, model results, consensus, cost |
| `groverStreamService.ts` | Grover iterative | iteration progress, code output, grading |
| `poetiqStreamService.ts` | Poetiq community | expert progress, voting, agent timeline |
| `saturnStreamService.ts` | Saturn visual | phase transitions, images, WebSocket bridge |

### Shared Utilities
`sseUtils.ts` — Common SSE formatting, error handling, and connection management.

---

## 10. Feature Areas

### 10.1 Core Puzzle Analysis

**Routes:** `/browser`, `/puzzle/:taskId`, `/examine/:taskId`, `/task/:taskId`, `/discussion/:taskId`, `/puzzles/database`

**Pages:** PuzzleBrowser, PuzzleExaminer, PuzzleAnalyst, PuzzleDiscussion, PuzzleDBViewer, PuzzleOverview

**Capabilities:**
- Browse 1,900+ ARC puzzles across 6 dataset sources (ARC1, ARC1-Eval, ARC2, ARC2-Eval, ARC-Heavy, ConceptARC)
- View puzzle grids (input/output pairs for train + test examples)
- Analyze puzzles with any AI model — pattern description, solving strategy, confidence, hints
- Multi-test support — models predict outputs for all test cases, scored per-case
- Conversation chaining — continue analysis across multiple turns
- Discussion mode — multi-turn puzzle discussion with model memory
- Database viewer — browse stored explanations, filter by model/puzzle/accuracy
- Puzzle overview — aggregated statistics across all explanations

**Data flow:**
1. User selects puzzle → frontend sends grid data + model + prompt mode
2. Backend routes to AI provider via factory → streams response via SSE
3. `ExplanationService.transformRawExplanation()` normalizes 33-field response
4. `ExplanationRepository` persists to PostgreSQL
5. `ResponsePersistence` saves raw HTTP response to `data/explained/`

### 10.2 AI Solvers

**Routes:** `/puzzle/saturn/:taskId`, `/puzzle/grover/:taskId`, `/puzzle/beetree/:taskId?`, `/puzzle/poetiq/:taskId`, `/poetiq`

**Pages:** SaturnVisualSolver, GroverSolver, BeetreeSolver, PoetiqSolver, PoetiqCommunity

Four specialized solver strategies (see [Section 8](#8-solver-strategies)) plus standard analysis. Each has:
- Dedicated page with solver-specific UI
- Real-time streaming via per-solver SSE service
- Progress tracking with custom hooks
- Cost/token monitoring
- Result persistence

### 10.3 RE-ARC Benchmarking

**Routes:** `/re-arc`, `/re-arc/submissions`, `/dataset-viewer`

**Pages:** ReArc, ReArcSubmissions, ReArcDataset

**Components:** `client/src/components/rearc/` — GenerationSection, EvaluationSection, EfficiencyPlot, ReArcLeaderboard

**Capabilities:**
- **Dataset Generation**: Python subprocess generates ARC-variant puzzles with deterministic seeding (`RE_ARC_SEED_PEPPER` + task-specific seeds). Task ID encoding/decoding via `reArcCodec.ts`
- **Submission Evaluation**: SSE-streamed scoring pipeline. Per-test-case scoring with 2 attempts each — test case solved if either attempt matches ground truth. Task score = solved/total. Submission score = average across tasks
- **Leaderboard**: Ranked model performance with submission history
- **SHA-256 Verification**: `submissionHash.ts` enables community verification of submission integrity
- **Dataset Viewer**: Browse generated RE-ARC datasets
- **Efficiency Plot**: Visualize cost vs accuracy tradeoffs

**Scoring (matches official ARC-AGI):**
```
For each task:
  For each test case (N per task, typically 1-4):
    2 attempts allowed
    test_case_solved = attempt_1_correct OR attempt_2_correct
  task_score = solved_test_cases / total_test_cases
submission_score = average(all task_scores)
tasks_solved = count(tasks with score == 1.0)
```

### 10.4 Worm Arena (SnakeBench)

**Routes:** `/worm-arena`, `/worm-arena/live/:sessionId?`, `/worm-arena/matches`, `/worm-arena/models`, `/worm-arena/stats`, `/worm-arena/skill-analysis`, `/worm-arena/distributions`, `/worm-arena/rules`

**Pages:** WormArena, WormArenaLive, WormArenaMatches, WormArenaModels, WormArenaStats, WormArenaSkillAnalysis, WormArenaDistributions, WormArenaRules

**Components:** 20+ dedicated Worm Arena components in `client/src/components/wormArena/`

**Capabilities:**
- **LLM Snake Game**: Two AI models compete in a snake game, making decisions each round
- **Live Streaming**: Real-time SSE broadcast of game state per round
- **Match Management**: Session-based matchmaking with pending/active/completed states
- **Replay System**: Browse and replay completed matches from `completed_games/` directory
- **TrueSkill Leaderboard**: Bayesian skill ranking across all models (ts-trueskill)
- **Model Insights**: Per-model performance analysis, win rates, strategies
- **Skill Analysis**: Deep analysis of model snake-playing capabilities
- **Score Distributions**: Statistical distribution of game outcomes
- **Matchup Suggestions**: Algorithm recommends informative matchups

**Architecture:**
- Python backend (`external/SnakeBench/`) runs game engine
- TypeScript services bridge via Python subprocess
- Game state persisted to DB + JSON replay files
- SSE streams game frames to frontend
- Greatest hits: Railway Postgres `public.games` + local `completed_games/game_index.json`

### 10.5 ARC3 Community Platform

**Routes:**
- **Community**: `/arc3` (landing), `/arc3/playground` (agent playground), `/arc3/gallery` (game gallery), `/arc3/play/:gameId` (play game), `/arc3/upload` (submit game)
- **Archive**: `/arc3/archive` (landing), `/arc3/archive/games` (browse), `/arc3/archive/games/:gameId` (spoiler view), `/arc3/archive/playground` (playground)
- **Specialized Playgrounds**: Arc3OpenRouterPlayground, Arc3CodexPlayground, Arc3HaikuPlayground

**Pages:** CommunityLanding, ARC3AgentPlayground, CommunityGallery, CommunityGamePlay, GameSubmissionPage, Arc3ArchiveLanding, Arc3GamesBrowser, Arc3GameSpoiler, Arc3ArchivePlayground

**Capabilities:**
- **Agent Playground**: Test AI agents against ARC puzzles with multiple runners (OpenAI, OpenRouter, Codex, Haiku)
- **Community Games**: Users create and share custom ARC-style puzzles
- **Pyodide Integration**: Client-side Python execution (WebAssembly) for community game validation
- **Game Gallery**: Browse community-created games
- **Game Submission**: Upload custom games with validation pipeline
- **Archive**: Historical game browsing with spoiler-tagged solutions
- **Scorecards**: Per-game performance tracking

**Services:** 19 entries in `server/services/arc3/` + `arc3Community/` (game catalog, Python bridge, runner, storage, validator)

### 10.6 Rankings & Analytics

**Routes:** `/analytics`, `/leaderboards`, `/elo/:taskId?`, `/elo/leaderboard`, `/compare/:taskId?`, `/model-comparison`, `/scoring`, `/task/:taskId/efficiency`

**Pages:** AnalyticsOverview, Leaderboards, EloComparison, EloLeaderboard, ModelComparisonPage, HuggingFaceUnionAccuracy, TaskEfficiency

**Capabilities:**
- **Elo Comparison**: Blind A/B voting between model explanations. Random puzzle/pair selection, session-based to prevent double-voting. Outcomes: a_wins, b_wins, tie, skip
- **Elo Leaderboard**: Ranked model list by Elo rating
- **Model Comparison**: Side-by-side model performance metrics
- **Analytics Overview**: Aggregated platform statistics, model performance trends
- **Leaderboards**: Multi-dimensional rankings (accuracy, cost-efficiency, speed)
- **HuggingFace Union Accuracy**: Scoring visualization using HF dataset integration
- **Task Efficiency**: Per-puzzle cost vs accuracy analysis

### 10.7 Model Debate & LLM Council

**Routes:** `/debate/:taskId?`, `/council/:taskId?`

**Pages:** ModelDebate, DebateTaskRedirect, LLMCouncil

**Model Debate:**
- Two models analyze same puzzle, then critique each other
- Uses `debate` prompt mode
- Streaming responses for both sides

**LLM Council:**
- Multi-model consensus via `llm-council` Python submodule (spawned from `server/python/council_wrapper.py`)
- TypeScript ↔ Python communication via stdin/stdout NDJSON
- Requires `OPENROUTER_API_KEY` (council uses OpenRouter internally)
- Two modes:
  - `solve` — Council analyzes puzzle independently
  - `assess` — Council evaluates existing explanations
- 3-stage pipeline (stage1 → stage2 → stage3) with metadata
- Health check verifies: Python wrapper + llm-council submodule + API key

### 10.8 LLM Reasoning Explorer

**Routes:** `/llm-reasoning`, `/llm-reasoning/advanced`

**Pages:** LLMReasoning, LLMReasoningAdvanced

Explore and visualize the reasoning traces from different AI models:
- View reasoning items, chain-of-thought logs
- Compare reasoning approaches across models
- Advanced mode for detailed reasoning analysis

### 10.9 Feedback System

**Routes:** `/feedback`, `/test-solution/:taskId?`

**Pages:** FeedbackExplorer, PuzzleFeedback

**Capabilities:**
- Submit feedback on model explanations (feedbackType, comment, userAgent, sessionId)
- Reference chain support (`referenceFeedbackId`) for voting on solutions
- Feedback explorer with filtering, trends, model breakdowns
- Daily/weekly statistics
- Solution testing interface

### 10.10 Fun & Community

**Routes:** `/trading-cards`, `/hall-of-fame`, `/hall-of-fame/johan-land`

**Pages:** PuzzleTradingCards, HumanTradingCards, JohanLandTribute

- **Trading Cards**: Collectible-style cards for ARC puzzles
- **Hall of Fame**: Community contributor recognition
- **Johan Land Tribute**: Dedicated tribute page for community member

### 10.11 Admin & Data Ingestion

**Routes:** `/admin`, `/admin/models`, `/admin/arc3-submissions`, `/admin/ingest-hf`, `/admin/openrouter`

**Pages:** AdminHub, ModelManagement, AdminArc3Submissions, HuggingFaceIngestion, AdminOpenRouter

**Capabilities:**
- **Admin Hub**: Central admin dashboard
- **Model Management**: Add/edit/disable model configurations
- **ARC3 Submissions**: Review and moderate community game submissions
- **HuggingFace Ingestion**: Import datasets and model results from HuggingFace
- **OpenRouter Catalog Sync**: Refresh available models from OpenRouter API

**Supporting services:** `modelManagementService.ts`, `ingestionJobManager.ts`, `githubService.ts`

### 10.12 Landing & About

**Routes:** `/` (root), `/about`

**Pages:** LandingPage, About

- **Landing Page**: Dedicated entry point (NOT PuzzleBrowser — root route maps to LandingPage)
- **About**: Project information and credits

**Additional:**
- `/snakebench` → SnakeBenchEmbed (iframe embed)
- `/kaggle-readiness` → KaggleReadinessValidation (submission validation)
- `/models` → ModelBrowser (public model listing)

---

## 11. Full Route Map

### Puzzle Core
| Route | Page | Description |
|---|---|---|
| `/` | LandingPage | Landing/entry page |
| `/browser` | PuzzleBrowser | Browse all puzzles |
| `/puzzle/:taskId` | PuzzleExaminer | Examine specific puzzle |
| `/examine/:taskId` | PuzzleExaminer | Alias for puzzle examiner |
| `/task/:taskId` | PuzzleAnalyst | Analyze puzzle with AI |
| `/discussion` | PuzzleDiscussion | Discussion landing |
| `/discussion/:taskId` | PuzzleDiscussion | Puzzle-specific discussion |
| `/puzzles/database` | PuzzleDBViewer | Database browser |

### Solvers
| Route | Page | Description |
|---|---|---|
| `/puzzle/saturn/:taskId` | SaturnVisualSolver | Saturn visual solver |
| `/puzzle/grover/:taskId` | GroverSolver | Grover iterative solver |
| `/puzzle/beetree/:taskId?` | BeetreeSolver | Beetree ensemble solver |
| `/puzzle/poetiq/:taskId` | PoetiqSolver | Poetiq code-gen solver |
| `/poetiq` | PoetiqCommunity | Poetiq community page |

### Analytics & Rankings
| Route | Page | Description |
|---|---|---|
| `/analytics` | AnalyticsOverview | Platform analytics |
| `/leaderboards` | Leaderboards | Model leaderboards |
| `/elo` | EloComparison | Elo voting (random) |
| `/elo/:taskId` | EloComparison | Elo voting (specific puzzle) |
| `/elo/leaderboard` | EloLeaderboard | Elo rankings |
| `/compare` | EloComparison | Alias for Elo comparison |
| `/compare/:taskId` | EloComparison | Alias with task |
| `/model-comparison` | ModelComparisonPage | Side-by-side comparison |
| `/scoring` | HuggingFaceUnionAccuracy | HF scoring view |
| `/task/:taskId/efficiency` | TaskEfficiency | Per-task efficiency |

### Debate & Council
| Route | Page | Description |
|---|---|---|
| `/debate` | ModelDebate | Debate landing |
| `/debate/:taskId` | DebateTaskRedirect / ModelDebate | Puzzle-specific debate |
| `/council` | LLMCouncil | Council landing |
| `/council/:taskId` | LLMCouncil | Puzzle-specific council |

### RE-ARC
| Route | Page | Description |
|---|---|---|
| `/re-arc` | ReArc | RE-ARC main page |
| `/re-arc/submissions` | ReArcSubmissions | Submission browser |
| `/dataset-viewer` | ReArcDataset | Dataset viewer |

### Worm Arena
| Route | Page | Description |
|---|---|---|
| `/worm-arena` | WormArena | Arena landing |
| `/worm-arena/live` | WormArenaLive | Live matches |
| `/worm-arena/live/:sessionId` | WormArenaLive | Specific live match |
| `/worm-arena/matches` | WormArenaMatches | Match history |
| `/worm-arena/models` | WormArenaModels | Model profiles |
| `/worm-arena/stats` | WormArenaStats | Arena statistics |
| `/worm-arena/skill-analysis` | WormArenaSkillAnalysis | Skill deep-dive |
| `/worm-arena/distributions` | WormArenaDistributions | Score distributions |
| `/worm-arena/rules` | WormArenaRules | Game rules |

### ARC3 Community
| Route | Page | Description |
|---|---|---|
| `/arc3` | CommunityLanding | Community landing |
| `/arc3/playground` | ARC3AgentPlayground | Agent playground |
| `/arc3/gallery` | CommunityGallery | Game gallery |
| `/arc3/play/:gameId` | CommunityGamePlay | Play a game |
| `/arc3/upload` | GameSubmissionPage | Submit a game |

### ARC3 Archive
| Route | Page | Description |
|---|---|---|
| `/arc3/archive` | Arc3ArchiveLanding | Archive landing |
| `/arc3/archive/games` | Arc3GamesBrowser | Browse archived games |
| `/arc3/archive/games/:gameId` | Arc3GameSpoiler | Game with spoilers |
| `/arc3/archive/playground` | Arc3ArchivePlayground | Archive playground |

### Fun & Community
| Route | Page | Description |
|---|---|---|
| `/trading-cards` | PuzzleTradingCards | Puzzle trading cards |
| `/hall-of-fame` | HumanTradingCards | Community hall of fame |
| `/hall-of-fame/johan-land` | JohanLandTribute | Johan Land tribute |

### LLM Reasoning
| Route | Page | Description |
|---|---|---|
| `/llm-reasoning` | LLMReasoning | Reasoning explorer |
| `/llm-reasoning/advanced` | LLMReasoningAdvanced | Advanced reasoning |

### Feedback
| Route | Page | Description |
|---|---|---|
| `/feedback` | FeedbackExplorer | Feedback browser |
| `/test-solution` | PuzzleFeedback | Solution testing |
| `/test-solution/:taskId` | PuzzleFeedback | Puzzle-specific testing |

### Admin
| Route | Page | Description |
|---|---|---|
| `/admin` | AdminHub | Admin dashboard |
| `/admin/models` | ModelManagement | Model config |
| `/admin/arc3-submissions` | AdminArc3Submissions | ARC3 moderation |
| `/admin/ingest-hf` | HuggingFaceIngestion | HF data import |
| `/admin/openrouter` | AdminOpenRouter | OpenRouter sync |

### Other
| Route | Page | Description |
|---|---|---|
| `/models` | ModelBrowser | Public model listing |
| `/model-config` | ModelManagement | Model config (alias) |
| `/snakebench` | SnakeBenchEmbed | SnakeBench iframe |
| `/kaggle-readiness` | KaggleReadinessValidation | Kaggle validation |
| `/about` | About | About page |

### Dev-Only
| Route | Page | Description |
|---|---|---|
| `/dev/re-arc/error-display` | ReArcErrorShowcase | Error UI testing |

### Redirects
| From | To |
|---|---|
| `/human-cards` | `/hall-of-fame` |
| `/snake-arena` | `/worm-arena` |
| `/arc3/games` | `/arc3/archive/games` |

---

## 12. API Surface

### Controllers (25 total)

| Controller | Domain | Key Endpoints |
|---|---|---|
| `puzzleController` | Puzzle CRUD | GET puzzles, metadata, grids |
| `explanationController` | Explanations | GET/POST model analyses |
| `streamController` | SSE streaming | POST start, GET events |
| `saturnController` | Saturn solver | POST solve, GET progress |
| `groverController` | Grover solver | POST solve, GET iterations |
| `beetreeController` | Beetree solver | POST solve, GET stages |
| `poetiqController` | Poetiq solver | POST solve, GET experts |
| `reArcController` | RE-ARC | POST generate/evaluate, GET leaderboard |
| `eloController` | Elo system | GET pairs, POST votes, GET leaderboard |
| `feedbackController` | Feedback | POST submit, GET explore |
| `discussionController` | Discussion | POST message, GET history |
| `councilController` | LLM Council | POST solve/assess, GET health |
| `accuracyController` | Accuracy stats | GET per-model, per-puzzle |
| `costController` | Cost tracking | GET per-model, per-analysis |
| `metricsController` | Aggregated metrics | GET overview, trends |
| `batchController` | Batch analysis | POST start, GET status |
| `modelManagementController` | Model config | CRUD models |
| `modelDatasetController` | Dataset management | GET/POST datasets |
| `adminController` | Admin operations | Various admin endpoints |
| `arc3Controller` | ARC3 platform | POST run, GET games, submissions |
| `snakeBenchController` | Snake game | POST match, GET replays |
| `wormArenaStreamController` | Arena streaming | GET live events |
| `contributorController` | Contributors | GET contributor stats |
| `ogImageController` | OG images | GET generated social images |
| `promptController` | Prompt templates | GET/POST prompt configs |

---

## 13. Environment & Configuration

### Required Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API access (server fallback) | Dev only |
| `DATABASE_URL` | PostgreSQL connection string | Optional (in-memory fallback) |

### Optional Environment Variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter access + LLM Council |
| `RE_ARC_SEED_PEPPER` | Server secret for deterministic RE-ARC seeds |
| `COUNCIL_TIMEOUT_MS` | LLM Council subprocess timeout |
| `ENABLE_SSE_STREAMING` | Server-side SSE feature flag |
| `VITE_ENABLE_SSE_STREAMING` | Client-side SSE feature flag |

### Build Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run prod` | Build + start production |
| `npm run test` | Run test suite |
| `npm run db:push` | Apply Drizzle schema changes |

---

## 14. External Systems & Submodules

| Submodule | Location | Language | Purpose |
|---|---|---|---|
| ARCEngine | `external/ARCEngine/` | Python | ARC task execution engine |
| re-arc | `external/re-arc/` | Python | RE-ARC dataset generation + verification |
| SnakeBench | `external/SnakeBench/` | Python | LLM snake game engine with backend API |
| llm-council | `llm-council/` | Python | Multi-model consensus system |

### Python Bridges
TypeScript spawns Python subprocesses for:
- Saturn solver execution
- RE-ARC dataset generation and evaluation
- SnakeBench match execution and streaming
- ARCEngine task validation
- LLM Council consensus (stdin/stdout NDJSON)
- Heuristic solver
- ARC3 Community game validation
- ARC3 OpenRouter/Haiku runners

---

## 15. Link Unfurling & OG Images

### Static Meta Tags (shared/routes.ts)
`ROUTE_META_TAGS` provides Discord/Twitter/Slack unfurling for:
- `/re-arc` — RE-ARC benchmarking page
- `/re-arc/leaderboard` — RE-ARC leaderboard

### Dynamic Meta Tags (metaTagInjector middleware)
- `/puzzle/:taskId` — Dynamic puzzle meta with OG image generation
- Pattern: `/^\/puzzle\/([a-f0-9]{8})(?:\/.*)?$/i`
- Generates preview images via `ogImageController` + `gridImageService` + `sharp`

---

## 16. Version History Highlights

| Version | Date | Key Changes |
|---|---|---|
| v7.4.0 | Mar 12, 2026 | Pyodide client-side community games |
| ~v7.x | Feb-Mar 2026 | ARC3 game naming, community audit, ARCEngine updates, archive routes |
| ~v6.x | Jan-Feb 2026 | Johan tribute, Worm Arena skill analysis, distributions |
| ~v5.x | Dec 2025-Jan 2026 | Beetree ensemble solver, Poetiq community solver |
| ~v4.x | Nov-Dec 2025 | RE-ARC benchmarking, Saturn deprecation cycle |
| ~v3.x | Oct-Nov 2025 | Trading cards, Hall of Fame, Elo system |
| Earlier | Pre-Oct 2025 | Core puzzle browser, analysis, streaming infrastructure |

Full changelog: `CHANGELOG.md` (4176 lines, semver ordered)

---

## Appendix: File Count Summary

| Category | Count |
|---|---|
| Frontend pages | 67 |
| Custom hooks | 58 |
| Component directories | 30+ |
| Server controllers | 25 |
| Server service entries | 59 |
| Repository classes | 20 |
| AI providers | 6 (+4 internal solvers) |
| Prompt modes | 9 |
| External submodules | 4 |
| Dataset sources | 6 |
| Total puzzles | 1,900+ |
| Drizzle ORM tables | 3 |
| Static model entries | 40+ |
| Runtime models (with OpenRouter) | 100+ |
| Environment variables | 7 |
| Route definitions | 65+ |
