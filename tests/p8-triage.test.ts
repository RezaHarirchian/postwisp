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

import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import { addRule, evaluateRules } from '../src/core/inbox.js';
import type { LlmClient } from '../src/core/llm.js';
import {
  applyTriageAction,
  classifyEmail,
  decideAction,
  learnFromCorrection,
  noteManualArchive,
  suggestedActionFor,
  triageInbound,
} from '../src/core/triage.js';
import { createInboundHandler } from '../src/bot/inbound.js';
import type { SendQueue, SendRequest } from '../src/bot/queue.js';
import type { EmailEvent } from '../src/providers/interface.js';

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function memStore(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}

function quietLogger(): Logger {
  return createLogger({ stream: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

// A canned model: returns one fixed classification and records whether it
// was consulted at all.
function stubLlm(result: unknown, calls: { n: number } = { n: 0 }): LlmClient {
  return {
    chatJson: async () => {
      calls.n++;
      return result;
    },
  };
}

function seedEmail(store: Store, id = 'em_1', from = 'news@example.com'): void {
  store.saveFullEmail({
    id,
    provider: 'resend',
    domain: 'example.com',
    from,
    subject: 'Weekly deals',
    snippet: 'sale',
    bodyText: 'Buy now, 50% off everything this week.',
  });
}

describe('classifyEmail', () => {
  it('validates the category and clamps the confidence', async () => {
    const out = await classifyEmail(
      stubLlm({ category: 'newsletter', confidence: 2 }),
      { from: 'a@b.c', subject: 's', body: 'b' },
    );
    expect(out).toEqual({ category: 'newsletter', confidence: 1 });
  });

  it('rejects an unknown category instead of acting on it', async () => {
    await expect(
      classifyEmail(stubLlm({ category: 'spam', confidence: 0.9 }), { from: 'a', subject: 's', body: 'b' }),
    ).rejects.toThrow();
  });

  it('rejects a non-numeric confidence', async () => {
    await expect(
      classifyEmail(stubLlm({ category: 'noise', confidence: 'high' }), { from: 'a', subject: 's', body: 'b' }),
    ).rejects.toThrow();
  });
});

describe('decideAction', () => {
  it('maps high-confidence categories onto rule actions', () => {
    expect(decideAction('urgent', 0.95)).toEqual({ action: 'label', label: 'urgent' });
    expect(decideAction('important', 0.8)).toEqual({ action: 'label', label: 'important' });
    expect(decideAction('newsletter', 0.85)).toEqual({ action: 'archive', label: null });
    expect(decideAction('noise', 0.8)).toEqual({ action: 'archive', label: null });
  });

  it('silences only very-confident noise', () => {
    expect(decideAction('noise', 0.95)).toEqual({ action: 'silent', label: null });
    expect(decideAction('noise', 0.89)).toEqual({ action: 'archive', label: null });
  });

  it('returns none below the confidence threshold', () => {
    expect(decideAction('urgent', 0.5)).toEqual({ action: 'none', label: null });
    expect(decideAction('unsure', 0.99)).toEqual({ action: 'none', label: null });
  });

  it('suggests the full-confidence action for unsure items', () => {
    expect(suggestedActionFor('newsletter')).toEqual({ action: 'archive', label: null });
    expect(suggestedActionFor('important')).toEqual({ action: 'label', label: 'important' });
    expect(suggestedActionFor('unsure')).toEqual({ action: 'none', label: null });
  });
});

describe('triageInbound', () => {
  it('auto-archives a high-confidence newsletter and records the decision', async () => {
    const store = memStore();
    seedEmail(store);
    const res = await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'newsletter', confidence: 0.95 }) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Weekly deals', snippet: 'sale', bodyText: 'Buy now.' },
    );
    expect(res).toEqual({ silent: false, unsure: null });
    expect(store.getEmailMeta('em_1')?.archived).toBe(true);
    const row = store.getTriageByEmail('em_1');
    expect(row).not.toBeNull();
    expect(row?.category).toBe('newsletter');
    expect(row?.applied).toBe(true);
  });

  it('labels a high-confidence urgent mail', async () => {
    const store = memStore();
    seedEmail(store, 'em_2', 'boss@example.com');
    await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'urgent', confidence: 0.9 }) },
      { id: 'em_2', fromAddr: 'boss@example.com', subject: 'Server down', snippet: '', bodyText: 'Fix now.' },
    );
    expect(store.getEmailMeta('em_2')?.labels).toContain('urgent');
    expect(store.getEmailMeta('em_2')?.archived).toBe(false);
  });

  it('silences very-confident noise', async () => {
    const store = memStore();
    seedEmail(store);
    const res = await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'noise', confidence: 0.97 }) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Weekly deals', snippet: '', bodyText: 'x' },
    );
    expect(res.silent).toBe(true);
    expect(res.unsure).toBeNull();
    expect(store.getEmailMeta('em_1')?.archived).toBe(true);
  });

  it('returns an unsure item below the threshold without touching the mail', async () => {
    const store = memStore();
    seedEmail(store);
    const res = await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'important', confidence: 0.5 }) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Weekly deals', snippet: '', bodyText: 'x' },
    );
    expect(res.silent).toBe(false);
    expect(res.unsure).not.toBeNull();
    expect(res.unsure?.triageId).toBeGreaterThan(0);
    expect(res.unsure?.category).toBe('important');
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    expect(store.getTriageByEmail('em_1')?.applied).toBe(false);
  });

  it('defers to an explicit rule for the sender without calling the model', async () => {
    const store = memStore();
    seedEmail(store);
    addRule(store, { name: 'keep news', matchFrom: 'news@example.com', action: 'label', actionArg: 'news' });
    const calls = { n: 0 };
    const res = await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'noise', confidence: 0.99 }, calls) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Weekly deals', snippet: '', bodyText: 'x' },
    );
    expect(calls.n).toBe(0);
    expect(res).toEqual({ silent: false, unsure: null });
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
  });

  it('treats a failed classification as triage-off: the mail flows normally', async () => {
    const store = memStore();
    seedEmail(store);
    const broken: LlmClient = {
      chatJson: async () => {
        throw new Error('boom');
      },
    };
    const res = await triageInbound(
      { store, logger: quietLogger(), llm: broken },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Weekly deals', snippet: '', bodyText: 'x' },
    );
    expect(res).toEqual({ silent: false, unsure: null });
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    expect(store.getTriageByEmail('em_1')).toBeNull();
  });
});

describe('applyTriageAction', () => {
  it('is a no-op for action none and for unknown emails', () => {
    const store = memStore();
    seedEmail(store);
    applyTriageAction(store, 'em_1', 'none', null);
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    applyTriageAction(store, 'nope', 'archive', null);
  });
});

describe('learnFromCorrection', () => {
  it('learns keep: the rule fires on future mail from the sender', () => {
    const store = memStore();
    const learned = learnFromCorrection(store, 'News@Example.COM', 'kept');
    expect(learned).toBe('keep mail from news@example.com');
    // End-to-end at the domain level: the learned rule fires through the
    // normal rules evaluation on a later email.
    const outcome = evaluateRules(store, { from: 'news@example.com', subject: 'More deals' });
    expect(outcome.labels).toContain('ai-kept');
    expect(outcome.archive).toBe(false);
  });

  it('learns archive: future mail from the sender is archived', () => {
    const store = memStore();
    const learned = learnFromCorrection(store, 'boss@example.com', 'archived');
    expect(learned).toBe('archive mail from boss@example.com');
    const outcome = evaluateRules(store, { from: 'boss@example.com', subject: 'Hello' });
    expect(outcome.archive).toBe(true);
  });

  it('does not duplicate an identical learned rule', () => {
    const store = memStore();
    expect(learnFromCorrection(store, 'a@b.c', 'kept')).not.toBeNull();
    expect(learnFromCorrection(store, 'a@b.c', 'kept')).toBeNull();
  });

  it('ignores empty addresses', () => {
    expect(learnFromCorrection(memStore(), '   ', 'kept')).toBeNull();
  });
});

describe('noteManualArchive', () => {  it('learns archive when the owner archives AI-labeled mail', async () => {
    const store = memStore();
    seedEmail(store, 'em_1', 'boss@example.com');
    await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'important', confidence: 0.9 }) },
      { id: 'em_1', fromAddr: 'boss@example.com', subject: 'Hi', snippet: '', bodyText: 'x' },
    );
    expect(store.getEmailMeta('em_1')?.labels).toContain('important');
    const learned = noteManualArchive(store, 'em_1', true);
    expect(learned).toBe('archive mail from boss@example.com');
    // The learned rule fires on future mail from that sender.
    expect(evaluateRules(store, { from: 'boss@example.com', subject: 'Later' }).archive).toBe(true);
    // A second manual archive is not a second correction.
    expect(noteManualArchive(store, 'em_1', true)).toBeNull();
  });

  it('learns keep when the owner un-archives AI-archived mail', async () => {
    const store = memStore();
    seedEmail(store);
    await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'newsletter', confidence: 0.9 }) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Deals', snippet: '', bodyText: 'x' },
    );
    expect(store.getEmailMeta('em_1')?.archived).toBe(true);
    const learned = noteManualArchive(store, 'em_1', false);
    expect(learned).toBe('keep mail from news@example.com');
    expect(
      evaluateRules(store, { from: 'news@example.com', subject: 'More' }).labels,
    ).toContain('ai-kept');
  });

  it('ignores mail the AI never triaged', () => {
    const store = memStore();
    seedEmail(store);
    expect(noteManualArchive(store, 'em_1', true)).toBeNull();
  });
});

describe('inbound triage integration', () => {
  function sampleEvent(overrides: Partial<EmailEvent> = {}): EmailEvent {
    return {
      id: 'ev-1',
      provider: 'resend',
      domain: 'example.com',
      from: { address: 'news@example.com', name: 'News' },
      to: ['me@example.com'],
      subject: 'Weekly deals',
      dateMs: 1700000000000,
      snippet: 'sale',
      bodyText: 'Buy now, 50% off everything this week.',
      bodyHtml: null,
      attachments: [],
      threadId: null,
      headers: {},
      ...overrides,
    };
  }

  function fakeQueue(): { queue: SendQueue; sent: SendRequest[] } {
    const sent: SendRequest[] = [];
    return {
      sent,
      queue: {
        enqueue(_chatId: number, req: SendRequest): void {
          sent.push(req);
        },
        stop(): void {},
      } as unknown as SendQueue,
    };
  }

  it('auto-applies triage through handleEmailEvent: archived, still notified', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      ai: { llm: stubLlm({ category: 'newsletter', confidence: 0.95 }) },
    });
    await handler.handleEmailEvent(sampleEvent());
    expect(store.getEmailMeta('ev-1')?.archived).toBe(true);
    expect(store.getTriageByEmail('ev-1')?.applied).toBe(true);
    // An archived-by-triage mail still notifies, like an archive rule.
    expect(sent).toHaveLength(1);
  });

  it('silences high-confidence noise: stored, never notified', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      ai: { llm: stubLlm({ category: 'noise', confidence: 0.97 }) },
    });
    await handler.handleEmailEvent(sampleEvent());
    expect(store.getEmailMeta('ev-1')?.archived).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('queues an approve/reject item for unsure mail plus the normal notification', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      ai: { llm: stubLlm({ category: 'important', confidence: 0.4 }) },
    });
    await handler.handleEmailEvent(sampleEvent());
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain('AI triage is unsure');
    expect(sent[1]!.text).toContain('Weekly deals');
  });

  it('without the ai dep nothing is classified and no extra message appears', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent());
    expect(sent).toHaveLength(1);
    expect(store.getTriageByEmail('ev-1')).toBeNull();
  });

  it('an explicit auto-reply rule still fires on silent-triaged mail', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    addRule(store, {
      name: 'reply to news',
      matchFrom: 'news@example.com',
      action: 'autoreply',
      actionArg: 'Thanks, noted.',
    });
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      ai: { llm: stubLlm({ category: 'noise', confidence: 0.97 }) },
    });
    await handler.handleEmailEvent(sampleEvent());
    // The explicit rule wins over the AI guess: the owner hears about the
    // auto-reply instead of silence.
    expect(sent.map((s) => s.text).join('\n')).toContain('rule wanted to auto-reply');
  });
});

describe('noteManualArchive on unsure items', () => {
  it('archiving an unsure item whose suggestion was archive is agreement, not a correction', async () => {
    const store = memStore();
    seedEmail(store);
    await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'newsletter', confidence: 0.6 }) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Deals', snippet: '', bodyText: 'x' },
    );
    expect(store.getTriageByEmail('em_1')?.action).toBe('none');
    // The owner archives it themselves: that matches the suggestion.
    expect(noteManualArchive(store, 'em_1', true)).toBeNull();
    expect(store.ruleList()).toEqual([]);
  });

  it('archiving an unsure item whose suggestion was label learns archive', async () => {
    const store = memStore();
    seedEmail(store);
    await triageInbound(
      { store, logger: quietLogger(), llm: stubLlm({ category: 'important', confidence: 0.6 }) },
      { id: 'em_1', fromAddr: 'news@example.com', subject: 'Deals', snippet: '', bodyText: 'x' },
    );
    expect(noteManualArchive(store, 'em_1', true)).toBe('archive mail from news@example.com');
    expect(evaluateRules(store, { from: 'news@example.com', subject: 'Later' }).archive).toBe(true);
  });
});
