#!/bin/bash
#
# Arbitrage with CrossEx — macOS uninstaller.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/uninstall.sh)"
#
# Removes the background service, the app, and its private Node.js runtime.
# Your API keys (~/.boros-crossex/config) and trade history (~/.boros-crossex/data)
# are KEPT unless you pass --purge:
#
#   /bin/bash -c "$(curl -fsSL …/uninstall.sh)" -- --purge

set -euo pipefail

ROOT="${BOROS_ROOT:-$HOME/.boros-crossex}"
LABEL="com.boros.crossex-terminal"
APP_TITLE="Arbitrage with CrossEx"
LOG_DIR="$HOME/Library/Logs/boros-crossex"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# Mirrors install.sh's stop_stale_server. `launchctl bootout` only stops the
# MANAGED service: a wedged instance, one started by hand, or an orphan left by
# a previous crash survives it. `rm -rf "$ROOT/app"` would then merely unlink
# the files of a live process — its modules are already resident, its .env is
# already loaded, and the reconcile loop keeps placing, cancelling and hedging
# REAL orders. Someone uninstalling to stop the bot must actually stop it, so
# this runs before anything is deleted.
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
  local pids i
  pids="$(server_pids)"
  [ -n "$pids" ] || return 0
  say "Stopping a server instance that survived the service stop…"
  kill $pids 2>/dev/null || true               # SIGTERM first (clean shutdown)
  for i in 1 2 3 4 5 6; do
    pids="$(server_pids)"
    [ -n "$pids" ] || return 0
    sleep 0.5
  done
  kill -9 $pids 2>/dev/null || true            # SIGKILL anything that ignored it
  sleep 0.5
}

main() {
  say "Stopping the background service…"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  stop_stale_server

  # Never delete the app or the trade journal out from under a live engine: it
  # would keep trading against an unlinked ledger, so the write-ahead order
  # reservations would no longer exist on disk for anyone to reconcile against.
  if [ -n "$(server_pids)" ]; then
    echo
    echo "  The trading server is STILL RUNNING and could not be stopped." >&2
    echo "  Nothing was removed — it would keep trading against deleted files." >&2
    echo "  Stop it manually, then re-run this uninstaller. The process(es):" >&2
    ps -o pid,command -p $(server_pids) >&2 2>/dev/null || true
    echo "    kill -9 $(server_pids)" >&2
    exit 1
  fi

  say "Removing the app and its private Node.js runtime…"
  rm -rf "$ROOT/app" "$ROOT/app.new" "$ROOT/app.old" "$ROOT/node" "$ROOT"/node-v*-darwin-*
  # The extra paths are the launcher names this app shipped under before; kept in
  # step with install.sh so an uninstall leaves no launcher from any past name.
  rm -rf "$HOME/Applications/$APP_TITLE.app" \
    "$HOME/Applications/CrossEx-Boros Terminal.app" \
    "$HOME/Applications/Boros CrossEx Terminal.app"
  rm -rf "$LOG_DIR"

  if [ "${1:-}" = "--purge" ]; then
    say "Removing API keys and trade history (--purge)…"
    rm -rf "$ROOT"
  else
    rmdir "$ROOT" 2>/dev/null || true # gone entirely if config/data were never created
    if [ -d "$ROOT" ]; then
      echo
      echo "  Kept your API keys and trade history in $ROOT"
      echo "  Remove them too with: rm -rf $ROOT"
    fi
  fi
  echo
  say "Uninstalled. (The entry under System Settings → Login Items may take a re-login to disappear.)"
}

main "$@"
