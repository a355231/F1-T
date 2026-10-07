// -*- mode: java; c-basic-offset: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

package com.google.appinventor.server;

import com.google.appinventor.server.storage.StorageIo;
import com.google.appinventor.server.storage.StorageIoInstanceHolder;
import com.google.appinventor.shared.rpc.user.User;

import java.io.IOException;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

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
