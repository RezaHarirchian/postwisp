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

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  isSecretConfigKey,
  loadConfig,
  parseConfigValue,
  readConfigFile,
} from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import {
  collectSecretValues,
  parseTail,
  redactLine,
  showLogs,
} from '../src/cli/commands/logs.js';
import {
  printAllConfig,
  printConfigValue,
  setConfigValue,
  type ConfigCmdDeps,
} from '../src/cli/commands/config.js';

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'postwisp-cli43-test-'));
  tmpDirs.push(dir);
  return dir;
}

function depsWith(cfgPath: string): { deps: ConfigCmdDeps; out: string[] } {
  const out: string[] = [];
  return { deps: { configPath: cfgPath, out: (l) => out.push(l) }, out };
}

describe('showLogs', () => {
  it('tails the file and redacts secret values', () => {
    const dir = tmpDir();
    const logFile = join(dir, 'postwisp.log');
    const secret = 're_secret-value-123';
    writeFileSync(
      logFile,
      ['{"msg":"start"}', `{"msg":"key=${secret} sent"}`, '{"msg":"end"}', ''].join('\n'),
    );
    const out: string[] = [];
    showLogs(
      {
        config: { ...defaultConfig(), logFile, resendApiKey: secret },
        readFile: (p) => readFileSync(p, 'utf8'),
        out: (l) => out.push(l),
      },
      50,
    );
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('[redacted]');
    expect(out.join('\n')).not.toContain(secret);
  });

  it('shows only the last N lines', () => {
    const dir = tmpDir();
    const logFile = join(dir, 'postwisp.log');
    writeFileSync(logFile, ['one', 'two', 'three', ''].join('\n'));
    const out: string[] = [];
    showLogs(
      {
        config: { ...defaultConfig(), logFile },
        readFile: (p) => readFileSync(p, 'utf8'),
        out: (l) => out.push(l),
      },
      2,
    );
    expect(out).toEqual(['two', 'three']);
  });

  it('without a logFile prints where logs go and the exact set command', () => {
    const out: string[] = [];
    showLogs(
      { config: defaultConfig(), readFile: (p) => readFileSync(p, 'utf8'), out: (l) => out.push(l) },
      50,
    );
    const text = out.join('\n');
    expect(text).toContain('stdout');
    expect(text).toContain('postwisp config set logFile');
  });

  it('fails with a fix when the file cannot be read', () => {
    const out: string[] = [];
    expect(() =>
      showLogs(
        {
          config: { ...defaultConfig(), logFile: '/nonexistent/postwisp.log' },
          readFile: (p) => readFileSync(p, 'utf8'),
          out: (l) => out.push(l),
        },
        50,
      ),
    ).toThrowError(/postwisp config get logFile/);
  });

  it('parseTail rejects non-positive values with a fix', () => {
    expect(parseTail('50')).toBe(50);
    expect(parseTail(undefined)).toBe(50);
    expect(() => parseTail('0')).toThrowError(/postwisp logs --tail 100/);
    expect(() => parseTail('abc')).toThrowError(/positive integer/);
  });

  it('collectSecretValues redacts short secrets too', () => {
    const values = collectSecretValues({ ...defaultConfig(), botToken: 'short', resendApiKey: 'long-enough-secret' });
    expect(values).toEqual(['short', 'long-enough-secret']);
    expect(redactLine('has short inside', values)).toBe('has [redacted] inside');
    expect(redactLine('has long-enough-secret inside', values)).toBe('has [redacted] inside');
  });

  it('collectSecretValues covers every provider API key', () => {
    const values = collectSecretValues({
      ...defaultConfig(),
      resendApiKey: 're_12345678',
      mailersendApiKey: 'mlsn_12345678',
      mailgunApiKey: 'key-12345678',
    });
    expect(values).toEqual(['re_12345678', 'mlsn_12345678', 'key-12345678']);
    expect(redactLine('saw mlsn_12345678 in output', values)).toBe('saw [redacted] in output');
  });
});

describe('logger file appender', () => {
  const devNull = { write: () => true } as unknown as NodeJS.WritableStream;

  it('appends JSON lines to the file with owner-only permissions', () => {
    const filePath = join(tmpDir(), 'nested', 'app.log');
    const logger = createLogger({ stream: devNull, filePath });
    logger.info('hello file');
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('"msg":"hello file"');
    expect(content.trim().split('\n')).toHaveLength(1);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('child loggers keep writing to the file', () => {
    const filePath = join(tmpDir(), 'app.log');
    const logger = createLogger({ stream: devNull, filePath });
    logger.child({ component: 'bot' }).warn('child line');
    expect(readFileSync(filePath, 'utf8')).toContain('"msg":"child line"');
  });

  it('works unchanged without a filePath', () => {
    const logger = createLogger({ stream: devNull });
    expect(() => logger.info('no file')).not.toThrow();
  });
});

describe('config command', () => {
  it('prints all keys with secrets redacted', () => {
    const dir = tmpDir();
    const cfgPath = join(dir, 'config.json');
    const writer = depsWith(cfgPath).deps;
    setConfigValue(writer, 'botToken', 'tok-secret-value');
    setConfigValue(writer, 'serverPort', '8080');
    const { deps, out } = depsWith(cfgPath);
    printAllConfig(deps);
    const text = out.join('\n');
    expect(text).toContain('botToken: [redacted]');
    expect(text).toContain('serverPort: 8080');
    expect(text).toContain('logFile: (not set)');
    expect(text).not.toContain('tok-secret-value');
  });

  it('get prints one value; secrets stay redacted; unknown keys name the valid ones', () => {
    const dir = tmpDir();
    const cfgPath = join(dir, 'config.json');
    const { deps } = depsWith(cfgPath);
    setConfigValue(deps, 'serverPort', '8080');
    setConfigValue(deps, 'resendApiKey', 're_secret');

    const { deps: d2, out: out2 } = depsWith(cfgPath);
    printConfigValue(d2, 'serverPort');
    expect(out2).toEqual(['8080']);

    const { deps: d3, out: out3 } = depsWith(cfgPath);
    printConfigValue(d3, 'resendApiKey');
    expect(out3).toEqual(['[redacted]']);

    const { deps: d4 } = depsWith(cfgPath);
    expect(() => printConfigValue(d4, 'bogus')).toThrowError(/Valid keys/);
  });

  it('set writes 0600, reports the change, and never echoes secrets', () => {
    const dir = tmpDir();
    const cfgPath = join(dir, 'config.json');
    const { deps, out } = depsWith(cfgPath);
    setConfigValue(deps, 'botToken', 'tok-secret-value');
    expect(readConfigFile(cfgPath).botToken).toBe('tok-secret-value');
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const text = out.join('\n');
    expect(text).toContain('botToken: [redacted] (set)');
    expect(text).not.toContain('tok-secret-value');

    const { deps: d2, out: out2 } = depsWith(cfgPath);
    setConfigValue(d2, 'botToken', 'tok-secret-value-2');
    expect(out2.join('\n')).toContain('(updated)');

    // Empty clears a nullable key.
    const { deps: d3, out: out3 } = depsWith(cfgPath);
    setConfigValue(d3, 'botToken', '');
    expect(loadConfig({}, cfgPath).botToken).toBeNull();
    expect(out3.join('\n')).toContain('(cleared)');
  });

  it('set validates values with the config rules', () => {
    const dir = tmpDir();
    const cfgPath = join(dir, 'config.json');
    const { deps } = depsWith(cfgPath);
    expect(() => setConfigValue(deps, 'serverPort', '99999')).toThrowError(/1-65535/);
    expect(() => setConfigValue(deps, 'logLevel', 'verbose')).toThrowError(/debug, info, warn, error/);
    expect(() => setConfigValue(deps, 'ownerId', '-3')).toThrowError(/positive integer/);
    expect(() => setConfigValue(deps, 'domains', 'not a domain')).toThrowError(/invalid domain/);
    expect(() => setConfigValue(deps, 'bogus', 'x')).toThrowError(/Valid keys/);
  });

  it('set domains parses a comma-separated list', () => {
    const dir = tmpDir();
    const cfgPath = join(dir, 'config.json');
    const { deps } = depsWith(cfgPath);
    setConfigValue(deps, 'domains', 'Mail.Example.com, other.org');
    expect(readConfigFile(cfgPath).domains).toEqual(['mail.example.com', 'other.org']);
  });

  it('parseConfigValue and isSecretConfigKey cover the key set', () => {
    expect(isSecretConfigKey('botToken')).toBe(true);
    expect(isSecretConfigKey('telegramWebhookSecret')).toBe(true);
    expect(isSecretConfigKey('mailersendApiKey')).toBe(true);
    expect(isSecretConfigKey('mailgunApiKey')).toBe(true);
    expect(isSecretConfigKey('emailProvider')).toBe(false);
    expect(isSecretConfigKey('serverPort')).toBe(false);
    expect(parseConfigValue('logFile', '/var/log/x.log')).toEqual({ logFile: '/var/log/x.log' });
    expect(parseConfigValue('logFile', '')).toEqual({ logFile: null });
    expect(parseConfigValue('logLevel', 'debug')).toEqual({ logLevel: 'debug' });
    expect(parseConfigValue('emailProvider', 'mailgun')).toEqual({ emailProvider: 'mailgun' });
    expect(parseConfigValue('mailersendApiKey', 'ms_k')).toEqual({ mailersendApiKey: 'ms_k' });
    expect(parseConfigValue('mailgunApiKey', '')).toEqual({ mailgunApiKey: null });
    expect(() => parseConfigValue('emailProvider', 'sendgrid')).toThrow(/invalid email provider/);
  });
});
