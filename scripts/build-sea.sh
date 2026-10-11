#!/usr/bin/env bash
# postwisp — self-hosted Telegram email manager
# Copyright (C) 2026 Reza Harirchian
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# Builds a single-file postwisp executable using Node's Single Executable
# Application (SEA) support. Run on each target platform (the binary is
# just a Node runtime with the app baked in, so it is platform-specific).
#
# Output: dist/sea/postwisp-<os>-<arch> plus dist/sea/node_modules/
# (the native SQLite binding, which cannot live inside the snapshot).
# The two must be distributed together; the binary loads the binding
# from its own directory at startup.
#
# Usage: ./scripts/build-sea.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/sea"
SHIM="$ROOT/scripts/sea-shim-better-sqlite3.cjs"

# --- prerequisites -----------------------------------------------------------
# SEA needs Node 20+. The fuse string postject looks for differs between
# Node builds, so it is read out of the actual binary instead of hardcoded.
node --version >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "error: node >= 20 required (found $(node --version))" >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "error: npx not found on PATH" >&2; exit 1; }

# The bundle is built from compiled output, never from src directly, so a
# stale dist would silently ship old code. Rebuild when in doubt.
if [ ! -f "$ROOT/dist/cli/index.js" ]; then
  echo "dist/ missing, running pnpm build first..."
  (cd "$ROOT" && pnpm build)
fi
[ -d "$ROOT/node_modules/better-sqlite3" ] || { echo "error: node_modules/better-sqlite3 missing; run pnpm install" >&2; exit 1; }

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
NAME="postwisp-${OS}-${ARCH}"

rm -rf "$OUT"
mkdir -p "$OUT/work"

# --- bundle ------------------------------------------------------------------
# Everything is bundled into one CJS file. CJS, not ESM: Node's SEA runner
# executes the snapshot main as CommonJS on every supported version.
# better-sqlite3 is aliased to a tiny shim (not bundled, not left as a bare
# external): the shim re-requires the real package from the filesystem next
# to the binary, which is the only way a native addon can load in SEA.
echo "bundling..."
npx -y esbuild@0.25.0 "$ROOT/dist/cli/index.js" \
  --bundle --platform=node --format=cjs \
  --alias:better-sqlite3="$SHIM" \
  --outfile="$OUT/work/bundle.cjs" \
  --log-level=warning

# --- SEA blob ----------------------------------------------------------------
cat > "$OUT/work/sea-config.json" <<EOF
{
  "main": "$OUT/work/bundle.cjs",
  "output": "$OUT/work/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF
echo "generating SEA blob..."
node --experimental-sea-config "$OUT/work/sea-config.json"

# --- inject ------------------------------------------------------------------
NODE_BIN="$(command -v node)"
FUSE="$(strings -a "$NODE_BIN" | grep -o 'NODE_SEA_FUSE[a-z0-9_]*' | sort -u | head -n 1)"
[ -n "$FUSE" ] || { echo "error: no SEA fuse string found in $NODE_BIN" >&2; exit 1; }

cp "$NODE_BIN" "$OUT/work/$NAME"
# On macOS the copied runtime keeps Apple's signature, which breaks
# injection; an unsigned copy is fine because we are not distributing
# Apple's binary as Apple.
if [ "$OS" = "darwin" ]; then
  codesign --remove-signature "$OUT/work/$NAME"
fi
echo "injecting blob into node binary..."
# Pinned like esbuild above, so the SEA build is reproducible instead of
# floating on whatever npx resolves that day.
npx -y postject@1.0.0-alpha.6 "$OUT/work/$NAME" NODE_SEA_BLOB "$OUT/work/sea-prep.blob" \
  --sentinel-fuse "$FUSE" >/dev/null
chmod +x "$OUT/work/$NAME"

# --- sidecar -----------------------------------------------------------------
# The native binding ships beside the binary; the shim resolves it starting
# from the binary's own directory. Installed via pnpm on this machine, so
# the .node file already matches this platform.
mkdir -p "$OUT/node_modules"
cp -r "$ROOT/node_modules/better-sqlite3" "$OUT/node_modules/"
mv "$OUT/work/$NAME" "$OUT/$NAME"
rm -rf "$OUT/work"

# --- verify ------------------------------------------------------------------
echo "verifying..."
"./dist/sea/$NAME" --version || { echo "error: built binary failed to run" >&2; exit 1; }
(cd "$ROOT" && "./dist/sea/$NAME" --version >/dev/null) || exit 1

echo "done: dist/sea/$NAME"
echo "ship dist/sea/$NAME together with dist/sea/node_modules/"
