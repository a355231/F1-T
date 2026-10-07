#!/usr/bin/env bash
# Runs App Inventor's build server on a PC (x86 Windows/WSL, macOS or Linux), so that
# Build > Android App works for the team. Keep it running while people build.
#
#   collab/pc/build-server.sh
#   (then, on the Pi)  sudo /opt/appinventor/set-build-server.sh <this-pc's-address>:9990
#
# Needs Java 11 and ant 1.10. Only people on your network should be able to reach port 9990.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/appinventor"
ant MakeAuthKey
cd buildserver
exec ant RunLocalBuildServer
