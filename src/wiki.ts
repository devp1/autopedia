import * as fs from "node:fs";
import * as path from "node:path";

export interface SearchResult {
  path: string;
  matches: string[];
}

export class Wiki {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private validateNoSymlinksInPath(
    dirPath: string,
    allowedPrefixes: string[]
  ): void {
    if (!fs.existsSync(dirPath)) return;

    const realDir = fs.realpathSync(dirPath);
    const isRealAllowed = allowedPrefixes.some((prefix) => {
      const dirBase = prefix.endsWith(path.sep)
        ? prefix.slice(0, -1)
        : prefix;
      const realBase = fs.existsSync(dirBase)
        ? fs.realpathSync(dirBase)
        : dirBase;
      return (
        realDir === realBase || realDir.startsWith(realBase + path.sep)
      );
    });

    if (!isRealAllowed) {
      throw new Error(
        `Write rejected: path resolves outside allowed directories via symlink`
      );
    }
  }

  // ── Sacred boundary enforcer ──────────────────────────────────

  safeWrite(filePath: string, content: string): void {
    // Reject null bytes
    if (filePath.includes("\0")) {
      throw new Error("Path contains null bytes");
    }

    const resolved = path.resolve(this.root, filePath);

    // Must be inside one of the allowed directories
    const allowedPrefixes = [
      path.join(this.root, "wiki") + path.sep,
      path.join(this.root, "ops") + path.sep,
      path.join(this.root, "sources", "agent") + path.sep,
    ];

    // Also allow the exact files at directory roots (e.g., wiki/index.md)
    const isAllowed = allowedPrefixes.some((prefix) =>
      resolved.startsWith(prefix)
    );

    if (!isAllowed) {
      throw new Error(
        `Write rejected: ${filePath} is outside allowed directories`
      );
    }

    // Reject if the target file itself is a symlink (prevents following symlinks)
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(
        `Write rejected: ${filePath} is a symlink`
      );
    }

    // Walk the entire path from root to parentDir checking for symlinks
    const parentDir = path.dirname(resolved);
    this.validateNoSymlinksInPath(parentDir, allowedPrefixes);

    // Ensure parent directory exists
    fs.mkdirSync(parentDir, { recursive: true });

    // Re-validate after mkdir (closes TOCTOU gap for mkdir race)
    this.validateNoSymlinksInPath(parentDir, allowedPrefixes);

    // Re-check the target isn't now a symlink (closes TOCTOU gap)
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(
        `Write rejected: ${filePath} became a symlink after validation`
      );
    }

    fs.writeFileSync(resolved, content, "utf-8");
  }

  // ── Read operations ───────────────────────────────────────────

  readPage(pagePath: string): string | null {
    const resolved = path.resolve(this.root, "wiki", pagePath);
    if (!resolved.startsWith(path.join(this.root, "wiki") + path.sep)) {
      throw new Error(`Read rejected: ${pagePath} is outside wiki/`);
    }
    if (!fs.existsSync(resolved)) return null;

    // Reject symlinks (prevents arbitrary file reads via symlinked wiki pages)
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Read rejected: ${pagePath} is a symlink`);
    }

    return fs.readFileSync(resolved, "utf-8");
  }

  listPages(dir?: string): string[] {
    const baseDir = dir
      ? path.resolve(this.root, "wiki", dir)
      : path.join(this.root, "wiki");

    const wikiDir = path.join(this.root, "wiki");
    if (baseDir !== wikiDir && !baseDir.startsWith(wikiDir + path.sep)) {
      throw new Error(`List rejected: ${dir} is outside wiki/`);
    }
    if (!fs.existsSync(baseDir)) return [];

    const results: string[] = [];
    const walk = (dirPath: string) => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith(".md")) {
          results.push(path.relative(path.join(this.root, "wiki"), fullPath));
        }
      }
    };
    walk(baseDir);
    return results.sort();
  }

  searchPages(query: string): SearchResult[] {
    const pages = this.listPages();
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const page of pages) {
      const content = this.readPage(page);
      if (!content) continue;

      const lines = content.split("\n");
      const matches: string[] = [];
      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery)) {
          matches.push(line.trim());
        }
      }
      if (matches.length > 0) {
        results.push({ path: page, matches: matches.slice(0, 5) });
      }
    }
    return results;
  }

  readIndex(): string {
    const indexPath = path.join(this.root, "wiki", "index.md");
    if (!fs.existsSync(indexPath)) return "";
    return fs.readFileSync(indexPath, "utf-8");
  }

  // ── Write operations (all go through safeWrite) ───────────────

  writePage(pagePath: string, content: string): void {
    this.safeWrite(path.join("wiki", pagePath), content);
  }

  appendLog(entry: string): void {
    const logPath = path.join(this.root, "ops", "log.md");
    const timestamp = new Date().toISOString();
    const logEntry = `\n- **${timestamp}**: ${entry}`;

    if (fs.existsSync(logPath)) {
      const existing = fs.readFileSync(logPath, "utf-8");
      this.safeWrite("ops/log.md", existing + logEntry);
    } else {
      this.safeWrite("ops/log.md", `# Operations Log${logEntry}`);
    }
  }

  updateMetrics(): void {
    const pages = this.listPages();
    const now = new Date().toISOString();
    const content = [
      "# Wiki Metrics",
      "",
      `- **Page count**: ${pages.length}`,
      `- **Last updated**: ${now}`,
      `- **Pages**: ${pages.join(", ") || "(none)"}`,
    ].join("\n");

    this.safeWrite("ops/metrics.md", content);
  }

  // ── Delete operations ─────────────────────────────────────────

  /** Validate a path for deletion: boundary check + ancestor symlink check */
  private validateDeletePath(resolved: string, allowedPrefix: string, label: string): void {
    if (!resolved.startsWith(allowedPrefix + path.sep)) {
      throw new Error(`Delete rejected: ${label} is outside allowed directory`);
    }
    if (!fs.existsSync(resolved)) return;
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Delete rejected: ${label} is a symlink`);
    }
    // Ancestor symlink check (same hardening as safeWrite)
    let ancestor = path.dirname(resolved);
    while (ancestor.length >= this.root.length) {
      if (fs.existsSync(ancestor)) {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          throw new Error(`Delete rejected: ancestor directory is a symlink`);
        }
        const realAncestor = fs.realpathSync(ancestor);
        if (realAncestor !== this.root && !realAncestor.startsWith(this.root + path.sep)) {
          throw new Error(`Delete rejected: ancestor resolves outside KB root`);
        }
        break;
      }
      ancestor = path.dirname(ancestor);
    }
  }

  /** Delete a wiki page. Returns false if page doesn't exist. */
  removePage(pagePath: string): boolean {
    const filename = pagePath.endsWith(".md") ? pagePath : `${pagePath}.md`;
    const resolved = path.resolve(this.root, "wiki", filename);
    this.validateDeletePath(resolved, path.join(this.root, "wiki"), pagePath);
    if (!fs.existsSync(resolved)) return false;
    fs.unlinkSync(resolved);

    // Clean up reference from index.md
    const pageName = filename.replace(/\.md$/, "");
    const indexPath = path.join(this.root, "wiki", "index.md");
    if (fs.existsSync(indexPath) && pageName !== "index") {
      const indexContent = fs.readFileSync(indexPath, "utf-8");
      const cleaned = indexContent
        .split("\n")
        .filter((line) => !line.includes(`[[${pageName}]]`) && !line.includes(`[[${pageName}.md]]`))
        .join("\n");
      if (cleaned !== indexContent) {
        this.safeWrite("wiki/index.md", cleaned);
      }
    }
    return true;
  }

  /** Find pages that still reference a deleted page name (checks both [[name]] and [[name.md]]) */
  reconcileAfterDelete(pageName: string): string[] {
    const pages = this.listPages();
    const broken: string[] = [];
    for (const page of pages) {
      const content = this.readPage(page);
      if (content && (content.includes(`[[${pageName}]]`) || content.includes(`[[${pageName}.md]]`))) {
        broken.push(page.replace(/\.md$/, ""));
      }
    }
    return broken;
  }

  /** Delete a source file (any type, any directory). Returns false if not found. */
  removeSource(slug: string): boolean {
    if (slug.includes("..") || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
      throw new Error("Delete rejected: invalid slug");
    }
    const hasExtension = /\.[a-z0-9]+$/i.test(slug);
    const candidates = hasExtension ? [slug] : [`${slug}.md`, slug];
    const dirs = [
      path.join(this.root, "sources", "agent"),
      path.join(this.root, "sources", "user", "notes"),
      path.join(this.root, "sources", "user"),
    ];

    for (const dir of dirs) {
      for (const filename of candidates) {
        const filePath = path.join(dir, filename);
        if (!fs.existsSync(filePath)) continue;
        this.validateDeletePath(filePath, path.join(this.root, "sources"), slug);
        fs.unlinkSync(filePath);
        this.removeFromQueue(slug);
        return true;
      }
    }
    return false;
  }

  /** Remove queue entries that match the slug exactly (as whole entry or after prefix) */
  private removeFromQueue(slug: string): void {
    const queuePath = path.join(this.root, "ops", "queue.md");
    if (!fs.existsSync(queuePath)) return;
    const content = fs.readFileSync(queuePath, "utf-8");
    const baseSlug = slug.replace(/\.[^.]+$/, ""); // strip extension for matching
    const filtered = content
      .split("\n")
      .filter((line) => {
        const entry = line.replace(/^- \[[ x]\] /, "").trim();
        // Match exact entry, note:slug, file:slug, repo:slug, or slug with extension
        return entry !== slug && entry !== baseSlug
          && entry !== `note:${baseSlug}` && entry !== `file:${slug}` && entry !== `file:${baseSlug}`
          && entry !== `repo:${baseSlug}` && entry !== `repo:${slug}`;
      })
      .join("\n");
    if (filtered !== content) {
      this.safeWrite("ops/queue.md", filtered);
    }
  }

  // ── Source operations ─────────────────────────────────────────

  saveAgentSource(slug: string, content: string): void {
    this.safeWrite(path.join("sources", "agent", `${slug}.md`), content);
  }

  saveUserFile(filename: string, sourcePath: string): void {
    // Reject path traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
      throw new Error("Write rejected: invalid filename");
    }

    const destPath = path.join("sources", "user", filename);
    const resolved = path.resolve(this.root, destPath);
    const allowedDir = path.join(this.root, "sources", "user") + path.sep;

    if (!resolved.startsWith(allowedDir)) {
      throw new Error("Write rejected: file path resolves outside sources/user/");
    }
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error("Write rejected: target is a symlink");
    }

    // Ancestor symlink check (mirrors safeWriteNote hardening)
    let ancestor = path.dirname(resolved);
    while (ancestor.length >= this.root.length) {
      if (fs.existsSync(ancestor)) {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          throw new Error("Write rejected: ancestor directory is a symlink");
        }
        const realAncestor = fs.realpathSync(ancestor);
        if (realAncestor !== this.root && !realAncestor.startsWith(this.root + path.sep)) {
          throw new Error("Write rejected: ancestor directory resolves outside KB root");
        }
        break;
      }
      ancestor = path.dirname(ancestor);
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.copyFileSync(sourcePath, resolved);
  }

  // ── Link extraction & graph ────────────────────────────────────

  /** Extract [[wikilink]] targets from a page (skips fenced code blocks) */
  extractLinks(pagePath: string): string[] {
    const content = this.readPage(pagePath);
    if (!content) return [];
    const stripped = content.replace(/```[\s\S]*?```/g, "");
    const targets: string[] = [];
    const pattern = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      targets.push(match[1]);
    }
    return targets;
  }

  /** Build a full graph of wiki pages and their wikilink edges */
  buildGraph(): { nodes: string[]; edges: { source: string; target: string }[] } {
    const pages = this.listPages();
    const nodes = pages.map((p) => p.replace(/\.md$/, ""));
    const edges: { source: string; target: string }[] = [];
    for (const page of pages) {
      const source = page.replace(/\.md$/, "");
      for (const raw of this.extractLinks(page)) {
        const target = raw.replace(/\.md$/, ""); // normalize [[foo.md]] → foo
        edges.push({ source, target });
      }
    }
    return { nodes, edges };
  }

  /** Find pages that link TO the given page name (without .md) */
  getBacklinks(pageName: string): string[] {
    const pages = this.listPages();
    const backlinks: string[] = [];
    for (const page of pages) {
      const source = page.replace(/\.md$/, "");
      if (source === pageName) continue;
      const targets = this.extractLinks(page).map((t) => t.replace(/\.md$/, ""));
      if (targets.includes(pageName)) {
        backlinks.push(source);
      }
    }
    return backlinks.sort();
  }

  // ── Queue & sources ──────────────────────────────────────────

  listUnprocessedSources(): string[] {
    const queuePath = path.join(this.root, "ops", "queue.md");
    if (!fs.existsSync(queuePath)) return [];
    const content = fs.readFileSync(queuePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.startsWith("- [ ] "));
    return lines.map((l) => l.replace("- [ ] ", "").trim());
  }

  addToQueue(entry: string): void {
    const queuePath = path.join(this.root, "ops", "queue.md");
    const line = `- [ ] ${entry}`;
    if (fs.existsSync(queuePath)) {
      const existing = fs.readFileSync(queuePath, "utf-8");
      // Skip if already queued (unprocessed) — prevents duplicates on re-scan
      if (existing.includes(line)) return;
      this.safeWrite("ops/queue.md", existing + "\n" + line);
    } else {
      this.safeWrite("ops/queue.md", `# Source Queue\n${line}`);
    }
  }

  markProcessed(entry: string): void {
    const queuePath = path.join(this.root, "ops", "queue.md");
    if (!fs.existsSync(queuePath)) return;
    const content = fs.readFileSync(queuePath, "utf-8");
    const updated = content.replace(`- [ ] ${entry}`, `- [x] ${entry}`);
    this.safeWrite("ops/queue.md", updated);
  }

  /** Find source files not referenced in queue or log (added via Obsidian, IDE, etc.) */
  scanUntracked(): { file: string; dir: "agent" | "user" }[] {
    // Collect all known slugs from queue (both processed and unprocessed) and log
    const knownSlugs = new Set<string>();
    const opsFiles = ["ops/queue.md", "ops/log.md"];
    for (const rel of opsFiles) {
      const filePath = path.join(this.root, rel);
      if (!fs.existsSync(filePath)) continue;
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      for (const line of lines) {
        // Extract slug-like tokens from each line
        const tokens = line.match(/[a-z0-9][-a-z0-9]{5,}/gi);
        if (tokens) tokens.forEach((t) => knownSlugs.add(t));
      }
    }

    const untracked: { file: string; dir: "agent" | "user" }[] = [];
    const dirs: { path: string; type: "agent" | "user" }[] = [
      { path: path.join(this.root, "sources", "agent"), type: "agent" },
      { path: path.join(this.root, "sources", "user", "notes"), type: "user" },
      { path: path.join(this.root, "sources", "user"), type: "user" },
    ];

    for (const { path: dirPath, type } of dirs) {
      if (!fs.existsSync(dirPath)) continue;
      const files = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name);
      for (const file of files) {
        const slug = file.replace(/\.[^.]+$/, ""); // strip any extension
        if (!knownSlugs.has(slug)) {
          untracked.push({ file, dir: type });
        }
      }
    }
    return untracked;
  }

  // ── Init ──────────────────────────────────────────────────────

  init(): void {
    const dirs = [
      "sources/user",
      "sources/user/notes",
      "sources/agent",
      "wiki",
      "ops",
      "schema",
    ];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    }

    // Create default files if they don't exist
    const defaults: Record<string, string> = {
      "wiki/index.md": "---\ntitle: Wiki Index\n---\n\n# Wiki Index\n\n*No pages yet.*\n",
      "ops/log.md": "# Operations Log\n",
      "ops/metrics.md":
        "# Wiki Metrics\n\n- **Page count**: 0\n- **Last updated**: never\n",
      "ops/queue.md": "# Source Queue\n",
    };

    for (const [filePath, content] of Object.entries(defaults)) {
      const fullPath = path.join(this.root, filePath);
      if (!fs.existsSync(fullPath)) {
        this.safeWrite(filePath, content);
      }
    }
  }

  // ── Safe note writing (sources/user/notes/) ───────────────

  safeWriteNote(slug: string, content: string): void {
    const notePath = path.join("sources", "user", "notes", `${slug}.md`);
    const resolved = path.resolve(this.root, notePath);
    const allowedDir =
      path.join(this.root, "sources", "user", "notes") + path.sep;

    if (!resolved.startsWith(allowedDir)) {
      throw new Error(
        `Write rejected: note path resolves outside sources/user/notes/`
      );
    }

    // Check target file for symlink
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Write rejected: target is a symlink`);
    }

    // Walk existing ancestors for symlinks BEFORE mkdirSync
    // This catches symlinks at sources/user even when notes/ doesn't exist yet
    let ancestor = path.dirname(resolved);
    while (ancestor.length >= this.root.length) {
      if (fs.existsSync(ancestor)) {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          throw new Error(
            `Write rejected: ancestor directory is a symlink outside allowed path`
          );
        }
        // Once we find an existing non-symlink ancestor, verify realpath
        const realAncestor = fs.realpathSync(ancestor);
        if (
          realAncestor !== this.root &&
          !realAncestor.startsWith(this.root + path.sep)
        ) {
          throw new Error(
            `Write rejected: ancestor directory is a symlink outside allowed path`
          );
        }
        break;
      }
      ancestor = path.dirname(ancestor);
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
  }
}

// ── URL validation (SSRF protection) ──────────────────────────

export function validateUrl(url: string): void {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme not allowed: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  const blockedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "metadata.google.internal",
    "169.254.169.254",
  ]);
  if (blockedHosts.has(hostname)) {
    throw new Error(`URL hostname blocked: ${hostname}`);
  }

  if (hostname.includes(":")) {
    throw new Error(`IPv6 addresses are not allowed: ${hostname}`);
  }

  if (/^[0-9]/.test(hostname) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    throw new Error(`Non-standard IP notation not allowed: ${hostname}`);
  }

  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      throw new Error(`URL points to private/reserved IP range: ${hostname}`);
    }
  }
}
