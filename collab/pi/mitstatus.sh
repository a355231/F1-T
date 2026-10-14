#!/usr/bin/env bash
# MITSTATUS: shows the link, the access code, the override code, the AI models and the update of App Inventor Team
# Edition, and gives the options that change them (including going back to the version before the last update). The
# install puts it in /usr/local/bin, so it is run as just MITSTATUS.
#   MITSTATUS          shows the status and the menu
#   MITSTATUS --show   shows the status only
# MIT_BASE, MIT_HUB and AI_LOCK point it at other folders and files, for tests.
set -uo pipefail

BASE="${MIT_BASE:-/opt/appinventor}"
HUB="${MIT_HUB:-$BASE/hub}"
LOCK="${AI_LOCK:-/run/collab-update.lock}"
NOTICE="$BASE/update-failed"

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

# The value of one setting in ai.env, or nothing (the last one wins, as systemd does).
setting() {
  [ -r "$BASE/ai.env" ] || return 0
  { grep "^$1=" "$BASE/ai.env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-
}

# The service in use, as the hub reads AI_PROVIDER: openrouter (the default) or opencode (OpenCode Go).
in_use_service() {
  [ "$(setting AI_PROVIDER)" = opencode ] && echo opencode || echo openrouter
}

# The name of a service as the person sees it, and whether its key is set (the key itself is never shown).
service_label() { [ "$1" = opencode ] && echo "OpenCode Go" || echo "OpenRouter"; }
key_state() { [ -n "$(setting "$1")" ] && echo set || echo "not set"; }

# The three presets of one service ($2: openrouter or opencode) as the hub folder given ($1) has them, with the overrides
# from ai.env applied the way the hub applies them. One line per preset: id, label, name, model, and where the model comes
# from. Nothing is printed when that folder has no preset table for the service (a hub from before it).
presets() {
  AI_MODEL_SMART="$(setting AI_MODEL_SMART)" AI_MODEL_BALANCED="$(setting AI_MODEL_BALANCED)" \
  AI_MODEL_FAST="$(setting AI_MODEL_FAST)" AI_PROVIDER="$(setting AI_PROVIDER)" \
  AI_OPENCODE_MODEL_SMART="$(setting AI_OPENCODE_MODEL_SMART)" AI_OPENCODE_MODEL_BALANCED="$(setting AI_OPENCODE_MODEL_BALANCED)" \
  AI_OPENCODE_MODEL_FAST="$(setting AI_OPENCODE_MODEL_FAST)" node -e '
    const {PROVIDERS, nameOf} = require(process.argv[1]);
    const service = PROVIDERS[process.argv[2]];
    for (const id of ["smart", "balanced", "fast"]) {
      const p = service.presets[id], over = process.env[p.env];
      console.log([id, p.label, nameOf(id, service), over || p.model, over ? "set in ai.env" : "built in"].join("\t"));
    }' "$1/ai.js" "$2" 2>/dev/null
}

# The model list of one service. The hub that runs is read first. A Pi whose hub was installed before the preset table has
# none, so the copy in the project folder ($BASE/repo) is read instead. show_status says so, because those models take
# effect only once the hub is updated.
model_rows() {
  local service=$1 rows repo
  rows="$(presets "$HUB" "$service")"
  if [ -z "$rows" ]; then
    repo="$(cat "$BASE/repo" 2>/dev/null || true)"
    [ -n "$repo" ] && rows="$(presets "$repo/collab/server" "$service")"
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

# The update, which update.sh keeps in files of its own: update-state (how long the last build took, when the last change
# was, and the version taken back by hand), update-progress (what a running update is doing) and update-failed (the notice
# of a failure). A running update holds the lock, which is how update_running tells that one is going.
update_value() { sed -n "s/^$1=//p" "$BASE/update-state" 2>/dev/null | tail -n 1; }
progress_value() { sed -n "s/^$1=//p" "$BASE/update-progress" 2>/dev/null | tail -n 1; }
update_running() { [ -e "$LOCK" ] && ! flock -n "$LOCK" true; }

# Minutes, rounded up, and the time so far in words. Until a build has finished on this Pi, it is estimated at 45 minutes:
# the middle of the 30 to 60 minutes that build-on-pi.sh gives.
minutes_of() { echo $(( ($1 + 59) / 60 )); }
so_far() { if [ "$1" -lt 60 ]; then echo "under a minute"; else echo "$(( $1 / 60 )) min"; fi; }
build_minutes() {
  local s
  s="$(update_value build_seconds)"
  if [ -n "$s" ]; then minutes_of "$s"; else echo 45; fi
}
build_basis() {
  local s
  s="$(update_value build_seconds)"
  if [ -n "$s" ]; then echo "the last build here took $(minutes_of "$s") min"; else echo "a first build takes 30 to 60 min"; fi
}

# One row of the status block: a label and its text. A row with no label continues the one above.
update_row() { printf '  %-20s%s\n' "$1" "$2"; }

# What the nightly update does, by its mode (update-mode).
next_step() {
  case "$1" in
    notify) echo "The nightly update only reports it; option 6 installs it." ;;
    off) echo "Nightly updates are off; option 6 installs it." ;;
    *) echo "The nightly update installs it at 3 AM, or option 6 installs it now." ;;
  esac
}

# There is an earlier version to go back to: one saved before the last update, and not the version running now.
can_revert() {
  local back now
  [ -s "$BASE/rollback/commit" ] || return 1
  back="$(cat "$BASE/rollback/version" 2>/dev/null || true)"
  now="$(cat "$BASE/version" 2>/dev/null || true)"
  [ -n "$back" ] && [ "$back" != "$now" ]
}

# The update, in the status block: what it is doing and how long it has left, or how the last one went; and the version
# that option 10 goes back to.
update_lines() {
  local mode stage version started elapsed left avail changed back
  mode="$(cat "$BASE/update-mode" 2>/dev/null || echo install)"
  update_row "Nightly updates:" "$mode"
  if update_running; then
    stage="$(progress_value stage)"
    version="$(progress_value version)"
    started="$(progress_value stage_started)"
    elapsed=$(( $(date +%s) - ${started:-$(date +%s)} ))
    case "$stage" in
      compile)
        left=$(( $(build_minutes) * 60 - elapsed ))
        if [ "$left" -gt 0 ]; then
          update_row "Update:" "building $version now, $(so_far "$elapsed") in. About $(minutes_of "$left") min left."
          update_row "" "Estimate: $(build_minutes) min, because $(build_basis)."
        else
          update_row "Update:" "building $version now, $(so_far "$elapsed") in: longer than the $(build_minutes) min estimate."
        fi ;;
      start)
        left=$(( 600 - elapsed ))
        if [ "$left" -gt 0 ]; then
          update_row "Update:" "starting $version. About $(minutes_of "$left") min left for it to answer."
        else
          update_row "Update:" "starting $version. It is taking longer than the 10 min it has to answer."
        fi ;;
      restoring) update_row "Update:" "the new version failed, so the previous one is being put back." ;;
      preparing) update_row "Update:" "getting $version ready (the running version is saved first)." ;;
      *) update_row "Update:" "an update is running." ;;
    esac
    update_row "" "Follow it with: tail -f $BASE/update.log"
    return 0
  fi
  if [ -s "$NOTICE" ]; then
    update_row "Update:" "FAILED. $(cat "$NOTICE")"
  fi
  avail="$(head -n 1 "$BASE/update-available" 2>/dev/null || true)"
  if [ -n "$avail" ] && [ -n "$(update_value held_short)" ] && [ "${avail%% *}" = "$(update_value held_short)" ]; then
    update_row "Update:" "$(update_value held_short) was taken back by hand, so the nightly update leaves it alone. Option 6 installs it."
  elif [ -n "$avail" ]; then
    update_row "Update:" "newer version available: $avail. $(next_step "$mode")"
  elif [ ! -s "$NOTICE" ]; then
    changed="$(update_value changed_at)"
    update_row "Update:" "up to date ($(cat "$BASE/version" 2>/dev/null || echo unknown))${changed:+, changed $changed}"
  fi
  if can_revert; then
    back="$(cat "$BASE/rollback/version" 2>/dev/null || echo unknown)"
    update_row "Previous version:" "$back (option 10 goes back to it)"
  fi
}

show_status() {
  local code pin rows id label name model source service
  code="$(cat "$BASE/teamcode" 2>/dev/null || true)"
  code="${code//[$'\r\n']/}"
  if [ -s "$BASE/overridepin" ]; then pin="$(head -n 1 "$BASE/overridepin")"; else pin="$(setting AI_OVERRIDE_PIN)"; fi
  service="$(in_use_service)"
  echo
  echo "  App Inventor Team Edition"
  echo "  -------------------------"
  update_lines
  echo
  link_lines
  echo "  Access code:        ${code:-not set}"
  # Only whether it is set: the code itself is never printed (CLAUDE.md).
  echo "  Override code:      $([ -n "$pin" ] && echo set || echo "not set")"
  case "$service" in
    opencode) echo "  AI provider:        OpenCode Go (in the companion its models need /beta; OpenRouter is used until then)" ;;
    *) echo "  AI provider:        OpenRouter" ;;
  esac
  echo "  AI keys:            OpenRouter $(key_state OPENROUTER_API_KEY), OpenCode Go $(key_state OPENCODE_API_KEY)"
  rows="$(model_rows "$service")"
  if [ -z "$rows" ]; then
    echo "  AI models:          not found (the hub and the project folder have no $(service_label "$service") model list)"
  else
    echo "  AI models ($(service_label "$service")):"
    while IFS=$'\t' read -r id label name model source; do
      printf '    %-9s %-18s %-38s (%s)\n' "$label" "$name" "$model" "$source"
    done <<< "$rows"
    if [ -z "$(presets "$HUB" "$service")" ]; then
      echo "    The hub that is running is older and does not use these yet. They take effect when it is updated."
    fi
  fi
  echo
}

pause() {
  read -r -p "  Press Enter to go back to the menu. " _ || true
}

# One line of the menu. The numbers are right-aligned, so 10 lines up with the others.
option() {
  printf '%3s. %s\n' "$1" "$2"
}

# 1 and 8. The model of one preset of one service: the service in use (1), or OpenCode Go (8), whichever is in use. $1 is
# the service. 'default' puts the built-in model back. set-ai.sh writes it to ai.env and restarts the hub.
change_models() {
  local service=$1 rows choice id label name model model_name hint
  rows="$(model_rows "$service")"
  if [ -z "$rows" ]; then
    echo "  The hub and the project folder have no $(service_label "$service") model list, so there is nothing to choose from."
    echo "  Run the update first: sudo $BASE/update.sh --now"
    return
  fi
  echo
  echo "  Which $(service_label "$service") model should change?"
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
  if [ "$service" = opencode ]; then
    hint="Type the model name as OpenCode Go lists it (for example deepseek-v4.1-flash),"
  else
    hint="Type a model name from https://openrouter.ai/models (for example anthropic/claude-haiku-5.5),"
  fi
  echo "  $hint"
  echo "  or 'default' to use the built-in model again ($model_name). Enter alone cancels."
  read -r -p "  Model: " model || return
  [ -n "$model" ] || return
  if [ "$model" = default ]; then
    "$BASE/set-ai.sh" --model "$id" --service "$service" --reset
  else
    "$BASE/set-ai.sh" --model "$id" --service "$service" "$model"
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
  echo "  The update is running in the background. Building the new version is estimated to take about $(build_minutes) min."
  echo "  The status shows the time left. Follow it with: tail -f $BASE/update.log"
  tail -n 3 "$BASE/update.log" 2>/dev/null | sed 's/^/    /'
}

# 10. Goes back to the version from before the last update. update.sh --rollback runs as a unit of its own, like the update
# (option 6). The version it takes back is held: the nightly update leaves it alone until a newer version is published.
revert_app() {
  local answer back now
  if update_running; then
    echo "  An update is running. Go back once it has finished."
    return
  fi
  if ! can_revert; then
    echo "  There is no earlier version saved to go back to. An update has to finish first."
    return
  fi
  back="$(cat "$BASE/rollback/version" 2>/dev/null || echo unknown)"
  now="$(cat "$BASE/version" 2>/dev/null || echo unknown)"
  echo
  echo "  Go back from $now to $back, the version before the last update?"
  echo "  App Inventor restarts, which disconnects anyone using it. Projects, backups, the team code and settings are kept."
  echo "  The nightly update will not install $now again. Option 6 does, when you choose it."
  read -r -p "  Go back now? (y/N): " answer || return
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "  Not changed."; return ;;
  esac
  if ! systemd-run --unit=collab-revert-now --collect --property=Nice=10 "$BASE/update.sh" --rollback > /dev/null; then
    echo "  Could not start the revert. Look at it with: systemctl status collab-revert-now"
    return
  fi
  sleep 3
  echo "  Going back in the background. It takes a few minutes. Follow it with: tail -f $BASE/update.log"
  tail -n 3 "$BASE/update.log" 2>/dev/null | sed 's/^/    /'
}

main_menu() {
  local choice service
  while true; do
    show_status
    service="$(in_use_service)"
    option 1 "Change AI models ($(service_label "$service"))"
    option 2 "New link"
    option 3 "Restart"
    option 4 "Change access code"
    option 5 "Change override code"
    option 6 "Update"
    option 7 "Change API key ($(service_label "$service"))"
    option 8 "Change OpenCode Go models"
    option 9 "Change OpenCode Go API key"
    option 10 "Go back to the previous version"
    option 11 "Exit"
    echo
    if ! read -r -p "  Choose 1-11: " choice; then
      echo
      exit 0
    fi
    case "$choice" in
      1) change_models "$service"; pause ;;
      2) new_link; pause ;;
      3) restart_app; pause ;;
      4) "$BASE/set-team-code.sh"; pause ;;
      5) "$BASE/set-ai.sh" --pin; pause ;;
      6) update_app; pause ;;
      7) "$BASE/set-ai.sh"; pause ;;
      8) change_models opencode; pause ;;
      9) "$BASE/set-ai.sh" --key opencode; pause ;;
      10) revert_app; pause ;;
      11|q|Q) exit 0 ;;
      *) echo "  Type a number from 1 to 11." ;;
    esac
  done
}

case "${1:-}" in
  --show) show_status ;;
  "") main_menu ;;
  *) echo "Usage: MITSTATUS [--show]" >&2; exit 1 ;;
esac
