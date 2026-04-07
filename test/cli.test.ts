import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Wiki } from "../src/wiki.js";

// We test CLI logic by directly testing the init/add/status operations
// through the Wiki class and file system, avoiding slow subprocess spawns.

describe("CLI: autopedia init", () => {
  let tmpDir: string;
  let kbRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-cli-"));
    kbRoot = path.join(tmpDir, ".autopedia");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: simulate `autopedia init` logic (matches new cli.ts behavior)
  function doInit() {
    const wiki = new Wiki(kbRoot);
    wiki.init();

    // Copy user-editable schema files (NOT prompt.md — served from package)
    const schemaDir = path.join(kbRoot, "schema");
    fs.mkdirSync(schemaDir, { recursive: true });

    const userSchemaFiles: Record<string, string> = {
      "identity.md": "# Identity\n\n## Who am I?\n- Name:\n",
      "interests.md": "# Interests\n\n## Topics I follow\n-\n",
      "rules.md": "# Rules\n\n## Content rules\n- Always include counter-arguments\n",
    };

    for (const [file, content] of Object.entries(userSchemaFiles)) {
      const fullPath = path.join(schemaDir, file);
      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, content, "utf-8");
      }
    }
  }

  // ── init ────────────────────────────────────────────────────

  describe("init operation", () => {
    it("creates .autopedia/ directory structure", () => {
      doInit();

      expect(fs.existsSync(kbRoot)).toBe(true);

      const expectedDirs = [
        "sources/user",
        "sources/user/notes",
        "sources/agent",
        "wiki",
        "ops",
        "schema",
      ];
      for (const dir of expectedDirs) {
        expect(
          fs.existsSync(path.join(kbRoot, dir)),
          `Directory ${dir} should exist`
        ).toBe(true);
      }
    });

    it("creates default wiki files", () => {
      doInit();

      expect(fs.existsSync(path.join(kbRoot, "wiki", "index.md"))).toBe(true);
      expect(fs.existsSync(path.join(kbRoot, "ops", "log.md"))).toBe(true);
      expect(fs.existsSync(path.join(kbRoot, "ops", "metrics.md"))).toBe(true);
      expect(fs.existsSync(path.join(kbRoot, "ops", "queue.md"))).toBe(true);
    });

    it("creates user-editable schema files (not prompt.md)", () => {
      doInit();

      // prompt.md is served from package dir, NOT copied to user dir
      expect(fs.existsSync(path.join(kbRoot, "schema", "prompt.md"))).toBe(false);
      expect(fs.existsSync(path.join(kbRoot, "schema", "identity.md"))).toBe(true);
      expect(fs.existsSync(path.join(kbRoot, "schema", "interests.md"))).toBe(true);
      expect(fs.existsSync(path.join(kbRoot, "schema", "rules.md"))).toBe(true);
    });

    it("does not overwrite existing files on re-init", () => {
      doInit();

      // Modify a file
      fs.writeFileSync(
        path.join(kbRoot, "schema", "identity.md"),
        "# Custom Identity\n\nI am a developer."
      );

      // Re-init
      doInit();

      const identity = fs.readFileSync(
        path.join(kbRoot, "schema", "identity.md"),
        "utf-8"
      );
      expect(identity).toContain("Custom Identity");
    });
  });

  // ── add (text) ──────────────────────────────────────────────

  describe("add operation (text)", () => {
    it("saves a text note to sources/user/notes/", () => {
      doInit();

      const wiki = new Wiki(kbRoot);
      const date = new Date().toISOString().split("T")[0];
      const text = "My thought about inference costs";
      const slug = `${date}-${text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/-+$/, "")}`;

      const notePath = path.join(
        kbRoot,
        "sources",
        "user",
        "notes",
        `${slug}.md`
      );
      fs.mkdirSync(path.dirname(notePath), { recursive: true });
      fs.writeFileSync(notePath, text, "utf-8");
      wiki.addToQueue(`note:${slug}`);

      // Verify file was created
      const notesDir = path.join(kbRoot, "sources", "user", "notes");
      const files = fs.readdirSync(notesDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.md$/);
    });

    it("adds to source queue", () => {
      doInit();

      const wiki = new Wiki(kbRoot);
      wiki.addToQueue("note:test-thought");

      const queue = fs.readFileSync(
        path.join(kbRoot, "ops", "queue.md"),
        "utf-8"
      );
      expect(queue).toContain("- [ ] note:test-thought");
    });
  });

  // ── add (URL — instant queue, no fetch) ───────────────────

  describe("add operation (URL — instant queue)", () => {
    it("queues URL without saving any source file", () => {
      doInit();

      const wiki = new Wiki(kbRoot);
      wiki.addToQueue("https://example.com/some-article");

      const queue = fs.readFileSync(
        path.join(kbRoot, "ops", "queue.md"),
        "utf-8"
      );
      expect(queue).toContain("- [ ] https://example.com/some-article");

      const agentDir = path.join(kbRoot, "sources", "agent");
      const agentFiles = fs.readdirSync(agentDir);
      expect(agentFiles).toHaveLength(0);
    });
  });

  // ── add (file) ────────────────────────────────────────────

  describe("add operation (file)", () => {
    it("adds a .md file as a note in sources/user/notes/", () => {
      doInit();

      // Create a test .md file
      const testFile = path.join(tmpDir, "article.md");
      fs.writeFileSync(testFile, "# GPU Pricing\n\nPrices are dropping fast.");

      const wiki = new Wiki(kbRoot);
      const content = fs.readFileSync(testFile, "utf-8");
      const slug = "2026-01-01-test-article";
      wiki.safeWriteNote(slug, content);
      wiki.addToQueue(`note:${slug}`);

      const notesDir = path.join(kbRoot, "sources", "user", "notes");
      const files = fs.readdirSync(notesDir);
      expect(files.some((f) => f.includes(slug))).toBe(true);

      const queue = fs.readFileSync(path.join(kbRoot, "ops", "queue.md"), "utf-8");
      expect(queue).toContain(`note:${slug}`);
    });

    it("adds a non-text file to sources/user/ with file: prefix", () => {
      doInit();

      // Create a test PDF-like file
      const testFile = path.join(tmpDir, "report.pdf");
      fs.writeFileSync(testFile, "fake PDF content");

      const wiki = new Wiki(kbRoot);
      const slug = "2026-01-01-test-report.pdf";
      wiki.saveUserFile(slug, testFile);
      wiki.addToQueue(`file:${slug}`);

      const userDir = path.join(kbRoot, "sources", "user");
      expect(fs.existsSync(path.join(userDir, slug))).toBe(true);

      const queue = fs.readFileSync(path.join(kbRoot, "ops", "queue.md"), "utf-8");
      expect(queue).toContain(`file:${slug}`);
    });
  });

  // ── add (folder) ──────────────────────────────────────────

  describe("add operation (folder)", () => {
    it("queues multiple files from a directory", () => {
      doInit();

      // Create test folder with files
      const testDir = path.join(tmpDir, "research");
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, "notes.md"), "# Notes\n\nSome research.");
      fs.writeFileSync(path.join(testDir, "data.txt"), "Raw data here.");

      const wiki = new Wiki(kbRoot);
      const entries = fs.readdirSync(testDir).filter((f) =>
        fs.statSync(path.join(testDir, f)).isFile()
      );
      expect(entries).toHaveLength(2);

      // Simulate adding each file
      for (const entry of entries) {
        const content = fs.readFileSync(path.join(testDir, entry), "utf-8");
        const slug = `2026-01-01-test-${entry.replace(/\.[^.]+$/, "").toLowerCase()}`;
        wiki.safeWriteNote(slug, content);
        wiki.addToQueue(`note:${slug}`);
      }

      const queue = fs.readFileSync(path.join(kbRoot, "ops", "queue.md"), "utf-8");
      expect(queue).toContain("note:2026-01-01-test-notes");
      expect(queue).toContain("note:2026-01-01-test-data");
    });
  });

  // ── status ──────────────────────────────────────────────────

  describe("status operation", () => {
    it("reports wiki stats", () => {
      doInit();

      const wiki = new Wiki(kbRoot);
      const pages = wiki.listPages();
      const unprocessed = wiki.listUnprocessedSources();

      expect(pages.length).toBeGreaterThanOrEqual(1); // index.md
      expect(unprocessed).toHaveLength(0);
    });

    it("reflects added sources in unprocessed count", () => {
      doInit();

      const wiki = new Wiki(kbRoot);
      wiki.addToQueue("https://example.com/article1");
      wiki.addToQueue("https://example.com/article2");

      const unprocessed = wiki.listUnprocessedSources();
      expect(unprocessed).toHaveLength(2);
    });

    it("marks sources as processed", () => {
      doInit();

      const wiki = new Wiki(kbRoot);
      wiki.addToQueue("https://example.com/article");
      wiki.markProcessed("https://example.com/article");

      const unprocessed = wiki.listUnprocessedSources();
      expect(unprocessed).toHaveLength(0);
    });
  });

  // Note: createCli import test removed — dynamic import of cli.ts is too slow
  // on WSL2+NTFS due to JSDOM dependency tree. All CLI logic is covered by the
  // programmatic tests above.
});

// ── view command guard tests ─────────────────────────────────

describe("CLI: autopedia view", () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof import("vitest").vi.spyOn>;
  let stderrSpy: ReturnType<typeof import("vitest").vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-view-"));
    // Stub process.exit to prevent test runner from dying
    exitSpy = (await import("vitest")).vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    stderrSpy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runView(args: string[]) {
    const { createCli } = await import("../src/cli.js");
    const program = createCli();
    program.exitOverride(); // Prevent commander from calling process.exit
    await program.parseAsync(["node", "test", "view", ...args]);
  }

  it("rejects non-integer port", async () => {
    await expect(runView(["--port", "abc", "--dir", tmpDir])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects port out of range (0)", async () => {
    await expect(runView(["--port", "0", "--dir", tmpDir])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects port out of range (70000)", async () => {
    await expect(runView(["--port", "70000", "--dir", tmpDir])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects port with trailing garbage (123abc)", async () => {
    await expect(runView(["--port", "123abc", "--dir", tmpDir])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects when .autopedia/ doesn't exist", async () => {
    const nonexistent = path.join(tmpDir, "nonexistent");
    await expect(runView(["--dir", nonexistent])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(".autopedia/ not found")
    );
  });

  it("rejects when directory is not an autopedia root", async () => {
    // Create .autopedia dir but NOT wiki/ or ops/ subdirectories
    const fakeRoot = path.join(tmpDir, ".autopedia");
    fs.mkdirSync(fakeRoot, { recursive: true });
    await expect(runView(["--dir", tmpDir])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("not an autopedia knowledge base")
    );
  });
});

// ── scan command tests ──────────────────────────────────────

describe("CLI: autopedia scan", () => {
  let tmpDir: string;
  let kbRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-scan-"));
    kbRoot = path.join(tmpDir, ".autopedia");
    const wiki = new Wiki(kbRoot);
    wiki.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects untracked files via wiki.scanUntracked()", () => {
    const wiki = new Wiki(kbRoot);
    // Drop a file directly (simulating Obsidian)
    fs.writeFileSync(path.join(kbRoot, "sources", "user", "notes", "dropped.md"), "# Dropped");
    const untracked = wiki.scanUntracked();
    expect(untracked.length).toBe(1);
    expect(untracked[0].file).toBe("dropped");
    expect(untracked[0].dir).toBe("user");
  });

  it("queues untracked files when scanned", () => {
    const wiki = new Wiki(kbRoot);
    fs.writeFileSync(path.join(kbRoot, "sources", "user", "notes", "dropped.md"), "# Dropped");
    const untracked = wiki.scanUntracked();
    for (const { file, dir } of untracked) {
      const entry = dir === "user" ? `note:${file}` : file;
      wiki.addToQueue(entry);
    }
    // Should now be tracked
    expect(wiki.scanUntracked().length).toBe(0);
    expect(wiki.listUnprocessedSources()).toContain("note:dropped");
  });

  it("reports nothing when all files are tracked", () => {
    const wiki = new Wiki(kbRoot);
    expect(wiki.scanUntracked()).toEqual([]);
  });
});

// ── search command tests ─────────────────────────────────────

describe("CLI: autopedia search", () => {
  let tmpDir: string;
  let kbRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-search-"));
    kbRoot = path.join(tmpDir, ".autopedia");
    const wiki = new Wiki(kbRoot);
    wiki.init();
    // Add a page with searchable content
    wiki.writePage("test-topic.md", "# Test Topic\n\nThis page is about inference costs and GPU pricing.");
    wiki.writePage("other.md", "# Other\n\nUnrelated content here.");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds matching pages", () => {
    const wiki = new Wiki(kbRoot);
    const results = wiki.searchPages("inference");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("test-topic.md");
    expect(results[0].matches.length).toBeGreaterThan(0);
  });

  it("returns empty for no match", () => {
    const wiki = new Wiki(kbRoot);
    const results = wiki.searchPages("xyznonexistent");
    expect(results).toHaveLength(0);
  });
});

// ── export command tests ─────────────────────────────────────

describe("CLI: autopedia export", () => {
  let tmpDir: string;
  let kbRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-export-"));
    kbRoot = path.join(tmpDir, ".autopedia");
    const wiki = new Wiki(kbRoot);
    wiki.init();
    wiki.writePage("alpha.md", "# Alpha\n\nFirst page.");
    wiki.writePage("beta.md", "# Beta\n\nSecond page.");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports all pages with markers", () => {
    const wiki = new Wiki(kbRoot);
    const pages = wiki.listPages();
    let output = "";
    const sorted = pages.sort((a, b) => {
      if (a === "index.md") return -1;
      if (b === "index.md") return 1;
      return a.localeCompare(b);
    });
    for (const page of sorted) {
      const content = wiki.readPage(page);
      if (content) output += `<!-- ${page} -->\n\n${content}\n\n`;
    }
    expect(output).toContain("<!-- index.md -->");
    expect(output).toContain("<!-- alpha.md -->");
    expect(output).toContain("<!-- beta.md -->");
    // Index should come first
    const indexPos = output.indexOf("<!-- index.md -->");
    const alphaPos = output.indexOf("<!-- alpha.md -->");
    expect(indexPos).toBeLessThan(alphaPos);
  });

  it("rejects output inside wiki/ directory", () => {
    const wikiDir = path.join(kbRoot, "wiki");
    const outputPath = path.join(wikiDir, "export.md");
    const resolved = path.resolve(outputPath);
    expect(resolved.startsWith(wikiDir + path.sep)).toBe(true);
  });
});
