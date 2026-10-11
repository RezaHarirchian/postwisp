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

import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from '../core/logger.js';
import { VERSION } from '../core/version.js';

export interface ServerOptions {
  logger: Logger;
}

// The HTTP layer owns transport only: verify, normalize, hand off.
// Product logic lives in bot/ and providers/, never here.
export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => {
    return { ok: true, version: VERSION };
  });

  app.setNotFoundHandler(async (request, reply) => {
    options.logger.warn('unknown route', { method: request.method, url: request.url });
    return reply.code(404).send({ ok: false, error: 'not found' });
  });

  app.setErrorHandler(async (error, request, reply) => {
    // Never leak internals: the client gets a generic message, the log gets the detail.
    options.logger.error('request failed', {
      method: request.method,
      url: request.url,
      detail: error instanceof Error ? error.message : String(error),
    });
    return reply.code(500).send({ ok: false, error: 'internal error' });
  });

  return app;
}
