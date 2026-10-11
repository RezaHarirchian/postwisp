#!/bin/sh
# postwisp installer — POSIX sh, no bashisms.
# Installs Node.js 20+ (if missing) and the postwisp CLI, then verifies it.
# Safe to re-run: every step checks the current state first and skips work
# that is already done. This script never asks for or prints any secret;
# all credentials are entered later through `postwisp setup`.
#
# Usage:  curl -fsSL https://raw.githubusercontent.com/RezaHarirchian/postwisp/main/install.sh | sh
#     or: sh install.sh
set -eu

# Pinned Node for the tarball fallback. Pinned, not "latest", so two runs a
# month apart produce the same runtime and the same behavior.
NODE_VERSION="22.21.0"

# Root is needed for system package installs and npm -g. Prefer sudo when
# available so the script also works for non-root users.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  echo "error: run as root or install sudo first" >&2
  exit 1
fi

node_ok() {
  # True when a new-enough node is already usable: the common re-run case.
  command -v node >/dev/null 2>&1 || return 1
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$major" -ge 20 ]
}

sha256_of() {
  # Portable SHA-256: sha256sum on Linux, shasum on macOS/BSD.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: need sha256sum or shasum to verify the Node tarball" >&2
    exit 1
  fi
}

install_node_tarball() {
  # Last resort that works on any distro: the official prebuilt binary
  # needs nothing but curl and a matching libc, which every target has.
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "error: unsupported architecture $arch" >&2; exit 1 ;;
  esac
  echo "installing Node $NODE_VERSION from nodejs.org..."
  tmp=$(mktemp -d)
  # The trap guarantees no temp dir is left behind even if the download fails.
  trap 'rm -rf "$tmp"' EXIT INT TERM
  url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz"
  curl -fsSL "$url" -o "$tmp/node.tar.xz"
  # The tarball is extracted as root: verify its SHA-256 against the
  # checksum file nodejs.org publishes before trusting it.
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  expected=$(grep "node-v$NODE_VERSION-linux-$arch.tar.xz" "$tmp/SHASUMS256.txt" | awk '{print $1}')
  actual=$(sha256_of "$tmp/node.tar.xz")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "error: checksum mismatch for the Node tarball (expected ${expected:-unknown}, got $actual); refusing to install" >&2
    exit 1
  fi
  echo "Node tarball checksum verified"
  # --strip-components drops the versioned top-level dir so bin/, lib/,
  # include/ land directly in /usr/local, shadowing nothing else.
  $SUDO tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
  trap - EXIT INT TERM
}

install_node_pm() {
  # Each branch below is the least surprising native path on that family.
  # NodeSource (apt/dnf) exists because distro repos lag: Debian's nodejs
  # is routinely years behind, and postwisp needs >= 20.
  if command -v apt-get >/dev/null 2>&1; then
    echo "installing Node 20 via NodeSource (apt)..."
    $SUDO apt-get update -y
    $SUDO apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    echo "installing Node 20 via NodeSource (dnf)..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO dnf install -y nodejs
  elif command -v pacman >/dev/null 2>&1; then
    echo "installing Node via pacman..."
    $SUDO pacman -Sy --noconfirm nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    echo "installing Node via apk..."
    $SUDO apk add --no-cache nodejs npm
  else
    return 1
  fi
}

ensure_node() {
  if node_ok; then
    echo "node $(node --version) already installed, skipping"
    return 0
  fi
  # Try the native package manager first; fall back to the tarball when
  # there is no known manager or it still leaves node too old/missing.
  install_node_pm || true
  if ! node_ok; then
    install_node_tarball
  fi
  node_ok || { echo "error: node installation did not produce node >= 20" >&2; exit 1; }
  echo "node $(node --version) ready"
}

ensure_postwisp() {
  # npm -g is idempotent by itself: re-running upgrades or no-ops.
  echo "installing postwisp..."
  # The install prefix may not be on PATH for this shell (fresh /usr/local
  # bin); export it for the verification step below, not just the user.
  case ":$PATH:" in
    *:/usr/local/bin:*) ;;
    *) export PATH="/usr/local/bin:$PATH" ;;
  esac
  $SUDO npm install -g postwisp
  # hash -r drops the shell's cached command locations so the just-installed
  # binary is found even if a previous lookup failed.
  hash -r 2>/dev/null || true
  command -v postwisp >/dev/null 2>&1 || {
    echo "error: postwisp installed but not on PATH; add $(npm root -g 2>/dev/null)/.bin or /usr/local/bin to PATH" >&2
    exit 1
  }
  echo "postwisp $(postwisp --version) installed"
}

main() {
  ensure_node
  ensure_postwisp
  echo ""
  echo "Done. Next steps:"
  echo "  1. postwisp setup    # guided wizard: Telegram bot, email provider, domains"
  echo "  2. postwisp doctor   # verifies everything is wired up"
  echo ""
  echo "Setup guide: https://github.com/RezaHarirchian/postwisp/blob/main/docs/SETUP.md"
}

main "$@"
