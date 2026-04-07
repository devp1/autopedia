import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { Wiki } from "../src/wiki.js";
import { createDashboard, displayName } from "../src/dashboard.js";

function request(server: http.Server, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

describe("Dashboard server", () => {
  let tmpDir: string;
  let kbRoot: string;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-dash-"));
    kbRoot = path.join(tmpDir, ".autopedia");
    const wiki = new Wiki(kbRoot);
    wiki.init();

    // Add some test content
    wiki.writePage("test-topic.md", "# Test Topic\n\nThis is about [[related-page]].\n");
    wiki.writePage("related-page.md", "# Related Page\n\nSee also [[test-topic]].\n");
    wiki.saveAgentSource("2024-01-01-example-com", "# Fetched Article\n\nSome content.");
    wiki.addToQueue("https://example.com/queued");

    server = createDashboard(kbRoot);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Index route ──────────────────────────────────────────────

  it("GET / returns HTML with wiki index content", async () => {
    const { status, body } = await request(server, "/");
    expect(status).toBe(200);
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("autopedia");
    expect(body).toContain("Wiki Index");
  });

  // ── Wiki page route ──────────────────────────────────────────

  it("GET /wiki/:page returns rendered page content", async () => {
    const { status, body } = await request(server, "/wiki/test-topic");
    expect(status).toBe(200);
    expect(body).toContain("Test Topic");
    expect(body).toContain("related-page");
  });

  it("GET /wiki/:page renders wikilinks as clickable links", async () => {
    const { status, body } = await request(server, "/wiki/test-topic");
    expect(status).toBe(200);
    expect(body).toContain('href="/wiki/related-page"');
    expect(body).toContain('class="wikilink"');
  });

  it("GET /wiki/nonexistent returns 404", async () => {
    const { status, body } = await request(server, "/wiki/does-not-exist");
    expect(status).toBe(404);
    expect(body).toContain("not found");
  });

  // ── Sources route ────────────────────────────────────────────

  it("GET /sources returns source list", async () => {
    const { status, body } = await request(server, "/sources");
    expect(status).toBe(200);
    expect(body).toContain("Sources");
    expect(body).toContain("2024-01-01-example-com");
  });

  it("GET /sources/:slug returns source content", async () => {
    const { status, body } = await request(server, "/sources/2024-01-01-example-com");
    expect(status).toBe(200);
    expect(body).toContain("Fetched Article");
  });

  // ── Status route ─────────────────────────────────────────────

  it("GET /status shows queue count", async () => {
    const { status, body } = await request(server, "/status");
    expect(status).toBe(200);
    expect(body).toContain("Queued");
    // Should show 1 unprocessed item
    expect(body).toContain("example.com/queued");
  });

  it("GET /status shows page count", async () => {
    const { status, body } = await request(server, "/status");
    expect(status).toBe(200);
    // 3 pages: index.md + test-topic.md + related-page.md
    expect(body).toContain(">3<");
  });

  // ── 404 ──────────────────────────────────────────────────────

  it("GET /nonexistent returns 404", async () => {
    const { status, body } = await request(server, "/nonexistent-route");
    expect(status).toBe(404);
    expect(body).toContain("404");
  });

  // ── XSS prevention ──────────────────────────────────────────

  it("HTML-escapes page content to prevent XSS", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.writePage("xss-test.md", "# Test\n\n<script>alert('xss')</script>");

    const { body } = await request(server, "/wiki/xss-test");
    // The script tag should be escaped, not rendered as HTML
    expect(body).not.toContain("<script>alert('xss')</script>");
  });

  it("escapes HTML in link text to prevent XSS", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.writePage("link-xss.md", '# Test\n\n[<img src=x onerror=alert(1)>](https://example.com)');

    const { body } = await request(server, "/wiki/link-xss");
    expect(body).not.toContain("<img src=x onerror");
    expect(body).toContain("&lt;img");
  });

  it("blocks javascript: links in markdown content", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.writePage("js-link.md", "# Test\n\n[click me](javascript:alert(1))");

    const { body } = await request(server, "/wiki/js-link");
    expect(body).not.toContain("javascript:alert");
    expect(body).toContain("#blocked");
  });

  it("HTML-escapes source content to prevent XSS", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.saveAgentSource("xss-source", "<img onerror=alert(1) src=x>");

    const { body } = await request(server, "/sources/xss-source");
    // The <img tag must be escaped — not rendered as actual HTML
    expect(body).toContain("&lt;img");
    expect(body).not.toContain("<img onerror");
  });

  // ── Sidebar ──────────────────────────────────────────────────

  it("sidebar shows wiki pages and sources on every page", async () => {
    const { body } = await request(server, "/");
    expect(body).toContain("test-topic");
    expect(body).toContain("related-page");
    expect(body).toContain("2024-01-01-example-com");
  });

  it("sidebar shows queue badge when items are queued", async () => {
    const { body } = await request(server, "/");
    expect(body).toContain("queue-badge");
  });

  // ── Responsive meta ──────────────────────────────────────────

  it("includes viewport meta tag for responsive layout", async () => {
    const { body } = await request(server, "/");
    expect(body).toContain('name="viewport"');
  });

  // ── Theme toggle ─────────────────────────────────────────────

  it("includes theme toggle button", async () => {
    const { body } = await request(server, "/");
    expect(body).toContain("theme-toggle");
  });

  // ── Localhost binding ────────────────────────────────────────

  it("binds to 127.0.0.1 only (not 0.0.0.0)", async () => {
    const { startDashboard } = await import("../src/dashboard.js");
    const localServer = await startDashboard(kbRoot, 0);
    const addr = localServer.address();
    expect(typeof addr).toBe("object");
    if (typeof addr === "object" && addr) {
      expect(addr.address).toBe("127.0.0.1");
    }
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });

  // ── Missing source returns 404 ──────────────────────────────

  it("GET /sources/nonexistent returns 404", async () => {
    const { status, body } = await request(server, "/sources/does-not-exist");
    expect(status).toBe(404);
    expect(body).toContain("not found");
  });

  // ── Frontmatter stripping ──────────────────────────────────

  it("strips YAML frontmatter from rendered pages", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.writePage("fm-test.md", "---\ntitle: My Title\ntags: [a, b]\n---\n# Actual Content\n\nBody text.");

    const { body } = await request(server, "/wiki/fm-test");
    expect(body).not.toContain("title: My Title");
    expect(body).not.toContain("tags: [a, b]");
    expect(body).toContain("Actual Content");
    expect(body).toContain("Body text");
  });

  it("strips YAML frontmatter with \\r\\n line endings", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.writePage("crlf-test.md", "---\r\ntitle: CRLF Test\r\n---\r\n# CRLF Content\r\n");

    const { body } = await request(server, "/wiki/crlf-test");
    expect(body).not.toContain("title: CRLF Test");
    expect(body).toContain("CRLF Content");
  });

  // ── Display name helper ────────────────────────────────────

  it("displayName strips date prefix, base36 timestamp, and replaces hyphens", () => {
    // Date + base36 timestamp (CLI-generated slugs)
    expect(displayName("2026-04-07-mnnzg4ak-karpathy-github-io")).toBe("karpathy github io");
    expect(displayName("2026-04-07-mnp1589w-the-karpathy-pattern")).toBe("the karpathy pattern");
    // Date only (MCP-generated slugs, no timestamp)
    expect(displayName("2024-01-01-example-com")).toBe("example com");
    // No date prefix
    expect(displayName("simple-slug")).toBe("simple slug");
    // File extension stripping
    expect(displayName("2026-04-07-my-article.md")).toBe("my article");
    // All-letter segments preserved (not mistaken for timestamp)
    expect(displayName("2026-04-07-karpathy-github-io")).toBe("karpathy github io");
  });

  // ── Breadcrumb navigation ──────────────────────────────────

  it("wiki pages include breadcrumb navigation", async () => {
    const { body } = await request(server, "/wiki/test-topic");
    expect(body).toContain("breadcrumb");
    expect(body).toContain('href="/"');
    expect(body).toContain("test-topic");
  });

  it("source detail pages include breadcrumb navigation", async () => {
    const { body } = await request(server, "/sources/2024-01-01-example-com");
    expect(body).toContain("breadcrumb");
    expect(body).toContain('href="/sources"');
  });

  // ── Better empty state ─────────────────────────────────────

  it("empty wiki shows getting-started guide instead of bare message", async () => {
    // Create a fresh kb with no wiki pages beyond index
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopedia-empty-"));
    const emptyKb = path.join(emptyDir, ".autopedia");
    const emptyWiki = new Wiki(emptyKb);
    emptyWiki.init();

    // Remove the default index.md to simulate truly empty
    const indexPath = path.join(emptyKb, "wiki", "index.md");
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);

    const emptyServer = createDashboard(emptyKb);
    await new Promise<void>((resolve) => emptyServer.listen(0, resolve));

    const { body } = await request(emptyServer, "/");
    expect(body).toContain("getting-started");
    expect(body).toContain("autopedia add");

    await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  // ── Display names in sidebar and source list ───────────────

  it("sidebar shows source title from content heading", async () => {
    const { body } = await request(server, "/");
    // The source "2024-01-01-example-com" has content "# Fetched Article" — should show that
    expect(body).toContain("Fetched Article");
  });

  // ── Pinned index ───────────────────────────────────────────

  it("sidebar pins index as Home at top of wiki list", async () => {
    const { body } = await request(server, "/");
    expect(body).toContain(">Home<");
    // Home should come before other pages
    const homePos = body.indexOf(">Home<");
    const topicPos = body.indexOf("test-topic");
    expect(homePos).toBeLessThan(topicPos);
  });

  it("index is not duplicated in sidebar", async () => {
    const { body } = await request(server, "/");
    // Should not appear as a separate sidebar item beyond "Home"
    expect(body).not.toContain('">index<');
  });

  // ── Graph route ─────────────────────────────────────────────

  it("GET /graph returns 200 with SVG", async () => {
    const { status, body } = await request(server, "/graph");
    expect(status).toBe(200);
    expect(body).toContain("graph-svg");
    expect(body).toContain("Knowledge Graph");
  });

  it("graph data includes wiki page nodes", async () => {
    const { body } = await request(server, "/graph");
    expect(body).toContain("test-topic");
    expect(body).toContain("related-page");
  });

  // ── Backlinks ───────────────────────────────────────────────

  it("wiki pages show backlinks section", async () => {
    // test-topic links to related-page, so related-page should show backlink from test-topic
    const { body } = await request(server, "/wiki/related-page");
    expect(body).toContain("Linked from");
    expect(body).toContain("test-topic");
  });

  it("wiki pages with no backlinks skip backlinks section", async () => {
    const wiki = new Wiki(kbRoot);
    wiki.writePage("orphan.md", "# Orphan\n\nNo one links here.");
    const { body } = await request(server, "/wiki/orphan");
    expect(body).not.toContain("Linked from");
  });

  // ── Graph link in sidebar ──────────────────────────────────

  it("sidebar includes Graph link", async () => {
    const { body } = await request(server, "/");
    expect(body).toContain('href="/graph"');
    expect(body).toContain("Graph");
  });
});
