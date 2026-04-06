#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Wiki, validateUrl } from "./wiki.js";
import { startServer } from "./mcp.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

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

export function createCli(): Command {
  const program = new Command();

  program
    .name("autopedia")
    .description("Personal knowledge wiki maintained by your AI tool via MCP")
    .version("0.1.0");

  // ── init ────────────────────────────────────────────────────

  program
    .command("init")
    .description("Initialize a new autopedia knowledge base")
    .option("-d, --dir <path>", "Directory for .autopedia/ (default: ~/)")
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
    .description("Add a URL or text to the source queue (no LLM call)")
    .option("-d, --dir <path>", "Path to .autopedia/")
    .action(async (source: string, opts: { dir?: string }) => {
      const kbRoot = opts.dir ? path.resolve(opts.dir) : findKbRoot();
      if (!fs.existsSync(kbRoot)) {
        console.error(
          "Error: .autopedia/ not found. Run `autopedia init` first."
        );
        process.exit(1);
      }

      const wiki = new Wiki(kbRoot);
      const date = new Date().toISOString().split("T")[0];
      const isUrl = source.startsWith("http://") || source.startsWith("https://");

      if (isUrl) {
        // Validate URL before any network call (SSRF protection)
        try {
          validateUrl(source);
        } catch (err) {
          console.error(
            `Error: URL blocked — ${err instanceof Error ? err.message : "invalid URL"}`
          );
          process.exit(1);
        }

        // Fetch and save the content
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          const response = await fetch(source, {
            redirect: "error",
            signal: controller.signal,
          });
          clearTimeout(timeout);

          const html = await response.text();
          if (html.length > 5 * 1024 * 1024) {
            throw new Error("Response too large (>5MB)");
          }

          const dom = new JSDOM(html, { url: source });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();

          const content = article
            ? `# ${article.title}\n\nSource: ${source}\n\n${article.textContent}`
            : `# Fetched from ${source}\n\n${html.slice(0, 5000)}`;

          const ts = Date.now().toString(36);
          const slug = `${date}-${ts}-${source
            .replace(/https?:\/\//, "")
            .replace(/[^a-z0-9]+/gi, "-")
            .slice(0, 40)}`;
          wiki.saveAgentSource(slug, content);
          wiki.addToQueue(source);

          console.log(`✓ Saved source: ${source}`);
        } catch (err) {
          // Only queue for retry if URL was valid but fetch failed
          wiki.addToQueue(source);
          console.log(`✓ Queued URL (fetch failed, will retry): ${source}`);
          if (err instanceof Error) {
            console.log(`  Note: ${err.message}`);
          }
        }
      } else {
        // Save as text note (via safe write with symlink validation)
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
        "  Will be processed next time you use your AI tool with autopedia."
      );
    });

  // ── serve ───────────────────────────────────────────────────

  program
    .command("serve")
    .description("Start the autopedia MCP server (stdio transport)")
    .option("-d, --dir <path>", "Path to .autopedia/")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = opts.dir ? path.resolve(opts.dir) : findKbRoot();
      if (!fs.existsSync(kbRoot)) {
        console.error(
          "Error: .autopedia/ not found. Run `autopedia init` first."
        );
        process.exit(1);
      }

      await startServer(kbRoot);
    });

  // ── status ──────────────────────────────────────────────────

  program
    .command("status")
    .description("Show wiki status and stats")
    .option("-d, --dir <path>", "Path to .autopedia/")
    .action(async (opts: { dir?: string }) => {
      const kbRoot = opts.dir ? path.resolve(opts.dir) : findKbRoot();
      if (!fs.existsSync(kbRoot)) {
        console.error(
          "Error: .autopedia/ not found. Run `autopedia init` first."
        );
        process.exit(1);
      }

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
