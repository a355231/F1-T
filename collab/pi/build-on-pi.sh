#!/usr/bin/env bash
# Builds App Inventor on this Raspberry Pi from this copy of the repository and installs it into
# /opt/appinventor, then (re)starts the services. Called by: sudo collab/pi/install.sh --build-here
# The first build takes a long time on a Pi (roughly 30-60 minutes).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
RUN_AS="${SUDO_USER:-pi}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE=/opt/appinventor
JDK=/opt/jdk-11

echo "== Java 11 for building (Eclipse Temurin)"
if [ ! -x "$JDK/bin/javac" ]; then
  case "$(uname -m)" in
    aarch64|arm64) arch=aarch64 ;;
    x86_64) arch=x64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  meta="$(curl -fsSL "https://api.adoptium.net/v3/assets/latest/11/hotspot?architecture=$arch&image_type=jdk&os=linux")"
  link="$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["binary"]["package"]["link"])')"
  sum="$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["binary"]["package"]["checksum"])')"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/jdk.tgz" "$link"
  echo "$sum  $tmp/jdk.tgz" | sha256sum -c --quiet
  mkdir -p "$JDK"
  tar -xzf "$tmp/jdk.tgz" -C "$JDK" --strip-components=1
  rm -rf "$tmp"
fi
apt-get install -y ant rsync librsvg2-bin

# The GWT compiler peaks at about 3 GB with a 2.5 GB heap. On Pis with less than 6 GB of memory,
# add swap for the build and take it away afterwards.
mem_mb=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 ))
heap=4g
swapfile=""
if [ "$mem_mb" -lt 6000 ]; then
  heap=2500m
  swapfile=/var/tmp/appinventor-build.swap
  if ! swapon --show=NAME --noheadings | grep -qx "$swapfile"; then
    fallocate -l 2G "$swapfile"
    chmod 600 "$swapfile"
    mkswap "$swapfile" >/dev/null
    swapon "$swapfile"
  fi
fi
cleanup() {
  if [ -n "$swapfile" ]; then
    swapoff "$swapfile" 2>/dev/null || true
    rm -f "$swapfile"
  fi
}
trap cleanup EXIT

echo "== Building App Inventor (this takes a while on a Pi)"
chown -R "$RUN_AS:$RUN_AS" "$ROOT"
sudo -u "$RUN_AS" -H env JAVA_HOME="$JDK" PATH="$JDK/bin:$PATH" \
  bash -c "cd '$ROOT/appinventor' && ant -q MakeAuthKey &&
    ant -q -Dgwt.heap=$heap '-Dclient.dev.flags=-style obfuscated -optimize 9' noplay"

echo "== Installing into $BASE"
mkdir -p "$BASE/war" "$BASE/hub" "$BASE/tools"
rsync -a --delete --exclude 'WEB-INF/appengine-generated' \
  "$ROOT/appinventor/appengine/build/war/" "$BASE/war/"
rsync -a --delete --exclude node_modules "$ROOT/collab/server/" "$BASE/hub/"
install -m 644 "$ROOT/appinventor/lib/keyczar/KeyczarTool.jar" "$BASE/tools/"
install -m 755 "$ROOT/collab/pi/apply-config.sh" "$ROOT/collab/pi/set-team-code.sh" \
  "$ROOT/collab/pi/tunnel-url.sh" "$ROOT/collab/pi/show-info.sh" "$ROOT/collab/pi/protect-sd.sh" \
  "$ROOT/collab/pi/move-data.sh" "$ROOT/collab/pi/watchdog.sh" "$ROOT/collab/pi/update.sh" \
  "$ROOT/collab/pi/stable-link.sh" "$ROOT/collab/pi/set-build-server.sh" "$ROOT/collab/pi/set-ai.sh" "$BASE/"
echo "$ROOT" > "$BASE/repo"
(cd "$ROOT" && git rev-parse --short HEAD) > "$BASE/version" 2>/dev/null || echo unknown > "$BASE/version"
chown -R "$RUN_AS:$RUN_AS" "$BASE"
sudo -u "$RUN_AS" -H "$BASE/apply-config.sh"
sudo -u "$RUN_AS" -H bash -c "cd '$BASE/hub' && npm install --omit=dev --no-audit --no-fund --silent"

echo "== Starting (and starting on every boot)"
systemctl enable appinventor collab-hub cloudflared-quick
systemctl restart appinventor collab-hub
# Left running if it already is, so the internet address stays the same across updates.
systemctl start cloudflared-quick
