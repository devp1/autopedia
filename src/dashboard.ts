import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { Marked } from "marked";
import { Wiki } from "./wiki.js";

// ── HTML escaping (XSS prevention) ─────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Markdown rendering with wikilink support ────────────────────

// Sanitize href — block javascript: and data: URIs
function sanitizeHref(href: string): string {
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:")) {
    return "#blocked";
  }
  return href;
}

// Configure marked to escape raw HTML and sanitize links (XSS prevention)
const markedInstance = new Marked({
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
    link({ href, text }: { href: string; text: string }) {
      const safeHref = sanitizeHref(href);
      return `<a href="${escapeHtml(safeHref)}">${text}</a>`;
    },
    image({ href, text }: { href: string; text: string }) {
      const safeHref = sanitizeHref(href);
      return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}" />`;
    },
  },
});

function renderMarkdown(content: string): string {
  // First: render markdown to HTML (raw HTML is escaped by our custom renderer)
  const html = markedInstance.parse(content, { async: false }) as string;
  // Then: convert [[wikilinks]] to clickable links in the rendered HTML
  return html.replace(
    /\[\[([^\]]+)\]\]/g,
    (_match, page: string) => `<a href="/wiki/${encodeURIComponent(page)}" class="wikilink">${escapeHtml(page)}</a>`
  );
}

// ── Design tokens ───────────────────────────────────────────────

const CSS = `
:root {
  --bg: #ffffff;
  --surface: #f6f5f4;
  --text: rgba(0,0,0,0.95);
  --text-secondary: #615d59;
  --accent: #0075de;
  --border: rgba(0,0,0,0.1);
  --sidebar-bg: #f6f5f4;
  --sidebar-active: #0075de;
  --code-bg: #f6f5f4;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #08090a;
    --surface: #0f1011;
    --text: #f7f8f8;
    --text-secondary: #8b8b8b;
    --accent: #5e6ad2;
    --border: rgba(255,255,255,0.08);
    --sidebar-bg: #0f1011;
    --sidebar-active: #5e6ad2;
    --code-bg: #161618;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
}

.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: 56px 1fr;
  min-height: 100vh;
}

/* ── Header ─────────────────────────────── */

.header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.header h1 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.header h1 a {
  color: var(--text);
  text-decoration: none;
}

.theme-toggle {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 16px;
  color: var(--text);
}

/* ── Sidebar ────────────────────────────── */

.sidebar {
  padding: 16px 0;
  border-right: 1px solid var(--border);
  background: var(--sidebar-bg);
  overflow-y: auto;
}

.sidebar h2 {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  padding: 8px 16px 4px;
}

.sidebar ul {
  list-style: none;
  padding: 0;
}

.sidebar li a {
  display: block;
  padding: 4px 16px 4px 20px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
  text-decoration: none;
  border-left: 3px solid transparent;
  transition: background 0.1s;
}

.sidebar li a:hover {
  background: var(--border);
}

.sidebar li a.active {
  border-left-color: var(--sidebar-active);
  font-weight: 700;
  color: var(--sidebar-active);
}

.sidebar .queue-badge {
  font-size: 12px;
  background: var(--accent);
  color: #fff;
  border-radius: 10px;
  padding: 1px 7px;
  margin-left: 6px;
  font-weight: 600;
}

/* ── Content ────────────────────────────── */

.content {
  padding: 32px 48px;
  max-width: 800px;
  overflow-y: auto;
}

.content h1 { font-size: 24px; font-weight: 700; margin-bottom: 16px; }
.content h2 { font-size: 20px; font-weight: 600; margin: 24px 0 12px; }
.content h3 { font-size: 17px; font-weight: 600; margin: 20px 0 8px; }
.content p { margin-bottom: 12px; }
.content ul, .content ol { margin-bottom: 12px; padding-left: 24px; }
.content li { margin-bottom: 4px; }
.content a { color: var(--accent); text-decoration: none; }
.content a:hover { text-decoration: underline; }

.content pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  margin-bottom: 12px;
  font-size: 14px;
}

.content code {
  background: var(--code-bg);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 14px;
}

.content pre code { background: none; padding: 0; }

.content blockquote {
  border-left: 3px solid var(--accent);
  padding-left: 16px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.wikilink {
  color: var(--accent);
  border-bottom: 1px dashed var(--accent);
}

.wikilink:hover { border-bottom-style: solid; }

/* ── Empty state ────────────────────────── */

.empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: 24px 0;
}

/* ── Source list ─────────────────────────── */

.source-list {
  list-style: none;
  padding: 0;
}

.source-list li {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.source-list li a { color: var(--accent); text-decoration: none; }
.source-list li a:hover { text-decoration: underline; }

/* ── Status cards ────────────────────────── */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.stat-card .label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}

.stat-card .value {
  font-size: 28px;
  font-weight: 700;
  margin-top: 4px;
}

/* ── Responsive ─────────────────────────── */

@media (max-width: 768px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: 56px auto 1fr;
  }

  .sidebar {
    border-right: none;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px 16px;
    overflow-x: auto;
  }

  .sidebar h2 { display: none; }
  .sidebar ul { display: flex; gap: 4px; flex-wrap: wrap; }
  .sidebar li a { padding: 4px 10px; border-left: none; border-radius: 6px; font-size: 14px; }
  .sidebar li a.active { background: var(--accent); color: #fff; border-left: none; }

  .content { padding: 16px; }
}
`;

// ── Theme toggle script (minimal inline JS) ─────────────────────

const THEME_SCRIPT = `
<script>
(function() {
  var btn = document.querySelector('.theme-toggle');
  var html = document.documentElement;
  var stored = localStorage.getItem('autopedia-theme');
  if (stored) html.setAttribute('data-theme', stored);
  if (btn) btn.addEventListener('click', function() {
    var current = html.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : (current === 'light' ? 'dark' :
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
    html.setAttribute('data-theme', next);
    localStorage.setItem('autopedia-theme', next);
  });
})();
</script>
<style>
[data-theme="dark"] { --bg:#08090a; --surface:#0f1011; --text:#f7f8f8; --text-secondary:#8b8b8b; --accent:#5e6ad2; --border:rgba(255,255,255,0.08); --sidebar-bg:#0f1011; --sidebar-active:#5e6ad2; --code-bg:#161618; }
[data-theme="light"] { --bg:#ffffff; --surface:#f6f5f4; --text:rgba(0,0,0,0.95); --text-secondary:#615d59; --accent:#0075de; --border:rgba(0,0,0,0.1); --sidebar-bg:#f6f5f4; --sidebar-active:#0075de; --code-bg:#f6f5f4; }
</style>
`;

// ── Page template ───────────────────────────────────────────────

interface SidebarData {
  pages: string[];
  sources: string[];
  queueCount: number;
  activePath: string;
}

function buildSidebar(data: SidebarData): string {
  const wikiItems = data.pages.length > 0
    ? data.pages.map(p => {
        const name = p.replace(/\.md$/, "");
        const isActive = data.activePath === `/wiki/${name}` || (data.activePath === "/" && p === "index.md");
        return `<li><a href="/wiki/${encodeURIComponent(name)}" class="${isActive ? "active" : ""}">${escapeHtml(name)}</a></li>`;
      }).join("\n")
    : `<li class="empty">No pages yet</li>`;

  const sourceItems = data.sources.length > 0
    ? data.sources.map(s => {
        const name = s.replace(/\.md$/, "");
        const isActive = data.activePath === `/sources/${name}`;
        return `<li><a href="/sources/${encodeURIComponent(name)}" class="${isActive ? "active" : ""}">${escapeHtml(name)}</a></li>`;
      }).join("\n")
    : `<li class="empty">No sources</li>`;

  const queueBadge = data.queueCount > 0
    ? `<span class="queue-badge">${data.queueCount}</span>`
    : "";

  return `
    <nav class="sidebar">
      <h2>Wiki</h2>
      <ul>${wikiItems}</ul>
      <h2>Sources</h2>
      <ul>${sourceItems}</ul>
      <h2>Queue${queueBadge}</h2>
    </nav>
  `;
}

function renderPage(title: string, bodyHtml: string, sidebar: SidebarData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — autopedia</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="layout">
    <header class="header">
      <h1><a href="/">autopedia</a></h1>
      <button class="theme-toggle" aria-label="Toggle theme">&#9788;/&#9789;</button>
    </header>
    ${buildSidebar(sidebar)}
    <main class="content">
      ${bodyHtml}
    </main>
  </div>
  ${THEME_SCRIPT}
</body>
</html>`;
}

// ── Route handlers ──────────────────────────────────────────────

function getSidebarData(wiki: Wiki, kbRoot: string, activePath: string): SidebarData {
  const pages = wiki.listPages();
  const sources = listAllSources(kbRoot);
  const queueCount = wiki.listUnprocessedSources().length;
  return { pages, sources, queueCount, activePath };
}

function listAllSources(kbRoot: string): string[] {
  const results: string[] = [];
  const dirs = [
    path.join(kbRoot, "sources", "agent"),
    path.join(kbRoot, "sources", "user", "notes"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    results.push(...files);
  }
  return results.sort();
}

function readSource(kbRoot: string, slug: string): string | null {
  // Reject path traversal
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
    return null;
  }
  const filename = slug.endsWith(".md") ? slug : `${slug}.md`;
  const candidates = [
    path.join(kbRoot, "sources", "agent", filename),
    path.join(kbRoot, "sources", "user", "notes", filename),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink()) {
      return fs.readFileSync(filePath, "utf-8");
    }
  }
  return null;
}

function handleWikiPage(wiki: Wiki, kbRoot: string, pageName: string): { html: string; status: number } {
  const pagePath = pageName.endsWith(".md") ? pageName : `${pageName}.md`;
  const content = wiki.readPage(pagePath);
  const sidebar = getSidebarData(wiki, kbRoot, `/wiki/${pageName}`);

  if (content === null) {
    return { html: renderPage("Not Found", `<h1>Page not found</h1><p class="empty">${escapeHtml(pageName)} does not exist.</p>`, sidebar), status: 404 };
  }

  return { html: renderPage(pageName, renderMarkdown(content), sidebar), status: 200 };
}

function handleIndex(wiki: Wiki, kbRoot: string): string {
  const sidebar = getSidebarData(wiki, kbRoot, "/");
  const content = wiki.readPage("index.md");

  if (!content || content.trim() === "") {
    return renderPage("Wiki", `<h1>autopedia</h1><p class="empty">No pages yet. Start a conversation with your AI tool.</p>`, sidebar);
  }

  return renderPage("Wiki", renderMarkdown(content), sidebar);
}

function handleSources(wiki: Wiki, kbRoot: string): string {
  const sidebar = getSidebarData(wiki, kbRoot, "/sources");
  const sources = listAllSources(kbRoot);

  if (sources.length === 0) {
    return renderPage("Sources", `<h1>Sources</h1><p class="empty">No sources saved. Paste a URL in conversation.</p>`, sidebar);
  }

  const list = sources.map(s => {
    const name = s.replace(/\.md$/, "");
    return `<li><a href="/sources/${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`;
  }).join("\n");

  return renderPage("Sources", `<h1>Sources</h1><ul class="source-list">${list}</ul>`, sidebar);
}

function handleSourceDetail(wiki: Wiki, kbRoot: string, slug: string): { html: string; status: number } {
  const sidebar = getSidebarData(wiki, kbRoot, `/sources/${slug}`);
  const content = readSource(kbRoot, slug);

  if (content === null) {
    return { html: renderPage("Not Found", `<h1>Source not found</h1><p class="empty">${escapeHtml(slug)} does not exist.</p>`, sidebar), status: 404 };
  }

  return { html: renderPage(slug, renderMarkdown(content), sidebar), status: 200 };
}

function handleStatus(wiki: Wiki, kbRoot: string): string {
  const sidebar = getSidebarData(wiki, kbRoot, "/status");
  const pages = wiki.listPages();
  const unprocessed = wiki.listUnprocessedSources();

  const logPath = path.join(kbRoot, "ops", "log.md");
  const logContent = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8")
    : "";
  const logLines = logContent.split("\n").filter(l => l.startsWith("- "));
  const recentLog = logLines.slice(-10);

  const queueHtml = unprocessed.length > 0
    ? `<ul>${unprocessed.map(u => `<li>${escapeHtml(u)}</li>`).join("")}</ul>`
    : `<p class="empty">All caught up.</p>`;

  const logHtml = recentLog.length > 0
    ? `<ul>${recentLog.map(l => `<li>${escapeHtml(l.replace(/^- /, ""))}</li>`).join("")}</ul>`
    : `<p class="empty">No activity yet.</p>`;

  const body = `
    <h1>Status</h1>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Wiki pages</div><div class="value">${pages.length}</div></div>
      <div class="stat-card"><div class="label">Queued</div><div class="value">${unprocessed.length}</div></div>
    </div>
    <h2>Unprocessed Queue</h2>
    ${queueHtml}
    <h2>Recent Activity</h2>
    ${logHtml}
  `;

  return renderPage("Status", body, sidebar);
}

// ── Server factory ──────────────────────────────────────────────

export function createDashboard(kbRoot: string): http.Server {
  const wiki = new Wiki(kbRoot);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    let result: { html: string; status: number };

    try {
      if (pathname === "/" || pathname === "") {
        result = { html: handleIndex(wiki, kbRoot), status: 200 };
      } else if (pathname.startsWith("/wiki/")) {
        const pageName = pathname.slice(6); // remove "/wiki/"
        result = handleWikiPage(wiki, kbRoot, pageName);
      } else if (pathname === "/sources") {
        result = { html: handleSources(wiki, kbRoot), status: 200 };
      } else if (pathname.startsWith("/sources/")) {
        const slug = pathname.slice(9); // remove "/sources/"
        result = handleSourceDetail(wiki, kbRoot, slug);
      } else if (pathname === "/status") {
        result = { html: handleStatus(wiki, kbRoot), status: 200 };
      } else {
        result = {
          html: renderPage("Not Found", `<h1>404</h1><p>Page not found.</p>`, getSidebarData(wiki, kbRoot, pathname)),
          status: 404,
        };
      }

      res.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(result.html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPage("Error", `<h1>Error</h1><p>${escapeHtml(msg)}</p>`, getSidebarData(wiki, kbRoot, "/")));
    }
  });

  return server;
}

export function startDashboard(kbRoot: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createDashboard(kbRoot);
    server.on("error", reject);
    // Bind to localhost only — dashboard is a local viewer, not a public server
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
