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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Which provider adapter sends mail and receives webhooks. 'resend' is
// the default; the adapter is selected in src/index.ts.
export type EmailProviderName = 'resend' | 'mailersend' | 'mailgun';

export interface PostwispConfig {
  ownerId: number | null;
  botToken: string | null;
  dataDir: string;
  logLevel: LogLevel;
  serverPort: number;
  serverHost: string;
  webhookSecret: string | null;
  resendApiKey: string | null;
  emailProvider: EmailProviderName;
  mailersendApiKey: string | null;
  mailgunApiKey: string | null;
  // Shared secret the companion Cloudflare Email Worker uses to sign its
  // /ingest/cloudflare POSTs. Unset means the Cloudflare ingest route is
  // disabled; sending always stays on the Resend adapter.
  cloudflareIngestSecret: string | null;
  domains: string[];
  // Telegram webhook mode (mutually exclusive with polling): an unguessable
  // path plus the secret token Telegram sends in a header. Both unset means
  // polling, which is the right default for dev and simple setups.
  telegramWebhookPath: string | null;
  telegramWebhookSecret: string | null;
  // Bookkeeping for the resumable `postwisp setup` wizard: the next step to
  // run, or 'done'. Wizard-internal, not operator config.
  setupStep: string | null;
  // Optional file the daemon appends its logs to (in addition to stdout).
  // `postwisp logs` reads this path; unset means stdout only.
  logFile: string | null;
  // Physical mailing address for the unsubscribe footer on non-personal
  // mail (bulk-mail best practice; asked in setup, optional).
  physicalAddress: string | null;
  // Abuse contact shown in the README and the abuse runbook; optional.
  abuseContact: string | null;
  // Public base URL of this instance (https://mail.example.com): builds
  // the one-click unsubscribe links and defaults `webhooks --public-url`.
  publicUrl: string | null;
  // BYOK key for the P8 AI features (triage, smart replies, nudges). Null
  // means every AI path is inert: no request, no UI, no scheduler work.
  llmApiKey: string | null;
  // OpenAI-compatible endpoint and model for the AI features.
  llmModel: string;
  llmBaseUrl: string;
  // Follow-up nudges fire for sent mail older than this many days with no
  // reply detected.
  nudgeDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Minimum for webhookSecret: it doubles as the HMAC key minting unsubscribe
// tokens, so anything shorter makes those tokens brute-forceable.
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Config lives under XDG paths so it survives reinstalls and stays out of the repo.
export function configDir(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'postwisp');
}

export function defaultDataDir(): string {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(base, 'postwisp');
}

export function configFilePath(): string {
  return join(configDir(), 'config.json');
}

export function defaultConfig(): PostwispConfig {
  return {
    ownerId: null,
    botToken: null,
    dataDir: defaultDataDir(),
    logLevel: 'info',
    serverPort: 3000,
    serverHost: '127.0.0.1',
    webhookSecret: null,
    resendApiKey: null,
    emailProvider: 'resend',
    mailersendApiKey: null,
    mailgunApiKey: null,
    cloudflareIngestSecret: null,
    domains: [],
    telegramWebhookPath: null,
    telegramWebhookSecret: null,
    setupStep: null,
    logFile: null,
    physicalAddress: null,
    abuseContact: null,
    publicUrl: null,
    llmApiKey: null,
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    nudgeDays: 3,
  };
}

function parseOwnerId(raw: string, source: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`invalid owner id in ${source}: expected a positive integer`);
  }
  return n;
}

function parsePort(raw: string, source: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`invalid port in ${source}: expected 1-65535`);
  }
  return n;
}

function parseLogLevel(raw: string, source: string): LogLevel {
  if (!(LOG_LEVELS as string[]).includes(raw)) {
    throw new ConfigError(`invalid log level in ${source}: expected one of ${LOG_LEVELS.join(', ')}`);
  }
  return raw as LogLevel;
}

const EMAIL_PROVIDERS: EmailProviderName[] = ['resend', 'mailersend', 'mailgun'];

// Exported for the setup wizard's provider selection.
export function parseEmailProvider(raw: string, source: string): EmailProviderName {
  if (!(EMAIL_PROVIDERS as string[]).includes(raw)) {
    throw new ConfigError(
      `invalid email provider in ${source}: expected one of ${EMAIL_PROVIDERS.join(', ')}`,
    );
  }
  return raw as EmailProviderName;
}

// Environment is the middle layer: it beats the file, but explicit flags beat it.
function configFromEnv(): Partial<PostwispConfig> {
  const env = process.env;
  const out: Partial<PostwispConfig> = {};
  if (env['POSTWISP_OWNER_ID']) out.ownerId = parseOwnerId(env['POSTWISP_OWNER_ID'], 'env POSTWISP_OWNER_ID');
  if (env['POSTWISP_BOT_TOKEN']) out.botToken = env['POSTWISP_BOT_TOKEN'];
  if (env['POSTWISP_DATA_DIR']) out.dataDir = env['POSTWISP_DATA_DIR'];
  if (env['POSTWISP_LOG_LEVEL']) out.logLevel = parseLogLevel(env['POSTWISP_LOG_LEVEL'], 'env POSTWISP_LOG_LEVEL');
  if (env['POSTWISP_SERVER_PORT']) out.serverPort = parsePort(env['POSTWISP_SERVER_PORT'], 'env POSTWISP_SERVER_PORT');
  if (env['POSTWISP_SERVER_HOST']) out.serverHost = env['POSTWISP_SERVER_HOST'];
  if (env['POSTWISP_WEBHOOK_SECRET']) out.webhookSecret = env['POSTWISP_WEBHOOK_SECRET'];
  if (env['POSTWISP_RESEND_API_KEY']) out.resendApiKey = env['POSTWISP_RESEND_API_KEY'];
  if (env['POSTWISP_EMAIL_PROVIDER'])
    out.emailProvider = parseEmailProvider(env['POSTWISP_EMAIL_PROVIDER'], 'env POSTWISP_EMAIL_PROVIDER');
  if (env['POSTWISP_MAILERSEND_API_KEY']) out.mailersendApiKey = env['POSTWISP_MAILERSEND_API_KEY'];
  if (env['POSTWISP_MAILGUN_API_KEY']) out.mailgunApiKey = env['POSTWISP_MAILGUN_API_KEY'];
  if (env['POSTWISP_CF_INGEST_SECRET']) out.cloudflareIngestSecret = env['POSTWISP_CF_INGEST_SECRET'];
  if (env['POSTWISP_TELEGRAM_WEBHOOK_PATH']) out.telegramWebhookPath = env['POSTWISP_TELEGRAM_WEBHOOK_PATH'];
  if (env['POSTWISP_TELEGRAM_WEBHOOK_SECRET'])
    out.telegramWebhookSecret = env['POSTWISP_TELEGRAM_WEBHOOK_SECRET'];
  if (env['POSTWISP_DOMAINS']) {
    out.domains = env['POSTWISP_DOMAINS'].split(',').map((d) => d.trim()).filter(Boolean);
  }
  if (env['POSTWISP_SETUP_STEP']) out.setupStep = env['POSTWISP_SETUP_STEP'];
  if (env['POSTWISP_LOG_FILE']) out.logFile = env['POSTWISP_LOG_FILE'];
  if (env['POSTWISP_PHYSICAL_ADDRESS']) out.physicalAddress = env['POSTWISP_PHYSICAL_ADDRESS'];
  if (env['POSTWISP_ABUSE_CONTACT']) out.abuseContact = env['POSTWISP_ABUSE_CONTACT'];
  if (env['POSTWISP_PUBLIC_URL'])
    out.publicUrl = parsePublicUrl(env['POSTWISP_PUBLIC_URL'], 'env POSTWISP_PUBLIC_URL');
  if (env['POSTWISP_LLM_API_KEY']) out.llmApiKey = env['POSTWISP_LLM_API_KEY'];
  if (env['POSTWISP_LLM_MODEL']) out.llmModel = env['POSTWISP_LLM_MODEL'];
  if (env['POSTWISP_LLM_BASE_URL']) out.llmBaseUrl = env['POSTWISP_LLM_BASE_URL'];
  if (env['POSTWISP_NUDGE_DAYS'])
    out.nudgeDays = parseNudgeDays(env['POSTWISP_NUDGE_DAYS'], 'env POSTWISP_NUDGE_DAYS');
  return out;
}

export function readConfigFile(filePath: string = configFilePath()): Partial<PostwispConfig> {
  return validateFileValues(readRawConfigObject(filePath), filePath);
}

// The file as written, without validation: saveConfigFile merges over
// this so keys it does not recognize (future versions, operator notes)
// survive a write instead of being silently dropped.
function readRawConfigObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigError(`cannot read config file at ${filePath}: permission denied or unreadable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`cannot parse config file at ${filePath}: not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`cannot parse config file at ${filePath}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// File values are validated like env values: a wrong-typed entry is a loud
// error at startup, not a silently broken bot later.
function validateFileValues(raw: Record<string, unknown>, filePath: string): Partial<PostwispConfig> {
  const source = `config file ${filePath}`;
  const out: Partial<PostwispConfig> = {};
  const asString = (v: unknown, key: string): string => {
    if (typeof v !== 'string') throw new ConfigError(`invalid ${key} in ${source}: expected a string`);
    return v;
  };
  if (raw['ownerId'] !== undefined && raw['ownerId'] !== null) {
    out.ownerId = parseOwnerId(String(raw['ownerId']), source);
  }
  if (raw['botToken'] !== undefined) out.botToken = raw['botToken'] === null ? null : asString(raw['botToken'], 'botToken');
  if (raw['dataDir'] !== undefined) out.dataDir = asString(raw['dataDir'], 'dataDir');
  if (raw['logLevel'] !== undefined) out.logLevel = parseLogLevel(asString(raw['logLevel'], 'logLevel'), source);
  if (raw['serverPort'] !== undefined) out.serverPort = parsePort(String(raw['serverPort']), source);
  if (raw['serverHost'] !== undefined) out.serverHost = asString(raw['serverHost'], 'serverHost');
  if (raw['webhookSecret'] !== undefined) {
    out.webhookSecret = raw['webhookSecret'] === null ? null : asString(raw['webhookSecret'], 'webhookSecret');
  }
  if (raw['telegramWebhookPath'] !== undefined) {
    out.telegramWebhookPath =
      raw['telegramWebhookPath'] === null ? null : asString(raw['telegramWebhookPath'], 'telegramWebhookPath');
  }
  if (raw['telegramWebhookSecret'] !== undefined) {
    out.telegramWebhookSecret =
      raw['telegramWebhookSecret'] === null ? null : asString(raw['telegramWebhookSecret'], 'telegramWebhookSecret');
  }
  if (raw['resendApiKey'] !== undefined) {
    out.resendApiKey = raw['resendApiKey'] === null ? null : asString(raw['resendApiKey'], 'resendApiKey');
  }
  if (raw['emailProvider'] !== undefined) {
    out.emailProvider = parseEmailProvider(asString(raw['emailProvider'], 'emailProvider'), source);
  }
  if (raw['mailersendApiKey'] !== undefined) {
    out.mailersendApiKey =
      raw['mailersendApiKey'] === null ? null : asString(raw['mailersendApiKey'], 'mailersendApiKey');
  }
  if (raw['mailgunApiKey'] !== undefined) {
    out.mailgunApiKey = raw['mailgunApiKey'] === null ? null : asString(raw['mailgunApiKey'], 'mailgunApiKey');
  }
  // Both spellings are accepted: `config set` writes camelCase, older
  // files may carry the snake_case key. camelCase wins when both exist.
  const cfSecretRaw =
    raw['cloudflareIngestSecret'] !== undefined
      ? { value: raw['cloudflareIngestSecret'], key: 'cloudflareIngestSecret' }
      : { value: raw['cloudflare_ingest_secret'], key: 'cloudflare_ingest_secret' };
  if (cfSecretRaw.value !== undefined) {
    out.cloudflareIngestSecret =
      cfSecretRaw.value === null ? null : asString(cfSecretRaw.value, cfSecretRaw.key);
  }
  if (raw['domains'] !== undefined) {
    if (!Array.isArray(raw['domains']) || !raw['domains'].every((d) => typeof d === 'string')) {
      throw new ConfigError(`invalid domains in ${source}: expected an array of strings`);
    }
    out.domains = raw['domains'] as string[];
  }
  if (raw['setupStep'] !== undefined) {
    out.setupStep = raw['setupStep'] === null ? null : asString(raw['setupStep'], 'setupStep');
  }
  if (raw['logFile'] !== undefined) {
    out.logFile = raw['logFile'] === null ? null : asString(raw['logFile'], 'logFile');
  }
  if (raw['physicalAddress'] !== undefined) {
    out.physicalAddress =
      raw['physicalAddress'] === null ? null : asString(raw['physicalAddress'], 'physicalAddress');
  }
  if (raw['abuseContact'] !== undefined) {
    out.abuseContact =
      raw['abuseContact'] === null ? null : asString(raw['abuseContact'], 'abuseContact');
  }
  if (raw['publicUrl'] !== undefined) {
    out.publicUrl =
      raw['publicUrl'] === null ? null : parsePublicUrl(asString(raw['publicUrl'], 'publicUrl'), source);
  }
  if (raw['llmApiKey'] !== undefined) {
    out.llmApiKey = raw['llmApiKey'] === null ? null : asString(raw['llmApiKey'], 'llmApiKey');
  }
  if (raw['llmModel'] !== undefined) out.llmModel = asString(raw['llmModel'], 'llmModel');
  if (raw['llmBaseUrl'] !== undefined) out.llmBaseUrl = asString(raw['llmBaseUrl'], 'llmBaseUrl');
  if (raw['nudgeDays'] !== undefined) {
    out.nudgeDays = parseNudgeDays(String(raw['nudgeDays']), source);
  }
  return out;
}

function defined<T>(obj: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// Priority, highest first: explicit flags > environment > config file > defaults.
export function loadConfig(flags: Partial<PostwispConfig> = {}, filePath: string = configFilePath()): PostwispConfig {
  const fileValues = readConfigFile(filePath);
  const envValues = configFromEnv();
  const config = {
    ...defaultConfig(),
    ...defined(fileValues),
    ...envValues,
    ...defined(flags),
  };
  // The secret doubles as the HMAC key for unsubscribe tokens; enforce the
  // minimum here as well so a short secret via env var or config file cannot
  // slip past the `config set` validation.
  if (config.webhookSecret !== null && config.webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new ConfigError(
      `webhookSecret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters: check POSTWISP_WEBHOOK_SECRET or the config file.`,
    );
  }
  return config;
}

// Writes are always explicit: the caller passes exactly what should change.
// Unrecognized keys already in the file are preserved. The file is created
// with 0600 so secrets never sit world-readable.
export function saveConfigFile(values: Partial<PostwispConfig>, filePath: string = configFilePath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const existing = readRawConfigObject(filePath);
  const merged: Record<string, unknown> = { ...existing, ...defined(values) };
  // The file may predate the camelCase spelling; the reader prefers
  // camelCase, so drop the stale snake_case twin when the new one is set.
  if (values.cloudflareIngestSecret !== undefined) {
    delete merged['cloudflare_ingest_secret'];
  }
  writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  // mode on write does not apply when the file already exists; enforce it.
  chmodSync(filePath, 0o600);
}

// Safe to print or log: secrets are replaced before they can leak.
export function redactedConfig(config: PostwispConfig): Record<string, unknown> {
  return {
    ...config,
    botToken: config.botToken ? '[redacted]' : null,
    webhookSecret: config.webhookSecret ? '[redacted]' : null,
    resendApiKey: config.resendApiKey ? '[redacted]' : null,
    mailersendApiKey: config.mailersendApiKey ? '[redacted]' : null,
    mailgunApiKey: config.mailgunApiKey ? '[redacted]' : null,
    cloudflareIngestSecret: config.cloudflareIngestSecret ? '[redacted]' : null,
    telegramWebhookSecret: config.telegramWebhookSecret ? '[redacted]' : null,
    llmApiKey: config.llmApiKey ? '[redacted]' : null,
  };
}

// Keys whose values must never be printed. Single source of truth for the
// CLI's "what changed" lines and `config` output.
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'botToken',
  'webhookSecret',
  'resendApiKey',
  'mailersendApiKey',
  'mailgunApiKey',
  'cloudflareIngestSecret',
  'telegramWebhookSecret',
  'llmApiKey',
]);

export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key);
}

// Display-safe rendering for `config` output and setup's "what changed"
// lines. Secret values are never rendered.
export function displayConfigValue(key: string, value: unknown): string {
  if (isSecretConfigKey(key)) {
    return value === null || value === undefined || value === '' ? '(not set)' : '[redacted]';
  }
  if (value === null || value === undefined || value === '') return '(not set)';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)';
  return String(value);
}

// One line per changed key for "what changed" reports after a write.
// setupStep is wizard bookkeeping, not a user-facing change, so it stays out.
export function describeChanges(before: PostwispConfig, delta: Partial<PostwispConfig>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'setupStep' || value === undefined) continue;
    const oldValue = (before as unknown as Record<string, unknown>)[key];
    const wasEmpty =
      oldValue === undefined ||
      oldValue === null ||
      oldValue === '' ||
      (Array.isArray(oldValue) && oldValue.length === 0);
    const action = value === null || value === '' ? 'cleared' : wasEmpty ? 'set' : 'updated';
    lines.push(`  ${key}: ${displayConfigValue(key, value)} (${action})`);
  }
  return lines;
}

// Parses a comma-separated domain list from the wizard or `config set`.
// Lowercases, dedupes, and rejects anything that is not a dotted hostname.
const DOMAIN_LABEL = '(?!-)[A-Za-z0-9-]{1,63}(?<!-)';
const DOMAIN_RE = new RegExp(`^${DOMAIN_LABEL}(\\.${DOMAIN_LABEL})+$`);

export function parseDomains(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const d = part.trim().toLowerCase();
    if (d.length === 0) continue;
    if (!DOMAIN_RE.test(d)) {
      throw new ConfigError(`invalid domain "${d}": expected a comma-separated list like "mail.example.com"`);
    }
    seen.add(d);
  }
  return [...seen];
}

// Follow-up nudges need a positive whole number of days.
function parseNudgeDays(raw: string, source: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`invalid nudge days in ${source}: expected a positive integer`);
  }
  return n;
}

// Keys the `postwisp config` command may read or change. setupStep is the
// wizard's private bookkeeping and stays out.
export const CONFIG_COMMAND_KEYS = [
  'ownerId',
  'botToken',
  'dataDir',
  'logLevel',
  'serverPort',
  'serverHost',
  'webhookSecret',
  'resendApiKey',
  'emailProvider',
  'mailersendApiKey',
  'mailgunApiKey',
  'cloudflareIngestSecret',
  'telegramWebhookPath',
  'telegramWebhookSecret',
  'domains',
  'logFile',
  'physicalAddress',
  'abuseContact',
  'publicUrl',
  'llmApiKey',
  'llmModel',
  'llmBaseUrl',
  'nudgeDays',
] as const;

// The public URL is where recipients land; it must be an absolute http(s)
// URL without a path, so unsubscribe links are built correctly.
function parsePublicUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError(`invalid publicUrl in ${source}: expected an absolute URL like "https://mail.example.com"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`invalid publicUrl in ${source}: expected an http(s) URL like "https://mail.example.com"`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(
      `invalid publicUrl in ${source}: expected a bare origin like "https://mail.example.com" (no path, query, or fragment)`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

// Validates one `config set <key> <value>` pair with the same rules as the
// config file and environment. An empty value clears nullable keys.
export function parseConfigValue(key: string, raw: string): Partial<PostwispConfig> {
  switch (key) {
    case 'ownerId':
      return { ownerId: raw === '' ? null : parseOwnerId(raw, 'config set ownerId') };
    case 'botToken':
      return { botToken: raw === '' ? null : raw };
    case 'dataDir':
      if (raw === '') throw new ConfigError('dataDir cannot be empty: pass a directory path.');
      return { dataDir: raw };
    case 'logLevel':
      return { logLevel: parseLogLevel(raw, 'config set logLevel') };
    case 'serverPort':
      return { serverPort: parsePort(raw, 'config set serverPort') };
    case 'serverHost':
      if (raw === '') throw new ConfigError('serverHost cannot be empty: pass a hostname or IP.');
      return { serverHost: raw };
    case 'webhookSecret': {
      // The secret doubles as the HMAC key for unsubscribe tokens; a short
      // secret makes those tokens brute-forceable.
      if (raw !== '' && raw.length < MIN_WEBHOOK_SECRET_LENGTH) {
        throw new ConfigError(`webhookSecret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`);
      }
      return { webhookSecret: raw === '' ? null : raw };
    }
    case 'resendApiKey':
      return { resendApiKey: raw === '' ? null : raw };
    case 'emailProvider':
      if (raw === '') throw new ConfigError('emailProvider cannot be empty: pass resend, mailersend, or mailgun.');
      return { emailProvider: parseEmailProvider(raw, 'config set emailProvider') };
    case 'mailersendApiKey':
      return { mailersendApiKey: raw === '' ? null : raw };
    case 'mailgunApiKey':
      return { mailgunApiKey: raw === '' ? null : raw };
    case 'cloudflareIngestSecret':
      return { cloudflareIngestSecret: raw === '' ? null : raw };
    case 'telegramWebhookPath':
      return { telegramWebhookPath: raw === '' ? null : raw };
    case 'telegramWebhookSecret':
      return { telegramWebhookSecret: raw === '' ? null : raw };
    case 'domains':
      return { domains: parseDomains(raw) };
    case 'logFile':
      return { logFile: raw === '' ? null : raw };
    case 'physicalAddress':
      return { physicalAddress: raw === '' ? null : raw };
    case 'abuseContact': {
      const value = raw.trim();
      if (value !== '' && !value.includes('@')) {
        throw new ConfigError('invalid abuseContact: expected an email address.');
      }
      return { abuseContact: value === '' ? null : value };
    }
    case 'publicUrl':
      return { publicUrl: raw === '' ? null : parsePublicUrl(raw, 'config set publicUrl') };
    case 'llmApiKey':
      return { llmApiKey: raw === '' ? null : raw };
    case 'llmModel':
      if (raw === '') throw new ConfigError('llmModel cannot be empty: pass a model name.');
      return { llmModel: raw };
    case 'llmBaseUrl':
      if (raw === '') throw new ConfigError('llmBaseUrl cannot be empty: pass an http(s) URL.');
      return { llmBaseUrl: raw };
    case 'nudgeDays':
      return { nudgeDays: parseNudgeDays(raw, 'config set nudgeDays') };
    default:
      throw new ConfigError(
        `unknown config key "${key}". Valid keys: ${CONFIG_COMMAND_KEYS.join(', ')}`,
      );
  }
}
