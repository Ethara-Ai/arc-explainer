# server/AGENTS.md

> Backend conventions for the ARC Explainer Express server.
> For global rules (file headers, SRP/DRY, changelog), see root `AGENTS.md`.

## Stack

- **Express** + **TypeScript 5.6** (ESM)
- **PostgreSQL** via **Drizzle ORM** (schema) + raw SQL (queries)
- **SSE** for streaming (NOT WebSocket, except Saturn solver)
- In-memory fallback when DB unavailable

## Entry Point

`server/index.ts` (247 lines) — Express app on port 5000.

**Middleware chain** (order matters):
```
dotenv → CORS → trust proxy → HTTPS enforcement → JSON parser (50mb)
→ URL encoding → request logging → routes → Vite/static
→ metaTagInjector → errorHandler
```

**Startup sequence**:
```
repositoryService.init() → DB stats → maintenance scheduler (6h)
→ aiServiceFactory → WebSocket → Poetiq agent initialization
```

## Layer Architecture

```
HTTP Request
  ↓
routes.ts (centralized registration, 521 lines, 20+ groups)
  ↓
controllers/ (26 files — request parsing, validation, response shaping)
  ↓
services/ (43+ files — business logic, AI providers, subprocess mgmt)
  ↓
repositories/ (22 files — data access via raw SQL)
  ↓
PostgreSQL (Drizzle schema, in-memory fallback)
```

## Directory Structure

```
server/
  index.ts              # Express app entry
  routes.ts             # Centralized route hub (521 lines)
  routes/               # Feature-specific route files
  controllers/          # 26 request handlers
  services/             # 43+ business logic files
    eval/               # Eval harness subsystem (see eval/AGENTS.md)
    arc3/               # ARC3 game services (18 files)
    snakeBench/         # SnakeBench services (4 files)
    reArc/              # RE-ARC services
    openai/             # OpenAI Responses API integration
    prompts/            # Prompt templates
    schemas/            # JSON schemas for structured output
    validation/         # Input validators
    formatters/         # Response formatters
    utils/              # Service utilities
    council/            # LLM Council
    beetree/            # Beetree solver
    poetiq/             # Poetiq solver
    wormArena/          # Worm Arena services
  repositories/         # 22 data access files
  middleware/           # 6 middleware files
  utils/                # 24 utility files
  config/               # Server config
  types/                # Server-only types
  constants/            # Constants
  scripts/              # Server scripts
  python/               # Python subprocess scripts
  migrations/           # Database migrations
```

## Route Registration

All routes registered centrally in `routes.ts` — 20+ route groups:

```typescript
// Pattern in routes.ts
app.use('/api/puzzles', puzzleRoutes);
app.use('/api/eval', evalRoutes);
app.use('/api/stream/analyze', streamRoutes);
// ... 17+ more groups
```

Route groups: `/api/puzzles`, `/api/explanations`, `/api/feedback`, `/api/stream/analyze`, `/api/saturn`, `/api/grover`, `/api/poetiq`, `/api/beetree`, `/api/council`, `/api/snakebench`, `/api/wormArena`, `/api/rearc`, `/api/eval`, `/api/accuracy`, `/api/cost`, `/api/elo`, `/api/metrics`, `/api/models`, `/api/admin`, `/api/arc3`, `/api/config`

## Controller Pattern

```typescript
// Every controller handler uses asyncHandler wrapper
import { asyncHandler } from '../middleware/asyncHandler';

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  // Validation via middleware or manual
  const result = await someService.getById(id);
  res.json(responseFormatter.success(result));
});
```

- Always wrap with `asyncHandler` (auto-catches promise rejections)
- Use `responseFormatter` for consistent response shape
- Validation via middleware (`validation.ts`, `enhancedValidation.ts`)

## Service Patterns

### AI Provider Services

Factory pattern via `aiServiceFactory.ts`:
```typescript
// Existing AI services (DO NOT modify these for eval harness)
openai.ts          // Responses API (/v1/responses) — NEVER Chat Completions
gemini.ts          // Google GenAI
anthropic.ts       // Anthropic SDK
bedrock.ts         // AWS Bedrock (scaffold)
deepseek.ts        // DeepSeek
grok.ts            // xAI Grok
openrouter.ts      // OpenRouter
```

Base class: `BaseAIService.ts` (22KB) — `callProvider()`, `parseResponse()`, prompt building, token counting, cost calculation, retry logic.

### Subprocess Management

Several services spawn child processes:
- `evalService` — runs TypeScript eval runner
- `poetiqService` — runs Poetiq Python solver
- `groverService` — runs Grover Python solver

Communication: **JSONL-over-stdout** protocol (see `eval/adapters/gameBridge.ts` for canonical pattern).

### SSE Streaming (CRITICAL)

**Two-step handshake** (POST → GET):

```typescript
// Step 1: POST creates session, returns sessionId
app.post('/api/eval/start', async (req, res) => {
  const sessionId = createSession(req.body);
  res.json({ sessionId });
});

// Step 2: GET registers SSE connection
app.get('/api/eval/stream/:id', (req, res) => {
  sseStreamManager.register(req.params.id, res);
});
```

**SSEStreamManager** (`services/SSEStreamManager.ts`):
- Connection registry with heartbeat
- Event buffering (handles race between POST and GET)
- Automatic cleanup on disconnect

**Event conventions**:
- Namespace: `eval.${type}` (e.g., `eval.step`, `eval.run_end`, `eval.model_done`)
- Field naming: **snake_case** (`run_id`, `game_type`, `cost_usd`)
- Always include `session_id` in events

## Repository Pattern

```typescript
// All repositories extend BaseRepository
export class SomeRepository extends BaseRepository {
  async findById(id: number) {
    const result = await this.query(
      'SELECT * FROM some_table WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }
}
```

**Key conventions**:
- **Raw SQL** via `this.query()` — NOT Drizzle fluent API
- `BaseRepository` handles: pool management, 3 retry attempts, in-memory fallback
- 22 repositories accessed via `RepositoryService` DI container
- Schema defined in `shared/schema.ts` (Drizzle ORM for migrations only)

### Major Repositories

| Repository | Domain | Notes |
|-----------|--------|-------|
| AccuracyRepository | Correctness aggregation | 1288 lines |
| ExplanationRepository | AI explanations | 1356 lines |
| MetricsRepository | Metric aggregation | 1646 lines |
| EvalRepository | Eval harness data | New for eval port |
| ReArcRepository | RE-ARC benchmarks | |
| EloRepository | Elo ratings | |
| TrustworthinessRepository | Confusing name — verify intent before modifying | |

## Middleware

| File | Purpose |
|------|---------|
| `asyncHandler.ts` | Wraps async handlers, catches rejections |
| `errorHandler.ts` | Global error handler (`AppError` class, structured responses) |
| `validation.ts` | Request validation |
| `enhancedValidation.ts` | Extended validation rules |
| `apiKeyAuth.ts` | API key authentication |
| `metaTagInjector.ts` | HTML meta tags for link unfurling |

## Error Handling

```typescript
// Use AppError for operational errors
import { AppError } from '../middleware/errorHandler';

throw new AppError('Puzzle not found', 404);
throw new AppError('Invalid grid format', 400);

// Always include context in Error messages
throw new Error(`[ServiceName] Operation failed for ${id}: ${err.message}`);
```

- **NEVER** empty catch blocks
- **NEVER** swallow errors silently
- Always log with context: `logger.error('msg', { error, context })`

## Utilities (24 files)

Key utilities:
- `logger` — Singleton, levels, context, truncation, env-aware
- `costCalculator` — AI provider cost computation
- `responseFormatter` — Standardized API responses
- `sseHelpers` — SSE event emission helpers
- `reArcCodec` — RE-ARC encoding/decoding
- `submissionHash` — SHA-256 for verification
- `modelNormalizer` — Normalize model names across providers
- `queryCache` — In-memory query caching
- `performanceMonitor` — Request timing
- `dbQueryWrapper` — Query instrumentation

## Anti-Patterns

- **NEVER** modify existing AI provider services (`services/openai/`, etc.) for eval harness
- **NEVER** use Chat Completions for OpenAI reasoning models — always Responses API (`/v1/responses`)
- **NEVER** use Drizzle fluent API for queries — use raw SQL via `this.query()`
- **NEVER** skip the SSE two-step handshake (POST → GET)
- **NEVER** use WebSocket for new features — use SSE (WebSocket only for Saturn solver legacy)
- **NEVER** use worker threads — use `Promise.all()` + `p-limit` for concurrency
- **NEVER** spawn Python subprocess for eval logic — the whole point of the eval port is TypeScript
- **NEVER** force push or rewrite git history on main
