import { randomUUID } from 'node:crypto';
import { Notepad } from '../../eval/runner/notepad';
import { ContextManager } from '../../eval/runner/contextManager';
import { CostTracker, type StepCost } from './CostTracker';
import { callWithRetry, type RetryConfig, type OnRetryCallback } from './callWithRetry';
import type { StepRecord, RunRecord } from './stepRecord';
import type { Arc3StreamHarness } from '../tools/Arc3ToolFactory';

// ---------------------------------------------------------------------------
// StepProvider interface — adapts different LLM backends
// ---------------------------------------------------------------------------

export interface StepResponse {
  readonly action: string;
  readonly reasoning: string;
  readonly notepadUpdate: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly rawResponse: Record<string, any> | null;
}

export interface StepProvider {
  call(
    systemPrompt: string,
    history: Array<{ role: string; content: string }>,
    currentPrompt: string,
    validActions: string[],
    signal?: AbortSignal,
  ): Promise<StepResponse>;

  /** Human-readable model identifier for logging. */
  readonly modelId: string;
}

// ---------------------------------------------------------------------------
// StepLoopConfig
// ---------------------------------------------------------------------------

export interface StepLoopConfig {
  readonly runId: string;
  readonly gameId: string;
  readonly gameGuid: string;
  readonly scorecardId: string;
  readonly modelId: string;
  readonly maxSteps: number;
  readonly systemPrompt: string;
  readonly retryConfig?: Partial<RetryConfig>;
  readonly contextWindowSize?: number;   // Default: 10
  readonly notepadMaxChars?: number;     // Default: 4000
}

// ---------------------------------------------------------------------------
// StepLoopCallbacks — integration points for runners
// ---------------------------------------------------------------------------

export interface StepLoopCallbacks {
  /** Get current game state as text observation for the LLM. */
  renderObservation(): string;

  /** Get currently valid actions. */
  getValidActions(): string[];

  /** Execute an action in the game. Returns feedback text. */
  executeAction(action: string): Promise<string>;

  /** Check if the game is done (WIN or GAME_OVER). */
  isDone(): boolean;

  /** Get current score. */
  getScore(): number;

  /** Get current game state string. */
  getState(): string;

  /** Get action counter / max actions for StepRecord. */
  getActionInfo(): { actionCounter: number | null; maxActions: number | null };

  /** Get level info for StepRecord. */
  getLevelInfo(): { level: number | null; totalLevels: number | null };

  /** Get score percentage (0-100). */
  getScorePct(): number;
}

// ---------------------------------------------------------------------------
// StepLoopResult
// ---------------------------------------------------------------------------

export interface StepLoopResult {
  readonly runId: string;
  readonly costTracker: CostTracker;
  readonly notepad: Notepad;
  readonly totalSteps: number;
  readonly stepRecords: ReadonlyArray<StepRecord>;
  readonly finalState: string;
  readonly finalScore: number;
  readonly elapsedMs: number;
  readonly aborted: boolean;
}

// ---------------------------------------------------------------------------
// StepLoopEngine
// ---------------------------------------------------------------------------

export class StepLoopEngine {
  private readonly provider: StepProvider;
  private readonly config: StepLoopConfig;
  private readonly callbacks: StepLoopCallbacks;
  private readonly streamHarness: Arc3StreamHarness | null;
  private readonly signal?: AbortSignal;
  private readonly onRetry?: OnRetryCallback;

  constructor(params: {
    provider: StepProvider;
    config: StepLoopConfig;
    callbacks: StepLoopCallbacks;
    streamHarness?: Arc3StreamHarness;
    signal?: AbortSignal;
    onRetry?: OnRetryCallback;
  }) {
    this.provider = params.provider;
    this.config = params.config;
    this.callbacks = params.callbacks;
    this.streamHarness = params.streamHarness ?? null;
    this.signal = params.signal;
    this.onRetry = params.onRetry;
  }

  /**
   * Execute the step loop. Returns when game is done, max steps reached,
   * or the abort signal fires.
   */
  async run(): Promise<StepLoopResult> {
    const runStartMs = Date.now();
    const notepad = new Notepad(this.config.notepadMaxChars ?? 4000);
    const context = new ContextManager({
      windowSize: this.config.contextWindowSize ?? 10,
    });
    let costTracker = new CostTracker();
    const stepRecords: StepRecord[] = [];
    let step = 0;

    while (step < this.config.maxSteps && !this.callbacks.isDone()) {
      if (this.signal?.aborted) break;

      const stepStartMs = Date.now();

      // 1. Render current observation
      const observation = this.callbacks.renderObservation();
      const validActions = this.callbacks.getValidActions();

      // 2. Build turn prompt (observation + notepad + available actions)
      const turnPrompt = this.buildTurnPrompt(observation, notepad, validActions, step);

      // 3. Call LLM with retry
      const history = context.getContext() as Array<{ role: string; content: string }>;

      let response: StepResponse;
      try {
        response = await callWithRetry(
          () => this.provider.call(
            this.config.systemPrompt,
            history,
            turnPrompt,
            validActions,
            this.signal,
          ),
          this.config.retryConfig ?? {},
          this.signal,
          (event) => {
            this.onRetry?.(event);
            this.emitEvent('agent.retry', {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              waitMs: event.waitMs,
              tier: event.tier,
              reason: event.reason,
              step,
              timestamp: Date.now(),
            });
          },
        );
      } catch (err) {
        // All retries exhausted — emit error and break
        this.emitEvent('agent.step_error', {
          step,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
        break;
      }

      if (this.signal?.aborted) break;

      // 4. Emit reasoning
      if (response.reasoning) {
        this.emitEvent('agent.reasoning', {
          content: response.reasoning,
          step,
          timestamp: Date.now(),
        });
      }

      // 5. Update notepad if requested
      if (response.notepadUpdate !== null) {
        notepad.update(response.notepadUpdate);
        this.emitEvent('agent.notepad_updated', {
          content: notepad.read(),
          length: notepad.read().length,
          step,
          timestamp: Date.now(),
        });
      }

      // 6. Execute action
      const action = response.action;
      let gameFeedback = '';

      if (action !== 'SKIP') {
        this.emitEvent('agent.tool_call', {
          tool: action,
          step,
          timestamp: Date.now(),
        });

        try {
          gameFeedback = await this.callbacks.executeAction(action);
        } catch (err) {
          gameFeedback = `Action failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        this.emitEvent('agent.tool_result', {
          tool: action,
          result: gameFeedback,
          step,
          timestamp: Date.now(),
        });
      }

      // 7. Record step cost
      const stepElapsedMs = Date.now() - stepStartMs;
      const stepCost: StepCost = {
        stepNumber: step,
        action,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        reasoningTokens: response.reasoningTokens,
        cachedInputTokens: response.cachedInputTokens,
        cacheWriteTokens: response.cacheWriteTokens,
        costUsd: response.costUsd,
        elapsedMs: stepElapsedMs,
      };
      costTracker = costTracker.recordStep(stepCost);

      // 8. Emit cost update
      this.emitEvent('agent.cost_update', {
        ...costTracker.toSSEPayload(),
        step,
        stepCostUsd: response.costUsd,
        timestamp: Date.now(),
      });

      // 9. Build and store step record
      const { actionCounter, maxActions } = this.callbacks.getActionInfo();
      const { level, totalLevels } = this.callbacks.getLevelInfo();
      const stepRecord: StepRecord = {
        runId: this.config.runId,
        stepNumber: step,
        action,
        reasoning: response.reasoning,
        notepadUpdate: response.notepadUpdate,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        reasoningTokens: response.reasoningTokens,
        cachedInputTokens: response.cachedInputTokens,
        cacheWriteTokens: response.cacheWriteTokens,
        stepCostUsd: response.costUsd,
        cumulativeCostUsd: costTracker.totalCostUsd,
        score: this.callbacks.getScore(),
        scorePct: this.callbacks.getScorePct(),
        state: this.callbacks.getState(),
        level,
        totalLevels,
        done: this.callbacks.isDone(),
        actionCounter,
        maxActions,
        notepadLength: notepad.read().length,
        notepadContents: notepad.read(),
        elapsedMs: stepElapsedMs,
        cumulativeElapsedMs: Date.now() - runStartMs,
        modelId: this.config.modelId,
        gameId: this.config.gameId,
        gameGuid: this.config.gameGuid,
        timestamp: new Date().toISOString(),
      };
      stepRecords.push(stepRecord);

      this.emitEvent('agent.step_recorded', {
        step,
        action,
        score: stepRecord.score,
        state: stepRecord.state,
        costUsd: stepRecord.stepCostUsd,
        cumulativeCostUsd: stepRecord.cumulativeCostUsd,
        timestamp: Date.now(),
      });

      // 10. Update conversation context
      context.addTurn('user', turnPrompt);
      context.addTurn('assistant', JSON.stringify({
        action,
        reasoning: response.reasoning,
        notepad_update: response.notepadUpdate,
      }));

      // Only increment step on successful (non-SKIP) actions
      if (action !== 'SKIP') {
        step++;
      }

      // Emit game action executed
      this.emitEvent('game.action_executed', {
        action,
        step,
        score: this.callbacks.getScore(),
        state: this.callbacks.getState(),
        timestamp: Date.now(),
      });
    }

    const elapsedMs = Date.now() - runStartMs;

    return {
      runId: this.config.runId,
      costTracker,
      notepad,
      totalSteps: step,
      stepRecords,
      finalState: this.callbacks.getState(),
      finalScore: this.callbacks.getScore(),
      elapsedMs,
      aborted: this.signal?.aborted ?? false,
    };
  }

  // ─── Prompt building ─────────────────────────────────────────────────────

  private buildTurnPrompt(
    observation: string,
    notepad: Notepad,
    validActions: string[],
    step: number,
  ): string {
    const parts: string[] = [];

    parts.push(`## Step ${step + 1}/${this.config.maxSteps}`);
    parts.push('');
    parts.push('### Current Observation');
    parts.push(observation);
    parts.push('');
    parts.push('### Available Actions');
    parts.push(validActions.join(', '));

    const notepadContent = notepad.read();
    if (notepadContent) {
      parts.push('');
      parts.push('### Your Notepad');
      parts.push(notepadContent);
    }

    parts.push('');
    parts.push('Respond with a JSON object: {"action": "YOUR_ACTION", "reasoning": "...", "notepad_update": "..." or null}');

    return parts.join('\n');
  }

  // ─── SSE emission ────────────────────────────────────────────────────────

  private emitEvent(event: string, data: Record<string, unknown>): void {
    if (this.streamHarness) {
      this.streamHarness.emitEvent(event, data);
    }
  }
}
