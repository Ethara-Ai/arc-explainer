# client/AGENTS.md

> Frontend conventions for the ARC Explainer React application.
> For global rules (file headers, SRP/DRY, changelog), see root `AGENTS.md`.

## Stack

- **React 18.3** + **Vite 6.3** + **TypeScript 5.6**
- **Wouter** for routing (NOT react-router)
- **TanStack Query** for server state
- **shadcn/ui** + **Tailwind CSS** + **DaisyUI** (7 themes)
- **Recharts** for charts
- **ESM** (`"type": "module"`)

## Entry Points

- `src/main.tsx` — Vite entry (5 lines, mounts `<App />`)
- `src/App.tsx` — Wouter router (213 lines, 70+ routes)
  - Wraps: `QueryClientProvider` > `TooltipProvider` > `PageLayout`

## Directory Structure

```
client/src/
  pages/          # 73 route components (one per route)
  components/     # 22 feature-based dirs + layout/ + ui/
    ui/           # 50+ shadcn primitives (DO NOT hand-roll equivalents)
    layout/       # PageLayout, AppHeader, AppNavigation
    puzzle/       # Core puzzle UI (39 files)
    puzzle-eval/  # ScoreOverStepsChart, ScoreVsCostChart
    saturn/       # Saturn solver (13 files)
    poetiq/       # Poetiq solver (10 files)
    grover/       # Grover solver (6 files)
    wormArena/    # Worm Arena (15 files)
    arc3/         # ARC3 games
    rearc/        # RE-ARC benchmark
    overview/     # Leaderboards, stats
    analytics/    # Analytics charts (5 files)
    elo/          # Elo system
    feedback/     # Feedback UI (3 files)
    model-examiner/
    human/        # Human solver (5 files)
    huggingFaceUnionAccuracy/ (5 files)
  hooks/          # 65 custom hooks
  services/       # API request utilities
  contexts/       # React Context providers
  lib/            # Utility functions
  types/          # Client-only types
  constants/      # Constants and enums
  utils/          # Shared utilities
```

## File Naming

| Type | Convention | Example |
|------|-----------|---------|
| Pages | `PascalCase.tsx` | `PuzzleExaminer.tsx` |
| Components | `PascalCase.tsx` | `ScoreOverStepsChart.tsx` |
| Hooks | `useCamelCase.ts` | `useEvalProgress.ts` |
| Utilities | `camelCase.ts` | `apiRequest.ts` |
| Types | `camelCase.ts` | `evalTypes.ts` |

## Import Aliases

```typescript
import { Button } from '@/components/ui/button';     // @/ → client/src/
import type { Puzzle } from '@shared/types';          // @shared/ → shared/
import logo from '@assets/logo.png';                  // @assets → attached_assets/
```

## State Management

### Server State: TanStack Query

```typescript
// Standard query config (see queryClient in App.tsx)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
```

- All data fetching via `useQuery` / `useMutation`
- Custom hooks wrap queries: `useModels()`, `usePuzzle(id)`, `useEvalRuns()`
- API calls through `apiRequest(method, url, data)` — unified fetch, 50-min timeout for AI analysis

### UI State: React Context

- `AnalysisContext` (266 lines) — analysis config, batch state
- `ConfigurationContext` — app-wide settings
- **No Redux, No Zustand** — Context + TanStack Query is sufficient

## Routing (Wouter)

```typescript
// In App.tsx — flat route declarations
<Route path="/puzzles" component={PuzzleBrowser} />
<Route path="/puzzles/:id" component={PuzzleExaminer} />
<Route path="/eval" component={PuzzleEvalDashboard} />
```

- 70+ routes, all in `App.tsx`
- Use `useLocation()` and `useRoute()` from Wouter (NOT react-router hooks)
- See `docs/reference/frontend/DEV_ROUTES.md` for the full route map

## Hook Patterns

### Data Fetching Hooks

```typescript
// Pattern: wrap useQuery with typed return
export function usePuzzle(id: string) {
  return useQuery({
    queryKey: ['puzzle', id],
    queryFn: () => apiRequest('GET', `/api/puzzles/${id}`),
    enabled: !!id,
  });
}
```

### SSE Streaming Hooks

```typescript
// Pattern: EventSource with reconnection and typed events
// See: useEvalProgress.ts (266 lines) — canonical SSE hook
// SSE events use snake_case fields: { run_id, game_type, cost_usd }
// Event namespace: eval.${type} (e.g., eval.step, eval.run_end)
```

Key streaming hooks:
- `useEvalProgress` — eval harness SSE (266L, canonical pattern)
- `useAnalysisStreaming` — puzzle analysis SSE
- `useMultiAgentStream` — multi-agent debate SSE
- `useArc3AgentStream` — ARC3 game agent SSE
- `useWormArenaStreaming` — Worm Arena live SSE

### Solver Hooks

Each solver has a dedicated progress hook:
- `useSaturnProgress`, `usePoetiqProgress`, `useGroverProgress`, `useBeetreeRun`, `useArc3AgentRun`

## Component Patterns

### Use shadcn/ui First

50+ shadcn components available in `components/ui/`. **NEVER** hand-roll:
- Buttons, Inputs, Selects, Dialogs, Tooltips, Cards, Tabs, etc.
- Check `components/ui/` before creating any new UI primitive

### Feature-Based Organization

Components grouped by feature domain, not by type:
```
components/puzzle/       # NOT components/buttons/ + components/forms/
components/wormArena/
components/puzzle-eval/
```

### Styling Rules

- **Tailwind CSS** for all styling (no inline styles, no CSS modules)
- **DaisyUI** themes (7 available) — use `data-theme` attribute
- **Dark mode**: class-based (`dark:` prefix)
- Custom `worm` font for Worm Arena branding
- CSS variables for theme colors
- **NO "AI slop"**: no default Inter-only typography, random purple gradients, uniform pill buttons, or over-rounded layouts

## Pages by Domain

| Domain | Count | Key Pages |
|--------|-------|-----------|
| Core Puzzle | 6 | PuzzleBrowser, PuzzleExaminer, PuzzleAnalyst |
| Solvers | 4 | SaturnVisualSolver, GroverSolver, PoetiqSolver, BeetreeSolver |
| Model/Compare | 7 | ModelBrowser, ModelDebate, LLMCouncil, LLMReasoning |
| Analytics | 5 | AnalyticsOverview, Leaderboards, EloLeaderboard |
| Eval Harness | 4 | PuzzleEvalDashboard (563L), EvalOverview, TrajectoryViewer |
| RE-ARC | 3 | ReArc, ReArcDataset, ReArcSubmissions |
| Worm Arena | 8 | WormArena, WormArenaLive, WormArenaMatches |
| ARC3 | 12 | ARC3Browser, ARC3AgentPlayground, Arc3GamesBrowser |
| Admin | 10 | AdminHub, HuggingFaceIngestion, KaggleReadinessValidation |
| Special | 6 | LandingPage, About, TradingCards |

## Anti-Patterns

- **NEVER** use `react-router` — this project uses **Wouter**
- **NEVER** use Redux/Zustand — use TanStack Query + Context
- **NEVER** create custom UI when shadcn/ui has an equivalent
- **NEVER** use CSS modules or styled-components — Tailwind only
- **NEVER** modify `components/ui/` files directly — they're shadcn-generated
- **NEVER** import from `@shared/types.ts` and modify it — it's a NO TOUCH zone (1740 lines)
- **NEVER** use `&&` chaining on Windows — see root AGENTS.md Section 7
