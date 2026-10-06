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
  each teammate's own **My Projects**, and each person keeps their own login.

## Raspberry Pi setup

You need a Raspberry Pi 4 or 5 with 4 GB of RAM or more, running 64-bit Raspberry Pi OS, plus a PC
(Windows with WSL, macOS, or Linux) with Java 11 JDK and ant 1.10 for building.

1. On the Pi, from a copy of this repository:

   ```
   sudo collab/pi/install.sh
   ```

   This installs Java, Node.js, the App Engine dev server and `cloudflared`, and sets up three
   services: `appinventor`, `collab-hub` and `cloudflared-quick`.

2. On the PC, build and copy everything to the Pi. The App Inventor build is too heavy for the
   Pi, so it runs on the PC:

   ```
   collab/pi/deploy-from-pc.sh pi@<pi-address>
   ```

   Run this again whenever you change the code. Saved projects on the Pi are kept.

3. Addresses:
   * On the LAN: `http://<pi-address>:8080`
   * From the internet: run `/opt/appinventor/tunnel-url.sh` on the Pi. It prints a
     `https://….trycloudflare.com` address. Cloudflare's free quick tunnel picks a new address
     every time the tunnel restarts, such as after a reboot. For a permanent address, set up a
     free named tunnel with a Cloudflare account and point it at `http://127.0.0.1:8080`.

### First start: creating the team's accounts

Each person logs in with an email and a password. App Inventor stores these on the Pi; no email
is ever sent.

1. On the Pi itself, open `http://localhost:8080` in its browser, or from the PC run
   `ssh -L 8080:localhost:8080 pi@<pi-address>` and open `http://localhost:8080` on the PC.
2. Choose the Google sign-in link on the login page. The dev server shows a test sign-in form:
   enter your email, tick **Sign in as Administrator**, and sign in. For safety, this test sign-in
   only works on the Pi itself. The hub blocks it, and the dev server's `/_ah/` admin pages, for
   LAN and internet visitors.
3. Open **Admin › User Admin** and add an account (email and password) for each person, including
   yourself.
4. Everyone, you included, now logs in on the normal login page with that email and password.

### Working together

1. One person creates or opens a project, opens the Team panel (bottom-left), and chooses
   **Share this project…**. Enter a teammate's login email. The project appears in their
   **My Projects** after they reload App Inventor.
2. Everyone opens the project. The Team panel lists everyone, which project, screen and editor
   each is in, who is main, and who is testing on a companion.
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

## Tests

```
cd collab/server && npm install && npm test
```
