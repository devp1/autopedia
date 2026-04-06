#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { Wiki, validateUrl } from "./wiki.js";
import { startServer } from "./mcp.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const DEFAULT_PROMPT = `# autopedia System Prompt

You are maintaining a personal knowledge wiki via the autopedia MCP server.

## Three Operations (Karpathy's framework)

### INGEST
When the user shares a URL or text:
1. Call \`add_source\` to fetch/save and get relevant context
2. Analyze the source content against existing wiki pages
3. Call \`apply_wiki_ops\` to create or update wiki pages

### QUERY
When the user asks a question:
1. Call \`search\` to find relevant wiki pages
2. Call \`read_page\` for full content
3. Answer grounded in the user's own research

### LINT
Periodically (or when asked):
1. Call \`lint\` to find issues (orphans, stale pages, contradictions)
2. Call \`question_assumptions\` to challenge high-confidence claims
3. Fix issues via \`apply_wiki_ops\`

## Wiki Page Format

Every page must have:
- A clear \`# Title\`
- A \`## TLDR\` section (1-2 sentences)
- A \`## Counter-arguments\` section (specific, not generic)
- Wikilinks to related pages: \`[[page-name]]\`
- When updating index.md: one line per page with TLDR

## Rules
- Never delete user content — only add, update, or reorganize
- Always include counter-arguments for claims
- Keep pages focused on one topic
- Cross-reference related pages with wikilinks
- Update index.md when adding new pages
`;

const DEFAULT_IDENTITY = `# Identity

<!-- Edit this file to describe yourself -->
<!-- This helps autopedia understand your perspective -->

## Who am I?
- Name:
- Role:
- Background:

## What matters to me?
- Key interests:
- Professional focus:
- Learning goals:
`;

const DEFAULT_INTERESTS = `# Interests

<!-- Edit this file to list your areas of interest -->
<!-- autopedia will prioritize these when processing sources -->

## Topics I follow
-

## Questions I'm exploring
-

## Sources I trust
-
`;

const DEFAULT_RULES = `# Rules

<!-- Edit this file to set rules for your wiki -->
<!-- These override default behavior -->

## Content rules
- Always include counter-arguments
- Prefer primary sources over commentary

## Style rules
- Use clear, concise language
- Link related topics with wikilinks

## Boundaries
- Don't add content about:
`;

function findKbRoot(): string {
  return path.resolve(process.cwd(), ".autopedia");
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
    .option("-d, --dir <path>", "Directory for .autopedia/", ".")
    .action(async (opts: { dir: string }) => {
      const kbRoot = path.resolve(opts.dir, ".autopedia");
      const wiki = new Wiki(kbRoot);
      wiki.init();

      // Write schema files
      const schemaFiles: Record<string, string> = {
        "schema/prompt.md": DEFAULT_PROMPT,
        "schema/identity.md": DEFAULT_IDENTITY,
        "schema/interests.md": DEFAULT_INTERESTS,
        "schema/rules.md": DEFAULT_RULES,
      };

      for (const [filePath, content] of Object.entries(schemaFiles)) {
        const fullPath = path.join(kbRoot, filePath);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, "utf-8");
        }
      }

      console.log(`✓ Created .autopedia/ in ${path.resolve(opts.dir)}`);
      console.log("");
      console.log("Next steps:");
      console.log(
        "  1. Edit .autopedia/schema/identity.md — tell autopedia who you are"
      );
      console.log(
        "  2. Edit .autopedia/schema/interests.md — what you care about"
      );
      console.log(
        "  3. Run: autopedia serve — start the MCP server"
      );
      console.log(
        '  4. Add to your AI tool\'s MCP config: { "command": "autopedia", "args": ["serve"] }'
      );
    });

  // ── add ─────────────────────────────────────────────────────

  program
    .command("add <source>")
    .description("Add a URL or text to the source queue (no LLM call)")
    .action(async (source: string) => {
      const kbRoot = findKbRoot();
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
        // Fetch and save the content
        try {
          validateUrl(source);
          const response = await fetch(source);
          const html = await response.text();
          const dom = new JSDOM(html, { url: source });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();

          const content = article
            ? `# ${article.title}\n\nSource: ${source}\n\n${article.textContent}`
            : `# Fetched from ${source}\n\n${html.slice(0, 5000)}`;

          const slug = `${date}-${source
            .replace(/https?:\/\//, "")
            .replace(/[^a-z0-9]+/gi, "-")
            .slice(0, 40)}`;
          wiki.saveAgentSource(slug, content);
          wiki.addToQueue(source);

          console.log(`✓ Saved source: ${source}`);
        } catch (err) {
          // Save URL reference even if fetch fails
          wiki.addToQueue(source);
          console.log(`✓ Queued URL (fetch failed, will retry): ${source}`);
          if (err instanceof Error) {
            console.log(`  Note: ${err.message}`);
          }
        }
      } else {
        // Save as text note (via safe write with symlink validation)
        const slug = `${date}-${source
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
    .action(async () => {
      const kbRoot = findKbRoot();
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
