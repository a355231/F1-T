# Notes for Claude

## MITSTATUS

`collab/pi/mitstatus.sh` is the menu the administrator runs on the Pi. Every time a new feature is added that the
administrator needs to set up, change or see on the Pi, add it to MITSTATUS in the same change: a menu option, a status
line, and a check in `collab/pi/test/mitstatus-test.sh`. The same goes for a setting that `set-ai.sh` or the update
scripts manage. Keep the MITSTATUS paragraph in `collab/README.md` up to date too.

Keys and PINs are never printed, put in the source, or sent to a browser. MITSTATUS shows only whether a key is set.
