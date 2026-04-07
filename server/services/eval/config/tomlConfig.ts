/**
 * Author: claude-haiku-4-5
 * Date: 2026-03-24
 * PURPOSE: Port of Python's toml_config.py — Parse eval.toml configuration files and merge CLI overrides.
 *          Handles simple TOML format with [eval], [budget], [circuit_breaker] sections.
 * SRP/DRY check: Pass — Single responsibility (TOML parsing + merging), uses stdlib fs/path, no external dependencies.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../utils/logger';

export interface TomlEvalConfig {
  // [eval] section
  game?: string[] | null;
  gameDir?: string | null;
  exclude?: string[] | null;
  models?: string[] | null;
  runs?: number | null;
  maxSteps?: number | null;
  contextWindow?: number | null;
  seed?: number | null;
  outputDir?: string | null;
  parallelGames?: number | null;
  parallelRuns?: number | null;
  sequential?: boolean | null;

  // [budget] section
  budgetGlobalUsd?: number | null;
  budgetPerGameUsd?: number | null;

  // [circuit_breaker] section
  circuitBreakerThreshold?: number | null;
  circuitBreakerHalfOpenSeconds?: number | null;

  // Top-level
  resume?: boolean; // default false
}

export interface CliArgs {
  game?: string[];
  gameDir?: string;
  exclude?: string[];
  models?: string[];
  runs?: number;
  maxSteps?: number;
  contextWindow?: number;
  seed?: number;
  outputDir?: string;
  parallelGames?: number;
  parallelRuns?: number;
  sequential?: boolean;
  circuitBreakerThreshold?: number | null;
  circuitBreakerHalfOpenSeconds?: number | null;
  budgetGlobal?: number | null;
  budgetPerGame?: number | null;
  resume?: boolean;
}

/**
 * Simple TOML parser for eval.toml format.
 * Supports:
 *   - [section] headers
 *   - key = value (string, number, boolean, array)
 *   - Arrays: ["a", "b"] or [1, 2]
 *   - Strings: "value" or 'value'
 *   - Comments: # comment
 */
function parseToml(content: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentSection = 'eval'; // default section
  result[currentSection] = {};

  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) continue;

    // Section header: [eval], [budget], etc.
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key = value
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const valueStr = line.slice(eqIndex + 1).trim();

    // Remove inline comments
    let valueTrimmed = valueStr;
    const commentIndex = valueStr.indexOf('#');
    if (commentIndex > 0) {
      valueTrimmed = valueStr.slice(0, commentIndex).trim();
    }

    const value = parseTomlValue(valueTrimmed);
    result[currentSection][key] = value;
  }

  return result;
}

/**
 * Parse a single TOML value: string, number, boolean, or array.
 */
function parseTomlValue(valueStr: string): unknown {
  // Array: ["a", "b"] or [1, 2]
  if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
    const innerStr = valueStr.slice(1, -1).trim();
    if (!innerStr) return [];

    const items = innerStr.split(',').map((s) => {
      const item = s.trim();
      // Quoted string
      if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
        return item.slice(1, -1);
      }
      // Number
      const num = Number(item);
      if (!Number.isNaN(num)) return num;
      // Unquoted string
      return item;
    });
    return items;
  }

  // Quoted string: "value" or 'value'
  if ((valueStr.startsWith('"') && valueStr.endsWith('"')) || (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
    return valueStr.slice(1, -1);
  }

  // Boolean: true / false (case-insensitive)
  if (valueStr.toLowerCase() === 'true') return true;
  if (valueStr.toLowerCase() === 'false') return false;

  // Number: integers or floats
  const num = Number(valueStr);
  if (!Number.isNaN(num) && valueStr !== '') return num;

  // Fallback: unquoted string
  return valueStr;
}

/**
 * Load and parse a TOML configuration file.
 * Validates section and key names, warns on unknowns.
 * Normalizes single strings to arrays for array fields (game, exclude, models).
 */
export function loadTomlConfig(tomlPath?: string): TomlEvalConfig {
  const resolvedPath = tomlPath || join(process.cwd(), 'eval.toml');

  if (!existsSync(resolvedPath)) {
    logger.warn(`[tomlConfig] TOML file not found: ${resolvedPath}, returning defaults`, 'eval-config');
    return { resume: false };
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  const tomlData = parseToml(content);

  const cfg: TomlEvalConfig = { resume: false };

  // Known sections and their allowed keys (snake_case in TOML)
  const knownKeys: Record<string, Set<string>> = {
    eval: new Set(['game', 'game_dir', 'exclude', 'models', 'runs', 'max_steps', 'context_window', 'seed', 'output_dir', 'parallel_games', 'parallel_runs', 'sequential']),
    budget: new Set(['global_usd', 'per_game_usd']),
    circuit_breaker: new Set(['threshold', 'half_open_seconds']),
  };

  // Process sections
  for (const [section, sectionData] of Object.entries(tomlData)) {
    const allowedKeys = knownKeys[section];
    if (!allowedKeys) {
      logger.warn(`[tomlConfig] Unknown TOML section: [${section}]`, 'eval-config');
      continue;
    }

    // Validate and map keys
    for (const [snakeCaseKey, value] of Object.entries(sectionData)) {
      if (!allowedKeys.has(snakeCaseKey)) {
        logger.warn(`[tomlConfig] Unknown key in [${section}]: ${snakeCaseKey}`, 'eval-config');
        continue;
      }

      // Map snake_case TOML keys to camelCase interface fields
      if (section === 'eval') {
        switch (snakeCaseKey) {
          case 'game': {
            const normalized = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
            cfg.game = normalized;
            break;
          }
          case 'game_dir':
            cfg.gameDir = value as string | null;
            break;
          case 'exclude': {
            const normalized = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
            cfg.exclude = normalized;
            break;
          }
          case 'models': {
            const normalized = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
            cfg.models = normalized;
            break;
          }
          case 'runs':
            cfg.runs = value as number | null;
            break;
          case 'max_steps':
            cfg.maxSteps = value as number | null;
            break;
          case 'context_window':
            cfg.contextWindow = value as number | null;
            break;
          case 'seed':
            cfg.seed = value as number | null;
            break;
          case 'output_dir':
            cfg.outputDir = value as string | null;
            break;
          case 'parallel_games':
            cfg.parallelGames = value as number | null;
            break;
          case 'parallel_runs':
            cfg.parallelRuns = value as number | null;
            break;
          case 'sequential':
            cfg.sequential = value as boolean | null;
            break;
        }
      } else if (section === 'budget') {
        switch (snakeCaseKey) {
          case 'global_usd':
            cfg.budgetGlobalUsd = value as number | null;
            break;
          case 'per_game_usd':
            cfg.budgetPerGameUsd = value as number | null;
            break;
        }
      } else if (section === 'circuit_breaker') {
        switch (snakeCaseKey) {
          case 'threshold':
            cfg.circuitBreakerThreshold = value as number | null;
            break;
          case 'half_open_seconds':
            cfg.circuitBreakerHalfOpenSeconds = value as number | null;
            break;
        }
      }
    }
  }

  return cfg;
}

/**
 * Helper: Pick a value based on priority.
 * Returns CLI value if it differs from cliDefault, otherwise TOML value if present, otherwise cliDefault.
 */
function _pick<T>(cliVal: T | undefined, tomlVal: T | null | undefined, cliDefault: T | undefined): T | null | undefined {
  if (cliVal !== undefined && cliVal !== cliDefault) {
    return cliVal;
  }
  return tomlVal !== null && tomlVal !== undefined ? tomlVal : cliDefault;
}

/**
 * Merge CLI arguments over TOML config.
 * CLI values win if explicitly set (differ from their defaults).
 * Otherwise, TOML values are used.
 * Otherwise, CLI defaults are used.
 */
export function mergeCliOverToml(tomlCfg: TomlEvalConfig, cliArgs: CliArgs): TomlEvalConfig {
  const merged: TomlEvalConfig = { resume: tomlCfg.resume ?? false };

  // String array fields
  merged.game = _pick(cliArgs.game, tomlCfg.game, undefined);
  merged.exclude = _pick(cliArgs.exclude, tomlCfg.exclude, undefined);
  merged.models = _pick(cliArgs.models, tomlCfg.models, undefined);

  // String fields
  merged.gameDir = _pick(cliArgs.gameDir, tomlCfg.gameDir, undefined);
  merged.outputDir = _pick(cliArgs.outputDir, tomlCfg.outputDir, undefined);

  // Number fields
  merged.runs = _pick(cliArgs.runs, tomlCfg.runs, undefined);
  merged.maxSteps = _pick(cliArgs.maxSteps, tomlCfg.maxSteps, undefined);
  merged.contextWindow = _pick(cliArgs.contextWindow, tomlCfg.contextWindow, undefined);
  merged.seed = _pick(cliArgs.seed, tomlCfg.seed, undefined);
  merged.parallelGames = _pick(cliArgs.parallelGames, tomlCfg.parallelGames, undefined);
  merged.parallelRuns = _pick(cliArgs.parallelRuns, tomlCfg.parallelRuns, undefined);
  merged.circuitBreakerThreshold = _pick(cliArgs.circuitBreakerThreshold, tomlCfg.circuitBreakerThreshold, undefined);
  merged.circuitBreakerHalfOpenSeconds = _pick(cliArgs.circuitBreakerHalfOpenSeconds, tomlCfg.circuitBreakerHalfOpenSeconds, undefined);

  // Budget fields
  merged.budgetGlobalUsd = _pick(cliArgs.budgetGlobal, tomlCfg.budgetGlobalUsd, undefined);
  merged.budgetPerGameUsd = _pick(cliArgs.budgetPerGame, tomlCfg.budgetPerGameUsd, undefined);

  // Boolean fields
  merged.sequential = _pick(cliArgs.sequential, tomlCfg.sequential, undefined);

  // Resume: CLI takes priority if set, else fall back to TOML, else default to false
  if (cliArgs.resume !== undefined) {
    merged.resume = cliArgs.resume;
  } else {
    merged.resume = tomlCfg.resume ?? false;
  }

  return merged;
}
