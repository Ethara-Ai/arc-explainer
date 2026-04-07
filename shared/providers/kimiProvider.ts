

import { OpenAIProvider } from "./openaiProvider";

export class KimiProvider extends OpenAIProvider {
  constructor(opts: {
    apiKey?: string;
    modelId?: string;
    baseUrl?: string;
    displayName?: string;
    /** Enable Kimi thinking/reasoning mode. Default: true */
    enableThinking?: boolean;
  } = {}) {
    const enableThinking = opts.enableThinking ?? true;

    // Kimi uses OpenAI-compatible API on Moonshot.
    // Thinking is enabled via extra_body.thinking field.
    const extraBody: Record<string, any> = {};
    if (enableThinking) {
      extraBody.thinking = { type: "enabled", budget_tokens: 8192 };
    }

    super({
      apiKey: opts.apiKey ?? process.env.MOONSHOT_API_KEY ?? "",
      modelId: opts.modelId ?? "kimi-k2.5",
      baseUrl: opts.baseUrl ?? "https://api.moonshot.ai/v1",
      displayName: opts.displayName ?? "Kimi k2.5",
      extraBody: Object.keys(extraBody).length > 0 ? extraBody : null,
    });
  }
}
