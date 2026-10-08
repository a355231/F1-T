#!/usr/bin/env bash
# Sets up (or turns off) the AI helper that opens with Ctrl+I+M in App Inventor.
#
#   sudo /opt/appinventor/set-ai.sh            # asks for the OpenRouter key and the model
#   sudo /opt/appinventor/set-ai.sh --pin      # asks for the PIN that turns on full-app mode (the Team panel
#                                              # can change it too: Change override PIN)
#   sudo /opt/appinventor/set-ai.sh --search   # asks for the Brave Search key (optional web search)
#   sudo /opt/appinventor/set-ai.sh --status
#   sudo /opt/appinventor/set-ai.sh --off      # turns the helper off, and forgets the PIN and search key
#
# The keys, the model and the search key are stored only in /opt/appinventor/ai.env (readable by root only)
# and read by the collaboration hub when it starts. The full-app PIN is kept in /opt/appinventor/overridepin
# instead, which the hub reads again whenever it changes, so the Team panel can change it too. They are never in the source code, never sent to
# a browser, and never printed. Get an OpenRouter key at https://openrouter.ai/keys; a model name looks
# like "anthropic/claude-sonnet-4.5" (see https://openrouter.ai/models). Web search uses a Brave Search
# API key (https://brave.com/search/api/, the free plan is enough for a team).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
BASE="${AI_BASE:-/opt/appinventor}"
FILE="$BASE/ai.env"
PIN_FILE="$BASE/overridepin"

# Writes one setting into ai.env, replacing an old value of the same name, and keeps the others.
set_setting() {
  local name=$1 value=$2
  umask 077
  touch "$FILE"
  { grep -v "^$name=" "$FILE" || true; printf '%s=%s\n' "$name" "$value"; } > "$FILE.new"
  mv "$FILE.new" "$FILE"
  chmod 600 "$FILE"
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
    { grep -v '^AI_OVERRIDE_PIN=' "$FILE" || true; } > "$FILE.new"
    mv -f "$FILE.new" "$FILE"
    chmod 600 "$FILE"
  fi
}

case "${1:-}" in
  --off)
    rm -f "$FILE" "$PIN_FILE"
    systemctl restart collab-hub
    echo "The AI helper is off. The full-app PIN and the search key were removed with it."
    exit 0 ;;
  --status)
    if [ -s "$FILE" ] && grep -q '^OPENROUTER_API_KEY=.' "$FILE"; then
      echo "AI helper: on, model $(grep '^OPENROUTER_MODEL=' "$FILE" | cut -d= -f2-)"
    else
      echo "AI helper: not set up"
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
esac

read -r -s -p "OpenRouter key (typing is hidden): " key; echo
read -r -p "Model name (for example anthropic/claude-sonnet-4.5): " model
if [ -z "$key" ] || [ -z "$model" ]; then
  echo "Both are needed." >&2
  exit 1
fi
case "$key$model" in *[[:space:]\"\'\\\$]*) echo "No spaces or quotes please." >&2; exit 1 ;; esac
limit="${AI_DAILY_LIMIT:-300}"
# Keep the full-app PIN and the search key when the key or model changes.
kept="$(grep -E '^(AI_OVERRIDE_PIN|BRAVE_API_KEY)=' "$FILE" 2>/dev/null || true)"
umask 077
printf 'OPENROUTER_API_KEY=%s\nOPENROUTER_MODEL=%s\nAI_DAILY_LIMIT=%s\n' "$key" "$model" "$limit" > "$FILE"
if [ -n "$kept" ]; then
  printf '%s\n' "$kept" >> "$FILE"
fi
chmod 600 "$FILE"
systemctl restart collab-hub
echo "The AI helper is on (model $model, at most $limit questions a day for the whole team)."
echo "Press Ctrl+I+M inside App Inventor to open it."
