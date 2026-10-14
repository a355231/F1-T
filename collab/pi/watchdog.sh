#!/usr/bin/env bash
# Restarts App Inventor or the collaboration hub if they stop answering. Run by a systemd timer
# every minute. Counters live in /run (memory), so this never writes to the SD card.
set -u
STATE=/run/appinventor-watchdog
BASE=/opt/appinventor
LOCK=/run/collab-update.lock
mkdir -p "$STATE"

# While an update is putting a new version in, or putting the old one back, the services are restarted on purpose,
# so this leaves them alone. A stale progress file (after a power cut, say) does not count: the lock must be held too.
if ! flock -n "$LOCK" true 2>/dev/null; then
  stage="$(sed -n 's/^stage=//p' "$BASE/update-progress" 2>/dev/null | tail -n 1)"
  if [ -e "$BASE/install-in-progress" ] || [ "$stage" = start ] || [ "$stage" = restoring ]; then exit 0; fi
fi

check() {  # name url
  local name="$1" url="$2" n
  if curl -fsS -m 10 -o /dev/null "$url" 2>/dev/null; then
    echo 0 > "$STATE/$name"
    return
  fi
  n=$(( $(cat "$STATE/$name" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE/$name"
  if [ "$n" -ge 3 ] && systemctl is-active --quiet "$name"; then
    logger -t appinventor-watchdog "$name did not answer 3 times in a row; restarting it"
    systemctl restart "$name"
    echo 0 > "$STATE/$name"
  fi
}
# App Inventor is slow to start; give it time after a (re)start
up="$(systemctl show -p ActiveEnterTimestampMonotonic --value appinventor 2>/dev/null || echo 0)"
now="$(cut -d. -f1 /proc/uptime)"
if [ "$(( now - up / 1000000 ))" -gt 240 ]; then
  check appinventor "http://127.0.0.1:8888/"
fi
check collab-hub "http://127.0.0.1:8080/collab/status"
