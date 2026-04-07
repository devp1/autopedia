import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Wiki } from "../src/wiki.js";

describe("Wiki CRUD operations", () => {
  let tmpDir: string;
  let wiki: Wiki;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-wiki-"));
    wiki = new Wiki(tmpDir);
    wiki.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Init ──────────────────────────────────────────────────────

  describe("init()", () => {
    it("creates all required directories", () => {
      const dirs = [
        "sources/user",
        "sources/user/notes",
        "sources/agent",
        "wiki",
        "ops",
        "schema",
      ];
      for (const dir of dirs) {
        expect(fs.existsSync(path.join(tmpDir, dir))).toBe(true);
      }
    });

    it("creates default files", () => {
      expect(fs.existsSync(path.join(tmpDir, "wiki", "index.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "ops", "log.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "ops", "metrics.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "ops", "queue.md"))).toBe(true);
    });

    it("does not overwrite existing files on re-init", () => {
      wiki.writePage("index.md", "# Custom Index");
      wiki.init();
      expect(wiki.readIndex()).toBe("# Custom Index");
    });
  });

  // ── Read/Write pages ──────────────────────────────────────────

  describe("readPage() / writePage()", () => {
    it("writes and reads a page", () => {
      wiki.writePage("test.md", "# Test Page\n\nHello world.");
      const content = wiki.readPage("test.md");
      expect(content).toBe("# Test Page\n\nHello world.");
    });

    it("returns null for non-existent page", () => {
      expect(wiki.readPage("nonexistent.md")).toBeNull();
    });

    it("writes to nested directories", () => {
      wiki.writePage("topics/ai/transformers.md", "# Transformers");
      expect(wiki.readPage("topics/ai/transformers.md")).toBe(
        "# Transformers"
      );
    });

    it("overwrites existing page", () => {
      wiki.writePage("test.md", "v1");
      wiki.writePage("test.md", "v2");
      expect(wiki.readPage("test.md")).toBe("v2");
    });

    it("rejects read outside wiki/", () => {
      expect(() => wiki.readPage("../ops/log.md")).toThrow(
        "outside wiki/"
      );
    });
  });

  // ── List pages ────────────────────────────────────────────────

  describe("listPages()", () => {
    it("returns empty array for empty wiki", () => {
      // index.md was created by init
      const pages = wiki.listPages();
      expect(pages).toContain("index.md");
    });

    it("lists all pages recursively", () => {
      wiki.writePage("page1.md", "content");
      wiki.writePage("topics/page2.md", "content");
      wiki.writePage("topics/sub/page3.md", "content");
      const pages = wiki.listPages();
      expect(pages).toContain("page1.md");
      expect(pages).toContain(path.join("topics", "page2.md"));
      expect(pages).toContain(path.join("topics", "sub", "page3.md"));
    });

    it("lists pages in a subdirectory", () => {
      wiki.writePage("topics/ai.md", "content");
      wiki.writePage("topics/ml.md", "content");
      wiki.writePage("other.md", "content");
      const pages = wiki.listPages("topics");
      expect(pages).toHaveLength(2);
      expect(pages).toContain(path.join("topics", "ai.md"));
      expect(pages).toContain(path.join("topics", "ml.md"));
    });

    it("returns sorted results", () => {
      wiki.writePage("z-page.md", "content");
      wiki.writePage("a-page.md", "content");
      const pages = wiki.listPages();
      const aIdx = pages.indexOf("a-page.md");
      const zIdx = pages.indexOf("z-page.md");
      expect(aIdx).toBeLessThan(zIdx);
    });
  });

  // ── Search ────────────────────────────────────────────────────

  describe("searchPages()", () => {
    it("finds pages containing the query", () => {
      wiki.writePage("gpu.md", "# GPU Pricing\n\nNVIDIA H100 costs $30k");
      wiki.writePage("cpu.md", "# CPU Pricing\n\nAMD EPYC is cheap");
      const results = wiki.searchPages("GPU");
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("gpu.md");
      expect(results[0].matches.length).toBeGreaterThan(0);
    });

    it("is case-insensitive", () => {
      wiki.writePage("test.md", "Machine Learning is great");
      const results = wiki.searchPages("machine learning");
      expect(results).toHaveLength(1);
    });

    it("returns empty for no matches", () => {
      wiki.writePage("test.md", "Hello world");
      const results = wiki.searchPages("quantum computing");
      expect(results).toHaveLength(0);
    });

    it("limits matches per page to 5", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}: GPU GPU GPU`);
      wiki.writePage("many.md", lines.join("\n"));
      const results = wiki.searchPages("GPU");
      expect(results[0].matches).toHaveLength(5);
    });
  });

  // ── Index ─────────────────────────────────────────────────────

  describe("readIndex()", () => {
    it("reads the default index", () => {
      const index = wiki.readIndex();
      expect(index).toContain("Wiki Index");
    });

    it("reads updated index", () => {
      wiki.writePage("index.md", "# Updated Index\n\n- [[page1]]");
      expect(wiki.readIndex()).toContain("Updated Index");
    });
  });

  // ── Log ───────────────────────────────────────────────────────

  describe("appendLog()", () => {
    it("appends to operations log", () => {
      wiki.appendLog("Created page: test.md");
      const logContent = fs.readFileSync(
        path.join(tmpDir, "ops", "log.md"),
        "utf-8"
      );
      expect(logContent).toContain("Created page: test.md");
    });

    it("appends multiple entries", () => {
      wiki.appendLog("Entry 1");
      wiki.appendLog("Entry 2");
      const logContent = fs.readFileSync(
        path.join(tmpDir, "ops", "log.md"),
        "utf-8"
      );
      expect(logContent).toContain("Entry 1");
      expect(logContent).toContain("Entry 2");
    });

    it("includes timestamps", () => {
      wiki.appendLog("test entry");
      const logContent = fs.readFileSync(
        path.join(tmpDir, "ops", "log.md"),
        "utf-8"
      );
      // ISO timestamp pattern
      expect(logContent).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ── Metrics ───────────────────────────────────────────────────

  describe("updateMetrics()", () => {
    it("writes correct page count", () => {
      wiki.writePage("page1.md", "content");
      wiki.writePage("page2.md", "content");
      wiki.updateMetrics();
      const metrics = fs.readFileSync(
        path.join(tmpDir, "ops", "metrics.md"),
        "utf-8"
      );
      // index.md + page1.md + page2.md = 3
      expect(metrics).toContain("**Page count**: 3");
    });

    it("lists page names", () => {
      wiki.writePage("gpu-pricing.md", "content");
      wiki.updateMetrics();
      const metrics = fs.readFileSync(
        path.join(tmpDir, "ops", "metrics.md"),
        "utf-8"
      );
      expect(metrics).toContain("gpu-pricing.md");
    });
  });

  // ── Source operations ─────────────────────────────────────────

  describe("source operations", () => {
    it("saves agent source", () => {
      wiki.saveAgentSource("2024-01-01-article", "# Article\n\nContent");
      expect(
        fs.existsSync(
          path.join(tmpDir, "sources", "agent", "2024-01-01-article.md")
        )
      ).toBe(true);
    });

    it("manages the source queue", () => {
      wiki.addToQueue("https://example.com/article");
      const unprocessed = wiki.listUnprocessedSources();
      expect(unprocessed).toContain("https://example.com/article");

      wiki.markProcessed("https://example.com/article");
      const remaining = wiki.listUnprocessedSources();
      expect(remaining).not.toContain("https://example.com/article");
    });
  });

  // ── Link extraction & graph ──────────────────────────────────

  describe("extractLinks()", () => {
    it("returns wikilink targets from page content", () => {
      wiki.writePage("linked.md", "# Test\n\nSee [[page-a]] and [[page-b]].");
      const links = wiki.extractLinks("linked.md");
      expect(links).toEqual(["page-a", "page-b"]);
    });

    it("skips wikilinks inside code blocks", () => {
      wiki.writePage("code.md", "# Test\n\n```\n[[not-a-link]]\n```\n\n[[real-link]]");
      const links = wiki.extractLinks("code.md");
      expect(links).toEqual(["real-link"]);
    });

    it("returns empty array for page with no links", () => {
      wiki.writePage("plain.md", "# No links here");
      expect(wiki.extractLinks("plain.md")).toEqual([]);
    });
  });

  describe("buildGraph()", () => {
    it("returns nodes and edges from wikilinks", () => {
      wiki.writePage("a.md", "# A\n\nSee [[b]].");
      wiki.writePage("b.md", "# B\n\nSee [[a]].");
      const graph = wiki.buildGraph();
      expect(graph.nodes).toContain("a");
      expect(graph.nodes).toContain("b");
      expect(graph.edges).toContainEqual({ source: "a", target: "b" });
      expect(graph.edges).toContainEqual({ source: "b", target: "a" });
    });

    it("normalizes .md suffix in link targets", () => {
      wiki.writePage("c.md", "# C\n\n[[d.md]]");
      wiki.writePage("d.md", "# D");
      const graph = wiki.buildGraph();
      expect(graph.edges).toContainEqual({ source: "c", target: "d" });
    });
  });

  describe("getBacklinks()", () => {
    it("finds pages that link to a given page", () => {
      wiki.writePage("src.md", "# Src\n\n[[target]]");
      wiki.writePage("target.md", "# Target");
      expect(wiki.getBacklinks("target")).toEqual(["src"]);
    });

    it("returns empty array when no backlinks exist", () => {
      wiki.writePage("lonely.md", "# Lonely page");
      expect(wiki.getBacklinks("lonely")).toEqual([]);
    });
  });

  // ── Scan untracked ──────────────────────────────────────────

  describe("scanUntracked()", () => {
    it("detects files not in queue or log", () => {
      // Write a source file directly (simulating Obsidian drop)
      const notesDir = path.join(tmpDir, "sources", "user", "notes");
      fs.writeFileSync(path.join(notesDir, "dropped-note.md"), "# Dropped via Obsidian");
      const untracked = wiki.scanUntracked();
      expect(untracked).toContainEqual({ file: "dropped-note.md", dir: "user" });
    });

    it("ignores files already in queue", () => {
      wiki.addToQueue("note:tracked-file");
      const notesDir = path.join(tmpDir, "sources", "user", "notes");
      fs.writeFileSync(path.join(notesDir, "tracked-file.md"), "# Tracked");
      const untracked = wiki.scanUntracked();
      expect(untracked.find(u => u.file === "tracked-file.md")).toBeUndefined();
    });

    it("returns empty when all files are tracked", () => {
      expect(wiki.scanUntracked()).toEqual([]);
    });

    it("detects binary files in sources/user/", () => {
      const userDir = path.join(tmpDir, "sources", "user");
      fs.writeFileSync(path.join(userDir, "report.pdf"), "binary content");
      const untracked = wiki.scanUntracked();
      expect(untracked.find(u => u.file === "report.pdf")).toBeDefined();
    });
  });

  // ── Delete operations ─────────────────────────────────────────

  describe("removePage()", () => {
    it("deletes a wiki page", () => {
      wiki.writePage("doomed.md", "# Doomed");
      expect(wiki.removePage("doomed")).toBe(true);
      expect(wiki.readPage("doomed.md")).toBeNull();
    });

    it("returns false for non-existent page", () => {
      expect(wiki.removePage("ghost")).toBe(false);
    });

    it("removes deleted page from index", () => {
      wiki.writePage("indexed.md", "# Indexed");
      wiki.writePage("index.md", "# Index\n\n- [[indexed]] — a page");
      wiki.removePage("indexed");
      const index = wiki.readPage("index.md");
      expect(index).not.toContain("[[indexed]]");
    });

    it("rejects path traversal", () => {
      expect(() => wiki.removePage("../etc/passwd")).toThrow("outside");
    });
  });

  describe("reconcileAfterDelete()", () => {
    it("finds pages with broken refs after deletion", () => {
      wiki.writePage("linker.md", "# Linker\n\nSee [[victim]].");
      wiki.writePage("victim.md", "# Victim");
      wiki.removePage("victim");
      expect(wiki.reconcileAfterDelete("victim")).toContain("linker");
    });

    it("handles [[page.md]] style refs", () => {
      wiki.writePage("ref.md", "# Ref\n\nSee [[target.md]].");
      expect(wiki.reconcileAfterDelete("target")).toContain("ref");
    });
  });

  describe("removeSource()", () => {
    it("deletes an agent source", () => {
      wiki.saveAgentSource("test-source", "# Content");
      expect(wiki.removeSource("test-source")).toBe(true);
    });

    it("removes queue entry when deleting source", () => {
      wiki.addToQueue("note:queued-src");
      const notesDir = path.join(tmpDir, "sources", "user", "notes");
      fs.writeFileSync(path.join(notesDir, "queued-src.md"), "# Queued");
      wiki.removeSource("queued-src");
      expect(wiki.listUnprocessedSources()).not.toContain("note:queued-src");
    });

    it("returns false for non-existent source", () => {
      expect(wiki.removeSource("ghost")).toBe(false);
    });

    it("rejects path traversal", () => {
      expect(() => wiki.removeSource("../../etc/passwd")).toThrow("invalid slug");
    });
  });
});
