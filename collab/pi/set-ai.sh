#!/usr/bin/env bash
# Sets up (or turns off) the AI helper that opens with Ctrl+I+M in App Inventor.
#
#   sudo /opt/appinventor/set-ai.sh            # asks for the OpenRouter key and the model
#   sudo /opt/appinventor/set-ai.sh --off
#   sudo /opt/appinventor/set-ai.sh --status
#
# The key and the model are stored only in /opt/appinventor/ai.env (readable by root only) and are
# read by the collaboration hub when it starts. They are never in the source code, never sent to
# a browser, and never printed. Get a key at https://openrouter.ai/keys; a model name looks like
# "anthropic/claude-sonnet-4.5" (see https://openrouter.ai/models).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
FILE=/opt/appinventor/ai.env

case "${1:-}" in
  --off)
    rm -f "$FILE"
    systemctl restart collab-hub
    echo "The AI helper is off."
    exit 0 ;;
  --status)
    if [ -s "$FILE" ] && grep -q '^OPENROUTER_API_KEY=.' "$FILE"; then
      echo "AI helper: on, model $(grep '^OPENROUTER_MODEL=' "$FILE" | cut -d= -f2-)"
    else
      echo "AI helper: not set up"
    fi
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
umask 077
printf 'OPENROUTER_API_KEY=%s\nOPENROUTER_MODEL=%s\nAI_DAILY_LIMIT=%s\n' "$key" "$model" "$limit" > "$FILE"
chmod 600 "$FILE"
systemctl restart collab-hub
echo "The AI helper is on (model $model, at most $limit questions a day for the whole team)."
echo "Press Ctrl+I+M inside App Inventor to open it."
