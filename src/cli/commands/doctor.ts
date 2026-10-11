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

import { accessSync, constants, statSync } from 'node:fs';
import { connect } from 'node:net';
import { resolveTxt } from 'node:dns/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import Database from 'better-sqlite3';
import { t } from '../../core/i18n.js';
import {
  configFilePath,
  loadConfig,
  type EmailProviderName,
  type PostwispConfig,
} from '../../core/config.js';
import { VERSION } from '../../core/version.js';
import { tgcloudDoctorCheck } from './deploy-serverless.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type DataDirState = 'ok' | 'missing' | 'not-writable';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string | undefined;
}

interface DoctorInput {
  nodeVersion: string;
  configPath: string;
  configReadable: boolean;
  dataDirState: DataDirState;
  config: PostwispConfig;
}

function majorOf(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

// Every check states what was tested, the result, and — on warn/fail —
// exactly how to fix it. The output doubles as a bug-report attachment.
export function runDoctorChecks(input: DoctorInput): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const fixSetup = t('cli.doctor.fixSetup');

  const major = majorOf(input.nodeVersion);
  checks.push({
    name: t('cli.doctor.nodeVersion'),
    status: major >= 20 ? 'ok' : 'fail',
    detail: input.nodeVersion,
    fix: major >= 20 ? undefined : 'Install Node.js 20 or newer from https://nodejs.org/.',
  });

  checks.push({
    name: t('cli.doctor.configReadable'),
    status: input.configReadable ? 'ok' : 'warn',
    detail: input.configPath,
    fix: input.configReadable ? undefined : fixSetup,
  });

  checks.push({
    name: t('cli.doctor.dataDirWritable'),
    status: input.dataDirState === 'ok' ? 'ok' : input.dataDirState === 'missing' ? 'warn' : 'fail',
    detail: input.config.dataDir,
    fix:
      input.dataDirState === 'ok'
        ? undefined
        : input.dataDirState === 'missing'
          ? 'The directory is created automatically on first run.'
          : `Make writable: chmod u+rwX "${input.config.dataDir}"`,
  });

  checks.push({
    name: t('cli.doctor.ownerSet'),
    status: input.config.ownerId !== null ? 'ok' : 'warn',
    detail: input.config.ownerId !== null ? String(input.config.ownerId) : t('cli.status.notSet'),
    fix: input.config.ownerId !== null ? undefined : fixSetup,
  });

  checks.push({
    name: t('cli.doctor.botTokenSet'),
    status: input.config.botToken ? 'ok' : 'warn',
    // The token value itself is never printed.
    detail: input.config.botToken ? t('cli.status.set') : t('cli.status.notSet'),
    fix: input.config.botToken ? undefined : fixSetup,
  });

  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks
    .map((c) => {
      const mark = c.status === 'ok' ? t('cli.doctor.ok') : c.status === 'warn' ? t('cli.doctor.warn') : t('cli.doctor.fail');
      const line = `[${mark}] ${c.name}: ${c.detail}`;
      return c.fix ? `${line}\n      fix: ${c.fix}` : line;
    })
    .join('\n');
}

export function worstStatus(checks: DoctorCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Extended checklist (P4). The base runDoctorChecks above is frozen: existing
// callers and tests depend on its exact five checks. Everything below adds
// the deeper checks without changing that contract.
// ---------------------------------------------------------------------------

export type StoreState = 'ok' | 'missing' | 'unreadable';

// Fetch is injected so tests never touch the network.
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ExtendedDoctorInput extends DoctorInput {
  // stat mode of the config file; null when the file does not exist (yet).
  configMode: number | null;
  storeState: StoreState;
}

export interface LiveDoctorDeps {
  fetchImpl: FetchImpl;
  probePort: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface BugReportMeta {
  version: string;
  platform: string;
  nodeVersion: string;
}

const FIX_SETUP = 'Run `postwisp setup` to configure it.';

// Sync checks that need more than the base input: file permissions, secrets,
// and the database. Unset-but-optional values warn (setup creates them);
// a wrong permission mode or an unreadable database fails.
export function runExtendedDoctorChecks(input: ExtendedDoctorInput): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const perms = input.configMode === null ? null : input.configMode & 0o777;

  checks.push({
    name: 'config file permissions (0600)',
    status: perms === 0o600 ? 'ok' : perms === null ? 'warn' : 'fail',
    detail:
      perms === 0o600
        ? `mode 600 on ${input.configPath}`
        : perms === null
          ? 'config file not created yet'
          : `mode ${perms.toString(8)} on ${input.configPath} — secrets are readable by other users`,
    fix:
      perms === 0o600
        ? undefined
        : perms === null
          ? 'Run `postwisp setup`; it creates the file with mode 0600.'
          : `Run: chmod 600 "${input.configPath}"`,
  });

  checks.push({
    name: 'webhook secret set',
    status: input.config.webhookSecret ? 'ok' : 'warn',
    detail: input.config.webhookSecret
      ? 'set'
      : 'not set — the Resend webhook endpoint cannot verify signatures without it',
    fix: input.config.webhookSecret ? undefined : FIX_SETUP,
  });

  checks.push({
    name: 'telegram webhook secret set',
    status: input.config.telegramWebhookSecret ? 'ok' : 'warn',
    detail: input.config.telegramWebhookSecret
      ? 'set'
      : 'not set — without it the Telegram webhook route cannot tell a real Telegram update from a forged one',
    fix: input.config.telegramWebhookSecret ? undefined : FIX_SETUP,
  });

  checks.push({
    name: 'Resend API key set',
    status: input.config.resendApiKey ? 'ok' : 'warn',
    detail: input.config.resendApiKey ? 'set' : 'not set — sending and domain checks are disabled',
    fix: input.config.resendApiKey ? undefined : FIX_SETUP,
  });

  checks.push({
    name: 'Cloudflare ingest secret',
    status: input.config.cloudflareIngestSecret ? 'ok' : 'warn',
    detail: input.config.cloudflareIngestSecret
      ? 'set'
      : 'not set — the Cloudflare ingest route is disabled; sending stays on the Resend adapter',
    fix: input.config.cloudflareIngestSecret
      ? undefined
      : 'Optional: run `postwisp setup` to enable the Cloudflare Email Worker ingest route.',
  });

  checks.push({
    name: 'database readable',
    status: input.storeState === 'ok' ? 'ok' : input.storeState === 'missing' ? 'warn' : 'fail',
    detail:
      input.storeState === 'ok'
        ? join(input.config.dataDir, 'postwisp.db')
        : input.storeState === 'missing'
          ? 'no database file yet — created automatically on first run'
          : `${join(input.config.dataDir, 'postwisp.db')} exists but cannot be opened`,
    fix:
      input.storeState === 'unreadable'
        ? `Check ownership and permissions: ls -l "${join(input.config.dataDir, 'postwisp.db')}"`
        : undefined,
  });

  return checks;
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Live checks that talk to the outside world. Each one is skipped when its
// prerequisite is missing (the sync checks already flagged that); every
// failure states what happened, why it matters, and the exact fix.
export async function runLiveDoctorChecks(
  config: PostwispConfig,
  deps: LiveDoctorDeps,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const timeout = { signal: AbortSignal.timeout(15000) };

  if (config.botToken) {
    const name = 'Telegram bot token valid';
    let res: Response | null = null;
    try {
      // Raw Bot API call, no SDK: the token itself is never printed.
      res = await deps.fetchImpl(`https://api.telegram.org/bot${config.botToken}/getMe`, {
        method: 'POST',
        ...timeout,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      checks.push({
        name,
        status: 'fail',
        detail: `could not reach api.telegram.org (${reason})`,
        fix: 'Check your network connection, then run `postwisp doctor` again.',
      });
    }
    if (res) {
      const body = (await readJsonBody(res)) as {
        ok?: boolean;
        description?: string;
        result?: { username?: string; id?: number };
      } | null;
      if (res.ok && body?.ok === true) {
        const who = body.result?.username ? `@${body.result.username}` : `id ${body.result?.id}`;
        checks.push({ name, status: 'ok', detail: `token accepted (${who})` });
      } else {
        const description = body?.description ?? `HTTP ${res.status}`;
        checks.push({
          name,
          status: 'fail',
          detail: `Telegram rejected the bot token (${description}).`,
          fix: 'WHAT: the token is invalid or revoked, so the bot can neither send nor receive anything. ' +
            'Fix: run `postwisp setup` and paste a fresh token from @BotFather.',
        });
      }
    }
  }

  if (config.resendApiKey) {
    const name = 'Resend API key valid';
    let res: Response | null = null;
    try {
      res = await deps.fetchImpl('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${config.resendApiKey}` },
        ...timeout,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      checks.push({
        name,
        status: 'fail',
        detail: `could not reach api.resend.com (${reason})`,
        fix: 'Check your network connection, then run `postwisp doctor` again.',
      });
    }
    if (res) {
      if (res.ok) {
        checks.push({ name, status: 'ok', detail: 'key accepted by Resend' });
      } else if (res.status === 401) {
        checks.push({
          name,
          status: 'fail',
          detail: 'Resend rejected the API key (HTTP 401).',
          fix: 'WHAT: the key is invalid or revoked, so sending mail and checking domains cannot work. ' +
            'Fix: run `postwisp setup` to set a valid Resend API key.',
        });
      } else {
        checks.push({
          name,
          status: 'fail',
          detail: `Resend returned HTTP ${res.status} for the domain list.`,
          fix: 'Fix: try again in a minute; if it persists, check https://resend.com/status.',
        });
      }
    }
  }

  {
    const name = 'webhook server reachable';
    const target = `${config.serverHost}:${config.serverPort}`;
    let reachable = false;
    try {
      reachable = await deps.probePort(config.serverHost, config.serverPort, 3000);
    } catch {
      reachable = false;
    }
    checks.push(
      reachable
        ? { name, status: 'ok', detail: `TCP connect to ${target} succeeded` }
        : {
            name,
            status: 'fail',
            detail:
              `nothing is listening on ${target} — the webhook server is down, so ` +
              'Resend and Telegram cannot deliver events to this instance',
            fix: 'Start postwisp (the webhook server runs inside the main postwisp process), then run `postwisp doctor` again.',
          },
    );
  }

  return checks;
}

// Defensive scrub: check details never contain secrets by construction, but
// the bug report must stay safe even if a detail ever does.
function redactSecrets(text: string, config: PostwispConfig): string {
  const secrets = [
    config.botToken,
    config.webhookSecret,
    config.resendApiKey,
    config.mailersendApiKey,
    config.mailgunApiKey,
    config.cloudflareIngestSecret,
    config.telegramWebhookSecret,
  ];
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function bugReportText(
  checks: DoctorCheck[],
  meta: BugReportMeta,
  config: PostwispConfig,
): string {
  const body = [
    '--- copy below this line into a bug report ---',
    `postwisp version: ${meta.version}`,
    `platform: ${meta.platform}`,
    `node: ${meta.nodeVersion}`,
    'checks:',
    formatDoctorChecks(checks),
    '--- copy above this line ---',
  ].join('\n');
  return redactSecrets(body, config);
}

// ---------------------------------------------------------------------------
// DNS checks (U50). Mail from a domain without SPF, DKIM and DMARC is
// treated as suspicious by receivers; these checks report exactly which
// record is missing and what to publish. The resolver is injected so tests
// never touch the network.
// ---------------------------------------------------------------------------

export type ResolveTxt = (hostname: string) => Promise<string[][]>;

export interface DnsDoctorInput {
  domains: string[];
  provider: EmailProviderName;
  resolveTxt: ResolveTxt;
  // When a Mailgun API key is available, the DKIM check asks Mailgun for
  // the domain's real selector instead of guessing from a hardcoded list.
  mailgunApiKey?: string | null | undefined;
  fetchImpl?: FetchImpl | undefined;
}

// The DKIM selector each provider's docs tell you to publish. Mailgun
// assigns the selector per domain, so its pair below is only the fallback
// for when the API cannot be reached: checkDkim prefers the domain's real
// selectors from the Mailgun API whenever a key is configured.
const DKIM_SELECTORS: Record<EmailProviderName, string[]> = {
  resend: ['resend'],
  mailersend: ['mlsend'],
  mailgun: ['mxvault', 'mailo'],
};

// The SPF include each provider's docs tell you to publish.
const SPF_INCLUDES: Record<EmailProviderName, string> = {
  resend: 'include:amazonses.com',
  mailersend: 'include:_spf.mailersend.net',
  mailgun: 'include:mailgun.org',
};

async function allTxt(resolveTxt: ResolveTxt, hostname: string): Promise<string[] | null> {
  try {
    const records = await resolveTxt(hostname);
    return records.map((parts) => parts.join(''));
  } catch {
    // NXDOMAIN, timeout, no TXT: the caller reports it as a failed check.
    return null;
  }
}

function dnsFail(name: string, detail: string, fix: string): DoctorCheck {
  return { name, status: 'fail', detail, fix };
}

// Unknown JSON from the Mailgun API: every accessor defends itself so one
// unexpected field shape never crashes the check.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// Asks Mailgun which DKIM selector(s) the domain actually uses. GET
// /v3/domains/{domain} returns sending_dns_records; DKIM entries are named
// <selector>._domainkey.<domain>. Returns null on any failure — a network
// error, a bad key, a domain Mailgun does not know — so the caller falls
// back to the known-selector set instead of failing the check.
async function mailgunDkimSelectors(
  domain: string,
  apiKey: string,
  fetchImpl: FetchImpl,
): Promise<string[] | null> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.mailgun.net/v3/domains/${encodeURIComponent(domain)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${apiKey}`, 'utf8').toString('base64')}`,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const records = asRecord(body)['sending_dns_records'];
  if (!Array.isArray(records)) return null;
  const suffix = `._domainkey.${domain.toLowerCase()}`;
  const selectors: string[] = [];
  for (const entry of records) {
    const rec = asRecord(entry);
    const name = asString(rec['name']).toLowerCase();
    if (asString(rec['record_type']).toUpperCase() === 'TXT' && name.endsWith(suffix)) {
      const selector = name.slice(0, -suffix.length);
      if (selector && !selectors.includes(selector)) selectors.push(selector);
    }
  }
  return selectors.length > 0 ? selectors : null;
}

export async function runDnsDoctorChecks(input: DnsDoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const domain of input.domains) {
    checks.push(await checkSpf(domain, input));
    checks.push(await checkDkim(domain, input));
    checks.push(await checkDmarc(domain, input));
  }
  return checks;
}

async function checkSpf(domain: string, input: DnsDoctorInput): Promise<DoctorCheck> {
  const name = `SPF for ${domain}`;
  const records = await allTxt(input.resolveTxt, domain);
  if (records === null) {
    return dnsFail(
      name,
      `no TXT records resolve for ${domain}`,
      `WHAT: receivers cannot verify the domain authorizes your mail server, so mail is more likely to be flagged as spam. ` +
        `Fix: publish a TXT record at "@" (the domain root) with the value "v=spf1 ${SPF_INCLUDES[input.provider]} ~all".`,
    );
  }
  const spf = records.find((r) => r.toLowerCase().startsWith('v=spf1'));
  if (!spf) {
    return dnsFail(
      name,
      `${records.length} TXT record(s) found, none is an SPF record`,
      `WHAT: without an SPF record, receivers cannot verify the domain authorizes your mail server. ` +
        `Fix: publish a TXT record at "@" (the domain root) with the value "v=spf1 ${SPF_INCLUDES[input.provider]} ~all".`,
    );
  }
  return { name, status: 'ok', detail: spf };
}

async function checkDkim(domain: string, input: DnsDoctorInput): Promise<DoctorCheck> {
  const name = `DKIM for ${domain}`;
  let selectors = DKIM_SELECTORS[input.provider];
  let viaApi = false;
  // Mailgun assigns the DKIM selector per domain, so the hardcoded pair
  // above is a guess that fails for any other selector. Ask the API for
  // the domain's real selectors when a key is configured.
  if (input.provider === 'mailgun' && input.mailgunApiKey && input.fetchImpl) {
    const apiSelectors = await mailgunDkimSelectors(domain, input.mailgunApiKey, input.fetchImpl);
    if (apiSelectors) {
      selectors = apiSelectors;
      viaApi = true;
    }
  }
  for (const selector of selectors) {
    const records = await allTxt(input.resolveTxt, `${selector}._domainkey.${domain}`);
    const dkim = records?.find((r) => r.toLowerCase().includes('v=dkim1'));
    if (dkim) {
      return {
        name,
        status: 'ok',
        detail: `${selector}._domainkey.${domain} publishes a DKIM key${viaApi ? ' (selector from the Mailgun API)' : ''}`,
      };
    }
  }
  const hostnames = selectors.map((s) => `${s}._domainkey.${domain}`).join(' or ');
  return dnsFail(
    name,
    `no DKIM key found at ${hostnames}${viaApi ? ' (selectors from the Mailgun API)' : ''}`,
    `WHAT: without DKIM, receivers cannot verify your mail was not tampered with in transit. ` +
      `Fix: copy the DKIM TXT value from your provider's domain settings (${input.provider}) and publish it at ${hostnames}.`,
  );
}

async function checkDmarc(domain: string, input: DnsDoctorInput): Promise<DoctorCheck> {
  const name = `DMARC for ${domain}`;
  const host = `_dmarc.${domain}`;
  const records = await allTxt(input.resolveTxt, host);
  const dmarc = records?.find((r) => r.toLowerCase().startsWith('v=dmarc1'));
  if (dmarc) {
    return { name, status: 'ok', detail: dmarc };
  }
  return dnsFail(
    name,
    records === null ? `no TXT records resolve for ${host}` : 'no DMARC record found',
    `WHAT: without DMARC, receivers apply no policy to mail that fails SPF/DKIM, so spoofed mail from your domain is not rejected. ` +
      `Fix: publish a TXT record at "${host}" with the value "v=DMARC1; p=none;". ` +
      `p=none only monitors; move to p=quarantine or p=reject once legitimate mail flows cleanly.`,
  );
}

// --- input gathering for the real command (kept out of the pure checks so
// tests can inject every value) ---

function statConfigMode(configPath: string): number | null {
  try {
    return statSync(configPath).mode;
  } catch {
    return null;
  }
}

function probeStoreFile(dataDir: string): StoreState {
  const dbPath = join(dataDir, 'postwisp.db');
  try {
    accessSync(dbPath, constants.R_OK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  // Read-only open plus a trivial query: proves the file is a usable
  // database without migrating it or taking a write lock.
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.prepare('SELECT 1').get();
    return 'ok';
  } catch {
    return 'unreadable';
  } finally {
    db?.close();
  }
}

function tcpPortProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function collectBaseInput(config: PostwispConfig): DoctorInput {
  let configReadable = false;
  try {
    accessSync(configFilePath(), constants.R_OK);
    configReadable = true;
  } catch {
    configReadable = false;
  }
  let dataDirState: DataDirState = 'ok';
  try {
    accessSync(config.dataDir, constants.W_OK);
  } catch (error) {
    dataDirState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not-writable';
  }
  return {
    nodeVersion: process.version,
    configPath: configFilePath(),
    configReadable,
    dataDirState,
    config,
  };
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check the installation and explain how to fix problems')
    .action(async () => {
      const config = loadConfig();
      const base = collectBaseInput(config);
      // dist/cli/commands/doctor.js -> repo root is three levels up.
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const checks: DoctorCheck[] = [
        ...runDoctorChecks(base),
        ...runExtendedDoctorChecks({
          ...base,
          configMode: statConfigMode(base.configPath),
          storeState: probeStoreFile(config.dataDir),
        }),
        // Informational only: the serverless companion is optional, so
        // this check warns at most and never fails the run.
        tgcloudDoctorCheck(repoRoot),
        ...(await runLiveDoctorChecks(config, { fetchImpl: fetch, probePort: tcpPortProbe })),
        // DNS records only matter once domains exist; without any, the
        // setup checks above already say what to do.
        ...(config.domains.length > 0
          ? await runDnsDoctorChecks({
              domains: config.domains,
              provider: config.emailProvider,
              resolveTxt: (hostname) => resolveTxt(hostname),
              mailgunApiKey: config.mailgunApiKey,
              fetchImpl: fetch,
            })
          : []),
      ];
      console.log(formatDoctorChecks(checks));
      console.log('');
      console.log(
        bugReportText(
          checks,
          {
            version: VERSION,
            platform: `${process.platform} ${process.arch}`,
            nodeVersion: process.version,
          },
          config,
        ),
      );
      if (worstStatus(checks) === 'fail') process.exitCode = 1;
    });
}
