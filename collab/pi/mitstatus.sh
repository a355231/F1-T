#!/usr/bin/env bash
# MITSTATUS: shows the link, the access code, the override code and the AI models of App Inventor Team Edition, and
# gives the options that change them. The install puts it in /usr/local/bin, so it is run as just MITSTATUS.
#   MITSTATUS          shows the status and the menu
#   MITSTATUS --show   shows the status only
# MIT_BASE, MIT_HUB and AI_LOCK point it at other folders and files, for tests.
set -uo pipefail

BASE="${MIT_BASE:-/opt/appinventor}"
HUB="${MIT_HUB:-$BASE/hub}"
LOCK="${AI_LOCK:-/run/collab-update.lock}"

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

# The value of one setting in ai.env, or nothing (the last one wins, as systemd does).
setting() {
  [ -r "$BASE/ai.env" ] || return 0
  { grep "^$1=" "$BASE/ai.env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-
}

# The three presets as the hub folder given ($1) has them, with the overrides from ai.env applied the way the hub applies
# them. One line per preset: id, label, name, model, and where the model comes from. Nothing is printed when that folder
# has no preset table (a hub from before it).
presets() {
  AI_MODEL_SMART="$(setting AI_MODEL_SMART)" AI_MODEL_BALANCED="$(setting AI_MODEL_BALANCED)" \
  AI_MODEL_FAST="$(setting AI_MODEL_FAST)" node -e '
    const {PRESETS} = require(process.argv[1]);
    for (const id of ["smart", "balanced", "fast"]) {
      const p = PRESETS[id], over = process.env[p.env];
      console.log([id, p.label, p.name, over || p.model, over ? "set in ai.env" : "built in"].join("\t"));
    }' "$1/ai.js" 2>/dev/null
}

# The model list. The hub that runs is read first. A Pi whose hub was installed before the preset table has none, so the
# copy in the project folder ($BASE/repo) is read instead. show_status says so, because those models take effect only
# once the hub is updated.
model_rows() {
  local rows repo
  rows="$(presets "$HUB")"
  if [ -z "$rows" ]; then
    repo="$(cat "$BASE/repo" 2>/dev/null || true)"
    [ -n "$repo" ] && rows="$(presets "$repo/collab/server")"
  fi
  echo "$rows"
}

# The Cloudflare tunnel's address. A tunnel made in the Cloudflare dashboard keeps its hostname there, so the command that
# installs it writes the hostname to $BASE/cloudflare-hostname. Otherwise it is the first hostname in the tunnel's config
# file (the App Inventor user's, or the one cloudflared keeps in /etc/cloudflared), or nothing. MIT_CF_CONFIG names another
# config file, for tests.
cloudflare_hostname() {
  local cfg="${MIT_CF_CONFIG:-}" owner
  if [ -s "$BASE/cloudflare-hostname" ]; then
    head -n 1 "$BASE/cloudflare-hostname" | tr -d '[:space:]'
    return 0
  fi
  if [ -z "$cfg" ]; then
    owner="$(stat -c %U "$BASE" 2>/dev/null || true)"
    for cfg in "/home/$owner/.cloudflared/config.yml" /etc/cloudflared/config.yml; do
      [ -r "$cfg" ] && break
    done
  fi
  [ -r "$cfg" ] || return 0
  grep -E -m 1 '^[[:space:]]*-?[[:space:]]*hostname:' "$cfg" 2>/dev/null |
    sed -E "s/.*hostname:[[:space:]]*//; s/[[:space:]\"']//g"
}

# The project's folder, as the installer wrote it down; used in the hint that points at the README.
repo_dir() {
  cat "$BASE/repo" 2>/dev/null || echo "~/F1-T"
}

# The links. A permanent address is a Tailscale Funnel link (stable-link.sh writes it to $BASE/stable-link when it turns
# Funnel on) or a configured Cloudflare named tunnel. When there is one, it is shown in place of the temporary Cloudflare
# quick link. When there is none, the status says to try Cloudflare, and shows the temporary link.
link_lines() {
  local stable cf url ip
  stable="$(cat "$BASE/stable-link" 2>/dev/null || true)"
  cf="$(cloudflare_hostname)"
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$cf" ] || [ -n "$stable" ]; then
    if [ -n "$cf" ]; then
      if systemctl is-active --quiet cloudflared 2>/dev/null; then
        echo "  Permanent link:     https://$cf  (Cloudflare)"
      else
        echo "  Permanent link:     https://$cf  (Cloudflare, but its tunnel is not running: systemctl status cloudflared)"
      fi
    fi
    [ -n "$stable" ] && echo "  Permanent link:     $stable  (Tailscale)"
  else
    url="$("$BASE/tunnel-url.sh" 2>/dev/null || true)"
    echo "  Permanent link:     none yet. Try Cloudflare for one (it needs a domain on Cloudflare):"
    echo "                      see \"Permanent address\" in $(repo_dir)/collab/README.md"
    echo "  Temporary link:     ${url:-not ready yet: wait a minute, then choose 2 (New link)}"
  fi
  echo "  Link (home Wi-Fi):  http://${ip:-<pi-address>}:8080"
}

show_status() {
  local code pin rows id label name model source
  code="$(cat "$BASE/teamcode" 2>/dev/null || true)"
  code="${code//[$'\r\n']/}"
  if [ -s "$BASE/overridepin" ]; then pin="$(head -n 1 "$BASE/overridepin")"; else pin="$(setting AI_OVERRIDE_PIN)"; fi
  echo
  echo "  App Inventor Team Edition"
  echo "  -------------------------"
  link_lines
  echo "  Access code:        ${code:-not set}"
  echo "  Override code:      ${pin:-not set}"
  rows="$(model_rows)"
  if [ -z "$rows" ]; then
    echo "  AI models:          not found (the hub and the project folder have no model list)"
  else
    echo "  AI models:"
    while IFS=$'\t' read -r id label name model source; do
      printf '    %-9s %-18s %-38s (%s)\n' "$label" "$name" "$model" "$source"
    done <<< "$rows"
    if [ -z "$(presets "$HUB")" ]; then
      echo "    The hub that is running is older and does not use these yet. They take effect when it is updated."
    fi
  fi
  echo
}

pause() {
  read -r -p "  Press Enter to go back to the menu. " _ || true
}

# 1. The model of one preset: a model name from OpenRouter, or 'default' to put the built-in one back.
change_models() {
  local rows choice id label name model model_name
  rows="$(model_rows)"
  if [ -z "$rows" ]; then
    echo "  Neither the hub nor the project folder has a model list, so there is nothing to choose from."
    echo "  Run the update first: sudo $BASE/update.sh --now"
    return
  fi
  echo
  echo "  Which model should change?"
  local n=0
  while IFS=$'\t' read -r id label name model source; do
    n=$((n + 1))
    printf '    %s. %-9s %s\n' "$n" "$label" "$name"
  done <<< "$rows"
  echo "    (Enter goes back)"
  read -r -p "  Choose 1-3: " choice || return
  case "$choice" in
    1) id=smart ;;
    2) id=balanced ;;
    3) id=fast ;;
    *) return ;;
  esac
  model_name="$(awk -F'\t' -v id="$id" '$1 == id {print $3}' <<< "$rows")"
  echo "  Type a model name from https://openrouter.ai/models (for example anthropic/claude-haiku-5.5),"
  echo "  or 'default' to use the built-in model again ($model_name). Enter alone cancels."
  read -r -p "  Model: " model || return
  [ -n "$model" ] || return
  if [ "$model" = default ]; then
    "$BASE/set-ai.sh" --model "$id" --reset
  else
    "$BASE/set-ai.sh" --model "$id" "$model"
  fi
}

# 2. A new Cloudflare quick link: the tunnel restarts, and the old address stops working.
new_link() {
  local old new waited=0
  old="$("$BASE/tunnel-url.sh" 2>/dev/null || true)"
  echo "  Asking Cloudflare for a new address. The current one stops working."
  if ! systemctl restart cloudflared-quick; then
    echo "  The tunnel did not restart. Look at it with: systemctl status cloudflared-quick"
    return
  fi
  while [ "$waited" -lt 90 ]; do
    sleep 3
    waited=$((waited + 3))
    new="$("$BASE/tunnel-url.sh" 2>/dev/null || true)"
    if [ -n "$new" ] && [ "$new" != "$old" ]; then
      echo "  New link: $new"
      return
    fi
  done
  echo "  No new address yet. Check again in a minute with MITSTATUS, or: systemctl status cloudflared-quick"
}

# 3. App Inventor and the team hub. The link stays the same.
restart_app() {
  local waited=0 code
  echo "  Restarting App Inventor and the team hub. The link does not change."
  if ! systemctl restart appinventor collab-hub; then
    echo "  The restart did not work. Look at it with: systemctl status appinventor collab-hub"
    return
  fi
  while [ "$waited" -lt 240 ]; do
    sleep 5
    waited=$((waited + 5))
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8888/ 2>/dev/null || true)"
    if [[ "$code" =~ ^(200|302|303|307)$ ]]; then
      echo "  App Inventor is running again."
      return
    fi
  done
  echo "  App Inventor is still starting, which can take a couple of minutes. Check with MITSTATUS."
}

# 6. The app update. It asks GitHub whether there is a newer version (update.sh --check). If there is, and the person says
# yes, update.sh --now runs as a unit of its own, so closing this window does not stop it. The new version is built while
# the current one keeps running; App Inventor restarts only once it is ready.
update_app() {
  local answer n
  if ! flock -n "$LOCK" true; then
    echo "  An update is already running. Its latest lines:"
    tail -n 3 "$BASE/update.log" 2>/dev/null | sed 's/^/    /'
    echo "  Follow it with: tail -f $BASE/update.log"
    return
  fi
  echo "  Asking GitHub whether there is a newer version..."
  if ! "$BASE/update.sh" --check | sed 's/^/  /'; then
    echo "  Could not check. Look at the log with: tail -n 20 $BASE/update.log"
    return
  fi
  [ -s "$BASE/update-available" ] || return
  n="$(curl -fsS -m 5 http://127.0.0.1:8080/collab/status 2>/dev/null |
    python3 -c 'import sys, json; print(len(json.load(sys.stdin)["online"]))' 2>/dev/null)" || n=0
  echo
  echo "  Update to $(cat "$BASE/update-available")?"
  echo "  The new version is built first, while the current one keeps running. Then App Inventor restarts, which"
  echo "  disconnects anyone using it. Projects, backups, the team code and settings are kept."
  if [ "${n:-0}" -gt 0 ]; then echo "  $n people are online right now."; fi
  read -r -p "  Update now? (y/N): " answer || return
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "  Not updated."; return ;;
  esac
  if ! systemd-run --unit=collab-update-now --collect --property=Nice=10 "$BASE/update.sh" --now > /dev/null; then
    echo "  Could not start the update. Look at it with: systemctl status collab-update-now"
    return
  fi
  sleep 3
  echo "  The update is running in the background. Building the new version can take about an hour on the Pi."
  echo "  Follow it with: tail -f $BASE/update.log"
  tail -n 3 "$BASE/update.log" 2>/dev/null | sed 's/^/    /'
}

main_menu() {
  local choice
  while true; do
    show_status
    echo "  1. Change AI models"
    echo "  2. New link"
    echo "  3. Restart"
    echo "  4. Change access code"
    echo "  5. Change override code"
    echo "  6. Update"
    echo "  7. Exit"
    echo
    if ! read -r -p "  Choose 1-7: " choice; then
      echo
      exit 0
    fi
    case "$choice" in
      1) change_models; pause ;;
      2) new_link; pause ;;
      3) restart_app; pause ;;
      4) "$BASE/set-team-code.sh"; pause ;;
      5) "$BASE/set-ai.sh" --pin; pause ;;
      6) update_app; pause ;;
      7|q|Q) exit 0 ;;
      *) echo "  Type a number from 1 to 7." ;;
    esac
  done
}

case "${1:-}" in
  --show) show_status ;;
  "") main_menu ;;
  *) echo "Usage: MITSTATUS [--show]" >&2; exit 1 ;;
esac
