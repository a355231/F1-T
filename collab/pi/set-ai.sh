#!/usr/bin/env bash
# Sets up (or turns off) the AI helper that opens with Ctrl+I+M in App Inventor.
#
#   sudo /opt/appinventor/set-ai.sh            # asks for the OpenRouter key and the model
#   sudo /opt/appinventor/set-ai.sh --pin      # asks for the PIN that turns on full-app mode
#   sudo /opt/appinventor/set-ai.sh --status
#   sudo /opt/appinventor/set-ai.sh --off      # turns the helper off, and forgets the PIN
#
# The key, the model and the PIN are stored only in /opt/appinventor/ai.env (readable by root only)
# and read by the collaboration hub when it starts. They are never in the source code, never sent to
# a browser, and never printed. Get a key at https://openrouter.ai/keys; a model name looks like
# "anthropic/claude-sonnet-4.5" (see https://openrouter.ai/models).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
FILE=/opt/appinventor/ai.env

case "${1:-}" in
  --off)
    rm -f "$FILE"
    systemctl restart collab-hub
    echo "The AI helper is off. The full-app PIN was removed with it."
    exit 0 ;;
  --status)
    if [ -s "$FILE" ] && grep -q '^OPENROUTER_API_KEY=.' "$FILE"; then
      echo "AI helper: on, model $(grep '^OPENROUTER_MODEL=' "$FILE" | cut -d= -f2-)"
    else
      echo "AI helper: not set up"
    fi
    if grep -q '^AI_OVERRIDE_PIN=.' "$FILE" 2>/dev/null; then
      echo "Full-app PIN: set"
    else
      echo "Full-app PIN: not set (run: sudo /opt/appinventor/set-ai.sh --pin)"
    fi
    exit 0 ;;
  --pin)
    read -r -s -p "Full-app PIN (typing is hidden; 4 to 20 letters or digits): " pin; echo
    if ! [[ "$pin" =~ ^[A-Za-z0-9]{4,20}$ ]]; then
      echo "The PIN must be 4 to 20 letters or digits." >&2
      exit 1
    fi
    umask 077
    touch "$FILE"
    { grep -v '^AI_OVERRIDE_PIN=' "$FILE" || true; printf 'AI_OVERRIDE_PIN=%s\n' "$pin"; } > "$FILE.new"
    mv "$FILE.new" "$FILE"
    chmod 600 "$FILE"
    systemctl restart collab-hub
    echo "Full-app PIN saved. In the AI helper, type /override and the PIN."
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
# Keep an existing full-app PIN when the key or model changes.
pin_line="$(grep '^AI_OVERRIDE_PIN=' "$FILE" 2>/dev/null || true)"
umask 077
printf 'OPENROUTER_API_KEY=%s\nOPENROUTER_MODEL=%s\nAI_DAILY_LIMIT=%s\n' "$key" "$model" "$limit" > "$FILE"
if [ -n "$pin_line" ]; then
  printf '%s\n' "$pin_line" >> "$FILE"
fi
chmod 600 "$FILE"
systemctl restart collab-hub
echo "The AI helper is on (model $model, at most $limit questions a day for the whole team)."
echo "Press Ctrl+I+M inside App Inventor to open it."
