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

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import { verifyUnsubscribeToken } from '../core/unsubscribe.js';

export interface UnsubscribeRouteDeps {
  // Signs and verifies the per-recipient tokens; the same server-side
  // secret the footers were minted with.
  secret: string;
  store: Store;
  logger: Logger;
  // Lets the coordinator tell the owner someone unsubscribed.
  onUnsubscribe?: (email: string) => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// RFC 8058 one-click endpoint: mail clients POST here when the recipient
// clicks "unsubscribe". Transport only: verify the token, suppress the
// address, log the consent event, hand the notification off.
export function registerUnsubscribe(app: FastifyInstance, deps: UnsubscribeRouteDeps): void {
  // Scoped registration so the urlencoded parser applies to this route
  // only; one-click clients POST "List-Unsubscribe=One-Click" as
  // application/x-www-form-urlencoded, which Fastify would otherwise 415.
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scoped.post('/unsub/:token', async (request, reply) => {
      const token = (request.params as { token?: string }).token ?? '';
      const email = verifyUnsubscribeToken(token, deps.secret);
      if (!email) {
        deps.logger.warn('unsubscribe rejected: bad token', {});
        return reply.code(400).type('text/html').send(unsubPage('This unsubscribe link is invalid.'));
      }
      deps.store.suppressAddress(email, 'one-click unsubscribe');
      deps.store.logConsent('unsubscribe', email, 'one-click');
      // The address is PII: it goes to debug only. The info line keeps the
      // consent event visible in production logs without naming anyone.
      deps.logger.debug('address unsubscribed via one-click', { email });
      deps.logger.info('address unsubscribed via one-click', {});
      deps.onUnsubscribe?.(email);
      return reply.code(200).type('text/html').send(unsubPage('You have been unsubscribed.'));
    });

    // A human opening the link in a browser gets a form that POSTs back, so
    // the same URL works for clients without one-click support.
    scoped.get('/unsub/:token', async (request, reply) => {
      const token = (request.params as { token?: string }).token ?? '';
      const email = verifyUnsubscribeToken(token, deps.secret);
      if (!email) {
        return reply.code(400).type('text/html').send(unsubPage('This unsubscribe link is invalid.'));
      }
      const safe = escapeHtml(`/unsub/${token}`);
      return reply.code(200).type('text/html').send(
        `<!doctype html><html><body>` +
          `<p>Unsubscribe ${escapeHtml(email)} from future mail?</p>` +
          `<form method="post" action="${safe}"><button type="submit">Unsubscribe</button></form>` +
          `</body></html>`,
      );
    });
  });
}

function unsubPage(message: string): string {
  return `<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`;
}
