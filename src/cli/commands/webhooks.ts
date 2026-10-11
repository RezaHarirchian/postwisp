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
import {
  loadConfig,
  type EmailProviderName,
  type PostwispConfig,
} from '../../core/config.js';

// Fetch is injected so tests never touch the network.
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const PROVIDER_LABELS: Record<EmailProviderName, string> = {
  resend: 'Resend',
  mailersend: 'MailerSend',
  mailgun: 'Mailgun',
};

// The path each provider must deliver to on this instance.
const PROVIDER_WEBHOOK_PATHS: Record<EmailProviderName, string> = {
  resend: '/webhooks/resend',
  mailersend: '/webhooks/mailersend',
  mailgun: '/webhooks/mailgun',
};

const RESEND_WEBHOOKS_URL = 'https://api.resend.com/webhooks';
export const RESEND_WEBHOOK_PATH = '/webhooks/resend';

function providerApiKey(config: PostwispConfig, provider: EmailProviderName): string | null {
  switch (provider) {
    case 'mailersend':
      return config.mailersendApiKey;
    case 'mailgun':
      return config.mailgunApiKey;
    default:
      return config.resendApiKey;
  }
}

function mailgunAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`api:${apiKey}`, 'utf8').toString('base64')}`;
}

// Unknown JSON from provider APIs: every accessor defends itself so one
// unexpected field shape never crashes the command.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export interface ProviderWebhookRow {
  id: string;
  endpoint: string;
  pointsAtOurs: boolean;
  // A webhook on the same path but a different host usually means events go
  // to another deployment; that is worth flagging explicitly.
  samePathOtherHost: boolean;
  // Mailgun and MailerSend list webhooks per domain; the domain is shown so
  // the operator knows which listing an entry came from.
  domain?: string;
}

export interface ProviderWebhooksResult {
  provider: EmailProviderName;
  // The URL the provider must deliver events to for this instance.
  ours: string;
  skipped: boolean;
  webhooks: ProviderWebhookRow[];
  matched: boolean;
  // Provider-specific context printed under the listing, e.g. which parts
  // of the plumbing no API covers and where to check them instead.
  note?: string | undefined;
  // Human-readable WHAT + WHY + exact fix when the provider call failed.
  error?: string | undefined;
}

export interface TelegramWebhookState {
  skipped: boolean;
  // null means Telegram has no webhook URL for the bot: it uses polling.
  url: string | null;
  pendingUpdateCount: number;
  lastError: string | null;
  // Human-readable WHAT + WHY + exact fix when the Telegram call failed.
  error?: string | undefined;
}

// The public URL is how the provider reaches us from the internet; the
// flag wins, otherwise we fall back to the configured host/port (usually
// localhost, which no provider can reach — the report says so plainly).
export function ourProviderWebhookUrl(
  config: PostwispConfig,
  provider: EmailProviderName,
  publicUrlFlag?: string,
): string {
  const base = (publicUrlFlag ?? `http://${config.serverHost}:${config.serverPort}`).replace(/\/+$/, '');
  return `${base}${PROVIDER_WEBHOOK_PATHS[provider]}`;
}

export function ourResendWebhookUrl(config: PostwispConfig, publicUrlFlag?: string): string {
  return ourProviderWebhookUrl(config, 'resend', publicUrlFlag);
}

function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

async function fetchResendWebhooks(
  apiKey: string,
  fetchImpl: FetchImpl,
): Promise<Array<{ id: string; endpoint: string }>> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_WEBHOOKS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach api.resend.com (${reason}). Resend webhook status is unknown until Resend answers. ` +
        'Fix: check your network connection and run `postwisp webhooks` again.',
    );
  }
  if (res.status === 401) {
    throw new Error(
      'Resend rejected the API key (HTTP 401). The key is invalid or revoked, so webhooks could not be listed. ' +
        'Fix: run `postwisp setup` to set a valid Resend API key.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `Resend returned HTTP ${res.status} for the webhook list. Webhook status is unknown until Resend answers. ` +
        'Fix: try again in a minute; if it persists, check https://resend.com/status.',
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(
      'Resend returned a response that was not JSON. Webhook status is unknown. ' +
        'Fix: try again in a minute; if it persists, check https://resend.com/status.',
    );
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error(
      'Resend returned an unexpected webhook list shape. Webhook status is unknown. ' +
        'Fix: try again in a minute; if it persists, check https://resend.com/status.',
    );
  }
  return data
    .filter(
      (w): w is { id: unknown; endpoint: unknown } => typeof w === 'object' && w !== null,
    )
    .map((w) => ({ id: String(w.id ?? ''), endpoint: String(w.endpoint ?? '') }));
}

export async function getResendWebhooks(
  config: PostwispConfig,
  publicUrlFlag: string | undefined,
  fetchImpl: FetchImpl,
): Promise<ProviderWebhooksResult> {
  return getProviderWebhooks({ ...config, emailProvider: 'resend' }, publicUrlFlag, fetchImpl);
}

// MailerSend lists activity webhooks per domain, and the list call wants
// the hashed domain id rather than the domain name.
async function mailerSendDomainId(
  apiKey: string,
  domain: string,
  fetchImpl: FetchImpl,
): Promise<string> {
  const res = await fetchImpl('https://api.mailersend.com/v1/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) {
    throw new Error(
      'MailerSend rejected the API key (HTTP 401). The key is invalid or revoked, so webhooks could not be listed. ' +
        'Fix: run `postwisp setup` to set a valid MailerSend API key.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `MailerSend returned HTTP ${res.status} for the domain list. Webhook status is unknown until MailerSend answers. ` +
        'Fix: try again in a minute; if it persists, check https://status.mailersend.com.',
    );
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const rows = Array.isArray(body?.data) ? (body?.data as unknown[]) : [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (asString(rec['name']).toLowerCase() === domain.toLowerCase()) {
      const id = asString(rec['id']);
      if (id) return id;
    }
  }
  throw new Error(
    `MailerSend has no domain "${domain}" in this account, so its webhooks cannot be listed. ` +
      'Fix: verify the domain in the MailerSend dashboard, then run `postwisp webhooks` again.',
  );
}

async function fetchMailerSendWebhooks(
  apiKey: string,
  domain: string,
  fetchImpl: FetchImpl,
): Promise<Array<{ id: string; endpoint: string }>> {
  const domainId = await mailerSendDomainId(apiKey, domain, fetchImpl);
  let res: Response;
  try {
    res = await fetchImpl(
      `https://api.mailersend.com/v1/webhooks?domain_id=${encodeURIComponent(domainId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach api.mailersend.com (${reason}). MailerSend webhook status is unknown until MailerSend answers. ` +
        'Fix: check your network connection and run `postwisp webhooks` again.',
    );
  }
  if (res.status === 401) {
    throw new Error(
      'MailerSend rejected the API key (HTTP 401). The key is invalid or revoked, so webhooks could not be listed. ' +
        'Fix: run `postwisp setup` to set a valid MailerSend API key.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `MailerSend returned HTTP ${res.status} for the webhook list. Webhook status is unknown until MailerSend answers. ` +
        'Fix: try again in a minute; if it persists, check https://status.mailersend.com.',
    );
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const rows = Array.isArray(body?.data) ? (body?.data as unknown[]) : [];
  return rows
    .map((w) => {
      const rec = asRecord(w);
      return { id: asString(rec['id']), endpoint: asString(rec['url']) };
    })
    .filter((w) => w.endpoint.length > 0);
}

// Mailgun lists webhooks per domain: { webhooks: { <type>: { urls: [...] } } }.
async function fetchMailgunWebhooks(
  apiKey: string,
  domain: string,
  fetchImpl: FetchImpl,
): Promise<Array<{ id: string; endpoint: string }>> {
  let res: Response;
  try {
    res = await fetchImpl(
      `https://api.mailgun.net/v3/domains/${encodeURIComponent(domain)}/webhooks`,
      { headers: { Authorization: mailgunAuthHeader(apiKey) } },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach api.mailgun.net (${reason}). Mailgun webhook status is unknown until Mailgun answers. ` +
        'Fix: check your network connection and run `postwisp webhooks` again.',
    );
  }
  if (res.status === 401) {
    throw new Error(
      'Mailgun rejected the API key (HTTP 401). The key is invalid or revoked, so webhooks could not be listed. ' +
        'Fix: run `postwisp setup` to set a valid Mailgun API key.',
    );
  }
  if (res.status === 404) {
    throw new Error(
      `Mailgun has no domain "${domain}" in this account (HTTP 404), so its webhooks cannot be listed. ` +
        'Fix: add and verify the domain in the Mailgun dashboard, then run `postwisp webhooks` again.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `Mailgun returned HTTP ${res.status} for the webhook list of ${domain}. Webhook status is unknown until Mailgun answers. ` +
        'Fix: try again in a minute; if it persists, check https://status.mailgun.com.',
    );
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const webhooks = asRecord(asRecord(body)['webhooks']);
  const out: Array<{ id: string; endpoint: string }> = [];
  for (const [type, entry] of Object.entries(webhooks)) {
    const urls = asRecord(entry)['urls'];
    if (Array.isArray(urls)) {
      for (const url of urls) {
        if (typeof url === 'string' && url.length > 0) {
          out.push({ id: `${domain}:${type}`, endpoint: url });
        }
      }
    }
  }
  return out;
}

async function listProviderWebhooks(
  provider: EmailProviderName,
  apiKey: string,
  domains: string[],
  fetchImpl: FetchImpl,
): Promise<Array<{ id: string; endpoint: string; domain?: string }>> {
  switch (provider) {
    case 'mailersend': {
      const out: Array<{ id: string; endpoint: string; domain?: string }> = [];
      for (const domain of domains) {
        for (const w of await fetchMailerSendWebhooks(apiKey, domain, fetchImpl)) {
          out.push({ ...w, domain });
        }
      }
      return out;
    }
    case 'mailgun': {
      const out: Array<{ id: string; endpoint: string; domain?: string }> = [];
      for (const domain of domains) {
        for (const w of await fetchMailgunWebhooks(apiKey, domain, fetchImpl)) {
          out.push({ ...w, domain });
        }
      }
      return out;
    }
    default:
      // Resend's webhook list is account-wide, not per domain.
      return fetchResendWebhooks(apiKey, fetchImpl);
  }
}

export async function getProviderWebhooks(
  config: PostwispConfig,
  publicUrlFlag: string | undefined,
  fetchImpl: FetchImpl,
): Promise<ProviderWebhooksResult> {
  const provider = config.emailProvider;
  const label = PROVIDER_LABELS[provider];
  const ours = ourProviderWebhookUrl(config, provider, publicUrlFlag);
  const apiKey = providerApiKey(config, provider);
  if (!apiKey) {
    return { provider, ours, skipped: true, webhooks: [], matched: false };
  }
  // MailerSend and Mailgun list webhooks per domain; with no domains
  // configured there is nothing to list.
  if (provider !== 'resend' && config.domains.length === 0) {
    return {
      provider,
      ours,
      skipped: false,
      webhooks: [],
      matched: false,
      note: 'No domains are configured, so there is nothing to list webhooks for. Add one with `postwisp setup`.',
    };
  }
  let remote: Array<{ id: string; endpoint: string; domain?: string }>;
  try {
    remote = await listProviderWebhooks(provider, apiKey, config.domains, fetchImpl);
  } catch (error) {
    return {
      provider,
      ours,
      skipped: false,
      webhooks: [],
      matched: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const ourHost = endpointHost(ours);
  const path = PROVIDER_WEBHOOK_PATHS[provider];
  const webhooks: ProviderWebhookRow[] = remote.map((w) => ({
    id: w.id,
    endpoint: w.endpoint,
    pointsAtOurs: w.endpoint === ours,
    samePathOtherHost: w.endpoint.endsWith(path) && endpointHost(w.endpoint) !== ourHost,
    ...(w.domain !== undefined ? { domain: w.domain } : {}),
  }));
  const result: ProviderWebhooksResult = {
    provider,
    ours,
    skipped: false,
    webhooks,
    matched: webhooks.some((w) => w.pointsAtOurs),
  };
  // The parts of each provider's plumbing that no list API covers, so the
  // operator knows where to look instead of assuming the list is complete.
  if (provider === 'mailersend') {
    result.note =
      'Only activity webhooks (delivery events) are listed above. Inbound mail arrives through MailerSend inbound routes, which have no list API — verify the route forwards to the "our endpoint" URL above in the MailerSend dashboard.';
  } else if (provider === 'mailgun') {
    result.note =
      'Event webhooks are listed per domain above. Inbound mail arrives through Mailgun Routes forwards: make sure a route forwards to the "our endpoint" URL above (Mailgun dashboard → Sending → Routes).';
  }
  return result;
}

export async function getTelegramWebhookInfo(
  botToken: string | null,
  fetchImpl: FetchImpl,
): Promise<TelegramWebhookState> {
  const idle: TelegramWebhookState = {
    skipped: true,
    url: null,
    pendingUpdateCount: 0,
    lastError: null,
  };
  if (!botToken) return idle;
  const state: TelegramWebhookState = { ...idle, skipped: false };
  let res: Response;
  try {
    // Raw Bot API call: no SDK between us and the error Telegram reports.
    res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
      method: 'POST',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    state.error =
      `Could not reach api.telegram.org (${reason}). Telegram webhook status is unknown until Telegram answers. ` +
      'Fix: check your network connection and run `postwisp webhooks` again.';
    return state;
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const result = (body as { ok?: boolean; description?: string; result?: unknown } | null)?.result as
    | {
        url?: string;
        pending_update_count?: number;
        last_error_date?: number;
        last_error_message?: string;
      }
    | undefined;
  if (!res.ok || !result) {
    const description =
      (body as { description?: string } | null)?.description ?? `HTTP ${res.status}`;
    state.error =
      `Telegram refused getWebhookInfo (${description}). The token is probably invalid or revoked, ` +
      'so the bot cannot receive updates at all. Fix: run `postwisp setup` to set a valid bot token from @BotFather.';
    return state;
  }
  state.url = result.url ? result.url : null;
  state.pendingUpdateCount =
    typeof result.pending_update_count === 'number' ? result.pending_update_count : 0;
  state.lastError = result.last_error_message
    ? `${result.last_error_message}${result.last_error_date ? ` (${new Date(result.last_error_date * 1000).toISOString()})` : ''}`
    : null;
  return state;
}

function formatProviderSection(result: ProviderWebhooksResult): string {
  const label = PROVIDER_LABELS[result.provider];
  const path = PROVIDER_WEBHOOK_PATHS[result.provider];
  const lines = [`${label} webhooks`, `  our endpoint: ${result.ours}`];
  if (result.skipped) {
    lines.push(
      `  skipped: no ${label} API key is set.`,
      `  Without the key, postwisp cannot verify that ${label} delivers email events to ${path}, so inbound mail would silently stop.`,
      '  fix: Run `postwisp setup` to add your API key.',
    );
    return lines.join('\n');
  }
  if (result.error) {
    lines.push(`  error: ${result.error}`);
    return lines.join('\n');
  }
  if (result.webhooks.length === 0) {
    lines.push(
      `  no webhooks registered with ${label}.`,
      `  ${label} has nowhere to deliver email events, so inbound mail will not arrive.`,
      `  fix: create a webhook in the ${label} dashboard pointing at the "our endpoint" URL above.`,
    );
  } else {
    for (const w of result.webhooks) {
      const mark = w.pointsAtOurs ? 'yes' : w.samePathOtherHost ? 'other host' : 'no';
      lines.push(
        `  - ${w.endpoint}  points at ours: ${mark}${w.domain ? `  (domain: ${w.domain})` : ''}`,
      );
      if (w.samePathOtherHost) {
        lines.push(
          `    warning: this webhook targets ${path} on a different host — events go there, not here.`,
        );
      }
    }
    if (!result.matched) {
      lines.push(
        `  No ${label} webhook points at our endpoint, so email events are not delivered to this instance.`,
        `  fix: create a webhook in the ${label} dashboard pointing at the "our endpoint" URL above.`,
      );
    }
  }
  if (result.note) {
    lines.push(`  note: ${result.note}`);
  }
  return lines.join('\n');
}

function formatTelegramSection(state: TelegramWebhookState): string {
  const lines = ['Telegram webhook'];
  if (state.skipped) {
    lines.push(
      '  skipped: no bot token is set.',
      '  Without a token, postwisp cannot ask Telegram anything, so neither polling nor webhooks can work.',
      '  fix: Run `postwisp setup` to add your bot token.',
    );
    return lines.join('\n');
  }
  if (state.error) {
    lines.push(`  error: ${state.error}`);
    return lines.join('\n');
  }
  lines.push(
    state.url
      ? `  webhook URL: ${state.url}`
      : '  webhook URL: not set — the bot uses long polling.',
  );
  lines.push(`  pending updates: ${state.pendingUpdateCount}`);
  lines.push(`  last error: ${state.lastError ?? 'none'}`);
  if (state.pendingUpdateCount > 0) {
    lines.push(
      '  Telegram is holding undelivered updates. If the count keeps growing, the bot is not processing them.',
      '  fix: make sure postwisp is running, then run `postwisp webhooks test telegram` again.',
    );
  }
  if (state.lastError) {
    lines.push(
      '  Telegram reported a delivery error for the webhook URL. Fix the URL or the server behind it, ' +
        'then run `postwisp webhooks test telegram` again.',
    );
  }
  return lines.join('\n');
}

export function formatWebhooksReport(
  provider: ProviderWebhooksResult,
  telegram: TelegramWebhookState,
): string {
  return `${formatProviderSection(provider)}\n\n${formatTelegramSection(telegram)}`;
}

// `postwisp webhooks test telegram`: the same Telegram state, explained for a
// human instead of a dashboard.
export function formatTelegramTest(state: TelegramWebhookState): string {
  if (state.skipped) {
    return [
      'Cannot test the Telegram webhook: no bot token is set.',
      'Without a token, postwisp cannot ask Telegram anything.',
      'fix: Run `postwisp setup` to add your bot token.',
    ].join('\n');
  }
  if (state.error) {
    return `Telegram webhook test failed: ${state.error}`;
  }
  const lines = [
    state.url
      ? `Telegram webhook is set to ${state.url}.`
      : 'No Telegram webhook URL is set, so the bot receives updates via long polling.',
  ];
  lines.push(
    state.pendingUpdateCount === 0
      ? 'No updates are waiting on Telegram.'
      : `${state.pendingUpdateCount} update(s) are waiting on Telegram — the bot is behind or not running.`,
  );
  lines.push(
    state.lastError
      ? `Telegram's last delivery error: ${state.lastError}`
      : 'Telegram reports no delivery errors.',
  );
  return lines.join('\n');
}

export function registerWebhooks(program: Command): void {
  const cmd = program
    .command('webhooks')
    .description('Show email provider and Telegram webhook status')
    .option(
      '--public-url <url>',
      'Public base URL of this postwisp instance, used to match the provider webhook',
    )
    .action(async (options: { publicUrl?: string }) => {
      const config = loadConfig();
      // The flag wins; otherwise the configured public URL; otherwise the
      // local server address as before.
      const provider = await getProviderWebhooks(
        config,
        options.publicUrl ?? config.publicUrl ?? undefined,
        fetch,
      );
      const telegram = await getTelegramWebhookInfo(config.botToken, fetch);
      console.log(formatWebhooksReport(provider, telegram));
      if (provider.error || telegram.error) process.exitCode = 1;
    });

  cmd
    .command('test')
    .description('Probe a webhook integration and explain the result in plain language')
    .argument('<target>', 'which integration to test: telegram')
    .action(async (target: string) => {
      if (target !== 'telegram') {
        console.error(
          `Unknown test target "${target}". Only "telegram" is supported: postwisp webhooks test telegram`,
        );
        process.exitCode = 1;
        return;
      }
      const config = loadConfig();
      const state = await getTelegramWebhookInfo(config.botToken, fetch);
      console.log(formatTelegramTest(state));
      if (state.error) process.exitCode = 1;
    });
}
