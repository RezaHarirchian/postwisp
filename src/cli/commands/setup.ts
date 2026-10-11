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

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Command } from 'commander';
import { confirm, intro, isCancel, outro, password, select, spinner, text } from '@clack/prompts';
import {
  configFilePath,
  describeChanges,
  loadConfig,
  parseConfigValue,
  parseDomains,
  parseEmailProvider,
  saveConfigFile,
  type EmailProviderName,
  type PostwispConfig,
} from '../../core/config.js';
import { openStore } from '../../core/store.js';
import { ResendEmailProvider } from '../../providers/resend.js';
import { MailerSendProvider } from '../../providers/mailersend.js';
import { MailgunProvider } from '../../providers/mailgun.js';
import type { EmailProvider } from '../../providers/interface.js';
import {
  describeError,
  fetchBotUsername,
  generatePairingToken,
  pairingLink,
  storePairingToken,
  type FetchImpl,
  type KvStore,
} from './pair.js';

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export class SetupCancelled extends Error {
  constructor() {
    super('Setup cancelled. Your progress is saved — re-run `postwisp setup` to continue.');
    this.name = 'SetupCancelled';
  }
}

// Shared secrets below this length are rejected in non-interactive setup.
// The wizard generates 64-char secrets; 16 chars is the floor for a value
// anyone could plausibly call unguessable.
const MIN_SECRET_LENGTH = 16;

// Wizard steps in order. The current step is persisted as `setupStep` in
// the config file after every step, so re-running `setup` resumes.
// 'resend' is the pre-P5 name of the 'provider' step; a config written by
// an older build resumes correctly through the mapping in runSetup.
export const SETUP_STEPS = ['bot-token', 'owner', 'provider', 'domains', 'compliance', 'cloudflare', 'e2e'] as const;
export type SetupStepName = (typeof SETUP_STEPS)[number];
export type SetupStep = SetupStepName | 'done';

export function isSetupStep(value: string | null): value is SetupStep {
  return (
    value === 'done' ||
    value === 'resend' || // pre-P5 name of the 'provider' step
    (SETUP_STEPS as readonly string[]).includes(value ?? '')
  );
}

export interface TextPromptOptions {
  message: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

export interface SelectPromptOptions {
  message: string;
  options: Array<{ value: string; label: string; hint?: string }>;
}

// Prompt IO behind an interface so tests can script answers instead of
// driving a terminal. The real implementation wraps @clack/prompts.
export interface Prompter {
  text(opts: TextPromptOptions): Promise<string>;
  password(opts: TextPromptOptions): Promise<string>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  select(opts: SelectPromptOptions): Promise<string>;
  spinnerStart(message: string): void;
  spinnerStop(message?: string): void;
}

function clackPrompter(isTTY: boolean): Prompter {
  let spin: ReturnType<typeof spinner> | null = null;
  const orCancel = <T>(value: T | symbol): T => {
    if (isCancel(value)) throw new SetupCancelled();
    return value;
  };
  return {
    text: async (opts) =>
      // exactOptionalPropertyTypes: omit unset optionals instead of passing
      // an explicit undefined.
      orCancel(
        await text({
          message: opts.message,
          ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
          ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
        }),
      ),
    password: async (opts) =>
      // clack's password requires a validate function; default to accepting.
      orCancel(
        await password({ message: opts.message, validate: opts.validate ?? (() => undefined) }),
      ),
    confirm: async (message, initialValue) =>
      // exactOptionalPropertyTypes: never pass an explicit undefined.
      orCancel(await confirm(initialValue === undefined ? { message } : { message, initialValue })),
    select: async (opts) => orCancel(await select({ message: opts.message, options: opts.options })),
    // Spinner and progress output only make sense on a live terminal.
    spinnerStart: (message) => {
      if (!isTTY) return;
      spin = spinner();
      spin.start(message);
    },
    spinnerStop: (message) => {
      spin?.stop(message ?? '');
      spin = null;
    },
  };
}

// Scripted answers for tests: strings for text/password/select, booleans
// for confirm, consumed in prompt order.
export function scriptPrompter(answers: Array<string | boolean>): Prompter {
  let i = 0;
  const take = (): string | boolean => {
    const a: string | boolean | undefined = answers[i];
    if (a === undefined) throw new Error(`scriptPrompter: ran out of answers at index ${i}`);
    i++;
    return a;
  };
  const takeString = (what: string): string => {
    const a = take();
    if (typeof a !== 'string') throw new Error(`scriptPrompter: expected a string for ${what}`);
    return a;
  };
  const takeBoolean = (what: string): boolean => {
    const a = take();
    if (typeof a !== 'boolean') throw new Error(`scriptPrompter: expected a boolean for ${what}`);
    return a;
  };
  return {
    text: async () => takeString('text'),
    password: async () => takeString('password'),
    confirm: async () => takeBoolean('confirm'),
    select: async () => takeString('select'),
    spinnerStart: () => undefined,
    spinnerStop: () => undefined,
  };
}

export interface SetupDeps {
  fetchImpl: FetchImpl;
  nowMs: () => number;
  isTTY: boolean;
  configPath: string;
  prompter: Prompter;
  out: (line: string) => void;
  // The store is opened per data dir in production; injected in tests so
  // they never touch the real database. Short-lived CLI process, so the
  // handle is left for process exit to reclaim.
  openKvStore: (dataDir: string) => KvStore;
  env: Record<string, string | undefined>;
}

interface StepContext {
  deps: SetupDeps;
  config: PostwispConfig;
  nonInteractive: boolean;
}

function saveAndReport(deps: SetupDeps, before: PostwispConfig, delta: Partial<PostwispConfig>): void {
  saveConfigFile(delta, deps.configPath);
  for (const line of describeChanges(before, delta)) deps.out(line);
}

export function parseOwnerIdInput(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new SetupError(
      `"${raw.trim()}" is not a valid Telegram user ID: it must be a positive integer. ` +
        'Fix: paste the numeric ID from @userinfobot (digits only, no @username).',
    );
  }
  return n;
}

function validateOwnerIdText(value: string): string | undefined {
  try {
    parseOwnerIdInput(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Live-checks a bot token against Telegram's getMe. Throws PairError with a
// what/why/fix message; the token itself never appears in it.
async function validateBotToken(deps: SetupDeps, token: string): Promise<void> {
  deps.prompter.spinnerStart('Checking the bot token with Telegram…');
  try {
    await fetchBotUsername(token, deps.fetchImpl);
  } finally {
    deps.prompter.spinnerStop();
  }
}

// Live-checks a Resend API key by listing domains. Never prints the key.
export async function validateResendKey(
  apiKey: string,
  fetchImpl: FetchImpl,
  prompter: Prompter,
): Promise<void> {
  prompter.spinnerStart('Checking the Resend API key…');
  try {
    let res: Response;
    try {
      res = await fetchImpl('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new SetupError(
        `Could not reach the Resend API (${describeError(error)}), so the key could not be verified. ` +
          'Fix: check your network connection and run `postwisp setup` again.',
      );
    }
    if (res.status === 401) {
      throw new SetupError(
        'Resend rejected the API key (HTTP 401). The key is wrong or revoked, and sending mail would fail. ' +
          'Fix: copy a fresh key from https://resend.com/api-keys and try again.',
      );
    }
    if (!res.ok) {
      throw new SetupError(
        `Resend returned HTTP ${res.status} while checking the API key, so it could not be verified. ` +
          'Fix: try again in a minute, or check https://status.resend.com/ for an outage.',
      );
    }
  } finally {
    prompter.spinnerStop();
  }
}

async function askBotToken(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps, config, nonInteractive } = ctx;
  if (config.botToken) {
    if (nonInteractive) {
      deps.out('Bot token: already configured, keeping.');
      return null;
    }
    if (!(await deps.prompter.confirm('A bot token is already saved. Enter a new one?', false))) {
      return null;
    }
  }
  if (nonInteractive) {
    const token = deps.env['POSTWISP_BOT_TOKEN'];
    if (!token) {
      throw new SetupError(
        'Bot token is missing. Fix: set POSTWISP_BOT_TOKEN to the token from @BotFather, then run `postwisp setup --yes` again.',
      );
    }
    await validateBotToken(deps, token);
    return { botToken: token };
  }
  for (;;) {
    const token = (await deps.prompter.password({ message: 'Bot token from @BotFather:' })).trim();
    if (!token) {
      deps.out('The token cannot be empty.');
      continue;
    }
    try {
      await validateBotToken(deps, token);
      return { botToken: token };
    } catch (error) {
      deps.out(error instanceof Error ? error.message : String(error));
      if (!(await deps.prompter.confirm('Try a different token?', true))) {
        throw new SetupError('Setup stopped with no working bot token. Re-run `postwisp setup` to continue.');
      }
    }
  }
}

// The pairing deep link: the bot consumes the token on a /start tap and
// writes ownerId to the config file itself. The wizard polls the file.
async function pairFlow(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps } = ctx;
  const config = loadConfig({}, deps.configPath);
  const botToken = config.botToken;
  if (!botToken) {
    // Unreachable: the bot-token step always runs first. Fail loudly rather
    // than printing a broken link.
    throw new SetupError('No bot token is saved, so no pairing link can be built. Re-run `postwisp setup` from the first step.');
  }
  const store = deps.openKvStore(config.dataDir);
  let username: string;
  deps.prompter.spinnerStart('Preparing the pairing link…');
  try {
    username = await fetchBotUsername(botToken, deps.fetchImpl);
  } catch (error) {
    throw new SetupError(
      `Could not build the pairing link: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    deps.prompter.spinnerStop();
  }
  const token = generatePairingToken();
  storePairingToken(store, token, deps.nowMs());
  deps.out('');
  deps.out('Pairing link (valid 15 minutes, single use):');
  deps.out('');
  deps.out(pairingLink(username, token));
  deps.out('');
  deps.out('1. Make sure the postwisp server is running, so the bot is online to receive your tap.');
  deps.out('2. Open the link and press Start in Telegram.');
  for (;;) {
    const next = await deps.prompter.select({
      message: 'Then choose:',
      options: [
        { value: 'check', label: 'I tapped Start — check now' },
        { value: 'manual', label: 'Enter Telegram user ID instead' },
        { value: 'skip', label: 'Skip for now' },
      ],
    });
    if (next === 'check') {
      const fresh = loadConfig({}, deps.configPath);
      if (fresh.ownerId !== null) {
        deps.out(`Paired. Owner ID ${fresh.ownerId} saved.`);
        return null;
      }
      deps.out(
        'Not paired yet — the tap has not reached the bot. Make sure the postwisp server is running and try again.',
      );
      continue;
    }
    if (next === 'manual') {
      const raw = await deps.prompter.text({
        message: 'Your Telegram user ID (from @userinfobot):',
        validate: validateOwnerIdText,
      });
      return { ownerId: parseOwnerIdInput(raw) };
    }
    deps.out(
      'Owner skipped. The bot ignores everyone until an owner is set — re-run `postwisp setup` to pair later.',
    );
    return null;
  }
}

async function askOwner(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps, config, nonInteractive } = ctx;
  if (config.ownerId !== null) {
    if (nonInteractive) {
      deps.out(`Owner ID: already set to ${config.ownerId}, keeping.`);
      return null;
    }
    if (!(await deps.prompter.confirm(`Owner ID is already ${config.ownerId}. Change it?`, false))) {
      return null;
    }
  }
  if (nonInteractive) {
    const raw = deps.env['POSTWISP_OWNER_ID'];
    if (!raw) {
      throw new SetupError(
        'Owner ID is missing. Fix: set POSTWISP_OWNER_ID to your Telegram user ID (get it from @userinfobot), then run `postwisp setup --yes` again. To pair from your phone instead, run `postwisp setup` without --yes.',
      );
    }
    return { ownerId: parseOwnerIdInput(raw) };
  }
  const choice = await deps.prompter.select({
    message: 'How should the bot recognize its owner?',
    options: [
      { value: 'pair', label: 'Pairing link', hint: 'open a Telegram link and tap Start (recommended)' },
      { value: 'manual', label: 'Enter Telegram user ID', hint: 'paste the numeric ID from @userinfobot' },
      { value: 'skip', label: 'Skip for now', hint: 'the bot ignores everyone until an owner is set' },
    ],
  });
  if (choice === 'manual') {
    const raw = await deps.prompter.text({
      message: 'Your Telegram user ID (from @userinfobot):',
      validate: validateOwnerIdText,
    });
    return { ownerId: parseOwnerIdInput(raw) };
  }
  if (choice === 'skip') {
    deps.out(
      'Owner skipped. The bot ignores everyone until an owner is set — re-run `postwisp setup` to pair later.',
    );
    return null;
  }
  return pairFlow(ctx);
}

const PROVIDER_LABELS: Record<EmailProviderName, string> = {
  resend: 'Resend',
  mailersend: 'MailerSend',
  mailgun: 'Mailgun',
};

const PROVIDER_KEY_FIELDS = {
  resend: 'resendApiKey',
  mailersend: 'mailersendApiKey',
  mailgun: 'mailgunApiKey',
} as const;

const PROVIDER_KEY_ENVS = {
  resend: 'POSTWISP_RESEND_API_KEY',
  mailersend: 'POSTWISP_MAILERSEND_API_KEY',
  mailgun: 'POSTWISP_MAILGUN_API_KEY',
} as const;

const PROVIDER_KEY_SOURCES: Record<EmailProviderName, string> = {
  resend: 'resend.com/api-keys',
  mailersend: 'app.mailersend.com (API tokens)',
  mailgun: 'app.mailgun.com (API keys)',
};

async function selectEmailProvider(ctx: StepContext): Promise<EmailProviderName> {
  const { deps, nonInteractive } = ctx;
  if (nonInteractive) {
    const raw = deps.env['POSTWISP_EMAIL_PROVIDER'];
    if (!raw) return 'resend';
    try {
      return parseEmailProvider(raw, 'env POSTWISP_EMAIL_PROVIDER');
    } catch {
      throw new SetupError(
        `Invalid POSTWISP_EMAIL_PROVIDER "${raw}". Fix: set it to resend, mailersend, or mailgun, then run \`postwisp setup --yes\` again.`,
      );
    }
  }
  const choice = await deps.prompter.select({
    message: 'Which email provider should postwisp use?',
    options: [
      { value: 'resend', label: 'Resend', hint: 'recommended' },
      { value: 'mailersend', label: 'MailerSend' },
      { value: 'mailgun', label: 'Mailgun' },
    ],
  });
  try {
    return parseEmailProvider(choice, 'email provider selection');
  } catch {
    throw new SetupError(
      `Unknown email provider "${choice}". Fix: re-run \`postwisp setup\` and pick resend, mailersend, or mailgun.`,
    );
  }
}

// Returns the new key, or null when the already-saved key is kept.
async function askProviderApiKey(
  ctx: StepContext,
  provider: EmailProviderName,
): Promise<string | null> {
  const { deps, config, nonInteractive } = ctx;
  const label = PROVIDER_LABELS[provider];
  const existing = config[PROVIDER_KEY_FIELDS[provider]];
  if (existing) {
    if (nonInteractive) {
      deps.out(`${label} API key: already configured, keeping.`);
      return null;
    }
    if (!(await deps.prompter.confirm(`A ${label} API key is already saved. Enter a new one?`, false))) {
      return null;
    }
  }
  if (nonInteractive) {
    const key = deps.env[PROVIDER_KEY_ENVS[provider]];
    if (!key) {
      throw new SetupError(
        `${label} API key is missing. Fix: set ${PROVIDER_KEY_ENVS[provider]} to a key from ${PROVIDER_KEY_SOURCES[provider]}, then run \`postwisp setup --yes\` again.`,
      );
    }
    if (provider === 'resend') {
      await validateResendKey(key, deps.fetchImpl, deps.prompter);
    }
    return key;
  }
  for (;;) {
    const key = (
      await deps.prompter.password({ message: `${label} API key (from ${PROVIDER_KEY_SOURCES[provider]}):` })
    ).trim();
    if (!key) {
      deps.out('The API key cannot be empty.');
      continue;
    }
    if (provider !== 'resend') {
      // No cheap live probe exists for these providers without a key, and
      // a wrong key fails loudly at the first send; do not block setup on
      // a probe that would only burn the operator's time.
      return key;
    }
    try {
      await validateResendKey(key, deps.fetchImpl, deps.prompter);
      return key;
    } catch (error) {
      deps.out(error instanceof Error ? error.message : String(error));
      if (!(await deps.prompter.confirm('Try a different key?', true))) {
        throw new SetupError(
          'Setup stopped with no working Resend API key. Re-run `postwisp setup` to continue.',
        );
      }
    }
  }
}

// Where each provider publishes the secret it signs webhooks with. The
// secret is always issued by the provider's dashboard: a locally generated
// value could never verify a real webhook, so the wizard never offers to
// generate one — it asks the operator to paste the provider-issued secret.
const PROVIDER_SECRET_SOURCES: Record<EmailProviderName, string> = {
  resend: 'Resend dashboard → Webhooks → your webhook → Signing Secret (starts with whsec_)',
  mailersend: 'MailerSend dashboard → Webhooks → your webhook → Signing secret',
  mailgun: 'Mailgun dashboard → Settings → Security → HTTP webhook signing key',
};

async function askWebhookSecret(ctx: StepContext, provider: EmailProviderName): Promise<string> {
  const { deps, nonInteractive } = ctx;
  if (nonInteractive) {
    const fromEnv = deps.env['POSTWISP_WEBHOOK_SECRET'];
    if (!fromEnv) {
      throw new SetupError(
        'Webhook signing secret is missing. Fix: copy the signing secret from ' +
          `${PROVIDER_SECRET_SOURCES[provider]}, set POSTWISP_WEBHOOK_SECRET to it, then run ` +
          '`postwisp setup --yes` again. Without the provider-issued secret, inbound webhooks are rejected.',
      );
    }
    return fromEnv;
  }
  deps.out(
    `Paste the signing secret ${PROVIDER_LABELS[provider]} uses to sign webhooks ` +
      `(${PROVIDER_SECRET_SOURCES[provider]}).`,
  );
  for (;;) {
    const pasted = (await deps.prompter.password({ message: 'Webhook signing secret:' })).trim();
    if (pasted) return pasted;
    deps.out('The signing secret cannot be empty — without it, inbound webhooks are rejected.');
  }
}

async function askEmailProvider(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { config } = ctx;
  const provider = await selectEmailProvider(ctx);
  const delta: Partial<PostwispConfig> = {};
  const providerChanged = config.emailProvider !== provider;
  if (providerChanged) {
    delta.emailProvider = provider;
  }
  const key = await askProviderApiKey(ctx, provider);
  if (key !== null) {
    delta[PROVIDER_KEY_FIELDS[provider]] = key;
  }
  // A signing secret is issued by exactly one provider. On a provider
  // switch the saved secret is the old provider's, so keeping it rejects
  // every inbound webhook with 401 — always re-ask, even when the API key
  // itself was kept and askProviderApiKey returned early above.
  if (key !== null || providerChanged) {
    delta.webhookSecret = await askWebhookSecret(ctx, provider);
  }
  return Object.keys(delta).length > 0 ? delta : null;
}

async function askDomains(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps, config, nonInteractive } = ctx;
  if (config.domains.length > 0) {
    if (nonInteractive) {
      deps.out(`Domains: already set to ${config.domains.join(', ')}, keeping.`);
      return null;
    }
    if (
      !(await deps.prompter.confirm(`Domains are already ${config.domains.join(', ')}. Change them?`, false))
    ) {
      return null;
    }
  }
  if (nonInteractive) {
    const raw = deps.env['POSTWISP_DOMAINS'];
    if (!raw) {
      throw new SetupError(
        'Domains are missing. Fix: set POSTWISP_DOMAINS to a comma-separated list (e.g. POSTWISP_DOMAINS=mail.example.com), then run `postwisp setup --yes` again.',
      );
    }
    return { domains: parseDomains(raw) };
  }
  const raw = await deps.prompter.text({
    message: 'Domains for inbound mail, comma-separated (leave empty to skip):',
    placeholder: 'mail.example.com',
    validate: (v) => {
      if (!v.trim()) return undefined;
      try {
        parseDomains(v);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (!raw.trim()) {
    deps.out('No domains saved. Inbound mail stays disabled — re-run `postwisp setup` to add one later.');
    return null;
  }
  return { domains: parseDomains(raw) };
}

// Optional compliance details: the physical address bulk-mail footers
// should carry, the abuse contact shown in the README, and the public URL
// the one-click unsubscribe links point at. All skippable.
async function askCompliance(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps, config, nonInteractive } = ctx;
  const delta: Partial<PostwispConfig> = {};
  const ask = async (
    key: 'physicalAddress' | 'abuseContact' | 'publicUrl',
    envKey: string,
    label: string,
    message: string,
    placeholder: string,
  ): Promise<void> => {
    if (nonInteractive) {
      const raw = deps.env[envKey]?.trim();
      if (raw) Object.assign(delta, parseConfigValue(key, raw));
      return;
    }
    if (config[key]) {
      deps.out(`${label}: already set, keeping.`);
      return;
    }
    const raw = (await deps.prompter.text({ message, placeholder })).trim();
    if (!raw) {
      deps.out(`${label}: skipped — set it later with \`postwisp config set ${key} ...\`.`);
      return;
    }
    try {
      Object.assign(delta, parseConfigValue(key, raw));
    } catch (error) {
      throw new SetupError(
        `${describeError(error)} Fix: re-run \`postwisp setup\` and enter a valid value, or skip it with an empty answer.`,
      );
    }
  };
  deps.out('Compliance details (all optional — press Enter to skip):');
  await ask(
    'physicalAddress',
    'POSTWISP_PHYSICAL_ADDRESS',
    'Physical address',
    'Physical mailing address for the unsubscribe footer:',
    '123 Main St, Vancouver BC, Canada',
  );
  await ask(
    'abuseContact',
    'POSTWISP_ABUSE_CONTACT',
    'Abuse contact',
    'Abuse contact email (shown in the README):',
    'abuse@example.com',
  );
  await ask(
    'publicUrl',
    'POSTWISP_PUBLIC_URL',
    'Public URL',
    'Public base URL of this instance (for unsubscribe links):',
    'https://mail.example.com',
  );
  return Object.keys(delta).length > 0 ? delta : null;
}

async function askCloudflare(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps, config, nonInteractive } = ctx;
  if (config.cloudflareIngestSecret) {
    if (nonInteractive) {
      deps.out('Cloudflare ingest secret: already configured, keeping.');
      return null;
    }
    if (
      !(await deps.prompter.confirm('A Cloudflare ingest secret is already saved. Change it?', false))
    ) {
      return null;
    }
  }
  if (nonInteractive) {
    const secret = deps.env['POSTWISP_CF_INGEST_SECRET'];
    if (!secret) {
      deps.out('Cloudflare ingest secret: not provided, skipping (optional).');
      return null;
    }
    // The wizard generates 64-char secrets; anything much shorter is not a
    // real shared secret. Reject it loudly instead of deploying a weak one.
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new SetupError(
        `POSTWISP_CF_INGEST_SECRET is too short (${secret.length} characters, minimum ${MIN_SECRET_LENGTH}). ` +
          'Fix: set it to a long random value (e.g. the output of `openssl rand -hex 32`), then run `postwisp setup --yes` again.',
      );
    }
    return { cloudflareIngestSecret: secret };
  }
  if (
    !(await deps.prompter.confirm(
      'Set a Cloudflare Email Worker ingest secret? (Only needed if you use the Cloudflare worker for inbound mail.)',
      false,
    ))
  ) {
    return null;
  }
  const choice = await deps.prompter.select({
    message: 'Ingest secret:',
    options: [
      { value: 'generate', label: 'Generate a random one', hint: 'recommended' },
      { value: 'paste', label: 'Paste an existing secret' },
    ],
  });
  if (choice === 'generate') return { cloudflareIngestSecret: randomBytes(32).toString('hex') };
  const pasted = (await deps.prompter.password({ message: 'Ingest secret:' })).trim();
  if (!pasted) {
    deps.out('Empty secret — skipping.');
    return null;
  }
  return { cloudflareIngestSecret: pasted };
}

// Builds the configured provider for the e2e step, threading the setup's
// injectable fetch through so tests stay off the network.
function createTestEmailProvider(
  name: EmailProviderName,
  apiKey: string,
  fetchImpl: FetchImpl,
): EmailProvider {
  const fetchFn = fetchImpl as typeof fetch;
  switch (name) {
    case 'mailersend':
      return new MailerSendProvider({ apiKey, fetchFn });
    case 'mailgun':
      return new MailgunProvider({ apiKey, fetchFn });
    default:
      return new ResendEmailProvider({ apiKey, fetchFn });
  }
}

// Sends a real test email through the configured provider. Injectable
// fetch keeps tests off the network; in production this is the point of
// the step.
export async function sendTestEmail(
  deps: SetupDeps,
  args: { provider: EmailProvider; providerLabel: string; fromDomain: string; to: string },
): Promise<void> {
  deps.prompter.spinnerStart(`Sending a test email to ${args.to}…`);
  try {
    try {
      await args.provider.send({
        from: `postwisp@${args.fromDomain}`,
        to: [args.to],
        subject: 'postwisp setup test',
        text: 'This is a test email from your postwisp setup. If you received it, outbound mail works.',
      });
    } catch (error) {
      throw new SetupError(
        `Could not send the test email through ${args.providerLabel} (${describeError(error)}). Your settings are saved; the mail itself was not sent. ` +
          `Fix: check your network connection and that the sending domain is verified with ${args.providerLabel}, then re-run \`postwisp setup\` to retry the test.`,
      );
    }
    deps.out(`Test email sent to ${args.to}. If it arrives, outbound mail works.`);
  } finally {
    deps.prompter.spinnerStop();
  }
}

function validateEmailText(value: string): string | undefined {
  return value.includes('@') ? undefined : 'Enter a valid email address.';
}

async function askE2e(ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  const { deps, config, nonInteractive } = ctx;
  const providerName = config.emailProvider;
  const providerLabel = PROVIDER_LABELS[providerName];
  const apiKey = config[PROVIDER_KEY_FIELDS[providerName]];
  const domain = config.domains[0];
  if (!apiKey || !domain) {
    deps.out(
      `Skipping the test email: it needs a ${providerLabel} API key and at least one domain.`,
    );
    return null;
  }
  const provider = createTestEmailProvider(providerName, apiKey, deps.fetchImpl);
  if (nonInteractive) {
    const to = deps.env['POSTWISP_TEST_EMAIL'];
    if (!to) {
      deps.out(
        'Test email skipped: set POSTWISP_TEST_EMAIL to an address you can read, then re-run `postwisp setup --yes` to send it.',
      );
      return null;
    }
    await sendTestEmail(deps, { provider, providerLabel, fromDomain: domain, to: to.trim() });
    return null;
  }
  if (!(await deps.prompter.confirm('Send a test email now to verify outbound mail works?', true))) {
    deps.out('Test email skipped. Re-run `postwisp setup` any time to send it.');
    return null;
  }
  const to = (
    await deps.prompter.text({
      message: 'Email address that should receive the test:',
      validate: validateEmailText,
    })
  ).trim();
  await sendTestEmail(deps, { provider, providerLabel, fromDomain: domain, to });
  return null;
}

async function runStep(step: SetupStepName, ctx: StepContext): Promise<Partial<PostwispConfig> | null> {
  switch (step) {
    case 'bot-token':
      return askBotToken(ctx);
    case 'owner':
      return askOwner(ctx);
    case 'provider':
      return askEmailProvider(ctx);
    case 'domains':
      return askDomains(ctx);
    case 'compliance':
      return askCompliance(ctx);
    case 'cloudflare':
      return askCloudflare(ctx);
    case 'e2e':
      return askE2e(ctx);
  }
}

export async function runSetup(deps: SetupDeps, opts: { yes?: boolean } = {}): Promise<void> {
  const nonInteractive = opts.yes ?? false;
  if (!nonInteractive && !deps.isTTY) {
    throw new SetupError(
      'Setup needs an interactive terminal, but this is not one, so there is nothing to answer the prompts with. ' +
        'Fix: run `postwisp setup --yes` with POSTWISP_BOT_TOKEN, POSTWISP_OWNER_ID, POSTWISP_RESEND_API_KEY and POSTWISP_DOMAINS in the environment.',
    );
  }
  if (!nonInteractive) intro('postwisp setup');
  const readConfig = (): PostwispConfig => loadConfig({}, deps.configPath);
  const config = readConfig();
  if (config.setupStep !== null && !isSetupStep(config.setupStep)) {
    throw new SetupError(
      `Unknown setup step "${config.setupStep}" in the config file at ${deps.configPath}. The file was probably edited by hand. ` +
        'Fix: delete the "setupStep" line from the file and run `postwisp setup` again.',
    );
  }
  let startIndex = 0;
  if (config.setupStep === 'done') {
    if (nonInteractive) {
      deps.out('Setup is already complete. Nothing to do.');
      return;
    }
    const redo = await deps.prompter.select({
      message: 'Setup is already complete. Redo a step?',
      options: [
        ...SETUP_STEPS.map((s) => ({ value: s as string, label: `Redo: ${s}` })),
        { value: 'leave', label: 'Leave everything as is' },
      ],
    });
    if (redo === 'leave') {
      deps.out('Nothing changed.');
      return;
    }
    startIndex = SETUP_STEPS.indexOf(redo as SetupStepName);
  } else if (config.setupStep !== null) {
    // Pre-P5 builds persisted this step as 'resend'.
    const persisted =
      (config.setupStep as string) === 'resend' ? 'provider' : config.setupStep;
    startIndex = SETUP_STEPS.indexOf(persisted as SetupStepName);
    if (startIndex > 0) deps.out(`Resuming setup at step "${persisted}".`);
  }
  for (let k = startIndex; k < SETUP_STEPS.length; k++) {
    const step = SETUP_STEPS[k] as SetupStepName;
    const current = readConfig();
    const delta = await runStep(step, { deps, config: current, nonInteractive });
    if (delta && Object.keys(delta).length > 0) {
      saveAndReport(deps, current, delta);
    }
    const nextStep: SetupStep =
      k + 1 < SETUP_STEPS.length ? (SETUP_STEPS[k + 1] as SetupStepName) : 'done';
    saveConfigFile({ setupStep: nextStep }, deps.configPath);
  }
  if (!nonInteractive) outro('Setup complete. Start the postwisp server, then open your bot in Telegram.');
  else deps.out('Setup complete.');
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('Guided first-time setup: bot token, owner pairing, Resend, domains, live test email')
    .option(
      '--yes',
      'non-interactive: read values from POSTWISP_BOT_TOKEN, POSTWISP_OWNER_ID, POSTWISP_RESEND_API_KEY, POSTWISP_DOMAINS, POSTWISP_WEBHOOK_SECRET (POSTWISP_EMAIL_PROVIDER, POSTWISP_MAILERSEND_API_KEY, POSTWISP_MAILGUN_API_KEY, POSTWISP_CF_INGEST_SECRET, POSTWISP_TEST_EMAIL optional)',
    )
    .action(async (opts: { yes?: boolean }) => {
      const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
      await runSetup(
        {
          fetchImpl: fetch,
          nowMs: Date.now,
          isTTY,
          configPath: configFilePath(),
          prompter: clackPrompter(isTTY),
          out: (line) => console.log(line),
          openKvStore: (dataDir) => openStore(join(dataDir, 'postwisp.db')),
          env: process.env,
        },
        { yes: opts.yes ?? false },
      );
    });
}
