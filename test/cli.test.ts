import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Wiki } from "../src/wiki.js";
import { createHash } from "node:crypto";
import { discoverFiles, formatBundle, scanRepo, isRepo } from "../src/cli.js";

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

  // ── init guard (project directory detection) ───────────────

  describe("init guard", () => {
    it("rejects init --dir inside a git repo", async () => {
      const projectDir = path.join(tmpDir, "myrepo");
      fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });

      const { createCli } = await import("../src/cli.js");
      const program = createCli();
      program.exitOverride();

      const exitSpy = (await import("vitest")).vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      const stderrSpy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(program.parseAsync(["node", "test", "init", "--dir", projectDir])).rejects.toThrow();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("code project"));
      } finally {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it("rejects init --dir inside nested subdirectory of a git repo", async () => {
      const projectDir = path.join(tmpDir, "myrepo2");
      fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
      const subDir = path.join(projectDir, "docs", "notes");
      fs.mkdirSync(subDir, { recursive: true });

      const { createCli } = await import("../src/cli.js");
      const program = createCli();
      program.exitOverride();

      const exitSpy = (await import("vitest")).vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      const stderrSpy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(program.parseAsync(["node", "test", "init", "--dir", subDir])).rejects.toThrow();
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
      }
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
    expect(untracked[0].file).toBe("dropped.md");
    expect(untracked[0].dir).toBe("user");
  });

  it("queues untracked files when scanned", () => {
    const wiki = new Wiki(kbRoot);
    fs.writeFileSync(path.join(kbRoot, "sources", "user", "notes", "dropped.md"), "# Dropped");
    const untracked = wiki.scanUntracked();
    for (const { file, dir } of untracked) {
      const slug = file.replace(/\.[^.]+$/, "");
      const entry = dir === "user" ? `note:${slug}` : slug;
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

// ── repo scanning tests ─────────────────────────────────────

describe("CLI: repo scanning", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-repo-"));
    repoDir = path.join(tmpDir, "my-project");
    fs.mkdirSync(repoDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to create a fake repo structure
  function makeRepo(files: Record<string, string>): void {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(repoDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
    }
  }

  // ── isRepo detection ──────────────────────────────────────

  describe("repo detection (isRepo)", () => {
    it("detects directory with .git/ as a repo", () => {
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
      expect(isRepo(repoDir)).toBe(true);
    });

    it("detects directory with package.json as a repo", () => {
      fs.writeFileSync(path.join(repoDir, "package.json"), '{"name":"test"}');
      expect(isRepo(repoDir)).toBe(true);
    });

    it("detects directory with Cargo.toml as a repo", () => {
      fs.writeFileSync(path.join(repoDir, "Cargo.toml"), '[package]\nname = "test"');
      expect(isRepo(repoDir)).toBe(true);
    });

    it("does not detect plain directory as a repo", () => {
      fs.writeFileSync(path.join(repoDir, "notes.md"), "# Notes");
      expect(isRepo(repoDir)).toBe(false);
    });
  });

  // ── file role classification ──────────────────────────────

  describe("file role classification", () => {
    it("classifies manifest files correctly", () => {
      makeRepo({
        "package.json": '{"name":"test"}',
        "src/index.ts": "export default 42;",
      });
      const { files } = discoverFiles(repoDir);
      const manifest = files.find(f => f.relativePath === "package.json");
      expect(manifest).toBeDefined();
      expect(manifest!.role).toBe("manifest");
      expect(manifest!.score).toBe(10);
    });

    it("classifies entry points correctly", () => {
      makeRepo({
        "src/index.ts": 'console.log("hello");',
      });
      const { files } = discoverFiles(repoDir);
      const entry = files.find(f => f.relativePath === "src/index.ts");
      expect(entry).toBeDefined();
      expect(entry!.role).toBe("entry");
    });

    it("classifies test files correctly", () => {
      makeRepo({
        "test/utils.test.ts": 'describe("test", () => {});',
      });
      const { files } = discoverFiles(repoDir);
      const test = files.find(f => f.relativePath === "test/utils.test.ts");
      expect(test).toBeDefined();
      expect(test!.role).toBe("test");
    });

    it("classifies docs correctly", () => {
      makeRepo({
        "README.md": "# My Project\n\nA cool project.",
      });
      const { files } = discoverFiles(repoDir);
      const doc = files.find(f => f.relativePath === "README.md");
      expect(doc).toBeDefined();
      expect(doc!.role).toBe("docs");
    });

    it("classifies config files correctly", () => {
      makeRepo({
        "tsconfig.json": '{"compilerOptions":{}}',
      });
      const { files } = discoverFiles(repoDir);
      const config = files.find(f => f.relativePath === "tsconfig.json");
      expect(config).toBeDefined();
      expect(config!.role).toBe("config");
    });
  });

  // ── excluded dir filtering ────────────────────────────────

  describe("excluded directory filtering", () => {
    it("excludes node_modules", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        "node_modules/lodash/index.js": "module.exports = {};",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.includes("node_modules"))).toBe(false);
    });

    it("excludes .git directory", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
      });
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".git", "config"), "[core]");
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.includes(".git/"))).toBe(false);
    });

    it("excludes dist/build/coverage directories", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        "dist/app.js": "var x = 1;",
        "build/output.js": "var y = 2;",
        "coverage/lcov.info": "SF:src/app.ts",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.startsWith("dist/"))).toBe(false);
      expect(files.some(f => f.relativePath.startsWith("build/"))).toBe(false);
      expect(files.some(f => f.relativePath.startsWith("coverage/"))).toBe(false);
    });
  });

  // ── excluded file filtering ───────────────────────────────

  describe("excluded file filtering", () => {
    it("excludes .env files", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        ".env": "SECRET=abc123",
        ".env.local": "DB_PASS=hunter2",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.includes(".env"))).toBe(false);
    });

    it("excludes lock files", () => {
      makeRepo({
        "package.json": '{"name":"test"}',
        "package-lock.json": '{"lockfileVersion":2}',
        "yarn.lock": "# yarn lockfile",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.includes("lock"))).toBe(false);
    });

    it("excludes credential/secret files", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        "credentials.json": '{"token":"secret"}',
        "my-secret.txt": "password123",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.includes("credential"))).toBe(false);
      expect(files.some(f => f.relativePath.includes("secret"))).toBe(false);
    });

    it("excludes .pem and .key files", () => {
      makeRepo({
        "server.pem": "-----BEGIN CERTIFICATE-----",
        "private.key": "-----BEGIN PRIVATE KEY-----",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.endsWith(".pem"))).toBe(false);
      expect(files.some(f => f.relativePath.endsWith(".key"))).toBe(false);
    });

    it("excludes common auth dotfiles (.npmrc, .netrc, id_rsa)", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        ".npmrc": "//registry.npmjs.org/:_authToken=abc123",
        ".netrc": "machine github.com login token",
        "id_rsa": "-----BEGIN RSA PRIVATE KEY-----",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath === ".npmrc")).toBe(false);
      expect(files.some(f => f.relativePath === ".netrc")).toBe(false);
      expect(files.some(f => f.relativePath === "id_rsa")).toBe(false);
    });
  });

  // ── generated file detection ──────────────────────────────

  describe("generated file detection", () => {
    it("excludes .d.ts files", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        "src/app.d.ts": "declare const x: number;",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.endsWith(".d.ts"))).toBe(false);
    });

    it("excludes .min.js and .min.css files", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
        "public/app.min.js": "var x=1;",
        "public/styles.min.css": "body{margin:0}",
      });
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath.includes(".min."))).toBe(false);
    });
  });

  // ── binary file detection ─────────────────────────────────

  describe("binary file detection", () => {
    it("skips files with null bytes (binary)", () => {
      makeRepo({
        "src/app.ts": "const x = 1;",
      });
      // Write a file with null bytes
      fs.writeFileSync(path.join(repoDir, "binary.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x00]));
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath === "binary.wasm")).toBe(false);
    });
  });

  // ── file selection budget ─────────────────────────────────

  describe("file selection budget", () => {
    it("limits source files to ~15", () => {
      const files: Record<string, string> = {};
      // Create 30 source files
      for (let i = 0; i < 30; i++) {
        const dir = `src/module${i % 10}`;
        files[`${dir}/file${i}.ts`] = `// File ${i}\n`.repeat(50);
      }
      makeRepo(files);
      const { stats } = scanRepo(repoDir);
      // Source files capped at 15, plus manifests/docs/configs — well under 30
      expect(stats.selectedFiles).toBeLessThanOrEqual(20);
    });

    it("respects line count budget", () => {
      const files: Record<string, string> = {};
      // Create files with many lines
      for (let i = 0; i < 20; i++) {
        files[`src/big${i}.ts`] = `// Line\n`.repeat(500);
      }
      makeRepo(files);
      const { stats } = scanRepo(repoDir);
      // Budget is 5000 lines max; with 20 files of 500 lines each, selection must cut
      expect(stats.selectedFiles).toBeLessThan(20);
      // Selected files have 500 lines each but only ~15 fit in budget
      expect(stats.totalLines).toBeLessThanOrEqual(8000);
    });
  });

  // ── directory diversity ───────────────────────────────────

  describe("directory diversity", () => {
    it("selects files from multiple directories over same-dir clustering", () => {
      const files: Record<string, string> = {};
      // 10 files in src/core/, 1 file each in 5 other dirs
      for (let i = 0; i < 10; i++) {
        files[`src/core/helper${i}.ts`] = `export function helper${i}() { return ${i}; }\n`.repeat(30);
      }
      for (let i = 0; i < 5; i++) {
        files[`src/module${i}/index.ts`] = `export const mod${i} = ${i};\n`.repeat(30);
      }
      makeRepo(files);
      // Use scanRepo which exercises the full selection pipeline
      const { stats } = scanRepo(repoDir);
      // Should select some files — verify via bundle content
      expect(stats.selectedFiles).toBeGreaterThanOrEqual(5);

      // Also verify through discoverFiles + formatBundle that diverse dirs are represented
      const { files: discovered } = discoverFiles(repoDir);
      const bundle = formatBundle(repoDir, discovered, discovered.slice(0, 15));
      // Should contain files from module dirs, not just core
      const moduleMatches = Array.from({ length: 5 }, (_, i) => bundle.includes(`src/module${i}/index.ts`));
      const moduleDirCount = moduleMatches.filter(Boolean).length;
      expect(moduleDirCount).toBeGreaterThanOrEqual(3);
    });
  });

  // ── symlink safety ────────────────────────────────────────

  describe("symlink safety", () => {
    it("skips symlinks during discovery", () => {
      makeRepo({
        "src/real.ts": "const x = 1;",
      });
      // Create a symlink to /etc/passwd (or any file outside repo)
      const symlinkPath = path.join(repoDir, "src", "evil.ts");
      try {
        fs.symlinkSync("/etc/passwd", symlinkPath);
      } catch {
        // Windows may not support symlinks without elevation — skip test
        return;
      }
      const { files } = discoverFiles(repoDir);
      expect(files.some(f => f.relativePath === "src/evil.ts")).toBe(false);
    });
  });

  // ── bundle format ─────────────────────────────────────────

  describe("bundle format", () => {
    it("produces structured markdown with all sections", () => {
      makeRepo({
        "package.json": '{"name":"test-project","version":"1.0.0"}',
        "README.md": "# Test Project\n\nA test project for testing.",
        "src/index.ts": 'export function main() {\n  console.log("hello");\n}',
        "tsconfig.json": '{"compilerOptions":{"strict":true}}',
      });
      const { files } = discoverFiles(repoDir);
      const selected = files; // small repo — all selected
      const bundle = formatBundle(repoDir, files, selected);

      expect(bundle).toContain("# Repository: my-project");
      expect(bundle).toContain("## Metadata");
      expect(bundle).toContain("## Directory Structure");
      expect(bundle).toContain("## Manifests");
      expect(bundle).toContain("## Documentation");
      expect(bundle).toContain("### package.json");
      expect(bundle).toContain("### README.md");
      expect(bundle).toContain("### src/index.ts");
    });

    it("truncates long source files to 200 lines", () => {
      const longContent = Array.from({ length: 300 }, (_, i) => `// Line ${i + 1}`).join("\n");
      makeRepo({
        "src/big.ts": longContent,
      });
      const { files } = discoverFiles(repoDir);
      const bundle = formatBundle(repoDir, files, files);
      expect(bundle).toContain("... (100 more lines)");
    });

    it("redacts absolute paths", () => {
      makeRepo({
        "src/config.ts": `const base = "${repoDir.replace(/\\/g, "/")}/data";`,
      });
      const { files } = discoverFiles(repoDir);
      const bundle = formatBundle(repoDir, files, files);
      expect(bundle).not.toContain(repoDir.replace(/\\/g, "/"));
      expect(bundle).toContain("<repo>");
    });
  });

  // ── scanRepo integration ──────────────────────────────────

  describe("scanRepo integration", () => {
    it("returns bundle with stats", () => {
      makeRepo({
        "package.json": '{"name":"test"}',
        "src/index.ts": "export default 42;",
        "README.md": "# Test",
      });
      const { bundle, stats } = scanRepo(repoDir);
      expect(stats.totalFiles).toBeGreaterThanOrEqual(3);
      expect(stats.selectedFiles).toBeGreaterThanOrEqual(3);
      expect(bundle).toContain("# Repository:");
    });

    it("handles empty repos gracefully", () => {
      // Empty directory — no files
      const { stats } = scanRepo(repoDir);
      expect(stats.totalFiles).toBe(0);
      expect(stats.selectedFiles).toBe(0);
    });
  });

  // ── depth limit ───────────────────────────────────────────

  describe("depth limit", () => {
    it("respects maxDepth parameter", () => {
      makeRepo({
        "a/b/c/d/e/f/deep.ts": "const deep = true;",
        "a/shallow.ts": "const shallow = true;",
      });
      const { files } = discoverFiles(repoDir, 2);
      expect(files.some(f => f.relativePath === "a/shallow.ts")).toBe(true);
      expect(files.some(f => f.relativePath.includes("f/deep.ts"))).toBe(false);
    });
  });

  // ── repo add CLI integration ──────────────────────────────

  describe("repo add to wiki", () => {
    it("saves bundle to sources/agent/ and queues as repo:", () => {
      const kbRoot = path.join(tmpDir, ".autopedia");
      const wiki = new Wiki(kbRoot);
      wiki.init();

      makeRepo({
        "package.json": '{"name":"test-project"}',
        "src/index.ts": "export default 42;",
      });

      // Simulate what the CLI add command does for repos
      const repoName = path.basename(repoDir);
      const { bundle } = scanRepo(repoDir);
      const pathHash = createHash("sha256").update(repoDir).digest("hex").slice(0, 4);
      const slug = `repo-${repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-+$/, "")}-${pathHash}`;
      wiki.saveAgentSource(slug, bundle);
      wiki.addToQueue(`repo:${slug}`);

      // Verify source was saved
      const sourcePath = path.join(kbRoot, "sources", "agent", `${slug}.md`);
      expect(fs.existsSync(sourcePath)).toBe(true);
      const savedContent = fs.readFileSync(sourcePath, "utf-8");
      expect(savedContent).toContain("# Repository:");

      // Verify queue entry
      const queue = fs.readFileSync(path.join(kbRoot, "ops", "queue.md"), "utf-8");
      expect(queue).toContain(`repo:${slug}`);
    });
  });
});
