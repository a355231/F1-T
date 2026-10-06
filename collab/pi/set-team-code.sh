#!/usr/bin/env bash
# Changes the team code, signs everyone out, and restarts App Inventor.
#   sudo /opt/appinventor/set-team-code.sh            # asks for the new code
#   sudo /opt/appinventor/set-team-code.sh --random   # makes one up and shows it once
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo $0" >&2
  exit 1
fi
BASE=/opt/appinventor
OWNER="$(stat -c %U "$BASE")"

random_code() {
  # 3 groups of 4 letters and digits, e.g. k7qm-2xwd-9fha (about 62 bits)
  local raw
  raw="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 12)"
  echo "${raw:0:4}-${raw:4:4}-${raw:8:4}"
}

if [ "${1:-}" = "--random" ]; then
  code="$(random_code)"
  show=1
else
  read -r -s -p "New team code (at least 8 characters, empty = make one up): " code
  echo
  if [ -z "$code" ]; then
    code="$(random_code)"
    show=1
  else
    show=0
    if [ "${#code}" -lt 8 ]; then
      echo "Use at least 8 characters." >&2
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
printf '%s\n' "$code" > "$BASE/teamcode"
chown "$OWNER:$OWNER" "$BASE/teamcode"
chmod 600 "$BASE/teamcode"

# A new cookie key signs out everyone who logged in with the old code.
rm -rf "$BASE/authkey"
if [ -f "$BASE/war/WEB-INF/appengine-web.xml" ]; then
  sudo -u "$OWNER" "$BASE/apply-config.sh"
  systemctl restart appinventor
  echo "Team code changed. Everyone has been signed out and must sign in with the new code."
else
  echo "Team code saved. It will be used when App Inventor is deployed."
fi
if [ "$show" = 1 ]; then
  echo "New team code: $code"
fi
