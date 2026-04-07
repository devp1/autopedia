#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export function createCli(): Command {
  const program = new Command();

  program
    .name("autopedia")
    .description("Personal knowledge wiki maintained by your AI tool via MCP")
    .version("0.3.0");

  // ── init ────────────────────────────────────────────────────

  program
    .command("init")
    .description("Initialize a new autopedia knowledge base")
    .option("-d, --dir <path>", "Parent directory for .autopedia/ (default: ~/)")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = opts.dir
        ? path.resolve(opts.dir, ".autopedia")
        : path.join(os.homedir(), ".autopedia");
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
    .description("Instantly queue a URL or text note (no fetch, no LLM call)")
    .option("-d, --dir <path>", "Path to .autopedia/ directory")
    .action(async (source: string, opts: { dir?: string }) => {
      const kbRoot = resolveKbRoot(opts.dir);
      requireKbRoot(kbRoot);

      const wiki = new Wiki(kbRoot);
      const isUrl = source.startsWith("http://") || source.startsWith("https://");

      if (isUrl) {
        // Validate URL (SSRF protection) — no fetch, just queue
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
      } else {
        // Save as text note (via safe write with symlink validation)
        const date = new Date().toISOString().split("T")[0];
        const ts = Date.now().toString(36);
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
        "  Will be processed next time your AI tool connects to autopedia."
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

      console.log("autopedia status");
      console.log("─".repeat(40));
      console.log(`  Wiki pages:          ${pages.length}`);
      console.log(`  Unprocessed sources: ${unprocessed.length}`);

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
