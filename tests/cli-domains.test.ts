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
  formatDomainTable,
  getDomainRows,
  registerDomains,
  type FetchImpl,
} from '../src/cli/commands/domains.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configWith(overrides = {}) {
  return {
    ...defaultConfig(),
    domains: ['example.com', 'mail.example.org'],
    resendApiKey: 're_test_key',
    ...overrides,
  };
}

describe('getDomainRows', () => {
  it('reports unknown status and skips the network when no Resend key is set', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return jsonResponse({ data: [] });
    };
    const result = await getDomainRows(configWith({ resendApiKey: null }), fetchImpl);
    expect(called).toBe(false);
    expect(result.keyMissing).toBe(true);
    expect(result.apiError).toBeUndefined();
    expect(result.rows).toEqual([
      { domain: 'example.com', status: 'unknown — set a Resend key' },
      { domain: 'mail.example.org', status: 'unknown — set a Resend key' },
    ]);
  });

  it('maps Resend verification states onto configured domains', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get('authorization') });
      return jsonResponse({
        data: [
          { id: 'd1', name: 'example.com', status: 'verified' },
          { id: 'd2', name: 'mail.example.org', status: 'pending' },
        ],
      });
    };
    const result = await getDomainRows(configWith(), fetchImpl);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.resend.com/domains');
    expect(seen[0]!.auth).toBe('Bearer re_test_key');
    expect(result.keyMissing).toBe(false);
    expect(result.rows).toEqual([
      { domain: 'example.com', status: 'verified' },
      { domain: 'mail.example.org', status: 'pending' },
    ]);
  });

  it('marks configured domains missing from Resend as not found', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({ data: [{ id: 'd1', name: 'other.com', status: 'verified' }] });
    const result = await getDomainRows(configWith(), fetchImpl);
    expect(result.rows.map((r) => r.status)).toEqual(['not found in Resend', 'not found in Resend']);
  });

  it('matches domain names case-insensitively', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({ data: [{ id: 'd1', name: 'Example.COM', status: 'verified' }] });
    const result = await getDomainRows(configWith({ domains: ['example.com'] }), fetchImpl);
    expect(result.rows[0]!.status).toBe('verified');
  });

  it('turns a 401 into an actionable error naming the fix command', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ error: 'unauthorized' }, 401);
    const result = await getDomainRows(configWith(), fetchImpl);
    expect(result.keyMissing).toBe(false);
    expect(result.apiError).toContain('HTTP 401');
    expect(result.apiError).toContain('`postwisp setup`');
    expect(result.rows.every((r) => r.status === 'unknown — Resend unreachable')).toBe(true);
  });

  it('turns a network failure into an actionable error, not a stack trace', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('fetch failed');
    };
    const result = await getDomainRows(configWith(), fetchImpl);
    expect(result.apiError).toContain('Could not reach api.resend.com');
    expect(result.apiError).toContain('`postwisp domains`');
  });

  it('returns no rows when no domains are configured', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ data: [] });
    const result = await getDomainRows(configWith({ domains: [] }), fetchImpl);
    expect(result.rows).toEqual([]);
  });
});

describe('formatDomainTable', () => {
  it('renders a plain aligned table with no emojis', () => {
    const out = formatDomainTable([
      { domain: 'example.com', status: 'verified' },
      { domain: 'longer.example.org', status: 'not found in Resend' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Domain              Status');
    expect(lines[1]).toBe('example.com         verified');
    expect(lines[2]).toBe('longer.example.org  not found in Resend');
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('registerDomains', () => {
  it('registers the domains command on the program', () => {
    const program = new Command();
    registerDomains(program);
    expect(program.commands.map((c) => c.name())).toContain('domains');
  });
});
