#!/usr/bin/env bash
#
# prjct — single-paste install.
#
# Designed to be invoked by pasting one line into Claude Code (or any
# AI agent's chat) and letting the agent execute it. Goal: zero terminal
# friction AND zero npm/Node dependency at install time.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash
#
# What it does:
#   1. Detects platform (mac arm64/intel + linux x64)
#   2. Tries to download the standalone binary from the latest GitHub
#      release (no npm needed). Falls through to npm/bun on failure.
#   3. Installs to ~/.prjct-cli/bin/prjct, symlinks to ~/.local/bin/prjct
#      (or /usr/local/bin/prjct as fallback)
#   4. Runs `prjct setup` to install hooks + the global CLAUDE.md block
#   5. If the cwd is a git repo, runs `prjct sync` to register the project

set -euo pipefail

# ---------------------------------------------------------------------------
# Pretty output (still quiet enough that an LLM can quote the whole run
# back to the user without spam)
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

step() { printf "${GREEN}▸${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC}  %s\n" "$1"; }
fail() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
note() { printf "${DIM}  %s${NC}\n" "$1"; }

PRJCT_DIR="${PRJCT_DIR:-$HOME/.prjct-cli}"
BIN_DIR="$PRJCT_DIR/bin"
LOCAL_BIN="$HOME/.local/bin"

# Defaults for variables we read after `set -u` is in effect. Never
# remove these — see fix line ~165 (CURRENT unbound) regression in
# v2.4.28.
CURRENT=""
NEW="unknown"
INSTALLED_VIA="unknown"
DOWNLOAD_OK=false

# ---------------------------------------------------------------------------
# 1. Platform detection
# ---------------------------------------------------------------------------

step "Detecting platform…"
KERNEL="$(uname -s | tr '[:upper:]' '[:lower:]')"
MACHINE="$(uname -m)"
ASSET=""
case "$KERNEL/$MACHINE" in
  darwin/arm64|darwin/aarch64) ASSET="prjct-darwin-arm64" ;;
  darwin/x86_64)               ASSET="prjct-darwin-x64" ;;
  linux/x86_64)                ASSET="prjct-linux-x64" ;;
  *) note "no standalone binary for $KERNEL/$MACHINE — will try package manager fallback" ;;
esac
[ -n "$ASSET" ] && note "platform: $ASSET"

# ---------------------------------------------------------------------------
# 2a. Try standalone binary first (the user's preferred path — no npm)
# ---------------------------------------------------------------------------

INSTALLED_VIA="binary"
DOWNLOAD_OK=false

if [ -n "$ASSET" ]; then
  step "Fetching latest release metadata…"
  LATEST_TAG="$(curl -sSL --fail https://api.github.com/repos/prjct-app/cli/releases/latest \
    | grep -oE '"tag_name":\s*"[^"]+"' | head -1 | cut -d '"' -f4 || true)"

  if [ -n "$LATEST_TAG" ]; then
    URL="https://github.com/prjct-app/cli/releases/download/$LATEST_TAG/$ASSET"
    note "downloading $LATEST_TAG → $URL"
    mkdir -p "$BIN_DIR"
    if curl -sSL --fail -o "$BIN_DIR/prjct.new" "$URL"; then
      chmod +x "$BIN_DIR/prjct.new"
      mv "$BIN_DIR/prjct.new" "$BIN_DIR/prjct"
      DOWNLOAD_OK=true
    else
      warn "binary download failed (release asset may not exist yet for this version) — falling back to package manager"
      rm -f "$BIN_DIR/prjct.new"
    fi
  else
    warn "could not query GitHub releases — falling back to package manager"
  fi
fi

# ---------------------------------------------------------------------------
# 2b. Package manager fallback — pnpm / bun / yarn / npm
#
# Detection order is critical to avoid creating PARALLEL installs:
#   1. If prjct is already installed via a known package manager,
#      use the SAME one to upgrade. Otherwise we end up with multiple
#      copies of prjct in PATH (the user's reality on 2026-05-02 had
#      5 concurrent installs from pnpm/bun/homebrew/npm/standalone).
#   2. If no existing install, prefer pnpm > bun > yarn > npm in that
#      order. Reasons: pnpm + bun are what most modern setups use; npm
#      is the universal fallback.
# ---------------------------------------------------------------------------

if [ "$DOWNLOAD_OK" = false ]; then
  INSTALLED_VIA="pkg-manager"
  step "Falling back to package manager…"

  # Detect which package manager (if any) owns the existing prjct install
  EXISTING_PRJCT="$(command -v prjct 2>/dev/null || true)"
  PM=""
  if [ -n "$EXISTING_PRJCT" ]; then
    case "$EXISTING_PRJCT" in
      */pnpm/*)        PM="pnpm" ;;
      */bun/*)         PM="bun" ;;
      */yarn/*)        PM="yarn" ;;
      */homebrew/*|*/Cellar/*) PM="brew" ;;
      */npm/*|*/.nvm/*|*/n/*)  PM="npm" ;;
    esac
    [ -n "$PM" ] && note "existing install via $PM ($EXISTING_PRJCT) — upgrading in-place"
  fi

  # No existing install (or unknown PM) — pick the user's preferred one
  if [ -z "$PM" ]; then
    if command -v pnpm >/dev/null 2>&1; then
      PM="pnpm"
    elif command -v bun >/dev/null 2>&1; then
      PM="bun"
    elif command -v yarn >/dev/null 2>&1; then
      PM="yarn"
    elif command -v npm >/dev/null 2>&1; then
      PM="npm"
    else
      fail "No package manager found (pnpm, bun, yarn, npm). Install one or use the standalone binary path: https://github.com/prjct-app/cli#install"
    fi
    note "no existing install — using $PM (first available in pnpm > bun > yarn > npm preference order)"
  fi

  case "$PM" in
    pnpm) pnpm install -g prjct-cli@latest >/dev/null 2>&1 || fail "pnpm install failed" ;;
    bun)  bun install -g prjct-cli@latest >/dev/null 2>&1 || fail "bun install failed" ;;
    yarn) yarn global add prjct-cli@latest >/dev/null 2>&1 || fail "yarn global add failed" ;;
    npm)  npm install -g prjct-cli@latest >/dev/null 2>&1 || fail "npm install failed" ;;
    brew) brew upgrade prjct-cli >/dev/null 2>&1 || brew install prjct-cli >/dev/null 2>&1 || fail "brew install failed" ;;
    *)    fail "Unknown package manager: $PM" ;;
  esac
fi

# ---------------------------------------------------------------------------
# 3. Symlink so `prjct` is on PATH
# ---------------------------------------------------------------------------

if [ "$INSTALLED_VIA" = "binary" ]; then
  step "Adding prjct to PATH…"
  mkdir -p "$LOCAL_BIN"
  ln -sf "$BIN_DIR/prjct" "$LOCAL_BIN/prjct"
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LOCAL_BIN"; then
    # Append PATH export to the user's shell rc, with a guard comment.
    SHELL_RC=""
    case "${SHELL:-}" in
      */zsh)  SHELL_RC="$HOME/.zshrc" ;;
      */bash) SHELL_RC="$HOME/.bashrc" ;;
    esac
    if [ -n "$SHELL_RC" ]; then
      if ! grep -qF "# prjct: add ~/.local/bin to PATH" "$SHELL_RC" 2>/dev/null; then
        printf "\n# prjct: add ~/.local/bin to PATH\nexport PATH=\"\$HOME/.local/bin:\$PATH\"\n" >> "$SHELL_RC"
        note "appended PATH export to $SHELL_RC — open a new shell or run 'source $SHELL_RC'"
      fi
    else
      warn "couldn't detect your shell rc — add this to your shell config: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
  fi
  # Make `prjct` resolvable in this script run too.
  export PATH="$LOCAL_BIN:$PATH"
fi

# Verify install
if ! command -v prjct >/dev/null 2>&1; then
  fail "prjct didn't end up on PATH — please add $LOCAL_BIN to your PATH manually"
fi

NEW="$(prjct -v 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)"
note "installed v$NEW (via $INSTALLED_VIA)"

# ---------------------------------------------------------------------------
# 4. Setup (hooks + global CLAUDE.md)
# ---------------------------------------------------------------------------

step "Wiring hooks + global CLAUDE.md (lookup-first)…"
# Capture stderr to a temp file so a failing setup doesn't leave the user
# blind — show the tail of it alongside the friendly fallback message.
SETUP_ERR="$(mktemp "${TMPDIR:-/tmp}/prjct-setup.XXXXXX")"
if ! PRJCT_NONINTERACTIVE=1 prjct setup --quiet 2>"$SETUP_ERR"; then
  warn "setup encountered non-fatal warnings; check 'prjct doctor' if anything looks off"
  if [ -s "$SETUP_ERR" ]; then
    note "setup stderr (last 10 lines):"
    tail -n 10 "$SETUP_ERR" | while IFS= read -r line; do note "$line"; done
  fi
fi
rm -f "$SETUP_ERR"

# ---------------------------------------------------------------------------
# 5. Register cwd if it's a git repo
# ---------------------------------------------------------------------------

if git rev-parse --show-toplevel >/dev/null 2>&1; then
  step "Registering this project (cwd is a git repo)…"
  prjct sync --quiet 2>/dev/null || note "sync skipped — run 'prjct sync' manually if you need to refresh"
else
  note "cwd is not a git repo — skipping project registration. cd into a project and run 'prjct sync' to register it."
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

VERB="installed"
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$NEW" ]; then
  VERB="upgraded v$CURRENT → v$NEW"
elif [ -n "$CURRENT" ] && [ "$CURRENT" = "$NEW" ]; then
  VERB="re-verified at v$NEW (already current)"
fi

# ---------------------------------------------------------------------------
# 6. PATH shadow detection — warn if an older `prjct` (e.g. from a stale
#    pnpm/yarn/homebrew install) is winning the PATH lookup over the
#    binary we just put in $LOCAL_BIN. Without this the user sees the
#    OLD version on `prjct -v` and assumes the install failed.
# ---------------------------------------------------------------------------

ACTIVE_PRJCT="$(command -v prjct 2>/dev/null || true)"
EXPECTED_PRJCT_BINARY="$BIN_DIR/prjct"
EXPECTED_PRJCT_SYMLINK="$LOCAL_BIN/prjct"

if [ -n "$ACTIVE_PRJCT" ] && [ "$ACTIVE_PRJCT" != "$EXPECTED_PRJCT_BINARY" ] && [ "$ACTIVE_PRJCT" != "$EXPECTED_PRJCT_SYMLINK" ]; then
  warn "PATH shadow detected: 'prjct' resolves to $ACTIVE_PRJCT (not the install we just placed at $EXPECTED_PRJCT_SYMLINK)."
  ACTIVE_VERSION="$($ACTIVE_PRJCT -v 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)"
  printf "${DIM}    Active path version: %s — expected: v%s${NC}\n" "$ACTIVE_VERSION" "$NEW"
  printf "${DIM}    Likely a stale pnpm / yarn / homebrew install. Remove it:${NC}\n"
  case "$ACTIVE_PRJCT" in
    */pnpm/*)        printf "${DIM}      pnpm rm -g prjct-cli${NC}\n" ;;
    */yarn/*)        printf "${DIM}      yarn global remove prjct-cli${NC}\n" ;;
    */homebrew/*|*/Cellar/*)
                     printf "${DIM}      brew uninstall prjct-cli${NC}\n" ;;
    */bun/*)         printf "${DIM}      bun remove -g prjct-cli${NC}\n" ;;
    *)               printf "${DIM}      (manually remove %s)${NC}\n" "$ACTIVE_PRJCT" ;;
  esac
  printf "${DIM}    Then start a new shell (or 'hash -r') and re-run this install command.${NC}\n"
fi

printf "\n${GREEN}✓${NC} prjct %s (via $INSTALLED_VIA).\n" "$VERB"
printf "${DIM}  Next:${NC}\n"
printf "${DIM}    - Open Claude Code in any project — the lookup-first protocol kicks in automatically${NC}\n"
printf "${DIM}    - Try: prjct capture \"a thought\"  or  prjct task \"the thing I'm working on\"${NC}\n"
printf "${DIM}    - Quality workflows: ask Claude to \"review\", \"qa\", \"investigate\", or \"security check\" the current branch.${NC}\n"
printf "${DIM}    - Re-run this same command anytime to upgrade to the latest version.${NC}\n"
