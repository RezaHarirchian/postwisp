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
  bugReportText,
  formatDoctorChecks,
  registerDoctor,
  runDoctorChecks,
  runExtendedDoctorChecks,
  runLiveDoctorChecks,
  worstStatus,
  type ExtendedDoctorInput,
  type FetchImpl,
  type LiveDoctorDeps,
} from '../src/cli/commands/doctor.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthyConfig(overrides = {}) {
  return {
    ...defaultConfig(),
    ownerId: 42,
    botToken: 'live-bot-token-value',
    webhookSecret: 'live-webhook-secret',
    resendApiKey: 're_live_key',
    cloudflareIngestSecret: 'cf_live_secret',
    telegramWebhookSecret: 'tg_live_secret',
    serverHost: '127.0.0.1',
    serverPort: 3000,
    ...overrides,
  };
}

function extInput(overrides: Partial<ExtendedDoctorInput> = {}): ExtendedDoctorInput {
  return {
    nodeVersion: 'v22.1.0',
    configPath: '/tmp/postwisp-config.json',
    configReadable: true,
    dataDirState: 'ok',
    configMode: 0o600,
    storeState: 'ok',
    config: healthyConfig(),
    ...overrides,
  };
}

// Every external probe is fake: no network, no real files, no real sockets.
function liveDeps(fetchImpl: FetchImpl, portOk = true): LiveDoctorDeps {
  return {
    fetchImpl,
    probePort: async () => portOk,
  };
}

const allOkFetch: FetchImpl = async (url) => {
  if (url.includes('api.telegram.org')) {
    return jsonResponse({ ok: true, result: { id: 123, username: 'postwispbot' } });
  }
  return jsonResponse({ data: [] });
};

describe('runLiveDoctorChecks', () => {
  it('passes every live check on a healthy setup and never prints the token', async () => {
    const checks = await runLiveDoctorChecks(healthyConfig(), liveDeps(allOkFetch, true));
    expect(worstStatus(checks)).toBe('ok');
    const names = checks.map((c) => c.name);
    expect(names).toContain('Telegram bot token valid');
    expect(names).toContain('Resend API key valid');
    expect(names).toContain('webhook server reachable');
    const tokenCheck = checks.find((c) => c.name === 'Telegram bot token valid')!;
    expect(tokenCheck.detail).toContain('@postwispbot');
    for (const c of checks) {
      expect(c.detail).not.toContain('live-bot-token-value');
      expect(c.fix ?? '').not.toContain('live-bot-token-value');
    }
  });

  it('fails on a bad bot token with the exact fix command', async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('api.telegram.org')) {
        return jsonResponse({ ok: false, description: 'Unauthorized' }, 401);
      }
      return jsonResponse({ data: [] });
    };
    const checks = await runLiveDoctorChecks(healthyConfig(), liveDeps(fetchImpl, true));
    const check = checks.find((c) => c.name === 'Telegram bot token valid')!;
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('`postwisp setup`');
    expect(check.fix).toContain('@BotFather');
    expect(worstStatus(checks)).toBe('fail');
  });

  it('fails on an invalid Resend key with the exact fix command', async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('api.resend.com')) return jsonResponse({ error: 'unauthorized' }, 401);
      return jsonResponse({ ok: true, result: { id: 1 } });
    };
    const checks = await runLiveDoctorChecks(healthyConfig(), liveDeps(fetchImpl, true));
    const check = checks.find((c) => c.name === 'Resend API key valid')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('HTTP 401');
    expect(check.fix).toContain('`postwisp setup`');
  });

  it('fails on an unreachable server port with the exact fix', async () => {
    const checks = await runLiveDoctorChecks(healthyConfig(), liveDeps(allOkFetch, false));
    const check = checks.find((c) => c.name === 'webhook server reachable')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('127.0.0.1:3000');
    expect(check.fix).toContain('postwisp doctor');
  });

  it('skips live checks whose prerequisite is missing', async () => {
    let telegramCalled = false;
    let resendCalled = false;
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('api.telegram.org')) telegramCalled = true;
      if (url.includes('api.resend.com')) resendCalled = true;
      return jsonResponse({});
    };
    const checks = await runLiveDoctorChecks(
      healthyConfig({ botToken: null, resendApiKey: null }),
      liveDeps(fetchImpl, true),
    );
    expect(telegramCalled).toBe(false);
    expect(resendCalled).toBe(false);
    expect(checks.map((c) => c.name)).toEqual(['webhook server reachable']);
  });
});

describe('runExtendedDoctorChecks', () => {
  it('passes everything on a healthy setup', () => {
    expect(worstStatus(runExtendedDoctorChecks(extInput()))).toBe('ok');
  });

  it('fails on wrong config file permissions with the chmod fix', () => {
    const checks = runExtendedDoctorChecks(extInput({ configMode: 0o644 }));
    const check = checks.find((c) => c.name.includes('permissions'))!;
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('chmod 600');
    expect(check.fix).toContain('/tmp/postwisp-config.json');
    expect(worstStatus(checks)).toBe('fail');
  });

  it('warns (not fails) on a missing config file', () => {
    const checks = runExtendedDoctorChecks(extInput({ configMode: null }));
    const check = checks.find((c) => c.name.includes('permissions'))!;
    expect(check.status).toBe('warn');
  });

  it('warns on missing secrets with the setup fix', () => {
    const checks = runExtendedDoctorChecks(
      extInput({
        config: healthyConfig({
          webhookSecret: null,
          resendApiKey: null,
          cloudflareIngestSecret: null,
          telegramWebhookSecret: null,
        }),
      }),
    );
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('webhook secret set')!.status).toBe('warn');
    expect(byName.get('Resend API key set')!.status).toBe('warn');
    expect(byName.get('Cloudflare ingest secret')!.status).toBe('warn');
    expect(byName.get('telegram webhook secret set')!.status).toBe('warn');
    expect(byName.get('telegram webhook secret set')!.fix).toContain('`postwisp setup`');
    for (const name of ['webhook secret set', 'Resend API key set']) {
      expect(byName.get(name)!.fix).toContain('`postwisp setup`');
    }
    expect(worstStatus(checks)).toBe('warn');
  });

  it('warns on a missing database, fails on an unreadable one', () => {
    const missing = runExtendedDoctorChecks(extInput({ storeState: 'missing' }));
    expect(missing.find((c) => c.name === 'database readable')!.status).toBe('warn');
    const unreadable = runExtendedDoctorChecks(extInput({ storeState: 'unreadable' }));
    const check = unreadable.find((c) => c.name === 'database readable')!;
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('ls -l');
    expect(worstStatus(unreadable)).toBe('fail');
  });
});

describe('old node failure mode', () => {
  it('fails the Node check below version 20', () => {
    const checks = runDoctorChecks({
      nodeVersion: 'v18.20.4',
      configPath: '/tmp/x',
      configReadable: true,
      dataDirState: 'ok',
      config: defaultConfig(),
    });
    const node = checks.find((c) => c.name.includes('Node'))!;
    expect(node.status).toBe('fail');
    expect(node.fix).toContain('nodejs.org');
  });
});

describe('bugReportText', () => {
  it('redacts every secret value from the report', () => {
    const config = healthyConfig();
    // A detail that accidentally contains a secret must still come out clean.
    const checks = [
      ...runExtendedDoctorChecks(extInput({ config })),
      {
        name: 'leak probe',
        status: 'ok' as const,
        detail: `saw ${config.botToken} and ${config.resendApiKey} here`,
      },
    ];
    const report = bugReportText(
      checks,
      { version: '0.1.0', platform: 'linux x64', nodeVersion: 'v22.1.0' },
      config,
    );
    expect(report).toContain('postwisp version: 0.1.0');
    expect(report).toContain('platform: linux x64');
    expect(report).toContain('node: v22.1.0');
    expect(report).toContain('[redacted]');
    expect(report).not.toContain('live-bot-token-value');
    expect(report).not.toContain('re_live_key');
    expect(report).not.toContain('live-webhook-secret');
    expect(report).not.toContain('cf_live_secret');
  });

  it('renders check lines in the existing doctor format', () => {
    const report = bugReportText(
      [{ name: 'Node.js version', status: 'ok', detail: 'v22.1.0' }],
      { version: '0.1.0', platform: 'darwin arm64', nodeVersion: 'v22.1.0' },
      defaultConfig(),
    );
    expect(report).toContain(formatDoctorChecks([{ name: 'Node.js version', status: 'ok', detail: 'v22.1.0' }]));
    expect(report).toContain('copy below this line');
  });
});

describe('registerDoctor', () => {
  it('registers the doctor command on the program', () => {
    const program = new Command();
    registerDoctor(program);
    expect(program.commands.map((c) => c.name())).toContain('doctor');
  });
});
