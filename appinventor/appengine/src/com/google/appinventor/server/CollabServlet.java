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
 * </pre>
 */
public class CollabServlet extends OdeServlet {
  private static final Logger LOG = Logger.getLogger(CollabServlet.class.getName());

  private final transient StorageIo storageIo = StorageIoInstanceHolder.getInstance();

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
        default:
          send(resp, HttpServletResponse.SC_NOT_FOUND, error("unknown endpoint"));
      }
    } catch (NumberFormatException e) {
      send(resp, HttpServletResponse.SC_BAD_REQUEST, error("bad projectId"));
    } catch (SecurityException e) {
      send(resp, HttpServletResponse.SC_FORBIDDEN, error("no access to project"));
    } catch (RuntimeException e) {
      LOG.log(Level.WARNING, "collab request failed: " + path, e);
      send(resp, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, error("server error"));
    }
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
