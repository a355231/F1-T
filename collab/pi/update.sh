#!/usr/bin/env bash
# Looks for a newer version of this software and, if you want, installs it when nobody is online.
#
#   sudo /opt/appinventor/update.sh [--check | --now]
#   sudo /opt/appinventor/update.sh --mode install|notify|off     # what the nightly check does
#
# Modes (stored in /opt/appinventor/update-mode):
#   install  update by itself at night when nobody is online (default)
#   notify   only tell the team that a new version exists
#   off      do nothing
# A systemd timer runs this at about 4 am (collab-update.timer). Your projects and the team code
# stay as they are. The previous version is kept in /opt/appinventor/war.previous.
set -uo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

BASE=/opt/appinventor
MODE_FILE="$BASE/update-mode"

if [ "${1:-}" = "--mode" ]; then
  case "${2:-}" in
    install|notify|off) echo "$2" > "$MODE_FILE"; echo "Updates: $2" ;;
    *) echo "Use: update.sh --mode install|notify|off" >&2; exit 1 ;;
  esac
  exit 0
fi

mode="$(cat "$MODE_FILE" 2>/dev/null || echo install)"
force=0
[ "${1:-}" = "--now" ] && force=1
if [ "$mode" = off ] && [ "$force" = 0 ] && [ "${1:-}" != "--check" ]; then
  exit 0
fi

REPO="$(cat "$BASE/repo" 2>/dev/null || true)"
if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  echo "I do not know where the downloaded copy is. Run the one-line install once more." >&2
  exit 1
fi
OWNER="$(stat -c %U "$REPO")"
as_owner() { sudo -u "$OWNER" -H "$@"; }
BRANCH="$(as_owner git -C "$REPO" rev-parse --abbrev-ref HEAD)"

if ! as_owner git -C "$REPO" fetch -q origin "$BRANCH"; then
  echo "Could not reach GitHub; will try again later." >&2
  exit 1
fi
here="$(as_owner git -C "$REPO" rev-parse HEAD)"
there="$(as_owner git -C "$REPO" rev-parse "origin/$BRANCH")"
if [ "$here" = "$there" ]; then
  rm -f "$BASE/update-available"
  echo "Up to date ($(cat "$BASE/version" 2>/dev/null || echo "$here"))."
  exit 0
fi
printf '%s\n' "$(as_owner git -C "$REPO" log -1 --format='%h %s' "origin/$BRANCH")" > "$BASE/update-available"
echo "A newer version exists: $(cat "$BASE/update-available")"
[ "${1:-}" = "--check" ] && exit 0
if [ "$mode" != install ] && [ "$force" = 0 ]; then
  exit 0
fi

online="$(curl -fsS -m 10 http://127.0.0.1:8080/collab/status 2>/dev/null |
  python3 -c 'import sys,json; print(len(json.load(sys.stdin)["online"]))' 2>/dev/null || echo 0)"
if [ "$online" != 0 ] && [ "$force" = 0 ]; then
  echo "$online people are online; I will try again later."
  exit 0
fi

echo "Updating..."
as_owner git -C "$REPO" merge --ff-only "origin/$BRANCH" || { echo "Cannot fast-forward the download; update by hand." >&2; exit 1; }
rm -rf "$BASE/war.previous"
rsync -a --exclude WEB-INF/appengine-generated "$BASE/war/" "$BASE/war.previous/"
if SUDO_USER="$OWNER" DEBIAN_FRONTEND=noninteractive "$REPO/collab/pi/install.sh" --build-here; then
  rm -f "$BASE/update-available"
  echo "Updated."
else
  echo "The update failed. The previous version is in $BASE/war.previous." >&2
  exit 1
fi
