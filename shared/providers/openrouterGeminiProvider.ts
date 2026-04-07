

import { OpenAIProvider } from "./openaiProvider";

export class OpenRouterGeminiProvider extends OpenAIProvider {
  constructor(opts: {
    apiKey?: string;
    modelId?: string;
    displayName?: string;
    /** Enable thinking/reasoning via OpenRouter. Default: true */
    enableThinking?: boolean;
  } = {}) {
    const enableThinking = opts.enableThinking ?? true;

    const extraBody: Record<string, any> = {
      provider: { order: ["google-ai-studio"] },
    };
    // OpenRouter passes reasoning config to Gemini backend
    if (enableThinking) {
      extraBody.reasoning = { effort: "high" };
    }

    super({
      apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
      modelId: opts.modelId ?? "google/gemini-3.1-pro-preview",
      baseUrl: "https://openrouter.ai/api/v1",
      displayName: opts.displayName ?? "Gemini 3.1",
      reasoningEffort: null, // Chat Completions path (not Responses API)
      extraBody,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/piyush/arc-explainer",
        "X-Title": "ARC Explainer Eval Harness",
      },
    });
  }
}
