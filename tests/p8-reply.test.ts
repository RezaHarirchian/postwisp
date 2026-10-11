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
import type { Context } from 'grammy';
import { openStore, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import type { LlmClient } from '../src/core/llm.js';
import type { SendInput, SendResult } from '../src/providers/interface.js';
import { generateReplyDraft } from '../src/core/smartreply.js';
import {
  buildNudgeView,
  buildTriageUnsureView,
  handleAiCallback,
  handleDraftReplyButton,
  type AiActionDeps,
} from '../src/bot/ai-actions.js';
import type { ComposeDeps } from '../src/bot/compose.js';
import { t } from '../src/core/i18n.js';

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

function stubLlm(body: unknown): LlmClient {
  return { chatJson: async () => body };
}

function fakeCtx(): { ctx: Context; replies: Array<{ text: string; extra?: unknown }> } {
  const replies: Array<{ text: string; extra?: unknown }> = [];
  const ctx = {
    chat: { id: 999, type: 'private' },
    from: { id: 999 },
    reply: async (text: string, extra?: unknown) => {
      replies.push({ text, extra });
      return { message_id: replies.length, chat: { id: 999 }, date: 0, text };
    },
  } as unknown as Context;
  return { ctx, replies };
}

function seedEmail(store: Store, headers: Record<string, string> = {}): void {
  store.saveFullEmail({
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    from: 'friend@example.com',
    subject: 'Dinner?',
    snippet: 'are you free friday',
    bodyText: 'Are you free for dinner on Friday?',
    headers,
  });
}

function aiDeps(store: Store, llm: LlmClient | null, sendDeps: ComposeDeps | null): AiActionDeps {
  return { store, logger: quietLogger(), llm, sendDeps, ownerId: 999, nudgeDays: 3 };
}

function sendDeps(
  store: Store,
  captured: SendInput[],
  compliance?: { publicUrl: string | null; secret: string | null; physicalAddress: string | null },
): ComposeDeps {
  const deps: ComposeDeps = {
    store,
    logger: quietLogger(),
    queue: null,
    ownerId: 999,
    domains: ['example.com'],
    sendEmail: async (input: SendInput): Promise<SendResult> => {
      captured.push(input);
      return { id: 'prov_1' };
    },
  };
  if (compliance) deps.compliance = compliance;
  return deps;
}

describe('generateReplyDraft', () => {
  it('returns the model body trimmed', async () => {
    const out = await generateReplyDraft(stubLlm({ body: '  Sounds good, see you then.  ' }), {
      from: 'a@b.c',
      subject: 's',
      body: 'b',
    });
    expect(out).toBe('Sounds good, see you then.');
  });

  it('rejects an empty draft', async () => {
    await expect(
      generateReplyDraft(stubLlm({ body: '   ' }), { from: 'a', subject: 's', body: 'b' }),
    ).rejects.toThrow();
  });

  it('rejects a non-string body', async () => {
    await expect(
      generateReplyDraft(stubLlm({}), { from: 'a', subject: 's', body: 'b' }),
    ).rejects.toThrow();
  });

  it('caps a runaway draft', async () => {
    const out = await generateReplyDraft(stubLlm({ body: 'x'.repeat(5000) }), {
      from: 'a',
      subject: 's',
      body: 'b',
    });
    expect(out.length).toBe(3000);
  });
});

describe('handleDraftReplyButton', () => {
  it('shows the escaped draft with approve/edit buttons and stores it', async () => {
    const store = memStore();
    seedEmail(store);
    const { ctx, replies } = fakeCtx();
    await handleDraftReplyButton(
      ctx,
      aiDeps(store, stubLlm({ body: 'Sure! <b>bold</b> & "quotes"' }), sendDeps(store, [])),
      'em_1',
    );
    expect(replies).toHaveLength(1);
    // Model output is untrusted: it must be escaped before touching markup.
    expect(replies[0]!.text).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(replies[0]!.text).not.toContain('<b>bold</b>');
    const drafts = store.getReplyDraft(1);
    expect(drafts?.toAddr).toBe('friend@example.com');
    expect(drafts?.subject).toBe('Re: Dinner?');
    expect(drafts?.body).toContain('<b>bold</b>');
  });

  it('refuses without an LLM key and never calls the model', async () => {
    const store = memStore();
    seedEmail(store);
    const { ctx, replies } = fakeCtx();
    // llm: null — the handler must refuse before any model call exists.
    await handleDraftReplyButton(ctx, aiDeps(store, null, sendDeps(store, [])), 'em_1');
    expect(replies[0]!.text).toBe(t('bot.ai.notAvailable'));
    expect(store.getReplyDraft(1)).toBeNull();
  });

  it('replies not-found for an unknown email', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    await handleDraftReplyButton(
      ctx,
      aiDeps(store, stubLlm({ body: 'x' }), sendDeps(store, [])),
      'nope',
    );
    expect(replies[0]!.text).toBe(t('bot.email.notFound'));
  });
});

describe('approve reply draft (ai:rok)', () => {
  it('sends through the normal path: signature plus compliance footer', async () => {
    const store = memStore();
    // No message-id header: the reply is not a personal threading reply,
    // so the normal send path attaches the compliance footer.
    seedEmail(store);
    store.set('identities', JSON.stringify(['me@example.com']));
    store.setSignature('me@example.com', 'Best,\nMe');
    const captured: SendInput[] = [];
    const deps = sendDeps(store, captured, {
      publicUrl: 'https://mail.example.com',
      secret: 'a-long-enough-webhook-secret',
      physicalAddress: null,
    });
    // Generate the draft first, through the real button flow.
    const { ctx, replies } = fakeCtx();
    const actions = aiDeps(store, stubLlm({ body: 'See you Friday.' }), deps);
    await handleDraftReplyButton(ctx, actions, 'em_1');
    expect(replies).toHaveLength(1);

    await handleAiCallback(ctx, actions, 'ai:rok:1');
    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.to).toEqual(['friend@example.com']);
    expect(sent.subject).toBe('Re: Dinner?');
    // Signature under the body, separated the traditional way.
    expect(sent.text).toContain('See you Friday.\n\n-- \nBest,\nMe');
    // Compliance footer for the non-personal send.
    expect(sent.text).toContain('You received this email from me@example.com.');
    expect(sent.headers?.['List-Unsubscribe']).toContain('https://mail.example.com');
    // The send is logged and the draft consumed.
    expect(store.getSentByProviderId('prov_1')?.to).toBe('friend@example.com');
    expect(store.getReplyDraft(1)).toBeNull();
    // The owner gets the normal send confirmation.
    expect(replies[replies.length - 1]!.text).toBe(t('bot.compose.sent', { to: 'friend@example.com' }));
  });

  it('keeps threading headers when the original carried a message-id', async () => {
    const store = memStore();
    seedEmail(store, { 'message-id': '<abc@example.com>' });
    store.set('identities', JSON.stringify(['me@example.com']));
    const captured: SendInput[] = [];
    const deps = sendDeps(store, captured);
    const { ctx } = fakeCtx();
    const actions = aiDeps(store, stubLlm({ body: 'On my way.' }), deps);
    await handleDraftReplyButton(ctx, actions, 'em_1');
    await handleAiCallback(ctx, actions, 'ai:rok:1');
    expect(captured[0]!.headers?.['In-Reply-To']).toBe('<abc@example.com>');
  });

  it('does not double-send on a double-tapped approve', async () => {
    const store = memStore();
    seedEmail(store);
    store.set('identities', JSON.stringify(['me@example.com']));
    const captured: SendInput[] = [];
    const deps = sendDeps(store, captured);
    const { ctx } = fakeCtx();
    const actions = aiDeps(store, stubLlm({ body: 'Yes.' }), deps);
    await handleDraftReplyButton(ctx, actions, 'em_1');
    await handleAiCallback(ctx, actions, 'ai:rok:1');
    // The draft is consumed by the first approve; the second finds nothing.
    await handleAiCallback(ctx, actions, 'ai:rok:1');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.idempotencyKey).toBe('postwisp-ai-reply:1');
  });
});

describe('edit reply draft (ai:red)', () => {
  it('opens the compose flow prefilled with the draft', async () => {
    const store = memStore();
    seedEmail(store);
    store.set('identities', JSON.stringify(['me@example.com']));
    const { ctx, replies } = fakeCtx();
    const actions = aiDeps(store, stubLlm({ body: 'Draft text here.' }), sendDeps(store, []));
    await handleDraftReplyButton(ctx, actions, 'em_1');
    await handleAiCallback(ctx, actions, 'ai:red:1');
    // The wizard skips the body prompt and continues at the attachment step.
    expect(replies[replies.length - 1]!.text).toBe(t('bot.compose.attachQuestion'));
    expect(store.getReplyDraft(1)).toBeNull();
  });
});

describe('AI views', () => {
  it('escapes the unsure triage view', () => {
    const view = buildTriageUnsureView({
      triageId: 7,
      from: 'evil@example.com',
      subject: 'Hi <script>',
      category: 'newsletter',
      confidence: 0.623,
    });
    expect(view.text).toContain('&lt;script&gt;');
    expect(view.text).toContain('62% sure');
    expect(view.text).toContain('Suggested: archive (newsletter');
    const data = view.replyMarkup.inline_keyboard.flatMap((row) =>
      row.map((b) => (b as { callback_data?: string }).callback_data),
    );
    expect(data).toContain('ai:tok:7');
    expect(data).toContain('ai:tno:7');
  });

  it('builds the nudge view with snooze/dismiss callbacks', () => {
    const view = buildNudgeView({ sentId: 3, to: 'a@b.c', subject: 'Proposal', sentAtMs: 1000 });
    expect(view.text).toContain('a@b.c');
    const data = view.replyMarkup.inline_keyboard.flatMap((row) =>
      row.map((b) => (b as { callback_data?: string }).callback_data),
    );
    expect(data).toContain('ai:snz:3');
    expect(data).toContain('ai:dis:3');
  });
});

describe('triage approve/reject (ai:tok/ai:tno)', () => {
  const llm: LlmClient = { chatJson: async () => ({}) };

  function seedUnsure(store: Store, category: 'newsletter' | 'unsure'): number {
    store.saveFullEmail({
      id: 'em_9',
      provider: 'resend',
      domain: 'example.com',
      from: 'news@example.com',
      subject: 'Deals',
    });
    return store.recordTriage({
      emailId: 'em_9',
      category,
      confidence: 0.6,
      action: 'none',
      label: null,
      applied: false,
    });
  }

  it('approve applies the suggested action on an unsure item', async () => {
    const store = memStore();
    const triageId = seedUnsure(store, 'newsletter');
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, aiDeps(store, llm, null), `ai:tok:${triageId}`);
    expect(store.getEmailMeta('em_9')?.archived).toBe(true);
    expect(store.getTriage(triageId)?.applied).toBe(true);
    expect(replies[0]!.text).toContain('archive');
  });

  it('reject inverts the suggestion into a learned rule that fires later', async () => {
    const store = memStore();
    const triageId = seedUnsure(store, 'newsletter');
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, aiDeps(store, llm, null), `ai:tno:${triageId}`);
    expect(replies[0]!.text).toContain('keep mail from news@example.com');
    // End-to-end at the domain level: the learned rule fires through the
    // normal rules evaluation on a later email from that sender.
    const { evaluateRules } = await import('../src/core/inbox.js');
    expect(evaluateRules(store, { from: 'news@example.com', subject: 'More' }).labels).toContain(
      'ai-kept',
    );
  });

  it('reject on a suggestion-less unsure item only acknowledges', async () => {
    const store = memStore();
    const triageId = seedUnsure(store, 'unsure');
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, aiDeps(store, llm, null), `ai:tno:${triageId}`);
    expect(replies[0]!.text).toBe(t('bot.ai.triageRejected'));
    expect(store.ruleList()).toEqual([]);
  });

  it('approve on a suggestion-less unsure item applies nothing', async () => {
    const store = memStore();
    const triageId = seedUnsure(store, 'unsure');
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, aiDeps(store, llm, null), `ai:tok:${triageId}`);
    expect(store.getEmailMeta('em_9')?.archived).toBe(false);
    expect(replies[0]!.text).toContain('no action');
  });
});
