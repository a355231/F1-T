#!/usr/bin/env bash
# Tests the nightly updater (collab/pi/update.sh) without a Raspberry Pi, as root. The services,
# the build and the health checks are stand-ins, and every folder is temporary.
#
#   sudo bash collab/pi/test/update-test.sh
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0" >&2; exit 2; }
command -v rsync >/dev/null && command -v flock >/dev/null && command -v python3 >/dev/null ||
  { echo "This test needs rsync, flock and python3." >&2; exit 2; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
UPDATE="$HERE/update.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export AI_BASE="$T/opt" AI_UNIT_DIR="$T/units" AI_LOCK="$T/lock"
export AI_HEALTH_SECONDS=2 AI_HEALTH_STEP=1 AI_STABLE_SECONDS=0
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.org
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.org
mkdir -p "$AI_BASE" "$AI_UNIT_DIR" "$T/bin" "$T/author"
echo "test-team-code" > "$AI_BASE/teamcode"
export PATH="$T/bin:$PATH"

# Stand-ins for systemd, and for App Inventor (port 8888) and the hub (port 8080). FAKE_BROKEN is
# a version whose health check fails.
cat > "$T/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "$AI_BASE/calls.log"
STUB
cat > "$T/bin/curl" <<'STUB'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *8888*) echo -n 200 ;;
  *8080/collab/status*)
    ver="$(cat "$AI_BASE/version" 2>/dev/null)"
    [ -n "${FAKE_BROKEN:-}" ] && [ "$ver" = "$FAKE_BROKEN" ] && ver=broken
    printf '{\n  "online": %s,\n  "version": "%s"\n}\n' "${FAKE_ONLINE:-[]}" "$ver" ;;
  *) exit 7 ;;
esac
STUB
chmod +x "$T/bin/systemctl" "$T/bin/curl"

# The project: a repository with a marker file and a stand-in installer. The installer copies the
# marker into place (replacing the file, as rsync does), and fails when FAKE_INSTALL_RC says so.
ORIGIN="$T/origin.git"
REPO="$T/repo"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$T/author"
git -C "$T/author" remote add origin "$ORIGIN"
mkdir -p "$T/author/collab/pi"
cat > "$T/author/collab/pi/install.sh" <<'INSTALL'
#!/usr/bin/env bash
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$AI_BASE/war"
cp "$root/marker.txt" "$AI_BASE/war/marker.tmp" && mv "$AI_BASE/war/marker.tmp" "$AI_BASE/war/marker.txt"
git -C "$root" rev-parse --short HEAD > "$AI_BASE/version.tmp" && mv "$AI_BASE/version.tmp" "$AI_BASE/version"
echo "installed $(cat "$root/marker.txt")" >> "$AI_BASE/calls.log"
exit "${FAKE_INSTALL_RC:-0}"
INSTALL
chmod +x "$T/author/collab/pi/install.sh"

publish() {  # a new version, with the marker text given
  echo "$1" > "$T/author/marker.txt"
  git -C "$T/author" add -A
  git -C "$T/author" commit -q -m "version $1"
  git -C "$T/author" push -q origin HEAD:main
}

publish one
git clone -q "$ORIGIN" "$REPO"
echo "$REPO" > "$AI_BASE/repo"
mkdir -p "$AI_BASE/war" "$AI_BASE/hub"
echo one > "$AI_BASE/war/marker.txt"
echo hub > "$AI_BASE/hub/hub.js"
git -C "$REPO" rev-parse --short HEAD > "$AI_BASE/version"
V1FULL="$(git -C "$REPO" rev-parse HEAD)"

installs() { grep -c '^installed' "$AI_BASE/calls.log" 2>/dev/null || true; }
run() { bash "$UPDATE" "$@" > "$T/out" 2>&1; }

pass=0
failed=0
check() {
  local name=$1
  shift
  if "$@"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name"
    failed=$((failed + 1))
  fi
}

# 1. A new version is downloaded, built and started, and the old one is kept for rollback.
publish two
V2="$(git -C "$T/author" rev-parse --short HEAD)"
V2FULL="$(git -C "$T/author" rev-parse HEAD)"
run --now; rc=$?
check "a good update succeeds" [ "$rc" = 0 ]
check "the new version is running" grep -qx two "$AI_BASE/war/marker.txt"
check "the version file shows the new version" [ "$(cat "$AI_BASE/version")" = "$V2" ]
check "no notice is left" [ ! -e "$AI_BASE/update-failed" ]
check "the old version is kept for rollback" [ "$(cat "$AI_BASE/rollback/commit")" = "$V1FULL" ]
check "the old files are kept for rollback" grep -qx one "$AI_BASE/rollback/war/marker.txt"

# 2. Nothing new: no build.
before="$(installs)"
run; rc=$?
check "an up-to-date check succeeds" [ "$rc" = 0 ]
check "an up-to-date check does not build" [ "$(installs)" = "$before" ]
check "an up-to-date check says so" grep -q "Up to date" "$T/out"

# 3. A failed build puts the old version back, and tells everybody.
publish three
export FAKE_INSTALL_RC=1
run --now; rc=$?
unset FAKE_INSTALL_RC
check "a failed build is a failed update" [ "$rc" = 1 ]
check "the old version is running again" grep -qx two "$AI_BASE/war/marker.txt"
check "the version file is the old one" [ "$(cat "$AI_BASE/version")" = "$V2" ]
check "the repository is back on the old commit" [ "$(git -C "$REPO" rev-parse HEAD)" = "$V2FULL" ]
check "everybody is told it failed at compile" grep -q "failed at compile" "$AI_BASE/update-failed"
check "the notice says the previous version runs" grep -q "running again" "$AI_BASE/update-failed"

# 4. A new version that does not answer is put back too.
publish four
V4="$(git -C "$T/author" rev-parse --short HEAD)"
export FAKE_BROKEN="$V4"
run --now; rc=$?
unset FAKE_BROKEN
check "a version that does not answer is a failed update" [ "$rc" = 1 ]
check "the previous version is running again" grep -qx two "$AI_BASE/war/marker.txt"
check "the notice says it failed at start" grep -q "failed at start" "$AI_BASE/update-failed"

# 5. People are online: nothing is installed, and the next half hour tries again.
publish five
rm -f "$AI_BASE/update-state"
before="$(installs)"
export FAKE_ONLINE='[{"name":"someone"}]'
run; rc=$?
unset FAKE_ONLINE
check "waiting for people to leave is not an error" [ "$rc" = 0 ]
check "nothing is installed while people are online" [ "$(installs)" = "$before" ]
check "the run says people are online" grep -q "People are online" "$T/out"

# 6. A quiet night: the update runs, and only once that day.
run; rc=$?
check "the nightly run succeeds" [ "$rc" = 0 ]
check "the nightly run installs the new version" grep -qx five "$AI_BASE/war/marker.txt"
publish six
before="$(installs)"
run
check "a second run the same day does not build again" [ "$(installs)" = "$before" ]

# 7. Rollback by hand puts back the version from before the last update.
run --rollback; rc=$?
check "rollback succeeds" [ "$rc" = 0 ]
check "rollback puts back the version from before the last update" grep -qx two "$AI_BASE/war/marker.txt"

# 8. A simulated failure at compile is undone without a build.
run --now --simulate-failure=compile; rc=$?
check "a simulated failure is reported" [ "$rc" = 1 ]
check "and the old version is running again" grep -qx two "$AI_BASE/war/marker.txt"

# 9. Notify mode only reports a newer version.
run --mode notify
check "notify mode is saved" [ "$(cat "$AI_BASE/update-mode")" = notify ]
publish seven
before="$(installs)"
run; rc=$?
check "notify mode does not build" [ "$(installs)" = "$before" ]
check "notify mode says it only reports" grep -q "notify only" "$T/out"

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
