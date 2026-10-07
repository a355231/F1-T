#!/usr/bin/env bash
# One command for the Raspberry Pi: build and start App Inventor Team Edition, then show the link
# and the team code. Safe to run again (it updates and rebuilds; your projects and team code stay).
#
#   sudo collab/pi/setup.sh
#
# The install runs under systemd, so if your SSH connection drops it keeps going. Run the same
# command again to watch it. Add --verbose to see every line of the install instead of the summary.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_AS="${SUDO_USER:-$(stat -c %U "$HERE")}"   # whoever owns this checkout
BASE="${APPINVENTOR_BASE:-/opt/appinventor}"
INSTALL="${APPINVENTOR_INSTALL_SCRIPT:-$HERE/install.sh}"
LOG="${APPINVENTOR_INSTALL_LOG:-/var/log/appinventor-install.log}"
UNIT=appinventor-install
DONE_MARKER="App Inventor is running and will start again on every boot"

is_running() {
  systemctl is-active --quiet "$UNIT" 2>/dev/null
}

if is_running; then
  echo "An install is already running; showing its progress."
else
  mkdir -p "$BASE"
  chown "$RUN_AS:$RUN_AS" "$BASE"
  if [ ! -s "$BASE/teamcode" ]; then
    echo "Choose the team code. Everyone signs in with their own name and this code."
    "$HERE/set-team-code.sh"
    echo
  fi
  : > "$LOG"
  echo "Starting the install. First time it takes about 20-60 minutes (mostly the build)."
  echo "It keeps running if this connection drops; run the same command again to watch it."
  systemd-run --quiet --unit="$UNIT" --collect --working-directory="$HERE" \
    --setenv=SUDO_USER="$RUN_AS" --setenv=DEBIAN_FRONTEND=noninteractive \
    --property=StandardOutput="truncate:$LOG" --property=StandardError=inherit \
    "$INSTALL" --build-here
fi

echo
start="$(date +%s)"
pos=0
last_note="$start"
print_new() {
  local size
  size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  if [ "$size" -gt "$pos" ]; then
    if [ "$VERBOSE" = 1 ]; then
      tail -c +"$((pos + 1))" "$LOG"
    else
      tail -c +"$((pos + 1))" "$LOG" | grep -E '^== |BUILD FAILED|BUILD SUCCESSFUL|GWT flags changed|Cannot |ERROR|OutOfMemory' || true
    fi
    pos="$size"
  fi
}
while is_running; do
  print_new
  now="$(date +%s)"
  if [ "$VERBOSE" = 0 ] && [ $((now - last_note)) -ge 60 ]; then
    printf '   ... still working (%d min so far)\n' $(((now - start) / 60))
    last_note="$now"
  fi
  sleep 3
done
print_new

if grep -q "$DONE_MARKER" "$LOG" 2>/dev/null; then
  "$BASE/show-info.sh"
else
  echo
  echo "The install stopped before it finished. The last lines of the log:"
  echo "----------------------------------------------------------------"
  tail -n 30 "$LOG" 2>/dev/null || true
  echo "----------------------------------------------------------------"
  echo "Full log: $LOG   (run this command again to retry; finished steps are skipped)"
  exit 1
fi
