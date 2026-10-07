#!/usr/bin/env bash
# Puts the Pi's own settings into the deployed App Inventor (/opt/appinventor/war):
#   * the location of the team code file (/opt/appinventor/teamcode), written into
#     WEB-INF/appengine-web.xml; the code itself stays in that file, which App Inventor re-reads at
#     every sign-in, so it can be changed while running;
#   * the Pi's cookie encryption key (/opt/appinventor/authkey), created on first use.
# Run by deploy-from-pc.sh and build-on-pi.sh after every deploy. Never prints the code.
set -euo pipefail

BASE=/opt/appinventor
WAR="$BASE/war"
XML="$WAR/WEB-INF/appengine-web.xml"

if [ ! -f "$XML" ]; then
  echo "App Inventor is not deployed yet ($XML is missing)." >&2
  exit 1
fi

python3 - "$XML" "$BASE/teamcode" <<'EOF'
import re, sys
from xml.sax.saxutils import quoteattr

xml_path, code_path = sys.argv[1], sys.argv[2]

with open(xml_path, encoding='utf-8') as f:
    xml = f.read()

def set_property(xml, name, value):
    line = '<property name="%s" value=%s />' % (name, quoteattr(value))
    pattern = re.compile(r'<property\s+name="%s"\s+value=("[^"]*"|\'[^\']*\')\s*/>' % re.escape(name))
    if pattern.search(xml):
        return pattern.sub(lambda m: line, xml, count=1)
    return xml.replace('</system-properties>', '    ' + line + '\n  </system-properties>', 1)

xml = set_property(xml, 'collab.teamcode', '')
xml = set_property(xml, 'collab.teamcode.file', code_path)
import os
backup_dir = os.path.join(os.path.dirname(code_path), 'backups')
os.makedirs(backup_dir, exist_ok=True)
xml = set_property(xml, 'collab.backup.dir', backup_dir)
try:
    with open(os.path.join(os.path.dirname(code_path), 'build-server'), encoding='utf-8') as f:
        host = f.read().strip()
    if host:
        xml = set_property(xml, 'build.server.host', host)
except OSError:
    pass
xml = set_property(xml, 'auth.usegoogle', 'false')
xml = set_property(xml, 'auth.uselocal', 'true')
with open(xml_path, 'w', encoding='utf-8') as f:
    f.write(xml)
EOF
chmod 600 "$XML"

# Login cookies are encrypted with this key. It stays on the Pi so that set-team-code.sh can
# replace it, which signs everyone out.
if [ ! -f "$BASE/authkey/meta" ]; then
  tool="$BASE/tools/KeyczarTool.jar"
  if [ ! -f "$tool" ]; then
    echo "Missing $tool; run deploy-from-pc.sh first." >&2
    exit 1
  fi
  rm -rf "$BASE/authkey"
  mkdir -p "$BASE/authkey"
  { java -jar "$tool" create --location="$BASE/authkey" --purpose=crypt &&
    java -jar "$tool" addkey --location="$BASE/authkey" &&
    java -jar "$tool" promote --location="$BASE/authkey" --version=1; } >/dev/null 2>&1 ||
    { echo "Could not create the login key in $BASE/authkey." >&2; exit 1; }
  chmod -R go-rwx "$BASE/authkey"
fi
rm -rf "$WAR/WEB-INF/authkey"
cp -r "$BASE/authkey" "$WAR/WEB-INF/authkey"
