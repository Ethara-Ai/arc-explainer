/**
 * Author: gpt-5-codex
 * Date: 2025-10-16T00:00:00Z
 * PURPOSE: Exposes a singleton OpenAI SDK client configured from environment so service
 *          code can import without duplicating construction details.
 * SRP/DRY check: Pass — isolates client wiring and enables easier mocking in tests.
 */

import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}
