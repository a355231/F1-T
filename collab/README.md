# App Inventor with real-time collaboration

This repository is MIT App Inventor 2 with one addition: two or three people can work on the same
project at the same time from their own computers. Everyone uses the normal App Inventor
interface, with the same menus as MIT's site. The additions are a small **Team** panel in the
bottom-left corner and a **Share this project…** link inside it.

## What is shared live

| | Live for teammates? |
|---|---|
| Blocks (add, move, delete, edit fields, collapse, disable, comments, variables) | Yes |
| Designer: add, move, delete, rename components, change any property | Yes |
| Which screen and editor each person is in, who is testing on a companion | Yes (Team panel) |
| Each person's companion (phone or iPad) | No, see below |
| New screens, uploaded media, project properties dialogs | Saved to the server; teammates see them after reopening the project |

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
  sends your block and designer edits, applies teammates' edits, and draws the Team panel.
* `appinventor/appengine/src/com/google/appinventor/client/collab/Collab.java` connects the
  designer to that script and stops non-main clients from saving.
* `appinventor/appengine/src/com/google/appinventor/server/CollabServlet.java` holds the endpoints
  for "who am I", "may I open this project", and "share this project". Shared projects appear in
  each teammate's own **My Projects**.
* `appinventor/appengine/src/com/google/appinventor/server/TeamLogin.java` is the sign-in: a name
  plus the team code (see below).

## Raspberry Pi setup

You need a Raspberry Pi 4 or 5 with 4 GB of RAM or more, running 64-bit Raspberry Pi OS, plus a PC
(Windows with WSL, macOS, or Linux) with Java 11 JDK and ant 1.10 for building.

1. On the Pi, from a copy of this repository:

   ```
   sudo collab/pi/install.sh
   ```

   This installs Java, Node.js, the App Engine dev server and `cloudflared`, and sets up three
   services: `appinventor`, `collab-hub` and `cloudflared-quick`. It also asks for a **team code**
   (press Enter to have one made up for you; it is shown once). The code is stored in
   `/opt/appinventor/teamcode`, readable only by the Pi's user.

2. On the PC, build and copy everything to the Pi. The App Inventor build is too heavy for the
   Pi, so it runs on the PC:

   ```
   collab/pi/deploy-from-pc.sh pi@<pi-address>
   ```

   Run this again whenever you change the code. Saved projects on the Pi are kept, and every
   deploy re-applies the Pi's team code, which never leaves the Pi and is never printed.

3. Addresses:
   * On the LAN: `http://<pi-address>:8080`
   * From the internet: run `/opt/appinventor/tunnel-url.sh` on the Pi. It prints a
     `https://….trycloudflare.com` address. Cloudflare's free quick tunnel picks a new address
     every time the tunnel restarts, such as after a reboot. For a permanent address, set up a
     free named tunnel with a Cloudflare account and point it at `http://127.0.0.1:8080`.

### First start: signing in

There are no accounts to create and no passwords. Everyone signs in with **their name** and the
**team code**.

1. Pick the team code during `install.sh`, or change it any time on the Pi:

   ```
   sudo /opt/appinventor/set-team-code.sh            # type a code (8+ characters)
   sudo /opt/appinventor/set-team-code.sh --random   # or have one made up and shown once
   ```

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
* if it leaks, or someone leaves the team, run `set-team-code.sh`. That changes the code **and
  signs everyone out**, and the old code stops working at once;
* after a few wrong codes from one address, App Inventor makes that address wait (5 seconds,
  then 10, 20, … up to 5 minutes) before it may try again.

The App Engine dev server's own pages (`/_ah/…`, including its test sign-in at
`/login/google`) only work in a browser on the Pi itself. The hub blocks them for everyone on the
LAN or the internet.

### Working together

1. One person creates or opens a project, opens the Team panel (bottom-left), and chooses
   **Share this project…**. Enter the name a teammate signs in with. The project appears in their
   **My Projects** after they reload App Inventor. Sharing with a name nobody has used yet is
   fine: the project is waiting when someone first signs in with that name.
2. Everyone opens the project. The Team panel lists everyone by the name they signed in with,
   which project, screen and editor each is in, who is main, and who is testing on a companion.
3. Build edits in the blocks or designer appear for everyone within a fraction of a second.

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
* "Too many wrong team codes": wait the number of seconds shown, then type the code carefully.

## Tests

```
cd collab/server && npm install && npm test
```
