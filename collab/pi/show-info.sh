#!/usr/bin/env bash
# Shows how to open App Inventor and the team code.   /opt/appinventor/show-info.sh
BASE=/opt/appinventor

code="$(cat "$BASE/teamcode" 2>/dev/null || sudo cat "$BASE/teamcode" 2>/dev/null)"
code="${code//[$'\r\n']/}"
ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
url="$("$BASE/tunnel-url.sh" 2>/dev/null || true)"

echo
echo "  App Inventor Team Edition"
echo "  -------------------------"
echo "  Link (anywhere):  ${url:-not ready yet - wait a minute and run $BASE/show-info.sh again}"
stable="$("$BASE/stable-link.sh" --url 2>/dev/null || true)"
[ -n "$stable" ] && echo "  Stable link:      $stable"
echo "  Link (home Wi-Fi): http://${ip:-<pi-address>}:8080"
echo "  Team code:        ${code:-not set - run: sudo $BASE/set-team-code.sh}"
echo
echo "  Everyone signs in with their own name and that code."
echo "  Change the code any time: Team panel > Change team code, or sudo $BASE/set-team-code.sh"

echo "  Version:          $(cat "$BASE/version" 2>/dev/null || echo unknown)  (updates: $(cat "$BASE/update-mode" 2>/dev/null || echo install))"
[ -s "$BASE/update-available" ] && echo "  A newer version is available: $(cat "$BASE/update-available")  (sudo $BASE/update.sh --now)"
"$BASE/protect-sd.sh" --status 2>/dev/null | grep 'written since' | sed 's/^ */  SD card:          /'
problems=0
for unit in appinventor collab-hub cloudflared-quick; do
  state="$(systemctl is-active "$unit" 2>/dev/null)"
  if [ "$state" != "active" ]; then
    echo "  WARNING: $unit is $state (try: sudo systemctl start $unit)"
    problems=1
  fi
done
holder="$(sudo ss -ltnpH 'sport = :8080' 2>/dev/null | head -n 1)"
if [ -n "$holder" ] && ! printf '%s' "$holder" | grep -q '"node"'; then
  echo "  WARNING: another program is using port 8080 (that is where App Inventor listens):"
  echo "    $holder"
  problems=1
fi
[ "$problems" = 0 ] && echo "  Everything is running."
echo
