#!/usr/bin/env bash
# Moves the projects (and their backups) from the SD card to a USB stick or SSD.
#
#   sudo /opt/appinventor/move-data.sh /mnt/usb        # a folder that is a mounted drive
#   sudo /opt/appinventor/move-data.sh --undo          # back to the SD card
#
# Everything is copied first and checked before the old copy is touched. App Inventor is stopped
# for a moment.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

BASE=/opt/appinventor
GEN="$BASE/war/WEB-INF/appengine-generated"
BAK="$BASE/backups"
OWNER="$(stat -c %U "$BASE")"

stop() { systemctl stop collab-hub appinventor; }
start() { systemctl start appinventor collab-hub; }

if [ "${1:-}" = "--undo" ]; then
  for link in "$GEN" "$BAK"; do
    if [ -L "$link" ]; then
      target="$(readlink -f "$link")"
      [ -d "$target" ] || { echo "Cannot find $target; is the drive plugged in?" >&2; exit 1; }
    fi
  done
  stop
  for link in "$GEN" "$BAK"; do
    if [ -L "$link" ]; then
      target="$(readlink -f "$link")"
      rm "$link"
      cp -a "$target" "$link"
    fi
  done
  start
  echo "The data is back on the SD card. The copy on the drive was left alone."
  exit 0
fi

MP="${1:-}"
if [ -z "$MP" ] || ! findmnt -n "$MP" >/dev/null 2>&1; then
  echo "Usage: $0 /path/to/mounted/drive    (it has to be a mounted drive, see: lsblk)" >&2
  exit 1
fi
if [ "$(findmnt -no FSTYPE "$MP")" = "vfat" ] || [ "$(findmnt -no FSTYPE "$MP")" = "exfat" ]; then
  echo "That drive is formatted as $(findmnt -no FSTYPE "$MP"), which cannot keep file permissions. Format it as ext4 first." >&2
  exit 1
fi
DEST="$MP/appinventor-data"
mkdir -p "$DEST"
stop
trap 'start' EXIT
for pair in "$GEN:generated" "$BAK:backups"; do
  src="${pair%%:*}"; name="${pair##*:}"
  if [ -L "$src" ]; then
    echo "$src is already on a drive ($(readlink -f "$src"))"
    continue
  fi
  mkdir -p "$src"
  rsync -a "$src/" "$DEST/$name/"
  if ! diff -rq "$src" "$DEST/$name" >/dev/null; then
    echo "The copy of $src does not match; leaving everything as it was." >&2
    exit 1
  fi
  mv "$src" "$src.on-sd-card"
  ln -s "$DEST/$name" "$src"
  chown -R "$OWNER:$OWNER" "$DEST"
  echo "$src now lives on $MP (the old copy is kept as $src.on-sd-card; delete it once you are happy)"
done
