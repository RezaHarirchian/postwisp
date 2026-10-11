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

import { select } from '@clack/prompts';
import { t } from '../core/i18n.js';

interface MenuEntry {
  value: string;
  implemented: boolean;
}

export const MENU_ENTRIES: MenuEntry[] = [
  { value: 'setup', implemented: true },
  { value: 'status', implemented: true },
  { value: 'domains', implemented: true },
  { value: 'telegram', implemented: true },
  { value: 'update', implemented: true },
  { value: 'doctor', implemented: true },
  { value: 'logs', implemented: true },
  { value: 'config', implemented: true },
];

export function menuTextList(): string {
  return MENU_ENTRIES.map((e) => `- ${e.value}${e.implemented ? '' : ` (${t('cli.menu.laterPhase')})`}`).join('\n');
}

// Bare `postwisp` opens this menu. Outside a TTY there is no interactive
// prompt to render, so a plain list is printed instead of crashing.
export async function showMenu(run: (command: string) => Promise<void> | void): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(menuTextList());
    return;
  }
  const choice = await select({
    message: t('cli.menu.choose'),
    options: MENU_ENTRIES.map((e) => ({
      value: e.value,
      label: e.value,
      ...(e.implemented ? {} : { hint: t('cli.menu.laterPhase') }),
    })),
  });
  if (typeof choice === 'string') {
    const entry = MENU_ENTRIES.find((e) => e.value === choice);
    if (entry?.implemented) {
      await run(choice);
    } else {
      console.log(`${choice}: ${t('cli.menu.laterPhase')}.`);
    }
  }
}
