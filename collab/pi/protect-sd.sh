#!/usr/bin/env bash
# Fewer writes to the SD card, without changing how App Inventor works.   sudo protect-sd.sh
#
#   * system logs are kept in memory (they are lost on reboot; use "journalctl" while it is up)
#   * Linux waits longer before flushing and prefers RAM over swap
#   * the root disk is mounted with noatime (reading a file no longer writes to it)
#   * /tmp is kept in memory
#   * the App Inventor datastore is written to disk every 2 minutes instead of every 30 seconds
#     (that is a setting in the appinventor service; a power cut can lose the last 2 minutes of
#     changes, but the minute-by-minute backups survive)
#   * swap lives in compressed RAM (zram) instead of on the card, when it can be installed
#
# Safe to run again.  protect-sd.sh --status shows how much has been written to the card so far.
set -uo pipefail

status() {
  for dev in /sys/block/mmcblk*; do
    [ -r "$dev/stat" ] || continue
    sectors="$(awk '{print $7}' "$dev/stat")"
    printf '  %s: %d MB written since the Pi started\n' "$(basename "$dev")" $((sectors * 512 / 1048576))
  done
  [ -e /sys/block/mmcblk0 ] || echo "  No SD card found (the Pi may boot from USB or SSD)."
  printf '  Logs: %s\n' "$(grep -qs '^Storage=volatile' /etc/systemd/journald.conf.d/appinventor-ram.conf && echo 'in memory' || echo 'on disk')"
  printf '  Swappiness: %s\n' "$(cat /proc/sys/vm/swappiness)"
  printf '  noatime: %s\n' "$(findmnt -no OPTIONS / | grep -q noatime && echo yes || echo no)"
}

if [ "${1:-}" = "--status" ]; then
  status
  exit 0
fi
if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

echo "Protecting the SD card:"

mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/appinventor-ram.conf <<'CONF'
[Journal]
Storage=volatile
RuntimeMaxUse=64M
CONF
systemctl restart systemd-journald 2>/dev/null || true
echo "  - logs are kept in memory"

cat > /etc/sysctl.d/90-appinventor-sd.conf <<'CONF'
vm.swappiness=10
vm.dirty_writeback_centisecs=1500
vm.dirty_expire_centisecs=6000
CONF
sysctl -q --system >/dev/null 2>&1 || true
echo "  - Linux flushes less often and prefers RAM over swap"

if grep -qE '^[^#].*[[:space:]]/[[:space:]]' /etc/fstab && ! grep -E '^[^#].*[[:space:]]/[[:space:]]' /etc/fstab | grep -q noatime; then
  cp -n /etc/fstab /etc/fstab.appinventor-backup
  sed -i -E '/^[^#].*[[:space:]]\/[[:space:]]/ s/(ext4[[:space:]]+)([^[:space:]]+)/\1\2,noatime/' /etc/fstab
  mount -o remount,noatime / 2>/dev/null || true
  echo "  - reading files no longer writes to the card (noatime; old fstab saved as /etc/fstab.appinventor-backup)"
else
  echo "  - noatime was already set"
fi

if [ -f /usr/share/systemd/tmp.mount ] && ! systemctl is-enabled tmp.mount >/dev/null 2>&1; then
  systemctl enable tmp.mount >/dev/null 2>&1 && echo "  - /tmp moves to memory after the next reboot"
fi

if ! dpkg -s zram-tools >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y zram-tools >/dev/null 2>&1 || true
fi
if dpkg -s zram-tools >/dev/null 2>&1; then
  printf 'ALGO=zstd\nPERCENT=50\n' > /etc/default/zramswap
  systemctl enable --now zramswap >/dev/null 2>&1 || true
  if [ -f /etc/dphys-swapfile ] && ! grep -q '^CONF_SWAPSIZE=0' /etc/dphys-swapfile; then
    sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=0/' /etc/dphys-swapfile
    systemctl restart dphys-swapfile 2>/dev/null || true
    swapoff /var/swap 2>/dev/null || true
  fi
  echo "  - swap is compressed memory instead of a file on the card"
else
  echo "  - zram could not be installed; swap stays as it was"
fi

echo
status
