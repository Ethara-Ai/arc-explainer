

import { BaseProvider, ProviderResponse, ChooseActionParams } from "./base";

function isRetriable(error: any): boolean {
  // Network-level errors
  if (error?.code === "ECONNREFUSED" || error?.code === "ETIMEDOUT" || error?.code === "ENOTFOUND") {
    return true;
  }

  const code = error?.code ?? error?.status ?? error?.statusCode;
  if (typeof code === "number") {
    if (code === 429 || code >= 500) return true;
    return false;
  }

  // gRPC status string fallback
  const status = error?.status;
  if (typeof status === "string") {
    const retriableStatuses = new Set([
      "RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL",
    ]);
    return retriableStatuses.has(status);
  }

  return false;
}

export class GeminiFallbackProvider extends BaseProvider {
  private _tiers: BaseProvider[];
  private _modelId: string;
  private _displayName: string;

  constructor(opts: {
    tiers: BaseProvider[];
    modelId: string;
    displayName: string;
  }) {
    super();
    if (!opts.tiers.length) throw new Error("GeminiFallbackProvider requires at least one tier");
    this._tiers = opts.tiers;
    this._modelId = opts.modelId;
    this._displayName = opts.displayName;
  }

  get modelName(): string { return this._displayName; }
  get modelId(): string { return this._modelId; }

  async chooseActionAsync(params: ChooseActionParams, signal?: AbortSignal): Promise<ProviderResponse> {
    let lastError: Error | null = null;

    for (let i = 0; i < this._tiers.length; i++) {
      const tier = this._tiers[i];
      try {
        // FIX(#1): All tiers now implement chooseActionAsync on the abstract class.
        // Pass signal through for cancellation support.
        return await tier.chooseActionAsync(params, signal);
      } catch (e: any) {
        lastError = e;
        if (!isRetriable(e)) {
          console.warn(
            `Gemini fallback: non-retriable error on tier ${i + 1}/${this._tiers.length} (${tier.modelName}): ${e.message}`
          );
          throw e;
        }
        const remaining = this._tiers.length - i - 1;
        if (remaining > 0) {
          console.info(
            `Gemini fallback: retriable error on tier ${i + 1}/${this._tiers.length} (${tier.modelName}): ${e.message}. Trying next tier (${remaining} remaining)...`
          );
        } else {
          console.warn(
            `Gemini fallback: all ${this._tiers.length} tiers exhausted. Last error: ${e.message}`
          );
        }
      }
    }

    throw lastError!;
  }
}
