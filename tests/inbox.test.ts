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

import { afterEach, describe, expect, it } from 'vitest';
import {
  addRule,
  allowAddress,
  blockAddress,
  deleteRule,
  dueSnoozed,
  evaluateRules,
  extractOtp,
  isAllowlisted,
  isBlocked,
  listRules,
  parseSearch,
  setRuleEnabled,
  snoozeEmail,
  unlistAddress,
  unsnoozeEmail,
} from '../src/core/inbox.js';
import { openStore, type Store } from '../src/core/store.js';

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

describe('parseSearch', () => {
  it('parses all operators with trailing text', () => {
    expect(parseSearch('from:boss subject:invoice has:attachment urgent')).toEqual({
      from: 'boss',
      subject: 'invoice',
      hasAttachment: true,
      text: 'urgent',
    });
  });

  it('returns an empty query for blank input', () => {
    expect(parseSearch('   ')).toEqual({});
  });

  it('treats unmatched text as a text search', () => {
    expect(parseSearch('quarterly report')).toEqual({ text: 'quarterly report' });
  });

  it('keeps quoted multi-word values intact', () => {
    expect(parseSearch('subject:"board meeting" from:"Jane Doe"')).toEqual({
      subject: 'board meeting',
      from: 'Jane Doe',
    });
  });

  it('matches operator names case-insensitively', () => {
    expect(parseSearch('FROM:Boss HAS:Attachment')).toEqual({
      from: 'Boss',
      hasAttachment: true,
    });
  });

  it('keeps unknown has: values as plain text instead of dropping them', () => {
    expect(parseSearch('has:image cats')).toEqual({ text: 'has:image cats' });
  });

  it('ignores an operator with an empty value instead of matching everything', () => {
    // A bare `subject:` used to compile to LIKE '%%' (match-all).
    expect(parseSearch('from:')).toEqual({});
    expect(parseSearch('subject: invoice')).toEqual({ text: 'invoice' });
  });
});

describe('filter rules', () => {
  it('supports full CRUD on rules', () => {
    const s = memStore();
    const id = addRule(s, {
      name: 'newsletters',
      matchFrom: 'news@',
      action: 'label',
      actionArg: 'newsletter',
    });
    expect(typeof id).toBe('number');
    expect(listRules(s)).toEqual([
      {
        id,
        name: 'newsletters',
        matchFrom: 'news@',
        matchSubject: null,
        action: 'label',
        actionArg: 'newsletter',
        enabled: true,
      },
    ]);
    setRuleEnabled(s, id, false);
    expect(listRules(s)[0]?.enabled).toBe(false);
    setRuleEnabled(s, id, true);
    expect(listRules(s)[0]?.enabled).toBe(true);
    deleteRule(s, id);
    expect(listRules(s)).toEqual([]);
  });

  it('evaluates label, archive and silent actions in id order', () => {
    const s = memStore();
    addRule(s, { name: 'l', matchSubject: 'invoice', action: 'label', actionArg: 'finance' });
    addRule(s, { name: 'a', matchFrom: 'boss@', action: 'archive' });
    addRule(s, { name: 's', matchFrom: 'noreply@', action: 'silent' });
    const out = evaluateRules(s, { from: 'boss@corp.com', subject: 'Invoice due' });
    expect(out).toEqual({ silent: false, archive: true, labels: ['finance'], autoreply: null });
  });

  it('matches case-insensitively and treats null matchers as match-all', () => {
    const s = memStore();
    addRule(s, { name: 'all', action: 'label', actionArg: 'seen' });
    const out = evaluateRules(s, { from: 'Anyone@x.com', subject: 'Whatever' });
    expect(out.labels).toEqual(['seen']);
  });

  it('skips disabled rules', () => {
    const s = memStore();
    const id = addRule(s, { name: 'x', action: 'archive' });
    setRuleEnabled(s, id, false);
    expect(evaluateRules(s, { from: 'a@b.c', subject: 'hi' }).archive).toBe(false);
  });

  it("normalizes empty-string matchers to null at write time", () => {
    const s = memStore();
    const id = addRule(s, { name: 'x', matchFrom: '', matchSubject: '', action: 'archive' });
    expect(listRules(s)[0]).toMatchObject({ id, matchFrom: null, matchSubject: null });
    // Still behaves as match-all, but the stored rule says what it means.
    expect(evaluateRules(s, { from: 'a@b.c', subject: 'hi' }).archive).toBe(true);
  });

  it('skips rules with an unknown action loudly instead of silently', () => {
    const s = memStore();
    // Bypass addRule's typing to simulate a tampered row.
    s.ruleAdd('evil', null, null, 'drop-table', null);
    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    let out;
    try {
      out = evaluateRules(s, { from: 'a@b.c', subject: 'hi' });
    } finally {
      console.warn = orig;
    }
    expect(out).toEqual({ silent: false, archive: false, labels: [], autoreply: null });
    expect(warns.length).toBeGreaterThan(0);
    expect(String(warns[0]![0])).toContain('unknown action');
  });

  it('keeps the first matching autoreply and ignores later ones', () => {
    const s = memStore();
    addRule(s, { name: 'r1', action: 'autoreply', actionArg: 'First reply' });
    addRule(s, { name: 'r2', action: 'autoreply', actionArg: 'Second reply' });
    expect(evaluateRules(s, { from: 'a@b.c', subject: 'hi' }).autoreply).toBe('First reply');
  });

  it('returns a quiet default when nothing matches', () => {
    const s = memStore();
    addRule(s, { name: 'x', matchFrom: 'zzz', action: 'archive' });
    expect(evaluateRules(s, { from: 'a@b.c', subject: 'hi' })).toEqual({
      silent: false,
      archive: false,
      labels: [],
      autoreply: null,
    });
  });

  it('ignores rules whose action argument is missing', () => {
    const s = memStore();
    addRule(s, { name: 'x', action: 'label' });
    addRule(s, { name: 'y', action: 'autoreply' });
    const out = evaluateRules(s, { from: 'a@b.c', subject: 'hi' });
    expect(out.labels).toEqual([]);
    expect(out.autoreply).toBeNull();
  });
});

describe('snooze', () => {
  function seededSnooze(): Store {
    const s = memStore();
    s.saveEmailMeta({
      id: 'a',
      provider: 'resend',
      domain: 'example.com',
      fromAddr: 'a@x.com',
      subject: 'one',
      receivedAt: 100,
      read: false,
      archived: false,
      trashed: false,
      labels: [],
      threadId: null,
    });
    s.saveEmailMeta({
      id: 'b',
      provider: 'resend',
      domain: 'example.com',
      fromAddr: 'b@x.com',
      subject: 'two',
      receivedAt: 200,
      read: false,
      archived: false,
      trashed: false,
      labels: [],
      threadId: null,
    });
    return s;
  }

  it('resurfaces snoozed mail once its time is due', () => {
    const s = seededSnooze();
    snoozeEmail(s, 'a', 1000);
    snoozeEmail(s, 'b', 5000);
    expect(dueSnoozed(s, 999)).toEqual([]);
    expect(dueSnoozed(s, 1000).map((e) => e.id)).toEqual(['a']);
    expect(dueSnoozed(s, 5000).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('unsnoozing removes mail from the due list', () => {
    const s = seededSnooze();
    snoozeEmail(s, 'a', 1000);
    unsnoozeEmail(s, 'a');
    expect(dueSnoozed(s, 2000)).toEqual([]);
    expect(s.getEmailMeta('a')?.snoozedUntilMs).toBeNull();
  });

  it('never returns trashed mail', () => {
    const s = seededSnooze();
    snoozeEmail(s, 'a', 1000);
    s.saveEmailMeta({
      id: 'a',
      provider: 'resend',
      domain: 'example.com',
      fromAddr: 'a@x.com',
      subject: 'one',
      receivedAt: 100,
      read: false,
      archived: false,
      trashed: true,
      labels: [],
      threadId: null,
    });
    expect(dueSnoozed(s, 2000)).toEqual([]);
  });
});

describe('blocklist and allowlist', () => {
  it('blocks and unlists addresses', () => {
    const s = memStore();
    expect(isBlocked(s, 'spam@evil.com')).toBe(false);
    blockAddress(s, 'spam@evil.com');
    expect(isBlocked(s, 'spam@evil.com')).toBe(true);
    unlistAddress(s, 'spam@evil.com');
    expect(isBlocked(s, 'spam@evil.com')).toBe(false);
  });

  it('lets the allowlist override the blocklist', () => {
    const s = memStore();
    blockAddress(s, 'boss@corp.com');
    allowAddress(s, 'boss@corp.com');
    expect(isBlocked(s, 'boss@corp.com')).toBe(false);
    expect(isAllowlisted(s, 'boss@corp.com')).toBe(true);
    // And blocking again after allowing flips it back.
    blockAddress(s, 'boss@corp.com');
    expect(isBlocked(s, 'boss@corp.com')).toBe(true);
    expect(isAllowlisted(s, 'boss@corp.com')).toBe(false);
  });

  it('normalizes addresses before comparing', () => {
    const s = memStore();
    blockAddress(s, '  Spammer@Evil.COM ');
    expect(isBlocked(s, 'spammer@evil.com')).toBe(true);
    expect(isBlocked(s, 'SPAMMER@EVIL.COM')).toBe(true);
    unlistAddress(s, 'Spammer@evil.com');
    expect(isBlocked(s, 'spammer@evil.com')).toBe(false);
  });

  it('unlisting an unknown address is a no-op', () => {
    const s = memStore();
    expect(() => unlistAddress(s, 'nobody@x.com')).not.toThrow();
  });
});

describe('extractOtp', () => {
  it('finds 4-8 digit codes', () => {
    expect(extractOtp('Your code is 4821.')).toEqual(['4821']);
    expect(extractOtp('Code: 12345678 expires soon')).toEqual(['12345678']);
  });

  it('rejects codes embedded in longer digit runs', () => {
    expect(extractOtp('ref 123456789')).toEqual([]);
    expect(extractOtp('123 and 1234')).toEqual(['1234']);
  });

  it('rejects runs shorter than 4 digits', () => {
    expect(extractOtp('call 123 now')).toEqual([]);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(extractOtp('4821 then 993412 then 4821 again')).toEqual(['4821', '993412']);
  });

  it('handles codes next to punctuation and line breaks', () => {
    expect(extractOtp('(OTP: 77-00-11)')).toEqual([]);
    expect(extractOtp('OTP:\n  550213  \nthanks')).toEqual(['550213']);
  });

  it('returns an empty array when there is no code', () => {
    expect(extractOtp('no codes here')).toEqual([]);
    expect(extractOtp('')).toEqual([]);
  });
});
