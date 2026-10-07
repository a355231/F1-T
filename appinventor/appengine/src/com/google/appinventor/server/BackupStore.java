// -*- mode: java; c-basic-offset: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

package com.google.appinventor.server;

import com.google.appinventor.server.flags.Flag;
import com.google.appinventor.server.storage.StorageIo;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Version history for projects. A backup is a zip of the project's source files, named
 * {@code <time in ms>-<8 hex of content hash>.zip} under {@code <collab.backup.dir>/<projectId>/}.
 * A backup is only written when the content differs from the newest one, which keeps the SD card
 * from being written for nothing. Old backups are thinned: every one for the last hour, then one
 * per 10 minutes for a day, then one per hour for a week, then one per day, at most MAX_KEPT.
 */
final class BackupStore {
  private static final Flag<String> DIR = Flag.createFlag("collab.backup.dir", "");
  private static final Pattern NAME = Pattern.compile("(\\d{10,15})-([0-9a-f]{8})\\.zip");
  private static final long MIN = 60 * 1000L;
  private static final int MAX_KEPT = 400;
  private static final long MAX_FILE_BYTES = 64L * 1024 * 1024;

  private final StorageIo storageIo;

  BackupStore(StorageIo storageIo) {
    this.storageIo = storageIo;
  }

  static boolean enabled() {
    return !DIR.get().isEmpty();
  }

  private Path folder(long projectId) {
    return Paths.get(DIR.get(), Long.toString(projectId));
  }

  /** Writes a backup if the project changed since the newest one. Returns its id or null. */
  synchronized String backup(String userId, long projectId, long now) throws IOException {
    if (!enabled()) {
      return null;
    }
    List<String> files = new ArrayList<>(storageIo.getProjectSourceFiles(userId, projectId));
    Collections.sort(files);
    MessageDigest md = sha();
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
      for (String f : files) {
        byte[] content = storageIo.downloadRawFile(userId, projectId, f);
        if (content == null) {
          continue;
        }
        md.update(f.getBytes(StandardCharsets.UTF_8));
        md.update((byte) 0);
        md.update(content);
        zip.putNextEntry(new ZipEntry(f));
        zip.write(content);
        zip.closeEntry();
      }
    }
    if (bytes.size() > MAX_FILE_BYTES) {
      return null;
    }
    String hash = hex(md.digest()).substring(0, 8);
    Path dir = folder(projectId);
    Files.createDirectories(dir);
    List<String> existing = ids(projectId);
    if (!existing.isEmpty() && existing.get(0).endsWith("-" + hash)) {
      return null;
    }
    String id = now + "-" + hash;
    Path temp = dir.resolve(id + ".tmp");
    Files.write(temp, bytes.toByteArray());
    Files.move(temp, dir.resolve(id + ".zip"));
    thin(projectId, now);
    return id;
  }

  /** Backup ids, newest first. */
  List<String> ids(long projectId) throws IOException {
    List<String> out = new ArrayList<>();
    Path dir = folder(projectId);
    if (!enabled() || !Files.isDirectory(dir)) {
      return out;
    }
    try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
      for (Path p : ds) {
        String n = p.getFileName().toString();
        if (NAME.matcher(n).matches()) {
          out.add(n.substring(0, n.length() - 4));
        }
      }
    }
    out.sort(Collections.reverseOrder());
    return out;
  }

  static long timeOf(String id) {
    return Long.parseLong(id.substring(0, id.indexOf('-')));
  }

  static boolean validId(String id) {
    return id != null && NAME.matcher(id + ".zip").matches();
  }

  private void thin(long projectId, long now) throws IOException {
    List<String> list = ids(projectId);
    Set<Long> buckets = new HashSet<>();
    int kept = 0;
    for (String id : list) {
      long age = now - timeOf(id);
      long size = age < 60 * MIN ? 0 : age < 24 * 60 * MIN ? 10 * MIN
          : age < 7 * 24 * 60 * MIN ? 60 * MIN : 24 * 60 * MIN;
      boolean keep = true;
      if (size > 0) {
        long bucket = size * 1000003L + timeOf(id) / size;
        keep = buckets.add(bucket);
      }
      if (keep && kept >= MAX_KEPT) {
        keep = false;
      }
      if (keep) {
        kept++;
      } else {
        Files.deleteIfExists(folder(projectId).resolve(id + ".zip"));
      }
    }
  }

  /** Puts the project's files back to what the backup holds. Returns the number of files. */
  synchronized int restore(String userId, long projectId, String id) throws IOException {
    if (!validId(id)) {
      throw new IOException("bad backup id");
    }
    Path file = folder(projectId).resolve(id + ".zip");
    byte[] zipBytes = Files.readAllBytes(file);
    Set<String> inBackup = new HashSet<>();
    Set<String> present = new HashSet<>(storageIo.getProjectSourceFiles(userId, projectId));
    try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
      ZipEntry e;
      while ((e = in.getNextEntry()) != null) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) {
          buf.write(chunk, 0, n);
        }
        inBackup.add(e.getName());
        if (!present.contains(e.getName())) {
          // A file deleted since the backup is registered with the project again first.
          storageIo.addSourceFilesToProject(userId, projectId, true, e.getName());
        }
        storageIo.uploadRawFileForce(projectId, e.getName(), userId, buf.toByteArray());
      }
    }
    for (String f : storageIo.getProjectSourceFiles(userId, projectId)) {
      if (!inBackup.contains(f)) {
        storageIo.deleteFile(userId, projectId, f);
      }
    }
    return inBackup.size();
  }

  private static MessageDigest sha() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static String hex(byte[] b) {
    StringBuilder s = new StringBuilder();
    for (byte x : b) {
      s.append(String.format("%02x", x));
    }
    return s.toString();
  }
}
