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

    it("rejects operations with empty array", async () => {
      const result = await client.callTool({
        name: "apply_wiki_ops",
        arguments: { operations: [] },
      });

      expect(result.isError).toBe(true);
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
});
