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

import { t } from '../../core/i18n.js';
import { configFilePath, type PostwispConfig } from '../../core/config.js';

// Plain-language status in the style of `gh auth status`: a human can tell
// in one glance whether postwisp works. Secrets are never printed.
export function statusText(config: PostwispConfig): string {
  const configured = config.ownerId !== null && config.botToken !== null;
  const lines = [configured ? t('cli.status.ok') : t('cli.status.notConfigured')];
  lines.push(`${t('cli.status.configFile')}: ${configFilePath()}`);
  lines.push(
    `${t('cli.status.owner')}: ${config.ownerId !== null ? config.ownerId : t('cli.status.notSet')}`,
  );
  lines.push(`${t('cli.status.dataDir')}: ${config.dataDir}`);
  return lines.join('\n');
}
