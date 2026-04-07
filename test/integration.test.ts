import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
import { Wiki } from "../src/wiki.js";

describe("Integration: full wiki workflow", () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-integ-"));
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

  it("full flow: add_source(text) → apply_ops → verify wiki state", async () => {
    // Step 1: Add a text source
    const addResult = await client.callTool({
      name: "add_source",
      arguments: {
        text: "GPU inference costs have dropped 10x in the last year. NVIDIA H100 is the dominant chip. AMD MI300X is a viable alternative.",
      },
    });

    const addData = JSON.parse(
      (addResult.content as Array<{ text: string }>)[0].text
    );
    expect(addData.source_content).toContain("GPU inference");

    // Step 2: Apply wiki operations (simulating what the host LLM would do)
    const applyResult = await client.callTool({
      name: "apply_wiki_ops",
      arguments: {
        operations: [
          {
            op: "create",
            path: "gpu-inference-costs.md",
            content: [
              "# GPU Inference Costs",
              "",
              "## TLDR",
              "GPU inference costs dropped 10x in the past year.",
              "",
              "## Key Facts",
              "- NVIDIA H100 is the dominant inference chip",
              "- AMD MI300X is emerging as a viable alternative",
              "",
              "## Counter-arguments",
              "- Cost reduction may slow as easy gains are captured",
              "- Total cost of ownership includes more than GPU price",
              "",
              "## Sources",
              "- User note (added via add_source)",
            ].join("\n"),
          },
          {
            op: "update",
            path: "index.md",
            content: [
              "# Wiki Index",
              "",
              "- [[gpu-inference-costs]] — GPU inference costs dropped 10x",
            ].join("\n"),
          },
        ],
      },
    });

    const applyData = JSON.parse(
      (applyResult.content as Array<{ text: string }>)[0].text
    );
    expect(applyData.applied).toBe(2);

    // Step 3: Verify wiki state via search
    const searchResult = await client.callTool({
      name: "search",
      arguments: { query: "GPU inference" },
    });

    const searchData = JSON.parse(
      (searchResult.content as Array<{ text: string }>)[0].text
    );
    expect(searchData.length).toBeGreaterThan(0);
    expect(searchData.some((r: { path: string }) => r.path === "gpu-inference-costs.md")).toBe(
      true
    );

    // Step 4: Verify via read_page
    const readResult = await client.callTool({
      name: "read_page",
      arguments: { path: "gpu-inference-costs.md" },
    });

    const pageContent = (readResult.content as Array<{ text: string }>)[0].text;
    expect(pageContent).toContain("Counter-arguments");
    expect(pageContent).toContain("NVIDIA H100");

    // Step 5: Verify status
    const statusResult = await client.callTool({
      name: "get_status",
      arguments: {},
    });

    const statusData = JSON.parse(
      (statusResult.content as Array<{ text: string }>)[0].text
    );
    expect(statusData.pages).toContain("gpu-inference-costs.md");
    expect(statusData.recent_log.length).toBeGreaterThan(0);
  });

  it("update flow: create → update with read-before-write → verify", async () => {
    // Create initial page
    await client.callTool({
      name: "apply_wiki_ops",
      arguments: {
        operations: [
          {
            op: "create",
            path: "evolving-topic.md",
            content: "# Evolving Topic\n\nInitial understanding: X is true.",
          },
        ],
      },
    });

    // Update with new information
    const updateResult = await client.callTool({
      name: "apply_wiki_ops",
      arguments: {
        operations: [
          {
            op: "update",
            path: "evolving-topic.md",
            content:
              "# Evolving Topic\n\nUpdated: X was partially true. New evidence shows Y.",
          },
        ],
      },
    });

    const updateData = JSON.parse(
      (updateResult.content as Array<{ text: string }>)[0].text
    );

    // Read-before-write should return the old content
    expect(updateData.current_state["evolving-topic.md"]).toContain(
      "Initial understanding"
    );

    // Verify the page was actually updated
    const readResult = await client.callTool({
      name: "read_page",
      arguments: { path: "evolving-topic.md" },
    });

    const content = (readResult.content as Array<{ text: string }>)[0].text;
    expect(content).toContain("New evidence shows Y");
  });

  it("lint flow: create pages → lint detects issues", async () => {
    // Create an orphan page (no inlinks)
    await client.callTool({
      name: "apply_wiki_ops",
      arguments: {
        operations: [
          {
            op: "create",
            path: "orphan-page.md",
            content: "# Orphan\n\nThis page has no inlinks.",
          },
          {
            op: "create",
            path: "linked-page.md",
            content:
              "# Linked Page\n\nSee also: [[orphan-page]]\n\nThis page links to orphan.",
          },
        ],
      },
    });

    const lintResult = await client.callTool({
      name: "lint",
      arguments: {},
    });

    const lintData = JSON.parse(
      (lintResult.content as Array<{ text: string }>)[0].text
    );

    // linked-page.md should be orphan (nothing links to it)
    expect(
      lintData.findings.some(
        (f: string) => f.startsWith("orphan:") && f.includes("linked-page.md")
      )
    ).toBe(true);

    // orphan-page.md has an inlink from linked-page.md — not an orphan
    expect(
      lintData.findings.some(
        (f: string) => f.startsWith("orphan:") && f.includes("orphan-page.md")
      )
    ).toBe(false);
  });

  it("question_assumptions flow: create claims → detect them", async () => {
    await client.callTool({
      name: "apply_wiki_ops",
      arguments: {
        operations: [
          {
            op: "create",
            path: "bold-claims.md",
            content: [
              "# Bold Claims",
              "",
              "Transformers are definitely the best architecture for NLP.",
              "RLHF is obviously the right approach for alignment.",
              "Prices may vary by region and time.",
            ].join("\n"),
          },
        ],
      },
    });

    const result = await client.callTool({
      name: "question_assumptions",
      arguments: {},
    });

    const data = JSON.parse(
      (result.content as Array<{ text: string }>)[0].text
    );

    expect(data.claims.length).toBeGreaterThanOrEqual(2);
    expect(
      data.claims.some((c: { claim: string }) => c.claim.includes("definitely"))
    ).toBe(true);
    expect(
      data.claims.some((c: { claim: string }) => c.claim.includes("obviously"))
    ).toBe(true);
    // "may vary" should NOT be flagged as high-confidence
    expect(
      data.claims.some((c: { claim: string }) => c.claim.includes("may vary"))
    ).toBe(false);
  });

  it("sacred boundary holds through MCP tools", async () => {
    // Try to write outside wiki/ via apply_wiki_ops
    const result = await client.callTool({
      name: "apply_wiki_ops",
      arguments: {
        operations: [
          {
            op: "create",
            path: "../../../etc/passwd",
            content: "hacked",
          },
        ],
      },
    });

    expect(result.isError).toBe(true);

    // Verify /etc/passwd was not modified (sanity check)
    const etcPasswd = fs.readFileSync("/etc/passwd", "utf-8");
    expect(etcPasswd).not.toBe("hacked");
  });
});
