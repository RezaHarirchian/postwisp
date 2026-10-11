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

import type { Command } from 'commander';
import { loadConfig, type PostwispConfig } from '../../core/config.js';

// The fetch implementation is a parameter (never the global directly) so
// tests can substitute a fake and the command never touches the network in
// a test run.
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';

export interface DomainRow {
  domain: string;
  status: string;
}

export interface DomainsResult {
  rows: DomainRow[];
  // True when there was no Resend key to check with; rows then carry the
  // "unknown" status and the caller prints the setup hint.
  keyMissing: boolean;
  // Human-readable WHAT + WHY + exact fix when the Resend call itself failed.
  apiError?: string | undefined;
}

interface ResendDomain {
  name: string;
  status: string;
}

function resendStatusLabel(apiStatus: string): string {
  // Resend reports: verified | pending | not_started | failed |
  // temporary_failure. Anything not finished counts as pending work.
  if (apiStatus === 'verified') return 'verified';
  if (apiStatus === 'failed') return 'failed';
  return 'pending';
}

async function fetchResendDomains(apiKey: string, fetchImpl: FetchImpl): Promise<ResendDomain[]> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_DOMAINS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach api.resend.com (${reason}). Domain verification status is unknown until Resend answers. ` +
        `Fix: check your network connection and run \`postwisp domains\` again.`,
    );
  }
  if (res.status === 401) {
    throw new Error(
      'Resend rejected the API key (HTTP 401). The key is invalid or revoked, so no domain status could be checked. ' +
        'Fix: run `postwisp setup` to set a valid Resend API key.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `Resend returned HTTP ${res.status} for the domain list. Domain verification status is unknown until Resend answers. ` +
        'Fix: try again in a minute; if it persists, check https://resend.com/status.',
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(
      'Resend returned a response that was not JSON. Domain verification status is unknown. ' +
        'Fix: try again in a minute; if it persists, check https://resend.com/status.',
    );
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error(
      'Resend returned an unexpected domain list shape. Domain verification status is unknown. ' +
        'Fix: try again in a minute; if it persists, check https://resend.com/status.',
    );
  }
  return data
    .filter(
      (d): d is { name: string; status: string } =>
        typeof d === 'object' && d !== null && typeof (d as { name: unknown }).name === 'string',
    )
    .map((d) => ({ name: d.name, status: typeof d.status === 'string' ? d.status : 'pending' }));
}

export async function getDomainRows(
  config: PostwispConfig,
  fetchImpl: FetchImpl,
): Promise<DomainsResult> {
  if (!config.resendApiKey) {
    return {
      rows: config.domains.map((domain) => ({
        domain,
        status: 'unknown — set a Resend key',
      })),
      keyMissing: true,
    };
  }
  let remote: ResendDomain[];
  try {
    remote = await fetchResendDomains(config.resendApiKey, fetchImpl);
  } catch (error) {
    return {
      rows: config.domains.map((domain) => ({ domain, status: 'unknown — Resend unreachable' })),
      keyMissing: false,
      apiError: error instanceof Error ? error.message : String(error),
    };
  }
  const byName = new Map(remote.map((d) => [d.name.toLowerCase(), d]));
  return {
    rows: config.domains.map((domain) => {
      const found = byName.get(domain.toLowerCase());
      return {
        domain,
        status: found ? resendStatusLabel(found.status) : 'not found in Resend',
      };
    }),
    keyMissing: false,
  };
}

// Plain aligned table; nothing here depends on a TTY.
export function formatDomainTable(rows: DomainRow[]): string {
  const headerDomain = 'Domain';
  const headerStatus = 'Status';
  const width = Math.max(headerDomain.length, ...rows.map((r) => r.domain.length));
  const lines = [`${headerDomain.padEnd(width)}  ${headerStatus}`];
  for (const row of rows) {
    lines.push(`${row.domain.padEnd(width)}  ${row.status}`);
  }
  return lines.join('\n');
}

export function registerDomains(program: Command): void {
  program
    .command('domains')
    .description('List sending domains and their Resend verification status')
    .action(async () => {
      const config = loadConfig();
      if (config.domains.length === 0) {
        console.log('No domains configured.');
        console.log('fix: Run `postwisp setup` to add your first sending domain.');
        return;
      }
      const result = await getDomainRows(config, fetch);
      console.log(formatDomainTable(result.rows));
      if (result.keyMissing) {
        console.log('');
        console.log('No Resend API key is set, so verification status is unknown.');
        console.log('fix: Run `postwisp setup` to add your Resend API key.');
      } else if (result.apiError) {
        // The table above already shows what we know; the error explains the rest.
        console.error(`\n${result.apiError}`);
        process.exitCode = 1;
      }
    });
}
