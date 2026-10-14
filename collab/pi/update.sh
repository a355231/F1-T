#!/usr/bin/env bash
# Updates App Inventor Team Edition every night at 3 AM (collab-update.timer). If people are online
# then, it tries again every half hour until 6 AM.
#
#   sudo /opt/appinventor/update.sh                    # what the timer runs
#   sudo /opt/appinventor/update.sh --now              # update now, even if people are online
#   sudo /opt/appinventor/update.sh --check            # only say whether a newer version exists
#   sudo /opt/appinventor/update.sh --rollback         # put back the version from before the last update (the nightly update does not install it again)
#   sudo /opt/appinventor/update.sh --mode install|notify|off
#   sudo /opt/appinventor/update.sh --now --simulate-failure=compile|start   # try the way back
#
# An update downloads the new version and builds it while the current one keeps running. Only then
# is it installed and started. The version it replaces is kept in /opt/appinventor/rollback. If the
# build fails, or the new version does not answer within 10 minutes, the old version is put back,
# and everyone who opens the link sees a notice until a later update succeeds. Projects, backups,
# the team code and the OpenRouter settings are never touched. If the installed copy is older than the checkout (after a
# manual git pull, say), the checkout is installed too, even when GitHub has nothing new.
#
# Modes (/opt/appinventor/update-mode): install (default) does all of this by itself; notify only
# reports that a newer version exists; off does nothing unless you run it by hand.
#
# Everything is inside main(), and the last line runs it and then exits. That lets install.sh
# replace this file while it runs. The installer must also replace files rather than write them in
# place, because the saved version shares its unchanged files with the running one.
set -uo pipefail

BASE=${AI_BASE:-/opt/appinventor}
UNITS=${AI_UNIT_DIR:-/etc/systemd/system}
LOCK=${AI_LOCK:-/run/collab-update.lock}
HEALTH_SECONDS=${AI_HEALTH_SECONDS:-600}
HEALTH_STEP=${AI_HEALTH_STEP:-10}
STABLE_SECONDS=${AI_STABLE_SECONDS:-120}
ROLL="$BASE/rollback"
MITSTATUS_PATH="${AI_MITSTATUS:-/usr/local/bin/MITSTATUS}"
STATE="$BASE/update-state"
NOTICE="$BASE/update-failed"
LOG="$BASE/update.log"
MODE_FILE="$BASE/update-mode"
PROGRESS="$BASE/update-progress"
BUILD_LOG="$BASE/build.log"
WHO="The automatic update"
REPO=""
OWNER=""
OLD=""
NEW=""
NEW_SHORT=""

log() {
  local line
  line="$(date '+%F %T') $*"
  echo "$line"
  echo "$line" >> "$LOG"
}

state_get() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null | tail -n 1; }

state_set() {
  { grep -v "^$1=" "$STATE" 2>/dev/null; echo "$1=$2"; } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

# What the update is doing now, for MITSTATUS: the stage, the version it is going to, and when the stage began.
progress() {  # stage, version
  printf 'stage=%s\nversion=%s\nstage_started=%s\n' "$1" "$2" "$(date +%s)" > "$PROGRESS.tmp" && mv "$PROGRESS.tmp" "$PROGRESS"
}

as_owner() {
  if [ "$OWNER" = "$(id -un)" ]; then "$@"; else sudo -u "$OWNER" -H "$@"; fi
}

# Is anybody using App Inventor right now? If the hub is not answering, nobody is.
people_online() {
  local n
  n="$(curl -fsS -m 5 http://127.0.0.1:8080/collab/status 2>/dev/null |
    python3 -c 'import sys, json; print(len(json.load(sys.stdin)["online"]))' 2>/dev/null)" || n=0
  [ "${n:-0}" -gt 0 ]
}

# Does App Inventor answer, and does the hub report the version given?
answers() {
  local code
  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8888/ 2>/dev/null)"
  [[ "$code" =~ ^(200|302|303|307)$ ]] || return 1
  curl -fsS -m 5 http://127.0.0.1:8080/collab/status 2>/dev/null | grep -q "\"version\": \"$1\""
}

# True once the version given answers, and still does STABLE_SECONDS later.
healthy() {
  # The time is counted from the clock, so that the stability wait counts toward the limit too.
  local deadline=$(( $(date +%s) + HEALTH_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if answers "$1"; then
      sleep "$STABLE_SECONDS"
      answers "$1" && return 0
    fi
    sleep "$HEALTH_STEP"
  done
  return 1
}

# Keeps the version that is running now, so that it can be put back. Files that do not change are
# hard links, so this costs almost no writes to the SD card.
snapshot() {
  rm -rf "$ROLL.new"
  mkdir -p "$ROLL.new/scripts" "$ROLL.new/units" || return 1
  rsync -a --exclude 'WEB-INF/appengine-generated' --link-dest="$BASE/war/" \
    "$BASE/war/" "$ROLL.new/war/" || return 1
  # The hub's packages are kept too: a rollback must not run the old hub with the new ones.
  rsync -a --link-dest="$BASE/hub/" "$BASE/hub/" "$ROLL.new/hub/" || return 1
  cp -p "$BASE"/*.sh "$ROLL.new/scripts/" 2>/dev/null
  cp -p "$MITSTATUS_PATH" "$ROLL.new/scripts/MITSTATUS" 2>/dev/null
  cp -p "$UNITS"/appinventor.service "$UNITS"/collab-hub.service "$UNITS"/cloudflared-quick.service \
    "$UNITS"/collab-update.service "$UNITS"/collab-update.timer "$UNITS"/collab-watchdog.service \
    "$UNITS"/collab-watchdog.timer "$ROLL.new/units/" 2>/dev/null
  cp -p "$BASE/version" "$ROLL.new/version" 2>/dev/null || echo unknown > "$ROLL.new/version"
  echo "$OLD" > "$ROLL.new/commit"
  rm -rf "$ROLL"
  mv "$ROLL.new" "$ROLL"
}

# Puts the saved version back, and starts it.
restore_previous() {
  [ -f "$ROLL/commit" ] || { log "There is no saved version to go back to."; return 1; }
  systemctl stop collab-hub appinventor 2>/dev/null
  # A copy that fails leaves the old version only partly back: that is reported (fail), not called a success.
  rsync -a --delete --exclude 'WEB-INF/appengine-generated' "$ROLL/war/" "$BASE/war/" || return 1
  rsync -a --delete "$ROLL/hub/" "$BASE/hub/" || return 1
  if [ -f "$ROLL/scripts/MITSTATUS" ]; then cp -p "$ROLL/scripts/MITSTATUS" "$MITSTATUS_PATH" || return 1; fi
  cp -p "$ROLL"/scripts/*.sh "$BASE/" 2>/dev/null
  cp -p "$ROLL"/units/* "$UNITS/" 2>/dev/null
  cp -p "$ROLL/version" "$BASE/version" 2>/dev/null
  as_owner git -C "$REPO" reset -q --hard "$(cat "$ROLL/commit")" || log "Could not reset the downloaded copy."
  systemctl daemon-reload
  systemctl start appinventor collab-hub
}

notice() { printf '%s\n' "$1" > "$NOTICE"; }

# The update did not work: put the old version back, and tell everybody who opens the link.
fail() {  # stage, reason
  log "The update failed at $1: $2"
  # The build's own output is not in this log (it goes to the journal), so its last lines are copied here.
  if [ "$1" = compile ] && [ -s "$BUILD_LOG" ]; then
    log "The end of the build's output:"
    tail -n 25 "$BUILD_LOG" | sed 's/^/    /' >> "$LOG"
  fi
  progress restoring "$(cat "$ROLL/version" 2>/dev/null || echo unknown)"
  local back
  if ! restore_previous; then
    back="The previous version could not be put back in full, so App Inventor may be down. Please ask whoever runs the Raspberry Pi."
  elif healthy "$(cat "$ROLL/version" 2>/dev/null)"; then
    back="The previous version is running again."
  else
    back="The previous version did not start either, so App Inventor may be down. Please ask whoever runs the Raspberry Pi."
  fi
  notice "$WHO to $NEW_SHORT failed at $1 ($2). $back Projects and backups were not changed. For details, run: sudo tail -n 60 $LOG"
  rm -f "$PROGRESS"
  log "Back on $(cat "$BASE/version" 2>/dev/null)."
  exit 1
}

main() {
  [ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

  local mode_arg="" now=0 check=0 rollback=0 sim="" mode branch
  while [ $# -gt 0 ]; do
    case "$1" in
      --now) now=1 ;;
      --check) check=1 ;;
      --rollback) rollback=1 ;;
      --mode) mode_arg="${2:-}"; shift ;;
      --simulate-failure=*)
        sim="${1#--simulate-failure=}"
        case "$sim" in compile|start) ;; *) echo "Use --simulate-failure=compile or start" >&2; exit 2 ;; esac ;;
      *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
  done

  if [ -n "$mode_arg" ]; then
    case "$mode_arg" in
      install|notify|off) mkdir -p "$BASE"; echo "$mode_arg" > "$MODE_FILE"; echo "Nightly updates: $mode_arg" ;;
      *) echo "Use: update.sh --mode install|notify|off" >&2; exit 2 ;;
    esac
    exit 0
  fi

  mkdir -p "$BASE"
  mode="$(cat "$MODE_FILE" 2>/dev/null || echo install)"
  if [ "$mode" = off ] && [ "$now$check$rollback" = 000 ]; then exit 0; fi

  exec 9>"$LOCK" || exit 1
  if ! flock -n 9; then
    log "Another update is already running."
    # A request made by hand is refused with a code that says so. The timer, finding the lock busy, is not an error.
    if [ "$now$check$rollback" = 000 ]; then exit 0; fi
    exit 75
  fi
  # install.sh is run by this update, and must not wait for the lock this update holds.
  export AI_UPDATE_LOCK_HELD=1
  if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 400 ]; then
    tail -n 300 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi

  REPO="$(cat "$BASE/repo" 2>/dev/null || true)"
  if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
    log "I do not know where the downloaded copy is. Run the one-line install once more."
    exit 1
  fi
  OWNER="$(stat -c %U "$REPO")"

  if [ "$rollback" = 1 ]; then
    local from
    from="$(as_owner git -C "$REPO" rev-parse HEAD)"
    progress restoring "$(cat "$ROLL/version" 2>/dev/null || echo unknown)"
    if ! restore_previous; then rm -f "$PROGRESS"; exit 1; fi
    if healthy "$(cat "$ROLL/version" 2>/dev/null)"; then
      # The version taken back is held: the nightly update leaves it alone until a newer version is published. --now still
      # installs it. Going back also clears the notice of the failure that came before.
      if [ "$(cat "$ROLL/commit")" != "$from" ]; then
        state_set held "$from"
        state_set held_short "$(as_owner git -C "$REPO" rev-parse --short "$from")"
      fi
      state_set changed_at "$(date '+%F %R')"
      rm -f "$NOTICE" "$PROGRESS"
      log "Back on $(cat "$BASE/version")."
      exit 0
    fi
    rm -f "$PROGRESS"
    log "The restored version did not answer; check the log."
    exit 1
  fi

  branch="$(as_owner git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  # Downloading is not news for the team: if GitHub cannot be reached, the next half hour tries again.
  # A connection that stalls is given up on, rather than holding the update lock for ever.
  if ! as_owner git -C "$REPO" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=120 fetch -q origin "$branch"; then
    log "Could not reach GitHub; I will try again at the next half hour."
    exit 1
  fi
  OLD="$(as_owner git -C "$REPO" rev-parse HEAD)"
  NEW="$(as_owner git -C "$REPO" rev-parse "origin/$branch")"
  NEW_SHORT="$(as_owner git -C "$REPO" rev-parse --short "origin/$branch")"
  # The installed copy can be older than the checkout: after a manual git pull, or an install that stopped before it
  # finished. Then GitHub has nothing new, but the checkout still has to be installed.
  INSTALLED="$(cat "$BASE/version" 2>/dev/null || true)"
  STALE=0
  if [ "$OLD" = "$NEW" ] && [ "$INSTALLED" != "$NEW_SHORT" ]; then STALE=1; fi

  if [ "$OLD" = "$NEW" ] && [ "$STALE" = 0 ] && [ -z "$sim" ]; then
    rm -f "$BASE/update-available"
    log "Up to date ($(cat "$BASE/version" 2>/dev/null || echo "$NEW_SHORT"))."
    exit 0
  fi
  as_owner git -C "$REPO" log -1 --format='%h %s' "origin/$branch" > "$BASE/update-available"
  WHY="A newer version exists"
  if [ "$STALE" = 1 ]; then WHY="The installed copy (${INSTALLED:-unknown}) is not the code in the checkout ($NEW_SHORT)"; fi
  if [ "$check" = 1 ]; then
    log "$WHY: $(cat "$BASE/update-available")"
    exit 0
  fi
  if [ "$now" = 0 ] && [ "$mode" = notify ]; then
    log "$WHY; nightly updates are set to notify only."
    exit 0
  fi
  # A version taken back by hand (MITSTATUS option 10, or --rollback) is not installed again by the nightly update.
  if [ "$now" = 0 ] && [ -n "$(state_get held)" ] && [ "$NEW" = "$(state_get held)" ]; then
    log "Not installing $NEW_SHORT: it was taken back by hand. To install it, run: sudo $BASE/update.sh --now"
    exit 0
  fi
  if [ "$now" = 0 ] && [ "$(state_get last_day)" = "$(date +%F)" ]; then exit 0; fi
  if [ "$now" = 0 ] && people_online; then
    log "People are online; I will try again at the next half hour."
    exit 0
  fi
  if [ ! -s "$BASE/teamcode" ]; then
    log "There is no team code, so the update cannot run unattended. Run: sudo $BASE/set-team-code.sh"
    exit 1
  fi
  if [ "$(df -Pm "$BASE" | awk 'NR==2 {print $4}')" -lt 2048 ]; then
    log "Less than 2 GB free on the card; not updating today."
    exit 1
  fi

  [ "$now" = 1 ] && WHO="The update"
  state_set last_day "$(date +%F)"
  log "Updating from $(cat "$BASE/version" 2>/dev/null || echo unknown) to $NEW_SHORT."
  progress preparing "$NEW_SHORT"
  if ! as_owner git -C "$REPO" merge -q --ff-only "origin/$branch"; then
    rm -f "$PROGRESS"
    log "Could not fast-forward the downloaded copy, so nothing was changed."
    exit 1
  fi
  # The version to go back to is saved only once the update is certain to go on: a refused merge must not replace it.
  if ! snapshot; then
    rm -f "$PROGRESS"
    log "Could not save the current version, so nothing was changed."
    exit 1
  fi

  # Compile: the build runs while the current version keeps serving. Nothing is installed until
  # the build has succeeded. Its output is kept in build.log, and fail copies the end of it into this log.
  rm -f "$BUILD_LOG"
  if [ "$sim" = compile ]; then fail compile "a failure was simulated for testing"; fi
  compile_started="$(date +%s)"
  progress compile "$NEW_SHORT"
  if ! SUDO_USER="$OWNER" DEBIAN_FRONTEND=noninteractive "$REPO/collab/pi/install.sh" --build-here 2>&1 | tee "$BUILD_LOG"; then
    fail compile "the build or the install step returned an error"
  fi
  # How long the build took is the estimate for the next one, which MITSTATUS shows as the time left.
  state_set build_seconds "$(( $(date +%s) - compile_started ))"

  # Start: the new version must answer, and keep answering, within 10 minutes.
  progress start "$NEW_SHORT"
  if [ "$sim" = start ]; then fail start "a failure was simulated for testing"; fi
  if ! healthy "$NEW_SHORT"; then
    fail start "App Inventor or the team hub did not answer as the new version within 10 minutes"
  fi

  rm -f "$NOTICE" "$BASE/update-available" "$PROGRESS"
  state_set held ""
  state_set held_short ""
  state_set changed_at "$(date '+%F %R')"
  log "Updated. Now running $NEW_SHORT. The version before it is kept for --rollback."
  exit 0
}

main "$@"; exit $?
