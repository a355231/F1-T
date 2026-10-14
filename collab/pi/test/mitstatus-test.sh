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
check "status shows that the override code is set, and never the code itself" "printf '%s' \"\$out\" | grep -q 'Override code:      set' && ! printf '%s' \"\$out\" | grep -q Qx7mR2pL"
check "status shows the Smart model" "printf '%s' \"\$out\" | grep -q 'anthropic/claude-haiku-5.5 *(built in)'"
check "status shows the Balanced model" "printf '%s' \"\$out\" | grep -q 'inclusionai/ling-3.1-flash *(built in)'"
check "status shows the Fast override from ai.env" "printf '%s' \"\$out\" | grep -q 'mistralai/example-model *(set in ai.env)'"

# 2. Without a model list anywhere (no preset table in the hub, no project folder), the status still works and says so
out2="$(MIT_HUB="$T/no-hub" bash "$MS" --show 2>&1)"
check "status without a model list says so" "printf '%s' \"\$out2\" | grep -q 'have no OpenRouter model list'"

# 3. The menu lists the six options; a wrong choice is refused; 6 exits
out3="$(printf 'x\n11\n' | bash "$MS" 2>&1)"; rc3=$?
check "menu lists the options" "printf '%s' \"\$out3\" | grep -q '1. Change AI models' && printf '%s' \"\$out3\" | grep -q '6. Update' && printf '%s' \"\$out3\" | grep -q '7. Change API key' && printf '%s' \"\$out3\" | grep -q '11. Exit'"
check "a wrong choice is refused" "printf '%s' \"\$out3\" | grep -q 'Type a number from 1 to 11.'"
check "11 exits with 0" "[ \$rc3 -eq 0 ]"

# 4. Change AI models: Balanced to a new name
printf '1\n2\nanthropic/claude-haiku-5.5\n\n11\n' | bash "$MS" > "$T/out4" 2>&1
check "Balanced is set in ai.env" "grep -q '^AI_MODEL_BALANCED=anthropic/claude-haiku-5.5$' '$T/base/ai.env'"
check "the other override is kept" "grep -q '^AI_MODEL_FAST=mistralai/example-model$' '$T/base/ai.env'"
check "the key is kept" "grep -q '^OPENROUTER_API_KEY=sk-test-123$' '$T/base/ai.env'"
check "ai.env stays mode 600" "[ \"\$(stat -c %a '$T/base/ai.env')\" = 600 ]"
check "the hub restarts after a model change" "grep -q 'restart collab-hub' '$T/systemctl.log'"

# 5. Change AI models: back to the built-in model
printf '1\n3\ndefault\n\n11\n' | bash "$MS" > "$T/out5" 2>&1
check "default removes the Fast override" "! grep -q '^AI_MODEL_FAST=' '$T/base/ai.env'"

# 6. New link: the quick tunnel restarts and the new address is shown
printf '2\n\n11\n' | bash "$MS" > "$T/out6" 2>&1
check "new link restarts the quick tunnel" "grep -q 'restart cloudflared-quick' '$T/systemctl.log'"
check "new link shows the new address" "grep -q 'New link: https://gen2.trycloudflare.com' '$T/out6'"

# 7. Restart: App Inventor and the hub, not the tunnel
printf '3\n\n11\n' | bash "$MS" > "$T/out7" 2>&1
check "restart restarts App Inventor and the hub" "grep -q 'restart appinventor collab-hub' '$T/systemctl.log'"
check "restart does not restart the tunnel again" "[ \"\$(grep -c 'restart cloudflared-quick' '$T/systemctl.log')\" = 1 ]"
check "restart reports App Inventor running" "grep -q 'App Inventor is running again' '$T/out7'"

# 8. Access code and override code run their own scripts (stand-ins here)
printf '#!/usr/bin/env bash\necho "set-team-code called"\n' > "$T/base/set-team-code.sh"
chmod +x "$T/base/set-team-code.sh"
printf '4\n\n11\n' | bash "$MS" > "$T/out8" 2>&1
check "change access code runs set-team-code.sh" "grep -q 'set-team-code called' '$T/out8'"
cp "$HERE/set-ai.sh" "$T/base/set-ai.sh"
printf '5\n\n11\n' | bash "$MS" > "$T/out8b" 2>&1
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
# The stand-in keeps Funnel on until it is turned off; FAKE_FUNNEL_STUCK makes turning it off fail.
printf '%s\n' '#!/usr/bin/env bash' "flag=\"$T/funnel-off\"" 'case "$*" in' '"funnel status") [ -e "$flag" ] || echo "https://pi-test.example.ts.net" ;;' '"funnel --https=443 off") [ -n "${FAKE_FUNNEL_STUCK:-}" ] || touch "$flag" ;;' 'esac' 'exit 0' > "$T/bin/tailscale"
chmod +x "$T/bin/tailscale"
printf 'EXTERNAL_PORT=8081\n' > "$T/hub.service"
STABLE_LINK_FILE="$T/base/stable-link" HUB_UNIT="$T/hub.service" bash "$HERE/stable-link.sh" > "$T/sl-on.out" 2>&1
check "turning Funnel on records the link" "grep -qx 'https://pi-test.example.ts.net' '$T/base/stable-link'"
STABLE_LINK_FILE="$T/base/stable-link" HUB_UNIT="$T/hub.service" bash "$HERE/stable-link.sh" --off > /dev/null 2>&1
check "turning Funnel off removes the record" "[ ! -e '$T/base/stable-link' ]"
rm -f "$T/funnel-off"
printf '%s\n' 'https://pi-test.example.ts.net' > "$T/base/stable-link"
FAKE_FUNNEL_STUCK=1 STABLE_LINK_FILE="$T/base/stable-link" HUB_UNIT="$T/hub.service" bash "$HERE/stable-link.sh" --off > "$T/sl-stuck.out" 2>&1; stuck_rc=$?
check "a Funnel that stays on is reported as still on, and its record is kept" "[ '$stuck_rc' = 1 ] && [ -e '$T/base/stable-link' ] && grep -q 'still on' '$T/sl-stuck.out'"

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
printf '6\n\n11\n' | bash "$MS" > "$T/out13a" 2>&1
check "an up-to-date app says so" "grep -q 'Up to date (test)' '$T/out13a'"
check "an up-to-date app asks nothing" "! grep -q 'Update to' '$T/out13a'"
touch "$T/base/newer"
printf '6\nn\n\n11\n' | bash "$MS" > "$T/out13b" 2>&1
check "a newer version is offered by name" "grep -q 'Update to abc1234 Test change?' '$T/out13b'"
check "declining starts nothing" "grep -q 'Not updated.' '$T/out13b' && [ ! -e '$T/systemd-run.log' ]"
printf '6\ny\n\n11\n' | bash "$MS" > "$T/out13c" 2>&1
check "accepting starts update.sh --now as a unit of its own" "grep -q -- '--unit=collab-update-now' '$T/systemd-run.log' && grep -q 'update.sh --now' '$T/systemd-run.log'"
check "accepting says the update runs in the background" "grep -q 'running in the background' '$T/out13c'"
exec 8>"$T/update.lock"; flock -x 8
printf '6\n\n11\n' | bash "$MS" > "$T/out13d" 2>&1
exec 8>&-
check "an update already running is reported, not started again" "grep -q 'An update is already running' '$T/out13d' && [ \"\$(grep -c -- '--unit=collab-update-now' '$T/systemd-run.log')\" = 1 ]"
touch "$T/base/check-fails"
printf '6\n\n11\n' | bash "$MS" > "$T/out13e" 2>&1
check "a failed check says so" "grep -q 'Could not check' '$T/out13e'"
rm -f "$T/base/newer" "$T/base/check-fails"

# 14. A hub from before the preset table: the models come from the project folder, the status says they take effect once
# the hub is updated, and Change AI models works from that list. A current hub gets no such note.
mkdir -p "$T/old-hub"
printf 'module.exports = {};\n' > "$T/old-hub/ai.js"
printf '%s\n' "$REPO" > "$T/base/repo"
out14="$(MIT_HUB="$T/old-hub" bash "$MS" --show 2>&1)"
check "an older hub still shows the models, from the project folder" "printf '%s' \"\$out14\" | grep -q 'Smart     Claude Haiku 5.5' && printf '%s' \"\$out14\" | grep -q 'anthropic/claude-haiku-5.5 *(built in)'"
check "an older hub says the models take effect once it is updated" "printf '%s' \"\$out14\" | grep -q 'is older and does not use these yet'"
out15="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "a current hub gets no older note" "! printf '%s' \"\$out15\" | grep -q 'is older'"
printf '1\n\n\n11\n' | MIT_HUB="$T/old-hub" bash "$MS" > "$T/out16" 2>&1
check "Change AI models works from the project folder's list" "grep -q 'Which OpenRouter model should change' '$T/out16' && grep -q 'Smart' '$T/out16'"
rm -f "$T/base/repo"

# 15. A dashboard tunnel keeps its hostname in the dashboard, so the install command writes it to $BASE/cloudflare-hostname
printf 'app.from-file.test\n' > "$T/base/cloudflare-hostname"
touch "$T/cf-active"
out17="$(MIT_CF_CONFIG="$T/none.yml" bash "$MS" --show 2>&1)"
check "a dashboard tunnel's hostname is shown as the permanent link" "printf '%s' \"\$out17\" | grep -q 'Permanent link:     https://app.from-file.test  (Cloudflare)'"
rm -f "$T/cf-active" "$T/base/cloudflare-hostname"

# 16. Change API key (option 7) runs set-ai.sh, which asks for the key, saves it, and restarts the hub
out16b="$(printf '7\nsk-new-test-key-123\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
check "option 7 runs the key setup and says the helper is on" "printf '%s' \"\$out16b\" | grep -q 'The AI helper is on'"
check "the new key is saved in ai.env" "grep -q '^OPENROUTER_API_KEY=sk-new-test-key-123$' '$T/base/ai.env'"
check "the key is saved once, and the other settings are kept" "[ \"\$(grep -c '^OPENROUTER_API_KEY=' '$T/base/ai.env')\" = 1 ] && grep -q '^AI_DAILY_LIMIT=' '$T/base/ai.env'"
check "the hub restarts after a new key" "grep -q 'restart collab-hub' '$T/systemctl.log'"

# 17. A preset whose model is changed in ai.env shows the name of that model
printf 'AI_MODEL_BALANCED=anthropic/claude-haiku-5.5\n' >> "$T/base/ai.env"
out17b="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "a changed model shows its own name in the status" "printf '%s' \"\$out17b\" | grep -q 'Balanced  Claude Haiku 5.5'"
check "the old name is gone from the changed preset" "! printf '%s' \"\$out17b\" | grep -q 'Balanced  Ling 3.1 Flash'"

# 18. OpenCode Go: --provider switches the service and asks for its key; the old model overrides go; the status follows
printf 'sk-opencode-test-456\n' | bash "$T/base/set-ai.sh" --provider opencode > "$T/out18" 2>&1
check "--provider opencode records the service" "grep -qx 'AI_PROVIDER=opencode' '$T/base/ai.env'"
check "the OpenCode key is saved under its own name" "grep -qx 'OPENCODE_API_KEY=sk-opencode-test-456' '$T/base/ai.env'"
check "the OpenRouter key is kept" "grep -qx 'OPENROUTER_API_KEY=sk-new-test-key-123' '$T/base/ai.env'"
check "the model overrides of each service are kept" "grep -qx 'AI_MODEL_BALANCED=anthropic/claude-haiku-5.5' '$T/base/ai.env'"
check "the switch says the service is now OpenCode Go" "grep -q 'The service is now OpenCode Go' '$T/out18'"
check "--status shows the provider" "bash '$T/base/set-ai.sh' --status > '$T/out18s' && grep -q 'Provider: OpenCode Go' '$T/out18s'"
out18b="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "the status shows the OpenCode provider and its models" "printf '%s' \"\$out18b\" | grep -q 'AI provider:        OpenCode Go' && printf '%s' \"\$out18b\" | grep -q 'Smart     Muse Spark 1.3'"
check "--model takes a model name without a slash, for the service in use" "bash '$T/base/set-ai.sh' --model fast deepseek-v4-flash >/dev/null 2>&1 && grep -qx 'AI_OPENCODE_MODEL_FAST=deepseek-v4-flash' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model fast --reset >/dev/null 2>&1
printf 'sk-new-test-key-123\n' | bash "$T/base/set-ai.sh" --provider openrouter > "$T/out18c" 2>&1
check "--provider openrouter goes back" "grep -qx 'AI_PROVIDER=openrouter' '$T/base/ai.env'"

# 19. OpenCode Go in MITSTATUS, whichever service is in use: its own key (option 9) and its own models (option 8). With
# OpenRouter in use here, the OpenCode Go options must not change the service in use, nor the OpenRouter settings.
out19="$(printf '9\nsk-opencode-new-789\n\n11\n' | bash "$MS" 2>&1)"
check "option 9 asks for the OpenCode Go key and says it is saved" "printf '%s' \"\$out19\" | grep -q 'OpenCode Go key is saved'"
check "option 9 saves the new OpenCode Go key, once" "grep -qx 'OPENCODE_API_KEY=sk-opencode-new-789' '$T/base/ai.env' && [ \"\$(grep -c '^OPENCODE_API_KEY=' '$T/base/ai.env')\" = 1 ]"
check "option 9 keeps the OpenRouter key and the service in use" "grep -qx 'OPENROUTER_API_KEY=sk-new-test-key-123' '$T/base/ai.env' && grep -qx 'AI_PROVIDER=openrouter' '$T/base/ai.env'"
check "option 9 says the OpenCode Go models wait for /beta" "printf '%s' \"\$out19\" | grep -q 'only after someone types /beta'"

out19b="$(printf '8\n1\nkimi-k2.6\n\n11\n' | bash "$MS" 2>&1)"
check "option 8 lists the OpenCode Go models" "printf '%s' \"\$out19b\" | grep -q 'Which OpenCode Go model should change' && printf '%s' \"\$out19b\" | grep -q 'Muse Spark 1.3'"
check "option 8 sets the OpenCode Go model of the preset" "grep -qx 'AI_OPENCODE_MODEL_SMART=kimi-k2.6' '$T/base/ai.env'"
check "option 8 leaves the OpenRouter model of that preset alone" "! grep -q '^AI_MODEL_SMART=' '$T/base/ai.env'"
printf '8\n1\ndefault\n\n11\n' | bash "$MS" > "$T/out19c" 2>&1
check "option 8 with default puts the built-in OpenCode Go model back" "! grep -q '^AI_OPENCODE_MODEL_SMART=' '$T/base/ai.env'"

printf '1\n1\nanthropic/claude-haiku-5.5\n\n11\n' | bash "$MS" > "$T/out19d" 2>&1
check "option 1 changes the OpenRouter model while OpenRouter is in use" "grep -qx 'AI_MODEL_SMART=anthropic/claude-haiku-5.5' '$T/base/ai.env'"
check "option 1 says which service its list is for" "grep -q 'Which OpenRouter model should change' '$T/out19d'"

out19e="$(printf '11\n' | bash "$MS" 2>&1)"
check "the menu names the service in use on options 1 and 7" "printf '%s' \"\$out19e\" | grep -q '1. Change AI models (OpenRouter)' && printf '%s' \"\$out19e\" | grep -q '7. Change API key (OpenRouter)'"
check "the menu offers the OpenCode Go model and key options" "printf '%s' \"\$out19e\" | grep -q '8. Change OpenCode Go models' && printf '%s' \"\$out19e\" | grep -q '9. Change OpenCode Go API key'"
check "the status shows whether each key is set, never the keys" "printf '%s' \"\$out19e\" | grep -q 'AI keys:            OpenRouter set, OpenCode Go set' && ! printf '%s' \"\$out19e\" | grep -q 'sk-'"

bash "$T/base/set-ai.sh" --key gemini > /dev/null 2>&1; rc=$?
check "--key takes openrouter or opencode only" "[ $rc -eq 1 ]"
printf '\n' | bash "$T/base/set-ai.sh" --key opencode > /dev/null 2>&1; rc=$?
check "an empty OpenCode Go key is refused, and the saved one stays" "[ $rc -eq 1 ] && grep -qx 'OPENCODE_API_KEY=sk-opencode-new-789' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model fast kimi-k2.6 --service nonsense > /dev/null 2>&1; rc=$?
check "--service takes openrouter or opencode only" "[ $rc -eq 1 ]"
bash "$T/base/set-ai.sh" --model fast kimi-k2.6 --service > /dev/null 2>&1; rc=$?
check "--service needs a service name" "[ $rc -eq 1 ]"
bash "$T/base/set-ai.sh" --model fast two names > /dev/null 2>&1; rc=$?
check "--model takes one model name" "[ $rc -eq 1 ]"
bash "$T/base/set-ai.sh" --model fast kimi-k2.6 --service opencode > /dev/null 2>&1
check "--service opencode sets that service's model, while OpenRouter is in use" "grep -qx 'AI_OPENCODE_MODEL_FAST=kimi-k2.6' '$T/base/ai.env' && ! grep -q '^AI_MODEL_FAST=' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model fast --service opencode --reset > /dev/null 2>&1
check "--service with --reset puts that service's model back" "! grep -q '^AI_OPENCODE_MODEL_FAST=' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --status > "$T/out19s" 2>&1
check "--status shows each key as set or not set, never a key" "grep -q 'Keys: OpenRouter key set, OpenCode Go key set' '$T/out19s' && ! grep -q 'sk-' '$T/out19s'"

# With OpenCode Go in use: its key and models are the ones the status and option 1 show; option 8 still shows them too.
printf 'sk-opencode-new-789\n' | bash "$T/base/set-ai.sh" --provider opencode > /dev/null 2>&1
out19f="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "with OpenCode Go in use, the status says its models need /beta" "printf '%s' \"\$out19f\" | grep -q 'OpenCode Go (in the companion its models need /beta'"
check "with OpenCode Go in use, the status lists its models" "printf '%s' \"\$out19f\" | grep -q 'AI models (OpenCode Go):' && printf '%s' \"\$out19f\" | grep -q 'Balanced  *Step 5 Preview'"
printf '1\n1\nglm-5.3\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" > "$T/out19g" 2>&1
check "with OpenCode Go in use, option 1 changes its model and is labelled so" "grep -qx 'AI_OPENCODE_MODEL_SMART=glm-5.3' '$T/base/ai.env' && grep -q '1. Change AI models (OpenCode Go)' '$T/out19g'"
out19h="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "a changed OpenCode Go model shows its own name" "printf '%s' \"\$out19h\" | grep -q 'Smart *GLM 5.3'"
printf '8\n\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" > "$T/out19i" 2>&1
check "option 8 with OpenCode Go in use still lists its models" "grep -q 'Which OpenCode Go model should change' '$T/out19i'"

# Back to OpenRouter in use, and the hub with no OpenCode Go list at all
printf 'sk-new-test-key-123\n' | bash "$T/base/set-ai.sh" --provider openrouter > /dev/null 2>&1
check "--provider openrouter brings OpenRouter back as the service in use" "grep -qx 'AI_PROVIDER=openrouter' '$T/base/ai.env'"
out19j="$(printf '8\n\n11\n' | MIT_HUB="$T/no-hub" bash "$MS" 2>&1)"
check "option 8 says so when there is no OpenCode Go list anywhere" "printf '%s' \"\$out19j\" | grep -q 'have no OpenCode Go model list'"
printf '%s\n' "$REPO" > "$T/base/repo"
printf '8\n\n\n11\n' | MIT_HUB="$T/old-hub" bash "$MS" > "$T/out19k" 2>&1
check "an older hub gets the OpenCode Go list from the project folder" "grep -q 'Which OpenCode Go model should change' '$T/out19k'"
rm -f "$T/base/repo"

# 20. The update in the status block: what it is doing and the time left, how the last one went, the version that option 10
# goes back to, and the revert itself. update.sh keeps its state in these files; the test writes them, and holds the update
# lock where a build or a revert is running.
hold_lock() { exec 8>"$T/update.lock"; flock -x 8; }
release_lock() { exec 8>&-; }
row() { printf '  %-20s%s' "$1" "$2"; }
show20() { MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1; }
rm -rf "$T/base/rollback"
rm -f "$T/base/update-failed" "$T/base/update-available" "$T/base/update-progress" "$T/base/update-state" "$T/base/update-mode"
printf 'abc1234\n' > "$T/base/version"
out20a="$(show20)"
want="$(row 'Update:' 'up to date (abc1234)')"
check "a finished update says it is up to date, with its version" "printf '%s' \"\$out20a\" | grep -qF \"\$want\""
want="$(row 'Nightly updates:' 'install')"
check "the status shows the nightly update mode, install by default" "printf '%s' \"\$out20a\" | grep -qF \"\$want\""
check "with no earlier version saved, nothing is offered to go back to" "! printf '%s' \"\$out20a\" | grep -q 'Previous version'"
printf 'notify\n' > "$T/base/update-mode"
want="$(row 'Nightly updates:' 'notify')"
out20b="$(show20)"
check "the nightly update mode shows when it is changed" "printf '%s' \"\$out20b\" | grep -qF \"\$want\""
rm -f "$T/base/update-mode"

# An earlier version is saved: it is offered, unless it is the version running now
mkdir -p "$T/base/rollback"
printf 'def5678\n' > "$T/base/rollback/version"
printf '0123456789abcdef0123456789abcdef01234567\n' > "$T/base/rollback/commit"
out20c="$(show20)"
want="$(row 'Previous version:' 'def5678 (option 10 goes back to it)')"
check "the version before the last update is offered, with option 10" "printf '%s' \"\$out20c\" | grep -qF \"\$want\""
printf 'def5678\n' > "$T/base/version"
out20d="$(show20)"
check "when the saved version is the one running, nothing is offered" "! printf '%s' \"\$out20d\" | grep -q 'Previous version'"
printf 'abc1234\n' > "$T/base/version"

# A build that is running: the time left comes from how long the last build took, or from 45 minutes for a first build
now="$(date +%s)"
printf 'build_seconds=2700\n' > "$T/base/update-state"
printf 'stage=compile\nversion=fed9876\nstage_started=%s\n' "$((now - 600))" > "$T/base/update-progress"
hold_lock; out20e="$(show20)"; release_lock
want="$(row 'Update:' 'building fed9876 now, 10 min in. About 35 min left.')"
check "a running build names its version and the time left" "printf '%s' \"\$out20e\" | grep -qF \"\$want\""
check "the estimate says what it is based on" "printf '%s' \"\$out20e\" | grep -q 'Estimate: 45 min, because the last build here took 45 min.'"
printf 'stage=compile\nversion=fed9876\nstage_started=%s\n' "$((now - 3000))" > "$T/base/update-progress"
hold_lock; out20f="$(show20)"; release_lock
check "a build longer than its estimate says so" "printf '%s' \"\$out20f\" | grep -q 'longer than the 45 min estimate'"
rm -f "$T/base/update-state"
printf 'stage=compile\nversion=fed9876\nstage_started=%s\n' "$((now - 600))" > "$T/base/update-progress"
hold_lock; out20g="$(show20)"; release_lock
check "a first build is estimated at 45 minutes, and the status says so" "printf '%s' \"\$out20g\" | grep -q 'Estimate: 45 min, because a first build takes 30 to 60 min.'"
check "the time left for a first build is worked out from that" "printf '%s' \"\$out20g\" | grep -q 'About 35 min left.'"
printf 'stage=restoring\nversion=fed9876\nstage_started=%s\n' "$now" > "$T/base/update-progress"
hold_lock; out20h="$(show20)"; release_lock
check "a failed update says the previous version is being put back" "printf '%s' \"\$out20h\" | grep -q 'the new version failed, so the previous one is being put back.'"
printf 'stage=start\nversion=fed9876\nstage_started=%s\n' "$((now - 60))" > "$T/base/update-progress"
hold_lock; out20i="$(show20)"; release_lock
check "a version that is starting says how long it has to answer" "printf '%s' \"\$out20i\" | grep -q 'starting fed9876. About 9 min left for it to answer.'"
rm -f "$T/base/update-progress"
hold_lock; out20j="$(show20)"; release_lock
check "a running update with no progress file still says it is running" "printf '%s' \"\$out20j\" | grep -q 'an update is running.'"

# How the last update went: a failure's notice, a newer version, and a version taken back by hand
printf 'The automatic update to fed9876 failed at compile (the build or the install step returned an error). The previous version is running again.\n' > "$T/base/update-failed"
out20k="$(show20)"
want="$(row 'Update:' 'FAILED. The automatic update to fed9876 failed at compile')"
check "a failed update shows its notice in the status" "printf '%s' \"\$out20k\" | grep -qF \"\$want\""
rm -f "$T/base/update-failed"
printf 'abc9999 A newer change\n' > "$T/base/update-available"
out20l="$(show20)"
check "a newer version is named, with what the nightly update does" "printf '%s' \"\$out20l\" | grep -q 'newer version available: abc9999 A newer change. The nightly update installs it at 3 AM'"
printf 'held_short=abc9999\n' >> "$T/base/update-state"
out20m="$(show20)"
check "a version taken back by hand is shown as held" "printf '%s' \"\$out20m\" | grep -q 'abc9999 was taken back by hand, so the nightly update leaves it alone.'"
rm -f "$T/base/update-available" "$T/base/update-state"

# Starting an update says how long the build is estimated to take (the stand-in update.sh of section 13 reports a newer version)
touch "$T/base/newer"
printf 'build_seconds=1500\n' > "$T/base/update-state"
rm -f "$T/systemd-run.log"
out20s="$(printf '6\ny\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
rm -f "$T/base/newer" "$T/base/update-state"
check "starting an update says how long the build is estimated to take" "printf '%s' \"\$out20s\" | grep -q 'estimated to take about 25 min'"

# Option 10: a revert needs an earlier version and no running update. It asks first, then runs update.sh --rollback as a unit.
mkdir -p "$T/base/rollback"
printf 'def5678\n' > "$T/base/rollback/version"
printf '0123456789abcdef0123456789abcdef01234567\n' > "$T/base/rollback/commit"
printf 'abc1234\n' > "$T/base/version"
rm -f "$T/systemd-run.log"
out20n="$(printf '10\nn\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
check "declining the revert changes nothing" "printf '%s' \"\$out20n\" | grep -q 'Not changed.' && [ ! -e '$T/systemd-run.log' ]"
out20o="$(printf '10\ny\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
check "the revert says which version it goes back from and to" "printf '%s' \"\$out20o\" | grep -q 'Go back from abc1234 to def5678'"
check "accepting the revert starts update.sh --rollback as a unit of its own" "grep -q -- '--unit=collab-revert-now' '$T/systemd-run.log' && grep -q -- 'update.sh --rollback' '$T/systemd-run.log'"
check "accepting the revert says it runs in the background" "printf '%s' \"\$out20o\" | grep -q 'Going back in the background'"
rm -rf "$T/base/rollback"
out20p="$(printf '10\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
check "with no earlier version, option 10 says so and starts nothing" "printf '%s' \"\$out20p\" | grep -q 'There is no earlier version saved' && [ \"\$(grep -c 'collab-revert-now' '$T/systemd-run.log')\" = 1 ]"
mkdir -p "$T/base/rollback"
printf 'def5678\n' > "$T/base/rollback/version"
printf '0123456789abcdef0123456789abcdef01234567\n' > "$T/base/rollback/commit"
hold_lock
out20q="$(printf '10\n\n11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
release_lock
check "a revert is refused while an update is running" "printf '%s' \"\$out20q\" | grep -q 'An update is running. Go back once it has finished.' && [ \"\$(grep -c 'collab-revert-now' '$T/systemd-run.log')\" = 1 ]"
out20r="$(printf '11\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
check "the menu lists going back as option 10, and Exit as 11" "printf '%s' \"\$out20r\" | grep -q '10. Go back to the previous version' && printf '%s' \"\$out20r\" | grep -q '11. Exit'"
rm -rf "$T/base/rollback"

# 10. The changed scripts parse
for f in "$HERE/mitstatus.sh" "$HERE/set-ai.sh" "$HERE/stable-link.sh" "$HERE/build-on-pi.sh" "$HERE/install.sh"; do
  check "syntax: $(basename "$f")" "bash -n '$f'"
done

echo
if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "$fails check(s) failed."; exit 1; fi
