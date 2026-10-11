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

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';

export interface WebappDeps {
  store: Store;
  // The bot token signs WebApp initData; without it no request can
  // authenticate and the routes stay unregistered.
  botToken: string;
  logger: Logger;
}

// initData older than this is rejected: a captured payload must not stay
// usable forever.
const INIT_DATA_MAX_AGE_SEC = 86400;

// Validates Telegram WebApp initData per the Bot API docs: the data_check
// string (all fields but hash, sorted, newline-joined) is HMAC-signed with
// a key derived from the bot token, and the result must match the hash
// field. The auth_date must be recent.
export function verifyInitData(initData: string, botToken: string, nowMs: number = Date.now()): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return false;
  }
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const pairs: string[] = [];
  for (const [key, value] of params) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(computed, 'hex');
    actual = Buffer.from(hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return false;
  return Math.abs(nowMs / 1000 - authDate) <= INIT_DATA_MAX_AGE_SEC;
}

function initDataOf(request: FastifyRequest): string {
  const raw = request.headers['x-telegram-init-data'];
  return typeof raw === 'string' ? raw : '';
}

// Deliberately read-only plus archive: the Web App is a triage surface,
// not a second settings panel. No compose, no settings, no key handling.
export function registerWebapp(app: FastifyInstance, deps: WebappDeps): void {
  const { store, botToken, logger } = deps;

  async function authorized(request: FastifyRequest): Promise<boolean> {
    const ok = verifyInitData(initDataOf(request), botToken);
    if (!ok) logger.warn('webapp request rejected: bad initData', {});
    return ok;
  }

  app.get('/webapp', async (_request, reply) => {
    return reply.type('text/html').send(WEBAPP_HTML);
  });

  app.get('/webapp/api/emails', async (request, reply) => {
    if (!(await authorized(request))) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const emails = store.listEmailMeta({ limit: 30 }).map((m) => ({
      id: m.id,
      fromAddr: m.fromAddr,
      fromName: m.fromName ?? null,
      subject: m.subject,
      dateMs: m.dateMs ?? m.receivedAt,
      snippet: m.snippet ?? '',
      read: m.read,
      archived: m.archived,
    }));
    return { ok: true, emails };
  });

  app.get('/webapp/api/emails/:id', async (request, reply) => {
    if (!(await authorized(request))) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const id = (request.params as { id?: string }).id ?? '';
    const meta = store.getEmailMeta(id);
    if (!meta) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!meta.read) store.saveEmailMeta({ ...meta, read: true });
    return {
      ok: true,
      email: {
        id: meta.id,
        fromAddr: meta.fromAddr,
        fromName: meta.fromName ?? null,
        to: meta.to ?? [],
        subject: meta.subject,
        dateMs: meta.dateMs ?? meta.receivedAt,
        bodyText: meta.bodyText ?? meta.snippet ?? '',
        archived: meta.archived,
      },
    };
  });

  app.post('/webapp/api/emails/:id/archive', async (request, reply) => {
    if (!(await authorized(request))) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const id = (request.params as { id?: string }).id ?? '';
    const meta = store.getEmailMeta(id);
    if (!meta) return reply.code(404).send({ ok: false, error: 'not found' });
    store.saveEmailMeta({ ...meta, archived: true });
    return { ok: true };
  });
}

// A single self-contained page: no build step, no external assets besides
// Telegram's WebApp script. All email content is inserted via textContent,
// never innerHTML, so a hostile subject cannot run script here.
const WEBAPP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>postwisp inbox</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; background: #fff; color: #111; }
h1 { font-size: 18px; margin: 4px 0 12px; }
.row { border-bottom: 1px solid #ddd; padding: 10px 0; }
.row .from { font-weight: 600; }
.row .subject { color: #333; margin: 2px 0; }
.row .date { color: #777; font-size: 12px; }
.row.unread .subject { font-weight: 600; }
button { margin: 6px 8px 0 0; padding: 6px 12px; font-size: 14px; }
#detail { white-space: pre-wrap; }
#detail .meta { color: #555; font-size: 13px; margin-bottom: 8px; }
a.back { display: inline-block; margin-bottom: 8px; }
</style>
</head>
<body>
<h1>Inbox</h1>
<div id="list"></div>
<div id="detail" hidden></div>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function () {
  var wa = window.Telegram && window.Telegram.WebApp;
  var initData = (wa && wa.initData) || '';
  if (wa) { try { wa.ready(); wa.expand(); } catch (e) {} }
  var listEl = document.getElementById('list');
  var detailEl = document.getElementById('detail');

  function fail() {
    listEl.textContent = 'Not authorized. Open this page from the bot.';
  }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({}, opts, {
      headers: { 'X-Telegram-Init-Data': initData }
    }));
    if (res.status === 401) { fail(); throw new Error('unauthorized'); }
    return res.json();
  }

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function fmtDate(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  async function archive(id, after) {
    await api('/webapp/api/emails/' + encodeURIComponent(id) + '/archive', { method: 'POST' });
    after();
  }

  function showList() {
    detailEl.hidden = true;
    listEl.hidden = false;
    api('/webapp/api/emails').then(function (data) {
      listEl.textContent = '';
      if (!data.emails || data.emails.length === 0) {
        listEl.textContent = 'No emails here.';
        return;
      }
      data.emails.forEach(function (m) {
        var row = el('div', undefined, 'row' + (m.read ? '' : ' unread'));
        row.appendChild(el('div', m.fromName || m.fromAddr, 'from'));
        row.appendChild(el('div', m.subject, 'subject'));
        row.appendChild(el('div', fmtDate(m.dateMs) + (m.archived ? ' — archived' : ''), 'date'));
        var open = el('button', 'Open');
        open.onclick = function () { showDetail(m.id); };
        var arch = el('button', m.archived ? 'Archived' : 'Archive');
        arch.disabled = !!m.archived;
        arch.onclick = function () {
          archive(m.id, function () { m.archived = true; showList(); });
        };
        row.appendChild(open);
        row.appendChild(arch);
        listEl.appendChild(row);
      });
    }).catch(function () {});
  }

  function showDetail(id) {
    api('/webapp/api/emails/' + encodeURIComponent(id)).then(function (data) {
      var m = data.email;
      listEl.hidden = true;
      detailEl.hidden = false;
      detailEl.textContent = '';
      var back = el('a', 'Back to inbox', 'back');
      back.href = '#';
      back.onclick = function (e) { e.preventDefault(); showList(); };
      detailEl.appendChild(back);
      var meta = el('div', undefined, 'meta');
      meta.appendChild(el('div', 'From: ' + (m.fromName || m.fromAddr)));
      if (m.to && m.to.length > 0) meta.appendChild(el('div', 'To: ' + m.to.join(', ')));
      meta.appendChild(el('div', fmtDate(m.dateMs)));
      detailEl.appendChild(meta);
      detailEl.appendChild(el('h2', m.subject));
      detailEl.appendChild(el('div', m.bodyText || '(no text body)'));
      var arch = el('button', m.archived ? 'Archived' : 'Archive');
      arch.disabled = !!m.archived;
      arch.onclick = function () {
        archive(id, function () { showList(); });
      };
      detailEl.appendChild(arch);
    }).catch(function () {});
  }

  if (!initData) { fail(); return; }
  showList();
})();
</script>
</body>
</html>
`;
