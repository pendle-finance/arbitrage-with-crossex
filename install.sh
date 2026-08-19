#!/bin/bash
#
# Arbitrage with CrossEx — macOS installer.
#
# Usage (paste into Terminal):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"
#
# What this script does — and everything it does:
#   1. Downloads a private copy of Node.js (official nodejs.org build, checksum
#      verified) into ~/.boros-crossex/ — it does NOT touch your system, PATH,
#      or shell profile, and never asks for an administrator password.
#   2. Downloads the app from GitHub into ~/.boros-crossex/app/.
#   3. Installs the app's dependencies and builds its web interface.
#   4. Registers a background service (a standard macOS "LaunchAgent") so the
#      app is always running for you, even after you restart your Mac.
#   5. Opens http://localhost:6688 in your browser and puts a launcher app in
#      ~/Applications. Your Gate.io API keys are entered later, in the browser —
#      never in this terminal.
#
# Re-running this command updates the app in place — it stops the previously
# running version first (including any orphaned/wedged copy), so an old version
# never lingers. Your keys and trade history (kept in ~/.boros-crossex/config and
# ~/.boros-crossex/data) are never touched.
# Uninstall: https://github.com/pendle-finance/arbitrage-with-crossex#uninstall
#
# This script is bash-3.2 compatible (macOS system bash).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (BOROS_* env vars exist for development/testing overrides)
# ---------------------------------------------------------------------------
REPO_SLUG="${BOROS_REPO:-pendle-finance/arbitrage-with-crossex}"
BRANCH="${BOROS_BRANCH:-main}"
# Pin an exact commit, tag or branch: BOROS_REF wins over BOROS_BRANCH. This is
# how you install the very tree you audited — see "Install exactly what you
# audited" in the README.
REF="${BOROS_REF:-}"
PORT="${BOROS_PORT:-6688}"
ROOT="${BOROS_ROOT:-$HOME/.boros-crossex}"
NODE_LINE="v24"
LABEL="com.boros.crossex-terminal"
APP_TITLE="Arbitrage with CrossEx"
LOG_DIR="$HOME/Library/Logs/boros-crossex"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

TMP=""

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP" || true; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight() {
  [ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS only."
  [ "$(id -u)" -ne 0 ] || fail "please run WITHOUT sudo — nothing here needs an administrator password."
  command -v curl >/dev/null || fail "curl not found (it ships with macOS — is this a very unusual setup?)"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/boros-install.XXXXXX")"
  trap cleanup EXIT
  mkdir -p "$ROOT" "$ROOT/config" "$ROOT/data" "$LOG_DIR" "$HOME/Library/LaunchAgents" "$HOME/Applications"
  chmod 700 "$ROOT/config"  # holds the live-money API secret in .env
  chmod 700 "$ROOT/data"    # holds the full real-money trade journal (history)
}

# ---------------------------------------------------------------------------
# Step 1: private Node.js runtime (no sudo, no Homebrew, no PATH changes)
# ---------------------------------------------------------------------------
node_arch() {
  local arch
  arch="$(uname -m)"
  # A Terminal running under Rosetta reports x86_64 on Apple Silicon.
  if [ "$arch" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    arch="arm64"
  fi
  case "$arch" in
    arm64) echo "arm64" ;;
    x86_64) echo "x64" ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
}

install_node() {
  if [ -x "$ROOT/node/bin/node" ]; then
    case "$("$ROOT/node/bin/node" -v 2>/dev/null)" in
      "$NODE_LINE".*) say "Node.js $("$ROOT/node/bin/node" -v) already installed — skipping."; return ;;
    esac
  fi
  local arch sums file dir
  arch="$(node_arch)"
  say "Downloading Node.js (official nodejs.org build, $arch)…"
  sums="$(curl -fsSL --retry 3 "https://nodejs.org/dist/latest-$NODE_LINE.x/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | grep -o "node-$NODE_LINE[0-9.]*-darwin-$arch\.tar\.gz" | head -1)"
  [ -n "$file" ] || fail "could not resolve the latest Node.js $NODE_LINE tarball for darwin-$arch."
  curl -fsSL --retry 3 -o "$TMP/$file" "https://nodejs.org/dist/latest-$NODE_LINE.x/$file"
  say "Verifying checksum…"
  ( cd "$TMP" && printf '%s\n' "$sums" | grep "  $file\$" | shasum -a 256 -c - >/dev/null ) \
    || fail "Node.js download failed checksum verification."
  dir="${file%.tar.gz}"
  rm -rf "$ROOT/$dir"
  tar -xzf "$TMP/$file" -C "$ROOT"
  ln -sfn "$ROOT/$dir" "$ROOT/node"
  say "Node.js $("$ROOT/node/bin/node" -v) installed into $ROOT."
}

install_yarn() {
  [ -x "$ROOT/node/bin/yarn" ] && return
  say "Installing the yarn package manager (into the private runtime only)…"
  # --prefix is not optional here. npm's global prefix follows its own config,
  # not the binary that was invoked: a user ~/.npmrc with prefix=~/.npm-global
  # (a common no-sudo setup) would scatter yarn outside the private runtime —
  # and $ROOT/node/bin/yarn, which everything downstream calls, would never
  # appear. Pinning the prefix keeps the runtime self-contained and removable
  # in one delete, which is the promise the installer makes. (install.ps1
  # carries the same guard for Windows' %APPDATA%\npm default.)
  PATH="$ROOT/node/bin:$PATH" "$ROOT/node/bin/npm" install -g --silent \
    --prefix "$ROOT/node" yarn@1.22.22
  [ -x "$ROOT/node/bin/yarn" ] || fail "yarn installation failed (expected $ROOT/node/bin/yarn)."
}

# ---------------------------------------------------------------------------
# Step 2+3: fetch the app and build it (staged in app.new, then swapped in)
# ---------------------------------------------------------------------------
# The commit a GitHub archive was cut from. `git archive` — which is what
# generates every /archive/ download — stamps the full sha into the tarball's
# pax global header, so this is exact, offline and needs no API call. Best
# effort by design: a hand-rolled tarball has no header, and an install must
# never fail over provenance.
archive_commit() {
  gzip -dc "$1" 2>/dev/null | dd bs=512 skip=1 count=1 2>/dev/null \
    | LC_ALL=C grep -aoE '[0-9a-f]{40}' | head -1 || true
}

# Record WHAT was installed, next to the code it describes: app.new is swapped
# into place atomically, so this file can never describe a different tree.
# Surfaced by the app in Settings → About and on GET /api/version.
write_install_info() {
  local commit="$1" requested="$2" source="$3" esc
  esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  cat > "$ROOT/app.new/install-info.json" <<JSON
{
  "schema": 1,
  "repo": "$(esc "$REPO_SLUG")",
  "requestedRef": "$(esc "$requested")",
  "commit": $( [ -n "$commit" ] && printf '"%s"' "$commit" || printf 'null' ),
  "source": "$source",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installer": "install.sh"
}
JSON
}

fetch_app() {
  say "Downloading the app…"
  rm -rf "$ROOT/app.new"
  mkdir -p "$ROOT/app.new"
  local tgz requested source
  if [ -n "${BOROS_TARBALL:-}" ]; then
    tgz="$BOROS_TARBALL"; requested=""; source="local-archive"
  else
    # Download to disk rather than streaming into tar: the commit stamp is read
    # back out of the archive, and a truncated transfer can no longer leave a
    # half-extracted app.new behind.
    tgz="$TMP/app.tgz"
    if [ -n "$REF" ]; then
      requested="$REF"
      curl -fsSL --retry 3 -o "$tgz" "https://github.com/$REPO_SLUG/archive/$REF.tar.gz" \
        || fail "could not download ref '$REF' from $REPO_SLUG — does it exist?"
    else
      requested="refs/heads/$BRANCH"
      curl -fsSL --retry 3 -o "$tgz" "https://github.com/$REPO_SLUG/archive/refs/heads/$BRANCH.tar.gz" \
        || fail "could not download branch '$BRANCH' from $REPO_SLUG."
    fi
    source="github-archive"
  fi
  tar -xzf "$tgz" -C "$ROOT/app.new" --strip-components=1
  [ -f "$ROOT/app.new/package.json" ] || fail "app download looks incomplete (no package.json)."
  write_install_info "$(archive_commit "$tgz")" "$requested" "$source"
}

build_app() {
  local yarn="$ROOT/node/bin/yarn"
  say "Installing dependencies (this takes a minute on first install)…"
  PATH="$ROOT/node/bin:$PATH" "$yarn" --cwd "$ROOT/app.new" install --frozen-lockfile --silent --non-interactive
  PATH="$ROOT/node/bin:$PATH" "$yarn" --cwd "$ROOT/app.new/web" install --frozen-lockfile --silent --non-interactive
  say "Building the web interface…"
  PATH="$ROOT/node/bin:$PATH" "$yarn" --cwd "$ROOT/app.new/web" --silent build >/dev/null
}

swap_app() {
  rm -rf "$ROOT/app.old"
  [ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
  mv "$ROOT/app.new" "$ROOT/app"
  rm -rf "$ROOT/app.old"
}

# ---------------------------------------------------------------------------
# Step 4: LaunchAgent — keeps the server running, across reboots and crashes
# ---------------------------------------------------------------------------
# Only processes that are provably OUR server. `pgrep -f` alone is not enough:
# it matches any process whose ARGUMENTS contain that path, so an editor, a
# `tail -f` or a grep on the file would match — and these get SIGTERM then
# SIGKILL. It also MISSES a server started from inside $ROOT/app with relative
# arguments, which has no absolute path in its argv at all. So, mirroring what
# the Windows scripts do: use pgrep as a cheap prefilter, then confirm by the
# process's EXECUTABLE (lsof's `txt` fd is the ExecutablePath analogue, and
# lsof is already required for the port check), plus an inverse sweep over the
# private runtime's node binary that needs no command line whatsoever.
# NOTE: lsof reports FULLY RESOLVED paths, and both $ROOT/node (a symlink to
# the versioned dir) and $ROOT itself may be symlinked — so resolve first.
# NOTE: `-a` in the sweep is load-bearing: lsof ORs its selection criteria
# without it, which would match every process this user owns.
# NOTE: on macOS `pgrep -a` means "include ancestors", NOT "print argv" as on
# Linux — never use it here.
server_pids() {
  command -v pgrep >/dev/null 2>&1 || return 0
  local uid pid exe rootdir out=""
  uid="$(id -u)"
  rootdir="$(cd "$ROOT" 2>/dev/null && pwd -P || true)"
  if [ -z "$rootdir" ] || ! command -v lsof >/dev/null 2>&1; then
    pgrep -U "$uid" -f "$ROOT/app/src/server/index.ts" 2>/dev/null || true
    return 0
  fi
  for pid in $(pgrep -U "$uid" -f "$ROOT/app/src/server/index.ts" 2>/dev/null || true); do
    exe="$(lsof -p "$pid" -a -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$exe" in "$rootdir"/node*/*) out="$out $pid" ;; esac
  done
  for pid in $(lsof -t -a -u "$uid" -- "$rootdir"/node-v*-darwin-*/bin/node 2>/dev/null || true); do
    case " $out " in *" $pid "*) ;; *) out="$out $pid" ;; esac
  done
  echo $out
}

stop_stale_server() {
  # bootout stops the managed service, but a wedged instance — or one started by
  # hand, or an orphan a previous crash left behind — can survive and keep
  # holding $PORT and the trade-journal lock, which would block the update.
  local pids i
  pids="$(server_pids)"
  [ -n "$pids" ] || return 0
  say "Stopping the previous version still running…"
  kill $pids 2>/dev/null || true              # SIGTERM first (clean shutdown)
  for i in 1 2 3 4 5 6; do
    pids="$(server_pids)"
    [ -n "$pids" ] || return 0
    sleep 0.5
  done
  kill -9 $pids 2>/dev/null || true            # SIGKILL anything that ignored it
  sleep 0.5
}

port_in_use_by_other_app() {
  # Called after bootout + stop_stale_server, so our own instances are gone:
  # anything still listening on $PORT is another program. Give the socket a
  # moment to free after we release it.
  local i
  for i in 1 2 3 4 5 6; do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 1
    sleep 0.5
  done
  return 0
}

write_plist() {
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/node/bin/node</string>
    <string>$ROOT/app/node_modules/tsx/dist/cli.mjs</string>
    <string>$ROOT/app/src/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT/app</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$ROOT/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>DOTENV_CONFIG_PATH</key>
    <string>$ROOT/config/.env</string>
    <key>ARB_DATA_DIR</key>
    <string>$ROOT/data</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST
  plutil -lint -s "$PLIST" || fail "generated LaunchAgent plist failed validation."
}

install_service() {
  say "Registering the background service…"
  # Keep the always-on logs from growing without bound: reset on each (re)install.
  : > "$LOG_DIR/server.out.log"; : > "$LOG_DIR/server.err.log"
  local uid; uid="$(id -u)"
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  stop_stale_server  # reap any old/orphaned server so re-running always updates
  if port_in_use_by_other_app; then
    fail "port $PORT is already in use by another program.
  See what it is with:  lsof -nP -iTCP:$PORT -sTCP:LISTEN
  Quit that program and re-run this installer (or re-run with BOROS_PORT=<other port>)."
  fi
  write_plist
  launchctl enable "gui/$uid/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$PLIST"
  launchctl kickstart -k "gui/$uid/$LABEL" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Step 5: open the app, create the launcher
# ---------------------------------------------------------------------------
wait_for_server() {
  say "Waiting for the app to start…"
  local i
  for i in $(seq 1 120); do
    if curl -sf --max-time 2 "http://localhost:$PORT/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 0.5
  done
  fail "the app did not start. Check the log: $LOG_DIR/server.err.log"
}

make_launcher() {
  # A tiny local .app that opens the terminal in your browser. Created locally,
  # so macOS Gatekeeper has no reason to block it.
  # The extra paths are the launcher names this app shipped under before. The
  # .app is keyed by name, so each rename would otherwise leave a stale launcher
  # in ~/Applications. APPEND the outgoing name on every rename; never replace.
  rm -rf "$HOME/Applications/$APP_TITLE.app" \
    "$HOME/Applications/CrossEx-Boros Terminal.app" \
    "$HOME/Applications/Boros CrossEx Terminal.app"
  osacompile -e "do shell script \"open http://localhost:$PORT\"" \
    -o "$HOME/Applications/$APP_TITLE.app" >/dev/null 2>&1 || true
}

main() {
  echo
  say "Installing $APP_TITLE into $ROOT"
  echo "    (no administrator password needed; your system setup is not modified)"
  echo
  preflight
  install_node
  install_yarn
  fetch_app
  build_app
  swap_app
  install_service
  wait_for_server
  make_launcher
  echo
  say "Done! Opening http://localhost:$PORT …"
  echo
  echo "  • The app now runs in the background, even after you restart your Mac."
  echo "  • Open it any time at http://localhost:$PORT (bookmark it!) or via"
  echo "    \"$APP_TITLE\" in your ~/Applications folder."
  echo "  • First time? The app will ask for your Gate.io API keys in the browser."
  echo "  • Update any time by re-running the install command."
  echo
  open "http://localhost:$PORT" 2>/dev/null || true
}

main "$@"
