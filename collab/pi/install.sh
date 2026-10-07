#!/usr/bin/env bash
# Setup of the Raspberry Pi that hosts App Inventor for the team.
#   sudo collab/pi/install.sh               # then build on a PC with deploy-from-pc.sh
#   sudo collab/pi/install.sh --build-here  # or build on the Pi itself (slow) and start it
# Needs a 64-bit Raspberry Pi OS (Bookworm or newer) on a Pi 4 or 5 with at least 4 GB of RAM.
# Safe to run again (for example after git pull); the team code and projects are kept.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo $0" >&2
  exit 1
fi
RUN_AS="${SUDO_USER:-pi}"
ARCH="$(dpkg --print-architecture)"
if [ "$ARCH" != "arm64" ]; then
  echo "This needs 64-bit Raspberry Pi OS (found $ARCH)." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD_HERE=0
if [ "${1:-}" = "--build-here" ]; then
  BUILD_HERE=1
fi

echo "== Packages (Java, Node.js, Python for the App Engine SDK)"
apt-get update
apt-get install -y curl rsync python3 nodejs npm
apt-get install -y openjdk-21-jdk-headless || apt-get install -y openjdk-17-jdk-headless
JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
echo "Java: $JAVA_HOME"

echo "== Google Cloud SDK with the App Engine Java dev server"
if [ ! -x /opt/google-cloud-sdk/bin/java_dev_appserver.sh ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/gcloud.tgz" \
    https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-arm.tar.gz
  tar -xzf "$tmp/gcloud.tgz" -C /opt
  rm -rf "$tmp"
  /opt/google-cloud-sdk/bin/gcloud components install app-engine-java --quiet
fi

echo "== cloudflared"
if ! command -v cloudflared >/dev/null; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cloudflared.deb" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  dpkg -i "$tmp/cloudflared.deb"
  rm -rf "$tmp"
fi

echo "== Folders and helper scripts"
mkdir -p /opt/appinventor/war /opt/appinventor/hub /opt/appinventor/tools
install -m 755 "$HERE/apply-config.sh" "$HERE/set-team-code.sh" "$HERE/tunnel-url.sh" \
  "$HERE/show-info.sh" "$HERE/protect-sd.sh" "$HERE/move-data.sh" "$HERE/watchdog.sh" \
  "$HERE/update.sh" "$HERE/stable-link.sh" "$HERE/set-build-server.sh" "$HERE/set-ai.sh" /opt/appinventor/
echo "$(cd "$HERE/../.." && pwd)" > /opt/appinventor/repo
(cd "$HERE" && git rev-parse --short HEAD 2>/dev/null) > /opt/appinventor/version || true
[ -f /opt/appinventor/update-mode ] || echo install > /opt/appinventor/update-mode
chown -R "$RUN_AS:$RUN_AS" /opt/appinventor

echo "== Team code"
if [ -s /opt/appinventor/teamcode ]; then
  echo "Keeping the existing team code (change it with: sudo /opt/appinventor/set-team-code.sh)"
else
  /opt/appinventor/set-team-code.sh
fi

echo "== Services"
for unit in appinventor collab-hub cloudflared-quick; do
  sed -e "s#@USER@#$RUN_AS#g" -e "s#@JAVA_HOME@#$JAVA_HOME#g" \
    "$HERE/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
done
for unit in collab-update.service collab-update.timer collab-watchdog.service collab-watchdog.timer; do
  cp "$HERE/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable appinventor collab-hub cloudflared-quick collab-update.timer collab-watchdog.timer
systemctl start collab-update.timer collab-watchdog.timer

echo "== Gentler on the SD card"
/opt/appinventor/protect-sd.sh || true

IP="$(hostname -I | awk '{print $1}')"

if [ "$BUILD_HERE" = 1 ]; then
  "$HERE/build-on-pi.sh"
  echo "== Waiting for the Cloudflare address"
  url=""
  for _ in $(seq 1 30); do
    url="$(/opt/appinventor/tunnel-url.sh 2>/dev/null || true)"
    [ -n "$url" ] && break
    sleep 2
  done
  echo
  echo "App Inventor is running and will start again on every boot."
  /opt/appinventor/show-info.sh
  exit 0
fi

cat <<EOF

Setup done. Next:
  1. On your PC, build App Inventor and copy it here:
       collab/pi/deploy-from-pc.sh $RUN_AS@$IP
     (or build on this Pi instead: sudo $HERE/install.sh --build-here)
  2. Give your team the team code. Everyone signs in with their name and that code.
  3. LAN address:      http://$IP:8080
     Internet address: /opt/appinventor/tunnel-url.sh
EOF
