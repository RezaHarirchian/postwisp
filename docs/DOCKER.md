# Running postwisp in Docker

The image runs the postwisp daemon (webhook HTTP server on port 3000 plus
the Telegram bot) as a non-root user. No config is baked in: every secret
and setting arrives through environment variables or a mounted config file.

## Build (multi-arch)

BuildKit with buildx produces one image for both architectures:

```sh
docker buildx create --use --name postwisp-builder 2>/dev/null || true
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/rezaharirchian/postwisp:0.2.0 \
  --push .
```

## Run

The daemon reads the same `POSTWISP_*` environment variables as the bare
install, so the env-file approach from the setup guide works unchanged.
Never put secrets on the command line: they land in the shell history and
in `docker ps` output.

```sh
# env file: one KEY=value per line, chmod 600
docker run -d --name postwisp \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file /srv/postwisp/postwisp.env \
  -v postwisp-config:/home/postwisp/.config/postwisp \
  -v postwisp-data:/home/postwisp/.local/share/postwisp \
  ghcr.io/rezaharirchian/postwisp:0.2.0
```

Required env vars (minimum for a working instance):

```sh
POSTWISP_BOT_TOKEN=<token from @BotFather>
POSTWISP_OWNER_ID=<your numeric Telegram user id>
POSTWISP_EMAIL_PROVIDER=resend
POSTWISP_RESEND_API_KEY=<resend key>
POSTWISP_WEBHOOK_SECRET=<provider-issued webhook secret>
```

The named volumes keep state across container replacement:

- `postwisp-config` · the wizard's `config.json` (created by `postwisp setup`).
- `postwisp-data` · the SQLite database and attachments.

To run the interactive setup wizard once before starting the daemon:

```sh
docker run --rm -it --env-file /srv/postwisp/postwisp.env \
  -v postwisp-config:/home/postwisp/.config/postwisp \
  -v postwisp-data:/home/postwisp/.local/share/postwisp \
  --entrypoint node ghcr.io/rezaharirchian/postwisp:0.2.0 dist/cli/index.js setup
```

## Health and logs

```sh
curl http://localhost:3000/healthz
docker logs postwisp
```

The image also carries a built-in HEALTHCHECK on `/healthz` (30s interval),
so orchestrators and `docker ps` report the real state.

## Updating

```sh
docker pull ghcr.io/rezaharirchian/postwisp:<new-version>
docker stop postwisp && docker rm postwisp
# re-run the `docker run` from above with the new tag
```

Config and data live in the volumes, so updating is a stop/replace with
the same `-v` flags and nothing else.
