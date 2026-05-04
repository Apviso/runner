#!/bin/sh
set -eu

PACKAGE_NAME="${APVISO_RUNNER_PACKAGE:-@apviso/runner}"
PACKAGE_VERSION="${APVISO_RUNNER_VERSION:-}"
INSTALL_ONLY="${APVISO_INSTALL_ONLY:-0}"

if [ -n "$PACKAGE_VERSION" ]; then
  PACKAGE_SPEC="${PACKAGE_NAME}@${PACKAGE_VERSION}"
else
  PACKAGE_SPEC="$PACKAGE_NAME"
fi

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'apviso install: %s\n' "$*" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22 or newer is required. Install Node.js, then rerun this installer."
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    fail "Could not detect the installed Node.js version."
    ;;
esac

if [ "$NODE_MAJOR" -lt 22 ]; then
  NODE_VERSION="$(node --version 2>/dev/null || printf 'unknown')"
  fail "Node.js 22 or newer is required; found ${NODE_VERSION}."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is required to install APVISO Runner. Install npm, then rerun this installer."
fi

say "Installing ${PACKAGE_SPEC} globally with npm..."
if ! npm install -g "$PACKAGE_SPEC"; then
  fail "npm install -g ${PACKAGE_SPEC} failed. If this is a permissions issue, configure npm's global prefix or run npm install -g ${PACKAGE_SPEC} with the needed privileges."
fi

if [ "$INSTALL_ONLY" = "1" ]; then
  say "APVISO Runner installed. Start the web console with: apviso"
  exit 0
fi

APVISO_BIN="$(command -v apviso || true)"
if [ -z "$APVISO_BIN" ]; then
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/apviso" ]; then
    APVISO_BIN="$NPM_PREFIX/bin/apviso"
  fi
fi

if [ -z "$APVISO_BIN" ]; then
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_PREFIX" ]; then
    fail "APVISO Runner installed, but apviso is not on PATH. Add ${NPM_PREFIX}/bin to PATH, then run apviso."
  fi
  fail "APVISO Runner installed, but apviso is not on PATH. Add npm's global bin directory to PATH, then run apviso."
fi

say "Starting APVISO Runner web console..."
exec "$APVISO_BIN" "$@"
