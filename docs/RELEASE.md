# postwisp release guide

How to cut a postwisp release and publish its artifacts: the npm package,
the Docker image, and the single-file binary. Everything below is manual
on purpose: the final steps need Reza's interactive login, GPG key, and
GitHub access.

## Before every release

1. Decide the version (semver). Bump it in both places:
   - `package.json` `"version"`
   - `src/core/version.ts` `VERSION`
   A test pins them together; if they drift, the suite fails.
2. Make sure the worktree is clean and `main` is pushed.
3. Run the full gate locally: `pnpm typecheck && pnpm test && pnpm build`.

## 1. npm package

Prep is automated via the `prepublishOnly` hook: every `npm publish`
runs typecheck, tests, and the build first. Nothing extra to remember.

Publish steps (run by Reza on his machine):

```sh
# interactive login · npm will prompt in the browser
npm login
# sanity check: inspect the tarball that will go out
npm pack
tar -tzf postwisp-<version>.tgz
# ship it
npm publish
```

The published tarball contains only `dist/`, the README, LICENSE,
SECURITY.md, PRIVACY.md, and `docs/SETUP.md` (the `files` list in
package.json). `node_modules`, tests, and source stay out.

After publishing, the CLI is runnable everywhere as `postwisp`:

```sh
npm install -g postwisp
postwisp --version
```

## 2. Single-file binary (Node SEA)

`scripts/build-sea.sh` builds a self-contained executable using Node's
Single Executable Application support. Run it on each target platform
(Linux x64, Linux arm64, macOS arm64) from a machine running Node >= 20:

```sh
./scripts/build-sea.sh
# output: dist/sea/postwisp-linux-x64  (name varies by platform)
./dist/sea/postwisp-linux-x64 --version
```

How it works: esbuild bundles `dist/` into one CJS file (Node's SEA
runner executes the snapshot main as CommonJS), `node
--experimental-sea-config` turns it into a blob, and postject injects the
blob into a copy of the local Node binary. The sentinel fuse string is
read out of the Node binary itself, so the script keeps working when the
fuse changes between Node releases.

One known limitation: better-sqlite3 is a native module, and Node's SEA
cannot embed native addons. The bundle aliases it to
`scripts/sea-shim-better-sqlite3.cjs`, which loads the real package from
the filesystem next to the binary. The build script copies
`node_modules/better-sqlite3` into `dist/sea/node_modules/` automatically;
the binary and that directory must be distributed together.

## 3. Docker image

Built with buildx for linux/amd64 and linux/arm64. See `docs/DOCKER.md`
for the full instructions; the short version:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/rezaharirchian/postwisp:<version> \
  --push .
```

## 4. Signed tag and GitHub Release (Reza only)

1. Create and push the signed tag from Reza's machine (needs his GPG key):
   `git tag -s v<version> -m "postwisp <version>" && git push origin v<version>`
2. Create the GitHub Release for the tag and attach the SEA binaries.
3. Verify: install from npm, from the Docker image, and from the binary
   on a clean machine, then `postwisp setup`.
