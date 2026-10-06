// -*- mode: java; c-basic-offset: 2; -*-
// Copyright 2009-2011 Google, All Rights reserved
// Copyright 2011-2019 MIT, All rights reserved
// Released under the MIT License https://raw.github.com/mit-cml/app-inventor/master/mitlicense.txt

package com.google.appinventor.server;

import com.google.appengine.api.users.UserService;
import com.google.appengine.api.users.UserServiceFactory;

import com.google.appinventor.server.flags.Flag;

import com.google.appinventor.server.storage.StorageIo;
import com.google.appinventor.server.storage.StorageIoInstanceHolder;
import com.google.appinventor.server.storage.StoredData.ProjectNotFoundException;

import com.google.appinventor.server.tokens.Token;
import com.google.appinventor.server.tokens.TokenException;
import com.google.appinventor.server.tokens.TokenProto;

import com.google.appinventor.server.util.UriBuilder;

import com.google.appinventor.shared.rpc.user.User;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;

import java.net.URLDecoder;


import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.ResourceBundle;
import java.util.Set;

import java.util.logging.Level;
import java.util.logging.Logger;

import javax.servlet.ServletConfig;
import javax.servlet.ServletException;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.owasp.html.HtmlPolicyBuilder;
import org.owasp.html.PolicyFactory;

/**
 * LoginServlet -- Handle logging someone in. Visitors sign in with a name and the team's shared
 * code (see {@link TeamLogin}); the same name always opens the same account. Password sign-in is
 * turned off. The /login/google page (App Engine's sign-in) and token logins still work; the
 * collaboration hub only lets requests from the Raspberry Pi itself reach /login/google.
 *
 * @author jis@mit.edu (Jeffrey I. Schiller)
 */
@SuppressWarnings("unchecked")
public class LoginServlet extends HttpServlet {

  private final StorageIo storageIo = StorageIoInstanceHolder.getInstance();
  private static final Logger LOG = Logger.getLogger(LoginServlet.class.getName());
  private static final Flag<Boolean> useGoogle = Flag.createFlag("auth.usegoogle", true);
  private static final Flag<Boolean> useLocal = Flag.createFlag("auth.uselocal", false);
  private static final String loginUrl = Flag.createFlag("login.url", "").get();

  private static final UserService userService = UserServiceFactory.getUserService();
  private final PolicyFactory sanitizer = new HtmlPolicyBuilder().allowElements("p").toFactory();
  private static final boolean DEBUG = Flag.createFlag("appinventor.debugging", false).get();
  private static final String PASSWORDS_OFF =
      "Passwords are not used here. Sign in with your name and the team code.";

  private static final Set<LoginListener> loginListeners = new HashSet<>();

  public interface LoginListener {
    void onLogin(User user, TokenProto.token token);
  }

  public static void addLoginListener(LoginListener listener) {
    loginListeners.add(listener);
  }

  public static void removeLoginListener(LoginListener listener) {
    loginListeners.remove(listener);
  }

  public void init(ServletConfig config) throws ServletException {
    super.init(config);
  }

  protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
    resp.setContentType("text/html; charset=utf-8");

    PrintWriter out;
    String [] components = req.getRequestURI().split("/");
    if (DEBUG) {
      LOG.info("requestURI = " + req.getRequestURI());
    }
    String page = getPage(req);

    OdeAuthFilter.UserInfo userInfo = OdeAuthFilter.getUserInfo(req);

    String queryString = req.getQueryString();
    HashMap<String, String> params = getQueryMap(queryString);
    // These params are passed around so they can take effect even if we
    // were not logged in.
    String locale = params.get("locale");
    String repo = params.get("repo");
    String galleryId = params.get("galleryId");
    String redirect = params.get("redirect");
    String autoload = params.get("autoload");
    String newGalleryId = params.get("ng");
    String uiPreference = params.get("ui");

    if (DEBUG) {
      LOG.info("locale = " + locale + " bundle: " + new Locale(locale));
    }
    ResourceBundle bundle;
    if (locale == null) {
      bundle = ResourceBundle.getBundle("com/google/appinventor/server/loginmessages", new Locale("en"));
    } else {
      bundle = ResourceBundle.getBundle("com/google/appinventor/server/loginmessages", new Locale(locale));
    }

    if (page.equals("google")) {
      // We get here after we have gone through the Google Login page
      // This is arranged via a security-constraint setup in web.xml
      com.google.appengine.api.users.User apiUser = userService.getCurrentUser();
      if (apiUser == null) {  // Hmmm. I don't think this should happen
        fail(req, resp, "Google Authentication Failed", locale); // Not sure what else to do
        return;
      }
      String email = apiUser.getEmail();
      String userId = apiUser.getUserId();
      User user = storageIo.getUser(userId, email);

      userInfo = new OdeAuthFilter.UserInfo(); // Create a new userInfo object

      userInfo.setUserId(user.getUserId()); // This effectively logs us in!
      userInfo.setIsAdmin(user.getIsAdmin());
      if (userService.isUserAdmin()) { // If we are a developer, we are always an admin
        userInfo.setIsAdmin(true);
      }

      String newCookie = userInfo.buildCookie(false);
      if (DEBUG) {
        LOG.info("newCookie = " + newCookie);
      }
      if (newCookie != null) {
        Cookie cook = new Cookie("AppInventor", newCookie);
        cook.setPath("/");
        resp.addCookie(cook);
      }
      // Remove the ACSID Cookie used by Google for Authentication
      Cookie cook = new Cookie("ACSID", null);
      cook.setPath("/");
      cook.setMaxAge(0);
      resp.addCookie(cook);
      String uri = "/";
      if (redirect != null) {
        uri = redirect;
      }
      uri = new UriBuilder(uri)
        .add("locale", locale)
        .add("repo", repo)
        .add("autoload", autoload)
        .add("ng", newGalleryId)
        .add("ui", uiPreference)
        .add("galleryId", galleryId).build();
      resp.sendRedirect(uri);
      return;
    } else {
      if (!loginUrl.isEmpty() && !page.equals("token")) {
        /* If we have an external login URL specified, then redirect to it. */
        String uri = new UriBuilder(loginUrl)
          .add("locale", locale)
          .add("repo", repo)
          .add("ng", newGalleryId)
          .add("galleryId", galleryId)
          .add("autoload", autoload)
          .add("ui", uiPreference)
          .add("redirect", redirect).build();
        resp.sendRedirect(uri);
        return;
      }
      if (useLocal.get() == false) {
        if (useGoogle.get() == false) {
          out = setCookieOutput(userInfo, resp);
          out.println("<html><head><title>Error</title></head>\n");
          out.println("<body><h1>App Inventor is Mis-Configured</h1>\n");
          out.println("<p>This instance of App Inventor has no authentication mechanism configured.</p>\n");
          out.println("</body>\n");
          out.println("</html>\n");
          return;
        } else if (!page.equals("token")) {
            String uri = new UriBuilder("/login/google")
              .add("locale", locale)
              .add("repo", repo)
              .add("ng", newGalleryId)
              .add("galleryId", galleryId)
              .add("autoload", autoload)
              .add("ui", uiPreference)
              .add("redirect", redirect).build();
            resp.sendRedirect(uri);
            return;
        }
      }
    }

    // If we get here, local accounts are supported
    // or we are the "token" page

    if (page.equals("setpw") || page.equals("sendlink") || page.equals("linksent")) {
      fail(req, resp, PASSWORDS_OFF, locale);
      return;
    } else if (page.equals("token") || page.equals("stoken")) {
      String encodedToken = params.get("token");
      if (encodedToken == null) {
        fail(req, resp, "No Authentication Token Provided", locale);
        return;
      }
      TokenProto.token token = null;
      try {
        if (page.equals("token")) {
          token = Token.verifyToken(encodedToken);
        } else {
          token = Token.verifySToken(encodedToken);
        }
      } catch (TokenException e) {
        fail(req, resp, e.getMessage(), locale);
        return;
      }
      // At this point we have a valid token, so use it to login!
      // need to make sure it is a SSOLOGIN token
      if (token.getCommand() != TokenProto.token.CommandType.SSOLOGIN &&
          token.getCommand() != TokenProto.token.CommandType.SSOLOGIN2 &&
          token.getCommand() != TokenProto.token.CommandType.SSOLOGIN3) {
        fail(req, resp, "Token Valid, but not a SSOLOGIN token.", locale);
        return;
      }
      long offset = System.currentTimeMillis() - token.getTs();
      offset /= 1000;  // Convert to seconds
      if (offset > 120) {       // Two minutes
        fail(req, resp, "Token Expired. Was valid until " +
          new Date(token.getTs()), locale);
        return;
      }
      // At this point we have a valid SSOLOGIN token

      userInfo = new OdeAuthFilter.UserInfo();
      if (token.getCommand() == TokenProto.token.CommandType.SSOLOGIN) {
        userInfo.setUserId(token.getUuid());
      } else if (token.getCommand() == TokenProto.token.CommandType.SSOLOGIN2) { // SSOLOGIN2
        String email = token.getName();
        if (email == null || email.isEmpty()) {
          fail(req, resp, "Failed to provide an Email Address for login.", locale);
          return;
        }
        User user = storageIo.getUserFromEmail(email);
        userInfo.setUserId(user.getUserId());
      } else {                  // SSOLOGIN3
        String uuid = token.getUuid();
        String email = token.getName();
        if (email == null || email.isEmpty() || uuid == null || uuid.isEmpty()) {
          fail(req, resp, "Failed to provide email and uuid, shouldn't happen!", locale);
          return;
        }
        User user = storageIo.getUser(uuid, email);
        userInfo.setUserId(user.getUserId());
        for (LoginListener listener : loginListeners) {
          listener.onLogin(user, token);
        }
      }

      userInfo.setReadOnly(token.getReadOnly());

      // Check to see if this is a one project token
      long oneProjectId = token.getOneProjectId();
      LOG.log(Level.INFO, "oneProjectId = " + oneProjectId);
      if (oneProjectId != 0) {  // It is...
        try {
          userInfo.setUserId(storageIo.getProjectUserId(oneProjectId));
          userInfo.setOneProjectId(oneProjectId);
        } catch (ProjectNotFoundException e) {
          fail(req, resp, e.getMessage(), locale);
        }
      }

      userInfo.setFauxProjectName(token.getDisplayprojectname());

      String fauxUserName = token.getDisplayaccountname();

      userInfo.setFauxAccountName(fauxUserName);

      String newCookie = userInfo.buildCookie(false);
      if (newCookie != null) {
        Cookie cook = new Cookie("AppInventor", newCookie);
        cook.setPath("/");
        resp.addCookie(cook);
      }

      String uri = new UriBuilder("/")
        .add("locale", locale)
        .add("repo", repo)
        .add("ng", newGalleryId)
        .add("galleryId", galleryId)
        .add("autoload", autoload)
        .add("ui", uiPreference)
        .add("redirect", redirect).build();
      resp.sendRedirect(uri);   // This should bring up App Inventor
      return;
    }

    String login = bundle.getString("login");

    req.setCharacterEncoding("UTF-8");
    req.setAttribute("teamLoginEnabled", TeamLogin.isEnabled() ? "true" : "false");
    req.setAttribute("loginLabel", login);
    req.setAttribute("localeLabel", locale);
    req.setAttribute("pleaselogin", bundle.getString("pleaselogin"));
    req.setAttribute("login", bundle.getString("login"));
    req.setAttribute("autoload", autoload);
    req.setAttribute("repo", repo);
    req.setAttribute("locale", locale);
    req.setAttribute("ng", newGalleryId);
    req.setAttribute("ui", uiPreference);
    req.setAttribute("galleryId", galleryId);
    try {
      req.getRequestDispatcher("/login.jsp").forward(req, resp);
    } catch (ServletException e) {
      throw new IOException(e);
    }
  }

  protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
    BufferedReader input = new BufferedReader(new InputStreamReader(req.getInputStream()));
    String queryString = input.readLine();

    PrintWriter out;

    OdeAuthFilter.UserInfo userInfo = OdeAuthFilter.getUserInfo(req);

    if (userInfo == null) {
      userInfo = new OdeAuthFilter.UserInfo();
    }

    if (queryString == null) {
      out = setCookieOutput(userInfo, resp);
      out.println("queryString is null");
      return;
    }

    HashMap<String, String> params = getQueryMap(queryString);
    String page = getPage(req);
    String locale = params.get("locale");
    String repo = params.get("repo");
    String galleryId = params.get("galleryId");
    String newGalleryId = params.get("ng");
    String redirect = params.get("redirect");
    String autoload = params.get("autoload");
    String uiPreference = params.get("ui");

    if (locale == null) {
      locale = "en";
    }

    ResourceBundle bundle = ResourceBundle.getBundle("com/google/appinventor/server/loginmessages", new Locale(locale));

    if (DEBUG) {
      LOG.info("locale = " + locale + " bundle: " + new Locale(locale));
    }
    if (page.equals("sendlink") || page.equals("setpw")) {
      fail(req, resp, PASSWORDS_OFF, locale);
      return;
    }

    // Team login: a name plus the team's shared code (collab.teamcode in appengine-web.xml).
    String ip = TeamLogin.clientIp(req);
    long wait = TeamLogin.secondsLocked(ip);
    if (wait > 0) {
      fail(req, resp, "Too many wrong team codes. Try again in " + wait + " seconds.", locale);
      return;
    }
    if (!TeamLogin.isEnabled()) {
      fail(req, resp, "Team login is not set up yet.", locale);
      return;
    }
    if (!TeamLogin.codeMatches(params.get("teamcode"))) {
      TeamLogin.recordFailure(ip);
      fail(req, resp, "Wrong team code.", locale);
      return;
    }
    String name = TeamLogin.normalizeName(params.get("name"));
    if (name == null) {
      fail(req, resp, "Your name can use 1 to 30 letters, digits, - and . (no spaces).", locale);
      return;
    }
    TeamLogin.recordSuccess(ip);
    User user = storageIo.getUserFromEmail(TeamLogin.emailFor(name));
    if (!user.getUserTosAccepted()) {
      storageIo.setTosAccepted(user.getUserId());
    }

    if (DEBUG) {
      LOG.info("userInfo = " + userInfo + " user = " + user);
    }
    userInfo.setUserId(user.getUserId());
    userInfo.setIsAdmin(user.getIsAdmin());
    String newCookie = userInfo.buildCookie(false);
    if (DEBUG) {
      LOG.info("newCookie = " + newCookie);
    }
    if (newCookie != null) {
      Cookie cook = new Cookie("AppInventor", newCookie);
      cook.setPath("/");
      resp.addCookie(cook);
    }

    String uri = "/";
    if (redirect != null && !redirect.equals("")) {
      uri = redirect;
    }
    uri = new UriBuilder(uri)
      .add("locale", locale)
      .add("autoload", autoload)
      .add("repo", repo)
      .add("ng", newGalleryId)
      .add("ui", uiPreference)
      .add("galleryId", galleryId).build();
    resp.sendRedirect(uri);
  }

  public void destroy() {
    super.destroy();
  }

  private static HashMap<String, String> getQueryMap(String query)  {
    HashMap<String, String> map = new HashMap<String, String>();
    if (query == null || query.equals("")) {
      return map;               // Empty map
    }
    String[] params = query.split("&");
    for (String param : params)  {
      String [] nvpair = param.split("=");
      if (nvpair.length <= 1) {
        map.put(nvpair[0], "");
      } else
        map.put(nvpair[0], URLDecoder.decode(nvpair[1]));
    }
    return map;
  }

  // Note: Urls in this servlet are of the form /login/<param>/<page>
  // The page identifier is *after* the parameter, if there is one.

  private String getPage(HttpServletRequest req) {
    String [] components = req.getRequestURI().split("/");
    return components[components.length-1];
  }

  private String getParam(HttpServletRequest req) {
    String [] components = req.getRequestURI().split("/");
    if (components.length < 2)
      return null;
    return components[components.length-2];
  }


  private void fail(HttpServletRequest req, HttpServletResponse resp, String error, String locale) throws IOException {
    resp.sendRedirect("/login/?locale=" + sanitizer.sanitize(locale) + "&error=" + sanitizer.sanitize(error));
    return;
  }


  private PrintWriter setCookieOutput(OdeAuthFilter.UserInfo userInfo, HttpServletResponse resp)
    throws IOException {
    if (userInfo != null) {     // if we never had logged in, this will be null!
      String newCookie = userInfo.buildCookie(true);
      if (newCookie != null) {
        Cookie cook = new Cookie("AppInventor", newCookie);
        cook.setPath("/");
        resp.addCookie(cook);
      }
    }
    resp.setContentType("text/html; charset=utf-8");
    PrintWriter out = resp.getWriter();
    return out;
  }

}
