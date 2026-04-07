

// Load .env BEFORE any code that reads process.env
import "dotenv/config";

import { promises as fs } from "fs";
import path from "path";

import {
  MODEL_REGISTRY,
  ALL_MODEL_KEYS,
  DEFAULT_EVAL_CONFIG,
  DEFAULT_OUTPUT_DIR,
  getApiKey,
} from "@shared/config/llmConfig";
import type {
  EvalConfig,
  EvalSessionConfig,
  EvalEvent,
  EventEmitter,
} from "@shared/eval-types";
import { EvalOrchestrator } from "../evalOrchestrator";
import type { SessionResult } from "../evalOrchestrator";
import { discoverGames, ENVIRONMENT_FILES_DIR } from "../adapters/types";
import { JsonlWriter } from "../data/traceWriter";

interface CliArgs {
  gameIds: string[];
  modelKeys: string[];
  numRuns: number;
  maxSteps: number;
  contextWindow: number;
  seedBase: number;
  outputDir: string;
  dryRun: boolean;
  withImages: boolean;
  listModels: boolean;
  listGames: boolean;
  verbose: boolean;
  jsonl: boolean;
  budgetGlobal: number | null;
  budgetPerGame: number | null;
  circuitThreshold: number;
  circuitHalfOpen: number;
  gameDir: string | undefined;
  parallelGames: number;
  parallelRuns: number;
  sequential: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    gameIds: [],
    modelKeys: [],
    numRuns: DEFAULT_EVAL_CONFIG.numRuns,
    maxSteps: DEFAULT_EVAL_CONFIG.maxSteps,
    contextWindow: DEFAULT_EVAL_CONFIG.contextWindow,
    seedBase: DEFAULT_EVAL_CONFIG.seedBase,
    outputDir: DEFAULT_OUTPUT_DIR,
    dryRun: false,
    withImages: false,
    listModels: false,
    listGames: false,
    verbose: false,
    jsonl: false,
    budgetGlobal: null,
    budgetPerGame: null,
    circuitThreshold: 10,
    circuitHalfOpen: 300,
    gameDir: undefined,
    parallelGames: 1,
    parallelRuns: 1,
    sequential: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    switch (arg) {
      case "--game": {
        i++;
        while (i < argv.length && !argv[i]!.startsWith("--")) {
          args.gameIds.push(argv[i]!);
          i++;
        }
        break;
      }
      case "--models": {
        i++;
        while (i < argv.length && !argv[i]!.startsWith("--")) {
          args.modelKeys.push(argv[i]!);
          i++;
        }
        break;
      }
      case "--runs": {
        i++;
        args.numRuns = parseInt(argv[i] ?? "3", 10);
        i++;
        break;
      }
      case "--max-steps": {
        i++;
        args.maxSteps = parseInt(argv[i] ?? "200", 10);
        i++;
        break;
      }
      case "--context-window": {
        i++;
        args.contextWindow = parseInt(argv[i] ?? "50", 10);
        i++;
        break;
      }
      case "--seed": {
        i++;
        args.seedBase = parseInt(argv[i] ?? "42", 10);
        i++;
        break;
      }
      case "--output-dir": {
        i++;
        args.outputDir = argv[i] ?? DEFAULT_OUTPUT_DIR;
        i++;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        i++;
        break;
      case "--with-images":
        args.withImages = true;
        i++;
        break;
      case "--list-models":
        args.listModels = true;
        i++;
        break;
      case "--list-games":
        args.listGames = true;
        i++;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        i++;
        break;
      case "--jsonl":
        args.jsonl = true;
        i++;
        break;
      case "--budget-global": {
        i++;
        args.budgetGlobal = parseFloat(argv[i] ?? "0");
        i++;
        break;
      }
      case "--budget-per-game": {
        i++;
        args.budgetPerGame = parseFloat(argv[i] ?? "0");
        i++;
        break;
      }
      case "--circuit-threshold": {
        i++;
        args.circuitThreshold = parseInt(argv[i] ?? "10", 10);
        i++;
        break;
      }
      case "--circuit-half-open": {
        i++;
        args.circuitHalfOpen = parseFloat(argv[i] ?? "300");
        i++;
        break;
      }
      case "--parallel-games": {
        i++;
        args.parallelGames = Math.min(
          Math.max(1, parseInt(argv[i] ?? "1", 10)),
          20,
        );
        i++;
        break;
      }
      case "--parallel-runs": {
        i++;
        args.parallelRuns = Math.min(
          Math.max(1, parseInt(argv[i] ?? "1", 10)),
          10,
        );
        i++;
        break;
      }
      case "--sequential":
        args.sequential = true;
        i++;
        break;
      case "--game-dir": {
        i++;
        args.gameDir = argv[i] ?? undefined;
        i++;
        break;
      }
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`
Usage: npm run eval -- [options]

Options:
  --game <id...> | all       Game IDs to evaluate (required unless --list-*)
  --models <key...> | all    Model keys to evaluate (default: all)
  --runs <n>                 Runs per model-game pair (default: ${DEFAULT_EVAL_CONFIG.numRuns})
  --max-steps <n>            Max steps per run (default: ${DEFAULT_EVAL_CONFIG.maxSteps})
  --context-window <n>       Conversation turns visible (default: ${DEFAULT_EVAL_CONFIG.contextWindow})
  --seed <n>                 Base random seed (default: ${DEFAULT_EVAL_CONFIG.seedBase})
  --output-dir <path>        Output directory (default: data/puzzle-evals)
  --dry-run                  Validate config without API calls
  --with-images              Include PNG screenshots in prompts
  --list-models              List available models and exit
  --list-games               List available ARC3 games and exit
  --jsonl                    Emit JSONL events to stdout
  --budget-global <usd>      Global USD budget limit (default: unlimited)
  --budget-per-game <usd>    Per-game USD budget limit (default: unlimited)
  --circuit-threshold <n>    Consecutive failures to trip circuit breaker (default: 10)
  --circuit-half-open <sec>  Seconds before half-open retry (default: 300)
  --parallel-games <n>       Games to run in parallel (default: 1, max: 20)
  --parallel-runs <n>        Runs per model in parallel (default: 1, max: 10)
  --sequential               Run models sequentially instead of in parallel
  --game-dir <path>           Override game directory (default: puzzle-environments/)
  --verbose, -v              Enable verbose logging

Cancel sentinels (touch file in {output-dir}/cancel/):
  CANCEL_ALL                 Stop everything immediately
  DRAIN                      Finish in-progress games, skip new ones
  CANCEL_{gameId}            Cancel a specific game
  CANCEL_{gameId}_{modelKey} Cancel a specific model on a specific game

Examples:
  npm run eval -- --game ct01 --models all
  npm run eval -- --game ct01 ct03 --models gpt-5.4 --runs 3
  npm run eval -- --game all --models all --dry-run
  npm run eval -- --game all --models all --parallel-games 3
  npm run eval -- --game bw01 --models gpt-5.4 --parallel-runs 3
  npm run eval -- --list-models
  npm run eval -- --list-games
`);
}

function makeJsonlEmitter(): EventEmitter {
  return (event: EvalEvent) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  };
}

function makeConsoleEmitter(verbose: boolean): EventEmitter {
  return (event: EvalEvent) => {
    switch (event.type) {
      case "session_start":
        break;
      case "run_start":
        console.error(
          `  [run_start] ${event.model} / ${event.game_id} #${event.run_number}`,
        );
        break;
      case "step":
        if (verbose) {
          console.error(
            `    [step ${event.step}] ` +
              `action=${event.action} score=${event.score}`,
          );
        }
        break;
      case "run_end":
        console.error(
          `  [run_end] ${event.model} / ${event.game_id} ` +
            `score=${event.final_score} steps=${event.total_steps} ` +
            `cost=$${event.cost_usd?.toFixed(4) ?? "?"}`,
        );
        break;
      case "model_done":
        console.error(
          `  [model_done] ${event.model} / ${event.game_id} ` +
            `avg=${event.avg_score_pct}% solved=${event.solved_count}/${event.total_runs}`,
        );
        break;
      case "error":
        console.error(`  [ERROR] ${event.code}: ${event.message}`);
        break;
      case "log":
        if (verbose || event.level !== "debug") {
          console.error(`  [${event.level}] ${event.message}`);
        }
        break;
      case "session_end":
        break;
    }
  };
}

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

  if (cliArgs.listModels) {
    console.log(`\nAvailable models (${ALL_MODEL_KEYS.length}):\n`);
    console.log(`  ${"Key".padEnd(30)} ${"Name".padEnd(35)} Provider`);
    console.log(`  ${"-".repeat(30)} ${"-".repeat(35)} ${"-".repeat(20)}`);
    for (const key of ALL_MODEL_KEYS) {
      const cfg = MODEL_REGISTRY[key];
      if (cfg) {
        console.log(
          `  ${key.padEnd(30)} ${cfg.name.padEnd(35)} ${cfg.provider}`,
        );
      }
    }
    console.log();
    return;
  }

  // --list-games (dynamic discovery from environment_files/)
  if (cliArgs.listGames) {
    const discovered = discoverGames(cliArgs.gameDir);
    const root = cliArgs.gameDir ?? ENVIRONMENT_FILES_DIR;
    console.log(`\nAvailable games in ${root} (${discovered.length}):\n`);
    console.log(`  ${"ID".padEnd(12)} ${"Tags".padEnd(40)} Path`);
    console.log(`  ${"-".repeat(12)} ${"-".repeat(40)} ${"-".repeat(40)}`);
    for (const g of discovered) {
      const tags = g.metadata.tags?.join(", ") ?? "";
      console.log(`  ${g.gameId.padEnd(12)} ${tags.padEnd(40)} ${g.gameDir}`);
    }
    console.log();
    return;
  }

  // Resolve game IDs (dynamic discovery replaces hardcoded list)
  const discovered = discoverGames(cliArgs.gameDir);
  const allGameIds = discovered.map((g) => g.gameId);

  let gameIds: string[];
  if (cliArgs.gameIds.length === 0) {
    console.error(
      "Error: --game is required (or use --list-games / --list-models)",
    );
    printUsage();
    process.exit(1);
  } else if (cliArgs.gameIds.includes("all")) {
    if (allGameIds.length === 0) {
      console.error(
        `Error: No games found in ${cliArgs.gameDir ?? ENVIRONMENT_FILES_DIR}`,
      );
      process.exit(1);
    }
    gameIds = allGameIds;
  } else {
    gameIds = cliArgs.gameIds;
  }

  // Resolve model keys
  let modelKeys: string[];
  if (cliArgs.modelKeys.length === 0 || cliArgs.modelKeys.includes("all")) {
    modelKeys = [...ALL_MODEL_KEYS];
  } else {
    // Validate model keys
    for (const mk of cliArgs.modelKeys) {
      if (!MODEL_REGISTRY[mk]) {
        console.error(
          `Error: Unknown model key "${mk}". Available: ${ALL_MODEL_KEYS.join(", ")}`,
        );
        process.exit(1);
      }
    }
    modelKeys = cliArgs.modelKeys;
  }

  // Validate API keys (always — even in dry-run, to catch config errors early)
  for (const mk of modelKeys) {
    try {
      getApiKey(mk);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // Build EvalConfig (merge CLI args over defaults)
  const evalConfig: EvalConfig = {
    ...DEFAULT_EVAL_CONFIG,
    maxSteps: cliArgs.maxSteps,
    numRuns: cliArgs.numRuns,
    contextWindow: cliArgs.contextWindow,
    seedBase: cliArgs.seedBase,
    outputDir: cliArgs.outputDir,
    dryRun: cliArgs.dryRun,
  };

  // Build EvalSessionConfig
  const sessionConfig: EvalSessionConfig = {
    gameIds,
    modelKeys,
    numRuns: cliArgs.numRuns,
    maxSteps: cliArgs.maxSteps,
    seedBase: cliArgs.seedBase,
    contextWindow: cliArgs.contextWindow,
    withImages: cliArgs.withImages,
    envDir: cliArgs.gameDir,
  };

  // Set up event emitter
  const eventEmitter = cliArgs.jsonl
    ? makeJsonlEmitter()
    : makeConsoleEmitter(cliArgs.verbose);

  // Print run plan banner (non-JSONL mode)
  const totalRuns = gameIds.length * modelKeys.length * cliArgs.numRuns;

  if (!cliArgs.jsonl) {
    console.log();
    console.log("=".repeat(60));
    console.log("  Puzzle Evaluation Harness (TypeScript)");
    console.log(
      `  Games:  ${gameIds.length} (${gameIds.slice(0, 5).join(", ")}${gameIds.length > 5 ? "..." : ""})`,
    );
    console.log(
      `  Models: ${modelKeys.length} (${modelKeys.slice(0, 3).join(", ")}${modelKeys.length > 3 ? "..." : ""})`,
    );
    console.log(
      `  Runs:   ${cliArgs.numRuns} per model per game (${totalRuns} total)`,
    );
    console.log(`  Steps:  max ${cliArgs.maxSteps} per run`);
    console.log(`  Seed:   ${cliArgs.seedBase}`);
    console.log(`  Output: ${cliArgs.outputDir}`);
    if (cliArgs.withImages) console.log("  Images: enabled");
    if (cliArgs.gameDir) console.log(`  GameDir: ${cliArgs.gameDir}`);
    if (cliArgs.budgetGlobal)
      console.log(`  Budget: $${cliArgs.budgetGlobal} global`);
    if (cliArgs.budgetPerGame)
      console.log(`  Budget: $${cliArgs.budgetPerGame} per game`);
    if (cliArgs.parallelGames > 1)
      console.log(`  Parallel games: ${cliArgs.parallelGames}`);
    if (cliArgs.parallelRuns > 1)
      console.log(`  Parallel runs:  ${cliArgs.parallelRuns}`);
    if (cliArgs.sequential) console.log("  Models: sequential");
    if (cliArgs.dryRun) console.log("  MODE:   DRY RUN (no API calls)");
    console.log(`  Cancel: touch ${cliArgs.outputDir}/cancel/CANCEL_ALL`);
    console.log("=".repeat(60));
    console.log();
  }

  // Dry run: validate config, create output structure, and exit
  if (cliArgs.dryRun) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const sessionDir = path.join(cliArgs.outputDir, timestamp);

    await fs.mkdir(sessionDir, { recursive: true });

    const csvHeader =
      "run_id,model,game_id,run_number,step,input_tokens,output_tokens,reasoning_tokens,cost_usd\n";

    for (const gid of gameIds) {
      const gameDir = path.join(sessionDir, gid);
      const tracesDir = path.join(gameDir, "traces");
      await fs.mkdir(tracesDir, { recursive: true });

      const runsWriter = new JsonlWriter(path.join(gameDir, "runs.jsonl"));
      await fs.writeFile(path.join(gameDir, "steps.jsonl"), "", "utf-8");
      await fs.writeFile(
        path.join(gameDir, "token_usage.csv"),
        csvHeader,
        "utf-8",
      );

      for (const mk of modelKeys) {
        const safeModel = mk.replace(/[^a-zA-Z0-9._-]/g, "_");
        for (let run = 0; run < cliArgs.numRuns; run++) {
          const seed = cliArgs.seedBase + run;
          const runId = `${mk}_${gid}_run${run}_seed${seed}`;
          await runsWriter.append({
            type: "planned_run",
            runId,
            model: MODEL_REGISTRY[mk]?.name ?? mk,
            modelKey: mk,
            gameId: gid,
            runNumber: run,
            seed,
            maxSteps: cliArgs.maxSteps,
            dryRun: true,
            timestamp: new Date().toISOString(),
          });

          const tracePath = path.join(
            tracesDir,
            `${safeModel}_run${run}_trace.jsonl`,
          );
          await fs.writeFile(tracePath, "", "utf-8");
        }
      }
    }

    console.log(`Dry run complete. Config is valid.`);
    console.log(`Output directory created: ${sessionDir}`);
    for (const gid of gameIds) {
      const runCount = modelKeys.length * cliArgs.numRuns;
      console.log(`  ${gid}/`);
      console.log(`    runs.jsonl:      ${runCount} planned runs`);
      console.log(`    steps.jsonl:     (empty - dry run)`);
      console.log(`    token_usage.csv: (header only)`);
      console.log(`    traces/:         ${runCount} trace file(s) created`);
    }
    return;
  }

  // Create orchestrator and run
  const orchestrator = new EvalOrchestrator(
    sessionConfig,
    evalConfig,
    eventEmitter,
    cliArgs.budgetGlobal,
    cliArgs.budgetPerGame,
    cliArgs.circuitThreshold,
    cliArgs.circuitHalfOpen,
    cliArgs.parallelGames,
    cliArgs.parallelRuns,
    cliArgs.sequential,
  );

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = () => {
    console.error("\nShutting down gracefully... (press again to force)");
    orchestrator.abort();
    // Second signal = force exit
    process.once("SIGINT", () => process.exit(130));
    process.once("SIGTERM", () => process.exit(143));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Execute
  const startTime = Date.now();
  let result: SessionResult;

  try {
    result = await orchestrator.runSession();
  } catch (err) {
    console.error(
      `\nFatal error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const elapsed = (Date.now() - startTime) / 1000;

  // Print summary (non-JSONL mode)
  if (!cliArgs.jsonl) {
    console.log();
    console.log("=".repeat(60));
    console.log(`  ${result.status.toUpperCase()}`);
    console.log(`  Total time:  ${elapsed.toFixed(1)}s`);
    console.log(`  Total cost:  $${result.totalCost.toFixed(4)}`);
    console.log(`  Total tokens: ${result.totalTokens.toLocaleString()}`);
    console.log(`  Results:`);
    for (const r of result.results) {
      const modelName = MODEL_REGISTRY[r.modelKey]?.name ?? r.modelKey;
      const pct = (r.avgScore * 100).toFixed(1);
      console.log(
        `    ${modelName} / ${r.gameId}: ` +
          `avg=${pct}% solved=${r.solvedCount}/${r.totalRuns} ` +
          `cost=$${r.runCost.toFixed(4)} steps=${r.runSteps}`,
      );
    }
    console.log(`  Output: ${cliArgs.outputDir}`);
    console.log("=".repeat(60));
    console.log();
  }

  // Exit code: 0=success, 1=partial failure, 2=budget exceeded, 3=all failed, 130=cancelled
  if (result.status === "cancelled") {
    process.exit(130);
  } else if (result.budgetExceeded) {
    process.exit(2);
  } else if (result.status === "failed") {
    process.exit(3);
  } else if (result.results.some((r) => r.error !== null)) {
    process.exit(1);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  console.error(
    "Unhandled error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
