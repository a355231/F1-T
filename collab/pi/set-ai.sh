#!/usr/bin/env bash
# Sets up (or turns off) the AI helper that opens with Ctrl+I+M in App Inventor.
#
#   sudo /opt/appinventor/set-ai.sh            # asks for the OpenRouter key, the only thing it asks for
#   sudo /opt/appinventor/set-ai.sh --pin      # asks for the PIN that turns on full-app mode (the Team panel
#                                              # can change it too: Change override PIN)
#   sudo /opt/appinventor/set-ai.sh --search   # asks for the Brave Search key (optional web search)
#   sudo /opt/appinventor/set-ai.sh --model smart anthropic/claude-haiku-5.5   # the model of one preset
#   sudo /opt/appinventor/set-ai.sh --model smart --reset                      # back to the built-in model
#   sudo /opt/appinventor/set-ai.sh --status   # shows what is set
#   sudo /opt/appinventor/set-ai.sh --off      # turns the helper off, and removes the key, the PIN and the search key
#
# The key and the search key are stored only in /opt/appinventor/ai.env (readable by root only) and read by the
# collaboration hub when it starts. The models are not asked for. --model sets the model of one preset (smart,
# balanced or fast); AI_MODEL_SMART, AI_MODEL_BALANCED and AI_MODEL_FAST in that file do the same by hand (model names
# are OpenRouter's, see https://openrouter.ai/models). This script keeps every line of ai.env that it does not manage, so those lines
# survive a new key. The full-app PIN is kept in /opt/appinventor/overridepin instead, which the hub reads again
# whenever it changes, so the Team panel can change it too. The keys and the PIN are never in the source code, never
# sent to a browser, and never printed. Get an OpenRouter key at https://openrouter.ai/keys. Web search uses a Brave
# Search API key (https://brave.com/search/api/; the free plan is enough for a team).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
BASE="${AI_BASE:-/opt/appinventor}"
FILE="$BASE/ai.env"
PIN_FILE="$BASE/overridepin"

# The value of one setting in ai.env, or nothing. A name that is there twice gives its last value, as systemd does.
get_setting() {
  [ -f "$FILE" ] || return 0
  { grep "^$1=" "$FILE" || true; } | tail -n 1 | cut -d= -f2-
}

# Rewrites ai.env without the lines whose names match the extended regular expression $1, then adds the line $2 if it
# is given. Every other line is kept as it is, including lines this script does not know. The new copy replaces the
# old file only once it is complete. The file keeps its owner (root, for a new file) and is mode 600.
rewrite_env() {
  local drop=$1 add=${2:-} status=0
  umask 077
  if [ -f "$FILE" ]; then
    grep -Ev "$drop" "$FILE" > "$FILE.new" || status=$?
    if [ "$status" -gt 1 ]; then
      rm -f "$FILE.new"
      echo "Could not read $FILE." >&2
      exit 1
    fi
    chown --reference="$FILE" "$FILE.new"
  else
    : > "$FILE.new"
  fi
  if [ -n "$add" ]; then printf '%s\n' "$add" >> "$FILE.new"; fi
  chmod 600 "$FILE.new"
  mv -f "$FILE.new" "$FILE"
}

# Writes one setting into ai.env, replacing an old value of the same name, and keeps the others.
set_setting() {
  rewrite_env "^$1=" "$1=$2"
}

# Saves the full-app PIN to its own file, owned by the same user as the rest of App Inventor so that the hub can
# replace it. The copy in ai.env is removed, so there is only one PIN.
save_pin() {
  local pin=$1 owner tmp
  owner="$(stat -c %U "$BASE")"
  tmp="$PIN_FILE.tmp"
  umask 077
  printf '%s\n' "$pin" > "$tmp"
  chown "$owner:$owner" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$PIN_FILE"
  if [ -f "$FILE" ]; then
    rewrite_env '^AI_OVERRIDE_PIN='
  fi
}

case "${1:-}" in
  --off)
    # Removes the key, the full-app PIN and the search key. Other lines (the model overrides, for example) stay, so
    # they are still there when the helper is set up again. The file itself goes only when nothing else is in it.
    if [ -f "$FILE" ]; then
      rewrite_env '^(OPENROUTER_API_KEY|AI_OVERRIDE_PIN|BRAVE_API_KEY)='
      if ! grep -q '[^[:space:]]' "$FILE"; then rm -f "$FILE"; fi
    fi
    rm -f "$PIN_FILE"
    systemctl restart collab-hub
    echo "The AI helper is off. The key, the full-app PIN and the search key were removed; other lines in ai.env were kept."
    exit 0 ;;
  --status)
    if [ -s "$FILE" ] && grep -q '^OPENROUTER_API_KEY=.' "$FILE"; then
      echo "AI helper: on"
    else
      echo "AI helper: not set up"
    fi
    # The helper's three presets give the models. An override in ai.env replaces the model of one preset; an empty
    # one is ignored, as the hub ignores it.
    overrides=""
    for name in AI_MODEL_SMART AI_MODEL_BALANCED AI_MODEL_FAST; do
      value="$(get_setting "$name")"
      if [ -n "$value" ]; then overrides="${overrides:+$overrides, }$name=$value"; fi
    done
    if [ -n "$overrides" ]; then
      echo "Model overrides: $overrides"
    else
      echo "Model overrides: none (the helper uses its three presets)"
    fi
    # The PIN file, when there is one, is the PIN; otherwise the one in ai.env is.
    if [ -s "$PIN_FILE" ] || { [ ! -e "$PIN_FILE" ] && grep -q '^AI_OVERRIDE_PIN=.' "$FILE" 2>/dev/null; }; then
      echo "Full-app PIN: set (the Team panel can change it: Change override PIN)"
    else
      echo "Full-app PIN: not set (run: sudo /opt/appinventor/set-ai.sh --pin)"
    fi
    if grep -q '^BRAVE_API_KEY=.' "$FILE" 2>/dev/null; then
      echo "Web search: on"
    else
      echo "Web search: off (run: sudo /opt/appinventor/set-ai.sh --search)"
    fi
    exit 0 ;;
  --pin)
    read -r -s -p "Full-app PIN (typing is hidden; 4 to 20 letters or digits): " pin; echo
    if ! [[ "$pin" =~ ^[A-Za-z0-9]{4,20}$ ]]; then
      echo "The PIN must be 4 to 20 letters or digits." >&2
      exit 1
    fi
    save_pin "$pin"
    echo "Full-app PIN saved. In the AI helper, type /override and the PIN. It takes effect at once."
    exit 0 ;;
  --search)
    read -r -s -p "Brave Search API key (typing is hidden): " search; echo
    if ! [[ "$search" =~ ^[A-Za-z0-9_-]{10,200}$ ]]; then
      echo "That does not look like a Brave Search key." >&2
      exit 1
    fi
    set_setting BRAVE_API_KEY "$search"
    systemctl restart collab-hub
    echo "Web search is on. The helper can now search the web when it needs to."
    exit 0 ;;
  --model)
    # The model of one preset: smart, balanced or fast. --reset (or no name) puts the built-in model back.
    preset="$(printf '%s' "${2:-}" | tr '[:lower:]' '[:upper:]')"
    case "$preset" in
      SMART|BALANCED|FAST) ;;
      *) echo "Use: set-ai.sh --model smart|balanced|fast <model name>, or --reset" >&2; exit 1 ;;
    esac
    var="AI_MODEL_$preset"
    if [ -z "${3:-}" ] || [ "${3:-}" = "--reset" ]; then
      rewrite_env "^$var="
      what="the built-in model again"
    else
      model="$3"
      if ! [[ "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$ ]]; then
        echo "That does not look like an OpenRouter model name, for example anthropic/claude-haiku-5.5." >&2
        exit 1
      fi
      set_setting "$var" "$model"
      what="$model"
    fi
    systemctl restart collab-hub
    echo "The $(printf '%s' "$preset" | tr '[:upper:]' '[:lower:]') model is now $what."
    exit 0 ;;
esac

# Only the OpenRouter key is asked for. The daily limit is written when ai.env has none yet, or when AI_DAILY_LIMIT is
# set in the environment; a limit already in ai.env is kept.
read -r -s -p "OpenRouter key (typing is hidden): " key; echo
if [ -z "$key" ]; then
  echo "An OpenRouter key is needed." >&2
  exit 1
fi
case "$key" in *[[:space:]\"\'\\\$]*) echo "No spaces or quotes please." >&2; exit 1 ;; esac
# Only the key and the daily limit are written here. Every other line of ai.env (the models, the full-app PIN, the
# search key and any line this script does not know) is kept.
set_setting OPENROUTER_API_KEY "$key"
if [ -n "${AI_DAILY_LIMIT:-}" ] || [ -z "$(get_setting AI_DAILY_LIMIT)" ]; then
  set_setting AI_DAILY_LIMIT "${AI_DAILY_LIMIT:-300}"
fi
limit="$(get_setting AI_DAILY_LIMIT)"
systemctl restart collab-hub
echo "The AI helper is on (at most $limit questions a day for the whole team)."
echo "Press Ctrl+I+M inside App Inventor to open it."
