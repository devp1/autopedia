#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Wiki, validateUrl } from "./wiki.js";
import { startServer } from "./mcp.js";
import { startDashboard } from "./dashboard.js";

// Read schema defaults from package directory (single source of truth)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_SCHEMA_DIR = path.resolve(__dirname, "..", "schema");

function readSchemaDefault(filename: string): string {
  const filePath = path.join(PACKAGE_SCHEMA_DIR, filename);
  return fs.readFileSync(filePath, "utf-8");
}

function findKbRoot(): string {
  const globalRoot = path.join(os.homedir(), ".autopedia");
  const localRoot = path.resolve(process.cwd(), ".autopedia");

  // Migration warning: local wiki exists but global doesn't
  if (!fs.existsSync(globalRoot) && fs.existsSync(localRoot)) {
    console.error(
      "Note: Found local wiki at ./.autopedia/ — use --dir to access it, or move it to ~/.autopedia/"
    );
  }

  return globalRoot;
}

function resolveKbRoot(dir?: string): string {
  if (!dir) return findKbRoot();
  const resolved = path.resolve(dir);
  // Accept both the .autopedia dir itself and its parent
  if (resolved.endsWith(".autopedia")) return resolved;
  return path.join(resolved, ".autopedia");
}

function requireKbRoot(kbRoot: string): void {
  if (!fs.existsSync(kbRoot)) {
    console.error("Error: .autopedia/ not found. Run `autopedia init` first.");
    process.exit(1);
  }
  // Validate this is actually an autopedia root, not an arbitrary directory
  const wikiDir = path.join(kbRoot, "wiki");
  const opsDir = path.join(kbRoot, "ops");
  if (!fs.existsSync(wikiDir) || !fs.existsSync(opsDir)) {
    console.error("Error: directory exists but is not an autopedia knowledge base (missing wiki/ or ops/).");
    process.exit(1);
  }
}

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".text"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function addFileToWiki(wiki: Wiki, filePath: string, date: string, ts: string, index: number): void {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    console.error(`  Skipped ${path.basename(filePath)}: too large (>${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    return;
  }
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    console.error(`  Skipped ${path.basename(filePath)}: symlink`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath, ext);
  const slug = `${date}-${ts}${index > 0 ? `-${index}` : ""}-${basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "")}`;

  if (TEXT_EXTENSIONS.has(ext)) {
    // Text file — read content, save as note
    const content = fs.readFileSync(filePath, "utf-8");
    wiki.safeWriteNote(slug, content);
    wiki.addToQueue(`note:${slug}`);
  } else {
    // Binary file (PDF, docx, images, etc.) — copy as-is
    wiki.saveUserFile(`${slug}${ext}`, filePath);
    wiki.addToQueue(`file:${slug}${ext}`);
  }
}

// ── Repo scanning ─────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", "target", ".cache", "coverage", ".turbo", ".vercel",
  ".output", ".nuxt", ".svelte-kit", ".parcel-cache", ".autopedia",
]);

const EXCLUDED_FILE_PATTERNS = [
  /^\.env/, /\.lock$/, /\.log$/, /^package-lock\.json$/,
  /^yarn\.lock$/, /^pnpm-lock\.yaml$/, /\.(pem|key|cert|crt|pfx|p12)$/,
  /credential/i, /secret/i, /^\.npmrc$/, /^\.netrc$/, /^\.pypirc$/,
  /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /^\.htpasswd$/,
  /^\.pgpass$/, /^token$/i, /^auth$/i, /^\.docker\/config\.json$/,
  /^\.aws\/credentials$/, /kubeconfig/i,
];

const MANIFEST_FILES = new Set([
  "package.json", "cargo.toml", "pyproject.toml", "go.mod", "pom.xml",
  "build.gradle", "gemfile", "requirements.txt", "setup.py", "setup.cfg",
  "composer.json", "mix.exs", "project.clj", "deno.json",
]);

const DOC_FILES = new Set([
  "readme.md", "architecture.md", "claude.md", "contributing.md",
  "changelog.md", "license", "license.md",
]);

const CONFIG_FILES = new Set([
  "tsconfig.json", "jsconfig.json", ".eslintrc", ".eslintrc.json", ".eslintrc.js",
  "eslint.config.js", "eslint.config.mjs", "dockerfile", "docker-compose.yml",
  "docker-compose.yaml", "makefile", ".prettierrc", ".prettierrc.json",
  "vitest.config.ts", "jest.config.js", "jest.config.ts", "webpack.config.js",
  "vite.config.ts", "vite.config.js", "rollup.config.js", ".gitignore",
  "turbo.json", "nx.json",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".scala",
  ".rb", ".php", ".swift", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".ex", ".exs", ".clj", ".lua", ".zig", ".v",
  ".svelte", ".vue",
]);

const GENERATED_EXTENSIONS = new Set([".map"]);
const GENERATED_PATTERNS = [/\.d\.ts$/, /\.min\.js$/, /\.min\.css$/, /\.bundle\.js$/];

const TEST_PATTERNS = [/\.test\./, /\.spec\./, /test[/\\]/, /tests[/\\]/, /__tests__[/\\]/];

export type FileRole = "manifest" | "docs" | "config" | "entry" | "source" | "test" | "generated";

export interface ScoredFile {
  relativePath: string;
  role: FileRole;
  score: number;
  size: number;
  lineCount: number;
}

function classifyFile(relativePath: string, size: number): { role: FileRole; score: number } {
  const basename = path.basename(relativePath).toLowerCase();
  const ext = path.extname(relativePath).toLowerCase();

  // Generated — always excluded
  if (GENERATED_EXTENSIONS.has(ext) || GENERATED_PATTERNS.some(p => p.test(basename))) {
    return { role: "generated", score: 0 };
  }

  // Manifest
  if (MANIFEST_FILES.has(basename)) {
    return { role: "manifest", score: 10 };
  }

  // Docs
  if (DOC_FILES.has(basename) || relativePath.startsWith("docs/") || relativePath.startsWith("docs\\")) {
    return { role: "docs", score: 9 };
  }

  // Config
  if (CONFIG_FILES.has(basename)) {
    return { role: "config", score: 7 };
  }

  // Entry points (common patterns)
  const entryPatterns = [
    /^src[/\\]index\.\w+$/, /^src[/\\]main\.\w+$/, /^src[/\\]app\.\w+$/,
    /^src[/\\]lib\.\w+$/, /^cmd[/\\]main\.\w+$/, /^main\.\w+$/,
    /^index\.\w+$/, /^app\.\w+$/,
  ];
  if (SOURCE_EXTENSIONS.has(ext) && entryPatterns.some(p => p.test(relativePath))) {
    return { role: "entry", score: 8 };
  }

  // Test
  if (SOURCE_EXTENSIONS.has(ext) && TEST_PATTERNS.some(p => p.test(relativePath))) {
    // Prefer medium-sized test files for better signal
    const sizeScore = size > 500 && size < 50000 ? 3 : 2;
    return { role: "test", score: sizeScore };
  }

  // Source — score by size (medium files are most informative)
  if (SOURCE_EXTENSIONS.has(ext)) {
    let sizeScore = 5;
    if (size < 100) sizeScore = 3;        // Tiny — probably re-exports
    else if (size > 100000) sizeScore = 3; // Huge — probably generated/vendored
    else if (size > 2000 && size < 30000) sizeScore = 6; // Sweet spot
    return { role: "source", score: sizeScore };
  }

  // Markdown/text in non-doc locations
  if (ext === ".md" || ext === ".txt") {
    return { role: "docs", score: 4 };
  }

  // Unknown extension — low score source
  return { role: "source", score: 2 };
}

function isExcludedFile(basename: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some(p => p.test(basename));
}

export function discoverFiles(repoPath: string, maxDepth = 5): { files: ScoredFile[]; skipped: number } {
  const results: ScoredFile[] = [];
  let skipped = 0;

  // Build gitignore set: files that git would ignore (if this is a git repo)
  let gitIgnored: Set<string> | null = null;
  if (fs.existsSync(path.join(repoPath, ".git"))) {
    try {
      // Get all tracked + untracked-but-not-ignored files
      const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: repoPath, stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
      }).toString().trim().split("\n").filter(Boolean);
      gitIgnored = new Set<string>();
      // We'll use this as an allowlist — only include files git knows about
      for (const f of tracked) {
        gitIgnored.add(f.replace(/\\/g, "/"));
      }
    } catch {
      gitIgnored = null; // Fall back to static exclusion
    }
  }

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped++;
      return; // Permission denied, etc.
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip symlinks everywhere
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          walk(fullPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (isExcludedFile(entry.name)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      // Skip files over 1MB (likely binary or vendored)
      if (stat.size > 1024 * 1024) continue;

      const relativePath = path.relative(repoPath, fullPath).replace(/\\/g, "/");

      // Skip gitignored files (if we have git data)
      if (gitIgnored && !gitIgnored.has(relativePath)) continue;

      const { role, score } = classifyFile(relativePath, stat.size);

      if (role === "generated") continue;

      // Read content, detect binary (null bytes), count lines
      let lineCount = 0;
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.includes("\0")) continue; // Binary file — skip
        lineCount = content.split("\n").length;
      } catch {
        continue; // Can't read as text — skip
      }

      results.push({ relativePath, role, score, size: stat.size, lineCount });
    }
  }

  walk(repoPath, 0);
  return { files: results, skipped };
}

function selectFiles(files: ScoredFile[]): ScoredFile[] {
  const selected: ScoredFile[] = [];
  let totalLines = 0;
  const MAX_LINES = 5000;
  const MAX_SOURCE = 15;
  const MAX_TEST = 3;

  // 1. Always include manifests, docs, configs, entries (budget-aware)
  const priority = files
    .filter(f => ["manifest", "docs", "config", "entry"].includes(f.role))
    .sort((a, b) => b.score - a.score);

  for (const f of priority) {
    // Docs/configs truncated to 500 lines in bundle, so budget accordingly
    const budgetLines = Math.min(f.lineCount, 500);
    if (totalLines + budgetLines > MAX_LINES && selected.length > 0) break;
    selected.push(f);
    totalLines += budgetLines;
  }

  // 2. Source files — prefer diverse directories
  const sources = files
    .filter(f => f.role === "source")
    .sort((a, b) => b.score - a.score);

  const selectedDirs = new Set<string>();
  let sourceCount = 0;

  for (const f of sources) {
    if (sourceCount >= MAX_SOURCE || totalLines >= MAX_LINES) break;
    const dir = path.dirname(f.relativePath);
    // Prefer files from directories we haven't seen yet
    const dirPenalty = selectedDirs.has(dir) ? 0.5 : 1;
    if (dirPenalty < 1 && sourceCount > 5) {
      // After 5 sources, skip same-dir files if we have options
      const remaining = sources.filter(
        s => !selected.includes(s) && !selectedDirs.has(path.dirname(s.relativePath))
      );
      if (remaining.length > 0) continue;
    }
    selected.push(f);
    selectedDirs.add(dir);
    totalLines += Math.min(f.lineCount, 200); // Budget for truncation
    sourceCount++;
  }

  // 3. Test files (for coverage signal)
  const tests = files
    .filter(f => f.role === "test")
    .sort((a, b) => b.score - a.score);

  let testCount = 0;
  for (const t of tests) {
    if (testCount >= MAX_TEST || totalLines >= MAX_LINES) break;
    selected.push(t);
    totalLines += Math.min(t.lineCount, 200);
    testCount++;
  }

  return selected;
}

function redactAbsolutePaths(content: string, repoPath: string): string {
  // Case-insensitive on Windows (drive letters vary in case)
  const flags = process.platform === "win32" ? "gi" : "g";

  // Replace absolute repo path with <repo>/
  const normalized = repoPath.replace(/\\/g, "/");
  let result = content.replace(new RegExp(escapeRegExp(normalized), flags), "<repo>");
  // Also replace backslash version on Windows
  if (path.sep === "\\") {
    result = result.replace(new RegExp(escapeRegExp(repoPath), flags), "<repo>");
  }
  // Replace home directory
  const home = os.homedir();
  const homeNorm = home.replace(/\\/g, "/");
  result = result.replace(new RegExp(escapeRegExp(homeNorm), flags), "~");
  if (path.sep === "\\") {
    result = result.replace(new RegExp(escapeRegExp(home), flags), "~");
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDirectoryTree(repoPath: string, maxDepth = 3): string {
  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries
      .filter(e => e.isDirectory() && !e.isSymbolicLink() && !EXCLUDED_DIRS.has(e.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < dirs.length; i++) {
      const isLast = i === dirs.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      lines.push(`${prefix}${connector}${dirs[i].name}/`);
      walk(path.join(dir, dirs[i].name), prefix + childPrefix, depth + 1);
    }
  }

  lines.push(path.basename(repoPath) + "/");
  walk(repoPath, "", 0);
  return lines.join("\n");
}

function getLanguageBreakdown(files: ScoredFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = path.extname(f.relativePath).toLowerCase();
    if (ext && SOURCE_EXTENSIONS.has(ext)) {
      counts.set(ext, (counts.get(ext) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(", ");
}

function getGitMetadata(repoPath: string): { remote: string; log: string; head: string } {
  let remote = "(no remote)";
  let log = "(no git history)";
  let head = "(unknown)";

  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    }).toString().trim();
    // Redact credentials from URLs like https://user:token@github.com/...
    remote = remote.replace(/\/\/[^@/]+@/, "//***@");
  } catch { /* no remote */ }

  try {
    log = execFileSync("git", ["log", "--oneline", "-20"], {
      cwd: repoPath, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    }).toString().trim();
  } catch { /* no git */ }

  try {
    head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoPath, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    }).toString().trim();
  } catch { /* no git */ }

  return { remote, log, head };
}

export function formatBundle(repoPath: string, allFiles: ScoredFile[], selected: ScoredFile[]): string {
  const repoName = path.basename(repoPath);
  const git = getGitMetadata(repoPath);
  const langBreakdown = getLanguageBreakdown(allFiles);
  const tree = getDirectoryTree(repoPath);

  const sections: string[] = [];

  // Header
  sections.push(`# Repository: ${repoName}\n`);

  // Metadata
  sections.push(`## Metadata\n`);
  sections.push(`- **Remote**: ${git.remote}`);
  sections.push(`- **HEAD**: ${git.head}`);
  sections.push(`- **Total files scanned**: ${allFiles.length}`);
  sections.push(`- **Files selected**: ${selected.length}`);
  sections.push(`- **Languages**: ${langBreakdown || "(none detected)"}`);
  sections.push("");

  // Directory tree
  sections.push(`## Directory Structure\n`);
  sections.push("```");
  sections.push(tree);
  sections.push("```\n");

  // Git log
  if (git.log !== "(no git history)") {
    sections.push(`## Recent Commits\n`);
    sections.push("```");
    sections.push(git.log);
    sections.push("```\n");
  }

  // Files grouped by role
  const roleOrder: FileRole[] = ["manifest", "docs", "config", "entry", "source", "test"];
  const roleLabels: Record<FileRole, string> = {
    manifest: "Manifests", docs: "Documentation", config: "Configuration",
    entry: "Entry Points", source: "Source Files", test: "Test Files", generated: "Generated",
  };

  for (const role of roleOrder) {
    const group = selected.filter(f => f.role === role);
    if (group.length === 0) continue;

    sections.push(`## ${roleLabels[role]}\n`);

    for (const f of group) {
      const filePath = path.join(repoPath, f.relativePath);
      let content: string;
      try {
        // Re-check symlink at read time (TOCTOU mitigation)
        // Check the file itself AND all ancestors up to repoPath
        if (fs.lstatSync(filePath).isSymbolicLink()) continue;
        let ancestor = path.dirname(filePath);
        let escaped = false;
        while (ancestor.length > repoPath.length) {
          if (fs.lstatSync(ancestor).isSymbolicLink()) { escaped = true; break; }
          ancestor = path.dirname(ancestor);
        }
        if (escaped) continue;
        // Verify realpath stays inside repo
        const realFile = fs.realpathSync(filePath);
        const realRepo = fs.realpathSync(repoPath);
        if (!realFile.startsWith(realRepo + path.sep) && realFile !== realRepo) continue;
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      // Truncate files by role: source/test=200, docs/config=500, manifest=full
      const lines = content.split("\n");
      const maxLines = ["source", "test"].includes(f.role) ? 200
        : ["docs", "config"].includes(f.role) ? 500
        : Infinity;
      const truncated = lines.length > maxLines;
      const displayContent = truncated
        ? lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`
        : content;

      // Redact absolute paths
      const safe = redactAbsolutePaths(displayContent, repoPath);

      const ext = path.extname(f.relativePath).replace(".", "");
      // Use a fence that won't collide with content's own fences
      // Find the longest run of backticks in content and use one longer
      const maxTicks = (safe.match(/`{3,}/g) || []).reduce((max, m) => Math.max(max, m.length), 2);
      const fence = "`".repeat(maxTicks + 1);
      sections.push(`### ${f.relativePath} (${f.role}, ${f.lineCount} lines)\n`);
      sections.push(fence + ext);
      sections.push(safe);
      sections.push(fence + "\n");
    }
  }

  return sections.join("\n");
}

export function scanRepo(repoPath: string): { bundle: string; stats: { totalFiles: number; selectedFiles: number; totalLines: number; languages: string; skipped: number } } {
  const { files: allFiles, skipped } = discoverFiles(repoPath);
  const selected = selectFiles(allFiles);

  const bundle = formatBundle(repoPath, allFiles, selected);
  const totalLines = selected.reduce((sum, f) => sum + f.lineCount, 0);
  const languages = getLanguageBreakdown(allFiles);

  return {
    bundle,
    stats: {
      totalFiles: allFiles.length,
      selectedFiles: selected.length,
      totalLines,
      languages: languages || "(none detected)",
      skipped,
    },
  };
}

export function isRepo(dirPath: string): boolean {
  // Has .git/ directory
  if (fs.existsSync(path.join(dirPath, ".git"))) return true;
  // Has a manifest file
  try {
    const entries = fs.readdirSync(dirPath);
    return entries.some(e => MANIFEST_FILES.has(e.toLowerCase()));
  } catch {
    return false;
  }
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("autopedia")
    .description("Personal knowledge wiki maintained by your AI tool via MCP")
    .version("0.4.0");

  // ── init ────────────────────────────────────────────────────

  program
    .command("init")
    .description("Initialize a new autopedia knowledge base")
    .option("-d, --dir <path>", "Parent directory for .autopedia/ (default: ~/)")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = opts.dir
        ? (path.resolve(opts.dir).endsWith(".autopedia")
          ? path.resolve(opts.dir)
          : path.resolve(opts.dir, ".autopedia"))
        : path.join(os.homedir(), ".autopedia");

      // Guard: prevent creating .autopedia/ inside a code project
      // Walk up from the target dir to root, checking each ancestor
      if (opts.dir) {
        const projectSignals = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml"];
        let checkDir = path.resolve(opts.dir);
        const home = os.homedir();
        while (checkDir !== path.dirname(checkDir) && checkDir !== home) {
          const isProject = projectSignals.some(s => fs.existsSync(path.join(checkDir, s)));
          if (isProject) {
            console.error("Error: this directory is inside a code project. autopedia should not be initialized inside a project directory.");
            console.error("  Run `autopedia init` (no --dir) to use the default location ~/");
            process.exit(1);
          }
          checkDir = path.dirname(checkDir);
        }
      }

      const wiki = new Wiki(kbRoot);
      wiki.init();

      // Copy user-editable schema files (NOT prompt.md — served from package)
      const userSchemaFiles = ["identity.md", "interests.md", "rules.md"];
      const schemaDir = path.join(kbRoot, "schema");
      fs.mkdirSync(schemaDir, { recursive: true });

      for (const filename of userSchemaFiles) {
        const destPath = path.join(schemaDir, filename);
        if (!fs.existsSync(destPath)) {
          fs.writeFileSync(destPath, readSchemaDefault(filename), "utf-8");
        }
      }

      console.log(`✓ Created .autopedia/ at ${kbRoot}`);
      console.log("");
      console.log("Next steps:");
      console.log(
        "  1. Add to your AI tool's global MCP config (~/.claude.json):"
      );
      console.log("");
      console.log('     { "mcpServers": { "autopedia": {');
      console.log('         "command": "node",');
      console.log(`         "args": ["${path.resolve(__dirname, "..", "dist", "cli.js")}", "serve"]`);
      console.log("     }}}");
      console.log("");
      console.log(
        "  2. Start a conversation — autopedia will interview you to set up your profile."
      );
    });

  // ── add ─────────────────────────────────────────────────────

  program
    .command("add <source>")
    .description("Queue a URL, text note, file, folder, or repo for wiki processing")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .option("-r, --repo", "Force repository scanning mode")
    .action(async (source: string, opts: { dir?: string; repo?: boolean }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);
      const date = new Date().toISOString().split("T")[0];
      const ts = Date.now().toString(36);
      const isUrl = source.startsWith("http://") || source.startsWith("https://");
      const resolved = path.resolve(source);
      const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      // Auto-detect repos only by .git/ (strong signal); --repo flag for manifest-only repos
      const useRepoMode = opts.repo || (isDir && fs.existsSync(path.join(resolved, ".git")));

      // --repo flag validation: must be a directory
      if (opts.repo && !isDir) {
        console.error(`Error: --repo requires a directory path. "${source}" is not a directory.`);
        process.exit(1);
      }

      if (isUrl) {
        // URL — validate + queue (no fetch)
        try {
          validateUrl(source);
        } catch (err) {
          console.error(
            `Error: URL blocked — ${err instanceof Error ? err.message : "invalid URL"}`
          );
          process.exit(1);
        }
        wiki.addToQueue(source);
        console.log(`✓ Queued: ${source}`);
      } else if (useRepoMode && isDir) {
        // Repository — scan, bundle, save, queue
        const repoName = path.basename(resolved);
        const { bundle, stats } = scanRepo(resolved);
        // Include 4-char hash of full path for uniqueness (two repos named "app" in different locations)
        const pathHash = createHash("sha256").update(resolved).digest("hex").slice(0, 4);
        const slug = `repo-${repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-+$/, "")}-${pathHash}`;
        wiki.saveAgentSource(slug, bundle);
        wiki.addToQueue(`repo:${slug}`);
        console.log(`✓ Scanned ${repoName}/ (${stats.totalFiles} source files, ${stats.selectedFiles} selected, ${stats.languages})`);
        console.log(`  Bundle: ${stats.selectedFiles} files, ${stats.totalLines} lines`);
        if (stats.skipped > 0) {
          console.log(`  Warning: ${stats.skipped} directories were unreadable (permission denied)`);
        }
      } else if (isDir) {
        // Directory (non-repo) — scan and add all files
        const entries = fs.readdirSync(resolved).filter((f) => {
          const full = path.join(resolved, f);
          return fs.statSync(full).isFile() && !fs.lstatSync(full).isSymbolicLink();
        });
        if (entries.length === 0) {
          console.error("Error: no files found in directory.");
          process.exit(1);
        }
        let count = 0;
        for (const entry of entries) {
          addFileToWiki(wiki, path.join(resolved, entry), date, ts, count);
          count++;
        }
        console.log(`✓ Added ${count} file(s) from ${path.basename(resolved)}/`);
      } else if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        // Single file
        addFileToWiki(wiki, resolved, date, ts, 0);
        console.log(`✓ Added: ${path.basename(source)}`);
      } else {
        // Text note (fallback — backward compatible)
        const slug = `${date}-${ts}-${source
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40)
          .replace(/-+$/, "")}`;
        wiki.safeWriteNote(slug, source);
        wiki.addToQueue(`note:${slug}`);
        console.log(`✓ Saved note: "${source.slice(0, 50)}${source.length > 50 ? "..." : ""}"`);
      }

      console.log(
        "  Tell your AI tool 'sync' to process."
      );
    });

  // ── serve ───────────────────────────────────────────────────

  program
    .command("serve")
    .description("Start the autopedia MCP server (stdio transport)")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      await startServer(kbRoot);
    });

  // ── view ────────────────────────────────────────────────────

  program
    .command("view")
    .description("Browse your wiki in a local dashboard")
    .option("-p, --port <port>", "Port to serve on", "8080")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .action(async (opts: { port: string; dir?: string }) => {
      // Validate port is a safe integer (strict: reject "123abc", "1.5", etc.)
      const port = /^\d+$/.test(opts.port) ? Number(opts.port) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("Error: --port must be an integer between 1 and 65535.");
        process.exit(1);
      }

      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wikiDir = path.join(kbRoot, "wiki");
      if (!fs.existsSync(wikiDir)) {
        console.error("Error: No wiki/ directory found. Add some content first.");
        process.exit(1);
      }

      const server = await startDashboard(kbRoot, port);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;

      console.log(`\nautopedia dashboard: http://localhost:${boundPort}`);
      console.log("Press Ctrl+C to stop.\n");

      // Open browser after a short delay
      const openUrl = `http://localhost:${boundPort}`;
      setTimeout(async () => {
        try {
          const { execFileSync } = await import("node:child_process");
          const platform = process.platform;
          if (platform === "darwin") execFileSync("open", [openUrl], { stdio: "ignore" });
          else if (platform === "win32") execFileSync("cmd", ["/c", "start", "", openUrl], { stdio: "ignore" });
          else {
            try {
              execFileSync("xdg-open", [openUrl], { stdio: "ignore" });
            } catch {
              execFileSync("wslview", [openUrl], { stdio: "ignore" });
            }
          }
        } catch {
          // Browser open is best-effort
        }
      }, 500);
    });

  // ── status ──────────────────────────────────────────────────

  program
    .command("status")
    .description("Show wiki status and stats")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);
      const pages = wiki.listPages();
      const unprocessed = wiki.listUnprocessedSources();
      const untracked = wiki.scanUntracked();

      // Count processed items from queue
      const queuePath = path.join(kbRoot, "ops", "queue.md");
      const queueContent = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf-8") : "";
      const processedCount = queueContent.split("\n").filter(l => l.startsWith("- [x] ")).length;

      console.log("autopedia status");
      console.log("─".repeat(40));
      console.log(`  Wiki pages:          ${pages.length}`);
      console.log(`  Queued:              ${unprocessed.length}`);
      console.log(`  Processed:           ${processedCount}`);
      if (untracked.length > 0) {
        console.log(`  Untracked:           ${untracked.length} (run 'autopedia scan')`);
      }

      if (pages.length > 0) {
        console.log("");
        console.log("Pages:");
        for (const page of pages) {
          console.log(`  - ${page}`);
        }
      }

      if (unprocessed.length > 0) {
        console.log("");
        console.log("Unprocessed sources:");
        for (const item of unprocessed) {
          console.log(`  - ${item}`);
        }
      }
    });

  // ── scan ───────────────────────────────────────────────────

  program
    .command("scan")
    .description("Detect files added outside autopedia (via Obsidian, IDE, etc.) and queue them")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);
      const untracked = wiki.scanUntracked();

      if (untracked.length === 0) {
        console.log("All files tracked. Nothing new to queue.");
        return;
      }

      console.log(`Found ${untracked.length} new file(s):`);
      for (const { file, dir } of untracked) {
        const slug = file.replace(/\.[^.]+$/, ""); // strip extension for queue entry
        const isText = /\.(md|txt|text)$/i.test(file);
        const entry = dir === "user" ? `${isText ? "note" : "file"}:${isText ? slug : file}` : slug;
        wiki.addToQueue(entry);
        const srcDir = dir === "user" ? "user/notes" : "agent";
        console.log(`  + sources/${srcDir}/${file} → queued as ${entry}`);
      }
    });

  // ── remove ─────────────────────────────────────────────────

  program
    .command("remove <name>")
    .description("Remove a wiki page or source")
    .option("-s, --source", "Remove a source instead of a wiki page")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .option("-y, --yes", "Skip confirmation")
    .action(async (name: string, opts: { source?: boolean; dir?: string; yes?: boolean }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);

      if (opts.source) {
        if (!opts.yes) {
          console.log(`Will delete source: ${name}`);
          console.log("Press Ctrl+C to cancel, or pass -y to skip this prompt.");
        }
        const removed = wiki.removeSource(name);
        if (removed) {
          console.log(`Removed source: ${name}`);
        } else {
          console.error(`Source not found: ${name}`);
          process.exitCode = 1;
        }
      } else {
        if (!opts.yes) {
          console.log(`Will delete wiki page: ${name}`);
          console.log("Press Ctrl+C to cancel, or pass -y to skip this prompt.");
        }
        const removed = wiki.removePage(name);
        if (removed) {
          const broken = wiki.reconcileAfterDelete(name.replace(/\.md$/, ""));
          console.log(`Removed: ${name}`);
          if (broken.length > 0) {
            console.log(`${broken.length} page(s) still reference [[${name.replace(/\.md$/, "")}]]: ${broken.join(", ")}`);
            console.log("Your AI tool will fix these on next session.");
          }
        } else {
          console.error(`Page not found: ${name}`);
          process.exitCode = 1;
        }
      }
    });

  // ── search ─────────────────────────────────────────────────

  program
    .command("search <query...>")
    .description("Search wiki pages (no MCP session needed)")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .action(async (queryParts: string[], opts: { dir?: string }) => {
      const trimmed = queryParts.join(" ").trim();
      if (!trimmed) {
        console.error("Error: query cannot be empty.");
        process.exit(1);
      }

      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);
      const results = wiki.searchPages(trimmed);

      if (results.length === 0) {
        console.log(`No results for "${trimmed}"`);
      } else {
        for (const r of results) {
          console.log(`${r.path}:`);
          for (const line of r.matches) {
            console.log(`  ${line}`);
          }
          console.log();
        }
      }
    });

  // ── export ─────────────────────────────────────────────────

  program
    .command("export")
    .description("Export wiki as a single markdown file")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .option("-o, --output <path>", "Output file (default: stdout)")
    .action(async (opts: { dir?: string; output?: string }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);
      const pages = wiki.listPages();

      if (pages.length === 0) {
        console.error("No wiki pages to export.");
        process.exit(1);
      }

      // Index first, then alphabetical
      const sorted = pages.sort((a, b) => {
        if (a === "index.md") return -1;
        if (b === "index.md") return 1;
        return a.localeCompare(b);
      });

      let output = "";
      for (const page of sorted) {
        const content = wiki.readPage(page);
        if (content) {
          output += `<!-- ${page} -->\n\n${content}\n\n`;
        }
      }

      if (opts.output) {
        const resolved = path.resolve(opts.output);
        const wikiDir = path.join(kbRoot, "wiki");
        // Use realpath for symlink-safe comparison
        const realWikiDir = fs.existsSync(wikiDir) ? fs.realpathSync(wikiDir) : wikiDir;
        const outputParent = path.dirname(resolved);
        const realOutputParent = fs.existsSync(outputParent) ? fs.realpathSync(outputParent) : outputParent;
        if (realOutputParent.startsWith(realWikiDir + path.sep) || realOutputParent === realWikiDir) {
          console.error("Error: cannot export into wiki/ directory.");
          process.exit(1);
        }
        fs.writeFileSync(resolved, output.trimStart(), "utf-8");
        console.log(`Exported ${sorted.length} pages to ${opts.output}`);
      } else {
        process.stdout.write(output.trimStart());
      }
    });

  return program;
}

// Run CLI when executed directly (not when imported as a module)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("/cli.ts") ||
    process.argv[1].endsWith("autopedia"));

if (isDirectRun) {
  const program = createCli();
  program.parse();
}
