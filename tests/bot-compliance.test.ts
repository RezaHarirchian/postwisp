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

import type { Context } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/core/store.js';
import {
  handleComplianceCallback,
  settingsComplianceKeyboard,
  type ComplianceDeps,
} from '../src/bot/compliance.js';

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function memStore(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}

interface CapturedReply {
  text: string;
  extra?: Record<string, unknown>;
}

function fakeCtx() {
  const replies: CapturedReply[] = [];
  const ctx = {
    reply: async (text: string, extra?: Record<string, unknown>) => {
      replies.push({ text, extra });
      return { message_id: 1 };
    },
  } as unknown as Context;
  return { ctx, replies };
}

function depsFor(store: Store): { deps: ComplianceDeps; wiped: string[] } {
  const wiped: string[] = [];
  const deps: ComplianceDeps = {
    store,
    wipeData: () => {
      wiped.push('wiped');
      store.wipeAllData();
    },
    backToSettings: async () => {},
  };
  return { deps, wiped };
}

describe('settingsComplianceKeyboard', () => {
  it('exposes the suppression list and data buttons', () => {
    const kb = settingsComplianceKeyboard();
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Suppression list');
    expect(labels).toContain('Data & privacy');
  });
});

describe('handleComplianceCallback', () => {
  it('shows the empty suppression list', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    expect(await handleComplianceCallback(ctx, deps, 'sup:list')).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('empty');
  });

  it('lists suppressed addresses with remove buttons', async () => {
    const store = memStore();
    store.suppressAddress('bounced@example.org', 'hard bounce');
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    await handleComplianceCallback(ctx, deps, 'sup:list');
    expect(replies[0]?.text).toContain('bounced@example.org');
    expect(replies[0]?.text).toContain('hard bounce');
  });

  it('removes an address and logs the owner override', async () => {
    const store = memStore();
    store.suppressAddress('bounced@example.org', 'hard bounce');
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    await handleComplianceCallback(ctx, deps, 'sup:rm:bounced@example.org');
    expect(store.isSuppressed('bounced@example.org')).toBe(false);
    expect(replies[0]?.text).toContain('removed from the suppression list');
    // The list is re-shown afterwards.
    expect(replies[1]?.text).toContain('empty');
    const log = store.listConsentLog(10);
    expect(log[0]?.event).toBe('unsuppress');
    expect(log[0]?.address).toBe('bounced@example.org');
  });

  it('removes the right address when the list changed since render (no index TOCTOU)', async () => {
    const store = memStore();
    store.suppressAddress('a@example.org', 'hard bounce');
    store.suppressAddress('b@example.org', 'complaint');
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    // Render the list, then the list changes (b is removed elsewhere).
    await handleComplianceCallback(ctx, deps, 'sup:list');
    store.unsuppressAddress('b@example.org');
    store.suppressAddress('c@example.org', 'hard bounce');
    // The stale tap still names a@example.org, not "index 0".
    await handleComplianceCallback(ctx, deps, 'sup:rm:a@example.org');
    expect(store.isSuppressed('a@example.org')).toBe(false);
    expect(store.isSuppressed('c@example.org')).toBe(true);
    expect(replies[replies.length - 2]?.text).toContain('a@example.org');
  });

  it('removes an over-long address via its hash form', async () => {
    const store = memStore();
    const longAddr = `${'a'.repeat(50)}@${'b'.repeat(40)}.example.org`;
    expect(`sup:rm:${longAddr}`.length).toBeGreaterThan(64);
    store.suppressAddress(longAddr, 'hard bounce');
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    // Read the hash-form callback the list rendered.
    await handleComplianceCallback(ctx, deps, 'sup:list');
    const last = replies[replies.length - 1]!;
    const kb = last.extra?.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const rmData = (kb?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data ?? '')
      .find((d) => d.startsWith('sup:rmh:'));
    expect(rmData).toBeDefined();
    expect(Buffer.byteLength(rmData!, 'utf8')).toBeLessThanOrEqual(64);

    await handleComplianceCallback(ctx, deps, rmData!);
    expect(store.isSuppressed(longAddr)).toBe(false);
  });

  it('ignores a removal tap for an address that already left the list', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    await handleComplianceCallback(ctx, deps, 'sup:rm:ghost@example.org');
    // No removal reply, just the re-shown (empty) list.
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('empty');
  });

  it('clears the whole list only after confirmation', async () => {
    const store = memStore();
    store.suppressAddress('a@example.org', 'hard bounce');
    store.suppressAddress('b@example.org', 'complaint');
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    await handleComplianceCallback(ctx, deps, 'sup:clear');
    expect(store.isSuppressed('a@example.org')).toBe(true);
    expect(replies[0]?.text).toContain('Remove all 2 addresses');

    await handleComplianceCallback(ctx, deps, 'sup:clear:yes');
    expect(store.isSuppressed('a@example.org')).toBe(false);
    expect(store.isSuppressed('b@example.org')).toBe(false);
    expect(replies.some((r) => r.text.includes('cleared'))).toBe(true);
  });

  it('counts the full clear scope, not just the displayed page', async () => {
    const store = memStore();
    for (let i = 0; i < 21; i++) {
      store.suppressAddress(`user${i}@example.org`, 'hard bounce');
    }
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);

    await handleComplianceCallback(ctx, deps, 'sup:clear');
    // The confirm screen must count what 'yes' will clear (21), not the
    // 20-row display page.
    expect(replies[0]?.text).toContain('Remove all 21 addresses');

    await handleComplianceCallback(ctx, deps, 'sup:clear:yes');
    expect(store.listSuppressed(1000)).toHaveLength(0);
  });

  it('shows the data screen, the audit log, and wipes on double confirmation', async () => {
    const store = memStore();
    store.set('k', 'v');
    store.logConsent('unsubscribe', 'r@example.org', 'one-click');
    const { ctx, replies } = fakeCtx();
    const { deps, wiped } = depsFor(store);

    await handleComplianceCallback(ctx, deps, 'data:home');
    // The title is HTML-escaped for parse_mode=HTML.
    expect(replies[0]?.text).toContain('Data &amp; privacy');

    await handleComplianceCallback(ctx, deps, 'data:audit');
    expect(replies[1]?.text).toContain('r@example.org');
    expect(replies[1]?.text).toContain('unsubscribe');

    await handleComplianceCallback(ctx, deps, 'data:wipe');
    expect(wiped).toHaveLength(0);
    expect(replies[2]?.text).toContain('cannot be undone');

    await handleComplianceCallback(ctx, deps, 'data:wipe:yes');
    expect(wiped).toHaveLength(1);
    expect(store.get('k')).toBeNull();
    expect(replies[3]?.text).toContain('deleted');
  });

  it('returns to settings on set:home', async () => {
    const store = memStore();
    const { ctx } = fakeCtx();
    const holder = depsFor(store);
    let backs = 0;
    holder.deps.backToSettings = async () => {
      backs++;
    };
    expect(await handleComplianceCallback(ctx, holder.deps, 'set:home')).toBe(true);
    expect(backs).toBe(1);
  });

  it('ignores unknown callbacks', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    const { deps } = depsFor(store);
    expect(await handleComplianceCallback(ctx, deps, 'sup:nope')).toBe(false);
    expect(replies).toHaveLength(0);
  });
});
