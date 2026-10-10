# App Inventor with real-time collaboration

This repository is MIT App Inventor 2 with one addition: two or three people can work on the same
project at the same time from their own computers. Everyone uses the normal App Inventor
interface, with the same menus as MIT's site. The additions are a small **Team** panel in the
bottom-left corner (with **Share this project…**, **Change team code…** and **Change override PIN…** links), and a coloured
mouse cursor with a name for each teammate who is working in the same project.

## What is shared live

| | Live for teammates? |
|---|---|
| Blocks (add, move, delete, edit fields, collapse, disable, comments, variables) | Yes |
| Designer: add, move, delete, rename components, change any property | Yes |
| Which screen and editor each person is in, who is testing on a companion | Yes (Team panel) |
| Where each teammate's mouse is, with their name | Yes, every 5 seconds (see below) |
| Each person's companion (phone or iPad) | Yes, every 5 seconds (can be switched off), see below |
| New and removed screens, uploaded and deleted media | Yes, within a couple of seconds |
| Project properties dialogs | Saved to the server; teammates see them after reopening the project |
| What a teammate has selected, block locks, recent changes, chat | Yes (Team panel and outlines) |

**Teammates' mouse cursors.** While you are in the blocks editor or looking at the designer's phone
preview, everyone else in the same project sees a second cursor: an arrow with the name you signed
in with, always shown next to it. Each person has a colour (red, blue or yellow; a fourth person
online at the same moment would share one). Your position is shared **every 5 seconds**, and the
cursor glides to its new spot. In the blocks editor the cursor is attached to a spot in the
workspace, so it stays on the same block when someone scrolls or zooms; in the designer it is
measured from the corner of the phone preview. A cursor only shows if you are looking at the same
screen and the same editor (Designer or Blocks) as that person, and it disappears when their mouse
leaves the workspace or preview, or when they close the project.

**Companions.** Everyone runs their own companion, connected from their own App Inventor
window. Your own edits reach your companion right away, as usual. By default your teammates'
changes are sent to *your* companion too, **every 5 seconds** (only what changed, so your running
app is not restarted for a block edit). If someone is demonstrating on an iPad and does not want
the app to change under them, they untick **Update my companion with teammates' changes** in the
Team panel. Then the panel shows "N waiting", and **Load teammates' changes now** (or
**Connect › Reset Connection**) brings them in when they are ready.

**Saving.** Projects are saved on the server (the Raspberry Pi) as in normal App Inventor. While
several people have a project open, only one client, marked **main** in the Team panel, writes it
to the server. That's the project's owner if they're there, otherwise whoever opened it first.
Everyone else's edits reach the server through the main client within a few seconds. If the main
person leaves, another person becomes main automatically and saves anything pending.

## How it fits together

```
 Computer 1 ┐                      Raspberry Pi
 Computer 2 ├─ LAN :8080 ──┬─► collab hub (Node.js, collab/server) ─► App Inventor :8888
 Computer 3 ┘              │     • proxies every normal request          (App Engine dev
                           │     • /collab/ws: live edits + presence      server, projects
 Internet ── trycloudflare ┘                                              stored on the Pi)
            (cloudflared on the Pi)
```

* `collab/server/` is the hub. It reverse-proxies App Inventor and relays edits over a WebSocket.
  WebSocket users are checked against their App Inventor login. Before anyone joins a project's
  session, App Inventor confirms they have access to that project.
* `appinventor/appengine/war/static/js/collab.js` is the browser side. It connects to the hub,
  sends your block and designer edits, applies teammates' edits, and draws the Team panel, the
  teammate cursors and the Change team code dialog.
* `appinventor/appengine/src/com/google/appinventor/client/collab/Collab.java` connects the
  designer to that script and stops non-main clients from saving.
* `appinventor/appengine/src/com/google/appinventor/server/CollabServlet.java` holds the endpoints
  for "who am I", "may I open this project", "share this project" and "change the team code".
  Shared projects appear in each teammate's own **My Projects**.
* `appinventor/appengine/src/com/google/appinventor/server/TeamLogin.java` is the sign-in: a name
  plus the team code (see below).

## Raspberry Pi setup

You need a Raspberry Pi 4 or 5 with 4 GB of RAM or more, running 64-bit Raspberry Pi OS.

### Quickest: one command on the Pi

```
sudo -v && { cd ~/F1-T 2>/dev/null && git pull --ff-only || git clone -b claude/amazing-ritchie-68cj4h --depth 1 https://github.com/a355231/F1-T.git ~/F1-T; } && sudo ~/F1-T/collab/pi/setup.sh
```

This downloads (or updates) this repository, installs everything, builds App Inventor on the Pi,
starts it, and finishes by printing the **link** and the **team code**. Details:

* `sudo -v` asks for your password first, on its own, so it cannot be swallowed by anything later.
* If the repository is private, `git clone` asks for your GitHub username and a
  [personal access token](https://github.com/settings/tokens) with read access as the password
  (or sign in once with `gh auth login`).
* The first time, it asks you to choose the **team code** (press Enter to have one made up). It is
  stored in `/opt/appinventor/teamcode`, readable only by the Pi's user.
* The build takes roughly 20-60 minutes on a Pi. The install runs under systemd, so **it keeps
  going if your SSH connection drops**. Run the same command again to watch it; it shows one line
  per stage, and `setup.sh --verbose` shows everything. On a 4 GB Pi it adds temporary swap for the
  build.
* Everything starts again on every boot (`appinventor`, `collab-hub`, `cloudflared-quick`).
* Run the same command later to update. Your projects and the team code are kept.

To see the link and the team code again at any time, and check that everything is running:

```
/opt/appinventor/show-info.sh
```

### Faster builds: build on a PC

Building on a PC (Windows with WSL, macOS, or Linux, with Java 11 JDK and ant 1.10) takes about
5 minutes instead:

1. On the Pi, from a copy of this repository:

   ```
   sudo collab/pi/install.sh
   ```

   This installs Java, Node.js, the App Engine dev server and `cloudflared`, and sets up three
   services: `appinventor`, `collab-hub` and `cloudflared-quick`. It also asks for a **team code**
   (press Enter to have one made up for you; it is shown once). The code is stored in
   `/opt/appinventor/teamcode`, readable only by the Pi's user.

   (This installs the programs only. The one command above does that and the build in one go.)

2. On the PC, build and copy everything to the Pi:

   ```
   collab/pi/deploy-from-pc.sh pi@<pi-address>
   ```

   Run this again whenever you change the code. Saved projects on the Pi are kept, and the team
   code stays on the Pi (it is never copied or printed by the deploy).

3. Addresses:
   * On the LAN: `http://<pi-address>:8080`
   * From the internet: run `/opt/appinventor/tunnel-url.sh` on the Pi. It prints a
     `https://….trycloudflare.com` address. Cloudflare's free quick tunnel picks a new address
     every time the tunnel restarts, such as after a reboot. For a permanent address, set up a
     free named tunnel with a Cloudflare account and point it at `http://127.0.0.1:8080`.

### First start: signing in

There are no accounts to create and no passwords. Everyone signs in with **their name** and the
**team code**.

1. Pick the team code the first time you run the install. You can change it **while App
   Inventor is running** (see "Changing the team code" below).
2. Tell your teammates the code privately.
3. Each person opens App Inventor, types their name and the code, and selects Login.

Names are not case-sensitive and can use up to 30 letters, digits, `-` and `.` (no spaces).
**The same name always opens the same account**, so use the same name every time to get back to
your projects. A new name starts a new, empty account.

If no team code is set, the login page says so and nobody can sign in.

**Security.** Anyone who knows the team code can sign in, *as any name*, including a teammate's,
and then see and change that person's projects. Through the Cloudflare address that includes anyone
on the internet. So:

* keep the code private and long (the made-up ones are 12 random letters and digits);
* if it leaks, or someone leaves the team, change the code and tick **Also sign everyone else out**
  (see below). The old code stops working at once;
* after a few wrong codes from one address, App Inventor makes that address wait (5 seconds,
  then 10, 20, … up to 5 minutes) before it may try again.

The App Engine dev server's own pages (`/_ah/…`, including its test sign-in at
`/login/google`) only work in a browser on the Pi itself. The hub blocks them for everyone on the
LAN or the internet.

### Changing the team code

The code can be changed at any time, with no restart and no rebuild. The next sign-in needs the new
code.

* **From App Inventor:** open the Team panel (bottom-left), choose **Change team code…**, type the
  current code and the new one (or choose **Make one up**), and select **Change code**. You need the
  current code, so someone at an unlocked computer cannot take over. Everyone else who is online is
  told by name that you changed it (the code itself is never sent to them), so you can pass it on.
* **From the Pi:** `sudo /opt/appinventor/set-team-code.sh` (asks for the new code), or add
  `--random` to have one made up and shown once.

By default, people who are already signed in stay signed in, so nobody is thrown out of their work.
If the old code leaked, sign them out as well: tick **Also sign everyone else out right now** in
the dialog, or run `sudo /opt/appinventor/set-team-code.sh --signout`. Everyone else's open pages
then stop working and their live connection is dropped; they sign in again with the new code. You
stay signed in.

The code is a single line of text in `/opt/appinventor/teamcode`; App Inventor reads it again at
every sign-in. If you empty that file, sign-in is switched off, again without a restart.

### Working together

1. One person creates or opens a project, opens the Team panel (bottom-left), and chooses
   **Share this project…**. Enter the name a teammate signs in with. The project appears in their
   **My Projects** after they reload App Inventor. Sharing with a name nobody has used yet is
   fine: the project is waiting when someone first signs in with that name.
2. Everyone opens the project. The Team panel lists everyone by the name they signed in with,
   which project, screen and editor each is in, who is main, and who is testing on a companion.
3. Build edits in the blocks or designer appear for everyone within a fraction of a second, and
   you see each other's cursors, with names, as described above.

### Building apps (.apk / .ipa)

Live testing with the MIT AI2 Companion works without anything else. **Build › Android App**
needs App Inventor's build server, which can't run on the Pi because Android's build tools are
x86-only. Run it on one of the PCs (`collab/pc/build-server.sh`), then on the Pi run
`sudo /opt/appinventor/set-build-server.sh <pc-address>:9990`.

## More team features

**The 30-second syncer.** Live edits can occasionally go missing (a lost connection, two people
dragging the same block). Every 30 seconds the hub asks everyone for a short fingerprint of the
screens people are on and compares each person's with the main client's. If someone's blocks differ
two rounds in a row (and nobody was editing at the time), they get the main client's blocks; if
their designer differs, their page reloads from the main client's saved copy. A screen is never
re-synced more than twice in 10 minutes, so a harmless difference cannot cause a loop. A teammate's
edits that cannot be applied for 30 seconds are replayed from the hub's log.

**Backups and going back.** While a project is open, it is backed up **every minute, but only if it
changed** (a backup is a zip of the project's source files in `/opt/appinventor/backups/<project>/`).
All of the last hour is kept, then one per 10 minutes for a day, one per hour for a week and one
per day, at most 400. To go back: in **My Projects**, **right-click** the project, choose **Go back
to an earlier version…**, and press **Restore** next to a time. A backup of the current version is
made first (so a restore can itself be undone), everyone who has the project open stops saving and
reloads. Right-click › **Back up now** makes one at once.

**Following, outlines, locks, changes, chat.** In the Team panel:
* **follow** next to a teammate takes you to whatever they are looking at (project, screen,
  Designer or Blocks) and keeps following until you press **stop following**.
* A block a teammate has selected gets an outline in their colour with their name (and "is typing…"
  while they edit a field).
* **Block locks:** the block you select is yours for about a minute (renewed while it stays
  selected). Others can look but a click on it says who is editing it. Locks are a courtesy that
  the browsers enforce, not a security feature; you can switch them off in the panel for yourself.
* **Recent changes** ("Sam added Button2 on Screen1") and a per-project **Chat**.

**Admin page** (`/collab/admin`, any signed-in person): who is online and where, **Sign out** next
to a person (they can sign in again with the team code; change the code to keep someone out), and
**Sign everyone out** (asks for the team code). It also shows the version and alerts.

**Alerts.** A yellow banner appears for everyone when the Pi is almost out of disk space or memory,
when App Inventor stops answering, or when a newer version of this software exists.

**Version, updates, restarts.** `/opt/appinventor/show-info.sh` shows the version.

**Nightly updates.** Every night at **3 AM** a systemd timer (`collab-update.timer`) checks the
branch on GitHub. If there is something new, it downloads it and **builds it while the current
version keeps running**. Only when the build has succeeded is the new version installed and
started. If people are online at 3 AM, it tries again every half hour until 6 AM, and it never
interrupts a session. Your projects, backups, team code and OpenRouter settings are never touched.

**If the new version fails, it goes back.** A failed build, or a new version that does not answer
within 10 minutes, puts the previous version back automatically. Everyone who opens the link then
sees a red notice at the top of the page, saying which step failed and that the previous version
is running again. The notice goes away after the next update that works. The log is
`/opt/appinventor/update.log` (`sudo tail -n 60 /opt/appinventor/update.log`).

The previous version is kept in `/opt/appinventor/rollback`, so you can go back by hand with
`sudo /opt/appinventor/update.sh --rollback`. Commands:
* `--check` says whether a newer version exists, without installing it.
* `--now` updates right away, even if people are online.
* `--mode install|notify|off` chooses what the nightly run does: install (the default), only
  report that a newer version exists, or nothing.
* `--now --simulate-failure=compile` or `=start` rehearses a failure and the way back. The `start`
  rehearsal does a real build first.

Whoever runs the Pi should know that a "successful" update means the new version starts and
answers. It does not check that every feature works. The updater trusts whatever is on the branch
it was installed from. Its test, `collab/pi/test/update-test.sh`, runs on any machine.

`collab-watchdog.timer` restarts App Inventor or the hub if they stop answering for 3 minutes.

**Fewer writes to the SD card.** The installer runs `/opt/appinventor/protect-sd.sh`: system logs in
memory, `noatime`, `/tmp` and swap in memory (zram), gentler write-back, and the datastore saved
every 2 minutes instead of every 30 seconds (a power cut can lose the last 2 minutes of edits,
and the minute-by-minute backups survive). Backups are skipped when nothing changed.
`protect-sd.sh --status` shows how much has been written since boot. To move projects and backups
to a USB stick or SSD (ext4): `sudo /opt/appinventor/move-data.sh /mnt/usb` (and `--undo`).
Logs live in memory now, so after a reboot `journalctl` starts empty.

**A link that never changes.** The Cloudflare quick tunnel gets a new address when it restarts.
For a fixed one, install Tailscale on the Pi (`curl -fsSL https://tailscale.com/install.sh | sh`,
`sudo tailscale up`) and run `sudo /opt/appinventor/stable-link.sh`; it turns on Tailscale Funnel
and prints your `https://….ts.net` address. Both links work at the same time.

**Build server.** Build › Android App needs the build server on an x86 PC: run
`collab/pc/build-server.sh` there, then on the Pi
`sudo /opt/appinventor/set-build-server.sh <pc-address>:9990` (kept across updates).

## AI helper

Press **Ctrl+I+M** (hold Ctrl and I, then M), or click **AI helper** in the Team panel, to open it in
its own window. It works on the project that is open, and its answers stream in as they are written,
like a chat app. The helper works on a draft copy of the project. A change reaches the project only when
someone presses **Apply**. Then the project is backed up, every open App Inventor tab saves what it has, the
change goes in, and the tabs reload by themselves: nobody needs to reload by hand. The helper's window tells the
App Inventor tab that opened it as well, in case that tab's connection to the team server missed the message.

**What it can do**

* **Read and check the project**: list the files, read a file (400 lines at a time), search every file,
  outline a screen's components and blocks, and run `check_project`, which finds components and blocks
  that do not exist, duplicate names and handlers, and missing settings.
* **Change screens**: add, set, remove and rename components (checked against App Inventor's own list of
  components, properties and events); add event handlers and blocks in App Inventor's format, with
  examples built in; edit a piece of text in a file.
* **Look things up**: a component's properties, methods and events; the component types by category;
  documentation pages from App Inventor, Android, MDN, Python, W3C, GitHub, Wikipedia, Stack Overflow,
  Microsoft Learn and Oracle, read as text (https only); web search, if Brave Search is set up.
* **Calculate and take notes**: exact arithmetic, the time on the Pi, and up to 40 notes kept for an hour.
* **Draw pictures**: `create_svg` draws an SVG, `svg_to_png` turns it into a PNG, and a proposal can add
  the PNG to the project's pictures.
* **Look at pictures**, when the model in use accepts images: pictures in the project, pictures it drew,
  and pictures you attach. Attach with the paperclip, paste, or drop them on the box: up to three, PNG,
  JPEG, GIF or WebP, 1.5 MB each. The paperclip only shows when the model can look at pictures.
* **Ask you a question** when it needs a choice, such as a colour. You answer in your next message.
* **Check what blocks mean.** `check_project` also checks each block against App Inventor's own reference: a
  property, method or event the component does not have, a block that names the wrong component type, and a global
  variable or procedure used but never defined. In full-app mode such a problem keeps the Apply button back until it
  is fixed. Yes/no and colour values are stored the way App Inventor writes them (`True`, `&HFFFF0000`).
* **One subagent.** The helper can hand one self-contained part of a job to a subagent (the `subagent` tool). It is the
  same model, on **low reasoning**, with the project tools, and it works on the same draft. It cannot talk to the
  person, propose changes or ask a question, and it cannot start another subagent. The person sees its steps, not its
  words. It gets 12 model answers and 4 minutes; if it cannot finish, the helper is told why and carries on. Reasoning
  pieces that a reasoning model sends are kept and sent back with the tool calls they belong to.
* **Context compactor.** One answer's conversation is kept within the model's room: **1M tokens** for the Claude 5
  models, **256K** for the rest, or less if OpenRouter reports less for the model in use. `AI_CONTEXT_TOKENS` in
  `ai.env` sets the room by hand. Past 75% of the room for the prompt, the oldest tool results are shortened first
  (the draft and the project still hold what they said). If that is not enough, the model writes notes on the oldest
  steps, and the answer goes on from them; the person is told "Making room". If the notes cannot be written, the
  older steps are removed and the helper says so. The newest quarter of the room is never touched.
* **Propose changes.** Nothing changes until someone presses Apply. Size is not a reason to refuse a change: a
  file may be up to 2 MB (a big screen is fine), and the files of one change may add up to 8 MB. The project is
  read a page at a time, so its total size alone does not stop the helper.
* **`/goal`** works toward a goal in several steps. It shows a plan that ticks off as it goes, a timer
  and a Stop button. It stops after 40 steps or 20 minutes, unless full-app mode is on. Closing the window
  stops the goal.
* **`/plan <idea>`** plans a change and says what it would do. It can read and check the project, look
  things up and ask questions, but it cannot change anything or propose a change, even if the model tries.
* **`/check [focus]`**, **`/explain [focus]`** and **`/fix <problem>`** ask the model to check the project,
  explain it, or make the smallest change that fixes one problem. You see the command; the model gets the question.
* **`/discard`** throws away an unfinished full app. **`/new`** (also `/clear`) starts a new conversation.
  **`/help`** lists the commands. `/effort low|medium|high` sets the effort, like the slider.
* **Effort** (the slider under the box, remembered on this computer): how hard the helper works. Low makes
  the change and checks it once; High reads the parts it touches, checks after each change and reviews the
  whole result before it proposes. It changes how much the helper checks, not the model's own reasoning,
  because reasoning counts against the length of an answer.
* **A step that keeps repeating** (the same tool calls, eight times in a row) stops the helper, and says so.

**Small mode (the default).** Small fixes and additions: up to 3 existing screen or blocks files, none
more than half again as big, and no new screens. It declines to build a whole app.

**Full-app mode.** Type `/override` and the PIN in the helper's box. For one hour, in this project and
for the person who entered the PIN, the helper may build a complete small app: up to 12 files in one
change, including up to 4 new screens (each a designer file and a blocks file). It may also rewrite the
project's existing screens, so for a new app start from an empty project. `/override` alone shows
whether the mode is on, and `/override off` ends it early. Restarting the hub also ends it. Full-app mode
has no step or time limit: the helper goes on until the app is complete, or until you press Stop.

The app can be built over as many messages as it takes: the helper keeps the unfinished app between them,
for an hour after the last message. **Apply appears only once the whole app is built and `check_project`
reports no problems** (problems the project already had do not count). If the helper stops with the app
unfinished, it is asked to carry on, up to three times in a row; if it still stops, the window says
"Still building" and what is left to do. A proposal that is not complete is refused. If someone else changes a file the helper is
working on, the helper's change to that file is dropped, and the helper says so. `/override off` throws
away the unfinished app.

**Pictures and the model.** Looking at pictures needs a model that accepts image input. The helper asks
OpenRouter's list of models whether the configured one does, and remembers the answer for six hours.
To set it by hand, add `AI_VISION=1` (or `AI_VISION=0`) to `/opt/appinventor/ai.env`.

**In the window:** Enter sends, Shift+Enter starts a new line, Esc or the square button stops, `/`
lists the commands, Copy works on answers and code blocks, and Try again redoes the last question.
An answer is worked out on the Pi, not in your browser. If your connection drops, or you reload the
window, the answer carries on, and the window reconnects by itself (or picks it up again after a reload)
without losing or repeating anything. **Stop** stops it. If nobody has the window open for three minutes, the
answer is stopped. While the helper is quiet for a long time (the model is thinking, or writing something
big), the window says "Still working…", and a long tool call shows how much has been written.

If the model service stops sending an answer for a minute, the helper tries again, up to three tries in all;
it does the same when the service ends an answer early, or is busy or unreachable for a moment. The window
says so and takes back what the failed try had shown. After that it gives up and says so, so the window never
stays busy for good (`AI_IDLE_MS` in `ai.env` changes the minute). No single model answer may run longer than
ten minutes. If the model runs out of room (`AI_MAX_TOKENS`, 8000 by default), the answer is never shown cut
short: a half-written tool call is skipped, and the helper is asked to carry on in smaller pieces. Only if that
happens four times in a row does the helper pause and ask to be told to carry on.

To see what the helper did when something goes wrong, run
`sudo journalctl -u collab-hub --since "1 hour ago" | grep "\[ai\]"`. It lists who asked, retries, stops and
how each answer ended, but never the questions, the answers or the keys.

**Not included:** running the app or the emulator, seeing how a screen looks, arbitrary web pages (only
the documentation sites above), changing anything outside the open project, the server's settings or
other projects, and files other than screens and PNG or JPG pictures. The helper checks structure and
names, not whether the blocks do what you intended; App Inventor still reports block errors when it opens.

Set it up on the Pi:
* `sudo /opt/appinventor/set-ai.sh` asks for the OpenRouter key and the model name.
* `sudo /opt/appinventor/set-ai.sh --pin` asks for the full-app PIN (typing is hidden). Anyone in the Team
  panel can change it too: **Change override PIN…** asks for the current PIN, then the new one (or makes one
  up), and the new PIN works at once. Wrong guesses share the lock that `/override` has. **Also turn full-app
  mode off for everyone** ends it for people already in it, for when the old PIN has leaked.
* `sudo /opt/appinventor/set-ai.sh --search` asks for a Brave Search key (free plan is enough). This is
  optional. Get one at https://brave.com/search/api/.
* `--status` shows what is set. `--off` turns the helper off and removes the key, PIN and search key.
* Pictures made here need `librsvg2-bin`; the Pi build installs it. If it is missing:
  `sudo apt install librsvg2-bin`.

Keys and the model are stored in `/opt/appinventor/ai.env`, readable only by root. The PIN is stored in
`/opt/appinventor/overridepin`, readable only by the user App Inventor runs as, which is how the Team panel
can change it without a restart (an older PIN in `ai.env` is used only until one is saved). Both are **not in the source**. They never reach a browser or the model. Questions are limited to 12 a minute
per person and 300 a day for the team (a goal counts as five). Anyone with the team code can use the
helper; the PIN is what unlocks full-app mode.

Privacy and safety: the project's screen files and your questions are sent to OpenRouter's model when
you ask, and so are any pictures you attach or the helper looks at. Web and documentation results are read as data, never as
instructions. The helper cannot open arbitrary pages: documentation is read only from the sites listed
above, over https, and only when they resolve to public addresses, with no redirects followed. Pictures
made here are checked before they are drawn: no scripts, no embedded pages or images, and no links to
other files. Pictures made here can be seen only by the person who made them.

## Speed

The hub reuses its connections to App Inventor, compresses text and TrueType/OpenType fonts (Brotli or
gzip) on the way to the browser, and keeps scripts, fonts, images and styles in memory. A file the hub
keeps is reused for ten minutes (five for the `.nocache.js` stubs); a deploy restarts the hub, which
empties that memory. A returning browser downloads almost nothing. The App Inventor service starts with a
larger Java heap. `/collab/status` shows the cache's hits and misses.

## Limits

* Edits are applied in the order the hub receives them. If two people drag the *same* block or
  change the *same* property at the same instant, the last one wins and the two screens can
  briefly differ. Reopening the project brings everyone back in line.
* Changing project properties is saved, but teammates only see it after reopening the project.
* Undo (Ctrl+Z) only undoes your own block edits.
* If the hub goes down, everyone keeps working and saving on their own, as in normal App
  Inventor. Live sharing resumes when the hub comes back. Close and reopen the project then, so
  everyone starts from the same saved copy.

## Troubleshooting

* `systemctl status appinventor collab-hub cloudflared-quick` on the Pi.
* `http://<pi-address>:8080/collab/status` lists who's online and in which project.
* The Team panel says **offline** when the page was opened on port 8888 instead of the hub's port
  8080, or when the hub isn't running.
* "Sign-in is not set up yet" on the login page: no team code is set. Run
  `sudo /opt/appinventor/set-team-code.sh`.
* No cursor for a teammate: they have to be in the same project, on the same screen and in the same
  editor (Designer or Blocks), with their mouse over the workspace or phone preview, and it can take
  up to 5 seconds to appear. The Team panel shows where each person is.
* Something else answers on `http://<pi-address>:8080` (for example another program that also uses
  port 8080): `/opt/appinventor/show-info.sh` warns about it.
* "Too many wrong team codes": wait the number of seconds shown, then type the code carefully.

## Tests

```
cd collab/server && npm install && npm test
```
