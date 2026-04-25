

import { getGameById } from './gameDiscovery';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DryRunRequest {
  readonly models: string[];
  readonly games: string[];
  readonly runsPerGame: number;
  readonly maxSteps: number;
}

export interface ModelValidation {
  readonly modelId: string;
  readonly hasPricing: boolean;
  readonly estimatedCostPerRun: number;
  readonly warnings: string[];
}

export interface GameValidation {
  readonly gameId: string;
  readonly found: boolean;
  readonly pyFile: string | null;
  readonly title: string | null;
  readonly baselineActions: number[] | null;
}

export interface DryRunReport {
  readonly valid: boolean;
  readonly models: ReadonlyArray<ModelValidation>;
  readonly games: ReadonlyArray<GameValidation>;
  readonly totalRuns: number;
  readonly estimatedTotalCost: number;
  readonly warnings: string[];
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a dry run configuration and estimate costs.
 * No LLM calls are made — this is purely a pre-flight check.
 */
export function validateDryRun(request: DryRunRequest): DryRunReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate models
  const modelValidations: ModelValidation[] = request.models.map((modelId) => {
    const hasPricing = false;
    const modelWarnings: string[] = [];

    modelWarnings.push(`Cost estimation unavailable for "${modelId}" — pricing is provider-reported at runtime`);

    const estimatedCostPerRun = 0;

    return {
      modelId,
      hasPricing,
      estimatedCostPerRun,
      warnings: modelWarnings,
    };
  });

  // Validate games
  const gameValidations: GameValidation[] = request.games.map((gameId) => {
    const game = getGameById(gameId);
    if (!game) {
      errors.push(`Game "${gameId}" not found in puzzle-environments`);
      return {
        gameId,
        found: false,
        pyFile: null,
        title: null,
        baselineActions: null,
      };
    }

    return {
      gameId,
      found: true,
      pyFile: game.pyFile,
      title: game.metadata.title ?? null,
      baselineActions: game.metadata.baseline_actions ?? null,
    };
  });

  // Aggregate
  const totalRuns = request.models.length * request.games.length * request.runsPerGame;
  const estimatedTotalCost = modelValidations.reduce(
    (sum, m) => sum + m.estimatedCostPerRun * request.games.length * request.runsPerGame,
    0,
  );

  // Collect warnings from model validations
  for (const m of modelValidations) {
    for (const w of m.warnings) {
      warnings.push(w);
    }
  }

  if (request.models.length === 0) {
    errors.push('No models specified');
  }
  if (request.games.length === 0) {
    errors.push('No games specified');
  }
  if (request.maxSteps < 1) {
    errors.push('maxSteps must be >= 1');
  }

  return {
    valid: errors.length === 0,
    models: modelValidations,
    games: gameValidations,
    totalRuns,
    estimatedTotalCost: Math.round(estimatedTotalCost * 100) / 100,
    warnings,
    errors,
  };
}
