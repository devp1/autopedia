import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { Wiki } from "../src/wiki.js";
import { createDashboard } from "../src/dashboard.js";

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
});
