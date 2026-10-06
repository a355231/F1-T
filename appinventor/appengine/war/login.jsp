<%@page import="javax.servlet.http.HttpServletRequest"%>
<%@page import="com.google.appinventor.server.util.UriBuilder"%>
<%@page import="org.apache.commons.lang3.StringEscapeUtils"%>
<%@page contentType="text/html" pageEncoding="UTF-8"%>
<!doctype html>
<%
   String error = StringEscapeUtils.escapeHtml4(request.getParameter("error"));
   boolean teamLoginEnabled = "true".equals(request.getAttribute("teamLoginEnabled"));
   String locale = StringEscapeUtils.escapeHtml4(request.getParameter("locale"));
   String redirect = StringEscapeUtils.escapeHtml4(request.getParameter("redirect"));
   String repo = StringEscapeUtils.escapeHtml4((String) request.getAttribute("repo"));
   String autoload = StringEscapeUtils.escapeHtml4((String) request.getAttribute("autoload"));
   String galleryId = StringEscapeUtils.escapeHtml4((String) request.getAttribute("galleryId"));
   String newGalleryId = StringEscapeUtils.escapeHtml4(request.getParameter("ng"));
   String uiPreference = StringEscapeUtils.escapeHtml4(request.getParameter("ui"));
   if (locale == null) {
       locale = "en";
   }

%>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <meta HTTP-EQUIV="pragma" CONTENT="no-cache"/>
    <meta HTTP-EQUIV="Cache-Control" CONTENT="no-cache, must-revalidate"/>
    <meta HTTP-EQUIV="expires" CONTENT="0"/>
    <title>MIT App Inventor</title>
  </head>
<body>
  <center>
    <h1>${pleaselogin}</h1>
  </center>
<% if (error != null) {
out.println("<center><font color=red><b>" + error + "</b></font></center><br/>");
   } %>
<% if (!teamLoginEnabled) { %>
<center><p><b>Sign-in is not set up yet.</b><br/>
Set a team code on the Raspberry Pi: <code>sudo /opt/appinventor/set-team-code.sh</code></p></center>
<% } else { %>
<form method=POST action="/login">
<center><table>
<tr><td>Your name</td><td><input type=text name=name value="" size="35" maxlength="30"
    autocomplete="username" autocapitalize="none" spellcheck="false" autofocus></td></tr>
<tr><td></td></td>
<tr><td>Team code</td><td><input type=password name=teamcode value="" size="35"
    autocomplete="current-password"></td></tr>
</table></center>
<% if (locale != null && !locale.equals("")) {
   %>
<input type=hidden name=locale value="<%= locale %>">
<% }
   if (repo != null && !repo.equals("")) {
   %>
<input type=hidden name=repo value="<%= repo %>">
<% }
   if (autoload != null && !autoload.equals("")) {
   %>
<input type=hidden name=autoload value="<%= autoload %>">
<% }
   if (galleryId != null && !galleryId.equals("")) {
   %>
<input type=hidden name=galleryId value="<%= galleryId %>">
<% }
   if (newGalleryId != null && !newGalleryId.equals("")) {
   %>
<input type=hidden name=ng value="<%= newGalleryId %>">
<% }
   if (uiPreference != null && !uiPreference.equals("")) {
   %>
<input type=hidden name=ui value="<%= uiPreference %>">
<% } %>
<% if (redirect != null && !redirect.equals("")) {
   %>
<input type=hidden name=redirect value="<%= redirect %>">
<% } %>
<p></p>
<center><input type=Submit value="${login}" style="font-size: 300%;"></center>
</form>
<p></p>
<center><p>Use the same name every time to get back to your projects.</p></center>
<% } %>
<footer>
<center><a href="<%= new UriBuilder("/login")
                           .add("locale", "zh_CN")
                           .add("repo", repo)
                           .add("autoload", autoload)
                           .add("galleryId", galleryId)
                           .add("ui", uiPreference)
                           .add("redirect", redirect).build() %>"  style="text-decoration:none;" >中文</a>&nbsp;
<a href="<%= new UriBuilder("/login")
                           .add("locale", "pt")
                           .add("repo", repo)
                           .add("autoload", autoload)
                           .add("galleryId", galleryId)
                           .add("ui", uiPreference)
                           .add("redirect", redirect).build() %>"  style="text-decoration:none;" >Português</a>&nbsp;
<a href="<%= new UriBuilder("/login")
                   .add("locale", "en")
                   .add("repo", repo)
                   .add("autoload", autoload)
                   .add("galleryId", galleryId)
                   .add("ng", newGalleryId)
                   .add("ui", uiPreference)
                   .add("redirect", redirect).build() %>"  style="text-decoration:none;" >English</a></center>
<p></p>
<center>
<%    if (locale != null && locale.equals("zh_CN")) { %>
<a href="http://www.weibo.com/mitappinventor" target="_blank"><img class="img-scale"
                  src="/static/images/mzl.png" width="30" height="30" title="Sina WeiBo"></a>&nbsp;
<%    } %>
<a href="http://www.appinventor.mit.edu" target="_blank"><img class="img-scale"
                src="/static/images/login-app-inventor.jpg" width="50" height="30" title="MIT App Inventor"></a></center>
<p></p>

<p style="text-align: center; clear:both;"><a rel="license" href="http://creativecommons.org/licenses/by-sa/3.0/"
                                              target="_blank"><img alt="Creative Commons License" src="/static/images/cc3.png"></a> <br>
  <a rel="license" href="http://creativecommons.org/licenses/by-sa/3.0/" target="_blank"></a></p>
</footer>
</body></html>

