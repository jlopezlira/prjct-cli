#!/bin/sh
#
# ⚠️  DEPRECATED — this installer is now a thin redirect.
#
# The real installer lives in scripts/install-standalone.sh. This stub is
# kept so old docs/links that reference install.sh keep working: it prints
# a deprecation notice and hands off to install-standalone.sh, passing all
# arguments through.
#
# Preferred install: npm install -g prjct-cli
#
# POSIX sh.

set -eu

printf '\n'
printf '%s\n' "⚠️  install.sh is DEPRECATED — redirecting to install-standalone.sh"
printf '%s\n' "   (preferred: npm install -g prjct-cli)"
printf '\n'

# When run from a repo checkout, the real installer is a sibling of this
# script. Otherwise (e.g. curl | sh from an old link, or the npm tarball,
# which only ships this stub) fetch it from GitHub.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="$SCRIPT_DIR/install-standalone.sh"

if [ -f "$TARGET" ]; then
  exec bash "$TARGET" "$@"
fi

if command -v curl >/dev/null 2>&1; then
  curl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash -s -- "$@"
else
  printf '%s\n' "✗ install-standalone.sh not found locally and curl is unavailable." >&2
  printf '%s\n' "  Install via npm instead: npm install -g prjct-cli" >&2
  exit 1
fi
