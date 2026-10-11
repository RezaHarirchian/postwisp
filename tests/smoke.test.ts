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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { startSystem } from '../src/index.js';

// Boots the real system on an ephemeral port with no bot credentials and
// hits it over real HTTP. The bot stays down gracefully; the server answers.
describe('system wiring', () => {
  it('serves /healthz with no bot configured', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'postwisp-smoke-'));
    const config = { ...defaultConfig(), dataDir, serverPort: 0, serverHost: '127.0.0.1' };
    const logger = createLogger({ level: 'error' });

    const system = await startSystem(config, logger);
    try {
      expect(system.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${system.port}/healthz`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      await system.stop();
    }
  });
});
