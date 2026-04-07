# shared/AGENTS.md

> Conventions for the isomorphic shared code used by both client and server.
> For global rules (file headers, SRP/DRY, changelog), see root `AGENTS.md`.

## Purpose

The `shared/` directory contains code importable by BOTH `client/` and `server/`. Everything here must be isomorphic — no Node-only APIs, no browser-only APIs, unless properly guarded.

## Directory Structure

```
shared/
  types.ts              # Core domain types (1740 lines) — NO TOUCH ZONE
  eval-types.ts         # Eval domain types (701 lines)
  schema.ts             # Drizzle ORM table definitions
  types/
    index.ts            # Eval provider types (EvalProviderType, BaseEvalProvider, etc.)
  providers/
    base.ts             # BaseProvider abstract class + ProviderResponse + shared parser (287 lines)
    pricing.ts           # Token pricing engine — 8 models, long-context tiers (216 lines)
    bedrockUtils.ts      # Shared ARN parsing utility
    index.ts             # Barrel export
    openaiProvider.ts    # GPT-5.4 (294 lines)
    geminiProvider.ts    # Gemini 3.1 (197 lines)
    bedrockClaudeProvider.ts   # Claude Opus 4.6 via Bedrock Converse (199 lines)
    bedrockKimiProvider.ts     # Kimi K2.5 via Bedrock InvokeModel (196 lines)
    anthropicClaudeProvider.ts # Claude via native SDK (186 lines)
    kimiProvider.ts      # Kimi via Moonshot (38 lines)
    openrouterGeminiProvider.ts # Gemini via OpenRouter (44 lines)
    geminiFallbackProvider.ts   # Multi-tier fallback (91 lines)
    litellmProvider.ts   # LiteLLM universal proxy (220 lines)
  config/
    llmConfig.ts         # MODEL_REGISTRY (18 entries) + EvalConfig + createProvider() factory (389 lines)
  utils/                 # Shared utility functions
  data/                  # Shared data loaders
  arc3Games/             # ARC3 game definitions
  test/                  # Shared test utilities
```

## Critical Rules

### types.ts is a NO TOUCH ZONE

`shared/types.ts` (1740 lines) contains core domain types used across the entire application. **DO NOT modify this file** unless you have explicit approval and understand all downstream impacts.

If you need new types for the eval harness, add them to:
- `shared/eval-types.ts` — eval domain types (701 lines)
- `shared/types/index.ts` — eval provider interfaces (50 lines)

### schema.ts Modifications

`shared/schema.ts` defines Drizzle ORM tables. When adding eval tables:
- Add to the END of the file
- Follow existing table definition patterns
- Run `npm run db:push` to apply changes
- 3 eval tables already exist: `eval_sessions`, `eval_runs`, `eval_steps`

## Provider Architecture

### Adding a New Provider

1. Create `shared/providers/{name}Provider.ts`
2. Extend `BaseProvider` from `shared/providers/base.ts`
3. Implement `chooseAction()` method
4. Add to `MODEL_REGISTRY` in `shared/config/llmConfig.ts`
5. Export from `shared/providers/index.ts`

### BaseProvider Contract

```typescript
// shared/providers/base.ts
abstract class BaseProvider implements BaseEvalProvider {
  abstract readonly modelName: string;
  abstract chooseAction(
    systemPrompt: string,
    conversationHistory: ProviderMessage[],
    currentObservation: string,
    validActions: string[],
    notepad: Notepad,
    imageB64?: string | null,
  ): Promise<ProviderResponse>;
}
```

### Response Parsing

Shared parser in `base.ts` handles all providers:
1. Brace-depth JSON extraction from LLM output
2. Case-insensitive action keyword fallback
3. Prefix matching for compound actions (e.g., "CLICK 10 15")
4. Fallback chain: valid JSON → keyword scan → SKIP

### Provider-Specific Gotchas

| Provider | Gotcha |
|----------|--------|
| OpenAI | SDK v6.5+ changed `ChatCompletionMessageToolCall` to union type — narrow with `"function" in tc` |
| Gemini | `FunctionCall.args` typed as `object` — cast to `Record<string, unknown>` |
| Gemini | 429/RESOURCE_EXHAUSTED needs 10-12 min cooldown, NOT standard backoff |
| Bedrock Kimi | Requires InvokeModel (NOT Converse) for vision support |
| Bedrock Claude | Support model ARN variants, bearer token auth |

## Config (llmConfig.ts)

### MODEL_REGISTRY

18 model entries with structure:
```typescript
{
  modelId: string,
  displayName: string,
  provider: EvalProviderType,
  contextWindow: number,
  maxOutputTokens: number,
  supportsVision: boolean,
  supportsTools: boolean,
  costPer1kInput: number,
  costPer1kOutput: number,
}
```

### createProvider() Factory

```typescript
// Returns the correct provider implementation based on modelId
const provider = createProvider(modelConfig);
```

## Pricing Engine (pricing.ts)

- 8 model pricing tables
- Long-context tier support (Gemini)
- Priority tier = 1.8x pricing
- Token-based cost calculation

## Import Patterns

```typescript
// From client or server code:
import type { Puzzle, Model } from '@shared/types';           // Core types
import type { EvalConfig } from '@shared/types/index';        // Eval types
import { createProvider } from '@shared/config/llmConfig';    // Provider factory
import { OpenAIProvider } from '@shared/providers';           // Provider impl

// Inside shared/ itself:
import type { BaseEvalProvider } from '../types/index';
import { BaseProvider } from './base';
```

## Why Providers Live Here (Not in server/)

Providers are in `shared/providers/` (not `server/services/eval/providers/`) because:
- Client needs type access for UI (model configs, pricing display)
- Server needs implementations for eval execution
- `shared/` is the only directory importable by both

## Anti-Patterns

- **NEVER** modify `shared/types.ts` — use `eval-types.ts` or `types/index.ts` for new eval types
- **NEVER** add Node-only imports (fs, path, child_process) to shared files without runtime guards
- **NEVER** add browser-only imports (DOM APIs) to shared files
- **NEVER** break the barrel export pattern — always re-export from `index.ts`
- **NEVER** add provider-specific logic to `base.ts` — keep it in individual provider files
