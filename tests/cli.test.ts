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
import { defaultConfig } from '../src/core/config.js';
import { formatDoctorChecks, runDoctorChecks, worstStatus } from '../src/cli/commands/doctor.js';
import { statusText } from '../src/cli/commands/status.js';
import { cloudflareGuideText } from '../src/cli/commands/cloudflare.js';
import { MENU_ENTRIES, menuTextList } from '../src/cli/menu.js';

function input(overrides = {}) {
  return {
    nodeVersion: 'v22.1.0',
    configPath: '/tmp/postwisp-config.json',
    configReadable: true,
    dataDirState: 'ok' as const,
    config: { ...defaultConfig(), ownerId: 42, botToken: 'x1y2z3-secret-value' },
    ...overrides,
  };
}

describe('runDoctorChecks', () => {
  it('passes everything on a healthy setup', () => {
    const checks = runDoctorChecks(input());
    expect(worstStatus(checks)).toBe('ok');
  });

  it('fails on Node older than 20 with a fix hint', () => {
    const checks = runDoctorChecks(input({ nodeVersion: 'v18.20.0' }));
    const node = checks.find((c) => c.name.includes('Node'));
    expect(node?.status).toBe('fail');
    expect(node?.fix).toContain('nodejs.org');
    expect(worstStatus(checks)).toBe('fail');
  });

  it('warns on missing config and owner with setup instructions', () => {
    const checks = runDoctorChecks(
      input({ configReadable: false, config: { ...defaultConfig() } }),
    );
    expect(checks.filter((c) => c.status === 'warn')).toHaveLength(3);
    for (const c of checks) {
      if (c.status === 'warn') expect(c.fix).toContain('postwisp setup');
    }
  });

  it('treats a missing data dir as a warning, not a failure', () => {
    const checks = runDoctorChecks(input({ dataDirState: 'missing' as const }));
    expect(worstStatus(checks)).toBe('warn');
  });

  it('never prints the bot token value', () => {
    const text = formatDoctorChecks(runDoctorChecks(input()));
    expect(text).not.toContain('x1y2z3-secret-value');
  });
});

describe('statusText', () => {
  it('reports configured state and never leaks secrets', () => {
    const text = statusText({ ...defaultConfig(), ownerId: 42, botToken: 'x1y2z3-secret-value' });
    expect(text).toContain('42');
    expect(text).not.toContain('x1y2z3-secret-value');
  });

  it('tells an unconfigured user what to do next', () => {
    expect(statusText(defaultConfig())).toContain('postwisp setup');
  });
});

describe('menu', () => {
  it('lists every entry as implemented', () => {
    const working = MENU_ENTRIES.filter((e) => e.implemented).map((e) => e.value);
    expect(working).toEqual(['setup', 'status', 'domains', 'telegram', 'update', 'doctor', 'logs', 'config']);
  });

  it('marks no entries as planned once all are implemented', () => {
    expect(menuTextList()).not.toContain('planned for a later phase');
  });
});

describe('cloudflareGuideText', () => {
  it('states the MX exclusivity rule and the deploy steps', () => {
    const text = cloudflareGuideText(null);
    expect(text).toContain('never both');
    expect(text).toContain('POSTWISP_CF_INGEST_SECRET');
    expect(text).toContain('wrangler secret put POSTWISP_SECRET');
    expect(text).toContain('postal-mime');
    expect(text).toContain('openssl rand -hex 32');
    // Copy-paste ready: no emoji anywhere.
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('uses a custom ingest URL when one is given', () => {
    const text = cloudflareGuideText('https://mail.example.com/ingest/cloudflare');
    expect(text).toContain('https://mail.example.com/ingest/cloudflare');
  });
});
