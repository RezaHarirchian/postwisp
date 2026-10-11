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

import { join } from 'node:path';
import type { Command } from 'commander';
import { loadConfig, type PostwispConfig } from '../../core/config.js';
import { openStore, type Store } from '../../core/store.js';
// The token helpers live in core so the bot layer can share them without
// importing from the CLI layer; re-exported here for existing importers.
import {
  generatePairingToken,
  pairingLink,
  storePairingToken,
  type KvStore,
} from '../../core/pairing.js';
export {
  PAIRING_TOKEN_KEY,
  PAIRING_TOKEN_EXPIRES_KEY,
  PAIRING_TOKEN_TTL_MS,
  clearPairingToken,
  generatePairingToken,
  pairingLink,
  pairingTokenMatches,
  readPairingToken,
  storePairingToken,
  type KvStore,
  type PairingToken,
} from '../../core/pairing.js';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class PairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Resolves the bot's username for the t.me deep link. The bot token never
// appears in error messages: it is a long-term secret, unlike the one-time
// pairing token the printed link itself carries.
export async function fetchBotUsername(
  botToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new PairError(
      `Could not reach Telegram to verify the bot token (${describeError(error)}). ` +
        'Without a working token there is no bot to pair with. ' +
        'Fix: check your network connection, or run `postwisp setup` and enter a fresh token from @BotFather.',
    );
  }
  let username: string | undefined;
  if (res.ok) {
    try {
      const body = (await res.json()) as { ok?: boolean; result?: { username?: unknown } };
      if (body.ok === true && typeof body.result?.username === 'string') {
        username = body.result.username;
      }
    } catch {
      username = undefined;
    }
  }
  if (username === undefined) {
    throw new PairError(
      `Telegram rejected the bot token (HTTP ${res.status}). ` +
        'The token is wrong, revoked, or not a bot token, so no pairing link can be built. ' +
        'Fix: run `postwisp setup` and enter a fresh token from @BotFather.',
    );
  }
  return username;
}

export interface PairRunDeps {
  config: PostwispConfig;
  store: KvStore;
  fetchImpl?: FetchImpl;
  nowMs?: () => number;
  out?: (line: string) => void;
}

export async function runPairCommand(
  deps: PairRunDeps,
  opts: { rotate?: boolean } = {},
): Promise<void> {
  const out = deps.out ?? console.log;
  const nowMs = deps.nowMs?.() ?? Date.now();
  const botToken = deps.config.botToken;
  if (!botToken) {
    throw new PairError(
      'No bot token is configured, so there is no bot to pair with. ' +
        'Fix: run `postwisp setup` first to save a bot token.',
    );
  }
  const username = await fetchBotUsername(botToken, deps.fetchImpl);
  const token = generatePairingToken();
  storePairingToken(deps.store, token, nowMs);
  if (opts.rotate) out('Previous pairing link invalidated.');
  out('Pairing link (valid 15 minutes, single use):');
  out('');
  out(pairingLink(username, token));
  out('');
  out('1. Make sure the postwisp server is running, so the bot is online to receive your tap.');
  out('2. Open the link and press Start in Telegram.');
  out('3. That chat becomes the bot owner; the link stops working afterwards.');
}

export function registerPair(program: Command): void {
  program
    .command('pair')
    .description('Print a one-time Telegram pairing link that makes this chat the bot owner')
    .option('--rotate', 'invalidate the current pairing link and print a new one')
    .action(async (opts: { rotate?: boolean }) => {
      const config = loadConfig();
      const store = openStore(join(config.dataDir, 'postwisp.db'));
      try {
        await runPairCommand({ config, store }, { rotate: opts.rotate ?? false });
      } finally {
        store.close();
      }
    });
}
