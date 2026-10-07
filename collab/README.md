# App Inventor with real-time collaboration

This repository is MIT App Inventor 2 with one addition: two or three people can work on the same
project at the same time from their own computers. Everyone uses the normal App Inventor
interface, with the same menus as MIT's site. The additions are a small **Team** panel in the
bottom-left corner (with **Share this project…** and **Change team code…** links), and a coloured
mouse cursor with a name for each teammate who is working in the same project.

## What is shared live

| | Live for teammates? |
|---|---|
| Blocks (add, move, delete, edit fields, collapse, disable, comments, variables) | Yes |
| Designer: add, move, delete, rename components, change any property | Yes |
| Which screen and editor each person is in, who is testing on a companion | Yes (Team panel) |
| Where each teammate's mouse is, with their name | Yes, every 5 seconds (see below) |
| Each person's companion (phone or iPad) | No, see below |
| New screens, uploaded media, project properties dialogs | Saved to the server; teammates see them after reopening the project |

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
window. Your own edits reach your companion right away, as usual. Teammates' edits do **not**
reach your companion while you are testing. The Team panel shows "N waiting". To load them, use
**Connect › Reset Connection** and connect again. They are also loaded when you switch screens or
make a designer change of your own, because the companion then reloads the whole screen.

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
x86-only. Run it on one of the PCs (`cd appinventor/buildserver && ant RunLocalBuildServer`), then
on the Pi set `build.server.host` in `/opt/appinventor/war/WEB-INF/appengine-web.xml` to
`<pc-address>:9990` and restart: `sudo systemctl restart appinventor`.

## Limits

* Edits are applied in the order the hub receives them. If two people drag the *same* block or
  change the *same* property at the same instant, the last one wins and the two screens can
  briefly differ. Reopening the project brings everyone back in line.
* Adding or removing a screen, uploading media, and changing project properties are saved, but
  teammates only see them after reopening the project. The Team panel says when a teammate is
  editing a screen you don't have yet.
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
