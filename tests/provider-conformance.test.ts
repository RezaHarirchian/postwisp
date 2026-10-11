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

import { describe, expect, it } from 'vitest';
import type { EmailProvider } from '../src/providers/interface.js';
import { ResendEmailProvider } from '../src/providers/resend.js';
import { MailerSendProvider } from '../src/providers/mailersend.js';
import { MailgunProvider } from '../src/providers/mailgun.js';

// Type-level conformance: this assignment fails to compile if any adapter
// drifts from the frozen v1 EmailProvider contract. Every adapter must
// appear here exactly once.
const ADAPTERS: EmailProvider[] = [
  new ResendEmailProvider({ apiKey: 'conformance' }),
  new MailerSendProvider({ apiKey: 'conformance' }),
  new MailgunProvider({ apiKey: 'conformance' }),
];

describe('provider conformance (frozen v1 contract)', () => {
  it('every adapter is a structural EmailProvider', () => {
    for (const adapter of ADAPTERS) {
      expect(typeof adapter.name).toBe('string');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.getInboundEmail).toBe('function');
      expect(typeof adapter.downloadAttachment).toBe('function');
      expect(typeof adapter.listSentEmails).toBe('function');
      expect(typeof adapter.verifyWebhook).toBe('function');
    }
  });

  it('adapter names are unique non-empty strings', () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('capabilities flags are booleans', () => {
    for (const adapter of ADAPTERS) {
      expect(typeof adapter.capabilities.scheduling).toBe('boolean');
      expect(typeof adapter.capabilities.batch).toBe('boolean');
    }
  });

  it('verifyWebhook never throws and returns a reason on rejection', () => {
    for (const adapter of ADAPTERS) {
      const result = adapter.verifyWebhook(Buffer.from('x'), {}, 'secret');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
