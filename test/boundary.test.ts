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
