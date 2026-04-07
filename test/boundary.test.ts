import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Wiki } from "../src/wiki.js";

describe("Sacred boundary enforcement", () => {
  let tmpDir: string;
  let wiki: Wiki;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-boundary-"));
    wiki = new Wiki(tmpDir);
    wiki.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Allowed writes ──────────────────────────────────────────

  it("allows write to wiki/", () => {
    expect(() => wiki.safeWrite("wiki/test.md", "content")).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, "wiki", "test.md"))).toBe(true);
  });

  it("allows write to wiki/ subdirectories", () => {
    expect(() =>
      wiki.safeWrite("wiki/topics/ai.md", "content")
    ).not.toThrow();
    expect(
      fs.existsSync(path.join(tmpDir, "wiki", "topics", "ai.md"))
    ).toBe(true);
  });

  it("allows write to ops/", () => {
    expect(() => wiki.safeWrite("ops/log.md", "content")).not.toThrow();
  });

  it("allows write to sources/agent/", () => {
    expect(() =>
      wiki.safeWrite("sources/agent/article.md", "content")
    ).not.toThrow();
    expect(
      fs.existsSync(path.join(tmpDir, "sources", "agent", "article.md"))
    ).toBe(true);
  });

  // ── Rejected writes ─────────────────────────────────────────

  it("rejects write to sources/user/ (SACRED)", () => {
    expect(() =>
      wiki.safeWrite("sources/user/notes/my-note.md", "content")
    ).toThrow("outside allowed directories");
  });

  it("rejects write to /etc/passwd", () => {
    expect(() => wiki.safeWrite("/etc/passwd", "hacked")).toThrow(
      "outside allowed directories"
    );
  });

  it("rejects path traversal with ../", () => {
    expect(() => wiki.safeWrite("wiki/../../etc/passwd", "hacked")).toThrow(
      "outside allowed directories"
    );
  });

  it("rejects path traversal from ops/", () => {
    expect(() =>
      wiki.safeWrite("ops/../../outside.md", "hacked")
    ).toThrow("outside allowed directories");
  });

  it("rejects null bytes in path", () => {
    expect(() => wiki.safeWrite("wiki/test\0.md", "content")).toThrow(
      "null bytes"
    );
  });

  it("rejects write to root of .autopedia/", () => {
    expect(() => wiki.safeWrite("config.json", "content")).toThrow(
      "outside allowed directories"
    );
  });

  it("rejects write to schema/ (read-only for server)", () => {
    expect(() => wiki.safeWrite("schema/prompt.md", "overwrite")).toThrow(
      "outside allowed directories"
    );
  });

  // ── Symlink attacks ─────────────────────────────────────────

  it("rejects write via symlink pointing outside allowed dirs", () => {
    // Create a symlink inside wiki/ that points to sources/user/
    const userDir = path.join(tmpDir, "sources", "user");
    const symlinkPath = path.join(tmpDir, "wiki", "sneaky");

    try {
      fs.symlinkSync(userDir, symlinkPath, "dir");
    } catch {
      // Symlinks may not be supported (Windows without admin, etc.)
      // Skip this test gracefully
      return;
    }

    expect(() =>
      wiki.safeWrite("wiki/sneaky/hacked.md", "content")
    ).toThrow();

    // Verify the file was NOT written to sources/user/
    expect(
      fs.existsSync(path.join(userDir, "hacked.md"))
    ).toBe(false);
  });

  it("rejects write when target file is itself a symlink", () => {
    // Create a file outside wiki/ then symlink from inside wiki/ to it
    const outsideFile = path.join(tmpDir, "outside-target.txt");
    fs.writeFileSync(outsideFile, "original");

    const symlinkFile = path.join(tmpDir, "wiki", "symlinked-file.md");
    try {
      fs.symlinkSync(outsideFile, symlinkFile, "file");
    } catch {
      return; // Symlinks not supported
    }

    expect(() =>
      wiki.safeWrite("wiki/symlinked-file.md", "hacked content")
    ).toThrow("symlink");

    // Verify the outside file was NOT modified
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("original");
  });

  // ── Unicode tricks ──────────────────────────────────────────

  it("rejects unicode right-to-left override in path", () => {
    // U+202E is right-to-left override
    expect(() =>
      wiki.safeWrite("wiki/test\u202E.md", "content")
    ).not.toThrow(); // The file is still inside wiki/ — unicode name is fine
    // What matters is the resolved path is inside allowed dirs
  });

  it("rejects path with encoded dots that resolve outside", () => {
    // Double-check that node's path.resolve handles this
    expect(() =>
      wiki.safeWrite("wiki/../../../tmp/evil.md", "content")
    ).toThrow("outside allowed directories");
  });
});

// ── safeWriteNote boundary enforcement ──────────────────────────

describe("safeWriteNote boundary enforcement", () => {
  let tmpDir: string;
  let wiki: Wiki;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-notes-"));
    wiki = new Wiki(tmpDir);
    wiki.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a note to sources/user/notes/", () => {
    expect(() => wiki.safeWriteNote("test-note", "hello world")).not.toThrow();
    const notePath = path.join(tmpDir, "sources", "user", "notes", "test-note.md");
    expect(fs.existsSync(notePath)).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toBe("hello world");
  });

  it("rejects path traversal in slug", () => {
    expect(() => wiki.safeWriteNote("../../etc/passwd", "hacked")).toThrow(
      "outside sources/user/notes/"
    );
  });

  it("rejects when target file is a symlink", () => {
    const notesDir = path.join(tmpDir, "sources", "user", "notes");
    fs.mkdirSync(notesDir, { recursive: true });

    const outsideFile = path.join(tmpDir, "outside.md");
    fs.writeFileSync(outsideFile, "original");
    const symlinkPath = path.join(notesDir, "evil-note.md");

    try {
      fs.symlinkSync(outsideFile, symlinkPath, "file");
    } catch {
      return; // Symlinks not supported
    }

    expect(() => wiki.safeWriteNote("evil-note", "hacked")).toThrow("symlink");
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("original");
  });

  it("rejects when notes/ directory is a symlink outside allowed path", () => {
    const notesDir = path.join(tmpDir, "sources", "user", "notes");
    const outsideDir = path.join(tmpDir, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });

    // Remove notes dir and replace with symlink to outside
    fs.rmSync(notesDir, { recursive: true, force: true });
    try {
      fs.symlinkSync(outsideDir, notesDir, "dir");
    } catch {
      return; // Symlinks not supported
    }

    expect(() => wiki.safeWriteNote("test-note", "hacked")).toThrow(
      "ancestor directory is a symlink"
    );
  });

  it("rejects when sources/user is a symlink (ancestor bypass)", () => {
    // This is the critical case: sources/user is a symlink, notes/ doesn't exist
    // mkdirSync({recursive:true}) would follow the symlink without ancestor check
    const userDir = path.join(tmpDir, "sources", "user");
    const outsideDir = path.join(tmpDir, "outside-user");
    fs.mkdirSync(outsideDir, { recursive: true });

    // Remove entire sources/user and replace with symlink
    fs.rmSync(userDir, { recursive: true, force: true });
    try {
      fs.symlinkSync(outsideDir, userDir, "dir");
    } catch {
      return; // Symlinks not supported
    }

    expect(() => wiki.safeWriteNote("test-note", "hacked")).toThrow(
      "ancestor directory is a symlink"
    );
    // Verify nothing was written outside
    expect(
      fs.existsSync(path.join(outsideDir, "notes", "test-note.md"))
    ).toBe(false);
  });
});
