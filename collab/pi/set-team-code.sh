#!/usr/bin/env bash
# Changes the team code while App Inventor is running. Nobody has to restart anything: the next
# person to sign in must use the new code.
#   sudo /opt/appinventor/set-team-code.sh                # asks for the new code
#   sudo /opt/appinventor/set-team-code.sh --random       # makes one up and shows it once
#   sudo /opt/appinventor/set-team-code.sh --signout      # also signs everybody out right now
# (The code can also be changed from inside App Inventor: Team panel > Change team code.)
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo $0" >&2
  exit 1
fi
BASE=/opt/appinventor
OWNER="$(stat -c %U "$BASE")"
RANDOM_CODE=0
SIGNOUT=0
for arg in "$@"; do
  case "$arg" in
    --random) RANDOM_CODE=1 ;;
    --signout) SIGNOUT=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

random_code() {
  # 3 groups of 4 letters and digits, e.g. k7qm-2xwd-9fha (about 62 bits)
  local raw
  raw="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 12)"
  echo "${raw:0:4}-${raw:4:4}-${raw:8:4}"
}

show=0
if [ "$RANDOM_CODE" = 1 ]; then
  code="$(random_code)"
  show=1
else
  read -r -s -p "New team code (at least 8 characters, empty = make one up): " code
  echo
  if [ -z "$code" ]; then
    code="$(random_code)"
    show=1
  else
    if [ "${#code}" -lt 8 ] || [ "${#code}" -gt 64 ]; then
      echo "Use 8 to 64 characters." >&2
      exit 1
    fi
    read -r -s -p "Type it again: " again
    echo
    if [ "$code" != "$again" ]; then
      echo "The two codes are different; nothing changed." >&2
      exit 1
    fi
  fi
fi

umask 077
tmp="$BASE/teamcode.tmp"
printf '%s\n' "$code" > "$tmp"
chown "$OWNER:$OWNER" "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$BASE/teamcode"

if [ "$SIGNOUT" = 1 ]; then
  printf '%s\n' "$(date +%s%3N)" > "$tmp"
  chown "$OWNER:$OWNER" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$BASE/teamcode.signout"
fi

WEBXML="$BASE/war/WEB-INF/appengine-web.xml"
if [ -f "$WEBXML" ] && ! grep -q 'name="collab.teamcode.file"' "$WEBXML"; then
  # An install from before the code could be changed live: switch it over once.
  sudo -u "$OWNER" "$BASE/apply-config.sh"
  systemctl restart appinventor
  echo "App Inventor was restarted once to switch to live code changes."
fi

echo "The team code is changed. The next sign-in needs the new code."
if [ "$SIGNOUT" = 1 ]; then
  echo "Everyone was signed out and must sign in again."
else
  echo "People who are signed in now stay signed in (add --signout to sign them out too)."
fi
if [ "$show" = 1 ]; then
  echo "New team code: $code"
fi
