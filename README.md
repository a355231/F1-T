# App Inventor Team Edition

**MIT App Inventor, with real-time teamwork and an AI helper.** Two or three people can build the same
App Inventor project at the same time from their own computers. Everyone uses the normal App Inventor
interface. The project is hosted on a Raspberry Pi on your local network, and can also be reached from the
internet.

This is a fork of [MIT App Inventor](http://appinventor.mit.edu). The original README, with the developer
setup for the App Inventor sources, is kept in [README-MIT.md](README-MIT.md).

## What's different

- **Live shared editing.** Blocks and the designer update for everyone within a fraction of a second.
- **Teammates' cursors**, with their names, plus **follow**, **block locks**, **recent changes** and a
  per-project **chat**.
- **Sign-in with a name and a team code.** No accounts and no passwords.
- **Automatic backups** of each project every minute, with a restore from any earlier version.
- **An AI helper** (Ctrl+I+M) that reads the open project, checks it, and proposes changes for you to apply.
- **Nightly updates** at 3 AM that build the new version while the old one keeps running, and go back
  automatically if the new one fails.
- **Faster loading**: the hub keeps files in memory and compresses them on the way to the browser.

Everything is documented in detail in [collab/README.md](collab/README.md).

## Quick start (Raspberry Pi)

You need a **Raspberry Pi 4 or 5 with at least 4 GB of RAM**, running 64-bit Raspberry Pi OS and connected to
your network.

Run this on the Pi:

```
sudo -v && { cd ~/F1-T 2>/dev/null && git pull --ff-only || git clone -b claude/amazing-ritchie-68cj4h --depth 1 https://github.com/a355231/F1-T.git ~/F1-T; } && sudo ~/F1-T/collab/pi/setup.sh
```

The command downloads or updates this repository, installs everything, builds App Inventor on the Pi, starts
it, and prints the **address** and the **team code**. The first build takes roughly 20 to 60 minutes. It runs
under systemd, so it keeps going if your SSH connection drops. Run the same command again to watch it, or
to update later. Your projects and team code are kept.

To see the address and the team code again, and check that everything is running:

```
/opt/appinventor/show-info.sh
```

Or type **`MITSTATUS`** on the Pi. It shows the address, the access code, the override code and the AI models, and
offers: change the AI models, get a new address, restart App Inventor, change the access code, change the override
code, or exit. It is installed with the rest, so after an update it is there too. (The first time, or after an update
from before it, you can also install just the command with `sudo install -m 755 ~/F1-T/collab/pi/mitstatus.sh /usr/local/bin/MITSTATUS`.)

Building on a PC is faster (about five minutes). See [collab/README.md](collab/README.md#faster-builds-build-on-a-pc).

## Using it with your team

1. Open the address on your network, for example `http://<pi-address>:8080`.
2. Type your **name** and the **team code**, then select **Login**. The same name always opens the same
   account.
3. To work on a project together, open the **Team** panel (bottom-left) and choose **Share this project…**.
   Your teammate finds it under **My Projects** after they sign in.

Anyone who knows the team code can sign in as any name, so keep it private. To change it, use **Change team
code…** in the Team panel, or run `sudo /opt/appinventor/set-team-code.sh` on the Pi.

For a link you can reach from outside your network, run `/opt/appinventor/tunnel-url.sh` on the Pi. It prints
a temporary `trycloudflare.com` address that changes when the tunnel restarts. For a fixed address, see
the fixed-address section of [collab/README.md](collab/README.md).

## The AI helper

Press **Ctrl+I+M**, or choose **AI helper** in the Team panel. The helper works on the project that is open.
It answers as it writes, and works on a draft copy: a change reaches the project only when someone presses
**Apply**. The project is backed up first, every open App Inventor tab saves what it has, and the tabs reload by
themselves to show the change.

It can read and check the project, add and change components and blocks in App Inventor's own format, look up
components and documentation, draw pictures, and ask you a question when it needs a choice.

| Command | What it does |
|---|---|
| `/goal <goal>` | Works toward a goal in steps, with a plan and a Stop button |
| `/plan <idea>` | Plans a change without changing anything |
| `/check [focus]` | Checks the project and says what is wrong |
| `/explain [focus]` | Explains how the project works |
| `/fix <problem>` | Makes the smallest change that fixes one problem |
| `/effort` | Sets how hard the helper works: low, medium or high (the slider does the same) |
| `/override <PIN>` | Turns on full-app mode for an hour, so the helper can build a small app |
| `/override off` | Turns full-app mode off |
| `/discard` | Throws away an unfinished full app |
| `/new` (or `/clear`) | Starts a new conversation |
| `/help` | Lists the commands |

**Setting it up** (on the Pi, as the administrator):

```
sudo /opt/appinventor/set-ai.sh            # the OpenRouter key
sudo /opt/appinventor/set-ai.sh --pin      # the PIN that unlocks full-app mode (also Change override PIN in the Team panel)
sudo /opt/appinventor/set-ai.sh --search   # optional: a Brave Search key for web search
sudo /opt/appinventor/set-ai.sh --model smart anthropic/claude-haiku-5.5   # the model of one preset (or --reset)
sudo /opt/appinventor/set-ai.sh --status   # what is set
```

The keys are stored in `/opt/appinventor/ai.env` (readable only by root), and the PIN in `/opt/appinventor/overridepin`
(readable only by the user App Inventor runs as). Neither is in the source, and neither reaches a browser or the model. Questions are limited to 12 a minute per person and 300 a day for the
team. The project's screen files, your questions, and any pictures you attach are sent to the model service
when you ask.

## Keeping it up to date

Every night at **3 AM** the Pi checks for a new version. If there is one, it builds it while the current version
keeps running, and installs it only once the build succeeds. If the new version fails, the previous version is
put back automatically, and everyone who opens the app sees a notice saying so.

```
sudo /opt/appinventor/update.sh --check     # is there a newer version?
sudo /opt/appinventor/update.sh --now       # update now, even if people are online
sudo /opt/appinventor/update.sh --rollback  # go back to the previous version by hand
tail -n 60 /opt/appinventor/update.log      # what the last update did
```

Projects, backups, the team code and the AI settings are never touched by an update.

## Development

The Team Edition code lives in:

- `collab/server/`: the hub (Node.js) that serves App Inventor, relays live edits, and runs the AI helper.
- `collab/pi/`: the Raspberry Pi installer, the updater and the helper scripts.
- `collab/pc/`: the build server for building Android apps on a PC.
- `appinventor/`: the App Inventor sources, with the collaboration code in
  `appinventor/appengine/src/com/google/appinventor/client/collab/` and
  `appinventor/appengine/war/static/js/collab.js`.

To run the hub's tests:

```
cd collab/server && npm install && npm test
```

For building the App Inventor sources themselves, see [README-MIT.md](README-MIT.md).

## Limits

- If two people change the *same* block or property at the same instant, the last change wins, and the two
  screens can briefly differ. Reopening the project brings everyone back in line.
- Changes to project properties are saved, but teammates see them after reopening the project.
- Building Android apps (.apk, .ipa) needs a build server on an x86 PC, because the Android build tools do not
  run on the Pi.
- The AI helper checks structure and names. It does not run the app or check that the blocks do what you
  intended.

## License

App Inventor is released under the Apache License, Version 2.0. See [LICENSE](LICENSE).
