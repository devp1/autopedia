import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
import { Wiki } from "../src/wiki.js";

describe("MCP Server", () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-mcp-"));
    const wiki = new Wiki(tmpDir);
    wiki.init();

    const server = createServer(tmpDir);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Tool listing ──────────────────────────────────────────────

  it("lists all expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("add_source");
    expect(names).toContain("apply_wiki_ops");
    expect(names).toContain("search");
    expect(names).toContain("read_page");
    expect(names).toContain("get_status");
    expect(names).toContain("lint");
    expect(names).toContain("question_assumptions");
    expect(names).toContain("complete_onboarding");
    expect(names).toContain("read_source");
  });

  // ── add_source (text) ─────────────────────────────────────────

  describe("add_source", () => {
    it("saves text source and returns structured data", async () => {
      const result = await client.callTool({
        name: "add_source",
        arguments: { text: "GPU pricing is dropping fast in 2024" },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.source_content).toContain("GPU pricing");
      expect(data.index).toBeDefined();

      // Verify file was saved to sources/user/notes/
      const notesDir = path.join(tmpDir, "sources", "user", "notes");
      const files = fs.readdirSync(notesDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/gpu-pricing/);
    });

    it("rejects when neither url nor text provided", async () => {
      const result = await client.callTool({
        name: "add_source",
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });

    // ── capture_mode: queue ─────────────────────────────────────

    it("queue mode with URL: queues without fetching", async () => {
      const result = await client.callTool({
        name: "add_source",
        arguments: {
          url: "https://example.com/article",
          capture_mode: "queue",
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.queued).toBe("https://example.com/article");
      expect(data.message).toContain("queue");

      // Verify it was added to the queue
      const queuePath = path.join(tmpDir, "ops", "queue.md");
      const queue = fs.readFileSync(queuePath, "utf-8");
      expect(queue).toContain("- [ ] https://example.com/article");

      // Verify NO source file was saved (no fetch happened)
      const agentDir = path.join(tmpDir, "sources", "agent");
      const agentFiles = fs.readdirSync(agentDir);
      expect(agentFiles).toHaveLength(0);
    });

    it("queue mode with text: saves note and queues", async () => {
      const result = await client.callTool({
        name: "add_source",
        arguments: {
          text: "Quick thought about inference costs",
          capture_mode: "queue",
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.note_saved).toBe(true);
      expect(data.queued).toContain("note:");

      // Verify note was saved
      const notesDir = path.join(tmpDir, "sources", "user", "notes");
      const files = fs.readdirSync(notesDir);
      expect(files.length).toBe(1);

      // Verify queue entry
      const queuePath = path.join(tmpDir, "ops", "queue.md");
      const queue = fs.readFileSync(queuePath, "utf-8");
      expect(queue).toContain("- [ ] note:");
    });

    it("ingest mode (default) returns full synthesis context", async () => {
      const result = await client.callTool({
        name: "add_source",
        arguments: { text: "Full ingest test content" },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      // Ingest mode returns source_content, index, relevant_pages
      expect(data.source_content).toBeDefined();
      expect(data.index).toBeDefined();
      expect(data.relevant_pages).toBeDefined();
    });
  });

  // ── apply_wiki_ops ────────────────────────────────────────────

  describe("apply_wiki_ops", () => {
    it("creates wiki pages", async () => {
      const result = await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            {
              op: "create",
              path: "gpu-pricing.md",
              content: "# GPU Pricing\n\nPrices are dropping.",
            },
          ],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.applied).toBe(1);

      // Verify file exists
      const content = fs.readFileSync(
        path.join(tmpDir, "wiki", "gpu-pricing.md"),
        "utf-8"
      );
      expect(content).toContain("GPU Pricing");
    });

    it("returns current state for update ops (read-before-write)", async () => {
      // First create
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "test.md", content: "Version 1" },
          ],
        },
      });

      // Then update
      const result = await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "update", path: "test.md", content: "Version 2" },
          ],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.current_state["test.md"]).toBe("Version 1");
    });

    it("applies multiple operations", async () => {
      const result = await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "page1.md", content: "Page 1" },
            { op: "create", path: "page2.md", content: "Page 2" },
            { op: "create", path: "topics/page3.md", content: "Page 3" },
          ],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.applied).toBe(3);
    });

    it("rejects empty operations without queue_item", async () => {
      const result = await client.callTool({
        name: "apply_wiki_ops",
        arguments: { operations: [] },
      });

      expect(result.isError).toBe(true);
    });

    it("allows empty operations with queue_item (mark-only)", async () => {
      const wiki = new Wiki(tmpDir);
      wiki.addToQueue("note:test-note");

      const result = await client.callTool({
        name: "apply_wiki_ops",
        arguments: { operations: [], queue_item: "note:test-note" },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.applied).toBe(0);
      expect(data.queue_item_processed).toBe("note:test-note");

      const unprocessed = wiki.listUnprocessedSources();
      expect(unprocessed).not.toContain("note:test-note");
    });

    it("logs operations", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "logged.md", content: "content" },
          ],
        },
      });

      const log = fs.readFileSync(path.join(tmpDir, "ops", "log.md"), "utf-8");
      expect(log).toContain("create: logged.md");
    });
  });

  // ── search ────────────────────────────────────────────────────

  describe("search", () => {
    it("finds pages matching query", async () => {
      // Add a page first
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            {
              op: "create",
              path: "transformers.md",
              content:
                "# Transformers\n\nAttention is all you need. Self-attention mechanism.",
            },
          ],
        },
      });

      const result = await client.callTool({
        name: "search",
        arguments: { query: "attention" },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].path).toBe("transformers.md");
    });

    it("returns empty for no matches", async () => {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "quantum_entanglement_xyz" },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(0);
    });

    it("rejects empty query", async () => {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "" },
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── read_page ─────────────────────────────────────────────────

  describe("read_page", () => {
    it("reads an existing page", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "readme.md", content: "# Hello\n\nWorld" },
          ],
        },
      });

      const result = await client.callTool({
        name: "read_page",
        arguments: { path: "readme.md" },
      });

      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("# Hello");
    });

    it("returns error for non-existent page", async () => {
      const result = await client.callTool({
        name: "read_page",
        arguments: { path: "nonexistent.md" },
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── get_status ────────────────────────────────────────────────

  describe("get_status", () => {
    it("returns wiki status", async () => {
      const result = await client.callTool({
        name: "get_status",
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.page_count).toBeGreaterThanOrEqual(1); // index.md at minimum
      expect(data.pages).toBeDefined();
      expect(data.unprocessed_sources).toBeDefined();
    });

    it("reflects newly added pages", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "new.md", content: "new page" },
          ],
        },
      });

      const result = await client.callTool({
        name: "get_status",
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.pages).toContain("new.md");
    });
  });

  // ── lint ──────────────────────────────────────────────────────

  describe("lint", () => {
    it("detects orphan pages", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "orphan.md", content: "# Orphan\n\nNo one links here." },
          ],
        },
      });

      const result = await client.callTool({
        name: "lint",
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      const orphanFindings = data.findings.filter((f: string) =>
        f.includes("orphan") && f.includes("orphan.md")
      );
      expect(orphanFindings.length).toBeGreaterThan(0);
    });

    it("returns empty findings for clean wiki", async () => {
      // Just the default index — it's excluded from orphan checks
      const result = await client.callTool({
        name: "lint",
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.findings).toBeDefined();
    });

    it("detects broken wikilinks", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "linker.md", content: "# Linker\n\nSee [[nonexistent-page]] for details." },
          ],
        },
      });

      const result = await client.callTool({ name: "lint", arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      const brokenLinks = data.findings.filter((f: string) => f.startsWith("broken-link:"));
      expect(brokenLinks.length).toBeGreaterThan(0);
      expect(brokenLinks[0]).toContain("nonexistent-page");
    });

    it("detects low cross-reference density (non-stub pages)", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            {
              op: "create",
              path: "isolated.md",
              // Must be >4 content lines to not be exempt as a stub
              content: "# Isolated Page\n\nThis page has no wikilinks.\nIt covers a real topic.\nWith multiple points of detail.\nAnd substantive analysis.\nBut zero cross-references to other pages.",
            },
          ],
        },
      });

      const result = await client.callTool({ name: "lint", arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      const lowCrossref = data.findings.filter((f: string) => f.startsWith("low-crossref:"));
      expect(lowCrossref.some((f: string) => f.includes("isolated.md"))).toBe(true);
    });

    it("detects unsourced claims", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "nosources.md", content: "# No Sources\n\n## Key Facts\n- GPUs cost $1000\n\n## Analysis\nPrices are rising." },
          ],
        },
      });

      const result = await client.callTool({ name: "lint", arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      const unsourced = data.findings.filter((f: string) => f.startsWith("unsourced:"));
      expect(unsourced.some((f: string) => f.includes("nosources.md"))).toBe(true);
    });

    it("reports knowledge gaps from broken links", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "gapper.md", content: "# Gapper\n\nRelated to [[missing-topic-1]] and [[missing-topic-2]]." },
          ],
        },
      });

      const result = await client.callTool({ name: "lint", arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      const gaps = data.findings.filter((f: string) => f.startsWith("gap:"));
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0]).toContain("topic(s) referenced but no page exists");
    });
  });

  // ── question_assumptions ──────────────────────────────────────

  describe("question_assumptions", () => {
    it("finds high-confidence claims", async () => {
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            {
              op: "create",
              path: "claims.md",
              content:
                "# Bold Claims\n\nGPUs will always be expensive.\nThis is definitely the best approach.\nPrices vary by region.",
            },
          ],
        },
      });

      const result = await client.callTool({
        name: "question_assumptions",
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.claims.length).toBeGreaterThan(0);
      expect(data.claims.some((c: { claim: string }) => c.claim.includes("always"))).toBe(true);
    });

    it("returns empty when no high-confidence claims", async () => {
      const result = await client.callTool({
        name: "question_assumptions",
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      // Default index has no bold claims
      expect(data.claims.length).toBe(0);
    });
  });

  // ── complete_onboarding ────────────────────────────────────────

  describe("complete_onboarding", () => {
    it("writes identity and interests files", async () => {
      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\n## Who am I?\n- Name: Test User\n- Role: Developer",
          interests: "# Interests\n\n## Topics I follow\n- TypeScript\n- MCP servers",
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.status).toBe("ok");

      // Verify files were written
      const identity = fs.readFileSync(path.join(tmpDir, "schema", "identity.md"), "utf-8");
      expect(identity).toContain("Test User");

      const interests = fs.readFileSync(path.join(tmpDir, "schema", "interests.md"), "utf-8");
      expect(interests).toContain("MCP servers");
    });

    it("rejects empty identity", async () => {
      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "",
          interests: "# Interests\n\nSome interests",
        },
      });

      expect(result.isError).toBe(true);
    });

    it("rejects empty interests", async () => {
      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\nSome identity",
          interests: "",
        },
      });

      expect(result.isError).toBe(true);
    });

    it("rejects oversized content", async () => {
      const bigContent = "x".repeat(11 * 1024); // > 10KB

      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: bigContent,
          interests: "# Interests\n\nSome interests",
        },
      });

      expect(result.isError).toBe(true);
    });

    it("overwrites existing schema files on second call", async () => {
      // First call
      await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\nVersion 1",
          interests: "# Interests\n\nVersion 1",
        },
      });

      // Second call
      await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\nVersion 2",
          interests: "# Interests\n\nVersion 2",
        },
      });

      const identity = fs.readFileSync(path.join(tmpDir, "schema", "identity.md"), "utf-8");
      expect(identity).toContain("Version 2");
      expect(identity).not.toContain("Version 1");
    });
  });

  describe("complete_onboarding symlink protection", () => {
    it("rejects when schema/ directory is a symlink", async () => {
      const schemaDir = path.join(tmpDir, "schema");
      const fakeTarget = path.join(tmpDir, "fake-schema");
      fs.mkdirSync(fakeTarget, { recursive: true });

      // Remove real schema dir and replace with symlink
      fs.rmSync(schemaDir, { recursive: true, force: true });
      try {
        fs.symlinkSync(fakeTarget, schemaDir, "dir");
      } catch {
        return; // Symlinks not supported on this platform
      }

      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\nTest",
          interests: "# Interests\n\nTest",
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("schema/ directory is a symlink");
    });

    it("rejects when identity.md is a symlink", async () => {
      const schemaDir = path.join(tmpDir, "schema");
      fs.mkdirSync(schemaDir, { recursive: true });

      const outsideFile = path.join(tmpDir, "outside-identity.md");
      fs.writeFileSync(outsideFile, "original");
      const identityPath = path.join(schemaDir, "identity.md");
      try {
        fs.symlinkSync(outsideFile, identityPath, "file");
      } catch {
        return; // Symlinks not supported
      }

      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\nHacked",
          interests: "# Interests\n\nTest",
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("is a symlink");
      // Verify outside file was NOT modified
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("original");
    });

    it("rejects when interests.md is a symlink", async () => {
      const schemaDir = path.join(tmpDir, "schema");
      fs.mkdirSync(schemaDir, { recursive: true });

      const outsideFile = path.join(tmpDir, "outside-interests.md");
      fs.writeFileSync(outsideFile, "original");
      const interestsPath = path.join(schemaDir, "interests.md");
      try {
        fs.symlinkSync(outsideFile, interestsPath, "file");
      } catch {
        return; // Symlinks not supported
      }

      const result = await client.callTool({
        name: "complete_onboarding",
        arguments: {
          identity: "# Identity\n\nTest",
          interests: "# Interests\n\nHacked",
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("is a symlink");
      // Verify outside file was NOT modified
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("original");
    });
  });

  // ── read_source ───────────────────────────────────────────────

  describe("read_source", () => {
    it("reads an agent source by slug", async () => {
      // Write a source file directly
      const sourceDir = path.join(tmpDir, "sources", "agent");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, "2024-01-01-example-com.md"),
        "# Example Article\n\nSome content here."
      );

      const result = await client.callTool({
        name: "read_source",
        arguments: { slug: "2024-01-01-example-com" },
      });

      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Example Article");
    });

    it("reads a user note by slug", async () => {
      const notesDir = path.join(tmpDir, "sources", "user", "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "my-thought.md"),
        "Inference costs are dropping fast."
      );

      const result = await client.callTool({
        name: "read_source",
        arguments: { slug: "my-thought" },
      });

      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Inference costs");
    });

    it("returns error for non-existent source", async () => {
      const result = await client.callTool({
        name: "read_source",
        arguments: { slug: "does-not-exist" },
      });

      expect(result.isError).toBe(true);
    });

    it("rejects path traversal", async () => {
      const result = await client.callTool({
        name: "read_source",
        arguments: { slug: "../../etc/passwd" },
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── apply_wiki_ops with queue_item ────────────────────────────

  describe("apply_wiki_ops queue_item", () => {
    it("marks queue item as processed", async () => {
      // Add something to the queue first
      const wiki = new Wiki(tmpDir);
      wiki.addToQueue("https://example.com/article");

      // Verify it's unprocessed
      let unprocessed = wiki.listUnprocessedSources();
      expect(unprocessed).toContain("https://example.com/article");

      // Apply ops with queue_item
      await client.callTool({
        name: "apply_wiki_ops",
        arguments: {
          operations: [
            { op: "create", path: "article.md", content: "# Article\n\nContent." },
          ],
          queue_item: "https://example.com/article",
        },
      });

      // Verify it's now processed
      unprocessed = wiki.listUnprocessedSources();
      expect(unprocessed).not.toContain("https://example.com/article");
    });
  });

  // ── Resource: autopedia://prompt ──────────────────────────────

  describe("autopedia://prompt resource", () => {
    it("lists the autopedia prompt resource", async () => {
      const { resources } = await client.listResources();
      expect(resources.some((r) => r.uri === "autopedia://prompt")).toBe(true);
    });

    it("reads the prompt resource from package dir", async () => {
      const result = await client.readResource({
        uri: "autopedia://prompt",
      });

      const text = (result.contents[0] as { text: string }).text;
      // Should serve the package's schema/prompt.md
      expect(text).toContain("autopedia System Prompt");
      expect(text).toContain("Three Operations");
    });

    it("serves prompt from package dir even when kbRoot has no prompt", async () => {
      // Remove prompt from kbRoot — should still serve from package
      const kbPromptPath = path.join(tmpDir, "schema", "prompt.md");
      if (fs.existsSync(kbPromptPath)) {
        fs.unlinkSync(kbPromptPath);
      }

      const result = await client.readResource({
        uri: "autopedia://prompt",
      });

      const text = (result.contents[0] as { text: string }).text;
      // Should serve the package prompt.md (contains the full system prompt)
      expect(text).toContain("autopedia System Prompt");
      expect(text).toContain("Onboarding");
    });
  });

  // ── Resource: autopedia://identity ─────────────────────────────

  describe("autopedia://identity resource", () => {
    it("reads the identity resource", async () => {
      fs.mkdirSync(path.join(tmpDir, "schema"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "schema", "identity.md"),
        "# Identity\n\n## Who am I?\n- Name: Test User"
      );

      const result = await client.readResource({
        uri: "autopedia://identity",
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("Test User");
    });

    it("returns fallback when identity file is a symlink", async () => {
      const schemaDir = path.join(tmpDir, "schema");
      fs.mkdirSync(schemaDir, { recursive: true });
      const identityPath = path.join(schemaDir, "identity.md");
      if (fs.existsSync(identityPath)) fs.unlinkSync(identityPath);

      const outsideFile = path.join(tmpDir, "secret.md");
      fs.writeFileSync(outsideFile, "SECRET DATA");
      try {
        fs.symlinkSync(outsideFile, identityPath, "file");
      } catch {
        return; // Symlinks not supported
      }

      const result = await client.readResource({
        uri: "autopedia://identity",
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("No identity configured");
      expect(text).not.toContain("SECRET DATA");
    });

    it("returns fallback when no identity file exists", async () => {
      const idPath = path.join(tmpDir, "schema", "identity.md");
      if (fs.existsSync(idPath)) fs.unlinkSync(idPath);

      const result = await client.readResource({
        uri: "autopedia://identity",
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("No identity configured");
    });
  });

  // ── Resource: autopedia://interests ────────────────────────────

  describe("autopedia://interests resource", () => {
    it("reads the interests resource", async () => {
      fs.mkdirSync(path.join(tmpDir, "schema"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "schema", "interests.md"),
        "# Interests\n\n## Topics I follow\n- Inference costs"
      );

      const result = await client.readResource({
        uri: "autopedia://interests",
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("Inference costs");
    });

    it("returns fallback when interests file is a symlink", async () => {
      const schemaDir = path.join(tmpDir, "schema");
      fs.mkdirSync(schemaDir, { recursive: true });
      const interestsPath = path.join(schemaDir, "interests.md");
      if (fs.existsSync(interestsPath)) fs.unlinkSync(interestsPath);

      const outsideFile = path.join(tmpDir, "secret-interests.md");
      fs.writeFileSync(outsideFile, "SECRET INTERESTS");
      try {
        fs.symlinkSync(outsideFile, interestsPath, "file");
      } catch {
        return; // Symlinks not supported
      }

      const result = await client.readResource({
        uri: "autopedia://interests",
      });

      const text = (result.contents[0] as { text: string }).text;
      expect(text).toContain("No interests configured");
      expect(text).not.toContain("SECRET INTERESTS");
    });
  });
});
