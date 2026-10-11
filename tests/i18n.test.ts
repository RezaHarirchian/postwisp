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
import { STRINGS, placeholders, t, type StringKey } from '../src/core/i18n.js';

describe('t', () => {
  it('returns the string for a known key', () => {
    expect(t('bot.menu.compose')).toBe('Compose');
  });

  it('replaces every placeholder with the given params', () => {
    expect(t('bot.settings.owner', { id: 42 })).toBe('Owner ID: 42');
  });

  it('leaves no braces behind when all params are supplied, for every string', () => {
    for (const key of Object.keys(STRINGS) as StringKey[]) {
      const params: Record<string, string> = {};
      for (const name of placeholders(STRINGS[key])) params[name] = 'x';
      expect(t(key, params)).not.toMatch(/[{}]/);
    }
  });

  it('rejects unknown keys at compile time, falls back to the key at runtime', () => {
    // @ts-expect-error — 'bot.nope' is not a valid string key
    expect(t('bot.nope')).toBe('bot.nope');
  });
});

describe('placeholders', () => {
  it('extracts placeholder names without duplicates', () => {
    expect(placeholders('a {x} b {y} c {x}')).toEqual(['x', 'y']);
    expect(placeholders('plain')).toEqual([]);
  });
});
