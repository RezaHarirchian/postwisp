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

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { VERSION } from '../src/core/version.js';
import {
  compareVersions,
  fetchLatestVersion,
  isNewer,
  maybeNotifyUpdate,
  registerUpdate,
  runUpdateCommand,
  type FetchImpl,
} from '../src/cli/commands/update.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('compareVersions / isNewer', () => {
  it('orders versions numerically, not lexicographically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('isNewer compares against the running version', () => {
    expect(isNewer('99.0.0', VERSION)).toBe(true);
    expect(isNewer(VERSION, VERSION)).toBe(false);
    expect(isNewer('0.0.1', VERSION)).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  it('returns the version from the npm registry metadata', async () => {
    const fetchImpl: FetchImpl = async (url) => {
      expect(url).toBe('https://registry.npmjs.org/postwisp/latest');
      return jsonResponse({ name: 'postwisp', version: '0.2.0' });
    };
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBe('0.2.0');
  });

  it('turns a network failure into an actionable error', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('fetch failed');
    };
    await expect(fetchLatestVersion(fetchImpl)).rejects.toThrow('`postwisp update`');
  });

  it('rejects unexpected registry responses', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ name: 'postwisp' });
    await expect(fetchLatestVersion(fetchImpl)).rejects.toThrow('unexpected metadata');
  });
});

describe('runUpdateCommand', () => {
  it('says so and does nothing when already on the latest version', async () => {
    let installed = false;
    const fetchImpl: FetchImpl = async () => jsonResponse({ version: VERSION });
    await runUpdateCommand({
      fetchImpl,
      spawnInstall: async () => {
        installed = true;
        return 0;
      },
    });
    expect(installed).toBe(false);
    expect(logs.join('\n')).toContain(`postwisp is up to date (${VERSION}).`);
    expect(process.exitCode).not.toBe(1);
  });

  it('installs and reports success when a newer version exists', async () => {
    let installed = false;
    const fetchImpl: FetchImpl = async () => jsonResponse({ version: '99.0.0' });
    await runUpdateCommand({
      fetchImpl,
      spawnInstall: async () => {
        installed = true;
        return 0;
      },
    });
    expect(installed).toBe(true);
    expect(logs.join('\n')).toContain('https://github.com/RezaHarirchian/postwisp/releases');
    expect(logs.join('\n')).toContain('Updated to 99.0.0.');
  });

  it('prints the exact manual command when the install fails', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ version: '99.0.0' });
    await runUpdateCommand({ fetchImpl, spawnInstall: async () => 1 });
    expect(errors.join('\n')).toContain('npm install -g postwisp@latest');
    expect(process.exitCode).toBe(1);
  });

  it('reports registry failures without a stack trace', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('fetch failed');
    };
    await runUpdateCommand({ fetchImpl, spawnInstall: async () => 0 });
    expect(errors.join('\n')).toContain('Could not reach the npm registry');
    expect(process.exitCode).toBe(1);
  });
});

describe('maybeNotifyUpdate', () => {
  function cacheDir() {
    return mkdtempSync(join(tmpdir(), 'postwisp-update-'));
  }

  it('stays silent when the last check was within 24h', async () => {
    const dir = cacheDir();
    const cachePath = join(dir, 'update-check.json');
    let fetched = false;
    const fetchImpl: FetchImpl = async () => {
      fetched = true;
      return jsonResponse({ version: '99.0.0' });
    };
    await maybeNotifyUpdate({ cachePath, fetchImpl, nowMs: 1_700_000_000_000 });
    expect(fetched).toBe(true);
    expect(errors.join('\n')).toContain('Update available');
    errors = [];
    // Ten minutes later: no fetch, no output.
    await maybeNotifyUpdate({ cachePath, fetchImpl, nowMs: 1_700_000_600_000 });
    expect(fetched).toBe(true); // unchanged: still one fetch total
    expect(errors).toEqual([]);
  });

  it('prints the update notice to stderr when a newer version exists', async () => {
    const cachePath = join(cacheDir(), 'update-check.json');
    const fetchImpl: FetchImpl = async () => jsonResponse({ version: '99.0.0' });
    await maybeNotifyUpdate({ cachePath, fetchImpl, nowMs: 1_700_000_000_000 });
    expect(errors.join('\n')).toContain(
      `Update available: ${VERSION} -> 99.0.0. Run \`postwisp update\`.`,
    );
    expect(logs).toEqual([]);
  });

  it('stays silent when already on the latest version', async () => {
    const cachePath = join(cacheDir(), 'update-check.json');
    const fetchImpl: FetchImpl = async () => jsonResponse({ version: VERSION });
    await maybeNotifyUpdate({ cachePath, fetchImpl, nowMs: 1_700_000_000_000 });
    expect(errors).toEqual([]);
  });

  it('stays silent on registry failure and still stamps the cache', async () => {
    const cachePath = join(cacheDir(), 'update-check.json');
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls++;
      throw new Error('fetch failed');
    };
    await maybeNotifyUpdate({ cachePath, fetchImpl, nowMs: 1_700_000_000_000 });
    expect(errors).toEqual([]);
    const stamped = JSON.parse(readFileSync(cachePath, 'utf8')) as { lastCheck: number };
    expect(stamped.lastCheck).toBe(1_700_000_000_000);
    // A later call inside the window must not retry the dead registry.
    await maybeNotifyUpdate({ cachePath, fetchImpl, nowMs: 1_700_000_600_000 });
    expect(calls).toBe(1);
  });
});

describe('registerUpdate', () => {
  it('registers the update command on the program', () => {
    const program = new Command();
    registerUpdate(program);
    expect(program.commands.map((c) => c.name())).toContain('update');
  });
});
