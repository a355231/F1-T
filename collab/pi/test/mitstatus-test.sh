#!/usr/bin/env bash
# Tests MITSTATUS and set-ai.sh (the keys and the models of OpenRouter and OpenCode Go) in a folder of their own: a fake
# systemctl, curl and link scripts, and the hub's preset table from this repository. Run: bash collab/pi/test/mitstatus-test.sh
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

# 1. The status: the link, the codes, the AI keys (set or not, never the keys) and the balanced and fast models of both
# services (the hub's table, with the ai.env override applied)
out="$(bash "$MS" --show 2>&1)"
check "status shows the link" "printf '%s' \"\$out\" | grep -q 'https://gen1.trycloudflare.com'"
check "status shows the access code" "printf '%s' \"\$out\" | grep -q 'Access code:        k7qm-2xwd-9fha'"
check "status shows the override code" "printf '%s' \"\$out\" | grep -q 'Override code:      Qx7mR2pL'"
check "status shows whether each AI key is set, never the key" "printf '%s' \"\$out\" | grep -q 'AI keys:            OpenRouter set, OpenCode Go not set' && ! printf '%s' \"\$out\" | grep -q 'sk-test-123'"
check "status shows the Balanced model" "printf '%s' \"\$out\" | grep -q 'inclusionai/ling-3.1-flash *(built in)'"
check "status shows the Fast override from ai.env" "printf '%s' \"\$out\" | grep -q 'mistralai/example-model *(set in ai.env)'"
check "status shows the OpenCode Go models too" "printf '%s' \"\$out\" | grep -q 'AI models (OpenCode Go):' && printf '%s' \"\$out\" | grep -q 'step-5-preview-free *(built in)'"
check "status has the balanced and fast presets only, and no service in use" "! printf '%s' \"\$out\" | grep -q 'Smart' && ! printf '%s' \"\$out\" | grep -q 'AI provider'"

# 2. Without a model list anywhere (no preset table in the hub, no project folder), the status still works and says so
out2="$(MIT_HUB="$T/no-hub" bash "$MS" --show 2>&1)"
check "status without a model list says so" "printf '%s' \"\$out2\" | grep -q 'have no OpenRouter model list'"

# 3. The menu lists the ten options; a wrong choice is refused; 10 exits
out3="$(printf 'x\n10\n' | bash "$MS" 2>&1)"; rc3=$?
check "menu lists the options" "printf '%s' \"\$out3\" | grep -q '1. Change OpenRouter models' && printf '%s' \"\$out3\" | grep -q '6. Update' && printf '%s' \"\$out3\" | grep -q '7. Change OpenRouter API key' && printf '%s' \"\$out3\" | grep -q '10. Exit'"
check "menu offers the OpenCode Go models and key options" "printf '%s' \"\$out3\" | grep -q '8. Change OpenCode Go models' && printf '%s' \"\$out3\" | grep -q '9. Change OpenCode Go API key'"
check "a wrong choice is refused" "printf '%s' \"\$out3\" | grep -q 'Type a number from 1 to 10.'"
check "10 exits with 0" "[ \$rc3 -eq 0 ]"

# 4. Change OpenRouter models (1): Balanced (1) to a new name. The list has balanced and fast only.
printf '1\n1\nanthropic/claude-haiku-5.5\n\n10\n' | bash "$MS" > "$T/out4" 2>&1
check "the model list offers balanced and fast only" "grep -q '1. Balanced  Ling 3.1 Flash' '$T/out4' && grep -q '2. Fast' '$T/out4' && ! grep -q 'Smart' '$T/out4'"
check "Balanced is set in ai.env" "grep -q '^AI_MODEL_BALANCED=anthropic/claude-haiku-5.5$' '$T/base/ai.env'"
check "the other override is kept" "grep -q '^AI_MODEL_FAST=mistralai/example-model$' '$T/base/ai.env'"
check "the key is kept" "grep -q '^OPENROUTER_API_KEY=sk-test-123$' '$T/base/ai.env'"
check "ai.env stays mode 600" "[ \"\$(stat -c %a '$T/base/ai.env')\" = 600 ]"
check "the hub restarts after a model change" "grep -q 'restart collab-hub' '$T/systemctl.log'"

# 5. Change OpenRouter models (1): Fast (2) back to the built-in model
printf '1\n2\ndefault\n\n10\n' | bash "$MS" > "$T/out5" 2>&1
check "default removes the Fast override" "! grep -q '^AI_MODEL_FAST=' '$T/base/ai.env'"

# 6. New link: the quick tunnel restarts and the new address is shown
printf '2\n\n10\n' | bash "$MS" > "$T/out6" 2>&1
check "new link restarts the quick tunnel" "grep -q 'restart cloudflared-quick' '$T/systemctl.log'"
check "new link shows the new address" "grep -q 'New link: https://gen2.trycloudflare.com' '$T/out6'"

# 7. Restart: App Inventor and the hub, not the tunnel
printf '3\n\n10\n' | bash "$MS" > "$T/out7" 2>&1
check "restart restarts App Inventor and the hub" "grep -q 'restart appinventor collab-hub' '$T/systemctl.log'"
check "restart does not restart the tunnel again" "[ \"\$(grep -c 'restart cloudflared-quick' '$T/systemctl.log')\" = 1 ]"
check "restart reports App Inventor running" "grep -q 'App Inventor is running again' '$T/out7'"

# 8. Access code and override code run their own scripts (stand-ins here)
printf '#!/usr/bin/env bash\necho "set-team-code called"\n' > "$T/base/set-team-code.sh"
chmod +x "$T/base/set-team-code.sh"
printf '4\n\n10\n' | bash "$MS" > "$T/out8" 2>&1
check "change access code runs set-team-code.sh" "grep -q 'set-team-code called' '$T/out8'"
cp "$HERE/set-ai.sh" "$T/base/set-ai.sh"
printf '5\n\n10\n' | bash "$MS" > "$T/out8b" 2>&1
check "change override code runs set-ai.sh --pin" "grep -q 'Full-app PIN' '$T/out8b' || grep -q 'Full-app PIN saved' '$T/out8b' || grep -q 'The PIN must be' '$T/out8b'"

# 9. set-ai.sh --model: rules and results. Only balanced and fast exist, for OpenRouter and OpenCode Go.
cp "$HERE/set-ai.sh" "$T/base/set-ai.sh"
bash "$T/base/set-ai.sh" --model gpt inclusionai/x > /dev/null 2>&1; rc=$?
check "an unknown preset is refused" "[ $rc -eq 1 ]"
bash "$T/base/set-ai.sh" --model smart anthropic/claude-haiku-5.5 > /dev/null 2>&1; rc=$?
check "the smart preset is gone, so it is refused and writes nothing" "[ $rc -eq 1 ] && ! grep -q '^AI_MODEL_SMART=' '$T/base/ai.env'"
before="$(cat "$T/base/ai.env")"
bash "$T/base/set-ai.sh" --model balanced "bad name" > /dev/null 2>&1; rc=$?
check "a model name with a space is refused" "[ $rc -eq 1 ] && [ \"\$(cat '$T/base/ai.env')\" = \"\$before\" ]"
bash "$T/base/set-ai.sh" --model balanced anthropic/claude-haiku-5.5 > /dev/null 2>&1
check "--model sets a preset" "grep -q '^AI_MODEL_BALANCED=anthropic/claude-haiku-5.5$' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model balanced --reset > /dev/null 2>&1
check "--reset removes the preset's override" "! grep -q '^AI_MODEL_BALANCED=' '$T/base/ai.env'"
check "--reset keeps the key" "grep -q '^OPENROUTER_API_KEY=sk-test-123$' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --provider opencode > "$T/out9p" 2>&1; rc=$?
check "--provider is gone: it is refused and writes no AI_PROVIDER" "[ $rc -eq 1 ] && grep -q 'Use: set-ai.sh' '$T/out9p' && ! grep -q '^AI_PROVIDER=' '$T/base/ai.env'"

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
printf '6\n\n10\n' | bash "$MS" > "$T/out13a" 2>&1
check "an up-to-date app says so" "grep -q 'Up to date (test)' '$T/out13a'"
check "an up-to-date app asks nothing" "! grep -q 'Update to' '$T/out13a'"
touch "$T/base/newer"
printf '6\nn\n\n10\n' | bash "$MS" > "$T/out13b" 2>&1
check "a newer version is offered by name" "grep -q 'Update to abc1234 Test change?' '$T/out13b'"
check "declining starts nothing" "grep -q 'Not updated.' '$T/out13b' && [ ! -e '$T/systemd-run.log' ]"
printf '6\ny\n\n10\n' | bash "$MS" > "$T/out13c" 2>&1
check "accepting starts update.sh --now as a unit of its own" "grep -q -- '--unit=collab-update-now' '$T/systemd-run.log' && grep -q 'update.sh --now' '$T/systemd-run.log'"
check "accepting says the update runs in the background" "grep -q 'running in the background' '$T/out13c'"
exec 8>"$T/update.lock"; flock -x 8
printf '6\n\n10\n' | bash "$MS" > "$T/out13d" 2>&1
exec 8>&-
check "an update already running is reported, not started again" "grep -q 'An update is already running' '$T/out13d' && [ \"\$(grep -c -- '--unit=collab-update-now' '$T/systemd-run.log')\" = 1 ]"
touch "$T/base/check-fails"
printf '6\n\n10\n' | bash "$MS" > "$T/out13e" 2>&1
check "a failed check says so" "grep -q 'Could not check' '$T/out13e'"
rm -f "$T/base/newer" "$T/base/check-fails"

# 14. A hub from before the preset table: the models come from the project folder, the status says they take effect once
# the hub is updated, and Change OpenRouter models works from that list. A current hub gets no such note.
mkdir -p "$T/old-hub"
printf 'module.exports = {};\n' > "$T/old-hub/ai.js"
printf '%s\n' "$REPO" > "$T/base/repo"
out14b="$(MIT_HUB="$T/old-hub" bash "$MS" --show 2>&1)"
check "an older hub still shows the models, from the project folder" "printf '%s' \"\$out14b\" | grep -q 'Balanced  Ling 3.1 Flash' && printf '%s' \"\$out14b\" | grep -q 'inclusionai/ling-3.1-flash *(built in)'"
check "an older hub says the models take effect once it is updated" "printf '%s' \"\$out14b\" | grep -q 'is older and does not use these yet'"
out15b="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "a current hub gets no older note" "! printf '%s' \"\$out15b\" | grep -q 'is older'"
printf '1\n\n\n10\n' | MIT_HUB="$T/old-hub" bash "$MS" > "$T/out16" 2>&1
check "Change OpenRouter models works from the project folder's list" "grep -q 'Which OpenRouter model should change' '$T/out16' && grep -q '1. Balanced  Ling 3.1 Flash' '$T/out16'"
rm -f "$T/base/repo"

# 15. A dashboard tunnel keeps its hostname in the dashboard, so the install command writes it to $BASE/cloudflare-hostname
printf 'app.from-file.test\n' > "$T/base/cloudflare-hostname"
touch "$T/cf-active"
out17="$(MIT_CF_CONFIG="$T/none.yml" bash "$MS" --show 2>&1)"
check "a dashboard tunnel's hostname is shown as the permanent link" "printf '%s' \"\$out17\" | grep -q 'Permanent link:     https://app.from-file.test  (Cloudflare)'"
rm -f "$T/cf-active" "$T/base/cloudflare-hostname"

# 16. Change OpenRouter API key (option 7) runs set-ai.sh --key openrouter: it asks for the key, saves it, restarts the hub,
# and changes no other line. A bare set-ai.sh asks for the OpenRouter key too, and sets the daily limit only when there is none.
printf 'AI_DAILY_LIMIT=250\n' >> "$T/base/ai.env"
out16b="$(printf '7\nsk-new-test-key-123\n\n10\n' | MIT_HUB="$REPO/collab/server" bash "$MS" 2>&1)"
check "option 7 saves the OpenRouter key and says so" "printf '%s' \"\$out16b\" | grep -q 'The OpenRouter key is saved'"
check "the new key is saved in ai.env" "grep -q '^OPENROUTER_API_KEY=sk-new-test-key-123$' '$T/base/ai.env'"
check "the key is saved once, and the other settings are kept" "[ \"\$(grep -c '^OPENROUTER_API_KEY=' '$T/base/ai.env')\" = 1 ] && grep -qx 'AI_DAILY_LIMIT=250' '$T/base/ai.env'"
check "the hub restarts after a new key" "grep -q 'restart collab-hub' '$T/systemctl.log'"
printf 'sk-new-test-key-123\n' | bash "$T/base/set-ai.sh" > "$T/out16c" 2>&1
check "a bare set-ai.sh asks for the OpenRouter key and says the helper is on" "grep -q 'The AI helper is on with OpenRouter' '$T/out16c' && grep -qx 'OPENROUTER_API_KEY=sk-new-test-key-123' '$T/base/ai.env' && grep -qx 'AI_DAILY_LIMIT=250' '$T/base/ai.env'"

# 17. A preset whose model is changed in ai.env shows the name of that model
printf 'AI_MODEL_BALANCED=anthropic/claude-haiku-5.5\n' >> "$T/base/ai.env"
out17b="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "a changed model shows its own name in the status" "printf '%s' \"\$out17b\" | grep -q 'Balanced  Claude Haiku 5.5'"
check "the old name is gone from the changed preset" "! printf '%s' \"\$out17b\" | grep -q 'Balanced  Ling 3.1 Flash'"

# 18. --key opencode saves the OpenCode Go key and changes nothing else. Its models wait for /beta in the companion.
printf 'sk-opencode-test-456\n' | bash "$T/base/set-ai.sh" --key opencode > "$T/out18" 2>&1
check "--key opencode saves the OpenCode Go key under its own name" "grep -qx 'OPENCODE_API_KEY=sk-opencode-test-456' '$T/base/ai.env'"
check "--key opencode keeps the OpenRouter key and the other settings" "grep -qx 'OPENROUTER_API_KEY=sk-new-test-key-123' '$T/base/ai.env' && grep -qx 'AI_MODEL_BALANCED=anthropic/claude-haiku-5.5' '$T/base/ai.env' && grep -qx 'AI_DAILY_LIMIT=250' '$T/base/ai.env'"
check "--key opencode says the key is saved, and that the models wait for /beta" "grep -q 'The OpenCode Go key is saved' '$T/out18' && grep -q 'only after someone types /beta' '$T/out18'"
check "no AI_PROVIDER line is ever written" "! grep -q '^AI_PROVIDER=' '$T/base/ai.env'"
out18b="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "the status shows both keys set" "printf '%s' \"\$out18b\" | grep -q 'AI keys:            OpenRouter set, OpenCode Go set'"
check "the status shows the OpenCode Go balanced model" "printf '%s' \"\$out18b\" | grep -q 'Balanced  Step 5 Preview'"
check "the status shows the OpenRouter balanced model override" "printf '%s' \"\$out18b\" | grep -q 'Balanced  Claude Haiku 5.5'"

# 19. MITSTATUS options 7 to 9: OpenRouter's key and models (1 and 7), OpenCode Go's key and models (8 and 9). Each one
# changes only its own service's settings.
out19="$(printf '9\nsk-opencode-new-789\n\n10\n' | bash "$MS" 2>&1)"
check "option 9 asks for the OpenCode Go key and says it is saved" "printf '%s' \"\$out19\" | grep -q 'OpenCode Go key is saved'"
check "option 9 saves the new OpenCode Go key, once" "grep -qx 'OPENCODE_API_KEY=sk-opencode-new-789' '$T/base/ai.env' && [ \"\$(grep -c '^OPENCODE_API_KEY=' '$T/base/ai.env')\" = 1 ]"
check "option 9 keeps the OpenRouter key" "grep -qx 'OPENROUTER_API_KEY=sk-new-test-key-123' '$T/base/ai.env'"
check "option 9 says the OpenCode Go models wait for /beta" "printf '%s' \"\$out19\" | grep -q 'only after someone types /beta'"

out19b="$(printf '8\n1\nkimi-k2.6\n\n10\n' | bash "$MS" 2>&1)"
check "option 8 lists the OpenCode Go models" "printf '%s' \"\$out19b\" | grep -q 'Which OpenCode Go model should change' && printf '%s' \"\$out19b\" | grep -q '1. Balanced  Step 5 Preview'"
check "option 8 sets the OpenCode Go model of the balanced preset" "grep -qx 'AI_OPENCODE_MODEL_BALANCED=kimi-k2.6' '$T/base/ai.env'"
check "option 8 leaves the OpenRouter model of that preset alone" "grep -qx 'AI_MODEL_BALANCED=anthropic/claude-haiku-5.5' '$T/base/ai.env'"
printf '8\n1\ndefault\n\n10\n' | bash "$MS" > "$T/out19c" 2>&1
check "option 8 with default puts the built-in OpenCode Go model back" "! grep -q '^AI_OPENCODE_MODEL_BALANCED=' '$T/base/ai.env'"

printf '1\n2\nmistralai/mistral-small-test\n\n10\n' | bash "$MS" > "$T/out19d" 2>&1
check "option 1 changes the OpenRouter fast model" "grep -qx 'AI_MODEL_FAST=mistralai/mistral-small-test' '$T/base/ai.env'"
check "option 1 says which service its list is for" "grep -q 'Which OpenRouter model should change' '$T/out19d'"

# The 'default' hint names the built-in model of the preset, not the one ai.env sets. Balanced is set to a known model here
# (Claude Haiku 5.5) and Fast to one the helper does not know (mistralai/mistral-small-test).
printf '1\n1\n\n\n10\n' | bash "$MS" > "$T/out19f" 2>&1
check "the default hint names the built-in Balanced model, not the one ai.env sets" "grep -q 'built-in model again (Ling 3.1 Flash). Enter alone cancels.' '$T/out19f' && ! grep -q 'again (Claude Haiku 5.5)' '$T/out19f'"
printf '1\n2\n\n\n10\n' | bash "$MS" > "$T/out19f2" 2>&1
check "the default hint names the built-in Fast model for an unknown override too" "grep -q 'built-in model again (Ling 3 Flash). Enter alone cancels.' '$T/out19f2' && ! grep -q 'again (mistralai' '$T/out19f2'"

out19e="$(printf '10\n' | bash "$MS" 2>&1)"
check "the menu names the OpenRouter options 1 and 7" "printf '%s' \"\$out19e\" | grep -q '1. Change OpenRouter models' && printf '%s' \"\$out19e\" | grep -q '7. Change OpenRouter API key'"
check "the menu offers the OpenCode Go model and key options" "printf '%s' \"\$out19e\" | grep -q '8. Change OpenCode Go models' && printf '%s' \"\$out19e\" | grep -q '9. Change OpenCode Go API key'"
check "the status shows whether each key is set, never the keys" "printf '%s' \"\$out19e\" | grep -q 'AI keys:            OpenRouter set, OpenCode Go set' && ! printf '%s' \"\$out19e\" | grep -q 'sk-'"

# A stale AI_PROVIDER line (from before this change) selects nothing: no service line, and the menu is the same.
printf 'AI_PROVIDER=opencode\n' >> "$T/base/ai.env"
out19s2="$(printf '10\n' | bash "$MS" 2>&1)"
check "a stale AI_PROVIDER line is not read: no service line, and OpenRouter stays the first option" "! printf '%s' \"\$out19s2\" | grep -q 'AI provider' && printf '%s' \"\$out19s2\" | grep -q '1. Change OpenRouter models'"
sed -i '/^AI_PROVIDER=/d' "$T/base/ai.env"

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
bash "$T/base/set-ai.sh" --bogus > /dev/null 2>&1; rc=$?
check "an unknown argument is refused" "[ $rc -eq 1 ]"
bash "$T/base/set-ai.sh" --model fast kimi-k2.6 --service opencode > /dev/null 2>&1
check "--service opencode sets that service's model and leaves OpenRouter's" "grep -qx 'AI_OPENCODE_MODEL_FAST=kimi-k2.6' '$T/base/ai.env' && grep -qx 'AI_MODEL_FAST=mistralai/mistral-small-test' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model fast --service opencode --reset > /dev/null 2>&1
check "--service with --reset puts that service's model back" "! grep -q '^AI_OPENCODE_MODEL_FAST=' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --model fast --reset > /dev/null 2>&1
check "--model fast --reset puts the OpenRouter fast model back" "! grep -q '^AI_MODEL_FAST=' '$T/base/ai.env'"
bash "$T/base/set-ai.sh" --status > "$T/out19t" 2>&1
check "--status shows each key as set or not set, never a key" "grep -q 'Keys: OpenRouter key set, OpenCode Go key set' '$T/out19t' && ! grep -q 'sk-' '$T/out19t'"
check "--status shows the overrides of balanced and fast, and no provider" "grep -q 'Model overrides: AI_MODEL_BALANCED=anthropic/claude-haiku-5.5' '$T/out19t' && ! grep -q 'Provider' '$T/out19t'"
check "--status says the AI helper is on" "grep -q 'AI helper: on' '$T/out19t'"

# The OpenCode Go list with no hub list anywhere, and from the project folder when the hub is older
out19j="$(printf '8\n\n10\n' | MIT_HUB="$T/no-hub" bash "$MS" 2>&1)"
check "option 8 says so when there is no OpenCode Go list anywhere" "printf '%s' \"\$out19j\" | grep -q 'have no OpenCode Go model list'"
printf '%s\n' "$REPO" > "$T/base/repo"
printf '8\n\n\n10\n' | MIT_HUB="$T/old-hub" bash "$MS" > "$T/out19k" 2>&1
check "an older hub gets the OpenCode Go list from the project folder" "grep -q 'Which OpenCode Go model should change' '$T/out19k'"

# With OpenCode Go's balanced model changed in MITSTATUS, its own name shows
printf '8\n1\nglm-5.3\n\n10\n' | MIT_HUB="$REPO/collab/server" bash "$MS" > "$T/out19g" 2>&1
out19h="$(MIT_HUB="$REPO/collab/server" bash "$MS" --show 2>&1)"
check "option 8 changes the OpenCode Go model, and the status shows its name" "grep -qx 'AI_OPENCODE_MODEL_BALANCED=glm-5.3' '$T/base/ai.env' && printf '%s' \"\$out19h\" | grep -q 'Balanced  GLM 5.3'"
rm -f "$T/base/repo"

# 10. The changed scripts parse, and neither script knows the removed parts (the provider setting, the smart preset)
for f in "$HERE/mitstatus.sh" "$HERE/set-ai.sh" "$HERE/stable-link.sh" "$HERE/build-on-pi.sh" "$HERE/install.sh"; do
  check "syntax: $(basename "$f")" "bash -n '$f'"
done
check "neither script reads or writes AI_PROVIDER" "! grep -q 'AI_PROVIDER' '$HERE/set-ai.sh' '$HERE/mitstatus.sh'"
check "neither script knows the smart preset" "! grep -qi 'smart' '$HERE/set-ai.sh' '$HERE/mitstatus.sh'"

echo
if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "$fails check(s) failed."; exit 1; fi
