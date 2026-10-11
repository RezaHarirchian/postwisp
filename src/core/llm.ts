// postwisp — self-hosted Telegram email manager
// Copyright (C) 2026 Reza Harirchian
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Minimal OpenAI-compatible chat-completions client for the owner's own
// LLM key (BYOK). No SDK dependency: one POST in JSON mode with a hard
// timeout. The key travels only in the Authorization header and is never
// logged. Callers gate on llmFromConfig returning non-null first, so with
// no configured key no client exists and no request can be made.

import type { PostwispConfig } from './config.js';

export interface LlmClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmClient {
  chatJson(args: { system: string; user: string; maxTokens?: number }): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createLlmClient(
  cfg: LlmClientConfig,
  fetchImpl: typeof fetch = fetch,
): LlmClient {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async chatJson({ system, user, maxTokens = 800 }): Promise<unknown> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            max_tokens: maxTokens,
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        // The key must never surface here: only the failure kind is reported.
        throw new LlmError(
          `request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        throw new LlmError(`request failed with status ${res.status}`);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new LlmError('could not parse the model response');
      }
      const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })
        .choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new LlmError('the model returned an empty response');
      }
      try {
        return JSON.parse(content);
      } catch {
        throw new LlmError('the model did not return valid JSON');
      }
    },
  };
}

// Null when no key is configured: every P8 path checks this first and
// returns early, so an unset key means no client, no request, no UI.
export function llmFromConfig(
  config: PostwispConfig,
  fetchImpl: typeof fetch = fetch,
): LlmClient | null {
  if (!config.llmApiKey) return null;
  return createLlmClient(
    { apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl, model: config.llmModel },
    fetchImpl,
  );
}

export function aiEnabled(config: PostwispConfig): boolean {
  return config.llmApiKey !== null && config.llmApiKey.length > 0;
}
