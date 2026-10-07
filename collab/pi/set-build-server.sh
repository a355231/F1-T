#!/usr/bin/env bash
# Points Build > Android App at a PC that runs the build server (see collab/pc/build-server.sh).
#
#   sudo /opt/appinventor/set-build-server.sh 192.168.4.20:9990
#   sudo /opt/appinventor/set-build-server.sh --off
#
# The address is kept in /opt/appinventor/build-server and re-applied after every update.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
BASE=/opt/appinventor
OWNER="$(stat -c %U "$BASE")"
case "${1:-}" in
  --off) rm -f "$BASE/build-server"; host="localhost:9990" ;;
  "") echo "Usage: $0 <pc-address>:9990   or   $0 --off" >&2; exit 1 ;;
  *) host="$1"
     case "$host" in *[!A-Za-z0-9.:-]*) echo "That does not look like host:port." >&2; exit 1 ;; esac
     echo "$host" > "$BASE/build-server"; chown "$OWNER:$OWNER" "$BASE/build-server" ;;
esac
if [ "${1:-}" = --off ]; then
  sed -i "s#\(name=\"build.server.host\" value=\"\)[^\"]*#\1$host#" "$BASE/war/WEB-INF/appengine-web.xml"
else
  sudo -u "$OWNER" -H "$BASE/apply-config.sh"
fi
systemctl restart appinventor
echo "Build server: $host (App Inventor is restarting)"
