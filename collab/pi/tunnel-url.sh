#!/usr/bin/env bash
# Prints the current public address of the Cloudflare quick tunnel. It changes every time the
# tunnel restarts (for example after a reboot).
url="$(journalctl -u cloudflared-quick --no-pager -o cat 2>/dev/null |
  grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1)"
if [ -z "$url" ]; then
  echo "No tunnel address yet. Check: systemctl status cloudflared-quick" >&2
  exit 1
fi
echo "$url"
