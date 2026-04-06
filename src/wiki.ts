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

  // ── Source operations ─────────────────────────────────────────

  saveAgentSource(slug: string, content: string): void {
    this.safeWrite(path.join("sources", "agent", `${slug}.md`), content);
  }

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
      "wiki/index.md": "# Wiki Index\n\n*No pages yet.*\n",
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

    // Walk ancestor directories for symlinks
    const parentDir = path.dirname(resolved);
    if (fs.existsSync(parentDir)) {
      const realParent = fs.realpathSync(parentDir);
      const expectedDir = allowedDir.slice(0, -1); // strip trailing sep
      if (
        realParent !== expectedDir &&
        !realParent.startsWith(allowedDir)
      ) {
        throw new Error(
          `Write rejected: ancestor directory is a symlink outside allowed path`
        );
      }
    }

    fs.mkdirSync(parentDir, { recursive: true });
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
