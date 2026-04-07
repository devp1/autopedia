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
      return `<a href="${escapeHtml(safeHref)}">${escapeHtml(text)}</a>`;
    },
    image({ href, text }: { href: string; text: string }) {
      const safeHref = sanitizeHref(href);
      return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}" />`;
    },
  },
});

function renderMarkdown(content: string): string {
  // Strip YAML frontmatter (---\n...\n---) before rendering — handles \r\n too
  const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // First: render markdown to HTML (raw HTML is escaped by our custom renderer)
  const html = markedInstance.parse(stripped, { async: false }) as string;
  // Then: convert [[wikilinks]] to clickable links in the rendered HTML
  return html.replace(
    /\[\[([^\]]+)\]\]/g,
    (_match, page: string) => `<a href="/wiki/${encodeURIComponent(page)}" class="wikilink">${escapeHtml(page)}</a>`
  );
}

// ── Design tokens ───────────────────────────────────────────────

const CSS = `
/* ── Fonts: Newsreader (display) + DM Sans (body) ── */
@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,500;0,6..72,700;1,6..72,400&family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400&display=swap');

:root {
  --bg: #fafaf9;
  --surface: #ffffff;
  --text: #1a1a19;
  --text-secondary: #78756f;
  --accent: #c45d3e;
  --accent-hover: #a84a2f;
  --accent-subtle: rgba(196,93,62,0.08);
  --border: #e8e6e1;
  --sidebar-bg: #f3f2ee;
  --sidebar-hover: rgba(0,0,0,0.04);
  --code-bg: #f3f2ee;
  --code-border: #e0ddd7;
  --shadow: 0 1px 3px rgba(0,0,0,0.04);
  --font-display: 'Newsreader', Georgia, 'Times New Roman', serif;
  --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0c0b;
    --surface: #141413;
    --text: #e8e6e1;
    --text-secondary: #7a7872;
    --accent: #e07a5f;
    --accent-hover: #eb9178;
    --accent-subtle: rgba(224,122,95,0.1);
    --border: #252420;
    --sidebar-bg: #111110;
    --sidebar-hover: rgba(255,255,255,0.04);
    --code-bg: #1a1918;
    --code-border: #2a2825;
    --shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.7;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  grid-template-rows: 1fr;
  min-height: 100vh;
}

/* ── Sidebar ────────────────────────────── */

.sidebar {
  padding: 32px 0 24px;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  position: sticky;
  top: 0;
  height: 100vh;
}

.sidebar-brand {
  padding: 0 24px 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-brand a {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
  letter-spacing: -0.03em;
}

.theme-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
  transition: color 0.15s;
}

.theme-toggle:hover { color: var(--text); }

.sidebar-section { margin-bottom: 8px; }

.sidebar h2 {
  font-family: var(--font-body);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
  padding: 12px 24px 6px;
}

.sidebar ul { list-style: none; }

.sidebar li a {
  display: block;
  padding: 5px 24px 5px 28px;
  font-size: 14px;
  font-weight: 400;
  color: var(--text-secondary);
  text-decoration: none;
  border-left: 2px solid transparent;
  transition: all 0.12s ease;
}

.sidebar li a:hover {
  color: var(--text);
  background: var(--sidebar-hover);
}

.sidebar li a.active {
  color: var(--accent);
  border-left-color: var(--accent);
  font-weight: 500;
  background: var(--accent-subtle);
}

.queue-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  padding: 1px 6px;
  margin-left: 6px;
  vertical-align: middle;
  line-height: 1.4;
}

.sidebar-nav-link {
  display: block;
  padding: 5px 24px 5px 28px;
  font-size: 14px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: color 0.12s;
}

.sidebar-nav-link:hover { color: var(--text); }
.sidebar-nav-link.active { color: var(--accent); font-weight: 500; }

/* ── Content ────────────────────────────── */

.content {
  padding: 48px 56px 80px;
  max-width: 720px;
  overflow-y: auto;
}

.content h1 {
  font-family: var(--font-display);
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.2;
  margin-bottom: 8px;
  color: var(--text);
}

.content h2 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.015em;
  margin: 40px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}

.content h3 {
  font-family: var(--font-body);
  font-size: 16px;
  font-weight: 700;
  margin: 28px 0 8px;
  color: var(--text);
}

.content p { margin-bottom: 16px; }

.content ul, .content ol {
  margin-bottom: 16px;
  padding-left: 20px;
}

.content li {
  margin-bottom: 6px;
  line-height: 1.6;
}

.content a {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s;
}

.content a:hover { border-bottom-color: var(--accent); }

.content pre {
  font-family: var(--font-mono);
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 8px;
  padding: 16px 20px;
  overflow-x: auto;
  margin-bottom: 20px;
  font-size: 13px;
  line-height: 1.6;
}

.content code {
  font-family: var(--font-mono);
  background: var(--code-bg);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 13px;
}

.content pre code { background: none; padding: 0; border-radius: 0; }

.content blockquote {
  border-left: 2px solid var(--accent);
  padding: 2px 0 2px 20px;
  margin: 0 0 20px;
  color: var(--text-secondary);
  font-style: italic;
}

.content hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 32px 0;
}

.wikilink {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent);
  transition: border-color 0.15s;
}

.wikilink:hover { border-bottom-style: solid; }

/* ── Breadcrumb ────────────────────────── */

.breadcrumb {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.breadcrumb a {
  color: var(--text-secondary);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: all 0.15s;
}

.breadcrumb a:hover {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.breadcrumb .separator { margin: 0 6px; }

/* ── Empty state ────────────────────────── */

.empty {
  color: var(--text-secondary);
  padding: 32px 0;
  font-size: 15px;
  line-height: 1.7;
}

/* ── Getting started card ──────────────── */

.getting-started {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 28px 32px;
  margin-top: 20px;
  box-shadow: var(--shadow);
}

.getting-started h2 {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 500;
  margin: 0 0 12px;
  border: none;
  padding: 0;
}

.getting-started p {
  color: var(--text-secondary);
  margin-bottom: 16px;
}

/* ── Source list ─────────────────────────── */

.source-list {
  list-style: none;
  padding: 0;
}

.source-list li {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.source-list li:last-child { border-bottom: none; }

.source-list li a {
  font-weight: 500;
  color: var(--text);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: all 0.15s;
}

.source-list li a:hover {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* ── Status cards ────────────────────────── */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}

.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px 24px;
  box-shadow: var(--shadow);
}

@media (prefers-color-scheme: dark) {
  .stat-card { border-color: #333; }
}

[data-theme="dark"] .stat-card { border-color: #333; }

.stat-card .label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.stat-card .value {
  font-family: var(--font-display);
  font-size: 36px;
  font-weight: 700;
  margin-top: 4px;
  letter-spacing: -0.02em;
  color: var(--text);
}

/* ── Responsive ─────────────────────────── */

@media (max-width: 768px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }

  .sidebar {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 16px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .sidebar-brand { padding: 0 16px 12px; }
  .sidebar h2 { display: none; }
  .sidebar-section { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 12px; }
  .sidebar ul { display: flex; flex-wrap: wrap; gap: 2px; }
  .sidebar li a {
    padding: 4px 12px;
    border-left: none;
    border-radius: 6px;
    font-size: 13px;
  }
  .sidebar li a.active { background: var(--accent); color: #fff; border-left: none; }

  .content { padding: 24px 16px 48px; overflow-y: visible; }
  .content h1 { font-size: 26px; }
  .content h2 { font-size: 19px; }
}

/* ── Page load animation ─────────────────── */

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.content { animation: fadeIn 0.25s ease-out; }

/* ── Graph view ────────────────────────── */

.graph-content { max-width: none; }
.graph-container { width: 100%; height: calc(100vh - 120px); }
.graph-container svg { width: 100%; height: 100%; }

/* ── Backlinks ─────────────────────────── */

.backlinks { margin-top: 40px; }
.backlinks h3 {
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.backlinks ul { list-style: none; padding: 0; }
.backlinks li { display: inline; }
.backlinks li + li::before { content: " · "; color: var(--text-secondary); }
.backlinks a { font-size: 14px; }
`;

// ── Theme toggle script (minimal inline JS) ─────────────────────

const THEME_SCRIPT = `
<script>
(function() {
  var btn = document.querySelector('.theme-toggle');
  var html = document.documentElement;
  var stored = localStorage.getItem('autopedia-theme');
  if (stored) html.setAttribute('data-theme', stored);
  function updateIcon() {
    var theme = html.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (btn) btn.textContent = theme === 'dark' ? '\\u2600' : '\\u263E';
  }
  updateIcon();
  if (btn) btn.addEventListener('click', function() {
    var current = html.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : (current === 'light' ? 'dark' :
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
    html.setAttribute('data-theme', next);
    localStorage.setItem('autopedia-theme', next);
    updateIcon();
  });
})();
</script>
<style>
[data-theme="dark"] { --bg:#0c0c0b; --surface:#141413; --text:#e8e6e1; --text-secondary:#7a7872; --accent:#e07a5f; --accent-hover:#eb9178; --accent-subtle:rgba(224,122,95,0.1); --border:#252420; --sidebar-bg:#111110; --sidebar-hover:rgba(255,255,255,0.04); --code-bg:#1a1918; --code-border:#2a2825; --shadow:0 1px 3px rgba(0,0,0,0.3); }
[data-theme="light"] { --bg:#fafaf9; --surface:#ffffff; --text:#1a1a19; --text-secondary:#78756f; --accent:#c45d3e; --accent-hover:#a84a2f; --accent-subtle:rgba(196,93,62,0.08); --border:#e8e6e1; --sidebar-bg:#f3f2ee; --sidebar-hover:rgba(0,0,0,0.04); --code-bg:#f3f2ee; --code-border:#e0ddd7; --shadow:0 1px 3px rgba(0,0,0,0.04); }
</style>
`;

// ── Display name helper ─────────────────────────────────────────

export function displayName(slug: string): string {
  return slug
    .replace(/^\d{4}-\d{2}-\d{2}-/, "") // strip date prefix
    .replace(/^(?=[a-z0-9]*\d)[a-z0-9]{7,9}-/, "") // strip base36 timestamp (has digit, 7-9 chars)
    .replace(/\.(md|txt|pdf)$/, "")
    .replace(/-/g, " ");
}

// ── Page template ───────────────────────────────────────────────

interface SidebarData {
  pages: string[];
  sources: string[];
  sourceTitles: Map<string, string>;
  queueCount: number;
  untrackedCount: number;
  activePath: string;
}

function buildSidebar(data: SidebarData): string {
  // Pinned index at top, then other pages alphabetically (deduplicated)
  const indexActive = data.activePath === "/" || data.activePath === "/wiki/index";
  const indexItem = `<li><a href="/" class="${indexActive ? "active" : ""}">Home</a></li>`;
  const otherPages = data.pages.filter(p => p !== "index.md");
  const otherItems = otherPages.map(p => {
    const name = p.replace(/\.md$/, "");
    const isActive = data.activePath === `/wiki/${name}`;
    return `<li><a href="/wiki/${encodeURIComponent(name)}" class="${isActive ? "active" : ""}">${escapeHtml(name)}</a></li>`;
  }).join("\n");
  const wikiItems = data.pages.length > 0
    ? indexItem + "\n" + otherItems
    : `<li><span class="empty" style="padding:4px 28px;font-size:13px;">No pages yet</span></li>`;

  const sourceItems = data.sources.length > 0
    ? data.sources.map(s => {
        const name = s.replace(/\.md$/, "");
        const isActive = data.activePath === `/sources/${name}`;
        const title = data.sourceTitles.get(name) || displayName(name);
        return `<li><a href="/sources/${encodeURIComponent(name)}" class="${isActive ? "active" : ""}" title="${escapeHtml(name)}">${escapeHtml(title)}</a></li>`;
      }).join("\n")
    : `<li><span class="empty" style="padding:4px 28px;font-size:13px;">No sources</span></li>`;

  const queueBadge = data.queueCount > 0
    ? `<span class="queue-badge">${data.queueCount}</span>`
    : "";

  const statusActive = data.activePath === "/status" ? " active" : "";
  const graphActive = data.activePath === "/graph" ? " active" : "";

  return `
    <nav class="sidebar">
      <div class="sidebar-brand">
        <a href="/">autopedia</a>
        <button class="theme-toggle" aria-label="Toggle theme"></button>
      </div>
      <div class="sidebar-section">
        <h2>Wiki</h2>
        <ul>${wikiItems}</ul>
      </div>
      <div class="sidebar-section">
        <h2>Sources</h2>
        <ul>${sourceItems}</ul>
      </div>
      <div class="sidebar-section">
        <h2>System</h2>
        <a href="/graph" class="sidebar-nav-link${graphActive}">Graph</a>
        <a href="/status" class="sidebar-nav-link${statusActive}">Status${queueBadge}</a>
      </div>
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

function buildSourceTitles(kbRoot: string, sources: string[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const s of sources) {
    const slug = s.replace(/\.md$/, "");
    const content = readSource(kbRoot, slug);
    if (content) {
      const heading = content.match(/^#\s+(.+)$/m);
      if (heading) { titles.set(slug, heading[1].slice(0, 60)); continue; }
    }
    titles.set(slug, displayName(slug));
  }
  return titles;
}

function getSidebarData(wiki: Wiki, kbRoot: string, activePath: string): SidebarData {
  const pages = wiki.listPages();
  const sources = listAllSources(kbRoot);
  const sourceTitles = buildSourceTitles(kbRoot, sources);
  const queueCount = wiki.listUnprocessedSources().length;
  const untrackedCount = wiki.scanUntracked().length;
  return { pages, sources, sourceTitles, queueCount, untrackedCount, activePath };
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

  const breadcrumb = `<nav class="breadcrumb"><a href="/">Wiki</a><span class="separator">/</span><span>${escapeHtml(pageName)}</span></nav>`;
  const backlinks = wiki.getBacklinks(pageName);
  const backlinksHtml = backlinks.length > 0
    ? `<hr><section class="backlinks"><h3>Linked from</h3><ul>${backlinks.map(b => `<li><a href="/wiki/${encodeURIComponent(b)}">${escapeHtml(b)}</a></li>`).join("")}</ul></section>`
    : "";
  return { html: renderPage(pageName, breadcrumb + renderMarkdown(content) + backlinksHtml, sidebar), status: 200 };
}

function handleIndex(wiki: Wiki, kbRoot: string): string {
  const sidebar = getSidebarData(wiki, kbRoot, "/");
  const content = wiki.readPage("index.md");

  if (!content || content.trim() === "") {
    const gettingStarted = `<h1>autopedia</h1>
      <div class="getting-started">
        <h2>Welcome to your wiki</h2>
        <p>Start by adding sources — your AI tool will build wiki pages from them.</p>
        <pre><code>autopedia add "your thought here"
autopedia add https://example.com/article
autopedia add ~/research/notes.md</code></pre>
        <p>Then connect your AI tool — it will process your queue and build wiki pages automatically.</p>
      </div>`;
    return renderPage("Wiki", gettingStarted, sidebar);
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
    return `<li><a href="/sources/${encodeURIComponent(name)}" title="${escapeHtml(name)}">${escapeHtml(displayName(name))}</a></li>`;
  }).join("\n");

  return renderPage("Sources", `<h1>Sources</h1><ul class="source-list">${list}</ul>`, sidebar);
}

function handleSourceDetail(wiki: Wiki, kbRoot: string, slug: string): { html: string; status: number } {
  const sidebar = getSidebarData(wiki, kbRoot, `/sources/${slug}`);
  const content = readSource(kbRoot, slug);

  if (content === null) {
    return { html: renderPage("Not Found", `<h1>Source not found</h1><p class="empty">${escapeHtml(slug)} does not exist.</p>`, sidebar), status: 404 };
  }

  const breadcrumb = `<nav class="breadcrumb"><a href="/sources">Sources</a><span class="separator">/</span><span>${escapeHtml(displayName(slug))}</span></nav>`;
  return { html: renderPage(displayName(slug), breadcrumb + renderMarkdown(content), sidebar), status: 200 };
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
    ? `<ul>${unprocessed.map(u => {
        // URLs and prefixed entries (note:, file:) stay as-is; only slugs get displayName
        const label = u.startsWith("http") || u.includes(":") ? u : displayName(u);
        return `<li title="${escapeHtml(u)}">${escapeHtml(label)}</li>`;
      }).join("")}</ul>`
    : `<p class="empty">All caught up.</p>`;

  const logHtml = recentLog.length > 0
    ? `<ul>${recentLog.map(l => `<li>${escapeHtml(l.replace(/^- /, ""))}</li>`).join("")}</ul>`
    : `<p class="empty">No activity yet.</p>`;

  const body = `
    <h1>Status</h1>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Wiki pages</div><div class="value">${pages.length}</div></div>
      <div class="stat-card"><div class="label">Queued</div><div class="value">${unprocessed.length}</div></div>
      ${sidebar.untrackedCount > 0 ? `<div class="stat-card"><div class="label">Untracked</div><div class="value">${sidebar.untrackedCount}</div></div>` : ""}
    </div>
    ${sidebar.untrackedCount > 0 ? `<p class="empty" style="padding:0 0 16px;">💡 ${sidebar.untrackedCount} file(s) added outside autopedia — run <code>autopedia scan</code> to queue them.</p>` : ""}
    <h2>Unprocessed Queue</h2>
    ${queueHtml}
    <h2>Recent Activity</h2>
    ${logHtml}
  `;

  return renderPage("Status", body, sidebar);
}

function handleGraph(wiki: Wiki, kbRoot: string): string {
  const sidebar = getSidebarData(wiki, kbRoot, "/graph");
  const graph = wiki.buildGraph();
  // Escape </script> and <!-- in JSON to prevent script breakout (XSS)
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  const graphScript = `
<script>
(function() {
  var data = ${graphJson};
  var svg = document.getElementById('graph-svg');
  var rect = svg.getBoundingClientRect();
  var W = rect.width, H = rect.height;
  var nodes = data.nodes.map(function(id, i) {
    return { id: id, x: W/2 + (Math.random()-0.5)*200, y: H/2 + (Math.random()-0.5)*200, vx: 0, vy: 0 };
  });
  var nodeMap = {};
  nodes.forEach(function(n) { nodeMap[n.id] = n; });
  var edges = data.edges.filter(function(e) { return nodeMap[e.source] && nodeMap[e.target]; });

  var ns = 'http://www.w3.org/2000/svg';
  var edgeEls = edges.map(function(e) {
    var el = document.createElementNS(ns, 'line');
    el.setAttribute('stroke', getComputedStyle(document.documentElement).getPropertyValue('--border').trim());
    el.setAttribute('stroke-width', '1.5');
    svg.appendChild(el);
    return el;
  });
  var nodeEls = nodes.map(function(n) {
    var g = document.createElementNS(ns, 'g');
    g.style.cursor = 'pointer';
    var circle = document.createElementNS(ns, 'circle');
    var r = n.id === 'index' ? 12 : 8;
    var fill = n.id === 'index'
      ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      : getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
    circle.setAttribute('r', r);
    circle.setAttribute('fill', fill);
    var label = document.createElementNS(ns, 'text');
    label.textContent = n.id;
    label.setAttribute('dy', -r - 4);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--text').trim());
    label.setAttribute('font-size', '12');
    label.setAttribute('font-family', getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim());
    g.appendChild(circle);
    g.appendChild(label);
    g.addEventListener('click', function() { window.location.href = '/wiki/' + encodeURIComponent(n.id); });
    svg.appendChild(g);
    return { g: g, circle: circle, node: n, r: r };
  });

  // Force simulation
  var alpha = 1, decay = 0.99, stopped = false;
  function tick() {
    if (stopped) return;
    alpha *= decay;
    if (alpha < 0.001) { stopped = true; return; }
    // Repulsion
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i+1; j < nodes.length; j++) {
        var dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        var d = Math.sqrt(dx*dx + dy*dy) || 1;
        var f = 800 / (d * d);
        nodes[i].vx -= dx/d * f * alpha;
        nodes[i].vy -= dy/d * f * alpha;
        nodes[j].vx += dx/d * f * alpha;
        nodes[j].vy += dy/d * f * alpha;
      }
    }
    // Attraction (edges)
    edges.forEach(function(e) {
      var s = nodeMap[e.source], t = nodeMap[e.target];
      var dx = t.x - s.x, dy = t.y - s.y;
      var d = Math.sqrt(dx*dx + dy*dy) || 1;
      var f = (d - 120) * 0.05 * alpha;
      s.vx += dx/d * f; s.vy += dy/d * f;
      t.vx -= dx/d * f; t.vy -= dy/d * f;
    });
    // Center gravity
    nodes.forEach(function(n) {
      n.vx += (W/2 - n.x) * 0.01 * alpha;
      n.vy += (H/2 - n.y) * 0.01 * alpha;
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(20, Math.min(W-20, n.x));
      n.y = Math.max(20, Math.min(H-20, n.y));
    });
    // Update DOM
    edgeEls.forEach(function(el, i) {
      var s = nodeMap[edges[i].source], t = nodeMap[edges[i].target];
      el.setAttribute('x1', s.x); el.setAttribute('y1', s.y);
      el.setAttribute('x2', t.x); el.setAttribute('y2', t.y);
    });
    nodeEls.forEach(function(ne) {
      ne.g.setAttribute('transform', 'translate(' + ne.node.x + ',' + ne.node.y + ')');
    });
    requestAnimationFrame(tick);
  }
  tick();

  // Drag
  var dragging = null, dragOff = {x:0,y:0};
  svg.addEventListener('mousedown', function(e) {
    for (var i = 0; i < nodeEls.length; i++) {
      var ne = nodeEls[i], dx = e.offsetX - ne.node.x, dy = e.offsetY - ne.node.y;
      if (dx*dx + dy*dy < ne.r*ne.r + 100) {
        dragging = ne.node; dragOff = {x: dx, y: dy};
        stopped = false; alpha = 0.3;
        e.preventDefault(); break;
      }
    }
  });
  svg.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    dragging.x = e.offsetX - dragOff.x;
    dragging.y = e.offsetY - dragOff.y;
    dragging.vx = 0; dragging.vy = 0;
    if (stopped) { stopped = false; alpha = 0.1; tick(); }
  });
  svg.addEventListener('mouseup', function() { dragging = null; });
})();
</script>`;

  const body = `
    <h1>Knowledge Graph</h1>
    <div class="graph-container">
      <svg id="graph-svg"></svg>
    </div>
    ${graphScript}
  `;

  return renderPage("Graph", body, sidebar).replace(
    '<main class="content">',
    '<main class="content graph-content">'
  );
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
      } else if (pathname === "/graph") {
        result = { html: handleGraph(wiki, kbRoot), status: 200 };
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
