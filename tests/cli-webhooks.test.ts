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
import { Command } from 'commander';
import { defaultConfig } from '../src/core/config.js';
import {
  formatTelegramTest,
  formatWebhooksReport,
  getProviderWebhooks,
  getResendWebhooks,
  getTelegramWebhookInfo,
  ourResendWebhookUrl,
  registerWebhooks,
  type FetchImpl,
} from '../src/cli/commands/webhooks.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configWith(overrides = {}) {
  return {
    ...defaultConfig(),
    resendApiKey: 're_test_key',
    botToken: 'test-bot-token',
    serverHost: '127.0.0.1',
    serverPort: 3000,
    ...overrides,
  };
}

describe('ourResendWebhookUrl', () => {
  it('falls back to the configured host and port', () => {
    expect(ourResendWebhookUrl(configWith(), undefined)).toBe(
      'http://127.0.0.1:3000/webhooks/resend',
    );
  });

  it('prefers the --public-url flag and strips trailing slashes', () => {
    expect(ourResendWebhookUrl(configWith(), 'https://mail.example.com/')).toBe(
      'https://mail.example.com/webhooks/resend',
    );
  });
});

describe('getResendWebhooks', () => {
  it('skips gracefully without a Resend key', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return jsonResponse({ data: [] });
    };
    const result = await getResendWebhooks(configWith({ resendApiKey: null }), undefined, fetchImpl);
    expect(called).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('matches a webhook pointing at our endpoint', async () => {
    const ours = 'https://mail.example.com/webhooks/resend';
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({
        data: [
          { id: 'wh1', endpoint: ours },
          { id: 'wh2', endpoint: 'https://other.example/webhooks/resend' },
        ],
      });
    const result = await getResendWebhooks(configWith(), 'https://mail.example.com', fetchImpl);
    expect(result.ours).toBe(ours);
    expect(result.matched).toBe(true);
    expect(result.webhooks).toHaveLength(2);
    expect(result.webhooks[0]).toMatchObject({ pointsAtOurs: true, samePathOtherHost: false });
    expect(result.webhooks[1]).toMatchObject({ pointsAtOurs: false, samePathOtherHost: true });
  });

  it('reports unmatched when no webhook targets our endpoint', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({ data: [{ id: 'wh1', endpoint: 'https://old.example.com/hook' }] });
    const result = await getResendWebhooks(configWith(), undefined, fetchImpl);
    expect(result.matched).toBe(false);
    const report = formatWebhooksReport(result, {
      skipped: true,
      url: null,
      pendingUpdateCount: 0,
      lastError: null,
    });
    expect(report).toContain('No Resend webhook points at our endpoint');
  });

  it('turns a 401 into an actionable error naming the fix command', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ error: 'unauthorized' }, 401);
    const result = await getResendWebhooks(configWith(), undefined, fetchImpl);
    expect(result.error).toContain('HTTP 401');
    expect(result.error).toContain('`postwisp setup`');
  });

  it('turns a network failure into an actionable error', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('fetch failed');
    };
    const result = await getResendWebhooks(configWith(), undefined, fetchImpl);
    expect(result.error).toContain('Could not reach api.resend.com');
  });
});

describe('getProviderWebhooks', () => {
  it('honors the configured provider instead of always checking Resend', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return jsonResponse({ webhooks: {} });
    };
    // A Resend key is set, but the configured provider is Mailgun without a
    // key: the old code would have listed Resend's webhooks here.
    const result = await getProviderWebhooks(
      configWith({
        emailProvider: 'mailgun',
        mailgunApiKey: null,
        resendApiKey: 're_test_key',
        domains: ['mail.example.com'],
      }),
      undefined,
      fetchImpl,
    );
    expect(called).toBe(false);
    expect(result.provider).toBe('mailgun');
    expect(result.skipped).toBe(true);
    expect(result.ours).toBe('http://127.0.0.1:3000/webhooks/mailgun');
  });

  it('lists Mailgun webhooks per domain and matches our endpoint', async () => {
    const ours = 'https://mail.example.com/webhooks/mailgun';
    const seen: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      seen.push(url);
      return jsonResponse({
        webhooks: {
          delivered: { urls: [ours] },
          opened: { urls: ['https://other.example/hook'] },
        },
      });
    };
    const result = await getProviderWebhooks(
      configWith({
        emailProvider: 'mailgun',
        mailgunApiKey: 'key-test',
        resendApiKey: null,
        domains: ['mail.example.com'],
      }),
      'https://mail.example.com',
      fetchImpl,
    );
    expect(seen[0]).toContain('api.mailgun.net/v3/domains/mail.example.com/webhooks');
    expect(result.provider).toBe('mailgun');
    expect(result.ours).toBe(ours);
    expect(result.matched).toBe(true);
    expect(result.webhooks).toHaveLength(2);
    expect(result.webhooks[0]).toMatchObject({
      endpoint: ours,
      pointsAtOurs: true,
      domain: 'mail.example.com',
    });
    expect(result.note).toContain('Routes');
  });

  it('lists MailerSend webhooks through the hashed domain id', async () => {
    const ours = 'https://mail.example.com/webhooks/mailersend';
    const seen: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      seen.push(url);
      if (url.includes('/v1/domains')) {
        return jsonResponse({ data: [{ id: 'dom_1', name: 'mail.example.com' }] });
      }
      if (url.includes('/v1/webhooks')) {
        return jsonResponse({ data: [{ id: 'wh1', url: ours }] });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const result = await getProviderWebhooks(
      configWith({
        emailProvider: 'mailersend',
        mailersendApiKey: 'ms_key',
        resendApiKey: null,
        domains: ['mail.example.com'],
      }),
      'https://mail.example.com',
      fetchImpl,
    );
    expect(seen.some((u) => u.includes('domain_id=dom_1'))).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.webhooks[0]).toMatchObject({ endpoint: ours, pointsAtOurs: true });
    expect(result.note).toContain('inbound routes');
  });

  it('reports no domains to list for per-domain providers', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return jsonResponse({ webhooks: {} });
    };
    const result = await getProviderWebhooks(
      configWith({
        emailProvider: 'mailgun',
        mailgunApiKey: 'key-test',
        resendApiKey: null,
        domains: [],
      }),
      undefined,
      fetchImpl,
    );
    expect(called).toBe(false);
    expect(result.note).toContain('No domains are configured');
  });
});

describe('getTelegramWebhookInfo', () => {
  it('skips gracefully without a bot token', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return jsonResponse({});
    };
    const state = await getTelegramWebhookInfo(null, fetchImpl);
    expect(called).toBe(false);
    expect(state.skipped).toBe(true);
  });

  it('parses url, pending updates, and the last error', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      seen.push(`${init?.method} ${url}`);
      return jsonResponse({
        ok: true,
        result: {
          url: 'https://mail.example.com/tg/secret-path',
          has_custom_certificate: false,
          pending_update_count: 3,
          last_error_date: 1790000000,
          last_error_message: 'Wrong response from the webhook: 500 Internal Server Error',
          max_connections: 40,
        },
      });
    };
    const state = await getTelegramWebhookInfo('test-bot-token', fetchImpl);
    expect(seen[0]).toBe('POST https://api.telegram.org/bottest-bot-token/getWebhookInfo');
    expect(state.skipped).toBe(false);
    expect(state.url).toBe('https://mail.example.com/tg/secret-path');
    expect(state.pendingUpdateCount).toBe(3);
    expect(state.lastError).toContain('Wrong response from the webhook: 500');
    expect(state.error).toBeUndefined();
  });

  it('treats an empty url as polling', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({ ok: true, result: { url: '', pending_update_count: 0 } });
    const state = await getTelegramWebhookInfo('test-bot-token', fetchImpl);
    expect(state.url).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it('turns a rejected token into an actionable error without leaking it', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({ ok: false, description: 'Unauthorized' }, 401);
    const state = await getTelegramWebhookInfo('bad-token-value', fetchImpl);
    expect(state.error).toContain('Unauthorized');
    expect(state.error).toContain('`postwisp setup`');
    expect(state.error).not.toContain('bad-token-value');
  });
});

describe('formatTelegramTest', () => {
  it('explains a set webhook in plain language', () => {
    const out = formatTelegramTest({
      skipped: false,
      url: 'https://mail.example.com/tg/x',
      pendingUpdateCount: 0,
      lastError: null,
    });
    expect(out).toContain('Telegram webhook is set to https://mail.example.com/tg/x.');
    expect(out).toContain('No updates are waiting on Telegram.');
    expect(out).toContain('no delivery errors');
  });

  it('explains polling and pending updates', () => {
    const out = formatTelegramTest({
      skipped: false,
      url: null,
      pendingUpdateCount: 5,
      lastError: 'timeout',
    });
    expect(out).toContain('long polling');
    expect(out).toContain('5 update(s) are waiting');
    expect(out).toContain('timeout');
  });

  it('explains a skipped test with the fix command', () => {
    const out = formatTelegramTest({
      skipped: true,
      url: null,
      pendingUpdateCount: 0,
      lastError: null,
    });
    expect(out).toContain('no bot token is set');
    expect(out).toContain('`postwisp setup`');
  });
});

describe('registerWebhooks', () => {
  it('registers webhooks with a test subcommand', () => {
    const program = new Command();
    registerWebhooks(program);
    const cmd = program.commands.find((c) => c.name() === 'webhooks');
    expect(cmd).toBeDefined();
    expect(cmd!.commands.map((c) => c.name())).toContain('test');
  });
});
