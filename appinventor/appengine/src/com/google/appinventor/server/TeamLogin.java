// -*- mode: java; c-basic-offset: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

package com.google.appinventor.server;

import com.google.appinventor.server.flags.Flag;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

import javax.servlet.http.HttpServletRequest;

/**
 * Team login: people sign in with a name and the team's shared code (the collab.teamcode flag in
 * appengine-web.xml). The same name always maps to the same account, name@team.local.
 */
final class TeamLogin {
  static final String EMAIL_DOMAIN = "@team.local";

  private static final Flag<String> TEAM_CODE = Flag.createFlag("collab.teamcode", "");
  private static final Pattern NAME = Pattern.compile("[a-z0-9.-]{1,30}");

  // Wrong codes from one address: the first few are free, then each one locks the address for
  // twice as long as the previous, up to MAX_LOCK_MS.
  private static final int FREE_FAILURES = 3;
  private static final long FIRST_LOCK_MS = 5 * 1000;
  private static final long MAX_LOCK_MS = 5 * 60 * 1000;
  private static final long FORGET_AFTER_MS = 60 * 60 * 1000;
  private static final int MAX_TRACKED = 10000;

  private static final Map<String, Failures> failures = new ConcurrentHashMap<>();

  private static final class Failures {
    int count;
    long lockedUntil;
    long last;
  }

  private TeamLogin() {
  }

  static boolean isEnabled() {
    return !TEAM_CODE.get().isEmpty();
  }

  /** Compares in constant time; hashing first keeps the code's length from leaking too. */
  static boolean codeMatches(String given) {
    String expected = TEAM_CODE.get();
    if (expected.isEmpty()) {
      return false;
    }
    return MessageDigest.isEqual(sha256(given == null ? "" : given), sha256(expected));
  }

  /** Trimmed, lowercased name of 1-30 letters, digits, '-' or '.', or null if not allowed. */
  static String normalizeName(String raw) {
    if (raw == null) {
      return null;
    }
    String name = raw.trim().toLowerCase(Locale.ROOT);
    return NAME.matcher(name).matches() ? name : null;
  }

  static String emailFor(String name) {
    return name + EMAIL_DOMAIN;
  }

  /**
   * The browser's address. App Inventor only listens on the Pi itself, behind the collaboration
   * hub, which replaces X-Forwarded-For with the real client address, so the header is only
   * trusted on connections from this machine.
   */
  static String clientIp(HttpServletRequest req) {
    String remote = req.getRemoteAddr();
    boolean local = "127.0.0.1".equals(remote) || "::1".equals(remote)
        || "0:0:0:0:0:0:0:1".equals(remote);
    String forwarded = req.getHeader("X-Forwarded-For");
    if (local && forwarded != null && !forwarded.trim().isEmpty()) {
      return forwarded.split(",")[0].trim();
    }
    return remote;
  }

  /** Seconds this address must wait before trying another code, or 0. */
  static long secondsLocked(String ip) {
    Failures f = failures.get(ip);
    if (f == null) {
      return 0;
    }
    synchronized (f) {
      long left = f.lockedUntil - System.currentTimeMillis();
      return left > 0 ? (left + 999) / 1000 : 0;
    }
  }

  static void recordFailure(String ip) {
    long now = System.currentTimeMillis();
    if (failures.size() > MAX_TRACKED) {
      forgetOld(now);
    }
    Failures f = failures.computeIfAbsent(ip, k -> new Failures());
    synchronized (f) {
      if (now - f.last > FORGET_AFTER_MS) {
        f.count = 0;
      }
      f.count++;
      f.last = now;
      if (f.count >= FREE_FAILURES) {
        int doublings = Math.min(f.count - FREE_FAILURES, 20);
        f.lockedUntil = now + Math.min(MAX_LOCK_MS, FIRST_LOCK_MS << doublings);
      }
    }
  }

  static void recordSuccess(String ip) {
    failures.remove(ip);
  }

  private static void forgetOld(long now) {
    for (Iterator<Failures> it = failures.values().iterator(); it.hasNext(); ) {
      Failures f = it.next();
      if (now - f.last > FORGET_AFTER_MS) {
        it.remove();
      }
    }
  }

  private static byte[] sha256(String s) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
