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

# Multi-stage build. The first stage compiles TypeScript and installs
# production dependencies; the second stage carries only what the daemon
# needs to run. No dev tools, no source, no secrets in the final image.

# --- builder ----------------------------------------------------------------
FROM node:20.20.2-trixie-slim AS builder

# better-sqlite3 ships prebuilt binaries for glibc, but building from source
# must still work if a prebuilt binary is missing for an architecture.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate \
  && pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY README.md LICENSE SECURITY.md PRIVACY.md ./
COPY docs/SETUP.md ./docs/SETUP.md
RUN pnpm build && pnpm prune --prod

# --- runtime -----------------------------------------------------------------
FROM node:20.20.2-trixie-slim AS runtime

LABEL org.opencontainers.image.title="postwisp" \
      org.opencontainers.image.source="https://github.com/RezaHarirchian/postwisp" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

# Non-root from the start: the daemon never needs root, and running as a
# dedicated user keeps the mounted config/data volumes owned sanely.
RUN groupadd -r postwisp && useradd -r -g postwisp -d /home/postwisp -m postwisp

WORKDIR /app
COPY --from=builder --chown=postwisp:postwisp /app/dist ./dist
COPY --from=builder --chown=postwisp:postwisp /app/node_modules ./node_modules
COPY --from=builder --chown=postwisp:postwisp /app/package.json ./
COPY --chown=postwisp:postwisp README.md LICENSE ./

USER postwisp

# The daemon listens on POSTWISP_SERVER_PORT (default 3000). Bind to all
# interfaces inside the container so the published port is reachable;
# the host firewall decides who may connect.
ENV POSTWISP_SERVER_HOST=0.0.0.0
EXPOSE 3000

# Health is the server's own readiness signal, not a TCP guess.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.POSTWISP_SERVER_PORT || '3000') + '/healthz').then(function (r) { process.exit(r.ok ? 0 : 1); }).catch(function () { process.exit(1); })"

# Daemon entry point: the webhook HTTP server plus the Telegram bot.
CMD ["node", "dist/index.js"]
