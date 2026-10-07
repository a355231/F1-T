// -*- mode: java; c-basic-offset: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

package com.google.appinventor.server;

import com.google.appinventor.server.flags.Flag;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;

import javax.servlet.http.HttpServletRequest;

/**
 * Team login: people sign in with a name and the team's shared code. The same name always maps to
 * the same account, name@team.local.
 *
 * <p>The code can be changed while App Inventor is running. When the collab.teamcode.file flag is
 * set (on the Raspberry Pi it is /opt/appinventor/teamcode) the code is read from that file, so
 * a change is picked up by the next sign-in without a restart; otherwise it comes from the
 * collab.teamcode flag in appengine-web.xml, and a change only lasts until the server restarts.
 * Signing everyone out is recorded as a time next to the code file (see signedOutBefore).
 */
final class TeamLogin {
  static final String EMAIL_DOMAIN = "@team.local";
  static final int MIN_CODE_LENGTH = 8;
  static final int MAX_CODE_LENGTH = 64;

  private static final Logger LOG = Logger.getLogger(TeamLogin.class.getName());
  private static final Flag<String> TEAM_CODE = Flag.createFlag("collab.teamcode", "");
  private static final Flag<String> TEAM_CODE_FILE = Flag.createFlag("collab.teamcode.file", "");
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

  // --- the code, read live ---

  private static String memoryCode = null;      // used when there is no code file
  private static String fileCode = "";

  private static Path codeFile() {
    String name = TEAM_CODE_FILE.get();
    return name.isEmpty() ? null : Paths.get(name);
  }

  private static String fileStamp(Path file) {
    try {
      return Files.getLastModifiedTime(file).toMillis() + ":" + Files.size(file);
    } catch (IOException e) {
      return "missing";
    }
  }

  private static String lastStamp = "";

  /** The code people must type now; empty means sign-in is switched off. */
  static synchronized String currentCode() {
    Path file = codeFile();
    if (file == null) {
      return memoryCode != null ? memoryCode : TEAM_CODE.get();
    }
    String stamp = fileStamp(file);
    if (!stamp.equals(lastStamp)) {
      try {
        fileCode = new String(Files.readAllBytes(file), StandardCharsets.UTF_8).trim();
      } catch (IOException e) {
        fileCode = "";
      }
      lastStamp = stamp;
    }
    return fileCode;
  }

  static boolean isEnabled() {
    return !currentCode().isEmpty();
  }

  /** Compares in constant time; hashing first keeps the code's length from leaking too. */
  static boolean codeMatches(String given) {
    String expected = currentCode();
    if (expected.isEmpty()) {
      return false;
    }
    return MessageDigest.isEqual(sha256(given == null ? "" : given), sha256(expected));
  }

  /** Why newCode cannot be used as a team code, or null if it can. */
  static String problemWithNewCode(String newCode) {
    if (newCode == null || newCode.length() < MIN_CODE_LENGTH) {
      return "The new team code needs at least " + MIN_CODE_LENGTH + " characters.";
    }
    if (newCode.length() > MAX_CODE_LENGTH) {
      return "The new team code can have at most " + MAX_CODE_LENGTH + " characters.";
    }
    if (!newCode.equals(newCode.trim()) || newCode.chars().anyMatch(Character::isISOControl)) {
      return "The new team code cannot start or end with a space or contain control characters.";
    }
    return null;
  }

  /**
   * Switches to a new code, effective for the next sign-in. Returns true if the change was saved
   * to the code file, so it survives a restart.
   */
  static synchronized boolean setCode(String newCode) throws IOException {
    Path file = codeFile();
    if (file == null) {
      memoryCode = newCode;
      return false;
    }
    writeAtomically(file, newCode + "\n");
    lastStamp = "";             // re-read on the next use
    return true;
  }

  // --- who changed the code last (so the collaboration hub can check an announcement) ---

  private static long lastChangeAt = 0;
  private static String lastChangeBy = "";
  private static boolean lastChangeSignedOut = false;

  static synchronized void recordChange(String userId, boolean signedOut) {
    lastChangeAt = System.currentTimeMillis();
    lastChangeBy = userId == null ? "" : userId;
    lastChangeSignedOut = signedOut;
  }

  /** {time in ms, user id, whether everyone was signed out} of the latest change, or time 0. */
  static synchronized Object[] lastChange() {
    return new Object[] {lastChangeAt, lastChangeBy, lastChangeSignedOut};
  }

  // --- signing everybody out ---

  private static long signedOutBefore = 0;
  private static long signedOutCheckedAt = 0;
  private static String signoutStamp = "";

  private static Path signoutFile() {
    Path code = codeFile();
    return code == null ? null : code.resolveSibling(code.getFileName() + ".signout");
  }

  /**
   * Login cookies issued before this moment (milliseconds since 1970) are no longer accepted.
   * Re-checked at most once a second, so a sign-out made from the Pi's command line is noticed
   * without a restart.
   */
  static synchronized long signedOutBefore() {
    Path file = signoutFile();
    long now = System.currentTimeMillis();
    if (file != null && now - signedOutCheckedAt >= 1000) {
      signedOutCheckedAt = now;
      String stamp = fileStamp(file);
      if (!stamp.equals(signoutStamp)) {
        signoutStamp = stamp;
        try {
          signedOutBefore = Math.max(signedOutBefore,
              Long.parseLong(new String(Files.readAllBytes(file), StandardCharsets.UTF_8).trim()));
        } catch (IOException | NumberFormatException e) {
          // no usable record: keep what we have
        }
      }
    }
    return signedOutBefore;
  }

  /** Signs everyone out; returns the moment, which is also the earliest cookie that stays valid. */
  static synchronized long signEveryoneOut() throws IOException {
    long now = System.currentTimeMillis();
    signedOutBefore = Math.max(signedOutBefore, now);
    Path file = signoutFile();
    if (file != null) {
      writeAtomically(file, Long.toString(now) + "\n");
      signoutStamp = fileStamp(file);
    }
    return now;
  }

  private static void writeAtomically(Path file, String content) throws IOException {
    Path temp = file.resolveSibling(file.getFileName() + ".tmp");
    Files.write(temp, content.getBytes(StandardCharsets.UTF_8));
    try {
      Files.setPosixFilePermissions(temp, PosixFilePermissions.fromString("rw-------"));
    } catch (UnsupportedOperationException | IOException e) {
      LOG.log(Level.FINE, "Could not restrict permissions on " + temp, e);
    }
    Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
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
