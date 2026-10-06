#!/usr/bin/env bash
# Build App Inventor on this PC and copy it, with the collaboration hub, to the Raspberry Pi.
#   collab/pi/deploy-from-pc.sh pi@192.168.1.50
# Needs Java 11 (JDK) and ant 1.10 on this PC, and ssh access to the Pi. The project data on the
# Pi (WEB-INF/appengine-generated) is never overwritten.
set -euo pipefail

TARGET="${1:?usage: $0 user@pi-address}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== Building App Inventor (web IDE only, no companion app)"
  (cd "$ROOT/appinventor" && { [ -f "$HOME/.appinventor/authkey.zip" ] || ant MakeAuthKey; } && ant noplay)
fi

echo "== Copying to $TARGET"
rsync -az --delete --exclude 'WEB-INF/appengine-generated/' \
  "$ROOT/appinventor/appengine/build/war/" "$TARGET:/opt/appinventor/war/"
rsync -az --delete --exclude node_modules \
  "$ROOT/collab/server/" "$TARGET:/opt/appinventor/hub/"

echo "== Restarting services on the Pi"
ssh "$TARGET" 'cd /opt/appinventor/hub && npm install --omit=dev --no-audit --no-fund &&
  sudo systemctl restart appinventor collab-hub cloudflared-quick'

echo "Done. Internet address: ssh $TARGET /opt/appinventor/tunnel-url.sh"
rsync -az "$ROOT/collab/pi/tunnel-url.sh" "$TARGET:/opt/appinventor/tunnel-url.sh"
