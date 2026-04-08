import type { EvalConfig, EvalSessionConfig } from "@shared/eval-types";
import { MODEL_REGISTRY } from "@shared/config/llmConfig";
import { existsSync, mkdirSync, accessSync, readdirSync, constants } from "fs";
import path from "path";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Discover available game IDs by scanning environment_files/ directory.
 * Falls back to known arcengine games if directory doesn't exist.
 */
function discoverAvailableGames(): Set<string> {
  const games = new Set<string>();

  // Always include known arcengine games
  for (const g of [
    "ct01",
    "ct03",
    "ft09",
    "gw01",
    "gw02",
    "ls20",
    "vc33",
    "ws03",
    "ws04",
  ]) {
    games.add(g);
  }

  // Also scan environment_files/ for local games
  try {
    const envDir = path.resolve(process.cwd(), "environment_files");
    if (existsSync(envDir)) {
      const entries = readdirSync(envDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          games.add(entry.name);
        }
      }
    }
  } catch {
    // ignore scan errors
  }

  return games;
}

/**
 * Validates global eval configuration constraints.
 * Checks numeric bounds and required fields.
 */
export function validateEvalConfig(config: EvalConfig): ValidationResult {
  const errors: ValidationError[] = [];

  if (config.maxSteps < 1 || config.maxSteps > 200) {
    errors.push({
      field: "maxSteps",
      message: `maxSteps must be 1-200, got ${config.maxSteps}`,
    });
  }
  if (config.numRuns < 1 || config.numRuns > 100) {
    errors.push({
      field: "numRuns",
      message: `numRuns must be 1-100, got ${config.numRuns}`,
    });
  }
  if (config.contextWindow < 1 || config.contextWindow > 200) {
    errors.push({
      field: "contextWindow",
      message: `contextWindow must be 1-200, got ${config.contextWindow}`,
    });
  }
  if (config.retryAttempts < 0 || config.retryAttempts > 100) {
    errors.push({
      field: "retryAttempts",
      message: `retryAttempts must be 0-100, got ${config.retryAttempts}`,
    });
  }
  if (config.retryBackoffBase <= 0) {
    errors.push({
      field: "retryBackoffBase",
      message: "retryBackoffBase must be positive",
    });
  }
  if (config.retryMaxWait <= 0) {
    errors.push({
      field: "retryMaxWait",
      message: "retryMaxWait must be positive",
    });
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

/**
 * Validates session-specific configuration.
 * Checks game IDs, model keys, environment variables, and numeric constraints.
 */
export function validateSessionConfig(
  config: EvalSessionConfig,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // Validate game IDs against discovered games (environment_files/ + arcengine)
  if (config.gameIds.length === 0) {
    errors.push({
      field: "gameIds",
      message: "At least one game ID is required",
    });
  }
  const knownGames = discoverAvailableGames();
  for (const gameId of config.gameIds) {
    if (!knownGames.has(gameId)) {
      // Warn but don't block -- game may be loadable at runtime
      warnings.push({
        field: "gameIds",
        message: `Game "${gameId}" not in discovered games (${[...knownGames].join(", ")}). Will attempt to load at runtime.`,
      });
    }
  }

  // Validate model keys
  if (config.modelKeys.length === 0) {
    errors.push({
      field: "modelKeys",
      message: "At least one model key is required",
    });
  }
  for (const key of config.modelKeys) {
    if (!(key in MODEL_REGISTRY)) {
      errors.push({
        field: "modelKeys",
        message: `Unknown model key: "${key}". Available: ${Object.keys(MODEL_REGISTRY).join(", ")}`,
      });
    }
  }

  // Validate model API keys are set in environment
  for (const key of config.modelKeys) {
    const modelConfig = MODEL_REGISTRY[key as keyof typeof MODEL_REGISTRY];
    if (modelConfig?.envKey && !process.env[modelConfig.envKey]) {
      errors.push({
        field: "modelKeys",
        message: `Model "${key}" requires env var ${modelConfig.envKey} which is not set`,
      });
    }
  }

  // Validate numeric constraints
  if (config.numRuns < 1) {
    errors.push({ field: "numRuns", message: "numRuns must be >= 1" });
  }
  if (config.maxSteps < 1 || config.maxSteps > 200) {
    errors.push({
      field: "maxSteps",
      message: `maxSteps must be 1-200, got ${config.maxSteps}`,
    });
  }
  if (config.contextWindow < 1) {
    errors.push({
      field: "contextWindow",
      message: "contextWindow must be >= 1",
    });
  }

  // Guard: ARC3 games are text-only — withImages has no effect and wastes prompt tokens
  if (config.withImages) {
    warnings.push({
      field: "withImages",
      message:
        "withImages=true has no effect for ARC3 games (renderPngBase64 returns null). Flag will be ignored.",
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validates that the output directory exists and is writable.
 * Creates the directory if it does not exist.
 */
export function validateOutputDir(outputDir: string): ValidationResult {
  const errors: ValidationError[] = [];

  try {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    // Verify writable
    accessSync(outputDir, constants.W_OK);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({
      field: "outputDir",
      message: `Output directory "${outputDir}" is not writable: ${message}`,
    });
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

/**
 * Combined validator that runs all validation checks.
 * Returns aggregated results from eval config, session config, and output directory.
 */
export function validateAll(
  evalConfig: EvalConfig,
  sessionConfig: EvalSessionConfig,
): ValidationResult {
  const results = [
    validateEvalConfig(evalConfig),
    validateSessionConfig(sessionConfig),
    validateOutputDir(evalConfig.outputDir),
  ];

  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);
  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
