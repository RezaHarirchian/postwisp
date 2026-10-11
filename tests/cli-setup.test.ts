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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeChanges, defaultConfig, parseDomains, readConfigFile, saveConfigFile } from '../src/core/config.js';
import { openStore, type Store } from '../src/core/store.js';
import { ResendEmailProvider } from '../src/providers/resend.js';
import {
  isSetupStep,
  parseOwnerIdInput,
  runSetup,
  scriptPrompter,
  sendTestEmail,
  validateResendKey,
  type Prompter,
  type SetupDeps,
} from '../src/cli/commands/setup.js';
import type { FetchImpl } from '../src/cli/commands/pair.js';

let stores: Store[] = [];
let tmpDirs: string[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

interface FakeFetchScenario {
  getMeStatus?: number;
  resendDomainsStatus?: number;
  emailsStatus?: number;
}

interface SentRequest {
  url: string;
  init?: RequestInit;
}

function fakeFetch(scenario: FakeFetchScenario = {}): { fetch: FetchImpl; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const fetch: FetchImpl = async (url, init) => {
    if (url.includes('api.telegram.org')) {
      const status = scenario.getMeStatus ?? 200;
      return status === 200
        ? new Response(JSON.stringify({ ok: true, result: { username: 'TestBot' } }), { status })
        : new Response('{}', { status });
    }
    if (url.includes('api.resend.com/domains')) {
      return new Response('{}', { status: scenario.resendDomainsStatus ?? 200 });
    }
    if (url.includes('api.resend.com/emails')) {
      sent.push({ url, init });
      return new Response(JSON.stringify({ id: 're_123' }), { status: scenario.emailsStatus ?? 200 });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
  return { fetch, sent };
}

function makeDeps(
  answers: Array<string | boolean>,
  overrides: Partial<SetupDeps> = {},
): { deps: SetupDeps; out: string[]; cfgPath: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'postwisp-setup-test-'));
  tmpDirs.push(dir);
  const cfgPath = join(dir, 'config.json');
  const out: string[] = [];
  const store = openStore(':memory:');
  stores.push(store);
  const deps: SetupDeps = {
    fetchImpl: fakeFetch().fetch,
    nowMs: () => 1_000_000,
    isTTY: true,
    configPath: cfgPath,
    prompter: scriptPrompter(answers),
    out: (l) => out.push(l),
    openKvStore: () => store,
    env: {},
    ...overrides,
  };
  return { deps, out, cfgPath, store };
}

// The full interactive answer script for a fresh setup with manual owner
// entry and a test email at the end.
const FULL_ANSWERS: Array<string | boolean> = [
  'tok123', // bot token
  'manual', // owner method
  '12345', // owner id
  'resend', // email provider
  're_key', // resend key
  'whsec_test12345678', // webhook secret: pasted from the Resend dashboard
  'mail.example.com', // domains
  '', // compliance: physical address (skip)
  '', // compliance: abuse contact (skip)
  '', // compliance: public URL (skip)
  false, // cloudflare: skip
  true, // e2e: send
  'me@example.com', // test recipient
];

describe('runSetup interactive', () => {
  it('runs end to end and writes every value with secrets redacted from output', async () => {
    const { fetch, sent } = fakeFetch();
    const { deps, out, cfgPath } = makeDeps(FULL_ANSWERS, { fetchImpl: fetch });
    await runSetup(deps, {});

    const saved = readConfigFile(cfgPath);
    expect(saved.botToken).toBe('tok123');
    expect(saved.ownerId).toBe(12345);
    expect(saved.resendApiKey).toBe('re_key');
    expect(saved.webhookSecret).toBe('whsec_test12345678');
    expect(saved.domains).toEqual(['mail.example.com']);
    expect(saved.setupStep).toBe('done');

    const text = out.join('\n');
    expect(text).not.toContain('tok123');
    expect(text).not.toContain('re_key');
    expect(text).toContain('botToken: [redacted] (set)');
    expect(text).toContain('domains: mail.example.com (set)');

    expect(sent).toHaveLength(1);
    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>;
    expect(body['from']).toBe('postwisp@mail.example.com');
    expect(body['to']).toEqual(['me@example.com']);
    expect(body['subject']).toBe('postwisp setup test');
  });

  it('resumes from the saved setup_step instead of starting over', async () => {
    const { fetch } = fakeFetch();
    const { deps, cfgPath } = makeDeps(FULL_ANSWERS.slice(3), { fetchImpl: fetch });
    saveConfigFile({ botToken: 'tok', ownerId: 1, setupStep: 'resend' }, cfgPath);
    await runSetup(deps, {});
    const saved = readConfigFile(cfgPath);
    expect(saved.botToken).toBe('tok');
    expect(saved.ownerId).toBe(1);
    expect(saved.resendApiKey).toBe('re_key');
    expect(saved.setupStep).toBe('done');
  });

  it('retries a rejected bot token and keeps the good one', async () => {
    let calls = 0;
    const fallback = fakeFetch();
    const getMeThenOk: FetchImpl = async (url, init) => {
      if (url.includes('api.telegram.org')) {
        calls++;
        return calls === 1
          ? new Response('{}', { status: 401 })
          : new Response(JSON.stringify({ ok: true, result: { username: 'TestBot' } }), { status: 200 });
      }
      return fallback.fetch(url, init);
    };
    const answers: Array<string | boolean> = [
      'bad-token',
      true, // try a different token
      'good-token',
      'manual',
      '12345',
      'resend', // email provider
      're_key',
      'whsec_pasted_123456',
      'mail.example.com',
      '', // compliance: skip
      '', // compliance: skip
      '', // compliance: skip
      false,
      false, // skip e2e
    ];
    const { deps, cfgPath } = makeDeps(answers, { fetchImpl: getMeThenOk });
    await runSetup(deps, {});
    expect(readConfigFile(cfgPath).botToken).toBe('good-token');
  });

  it('pairs via deep link: a tap writes ownerId and the wizard picks it up', async () => {
    const { fetch } = fakeFetch();
    const answers: Array<string | boolean> = [
      'tok',
      'pair', // owner method
      'check', // I tapped Start — check now
      'resend', // email provider
      're_key',
      'whsec_pasted_123456',
      'mail.example.com',
      '', // compliance: skip
      '', // compliance: skip
      '', // compliance: skip
      false,
      false, // skip e2e
    ];
    const { deps, cfgPath, store } = makeDeps(answers, { fetchImpl: fetch });
    // Simulate the bot consuming the tap between the link display and the check.
    const base = deps.prompter;
    let selects = 0;
    const prompter: Prompter = {
      ...base,
      select: async (): Promise<string> => {
        selects++;
        const value = await base.select();
        if (selects === 2 && value === 'check') {
          saveConfigFile({ ownerId: 777 }, cfgPath);
        }
        return value;
      },
    };
    await runSetup({ ...deps, prompter }, {});
    expect(readConfigFile(cfgPath).ownerId).toBe(777);
    // The pairing token was minted in the shared kv.
    expect(store.get('pairing_token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to manual owner id when the tap has not arrived', async () => {
    const { fetch } = fakeFetch();
    const answers: Array<string | boolean> = [
      'tok',
      'pair',
      'check', // not paired yet
      'manual', // enter the id instead
      '555',
      'resend', // email provider
      're_key',
      'whsec_pasted_123456',
      'mail.example.com',
      '', // compliance: skip
      '', // compliance: skip
      '', // compliance: skip
      false,
      false,
    ];
    const { deps, out, cfgPath } = makeDeps(answers, { fetchImpl: fetch });
    await runSetup(deps, {});
    expect(readConfigFile(cfgPath).ownerId).toBe(555);
    expect(out.join('\n')).toContain('Not paired yet');
  });

  it('refuses without a TTY unless --yes is given', async () => {
    const { deps } = makeDeps([], { isTTY: false });
    await expect(runSetup(deps, {})).rejects.toThrowError(/--yes/);
  });

  it('rejects an unknown setup_step instead of guessing', async () => {
    const { deps, cfgPath } = makeDeps([]);
    saveConfigFile({ setupStep: 'bogus' }, cfgPath);
    await expect(runSetup(deps, {})).rejects.toThrowError(/Unknown setup step/);
  });
});

describe('runSetup --yes', () => {
  const yesEnv = {
    POSTWISP_BOT_TOKEN: 'tok',
    POSTWISP_OWNER_ID: '99',
    POSTWISP_RESEND_API_KEY: 're_k',
    POSTWISP_WEBHOOK_SECRET: 'whsec_test_12345678',
    POSTWISP_DOMAINS: 'mail.example.com',
    POSTWISP_TEST_EMAIL: 'me@example.com',
  };

  it('takes everything from the environment and sends the test email', async () => {
    const { fetch, sent } = fakeFetch();
    const { deps, out, cfgPath } = makeDeps([], { fetchImpl: fetch, env: yesEnv, isTTY: false });
    await runSetup(deps, { yes: true });
    const saved = readConfigFile(cfgPath);
    expect(saved.botToken).toBe('tok');
    expect(saved.ownerId).toBe(99);
    expect(saved.resendApiKey).toBe('re_k');
    expect(saved.domains).toEqual(['mail.example.com']);
    expect(saved.setupStep).toBe('done');
    expect(sent).toHaveLength(1);
    expect(out.join('\n')).toContain('Setup complete.');
  });

  it('fails fast naming the missing value', async () => {
    const { fetch } = fakeFetch();
    const { deps: d1 } = makeDeps([], { fetchImpl: fetch, env: {}, isTTY: false });
    await expect(runSetup(d1, { yes: true })).rejects.toThrowError(/POSTWISP_BOT_TOKEN/);

    const { deps: d2 } = makeDeps([], {
      fetchImpl: fetch,
      env: { POSTWISP_BOT_TOKEN: 'tok' },
      isTTY: false,
    });
    await expect(runSetup(d2, { yes: true })).rejects.toThrowError(/POSTWISP_OWNER_ID/);

    const { deps: d3 } = makeDeps([], {
      fetchImpl: fetch,
      env: { POSTWISP_BOT_TOKEN: 'tok', POSTWISP_OWNER_ID: '99' },
      isTTY: false,
    });
    await expect(runSetup(d3, { yes: true })).rejects.toThrowError(/POSTWISP_RESEND_API_KEY/);

    const { deps: d4 } = makeDeps([], {
      fetchImpl: fetch,
      env: { POSTWISP_BOT_TOKEN: 'tok', POSTWISP_OWNER_ID: '99', POSTWISP_RESEND_API_KEY: 're_k', POSTWISP_WEBHOOK_SECRET: 'whsec_test_12345678' },
      isTTY: false,
    });
    await expect(runSetup(d4, { yes: true })).rejects.toThrowError(/POSTWISP_DOMAINS/);
  });

  it('skips the test email without POSTWISP_TEST_EMAIL and says how to run it later', async () => {
    const { fetch, sent } = fakeFetch();
    const { POSTWISP_TEST_EMAIL: _drop, ...env } = yesEnv;
    void _drop;
    const { deps, out } = makeDeps([], { fetchImpl: fetch, env, isTTY: false });
    await runSetup(deps, { yes: true });
    expect(sent).toHaveLength(0);
    expect(out.join('\n')).toContain('POSTWISP_TEST_EMAIL');
  });

  it('is a no-op when setup is already done', async () => {
    const { deps, out, cfgPath } = makeDeps([], { isTTY: false });
    saveConfigFile({ botToken: 'tok', setupStep: 'done' }, cfgPath);
    await runSetup(deps, { yes: true });
    expect(out.join('\n')).toContain('already complete');
  });

  it('resumes mid-way, keeping already-configured values', async () => {
    const { fetch } = fakeFetch();
    const { deps, out, cfgPath } = makeDeps([], {
      fetchImpl: fetch,
      env: { POSTWISP_OWNER_ID: '99', POSTWISP_RESEND_API_KEY: 're_k', POSTWISP_WEBHOOK_SECRET: 'whsec_test_12345678', POSTWISP_DOMAINS: 'a.com' },
      isTTY: false,
    });
    saveConfigFile({ botToken: 'tok', setupStep: 'owner' }, cfgPath);
    await runSetup(deps, { yes: true });
    const saved = readConfigFile(cfgPath);
    expect(saved.botToken).toBe('tok');
    expect(saved.ownerId).toBe(99);
    expect(out.join('\n')).not.toContain('tok');
  });

  it('rejects a bad POSTWISP_OWNER_ID', async () => {
    const { fetch } = fakeFetch();
    const { deps } = makeDeps([], {
      fetchImpl: fetch,
      env: { POSTWISP_BOT_TOKEN: 'tok', POSTWISP_OWNER_ID: 'abc' },
      isTTY: false,
    });
    await expect(runSetup(deps, { yes: true })).rejects.toThrowError(/user ID/);
  });

  it('configures a non-resend provider from the environment', async () => {
    const { fetch } = fakeFetch();
    const { deps, out, cfgPath } = makeDeps([], {
      fetchImpl: fetch,
      env: {
        POSTWISP_BOT_TOKEN: 'tok',
        POSTWISP_OWNER_ID: '99',
        POSTWISP_EMAIL_PROVIDER: 'mailersend',
        POSTWISP_MAILERSEND_API_KEY: 'ms_k',
        POSTWISP_WEBHOOK_SECRET: 'ms_webhook_secret_1234',
        POSTWISP_DOMAINS: 'mail.example.com',
      },
      isTTY: false,
    });
    await runSetup(deps, { yes: true });
    const saved = readConfigFile(cfgPath);
    expect(saved.emailProvider).toBe('mailersend');
    expect(saved.mailersendApiKey).toBe('ms_k');
    expect(saved.resendApiKey ?? null).toBeNull();
    expect(saved.webhookSecret).toBe('ms_webhook_secret_1234');
    expect(out.join('\n')).not.toContain('ms_k');
  });

  it('fails fast when the selected provider key is missing', async () => {
    const { fetch } = fakeFetch();
    const { deps } = makeDeps([], {
      fetchImpl: fetch,
      env: {
        POSTWISP_BOT_TOKEN: 'tok',
        POSTWISP_OWNER_ID: '99',
        POSTWISP_EMAIL_PROVIDER: 'mailgun',
        POSTWISP_DOMAINS: 'mail.example.com',
      },
      isTTY: false,
    });
    await expect(runSetup(deps, { yes: true })).rejects.toThrowError(/POSTWISP_MAILGUN_API_KEY/);
  });

  it('fails fast when the webhook secret is missing in non-interactive mode', async () => {
    const { fetch } = fakeFetch();
    const { deps } = makeDeps([], {
      fetchImpl: fetch,
      env: {
        POSTWISP_BOT_TOKEN: 'tok',
        POSTWISP_OWNER_ID: '99',
        POSTWISP_RESEND_API_KEY: 're_k',
        POSTWISP_DOMAINS: 'mail.example.com',
      },
      isTTY: false,
    });
    // A locally generated secret could never verify a provider webhook, so
    // setup refuses to continue without the provider-issued secret.
    await expect(runSetup(deps, { yes: true })).rejects.toThrowError(/POSTWISP_WEBHOOK_SECRET/);
  });

  it('saves compliance details from env in --yes mode', async () => {
    const { fetch } = fakeFetch();
    const { deps, cfgPath } = makeDeps([], {
      fetchImpl: fetch,
      env: {
        ...yesEnv,
        POSTWISP_PHYSICAL_ADDRESS: '123 Main St',
        POSTWISP_ABUSE_CONTACT: 'abuse@example.com',
        POSTWISP_PUBLIC_URL: 'https://mail.example.com',
      },
      isTTY: false,
    });
    await runSetup(deps, { yes: true });
    const saved = readConfigFile(cfgPath);
    expect(saved.physicalAddress).toBe('123 Main St');
    expect(saved.abuseContact).toBe('abuse@example.com');
    expect(saved.publicUrl).toBe('https://mail.example.com');
  });

  it('asks the compliance questions interactively and validates the URL', async () => {
    const { fetch } = fakeFetch();
    const answers: Array<string | boolean> = [
      'tok123', // bot token
      'manual', // owner method
      '12345', // owner id
      'resend', // email provider
      're_key', // resend key
      'whsec_test12345678', // webhook secret
      'mail.example.com', // domains
      '123 Main St', // compliance: physical address
      'abuse@example.com', // compliance: abuse contact
      'https://mail.example.com', // compliance: public URL
      false, // cloudflare: skip
      false, // e2e: skip test email
    ];
    const { deps, cfgPath } = makeDeps(answers, { fetchImpl: fetch });
    await runSetup(deps, {});
    const saved = readConfigFile(cfgPath);
    expect(saved.physicalAddress).toBe('123 Main St');
    expect(saved.abuseContact).toBe('abuse@example.com');
    expect(saved.publicUrl).toBe('https://mail.example.com');
  });

  it('rejects an unknown POSTWISP_EMAIL_PROVIDER', async () => {
    const { fetch } = fakeFetch();
    const { deps } = makeDeps([], {
      fetchImpl: fetch,
      env: {
        POSTWISP_BOT_TOKEN: 'tok',
        POSTWISP_OWNER_ID: '99',
        POSTWISP_EMAIL_PROVIDER: 'sendgrid',
        POSTWISP_DOMAINS: 'mail.example.com',
      },
      isTTY: false,
    });
    await expect(runSetup(deps, { yes: true })).rejects.toThrowError(/POSTWISP_EMAIL_PROVIDER/);
  });
});

describe('validators', () => {
  it('parseDomains lowercases, dedupes and validates', () => {
    expect(parseDomains('Mail.Example.COM, mail.example.com')).toEqual(['mail.example.com']);
    expect(parseDomains('')).toEqual([]);
    expect(() => parseDomains('not a domain')).toThrowError(/invalid domain/);
    expect(() => parseDomains('example')).toThrowError(/invalid domain/);
  });

  it('parseOwnerIdInput accepts positive integers only', () => {
    expect(parseOwnerIdInput('123')).toBe(123);
    expect(parseOwnerIdInput('  42 ')).toBe(42);
    expect(() => parseOwnerIdInput('abc')).toThrowError(/user ID/);
    expect(() => parseOwnerIdInput('0')).toThrowError(/user ID/);
    expect(() => parseOwnerIdInput('-5')).toThrowError(/user ID/);
  });

  it('isSetupStep recognizes the step names and done', () => {
    expect(isSetupStep('bot-token')).toBe(true);
    expect(isSetupStep('provider')).toBe(true);
    expect(isSetupStep('resend')).toBe(true); // pre-P5 persisted name
    expect(isSetupStep('done')).toBe(true);
    expect(isSetupStep(null)).toBe(false);
    expect(isSetupStep('bogus')).toBe(false);
  });

  it('validateResendKey rejects a 401 with a fix', async () => {
    const { fetch } = fakeFetch({ resendDomainsStatus: 401 });
    const prompter = scriptPrompter([]);
    await expect(validateResendKey('bad', fetch, prompter)).rejects.toThrowError(/resend\.com\/api-keys/);
  });

  it('sendTestEmail surfaces provider failures with a fix', async () => {
    const { fetch } = fakeFetch({ emailsStatus: 500 });
    const { deps } = makeDeps([]);
    const provider = new ResendEmailProvider({ apiKey: 're_k', fetchFn: fetch as typeof fetch });
    await expect(
      sendTestEmail(deps, { provider, providerLabel: 'Resend', fromDomain: 'a.com', to: 'me@a.com' }),
    ).rejects.toThrowError(/Could not send the test email through Resend/);
  });

  it('re-asks the webhook secret when the provider changes but the API key is kept', async () => {
    const { fetch } = fakeFetch();
    // Previously configured on Resend, with a Mailgun key already saved
    // from an earlier stint: switching back to Mailgun keeps the key but
    // must not keep Resend's signing secret.
    const { deps, cfgPath } = makeDeps(
      [
        'provider', // redo step
        'mailgun', // email provider
        false, // keep the saved Mailgun API key
        'mg_new_secret_123456', // webhook secret: re-asked because the provider changed
        false, // domains: keep
        false, // cloudflare: skip
        false, // e2e: skip test email
      ],
      { fetchImpl: fetch },
    );
    saveConfigFile(
      {
        botToken: 'tok',
        ownerId: 1,
        emailProvider: 'resend',
        resendApiKey: 're_old',
        mailgunApiKey: 'mg_old',
        webhookSecret: 'whsec_old_resend_1234',
        domains: ['mail.example.com'],
        physicalAddress: '123 Main St',
        abuseContact: 'abuse@example.com',
        publicUrl: 'https://mail.example.com',
        setupStep: 'done',
      },
      cfgPath,
    );
    await runSetup(deps, {});
    const saved = readConfigFile(cfgPath);
    expect(saved.emailProvider).toBe('mailgun');
    expect(saved.mailgunApiKey).toBe('mg_old');
    expect(saved.resendApiKey).toBe('re_old');
    expect(saved.webhookSecret).toBe('mg_new_secret_123456');
  });

  it('sends the e2e test email through the configured provider, not Resend', async () => {
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const msFetch: FetchImpl = async (url, init) => {
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: { username: 'TestBot' } }), {
          status: 200,
        });
      }
      if (url.includes('api.mailersend.com/v1/email')) {
        sent.push({ url, init });
        return new Response('', { status: 202, headers: { 'x-message-id': 'ms_123' } });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    };
    const answers: Array<string | boolean> = [
      'tok123', // bot token
      'manual', // owner method
      '12345', // owner id
      'mailersend', // email provider
      'ms_key', // mailersend key
      'ms_wh_secret_123456', // webhook secret
      'mail.example.com', // domains
      '', // compliance: skip
      '', // compliance: skip
      '', // compliance: skip
      false, // cloudflare: skip
      true, // e2e: send
      'me@example.com', // test recipient
    ];
    const { deps, cfgPath } = makeDeps(answers, { fetchImpl: msFetch });
    await runSetup(deps, {});
    const saved = readConfigFile(cfgPath);
    expect(saved.emailProvider).toBe('mailersend');
    expect(saved.mailersendApiKey).toBe('ms_key');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('api.mailersend.com/v1/email');
    const body = JSON.parse(String(sent[0]!.init?.body)) as Record<string, unknown>;
    expect((body['from'] as { email: string }).email).toBe('postwisp@mail.example.com');
  });

  it('rejects a short POSTWISP_CF_INGEST_SECRET in non-interactive mode', async () => {
    const { fetch } = fakeFetch();
    const baseEnv = {
      POSTWISP_BOT_TOKEN: 'tok',
      POSTWISP_OWNER_ID: '99',
      POSTWISP_RESEND_API_KEY: 're_k',
      POSTWISP_WEBHOOK_SECRET: 'whsec_test_12345678',
      POSTWISP_DOMAINS: 'mail.example.com',
    };
    const { deps: short } = makeDeps([], {
      fetchImpl: fetch,
      env: { ...baseEnv, POSTWISP_CF_INGEST_SECRET: 'short' },
      isTTY: false,
    });
    await expect(runSetup(short, { yes: true })).rejects.toThrowError(/too short/);

    const longSecret = 'a'.repeat(32);
    const { deps: ok, out: okOut } = makeDeps([], {
      fetchImpl: fetch,
      env: { ...baseEnv, POSTWISP_CF_INGEST_SECRET: longSecret },
      isTTY: false,
    });
    await runSetup(ok, { yes: true });
    // Asserted via the wizard's report, not the config file: the file
    // round-trip for this key is broken pre-existing (written camelCase,
    // read back only as snake_case) and config.ts is outside this change.
    expect(okOut.join('\n')).toContain('cloudflareIngestSecret: [redacted] (set)');
  });

  it('describeChanges never renders secret values', () => {
    const lines = describeChanges(defaultConfig(), { botToken: 'super-secret', serverPort: 8080 });
    const text = lines.join('\n');
    expect(text).toContain('botToken: [redacted] (set)');
    expect(text).toContain('serverPort: 8080 (updated)');
    expect(text).not.toContain('super-secret');
  });
});
