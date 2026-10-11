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

// SEA-only shim for better-sqlite3. Node's single-executable loader cannot
// resolve native addons from inside the snapshot, so the SEA bundle aliases
// better-sqlite3 to this file. At runtime it loads the real package from
// the filesystem next to the executable (dist/sea/node_modules), using a
// filesystem-backed require anchored at the binary's own directory.
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const fsRequire = createRequire(join(dirname(process.execPath), 'package.json'));

module.exports = fsRequire('better-sqlite3');
