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

import { describe, expect, it } from 'vitest';
import {
  aiEnabled,
  createLlmClient,
  LlmError,
  llmFromConfig,
} from '../src/core/llm.js';
import {
  defaultConfig,
  displayConfigValue,
  isSecretConfigKey,
  redactedConfig,
} from '../src/core/config.js';

function chatCompletions(body: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('llmFromConfig', () => {
  it('returns null without a key, so every AI path stays inert', () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls++;
      return chatCompletions({ category: 'noise', confidence: 1 });
    }) as typeof fetch;
    const client = llmFromConfig({ ...defaultConfig(), llmApiKey: null }, spyFetch);
    expect(client).toBeNull();
    expect(aiEnabled({ ...defaultConfig(), llmApiKey: null })).toBe(false);
    expect(calls).toBe(0);
  });

  it('returns null for an empty-string key', () => {
    expect(llmFromConfig({ ...defaultConfig(), llmApiKey: '' })).toBeNull();
    expect(aiEnabled({ ...defaultConfig(), llmApiKey: '' })).toBe(false);
  });

  it('builds a client when the key is set', () => {
    const client = llmFromConfig(
      { ...defaultConfig(), llmApiKey: 'sk-test' },
      (async () => chatCompletions({ ok: true })) as typeof fetch,
    );
    expect(client).not.toBeNull();
    expect(aiEnabled({ ...defaultConfig(), llmApiKey: 'sk-test' })).toBe(true);
  });
});

describe('createLlmClient', () => {
  it('posts JSON mode to the OpenAI-compatible endpoint and parses the reply', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return chatCompletions({ category: 'urgent', confidence: 0.9 });
    }) as typeof fetch;
    const client = createLlmClient(
      { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o-mini' },
      fetchImpl,
    );
    const out = await client.chatJson({ system: 's', user: 'u' });
    expect(out).toEqual({ category: 'urgent', confidence: 0.9 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect((seen[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk-test',
    );
  });

  it('fails on HTTP errors without leaking the key', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const client = createLlmClient({ apiKey: 'sk-secret', baseUrl: 'https://x.test', model: 'm' }, fetchImpl);
    await expect(client.chatJson({ system: 's', user: 'u' })).rejects.toThrow(LlmError);
    await expect(client.chatJson({ system: 's', user: 'u' })).rejects.toThrow(/401/);
  });

  it('fails when the model does not return JSON', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
        status: 200,
      })) as typeof fetch;
    const client = createLlmClient({ apiKey: 'k', baseUrl: 'https://x.test', model: 'm' }, fetchImpl);
    await expect(client.chatJson({ system: 's', user: 'u' })).rejects.toThrow(/valid JSON/);
  });

  it('aborts after the timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const client = createLlmClient(
      { apiKey: 'k', baseUrl: 'https://x.test', model: 'm', timeoutMs: 20 },
      fetchImpl,
    );
    await expect(client.chatJson({ system: 's', user: 'u' })).rejects.toThrow(LlmError);
  });
});

describe('llmApiKey secrecy', () => {
  it('is a secret config key: never displayed, redacted in dumps', () => {
    expect(isSecretConfigKey('llmApiKey')).toBe(true);
    expect(displayConfigValue('llmApiKey', 'sk-live-key')).toBe('[redacted]');
    expect(displayConfigValue('llmApiKey', null)).toBe('(not set)');
    const redacted = redactedConfig({ ...defaultConfig(), llmApiKey: 'sk-live-key' });
    expect(redacted['llmApiKey']).toBe('[redacted]');
    expect(JSON.stringify(redacted)).not.toContain('sk-live-key');
  });
});
