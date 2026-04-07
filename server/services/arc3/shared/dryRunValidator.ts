

import { getAvailableGames, getGameById } from './gameDiscovery';
import { PRICING, computeCost } from '@shared/providers/pricing';

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
// Average tokens per step (based on historical eval data)
// ---------------------------------------------------------------------------

const AVG_INPUT_TOKENS_PER_STEP = 3500;
const AVG_OUTPUT_TOKENS_PER_STEP = 800;
const AVG_REASONING_TOKENS_PER_STEP = 1200;
const AVG_CACHED_INPUT_TOKENS_PER_STEP = 1500;
const AVG_STEPS_PER_RUN = 15;

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
    const hasPricing = modelId in PRICING || findPricingKey(modelId) !== null;
    const modelWarnings: string[] = [];

    if (!hasPricing) {
      modelWarnings.push(`No pricing data for "${modelId}" — cost estimates unavailable`);
    }

    // Estimate cost per run
    let estimatedCostPerRun = 0;
    if (hasPricing) {
      const stepsToEstimate = Math.min(request.maxSteps, AVG_STEPS_PER_RUN);
      try {
        const costPerStep = computeCost(
          modelId,
          AVG_INPUT_TOKENS_PER_STEP,
          AVG_OUTPUT_TOKENS_PER_STEP,
          AVG_REASONING_TOKENS_PER_STEP,
          AVG_CACHED_INPUT_TOKENS_PER_STEP,
          0,
        );
        estimatedCostPerRun = costPerStep * stepsToEstimate;
      } catch {
        modelWarnings.push('Cost estimation failed — pricing lookup error');
      }
    }

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPricingKey(modelId: string): string | null {
  for (const key of Object.keys(PRICING)) {
    if (modelId.startsWith(key) || key.startsWith(modelId)) {
      return key;
    }
  }
  return null;
}
