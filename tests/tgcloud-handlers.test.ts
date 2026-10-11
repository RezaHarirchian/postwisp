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

// Tests for the tgcloud handlers and lib against a virtual 'sdk' mock.
// The mock implements the minimal query-builder surface store.js needs
// (documented at the top of tgcloud/lib/store.js) with an in-memory store.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const sdkState = vi.hoisted(() => {
  const tables = new Map<string, Map<string, Row>>();
  const autoIds = new Map<string, number>();
  function table(name: string): Map<string, Row> {
    let t = tables.get(name);
    if (!t) {
      t = new Map();
      tables.set(name, t);
    }
    return t;
  }
  function pkOf(row: Row): string {
    if (row.key !== undefined) return `k:${row.key}`;
    if (row.address !== undefined) return `a:${row.address}`;
    return `i:${row.id}`;
  }
  // Predicates mirror the documented sdk/db operators: eq(col, v) and
  // and(...)/or(...) over them. where() accumulates with AND semantics.
  function matches(row: Row, p: any): boolean {
    if (!p || !p._pred) return true;
    if (p.op === 'eq') return row[p.col] === p.val;
    if (p.op === 'and') return p.preds.every((x: any) => matches(row, x));
    if (p.op === 'or') return p.preds.some((x: any) => matches(row, x));
    return true;
  }
  function makeQuery(tableName: string): any {
    let preds: any[] = [];
    let order: { col: string; dir: string } | null = null;
    let limitN: number | null = null;
    let offsetN = 0;
    const run = (): Row[] => {
      let rows = [...table(tableName).values()].filter((r) => preds.every((p) => matches(r, p)));
      if (order) {
        const { col, dir } = order;
        rows = [...rows].sort((a, b) => {
          if (a[col] === b[col]) return 0;
          return (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        });
      }
      return rows.slice(offsetN, limitN === null ? undefined : offsetN + limitN);
    };
    const q: any = {
      from(t: any) {
        return makeQuery(t.name);
      },
      where(p: any) {
        preds = [...preds, p];
        return q;
      },
      orderBy(o: any) {
        order = { col: o.col, dir: o.dir };
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      offset(n: number) {
        offsetN = n;
        return q;
      },
      all: async () => run(),
      get: async () => run()[0] ?? null,
    };
    return q;
  }
  const db = {
    select: () => makeQuery(''),
    insert: (t: any) => {
      const tableName: string = t.name;
      return {
        values: (row: Row) => {
          let conflict: { target: string; set: Row } | null = null;
          const b: any = {
            onConflictDoUpdate(c: any) {
              conflict = { target: c.target.jsKey ?? c.target.name, set: c.set };
              return b;
            },
            returning() {
              return b;
            },
            run: async () => {
              const tbl = table(tableName);
              let finalRow = { ...row };
              if (finalRow.id === undefined && tableName === 'outbox') {
                const next = (autoIds.get(tableName) ?? 0) + 1;
                autoIds.set(tableName, next);
                finalRow = { ...finalRow, id: next };
              }
              if (conflict) {
                for (const existing of tbl.values()) {
                  if (existing[conflict.target] === finalRow[conflict.target]) {
                    Object.assign(existing, conflict.set, { [conflict.target]: finalRow[conflict.target] });
                    return [existing];
                  }
                }
              }
              tbl.set(pkOf(finalRow), finalRow);
              return [finalRow];
            },
          };
          return b;
        },
      };
    },
    update: (t: any) => {
      const tableName: string = t.name;
      let preds: any[] = [];
      let patch: Row = {};
      const u: any = {
        set(obj: Row) {
          patch = { ...patch, ...obj };
          return u;
        },
        where(p: any) {
          preds = [...preds, p];
          return u;
        },
        run: async () => {
          for (const row of table(tableName).values()) {
            if (preds.every((p) => matches(row, p))) Object.assign(row, patch);
          }
        },
      };
      return u;
    },
    delete: (t: any) => {
      const tableName: string = t.name;
      let preds: any[] = [];
      const d: any = {
        where(p: any) {
          preds = [...preds, p];
          return d;
        },
        run: async () => {
          for (const [k, row] of table(tableName)) {
            if (preds.every((p) => matches(row, p))) table(tableName).delete(k);
          }
        },
      };
      return d;
    },
  };
  const state = {
    db,
    sent: [] as Row[],
    answered: [] as Row[],
    fetchCalls: [] as { url: string; init: any }[],
    fetchImpl: async (url: string, init: any): Promise<Response> => {
      state.fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ id: 're_test_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    reset() {
      tables.clear();
      autoIds.clear();
      state.sent = [];
      state.answered = [];
      state.fetchCalls = [];
      state.fetchImpl = async (url: string, init: any): Promise<Response> => {
        state.fetchCalls.push({ url, init });
        return new Response(JSON.stringify({ id: 're_test_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    },
  };
  return state;
});

vi.mock('sdk', () => {
  return {
    api: {
      sendMessage: async (params: Row) => {
        sdkState.sent.push(params);
        return { ok: true, result: { message_id: sdkState.sent.length } };
      },
      answerCallbackQuery: async (params: Row) => {
        sdkState.answered.push(params);
      },
    },
    db: sdkState.db,
    fetch: (url: string, init: any) => sdkState.fetchImpl(url, init),
  };
}, { virtual: true });

vi.mock('sdk/db', () => {
  const column = (sqlName: string) => ({ name: sqlName, primaryKey: () => ({ name: sqlName }) });
  return {
    // The table mock keeps JS-key -> column-ref mapping like the real DSL,
    // so store code can pass kv.key / emails.id into eq()/desc().
    table: (name: string, cols?: Record<string, any>) => {
      const t: any = { name };
      for (const [jsKey, col] of Object.entries(cols || {})) {
        t[jsKey] = { name: col?.name ?? jsKey, jsKey };
      }
      return t;
    },
    integer: column,
    text: column,
    eq: (col: any, val: any) => ({ _pred: true, op: 'eq', col: col.jsKey ?? col.name, val }),
    and: (...preds: any[]) => ({ _pred: true, op: 'and', preds }),
    or: (...preds: any[]) => ({ _pred: true, op: 'or', preds }),
    asc: (col: any) => ({ col: col.jsKey ?? col.name, dir: 'asc' }),
    desc: (col: any) => ({ col: col.jsKey ?? col.name, dir: 'desc' }),
  };
}, { virtual: true });

import onMessage from '../tgcloud/handlers/message.js';
import onCallbackQuery from '../tgcloud/handlers/callback_query.js';
import { formatInboundMessage } from '../tgcloud/lib/pure.js';
import { addSuppression, getEmail, kvDelete, kvSet, listOutbox, saveEmail } from '../tgcloud/lib/store.js';

const OWNER_ID = 99;
const CHAT_ID = 7;

function message(text: string, fromId = OWNER_ID): any {
  return { message_id: 1, from: { id: fromId, is_bot: false }, chat: { id: CHAT_ID }, text };
}

function callback(data: string, opts: { fromId?: number; messageText?: string } = {}): any {
  return {
    id: 'cb1',
    from: { id: opts.fromId ?? OWNER_ID, is_bot: false },
    data,
    message: { message_id: 42, chat: { id: CHAT_ID }, text: opts.messageText ?? '' },
  };
}

function flatButtons(params: Row): string[] {
  const rows = params.reply_markup?.inline_keyboard ?? [];
  return rows.flat().map((b: any) => b.text);
}

const NOTIFICATION = formatInboundMessage({
  from_addr: 'alice@example.com',
  from_name: 'Alice',
  subject: 'Your code',
  date_ms: 1760140000000,
  body: 'Your code is 482917.',
});

beforeEach(async () => {
  sdkState.reset();
  await kvSet('owner_id', String(OWNER_ID));
  await kvSet('resend_api_key', 're_test_key');
  await kvSet('from_addr', 'bot@example.com');
});

describe('owner guard', () => {
  it('drops messages from non-owners silently', async () => {
    await onMessage(message('/start', 123));
    expect(sdkState.sent).toHaveLength(0);
    expect(sdkState.answered).toHaveLength(0);
  });

  it('drops callback queries from non-owners after answering', async () => {
    await onCallbackQuery(callback('cb:menu', { fromId: 123 }));
    // The query itself is answered (client must not hang), but nothing else happens.
    expect(sdkState.answered).toHaveLength(1);
    expect(sdkState.sent).toHaveLength(0);
  });

  it('drops everything when no owner is seeded', async () => {
    await kvDelete('owner_id');
    await onMessage(message('/start'));
    expect(sdkState.sent).toHaveLength(0);
  });
});

describe('menu', () => {
  it('renders inbox/compose/sent/settings buttons for /start', async () => {
    await onMessage(message('/start'));
    expect(sdkState.sent).toHaveLength(1);
    const buttons = flatButtons(sdkState.sent[0]);
    expect(buttons).toEqual(expect.arrayContaining(['Inbox', 'Compose', 'Sent', 'Settings']));
  });
});

describe('compose wizard', () => {
  async function driveToConfirm(to = 'a@b.com') {
    await onMessage(message('/compose'));
    await onMessage(message(to));
    await onMessage(message('Hello'));
    await onMessage(message('Body here'));
  }

  it('walks to -> subject -> body -> confirm', async () => {
    await driveToConfirm();
    const prompts = sdkState.sent.map((s) => s.text);
    expect(prompts[0]).toMatch(/who is this to/i);
    expect(prompts[1]).toMatch(/subject/i);
    expect(prompts[2]).toMatch(/body/i);
    const confirm = sdkState.sent[sdkState.sent.length - 1];
    expect(confirm.text).toMatch(/Ready to send/);
    expect(flatButtons(confirm)).toEqual(expect.arrayContaining(['Send', 'Cancel']));
  });

  it('rejects invalid addresses and stays on the to-step', async () => {
    await onMessage(message('/compose'));
    await onMessage(message('not-an-email'));
    const last = sdkState.sent[sdkState.sent.length - 1];
    expect(last.text).toMatch(/do not look like email addresses/i);
    // Still on the to-step: a valid address now moves to subject.
    await onMessage(message('a@b.com'));
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/subject/i);
  });

  it('/cancel abandons the wizard', async () => {
    await onMessage(message('/compose'));
    await onMessage(message('/cancel'));
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/cancelled/i);
    // Wizard state is gone: plain text is now a search, not a wizard step.
    await onMessage(message('a@b.com'));
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/no mail matching/i);
  });

  it('sends through Resend with an Idempotency-Key on confirm', async () => {
    await driveToConfirm();
    await onCallbackQuery(callback('cb:send'));
    expect(sdkState.fetchCalls).toHaveLength(1);
    const call = sdkState.fetchCalls[0];
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Authorization']).toBe('Bearer re_test_key');
    expect(call.init.headers['Idempotency-Key']).toMatch(/^tg-\d+-[a-z0-9]+$/);
    const body = JSON.parse(call.init.body);
    expect(body).toMatchObject({
      from: 'bot@example.com',
      to: ['a@b.com'],
      subject: 'Hello',
      text: 'Body here',
    });
    const outbox = await listOutbox(5);
    expect(outbox[0]?.status).toBe('sent');
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/Sent to a@b\.com/);
  });

  it('a Resend 429 marks the outbox entry failed with the retry hint', async () => {
    sdkState.fetchImpl = async (url: string, init: any) => {
      sdkState.fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ retry_after: 45 }), { status: 429 });
    };
    await driveToConfirm();
    await onCallbackQuery(callback('cb:send'));
    const outbox = await listOutbox(5);
    expect(outbox[0]?.status).toBe('failed');
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/retry after 45s/);
  });

  it('a retried send reuses the same Idempotency-Key', async () => {
    // First attempt fails; the wizard survives, so the retry must carry the
    // same key and Resend can dedup it instead of delivering twice.
    sdkState.fetchImpl = async (url: string, init: any) => {
      sdkState.fetchCalls.push({ url, init });
      return new Response('boom', { status: 500 });
    };
    await driveToConfirm();
    await onCallbackQuery(callback('cb:send'));
    sdkState.fetchImpl = async (url: string, init: any) => {
      sdkState.fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ id: 're_retry_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await onCallbackQuery(callback('cb:send'));
    const keys = sdkState.fetchCalls.map((c) => c.init.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^tg-\d+-[a-z0-9]+$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('refuses to send to a suppressed address', async () => {
    await addSuppression('bad@x.com', 'bounced');
    await driveToConfirm('bad@x.com');
    await onCallbackQuery(callback('cb:send'));
    expect(sdkState.fetchCalls).toHaveLength(0);
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/suppression list/);
  });

  it('refuses to send when secrets are not seeded', async () => {
    await kvDelete('resend_api_key');
    await driveToConfirm();
    await onCallbackQuery(callback('cb:send'));
    expect(sdkState.fetchCalls).toHaveLength(0);
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/must be seeded/i);
  });
});

describe('callback queries', () => {
  it('answers every query before doing the work', async () => {
    await onCallbackQuery(callback('cb:menu'));
    expect(sdkState.answered[0]).toMatchObject({ callback_query_id: 'cb1' });
  });
});

describe('worker notifications (w:*)', () => {
  it('w:sv saves the notification email and toasts', async () => {
    await onCallbackQuery(callback('w:sv', { messageText: NOTIFICATION }));
    const email = await getEmail('w:7:42');
    expect(email?.from_addr).toBe('alice@example.com');
    expect(email?.subject).toBe('Your code');
    expect(email?.body).toBe('Your code is 482917.');
    expect(sdkState.answered[sdkState.answered.length - 1]?.text).toMatch(/saved to inbox/i);
  });

  it('w:otp replies with the extracted code and protects the message', async () => {
    await onCallbackQuery(callback('w:otp', { messageText: NOTIFICATION }));
    const last = sdkState.sent[sdkState.sent.length - 1];
    expect(last.text).toMatch(/482917/);
    expect(last.protect_content).toBe(true);
  });

  it('w:otp toasts when there is no code', async () => {
    const noCode = formatInboundMessage({
      from_addr: 'a@b.com',
      from_name: '',
      subject: 'hi',
      date_ms: 1,
      body: 'just saying hello',
    });
    await onCallbackQuery(callback('w:otp', { messageText: noCode }));
    expect(sdkState.answered[sdkState.answered.length - 1]?.text).toMatch(/no code found/i);
    expect(sdkState.sent).toHaveLength(0);
  });

  it('w:rpl starts a compose prefilled from the notification', async () => {
    await onCallbackQuery(callback('w:rpl', { messageText: NOTIFICATION }));
    const last = sdkState.sent[sdkState.sent.length - 1];
    expect(last.text).toMatch(/alice@example\.com/);
    expect(last.text).toMatch(/Re: Your code/);
  });

  it('rules run at save time', async () => {
    await sdkState.db.insert({ name: 'rules' }).values({
      id: 1,
      field: 'subject',
      matcher: 'contains',
      value: 'code',
      action: 'archive',
    }).run();
    await onCallbackQuery(callback('w:sv', { messageText: NOTIFICATION }));
    const email = await getEmail('w:7:42');
    expect(email?.labels).toContain('archived');
    expect(sdkState.answered[sdkState.answered.length - 1]?.text).toMatch(/archived by rule/);
  });
});

describe('inbox', () => {
  it('lists saved mail and opens the detail with protected content', async () => {
    await saveEmail({
      id: 'e1',
      from_addr: 'alice@example.com',
      from_name: 'Alice',
      subject: 'Hello',
      snippet: 'hi there',
      body: 'hi there, this is the body',
      received_at: 100,
    });
    await onCallbackQuery(callback('cb:inbox:0'));
    const list = sdkState.sent[sdkState.sent.length - 1];
    expect(list.text).toMatch(/alice@example\.com/);
    expect(list.protect_content).toBe(true);

    await onCallbackQuery(callback('cb:open:e1'));
    const detail = sdkState.sent[sdkState.sent.length - 1];
    expect(detail.text).toMatch(/From: Alice <alice@example\.com>/);
    expect(flatButtons(detail)).toEqual(
      expect.arrayContaining(['Full text', 'Mark read', 'Archive', 'Reply']),
    );
  });

  it('cb:full chunks a long body', async () => {
    await saveEmail({
      id: 'e2',
      from_addr: 'a@b.com',
      from_name: '',
      subject: 'long',
      snippet: '',
      body: 'x'.repeat(9000),
      received_at: 100,
    });
    const before = sdkState.sent.length;
    await onCallbackQuery(callback('cb:full:e2'));
    const chunks = sdkState.sent.slice(before);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.protect_content).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it('plain text searches the inbox', async () => {
    await saveEmail({
      id: 'e3',
      from_addr: 'alice@example.com',
      from_name: '',
      subject: 'Hello',
      snippet: '',
      body: 'nothing special',
      received_at: 100,
    });
    await onMessage(message('alice'));
    expect(sdkState.sent[sdkState.sent.length - 1].text).toMatch(/1 match/);
  });
});
