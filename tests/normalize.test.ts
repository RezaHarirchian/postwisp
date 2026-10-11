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
import { snippetOf } from '../src/providers/normalize.js';

describe('snippetOf', () => {
  it('collapses whitespace and trims', () => {
    expect(snippetOf('  hello   \n  world  ')).toBe('hello world');
  });

  it('leaves short text alone', () => {
    expect(snippetOf('short')).toBe('short');
  });

  it('cuts at exactly 200 units for plain ASCII', () => {
    expect(snippetOf('a'.repeat(300))).toBe('a'.repeat(200));
  });

  it('never splits a surrogate pair: backs off instead of stranding a lead surrogate', () => {
    // U+1F600 is a surrogate pair in UTF-16; cutting at 200 would leave a
    // lone lead surrogate, which renders as U+FFFD downstream.
    const text = 'x'.repeat(199) + '😀' + 'y'.repeat(50);
    const out = snippetOf(text);
    expect(out).toBe('x'.repeat(199));
    expect(out).not.toContain('�');
  });

  it('keeps a pair that ends exactly on the boundary', () => {
    const text = 'x'.repeat(198) + '😀' + 'y'.repeat(50);
    expect(snippetOf(text)).toBe('x'.repeat(198) + '😀');
  });
});
