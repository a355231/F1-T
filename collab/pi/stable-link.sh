#!/usr/bin/env bash
# A link that never changes, for free, with Tailscale Funnel.
#
#   sudo /opt/appinventor/stable-link.sh          # turn it on and show the link
#   sudo /opt/appinventor/stable-link.sh --off    # turn it off
#   /opt/appinventor/stable-link.sh --url         # just print the link, if there is one
#
# The Cloudflare quick tunnel keeps working as well; its address changes whenever it restarts.
# Funnel sends traffic to the hub's second port (8081), which treats everyone as coming from the
# internet, so the Pi-only pages stay closed.
set -uo pipefail

# The link is written to STATE when Funnel is turned on, and removed when it is turned off. MITSTATUS reads it, so it
# knows there is a permanent address without parsing Tailscale's status text.
STATE="${STABLE_LINK_FILE:-/opt/appinventor/stable-link}"
HUB_UNIT="${HUB_UNIT:-/etc/systemd/system/collab-hub.service}"

url() {
  command -v tailscale >/dev/null 2>&1 || return 1
  tailscale funnel status 2>/dev/null | grep -oE 'https://[A-Za-z0-9.-]+\.ts\.net' | head -n 1
}

case "${1:-}" in
  --url) url; exit 0 ;;
  --off)
    [ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
    tailscale funnel --https=443 off 2>/dev/null || tailscale funnel reset
    rm -f "$STATE"
    echo "The stable link is off."
    exit 0 ;;
esac

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale is not installed on this Pi. Install it and sign in first:"
  echo "    curl -fsSL https://tailscale.com/install.sh | sh"
  echo "    sudo tailscale up"
  echo "Then run this again."
  exit 1
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale is installed but not signed in. Run: sudo tailscale up"
  exit 1
fi
if ! grep -q 'EXTERNAL_PORT' "$HUB_UNIT" 2>/dev/null; then
  echo "The hub does not have its second port yet; run the one-line install again to update." >&2
  exit 1
fi
echo "Turning on Tailscale Funnel. If it asks you to enable Funnel for your tailnet, open the"
echo "link it prints, then run this again."
if ! tailscale funnel --bg 8081; then
  exit 1
fi
sleep 1
link="$(url)"
echo
if [ -n "$link" ]; then
  printf '%s\n' "$link" > "$STATE"
  echo "  Stable link: $link"
  echo "  Everyone signs in with their name and the team code, as always."
else
  echo "Funnel is on, but I could not read the link. Run: tailscale funnel status"
fi
