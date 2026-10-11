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

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  displayConfigValue,
  isSecretConfigKey,
  loadConfig,
  parseConfigValue,
  readConfigFile,
  redactedConfig,
  saveConfigFile,
} from '../src/core/config.js';

const ENV_KEYS = [
  'POSTWISP_OWNER_ID',
  'POSTWISP_BOT_TOKEN',
  'POSTWISP_DATA_DIR',
  'POSTWISP_LOG_LEVEL',
  'POSTWISP_SERVER_PORT',
  'POSTWISP_SERVER_HOST',
  'POSTWISP_WEBHOOK_SECRET',
  'POSTWISP_RESEND_API_KEY',
  'POSTWISP_EMAIL_PROVIDER',
  'POSTWISP_MAILERSEND_API_KEY',
  'POSTWISP_MAILGUN_API_KEY',
  'POSTWISP_CF_INGEST_SECRET',
  'POSTWISP_DOMAINS',
  'POSTWISP_PHYSICAL_ADDRESS',
  'POSTWISP_ABUSE_CONTACT',
  'POSTWISP_PUBLIC_URL',
];

const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'postwisp-config-'));
  return join(dir, 'config.json');
}

describe('defaultConfig', () => {
  it('returns safe defaults with no secrets', () => {
    const c = defaultConfig();
    expect(c.ownerId).toBeNull();
    expect(c.botToken).toBeNull();
    expect(c.logLevel).toBe('info');
    expect(c.serverPort).toBe(3000);
    expect(c.serverHost).toBe('127.0.0.1');
    expect(c.domains).toEqual([]);
  });
});

describe('loadConfig priority', () => {
  it('flags beat env, env beats file, file beats defaults', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ serverPort: 1111, logLevel: 'debug' }));
    process.env['POSTWISP_SERVER_PORT'] = '2222';
    const c = loadConfig({ serverPort: 3333, logLevel: 'warn' }, file);
    expect(c.serverPort).toBe(3333);
    expect(c.logLevel).toBe('warn');
  });

  it('env beats file when no flags given', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ serverPort: 1111 }));
    process.env['POSTWISP_SERVER_PORT'] = '2222';
    expect(loadConfig({}, file).serverPort).toBe(2222);
  });

  it('file beats defaults', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ serverHost: '0.0.0.0' }));
    expect(loadConfig({}, file).serverHost).toBe('0.0.0.0');
  });

  it('missing file falls back to defaults', () => {
    expect(loadConfig({}, tempConfigPath()).serverPort).toBe(3000);
  });

  it('parses POSTWISP_DOMAINS as a comma-separated list', () => {
    process.env['POSTWISP_DOMAINS'] = 'a.example, b.example ';
    expect(loadConfig({}, tempConfigPath()).domains).toEqual(['a.example', 'b.example']);
  });

  it('rejects an invalid port instead of silently using it', () => {
    process.env['POSTWISP_SERVER_PORT'] = '99999';
    expect(() => loadConfig({}, tempConfigPath())).toThrow(ConfigError);
  });

  it('rejects an invalid log level instead of silently using it', () => {
    process.env['POSTWISP_LOG_LEVEL'] = 'verbose';
    expect(() => loadConfig({}, tempConfigPath())).toThrow(ConfigError);
  });
});

describe('email provider config', () => {
  it('defaults to resend with no provider keys', () => {
    const c = defaultConfig();
    expect(c.emailProvider).toBe('resend');
    expect(c.mailersendApiKey).toBeNull();
    expect(c.mailgunApiKey).toBeNull();
  });

  it('reads the provider and keys from the environment', () => {
    process.env['POSTWISP_EMAIL_PROVIDER'] = 'mailgun';
    process.env['POSTWISP_MAILGUN_API_KEY'] = 'mg_key';
    const c = loadConfig({}, tempConfigPath());
    expect(c.emailProvider).toBe('mailgun');
    expect(c.mailgunApiKey).toBe('mg_key');
    expect(c.mailersendApiKey).toBeNull();
  });

  it('rejects an unknown provider instead of silently using it', () => {
    process.env['POSTWISP_EMAIL_PROVIDER'] = 'sendgrid';
    expect(() => loadConfig({}, tempConfigPath())).toThrow(/invalid email provider/);
  });

  it('reads the provider and keys from the config file', () => {
    const file = tempConfigPath();
    writeFileSync(
      file,
      JSON.stringify({ emailProvider: 'mailersend', mailersendApiKey: 'ms_key' }),
    );
    const c = loadConfig({}, file);
    expect(c.emailProvider).toBe('mailersend');
    expect(c.mailersendApiKey).toBe('ms_key');
  });

  it('rejects an unknown provider in the config file', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ emailProvider: 'sendgrid' }));
    expect(() => loadConfig({}, file)).toThrow(/invalid email provider/);
  });

  it('redacts the new provider keys', () => {
    const c = {
      ...defaultConfig(),
      mailersendApiKey: 'ms_secret',
      mailgunApiKey: 'mg_secret',
    };
    const redacted = JSON.stringify(redactedConfig(c));
    expect(redacted).not.toContain('ms_secret');
    expect(redacted).not.toContain('mg_secret');
    expect(redactedConfig(c).mailersendApiKey).toBe('[redacted]');
    expect(redactedConfig(c).mailgunApiKey).toBe('[redacted]');
  });
});

describe('readConfigFile', () => {
  it('throws a clear error on malformed JSON', () => {
    const file = tempConfigPath();
    writeFileSync(file, '{not json');
    expect(() => readConfigFile(file)).toThrow(/not valid JSON/);
  });

  it('throws a clear error on a non-object document', () => {
    const file = tempConfigPath();
    writeFileSync(file, '[1,2,3]');
    expect(() => readConfigFile(file)).toThrow(/expected a JSON object/);
  });

  it('rejects a wrong-typed owner id in the file', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ ownerId: 'abc' }));
    expect(() => readConfigFile(file)).toThrow(ConfigError);
  });

  it('rejects an invalid log level in the file', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ logLevel: 'verbose' }));
    expect(() => readConfigFile(file)).toThrow(ConfigError);
  });

  it('rejects a non-string secret in the file', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ botToken: 42 }));
    expect(() => readConfigFile(file)).toThrow(ConfigError);
  });

  it('rejects a non-string domains array in the file', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ domains: ['a.com', 7] }));
    expect(() => readConfigFile(file)).toThrow(ConfigError);
  });

  it('accepts valid typed values from the file', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ ownerId: 42, domains: ['a.com'], logLevel: 'debug' }));
    const c = readConfigFile(file);
    expect(c.ownerId).toBe(42);
    expect(c.domains).toEqual(['a.com']);
    expect(c.logLevel).toBe('debug');
  });
});

describe('saveConfigFile', () => {
  it('creates the file with 0600 permissions', () => {
    const file = tempConfigPath();
    saveConfigFile({ botToken: 'secret-token' }, file);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).botToken).toBe('secret-token');
  });

  it('merges with existing values instead of wiping them', () => {
    const file = tempConfigPath();
    saveConfigFile({ serverPort: 4444 }, file);
    saveConfigFile({ logLevel: 'error' }, file);
    const c = loadConfig({}, file);
    expect(c.serverPort).toBe(4444);
    expect(c.logLevel).toBe('error');
  });
});

describe('cloudflare ingest secret round-trip', () => {
  it('writes camelCase via config set and reads it back', () => {
    const file = tempConfigPath();
    saveConfigFile({ cloudflareIngestSecret: 'cf-secret' }, file);
    expect(readConfigFile(file).cloudflareIngestSecret).toBe('cf-secret');
    expect(loadConfig({}, file).cloudflareIngestSecret).toBe('cf-secret');
  });

  it('still reads the legacy snake_case key', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ cloudflare_ingest_secret: 'legacy-secret' }));
    expect(readConfigFile(file).cloudflareIngestSecret).toBe('legacy-secret');
  });

  it('prefers camelCase when both spellings are present', () => {
    const file = tempConfigPath();
    writeFileSync(
      file,
      JSON.stringify({ cloudflare_ingest_secret: 'old', cloudflareIngestSecret: 'new' }),
    );
    expect(readConfigFile(file).cloudflareIngestSecret).toBe('new');
  });

  it('replaces the stale snake_case twin on the next write', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ cloudflare_ingest_secret: 'legacy-secret' }));
    saveConfigFile({ serverPort: 4444 }, file);
    // Untouched key: the legacy spelling still reads back.
    expect(readConfigFile(file).cloudflareIngestSecret).toBe('legacy-secret');
    saveConfigFile({ cloudflareIngestSecret: 'new-secret' }, file);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw['cloudflareIngestSecret']).toBe('new-secret');
    expect(raw['cloudflare_ingest_secret']).toBeUndefined();
    expect(readConfigFile(file).cloudflareIngestSecret).toBe('new-secret');
  });

  it('preserves unrecognized keys across writes', () => {
    const file = tempConfigPath();
    writeFileSync(file, JSON.stringify({ ownerId: 7, future_key: 'keep me', nested: { a: 1 } }));
    saveConfigFile({ serverPort: 4444 }, file);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw['future_key']).toBe('keep me');
    expect(raw['nested']).toEqual({ a: 1 });
    expect(raw['serverPort']).toBe(4444);
    expect(readConfigFile(file).ownerId).toBe(7);
  });
});

describe('redactedConfig', () => {
  it('never exposes secret values', () => {
    const c = { ...defaultConfig(), botToken: 't', webhookSecret: 'w', resendApiKey: 'r' };
    const redacted = JSON.stringify(redactedConfig(c));
    expect(redacted).not.toContain('"t"');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('[redacted]');
  });
});

describe('compliance config keys', () => {
  it('defaults the new keys to null', () => {
    const c = defaultConfig();
    expect(c.physicalAddress).toBeNull();
    expect(c.abuseContact).toBeNull();
    expect(c.publicUrl).toBeNull();
  });

  it('reads the new keys from env and the file', () => {
    process.env['POSTWISP_PHYSICAL_ADDRESS'] = '123 Main St';
    process.env['POSTWISP_ABUSE_CONTACT'] = 'abuse@example.com';
    process.env['POSTWISP_PUBLIC_URL'] = 'https://mail.example.com';
    const c = loadConfig({}, tempConfigPath());
    expect(c.physicalAddress).toBe('123 Main St');
    expect(c.abuseContact).toBe('abuse@example.com');
    expect(c.publicUrl).toBe('https://mail.example.com');
  });

  it('rejects a public URL with a path, query, or fragment', () => {
    for (const bad of [
      'https://mail.example.com/some/path',
      'https://mail.example.com?x=1',
      'https://mail.example.com#frag',
    ]) {
      process.env['POSTWISP_PUBLIC_URL'] = bad;
      expect(() => loadConfig({}, tempConfigPath())).toThrow(ConfigError);
      expect(() => parseConfigValue('publicUrl', bad)).toThrow(ConfigError);
    }
  });

  it('rejects a non-http public URL', () => {
    process.env['POSTWISP_PUBLIC_URL'] = 'ftp://mail.example.com';
    expect(() => loadConfig({}, tempConfigPath())).toThrow(ConfigError);
  });

  it('parseConfigValue validates the new keys', () => {
    expect(parseConfigValue('physicalAddress', '123 Main St')).toEqual({ physicalAddress: '123 Main St' });
    expect(parseConfigValue('physicalAddress', '')).toEqual({ physicalAddress: null });
    expect(parseConfigValue('abuseContact', 'abuse@example.com')).toEqual({ abuseContact: 'abuse@example.com' });
    expect(() => parseConfigValue('abuseContact', 'not-an-email')).toThrow(ConfigError);
    expect(parseConfigValue('publicUrl', 'https://mail.example.com')).toEqual({
      publicUrl: 'https://mail.example.com',
    });
    expect(() => parseConfigValue('publicUrl', 'not a url')).toThrow(ConfigError);
  });

  it('parseConfigValue enforces a minimum webhook secret length', () => {
    // The secret doubles as the unsubscribe HMAC key.
    expect(() => parseConfigValue('webhookSecret', 'short')).toThrow(ConfigError);
    expect(() => parseConfigValue('webhookSecret', 'a'.repeat(15))).toThrow(ConfigError);
    expect(parseConfigValue('webhookSecret', 'a'.repeat(16))).toEqual({
      webhookSecret: 'a'.repeat(16),
    });
    expect(parseConfigValue('webhookSecret', '')).toEqual({ webhookSecret: null });
  });

  it('does not treat the new keys as secrets', () => {
    expect(isSecretConfigKey('physicalAddress')).toBe(false);
    expect(isSecretConfigKey('abuseContact')).toBe(false);
    expect(isSecretConfigKey('publicUrl')).toBe(false);
    expect(displayConfigValue('abuseContact', 'abuse@example.com')).toBe('abuse@example.com');
  });
});
