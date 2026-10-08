// -*- mode: java; c-basic-offset: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

package com.google.appinventor.server;

import com.google.appinventor.server.storage.StorageIo;
import com.google.appinventor.server.storage.StorageIoInstanceHolder;
import com.google.appinventor.shared.rpc.user.User;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;

import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Endpoints used by the real-time collaboration hub (collab/server) and the collaboration panel.
 *
 * <pre>
 *   GET  /ode/collab/whoami
 *   GET  /ode/collab/access?projectId=N
 *   GET  /ode/collab/collaborators?projectId=N
 *   POST /ode/collab/share?projectId=N&amp;name=TEAM_NAME
 *   POST /ode/collab/teamcode  current=CODE&amp;new=CODE[&amp;signout=true]
 *   POST /ode/collab/backup?projectId=N        (no-op if unchanged since the newest backup)
 *   GET  /ode/collab/backups?projectId=N
 *   POST /ode/collab/restore?projectId=N&amp;id=BACKUP_ID
 *   GET  /ode/collab/files?projectId=N, /file?projectId=N&path=P   (read a project's source)
 *   POST /ode/collab/writefiles?projectId=N     (a few small .scm/.bky changes; backup first)
 *   POST /ode/collab/kick?name=NAME            (signs that person out; the hub drops them)
 *   GET  /ode/collab/lastcodechange   (lets the hub check an announcement of a change)
 * </pre>
 */
public class CollabServlet extends OdeServlet {
  private static final Logger LOG = Logger.getLogger(CollabServlet.class.getName());

  private final transient StorageIo storageIo = StorageIoInstanceHolder.getInstance();
  private final transient BackupStore backups = new BackupStore(storageIo);

  @Override
  protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
    handle(req, resp, false);
  }

  @Override
  protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
    handle(req, resp, true);
  }

  private void handle(HttpServletRequest req, HttpServletResponse resp, boolean post)
      throws IOException {
    resp.setContentType("application/json; charset=utf-8");
    resp.setHeader("Cache-Control", "no-store");
    String userId = userInfoProvider.getUserId();
    if (userId == null) {
      send(resp, HttpServletResponse.SC_UNAUTHORIZED, error("not logged in"));
      return;
    }
    String path = req.getPathInfo() == null ? "" : req.getPathInfo();
    try {
      switch (path) {
        case "/whoami":
          send(resp, 200, new JSONObject()
              .put("userId", userId)
              .put("email", userInfoProvider.getUserEmail()));
          return;
        case "/access": {
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          String ownerId = storageIo.getProjectUserId(projectId);
          User owner = ownerId == null ? null : storageIo.getUser(ownerId);
          send(resp, 200, new JSONObject()
              .put("ok", true)
              .put("projectId", projectId)
              .put("projectName", storageIo.getProjectName(userId, projectId))
              .put("ownerEmail", owner == null ? "" : owner.getUserEmail()));
          return;
        }
        case "/collaborators": {
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          JSONArray emails = new JSONArray();
          for (String id : storageIo.getProjectCollaborators(projectId)) {
            emails.put(storageIo.getUser(id).getUserEmail());
          }
          send(resp, 200, new JSONObject().put("collaborators", emails));
          return;
        }
        case "/share": {
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          String name = TeamLogin.normalizeName(req.getParameter("name"));
          if (name == null) {
            send(resp, HttpServletResponse.SC_BAD_REQUEST,
                error("a team name is 1 to 30 letters, digits, - and ."));
            return;
          }
          User target = storageIo.getUserFromEmail(TeamLogin.emailFor(name));
          storageIo.addProjectCollaborator(target.getUserId(), projectId);
          send(resp, 200, new JSONObject().put("ok", true).put("name", name));
          return;
        }
        case "/kick": {
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          String name = TeamLogin.normalizeName(req.getParameter("name"));
          if (name == null) {
            send(resp, HttpServletResponse.SC_BAD_REQUEST, error("bad name"));
            return;
          }
          User target = storageIo.getUserFromEmail(TeamLogin.emailFor(name));
          if (target.getUserId().equals(userId)) {
            send(resp, HttpServletResponse.SC_BAD_REQUEST, error("you cannot kick yourself"));
            return;
          }
          TeamLogin.signOutUser(target.getUserId());
          LOG.info(userInfoProvider.getUserEmail() + " signed " + name + " out");
          send(resp, 200, new JSONObject().put("ok", true).put("userId", target.getUserId()));
          return;
        }
        case "/lastcodechange": {
          Object[] last = TeamLogin.lastChange();
          send(resp, 200, new JSONObject().put("at", last[0]).put("by", last[1])
              .put("signedOut", last[2]));
          return;
        }
        case "/backup": {
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          String id = backups.backup(userId, projectId, System.currentTimeMillis());
          send(resp, 200, new JSONObject().put("ok", true).put("enabled", BackupStore.enabled())
              .put("id", id == null ? JSONObject.NULL : id));
          return;
        }
        case "/backups": {
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          JSONArray list = new JSONArray();
          for (String id : backups.ids(projectId)) {
            list.put(new JSONObject().put("id", id).put("at", BackupStore.timeOf(id)));
          }
          send(resp, 200, new JSONObject().put("ok", true).put("enabled", BackupStore.enabled())
              .put("backups", list));
          return;
        }
        case "/restore": {
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          String id = req.getParameter("id");
          if (!BackupStore.validId(id)) {
            send(resp, HttpServletResponse.SC_BAD_REQUEST, error("bad backup id"));
            return;
          }
          backups.backup(userId, projectId, System.currentTimeMillis());  // safety copy first
          int n = backups.restore(userId, projectId, id);
          LOG.info("Project " + projectId + " restored to backup " + id);
          send(resp, 200, new JSONObject().put("ok", true).put("files", n));
          return;
        }
        case "/files": {
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          JSONArray list = new JSONArray();
          for (String f : storageIo.getProjectSourceFiles(userId, projectId)) {
            byte[] content = storageIo.downloadRawFile(userId, projectId, f);
            list.put(new JSONObject().put("path", f).put("bytes", content == null ? 0 : content.length));
          }
          send(resp, 200, new JSONObject().put("ok", true).put("files", list));
          return;
        }
        case "/file": {
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          String file = req.getParameter("path");
          if (file == null || !storageIo.getProjectSourceFiles(userId, projectId).contains(file)) {
            send(resp, HttpServletResponse.SC_NOT_FOUND, error("no such file"));
            return;
          }
          byte[] content = storageIo.downloadRawFile(userId, projectId, file);
          boolean text = file.endsWith(".scm") || file.endsWith(".bky") || file.endsWith(".properties")
              || file.endsWith(".json") || file.endsWith(".txt") || file.endsWith(".csv");
          send(resp, 200, new JSONObject().put("ok", true).put("path", file)
              .put("bytes", content.length)
              .put("text", text ? new String(content, java.nio.charset.StandardCharsets.UTF_8)
                  : JSONObject.NULL));
          return;
        }
        case "/writefiles": {
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          writeFiles(userId, projectId, req, resp);
          return;
        }
        case "/bundle": {
          // Every designer, blocks and properties file of the project, for the AI helper. A big project does not
          // fit in one reply, so the files come a page at a time: a page holds up to MAX_BUNDLE_BYTES, and "next"
          // is the name to pass as "after" to get the next page (null when there are no more).
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          List<String> names = new ArrayList<>();
          for (String f : storageIo.getProjectSourceFiles(userId, projectId)) {
            if (f.endsWith(".scm") || f.endsWith(".bky") || f.endsWith("project.properties")) {
              names.add(f);
            }
          }
          Collections.sort(names);
          String after = req.getParameter("after");
          JSONObject out = new JSONObject();
          int total = 0;
          String last = null;
          String next = null;
          for (String f : names) {
            if (after != null && f.compareTo(after) <= 0) {
              continue;
            }
            byte[] content = storageIo.downloadRawFile(userId, projectId, f);
            if (content == null) {
              continue;
            }
            if (total > 0 && total + content.length > MAX_BUNDLE_BYTES) {
              next = last;   // this file begins the next page
              break;
            }
            total += content.length;
            out.put(f, new String(content, StandardCharsets.UTF_8));
            last = f;
          }
          send(resp, 200, new JSONObject().put("ok", true).put("files", out)
              .put("next", next == null ? JSONObject.NULL : next));
          return;
        }
        case "/rawfile": {
          // One picture of the project (assets/*.png, *.jpg, *.gif), base64, for the AI helper to look at.
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          String file = req.getParameter("path");
          if (file == null || !PICTURE_ASSET.matcher(file).matches()) {
            send(resp, HttpServletResponse.SC_BAD_REQUEST, error("only pictures in assets/ can be read"));
            return;
          }
          if (!storageIo.getProjectSourceFiles(userId, projectId).contains(file)) {
            send(resp, HttpServletResponse.SC_NOT_FOUND, error("no such picture"));
            return;
          }
          byte[] content = storageIo.downloadRawFile(userId, projectId, file);
          if (content == null || content.length > MAX_RAW_BYTES) {
            send(resp, HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, error("that picture is too big to view"));
            return;
          }
          String lower = file.toLowerCase(java.util.Locale.ROOT);
          String mime = lower.endsWith(".gif") ? "image/gif" : (lower.endsWith(".png") ? "image/png" : "image/jpeg");
          send(resp, 200, new JSONObject().put("ok", true).put("path", file).put("mime", mime)
              .put("bytes", content.length).put("data", java.util.Base64.getEncoder().encodeToString(content)));
          return;
        }
        case "/writemedia": {
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          long projectId = projectId(req);
          storageIo.assertUserHasProject(userId, projectId);
          writeMedia(userId, projectId, req, resp);
          return;
        }
        case "/teamcode":
          if (!post) {
            send(resp, HttpServletResponse.SC_METHOD_NOT_ALLOWED, error("use POST"));
            return;
          }
          changeTeamCode(req, resp);
          return;
        default:
          send(resp, HttpServletResponse.SC_NOT_FOUND, error("unknown endpoint"));
      }
    } catch (NumberFormatException e) {
      send(resp, HttpServletResponse.SC_BAD_REQUEST, error("bad projectId"));
    } catch (SecurityException e) {
      send(resp, HttpServletResponse.SC_FORBIDDEN, error("no access to project"));
    } catch (IOException e) {
      LOG.log(Level.WARNING, "collab backup failed: " + path, e);
      send(resp, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, error("backup failed"));
    } catch (RuntimeException e) {
      LOG.log(Level.WARNING, "collab request failed: " + path, e);
      send(resp, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, error("server error"));
    }
  }

  /**
   * Changes the team code while App Inventor is running; the next sign-in must use the new code.
   * The current code has to be given again, and wrong guesses are slowed down like at sign-in.
   */
  private void changeTeamCode(HttpServletRequest req, HttpServletResponse resp)
      throws IOException {
    String ip = TeamLogin.clientIp(req);
    long wait = TeamLogin.secondsLocked(ip);
    if (wait > 0) {
      send(resp, 429, error("Too many wrong team codes. Try again in " + wait + " seconds."));
      return;
    }
    if (!TeamLogin.codeMatches(req.getParameter("current"))) {
      TeamLogin.recordFailure(ip);
      send(resp, HttpServletResponse.SC_FORBIDDEN, error("The current team code is wrong."));
      return;
    }
    TeamLogin.recordSuccess(ip);
    String newCode = req.getParameter("new");
    boolean keepCode = (newCode == null || newCode.isEmpty())
        && "true".equals(req.getParameter("signout"));
    if (keepCode) {
      newCode = req.getParameter("current");  // only signing everybody out; the code stays
    }
    String problem = TeamLogin.problemWithNewCode(newCode);
    if (problem != null) {
      send(resp, HttpServletResponse.SC_BAD_REQUEST, error(problem));
      return;
    }
    boolean saved = keepCode || TeamLogin.setCode(newCode);
    boolean signedOut = "true".equals(req.getParameter("signout"));
    if (signedOut) {
      OdeAuthFilter.UserInfo me = OdeAuthFilter.getUserInfo(req);
      long moment = TeamLogin.signEveryoneOut();
      if (me != null) {
        // Keep the person who made the change signed in, with a cookie from after the sign-out.
        me.ts = moment;
        String cookie = me.buildCookie(false);
        if (cookie != null) {
          Cookie fresh = new Cookie("AppInventor", cookie);
          fresh.setPath("/");
          resp.addCookie(fresh);
        }
      }
    }
    TeamLogin.recordChange(userInfoProvider.getUserId(), signedOut);
    LOG.info("The team code was changed" + (signedOut ? " and everyone was signed out" : "")
        + (saved ? "" : " (not saved to a file: it lasts until the next restart)"));
    send(resp, 200, new JSONObject().put("ok", true).put("saved", saved)
        .put("signedOut", signedOut));
  }

  private static final int MAX_WRITE_FILES = 3;
  // Big screens are normal in a team's project; a change to one (a new handler on the main screen) must go through.
  private static final int MAX_WRITE_BYTES = 2 * 1024 * 1024;
  // Full-app mode (see collab/server/ai.js): the hub sends this header only for a change that a
  // person asked the AI helper to make after entering the PIN. The hub removes it from anything a
  // browser sends, so nobody else can ask for it.
  private static final String AI_MODE_HEADER = "x-collab-ai-mode";
  private static final int FULL_MAX_FILES = 12;
  private static final int FULL_MAX_NEW_SCREENS = 4;
  private static final int MAX_CHANGE_BYTES = 8 * 1024 * 1024;  // all the files of one change, together
  private static final int MAX_BODY_BYTES = 12 * 1024 * 1024;  // the JSON of one change, escaping included
  private static final Pattern NEW_SCREEN_FILE =
      Pattern.compile("[A-Za-z][A-Za-z0-9_]*\\.(scm|bky)");

  /**
   * Changes a few designer (.scm) and blocks (.bky) files of a project; used by the AI helper.
   * Body: {"files": {"path": "new content", ...}}. Normally only existing files can change, at most
   * 3 at once, and a file may not grow by more than half (plus 4 KB). In full-app mode (the
   * AI_MODE_HEADER) up to 12 files may change, and up to 4 new screens may be added, each as a
   * .scm and a .bky file in the folder of the existing screens. A backup is made first, so that
   * it can be undone.
   */
  private void writeFiles(String userId, long projectId, HttpServletRequest req,
      HttpServletResponse resp) throws IOException {
    boolean full = "full".equals(req.getHeader(AI_MODE_HEADER));
    StringBuilder body = new StringBuilder();
    char[] buf = new char[8192];
    int n;
    java.io.Reader reader = req.getReader();
    while ((n = reader.read(buf)) > 0) {
      body.append(buf, 0, n);
      if (body.length() > MAX_BODY_BYTES) {
        send(resp, HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, error("too large"));
        return;
      }
    }
    JSONObject files = new JSONObject(body.toString()).getJSONObject("files");
    int maxFiles = full ? FULL_MAX_FILES : MAX_WRITE_FILES;
    if (files.length() == 0 || files.length() > maxFiles) {
      send(resp, HttpServletResponse.SC_BAD_REQUEST,
          error("a change touches 1 to " + maxFiles + " files"));
      return;
    }
    List<String> paths = new ArrayList<>();
    for (Iterator<?> it = files.keys(); it.hasNext();) {
      paths.add((String) it.next());
    }
    String problem = fileProblem(userId, projectId, files, paths, full);
    if (problem != null) {
      send(resp, HttpServletResponse.SC_BAD_REQUEST, error(problem));
      return;
    }
    backups.backup(userId, projectId, System.currentTimeMillis());
    List<String> existing = storageIo.getProjectSourceFiles(userId, projectId);
    List<String> created = new ArrayList<>();
    for (String path : paths) {
      if (!existing.contains(path)) {
        created.add(path);
      }
    }
    if (!created.isEmpty()) {
      // A new file is registered with the project before its contents are stored.
      storageIo.addSourceFilesToProject(userId, projectId, true, created.toArray(new String[0]));
    }
    for (String path : paths) {
      storageIo.uploadFileForce(projectId, path, userId, files.getString(path), "UTF-8");
    }
    LOG.info((full ? "Full-app AI change" : "AI change") + " applied to project " + projectId
        + " by " + userInfoProvider.getUserEmail());
    send(resp, 200, new JSONObject().put("ok", true).put("files", paths.size()));
  }

  /** Why these changes are not allowed, or null if they are. */
  private String fileProblem(String userId, long projectId, JSONObject files, List<String> paths,
      boolean full) throws IOException {
    List<String> existing = storageIo.getProjectSourceFiles(userId, projectId);
    String folder = screenFolder(existing);
    int totalBytes = 0;
    int newScreens = 0;
    for (String path : paths) {
      if (!path.endsWith(".scm") && !path.endsWith(".bky")) {
        return "only screen (.scm) and blocks (.bky) files can be changed: " + path;
      }
      int size = files.getString(path).getBytes(StandardCharsets.UTF_8).length;
      if (size > MAX_WRITE_BYTES) {
        return path + " is over 2 MB, more than one change can hold";
      }
      totalBytes += size;
      if (existing.contains(path)) {
        if (!full) {
          byte[] old = storageIo.downloadRawFile(userId, projectId, path);
          if (old != null && size > old.length * 1.5 + 4096) {
            return path + " would change too much for a small fix";
          }
        }
      } else if (!full) {
        return "only existing screen (.scm) and blocks (.bky) files can be changed: " + path;
      } else if (folder == null || !path.startsWith(folder)
          || !NEW_SCREEN_FILE.matcher(path.substring(folder.length())).matches()) {
        return "a new file must be a screen in the same folder as the others: " + path;
      } else {
        String base = path.substring(0, path.lastIndexOf('.'));
        String partner = base + (path.endsWith(".scm") ? ".bky" : ".scm");
        if (!paths.contains(partner)) {
          return "a new screen needs both " + base + ".scm and " + base + ".bky in the same change";
        }
        if (path.endsWith(".scm")) {
          newScreens++;
        }
      }
    }
    if (totalBytes > MAX_CHANGE_BYTES) {
      return "the files of this change add up to over 8 MB, the most one change can hold";
    }
    if (newScreens > FULL_MAX_NEW_SCREENS) {
      return "at most " + FULL_MAX_NEW_SCREENS + " new screens at a time";
    }
    return null;
  }

  /** The folder the project's screens are in, such as "src/appinventor/.../Project/", or null. */
  private static String screenFolder(List<String> files) {
    for (String f : files) {
      if (f.endsWith(".scm")) {
        return f.substring(0, f.lastIndexOf('/') + 1);
      }
    }
    return null;
  }

  private static final int MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
  private static final int MAX_RAW_BYTES = 2 * 1024 * 1024;
  private static final Pattern PICTURE_ASSET =
      Pattern.compile("assets/[^/]{1,80}\\.(png|jpe?g|gif)", Pattern.CASE_INSENSITIVE);
  private static final int MAX_MEDIA = 3;
  private static final int MAX_MEDIA_BYTES = 1024 * 1024;
  private static final Pattern PICTURE_NAME =
      Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,40}\\.(png|jpe?g)");

  /**
   * Adds PNG or JPG pictures to the project's assets, for the AI helper. Body:
   * {"media": [{"name": "logo.png", "data": "BASE64"}]}. Nothing else can be written this way. A
   * backup is made first, and a picture with the same name as an existing one replaces it.
   */
  private void writeMedia(String userId, long projectId, HttpServletRequest req,
      HttpServletResponse resp) throws IOException {
    StringBuilder body = new StringBuilder();
    char[] buf = new char[8192];
    int n;
    java.io.Reader reader = req.getReader();
    while ((n = reader.read(buf)) > 0) {
      body.append(buf, 0, n);
      if (body.length() > 2 * 1024 * 1024) {
        send(resp, HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, error("too large"));
        return;
      }
    }
    JSONArray media = new JSONObject(body.toString()).getJSONArray("media");
    if (media.length() == 0 || media.length() > MAX_MEDIA) {
      send(resp, HttpServletResponse.SC_BAD_REQUEST, error("1 to " + MAX_MEDIA + " pictures at a time"));
      return;
    }
    List<String> paths = new ArrayList<>();
    List<byte[]> contents = new ArrayList<>();
    for (int i = 0; i < media.length(); i++) {
      JSONObject m = media.getJSONObject(i);
      String name = m.optString("name", "");
      if (!PICTURE_NAME.matcher(name).matches()) {
        send(resp, HttpServletResponse.SC_BAD_REQUEST,
            error("picture names are letters, digits and underscores, ending in .png or .jpg"));
        return;
      }
      byte[] bytes;
      try {
        bytes = java.util.Base64.getDecoder().decode(m.optString("data", ""));
      } catch (IllegalArgumentException e) {
        send(resp, HttpServletResponse.SC_BAD_REQUEST, error("a picture is not valid base64"));
        return;
      }
      if (bytes.length == 0 || bytes.length > MAX_MEDIA_BYTES) {
        send(resp, HttpServletResponse.SC_BAD_REQUEST, error("a picture is too big (over 1 MB)"));
        return;
      }
      if (!isPng(bytes) && !isJpeg(bytes)) {
        send(resp, HttpServletResponse.SC_BAD_REQUEST, error("that is not a PNG or JPG picture: " + name));
        return;
      }
      paths.add("assets/" + name);
      contents.add(bytes);
    }
    backups.backup(userId, projectId, System.currentTimeMillis());
    List<String> existing = storageIo.getProjectSourceFiles(userId, projectId);
    List<String> created = new ArrayList<>();
    for (String path : paths) {
      if (!existing.contains(path)) {
        created.add(path);
      }
    }
    if (!created.isEmpty()) {
      storageIo.addSourceFilesToProject(userId, projectId, true, created.toArray(new String[0]));
    }
    for (int i = 0; i < paths.size(); i++) {
      storageIo.uploadRawFileForce(projectId, paths.get(i), userId, contents.get(i));
    }
    LOG.info("AI pictures added to project " + projectId + " by " + userInfoProvider.getUserEmail());
    send(resp, 200, new JSONObject().put("ok", true).put("files", paths.size()));
  }

  private static boolean isPng(byte[] b) {
    return b.length > 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
  }

  private static boolean isJpeg(byte[] b) {
    return b.length > 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff;
  }

  private static long projectId(HttpServletRequest req) {
    return Long.parseLong(req.getParameter("projectId"));
  }

  private static JSONObject error(String message) {
    return new JSONObject().put("ok", false).put("error", message);
  }

  private static void send(HttpServletResponse resp, int status, JSONObject body)
      throws IOException {
    resp.setStatus(status);
    resp.getWriter().write(body.toString());
  }
}
