# Changelog

The Team Edition: the collaboration hub and the companion helper in `collab/server`, the Raspberry Pi tooling in
`collab/pi`, and the team changes inside the App Inventor client (`appinventor/appengine`). Newest first. Commit hashes
are on the `claude/amazing-ritchie-68cj4h` branch.

## Unreleased: stability update

A pass over the whole team layer. Each fix below has a test, or is covered by the browser simulation. What is still
known to be wrong is listed at the end of this section.

**After this update, reload every open App Inventor tab once.** The team page's scripts changed, and a tab opened before
the update keeps the old scripts until it is reloaded.

### Fixed

**Security**
- The Pi-only pages (the App Engine admin console at `/_ah/`, and the Google sign-in stand-in at `/login/google`) could be
  reached through the tunnel with a percent-encoded or otherwise re-spelled path, such as `/%5Fah/admin`. The hub now
  checks the path as App Engine will route it, and refuses a path that does not decode.
- MITSTATUS no longer prints the full-app override code. It shows whether the code is set, as it does for the keys
  (`collab/pi/mitstatus.sh`).
- The hub's 502 page no longer shows App Inventor's internal address.

**The hub stopping or hanging** (`collab/server/hub.js`, `rooms.js`, `perf.js`)
- A frame over 4 MB, a frame that breaks the protocol, or a connection reset during sign-in ended the whole hub, and with
  it everyone's live connection. Each connection now fails on its own.
- A message that is the JSON value `null` is ignored rather than logged as an error.
- An App Inventor reply cut off part way through (for example, App Inventor restarting) left sign-in, joins and backups
  waiting for ever, and backups stopped until the hub restarted. Those calls now end as "no answer".
- The hub's own calls to App Inventor (sign-in, project access, backups) have their own connections, so slow downloads
  through the proxy cannot starve them. Each call has a deadline that includes the wait for a connection. Backups get
  five minutes; everything else 30 seconds.
- A proxied request that App Inventor stops answering is given up after two minutes. A browser that leaves a download
  part way ends its request to App Inventor. A reply cut off part way now ends the browser's reply too, instead of
  leaving an endless spinner.
- A reply of unknown length is no longer held whole in memory before it is cached.

**Joins, access and backups** (`hub.js`, `rooms.js`)
- A join overtaken by a later join (App Inventor was slow to check the first project) could put the student in the
  earlier project, and their edits were then dropped. The latest join now wins.
- A failed project-access check (App Inventor did not answer, or answered with an error) was reported as "no access",
  and the page never asked again. The hub tries once more; the page asks again after five seconds. Only App Inventor's
  refusal (403) is reported as no access.
- A backup slower than 30 seconds was never recorded, and was asked for again every minute. Backups now have five
  minutes, and are not asked for again while one is still open. Three failures in a row raise an alert on the admin page.
- A Pi whose App Inventor keeps no backups (`enabled: false`) recorded every change as backed up. Now the hub says so
  on the status page and stops asking until it restarts.
- A backup reported after a restore could mark the restored project as backed up. Each backup now carries the session it
  belongs to, and a report from an earlier session is ignored.

**Restores, freezes and syncs** (`hub.js`, `rooms.js`, `collab-extra.js`, `collab.js`)
- A restore that failed left every other open page frozen for good. The restoring page now tells the hub it failed, and
  the hub unfreezes the others. A restore freeze also ends by itself after a minute if nothing reports it.
- A page that was frozen when its connection dropped stayed frozen after it rejoined. It now unfreezes on rejoining,
  unless a restore or an AI change is still being saved.
- The messages that freeze, unfreeze or reload pages name their project, and a page ignores one for another project.
- A manual sync is refused if the project's pages were reloaded less than 20 seconds before (it used to be possible to
  reload everyone over and over).
- An AI change that could not save in one tab was refused by reloading every tab, which threw away the unsaved edits of
  the tab that could not save. The tabs are now unfrozen without a reload.

**Limits, so one client cannot grow the hub without bound** (`rooms.js`, `perf.js`)
- The edit log of a project is capped at 8 MB, oldest edits first. (It used to keep every edit of the last ten minutes,
  and every joining page was sent all of them.)
- Presence names are cut to 100 characters, and the editor name to 20. (A 2 MB screen name was sent to everyone.)
- A client keeps fingerprints of at most 16 screens.
- The static-file cache holds at most 2,000 files, as well as its byte cap. Each file is compressed once for each
  encoding, even when requests arrive together, and the bytes are counted once.
- Each relayed message is turned into text once, not once per person who receives it.

**The companion helper's back end** (`collab/server/ai.js`, `ai-project.js`, `ai-registry.js`)
- Two Applies of changes to one project at the same time could overwrite each other, and both were reported as applied.
  One change now goes in at a time per project; the second is told to try again (409).
- A small change to a designer or blocks file that does not read at all (broken XML, for example) is refused, and the
  problem is named. It used to be applied, and App Inventor could not read the file afterwards.
- `bky_add_event_handler` dropped every statement after a statement written as a self-closing block, and still reported
  success. Those statements are kept now.
- A screen could be renamed through its own name, which changed the name inside its designer file. Refused now.
- The regular-expression search allows at most two of `*`, `+` and `{`, tests each long line in windows, and stops after
  1.5 seconds. Several wildcards in a row used to take minutes on a designer file's long lines.
- A blocks file with a comment or processing instruction that is never closed took time that grew with the square of its
  size, and blocked the hub while it did. It is refused at once.
- A question with a character split between two pieces of the request (common with accents and emoji) reached the model
  with garbled characters. The request is now read as bytes and decoded once.
- A model call that failed was left open on the connection to the service. It is closed now.
- An answer whose browser left while the access check was running was never stopped, because nothing was watching it.
  It stops after the usual time now.
- Full-app answers stop after 200 model calls, and a subagent after 40 steps, each with a message. They had no limit,
  and each step is a paid call.
- Drafts, proposals, pictures and scratch notes of people who have left are dropped every ten minutes, not only when
  someone else uses the same feature.
- `AI_DAILY_LIMIT` set to something that is not a whole number switched the limit off. It now keeps the default, 300.

**The companion page** (`collab/server/public/ai/app.js`)
- The model, service and effort picks were undone after each answer, and every 30 seconds, when the server's lists were
  read again. The pick now stays.
- "Try again" on an earlier answer asked the newest question again and garbled the conversation. It works on the newest
  question only.
- A gateway or server error while an answer was being resumed was shown as the helper's final failure, while the answer
  was still being written. Only client errors are final now.
- "Copied" was shown even when the browser refused the copy. A refused copy says so.
- When browser storage is full, the conversation is kept in a shorter copy, and the person is told once if even that
  does not fit.
- Picture previews are released when a conversation is cleared.
- A status request that failed because the team server was briefly unavailable said "Sign in to App Inventor first".
  Only a 401 says that now, and the status is asked for again.

**The team page** (`appinventor/appengine/war/static/js/collab.js`, `collab-extra.js`)
- Join-time chat, recent activity, block locks and selections were never read: a second `case 'joined'` in the same
  switch could never run. It is merged into the first, and only for the project the page wants.
- A follower whose connection dropped for a few seconds took over as the main client at once, and saved its stale copy
  over the leader's changes. Taking over now waits thirty seconds, and is cancelled when the page rejoins.
- A socket that never opened (the server accepted the connection, but not the upgrade) was never replaced. It is given
  up after fifteen seconds.
- Reconnects wait a random part of their delay too, so the pages do not all knock at once after a hub restart. The
  count of failures is cleared only after a connection has lasted ten seconds.
- A chat message is cleared from the box only once it has been sent. If the connection is down, it stays there, and the
  person is told.
- "Back up now" said the project had not changed when the backup request had failed. It says the backup failed.
- The access check that the hub retries is also retried by the page, as above.

**The App Inventor client and server** (Java, `appinventor/appengine/src`)
- An editor whose file was not saved because a teammate's client is the main one was dropped from the save list, so
  its edits were lost. It stays dirty now, and is saved when this client becomes main (`EditorManager`).
- An AI change's request body was read as ISO-8859-1, so accented and other non-ASCII text was saved garbled. It is read
  as UTF-8 now (`CollabServlet`).
- One failed read of the team-code file switched sign-in off for everyone until the file changed, and one failed read of
  the sign-out file missed a sign-out in the same way. The file's stamp is now recorded only after a good read, and a
  failed read keeps the code in use (`TeamLogin`).

**The Raspberry Pi tooling** (`collab/pi`)
- `install.sh` wrote the new version number before the build. If the build was interrupted, the status reported the new
  version while the old code ran. The version is written once the new code is in place (`build-on-pi.sh`).
- The nightly update printed the team code into its log. It no longer does; MITSTATUS shows it.
- The rollback point was replaced before the fast-forward of the checkout, so a refused merge lost the version to go
  back to. It is saved once the merge has gone through.
- The update's health wait counted its stability wait toward its limit only sometimes, and could run for hours. It now
  runs to a clock deadline.
- A rollback whose copies failed was reported as "the previous version is running again". It is reported as a partial
  restore, and the team is told App Inventor may be down.
- The fetch from GitHub gives up on a stalled connection rather than holding the update lock for ever.
- Downloads (the JDK, the Google Cloud SDK, cloudflared) retry and time out, and remove their temporary folders when
  they fail.
- The build's 2 GB swap file is removed even if the build stops part way, and any file left by an earlier stopped build
  is removed first. Such a file kept 2 GB off the card, which blocked later updates.
- `move-data.sh --undo` restarts App Inventor even if the copy fails, and checks the copy before it replaces the link to
  the drive.
- `stable-link.sh --off` reports the link still on, and keeps its record, if Tailscale did not turn Funnel off.
- `deploy-from-pc.sh` installs MITSTATUS, as the update does, so a deployed change to the menu reaches the Pi.

### Changed
- Manual syncs are refused for twenty seconds after the pages of a project were reloaded.
- Full-app answers stop at 200 model calls; subagents at 40 steps.
- Backups are allowed five minutes on the App Inventor side (they were thirty seconds).
- A follower that loses its connection saves its own work after thirty seconds offline, not at once.
- Reconnects wait a random part of their delay.
- The hub's health-check interval (`HEALTH_MS`) and its backup timeout (`BACKUP_TIMEOUT_MS`) can be set by
  environment variables; the tests use them. The defaults are unchanged.

### Tests
- `collab/server`: `node --test test/*.test.js` runs 342 tests (297 before the first pass). They include the hub over real
  WebSockets against a stand-in for App Inventor (including cut-off replies, stalled requests, a frame over the limit, a
  reset during sign-in, a failed restore), the room logic, the cache, the companion (`ai*.test.js`), the companion page
  (`client-reset.test.js`), the team page's join and freeze handling in a VM (`collab-extra.test.js`), and the browser
  simulation of two or three people editing (`page-sync.test.js`, which runs in headless Chromium).
- Run against the code from before this update, the new hub, room and cache tests fail, except the proxied cut-off reply,
  which fails only when it is run alone (in the full run, a connection left in the pool from an earlier test hides it).
- `collab/pi/test/mitstatus-test.sh` and `collab/pi/test/update-test.sh` (as root) pass. The update test now covers a
  refused fast-forward (the saved version to go back to is kept) and a restore whose copy fails (reported as such).
- The App Inventor Java changes (`EditorManager`, `CollabServlet`, `TeamLogin`) compile against the built libraries.
  The full client build (GWT) was not run for this change, and the Java has no tests in this repository.

### Second pass (same release)

These were open in the first pass, and are fixed now.

- **Files:** a Cloud Storage object that is missing now fails the read (it used to read as empty, and a save could write
  the empty file over the real one). A read that finds the object shorter or longer than it was when it started fails
  too; the loop that could run for ever is gone (`ObjectifyStorageIo`).
- **Saves and AI changes:** a page whose save fails tells the hub, and the change is refused (the tabs are unfrozen). It
  used to be told the save worked (`EditorManager`, `Collab`, `collab-extra.js`).
- **Team code:** the sign-out marker is written before the new code is saved, so a failed marker leaves the old code in
  place (`CollabServlet`).
- **Backups:** a project too big to back up is reported as not backed up (the hub alerts after three tries). A restore
  goes ahead only with a copy of the project as it is now. AI changes still go ahead on a big project, without a copy,
  and the failure is logged.
- **Per project:** AI writes, picture writes and restores of one project take turns (`CollabServlet`).
- **Apply:** when App Inventor's reply is lost or a write stops part way, the project is read back. A change that is
  all there is applied; a part is reported as only partly made, with the files named.
- **Renames in small mode:** the designer and blocks files are checked together, so a limit on the second file leaves
  the first unchanged (`ai-registry`).
- **Companion page:** a question the server did not take goes back in the box, with its pictures. A server that does
  not start its answer within the silence limit is given up on, and the question goes back in the box.
- **Day count:** the team's day count is kept in `ai-daily.json` in the data folder, so a restart of the hub does not
  give a new day.
- **Edits:** one person may send 400 edits at once, then 100 a second. Edits past that are not shared, and the person is
  told (`rooms.js`).
- **Pi:** install and deploy wait for an update that is running (they refuse, and say so). A request made by hand while
  an update runs exits with code 75. The rollback point keeps the hub's packages and the menu (MITSTATUS) too.

### Known issues, not fixed in this update
These were found while reviewing, and are not fixed here. Some need a design decision.

*Team page and the App Inventor client*
- A teammate's designer change that fails to apply on the main client is acknowledged, and lost at the next save of that
  screen.
- A large `.bky` that shrinks is not guarded against a save that empties it.
- A restore writes files one at a time, with no rollback, and an AI change to two screens can be left half applied.
- Restores are not limited: a member who repeats the restore message reloads everyone each time.

*The companion helper*
- A Send or Apply whose response never starts has a timeout for Send only. Apply still waits until Stop or reload.
- A reload drops the Apply card of a finished answer, and an answer still being written after a reload.
- The model's daily limit counts a whole answer, including its subagents, as one question. Each answer has its own cap.
- Streamed answers are rendered again on every frame, which slows down long answers.

*The hub*
- A restart of the hub resets the write count, so the pages' kept edits are dropped (they are told).
- Operations are not acknowledged, so an edit in flight when a connection drops is not known to have arrived.
- A stalled App Inventor request still holds one connection for up to two minutes.

*The Raspberry Pi*
- A systemd restart loop has no limit (a start limit would also stop a fault that clears by itself; this needs a decision).
- Stale GWT output accumulates on the card with each build.
- MITSTATUS's restart options do not wait for an update that is running.

## Earlier history (2026-10-06 to 2026-10-14)

The Team Edition's first 48 commits, newest day first. Short hashes are on `claude/amazing-ritchie-68cj4h`.

### 2026-10-14

- Pages kept in step: repairs keep block ids, and edits made while a page is offline are kept and sent on rejoin (89e70ef).

### 2026-10-13

- MITSTATUS shows the update's progress and time left, and can go back to the previous version (2875aef).
- Manual sync brings every open page of a project up to date (ea4b66a).
- The companion's service, model and effort controls and the Smart preset restored after the earlier trim (fabd525).
- OpenCode Go errors fixed, Apply checks its change, and run modes, the smart subagent and the companion clutter removed (bce6ddd).

### 2026-10-12

- MITSTATUS changes the OpenCode Go key and models, whichever service is in use (19aaa73).
- OpenCode Go gated behind `/beta`, with a Smart button (ffcfd77).
- The companion picks its service, and OpenCode Go models accept pictures (54d8a18); OpenCode Go added as a provider (2b1f816).
- The model in use is shown when a preset's model changes (574ecd9); Change API key added to MITSTATUS (4ee7647).

### 2026-10-11

- The nightly update and Update install the checkout when the installed copy is older (163ab5a).

### 2026-10-10

- MITSTATUS added, with the link, the codes, the AI models and a menu to change them (06c0265); it shows the permanent address or suggests Cloudflare (5519a2d, 28b7127); Update in MITSTATUS (549727a); older hubs still show the AI models (3b01d37).
- Cloudflare permanent-address steps: domain setup, headless login, start on boot, checks (6c230f2).
- Model presets, run modes, reasoning settings and subagent modes added to the companion (a1e3262), with later fixes to retries, tool-call steps and failed answers (d4fb670, f70fff2, 32ce855, 08d3079).
- `node_modules` no longer committed; karma's dependencies installed in CI (ea37eaf).

### 2026-10-08

- Companion: stops freezing; proposes a full app only once it is complete (ca2fdf4); keeps answering when the connection drops (ba43b69); carries on in smaller pieces when an answer is cut off (8f23899); effort slider and more commands (7a87fc5).
- Context compactor: 1M-token room for the newer Claude models, 256K for the rest (ec0a716).
- Helper checks what its blocks mean, stores values the App Inventor way, and compacts long answers (28b4c7d).
- Normal projects no longer refused for their size; the App Inventor tab reloads after Apply (f4fd8dc).
- Team panel changes the override PIN, the way it changes the team code (80bd5d1).
- README for the Team Edition; the MIT README moved to `README-MIT.md` (94ab296).

### 2026-10-07

- Teammate cursors, live team-code changes, project backups with restore, the 30-second syncer, follow, locks, chat, the admin page, alerts, kick, and live screens and media (d3bcf53, 761a17e, 7f8c3c6).
- Optimised client build so App Inventor loads on phones (c1b4f60); rebuilt when the GWT flags change (2faf31d).
- Full-app mode in the AI helper, unlocked with a PIN set on the Pi (da61620).
- Nightly 3 AM updater that builds first and restores the old version if the build fails (4a9037c).
- AI helper rebuilt as a streaming chat with tools, pictures and `/goal` (ecb17a5, a0b9bb0).
- Faster delivery of App Inventor files from the hub (4da8c18); the Pi reports the right version after an update (6ce040d).

### 2026-10-06

- Real-time collaboration for 2–3 people, with sign-in by a name and a shared team code (82abc5a, 6fded5d).
- One-command install that builds App Inventor on the Pi (8e32957).
