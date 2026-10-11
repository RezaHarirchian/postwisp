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

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { configFilePath, loadConfig, type PostwispConfig } from '../../core/config.js';

export class LogsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogsError';
  }
}

const SECRET_VALUE_KEYS = [
  'botToken',
  'webhookSecret',
  'resendApiKey',
  'mailersendApiKey',
  'mailgunApiKey',
  'cloudflareIngestSecret',
  'telegramWebhookSecret',
] as const;

// Every configured secret value is redacted, whatever its length: a short
// secret printed verbatim in a log line is still a credential leak. Empty
// values are skipped (redacting the empty string would mangle every line).
export function collectSecretValues(config: PostwispConfig): string[] {
  return SECRET_VALUE_KEYS.map((k) => config[k]).filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

export function redactLine(line: string, secrets: string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export interface LogsDeps {
  config: PostwispConfig;
  readFile: (path: string) => string;
  out: (line: string) => void;
}

export function showLogs(deps: LogsDeps, tail: number): void {
  const logFile = deps.config.logFile;
  if (!logFile) {
    deps.out('No log file is configured: the postwisp server writes its logs to stdout.');
    deps.out('To capture logs in a file instead, run:');
    deps.out('  postwisp config set logFile /var/log/postwisp/postwisp.log');
    deps.out('then restart the server so the new setting takes effect.');
    return;
  }
  let content: string;
  try {
    content = deps.readFile(logFile);
  } catch {
    throw new LogsError(
      `Could not read the log file at ${logFile}. The path may be wrong or the file unreadable. ` +
        'Fix: verify it with `postwisp config get logFile`, then point it somewhere the server can write with `postwisp config set logFile <path>` and restart the server.',
    );
  }
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const secrets = collectSecretValues(deps.config);
  for (const line of lines.slice(-tail)) deps.out(redactLine(line, secrets));
}

export function parseTail(raw: string | undefined): number {
  const n = Number(raw ?? '50');
  if (!Number.isInteger(n) || n <= 0) {
    throw new LogsError(
      `Invalid --tail value "${raw ?? ''}": expected a positive integer. ` +
        'Fix: pass a positive integer, e.g. `postwisp logs --tail 100`.',
    );
  }
  return n;
}

export function registerLogs(program: Command): void {
  program
    .command('logs')
    .description('Show recent server log lines (secret values redacted)')
    .option('--tail <n>', 'how many lines to show', '50')
    .action((opts: { tail?: string }) => {
      const tail = parseTail(opts.tail);
      showLogs(
        {
          config: loadConfig(),
          readFile: (p) => readFileSync(p, 'utf8'),
          out: (line) => console.log(line),
        },
        tail,
      );
    });
}
