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

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export interface TelegramWebhookOptions {
  // Unguessable path generated at setup, e.g. /tg/9f2c... — the only thing
  // standing between the internet and the bot.
  path: string;
  secretToken: string;
  handleUpdate: (update: unknown) => Promise<void>;
}

// The transport layer owns verification only. Product logic lives in bot/;
// this function parses the envelope and hands it off.
export function registerTelegramWebhook(app: FastifyInstance, options: TelegramWebhookOptions): void {
  // Fail closed on a missing secret: timingSafeEqual(empty, empty) is
  // true, so without this guard a request carrying no header at all would
  // be accepted as authorized. The route stays registered (same 404
  // surface for unknown paths) but every request is rejected until a real
  // secret is configured.
  if (!options.secretToken) {
    app.post(options.path, async (_request, reply) => {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    });
    return;
  }
  const expected = Buffer.from(options.secretToken, 'utf8');

  app.post(options.path, async (request, reply) => {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    const provided = Buffer.from(Array.isArray(header) ? (header[0] ?? '') : (header ?? ''), 'utf8');

    // timingSafeEqual throws on length mismatch, so compare lengths first.
    // A wrong token is a flat 401; the path itself stays unguessable.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }

    // Always 200: anything else makes Telegram retry the update, and a
    // poisoned update must not wedge the queue behind it.
    try {
      await options.handleUpdate(request.body);
    } catch {
      // The error is intentionally swallowed here; bot-level logging lives in
      // the handleUpdate implementation, not in transport.
    }
    return reply.code(200).send({ ok: true });
  });
}
