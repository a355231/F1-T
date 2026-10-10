#!/usr/bin/env bash
# Tests MITSTATUS and set-ai.sh --model in a folder of their own: a fake systemctl, curl and link scripts, and the
# hub's preset table from this repository. Run: bash collab/pi/test/mitstatus-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # collab/pi
REPO="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/base" "$T/bin"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Fake services: systemctl logs its calls, a restart of the quick tunnel moves its address on, and the Cloudflare tunnel
# counts as running while $T/cf-active exists.
printf '%s\n' '#!/usr/bin/env bash' \
  "if [ \"\$1\" = is-active ]; then [ -e '$T/cf-active' ]; exit \$?; fi" \
  "echo \"systemctl \$*\" >> '$T/systemctl.log'" \
  "if [ \"\$*\" = 'restart cloudflared-quick' ]; then echo \$(( \$(cat '$T/gen' 2>/dev/null || echo 1) + 1 )) > '$T/gen'; fi" \
  'exit 0' > "$T/bin/systemctl"
printf '%s\n' '#!/usr/bin/env bash' "echo 200" > "$T/bin/curl"
printf '%s\n' '#!/usr/bin/env bash' "echo \"systemd-run \$*\" >> '$T/systemd-run.log'" 'exit 0' > "$T/bin/systemd-run"
printf '%s\n' '#!/usr/bin/env bash' "echo https://gen\$(cat '$T/gen' 2>/dev/null || echo 1).trycloudflare.com" \
  > "$T/base/tunnel-url.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$T/base/stable-link.sh"
chmod +x "$T/bin/systemctl" "$T/bin/curl" "$T/bin/systemd-run" "$T/base/tunnel-url.sh" "$T/base/stable-link.sh"
cp "$HERE/set-ai.sh" "$T/base/set-ai.sh"
printf 'k7qm-2xwd-9fha\n' > "$T/base/teamcode"
printf 'Qx7mR2pL\n' > "$T/base/overridepin"
printf 'OPENROUTER_API_KEY=sk-test-123\nAI_MODEL_FAST=mistralai/example-model\n' > "$T/base/ai.env"
chmod 600 "$T/base/ai.env"

export PATH="$T/bin:$PATH" MIT_BASE="$T/base" MIT_HUB="$REPO/collab/server" AI_BASE="$T/base" MIT_CF_CONFIG="$T/none.yml" \
  AI_LOCK="$T/update.lock"
MS="$HERE/mitstatus.sh"

# 1. The status: the link, the codes and the models (the hub's table, with the ai.env override applied)
out="$(bash "$MS" --show 2>&1)"
check "status shows the link" "printf '%s' \"\$out\" | grep -q 'https://gen1.trycloudflare.com'"
check "status shows the access code" "printf '%s' \"\$out\" | grep -q 'Access code:        k7qm-2xwd-9fha'"
check "status shows the override code" "printf '%s' \"\$out\" | grep -q 'Override code:      Qx7mR2pL'"
check "status shows the Smart model" "printf '%s' \"\$out\" | grep -q 'anthropic/claude-haiku-5.5 *(built in)'"
check "status shows the Balanced model" "printf '%s' \"\$out\" | grep -q 'inclusionai/ling-3.1-flash *(built in)'"
check "status shows the Fast override from ai.env" "printf '%s' \"\$out\" | grep -q 'mistralai/example-model *(set in ai.env)'"

# 2. Without the hub's preset table (an install from before it), the status still works
out2="$(MIT_HUB="$T/no-hub" bash "$MS" --show 2>&1)"
check "status without the preset table says so" "printf '%s' \"\$out2\" | grep -q 'does not list them yet'"

# 3. The menu lists the six options; a wrong choice is refused; 6 exits
out3="$(printf 'x\n7\n' | bash "$MS" 2>&1)"; rc3=$?
check "menu lists the options" "printf '%s' \"\$out3\" | grep -q '1. Change AI models' && printf '%s' \"\$out3\" | grep -q '6. Update' && printf '%s' \"\$out3\" | grep -q '7. Exit'"
check "a wrong choice is refused" "printf '%s' \"\$out3\" | grep -q 'Type a number from 1 to 7.'"
check "7 exits with 0" "[ \$rc3 -eq 0 ]"

# 4. Change AI models: Balanced to a new name
printf '1\n2\nanthropic/claude-haiku-5.5\n\n7\n' | bash "$MS" > "$T/out4" 2>&1
check "Balanced is set in ai.env" "grep -q '^AI_MODEL_BALANCED=anthropic/claude-haiku-5.5$' '$T/base/ai.env'"
check "the other override is kept" "grep -q '^AI_MODEL_FAST=mistralai/example-model$' '$T/base/ai.env'"
check "the key is kept" "grep -q '^OPENROUTER_API_KEY=sk-test-123$' '$T/base/ai.env'"
check "ai.env stays mode 600" "[ \"\$(stat -c %a '$T/base/ai.env')\" = 600 ]"
check "the hub restarts after a model change" "grep -q 'restart collab-hub' '$T/systemctl.log'"

# 5. Change AI models: back to the built-in model
printf '1\n3\ndefault\n\n7\n' | bash "$MS" > "$T/out5" 2>&1
check "default removes the Fast override" "! grep -q '^AI_MODEL_FAST=' '$T/base/ai.env'"

# 6. New link: the quick tunnel restarts and the new address is shown
printf '2\n\n7\n' | bash "$MS" > "$T/out6" 2>&1
check "new link restarts the quick tunnel" "grep -q 'restart cloudflared-quick' '$T/systemctl.log'"
check "new link shows the new address" "grep -q 'New link: https://gen2.trycloudflare.com' '$T/out6'"

# 7. Restart: App Inventor and the hub, not the tunnel
printf '3\n\n7\n' | bash "$MS" > "$T/out7" 2>&1
check "restart restarts App Inventor and the hub" "grep -q 'restart appinventor collab-hub' '$T/systemctl.log'"
check "restart does not restart the tunnel again" "[ \"\$(grep -c 'restart cloudflared-quick' '$T/systemctl.log')\" = 1 ]"
check "restart reports App Inventor running" "grep -q 'App Inventor is running again' '$T/out7'"

# 8. Access code and override code run their own scripts (stand-ins here)
printf '#!/usr/bin/env bash\necho "set-team-code called"\n' > "$T/base/set-team-code.sh"
chmod +x "$T/base/set-team-code.sh"
printf '4\n\n7\n' | bash "$MS" > "$T/out8" 2>&1
check "change access code runs set-team-code.sh" "grep -q 'set-team-code called' '$T/out8'"
cp "$HERE/set-ai.sh" "$T/base/set-ai.sh"
printf '5\n\n7\n' | bash "$MS" > "$T/out8b" 2>&1
check "change override code runs set-ai.sh --pin" "grep -q 'Full-app PIN' '$T/out8b' || grep -q 'Full-app PIN saved' '$T/out8b' || grep -q 'The PIN must be' '$T/out8b'"

# 9. set-ai.sh --model: rules and results
cp "$HERE/set-ai.sh" "$T/base/set-ai.sh"
bash "$T/base/set-ai.sh" --model gpt inclusionai/x > /dev/null 2>&1; rc=$?
check "an unknown preset is refused" "[ $rc -eq 1 ]"
before="$(cat "$T/base/ai.env")"
bash "$T/base/set-ai.sh" --model smart "bad name" > /dev/null 2>&1; rc=$?
check "a model name with a space is refused" "[ $rc -eq 1 ] && [ \"\$(cat '$T/base/ai.env')\" = \"\$before\" ]"
bash "$T/base/set-ai.sh" --model smart anthropic/claude-haiku-5.5 > /dev/null 2>&1
check "--model sets a preset" "grep -q '^AI_MODEL_SMART=anthropic/claude-haiku-5.5$' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model smart --reset > /dev/null 2>&1
check "--reset removes the preset's override" "! grep -q '^AI_MODEL_SMART=' '$T/base/ai.env'"
check "--reset keeps the key" "grep -q '^OPENROUTER_API_KEY=sk-test-123$' '$T/base/ai.env'"

# 11. The permanent link: a Cloudflare tunnel (running or stopped), a Tailscale link, both, or neither
printf 'tunnel: 1234\ncredentials-file: /x/1234.json\ningress:\n  - hostname: app.example.test\n    service: http://127.0.0.1:8080\n  - service: http_status:404\n' > "$T/cf.yml"
rm -f "$T/cf-active" "$T/base/stable-link"
out11="$(MIT_CF_CONFIG="$T/none.yml" bash "$MS" --show 2>&1)"
check "without a permanent link the status says to try Cloudflare" "printf '%s' \"\$out11\" | grep -q 'none yet. Try Cloudflare' && printf '%s' \"\$out11\" | grep -q 'Temporary link:'"
touch "$T/cf-active"
out12="$(MIT_CF_CONFIG="$T/cf.yml" bash "$MS" --show 2>&1)"
check "a running Cloudflare tunnel is shown as the permanent link" "printf '%s' \"\$out12\" | grep -q 'Permanent link:     https://app.example.test  (Cloudflare)' && ! printf '%s' \"\$out12\" | grep -q 'Try Cloudflare'"
check "the temporary link is not shown once there is a permanent one" "! printf '%s' \"\$out12\" | grep -q 'Temporary link'"
rm -f "$T/cf-active"
out13="$(MIT_CF_CONFIG="$T/cf.yml" bash "$MS" --show 2>&1)"
check "a configured but stopped Cloudflare tunnel says so" "printf '%s' \"\$out13\" | grep -q 'tunnel is not running'"
echo https://pi-test.example.ts.net > "$T/base/stable-link"
out14="$(MIT_CF_CONFIG="$T/none.yml" bash "$MS" --show 2>&1)"
check "a Tailscale link is shown as the permanent link" "printf '%s' \"\$out14\" | grep -q 'Permanent link:     https://pi-test.example.ts.net  (Tailscale)'"
out15="$(MIT_CF_CONFIG="$T/cf.yml" bash "$MS" --show 2>&1)"
check "both permanent links are shown" "printf '%s' \"\$out15\" | grep -q '(Cloudflare' && printf '%s' \"\$out15\" | grep -q '(Tailscale)'"
rm -f "$T/base/stable-link"

# 12. stable-link.sh records the link when Funnel is on, and removes it when Funnel is off (with a stand-in tailscale)
printf '%s\n' '#!/usr/bin/env bash' 'case "$*" in "funnel status") echo "https://pi-test.example.ts.net" ;; esac' 'exit 0' > "$T/bin/tailscale"
chmod +x "$T/bin/tailscale"
printf 'EXTERNAL_PORT=8081\n' > "$T/hub.service"
STABLE_LINK_FILE="$T/base/stable-link" HUB_UNIT="$T/hub.service" bash "$HERE/stable-link.sh" > "$T/sl-on.out" 2>&1
check "turning Funnel on records the link" "grep -qx 'https://pi-test.example.ts.net' '$T/base/stable-link'"
STABLE_LINK_FILE="$T/base/stable-link" HUB_UNIT="$T/hub.service" bash "$HERE/stable-link.sh" --off > /dev/null 2>&1
check "turning Funnel off removes the record" "[ ! -e '$T/base/stable-link' ]"

# 13. The update: up to date, a newer version declined, accepted (started as a unit of its own), an update already running,
# and a failed check. The update.sh here is a stand-in: its --check reports from the test folder, and nothing else runs.
# The question is printed with echo: read -p shows its prompt only at a terminal, and these tests pipe the answers in.
cat > "$T/base/update.sh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = --check ] || exit 0
here="$(dirname "$0")"
if [ -e "$here/check-fails" ]; then echo "Could not reach GitHub; I will try again at the next half hour."; exit 1; fi
if [ -e "$here/newer" ]; then
  echo "$(date '+%F %T') A newer version exists: abc1234 Test change"
  echo "abc1234 Test change" > "$here/update-available"
else
  echo "$(date '+%F %T') Up to date (test)."
  rm -f "$here/update-available"
fi
exit 0
EOF
chmod +x "$T/base/update.sh"
printf '6\n\n7\n' | bash "$MS" > "$T/out13a" 2>&1
check "an up-to-date app says so" "grep -q 'Up to date (test)' '$T/out13a'"
check "an up-to-date app asks nothing" "! grep -q 'Update to' '$T/out13a'"
touch "$T/base/newer"
printf '6\nn\n\n7\n' | bash "$MS" > "$T/out13b" 2>&1
check "a newer version is offered by name" "grep -q 'Update to abc1234 Test change?' '$T/out13b'"
check "declining starts nothing" "grep -q 'Not updated.' '$T/out13b' && [ ! -e '$T/systemd-run.log' ]"
printf '6\ny\n\n7\n' | bash "$MS" > "$T/out13c" 2>&1
check "accepting starts update.sh --now as a unit of its own" "grep -q -- '--unit=collab-update-now' '$T/systemd-run.log' && grep -q 'update.sh --now' '$T/systemd-run.log'"
check "accepting says the update runs in the background" "grep -q 'running in the background' '$T/out13c'"
exec 8>"$T/update.lock"; flock -x 8
printf '6\n\n7\n' | bash "$MS" > "$T/out13d" 2>&1
exec 8>&-
check "an update already running is reported, not started again" "grep -q 'An update is already running' '$T/out13d' && [ \"\$(grep -c -- '--unit=collab-update-now' '$T/systemd-run.log')\" = 1 ]"
touch "$T/base/check-fails"
printf '6\n\n7\n' | bash "$MS" > "$T/out13e" 2>&1
check "a failed check says so" "grep -q 'Could not check' '$T/out13e'"
rm -f "$T/base/newer" "$T/base/check-fails"

# 10. The changed scripts parse
for f in "$HERE/mitstatus.sh" "$HERE/set-ai.sh" "$HERE/stable-link.sh" "$HERE/build-on-pi.sh" "$HERE/install.sh"; do
  check "syntax: $(basename "$f")" "bash -n '$f'"
done

echo
if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "$fails check(s) failed."; exit 1; fi
