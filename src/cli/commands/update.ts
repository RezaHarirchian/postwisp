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

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { VERSION } from '../../core/version.js';

// Fetch and the installer are injected so tests never touch the network or
// run npm for real.
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const REGISTRY_URL = 'https://registry.npmjs.org/postwisp/latest';
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

export interface UpdateCommandDeps {
  fetchImpl: FetchImpl;
  // Resolves with the npm exit code; never throws for a failed install.
  spawnInstall: () => Promise<number>;
}

export interface NotifyUpdateOverrides {
  cachePath?: string;
  fetchImpl?: FetchImpl;
  nowMs?: number;
}

// VERSION is the runtime copy of the package.json version; a test pins the
// two together so they cannot drift apart unnoticed.
export function currentVersion(): string {
  return VERSION;
}

function versionParts(version: string): number[] {
  return version
    .split(/[+-]/)[0]!
    .split('.')
    .map((part) => {
      const n = Number(part);
      return Number.isNaN(n) ? 0 : n;
    });
}

// Numeric dot-part comparison; prerelease/build tags are ignored because
// postwisp releases are plain semver.
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

export async function fetchLatestVersion(fetchImpl: FetchImpl): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the npm registry (${reason}). The latest version is unknown until the registry answers. ` +
        'Fix: check your network connection and run `postwisp update` again.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `The npm registry returned HTTP ${res.status} for the postwisp metadata. The latest version is unknown. ` +
        'Fix: try again in a minute; if it persists, check https://status.npmjs.org/.',
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(
      'The npm registry returned a response that was not JSON. The latest version is unknown. ' +
        'Fix: try again in a minute; if it persists, check https://status.npmjs.org/.',
    );
  }
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      'The npm registry returned an unexpected metadata shape. The latest version is unknown. ' +
        'Fix: try again in a minute; if it persists, check https://status.npmjs.org/.',
    );
  }
  return version;
}

export async function runUpdateCommand(deps: UpdateCommandDeps): Promise<void> {
  let latest: string;
  try {
    latest = await fetchLatestVersion(deps.fetchImpl);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!isNewer(latest, currentVersion())) {
    console.log(`postwisp is up to date (${currentVersion()}).`);
    return;
  }
  console.log(`New version available: ${currentVersion()} -> ${latest}.`);
  console.log('See what changed: https://github.com/RezaHarirchian/postwisp/releases');
  console.log('Installing postwisp@latest ...');
  let code = 1;
  try {
    code = await deps.spawnInstall();
  } catch {
    code = 1;
  }
  if (code === 0) {
    console.log(`Updated to ${latest}. Restart postwisp to run the new version.`);
  } else {
    console.error('Automatic install failed.');
    console.error('Fix: run it yourself with: npm install -g postwisp@latest');
    process.exitCode = 1;
  }
}

function spawnNpmInstall(): Promise<number> {
  return new Promise((resolve) => {
    // Inherit stdio: npm's own progress and errors are more useful than a
    // summary line we would write ourselves.
    const child = spawn('npm', ['install', '-g', 'postwisp@latest'], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('Check for a newer postwisp release and install it')
    .action(async () => {
      await runUpdateCommand({ fetchImpl: fetch, spawnInstall: spawnNpmInstall });
    });
}

// Notify-on-exit: the coordinator calls this after the command finishes. It
// checks at most once per 24h, waits at most a few seconds, and stays silent
// on any failure — an update nudge must never break or slow a command.
//
// The cache is a dotfile under ~/.postwisp (not the kv store) because this
// runs for every CLI invocation, including before setup has created the
// database, and a JSON dotfile has no heavier dependency than fs.
export function defaultUpdateCachePath(): string {
  return join(homedir(), '.postwisp', 'update-check.json');
}

interface UpdateCache {
  lastCheck?: number;
  latest?: string;
}

function readUpdateCache(cachePath: string): UpdateCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) return parsed as UpdateCache;
  } catch {
    // Missing or corrupt cache: treat as "never checked".
  }
  return {};
}

export async function maybeNotifyUpdate(overrides: NotifyUpdateOverrides = {}): Promise<void> {
  const cachePath = overrides.cachePath ?? defaultUpdateCachePath();
  const now = overrides.nowMs ?? Date.now();
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const cached = readUpdateCache(cachePath);
  if (typeof cached.lastCheck === 'number' && now - cached.lastCheck < CHECK_INTERVAL_MS) {
    return;
  }
  let latest: string | null = typeof cached.latest === 'string' ? cached.latest : null;
  try {
    const timed: FetchImpl = (url, init) =>
      fetchImpl(url, { ...init, signal: AbortSignal.timeout(5000) });
    latest = await fetchLatestVersion(timed);
  } catch {
    // Silent by design: the check is best-effort.
  }
  // Stamp the attempt even on failure so a dead registry costs one check per
  // 24h instead of one slow timeout per invocation.
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const next: UpdateCache = { lastCheck: now };
    if (latest) next.latest = latest;
    writeFileSync(cachePath, JSON.stringify(next) + '\n');
  } catch {
    // Cache write is best-effort; the notification still goes out below.
  }
  if (latest && isNewer(latest, currentVersion())) {
    console.error(`Update available: ${currentVersion()} -> ${latest}. Run \`postwisp update\`.`);
  }
}
