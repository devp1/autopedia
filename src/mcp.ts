import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// JSDOM + Readability are lazy-imported in add_source (42s load on WSL2+NTFS)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Wiki, validateUrl } from "./wiki.js";

// ── Zod schemas ─────────────────────────────────────────────────

const WikiOpSchema = z.object({
  op: z.enum(["create", "update"]),
  path: z.string().min(1),
  content: z.string(),
});

const AddSourceInput = z.object({
  url: z.string().url().optional(),
  text: z.string().optional(),
  capture_mode: z.enum(["queue", "ingest"]).default("ingest"),
}).refine((data) => data.url || data.text, {
  message: "Either url or text must be provided",
});

const ApplyWikiOpsInput = z.object({
  operations: z.array(WikiOpSchema),
  queue_item: z.string().optional(),
});

const SearchInput = z.object({
  query: z.string().min(1),
});

const ReadPageInput = z.object({
  path: z.string().min(1),
});

// ── Server factory ──────────────────────────────────────────────

// Package schema directory (prompt.md served from here, auto-updates on upgrade)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_SCHEMA_DIR = path.resolve(__dirname, "..", "schema");

export function createServer(kbRoot: string): McpServer {
  const wiki = new Wiki(kbRoot);

  const server = new McpServer({
    name: "autopedia",
    version: "0.3.0",
  });

  // ── INGEST: add_source ──────────────────────────────────────

  server.tool(
    "add_source",
    "Fetch a URL or save text as a source. Set capture_mode: 'queue' for instant save (no fetch), 'ingest' (default) for full fetch + synthesis context.",
    {
      url: z.string().url().optional(),
      text: z.string().optional(),
      capture_mode: z.enum(["queue", "ingest"]).default("ingest"),
    },
    async (args) => {
      const input = AddSourceInput.parse(args);
      const date = new Date().toISOString().split("T")[0];

      // ── Queue mode: instant capture, no fetch ──────────────────
      if (input.capture_mode === "queue") {
        if (input.url) {
          validateUrl(input.url);
          wiki.addToQueue(input.url);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  queued: input.url,
                  message: "Saved to queue. Will be processed next session or when you say 'process queue'.",
                }),
              },
            ],
          };
        } else {
          const slug = `${date}-${textToSlug(input.text!)}`;
          wiki.safeWriteNote(slug, input.text!);
          wiki.addToQueue(`note:${slug}`);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  queued: `note:${slug}`,
                  note_saved: true,
                  message: "Note saved and queued for wiki processing.",
                }),
              },
            ],
          };
        }
      }

      // ── Ingest mode: full fetch + synthesis context ────────────
      let sourceContent: string;
      let slug: string;

      if (input.url) {
        // SSRF protection: only allow http/https and reject private IPs
        validateUrl(input.url);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(input.url, {
          redirect: "error",
          signal: controller.signal,
        });
        clearTimeout(timeout);

        // Limit response size to 5MB
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
          throw new Error("Response too large (>5MB)");
        }

        const html = await response.text();
        if (html.length > 5 * 1024 * 1024) {
          throw new Error("Response too large (>5MB)");
        }

        const { JSDOM } = await import("jsdom");
        const { Readability } = await import("@mozilla/readability");
        const dom = new JSDOM(html, { url: input.url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        sourceContent = article
          ? `# ${article.title}\n\n${article.textContent}`
          : html;
        slug = `${date}-${urlToSlug(input.url)}`;

        wiki.saveAgentSource(slug, sourceContent);
      } else {
        sourceContent = input.text!;
        slug = `${date}-${textToSlug(input.text!)}`;

        // Save user text notes via Wiki.safeWriteNote (path + symlink validated)
        wiki.safeWriteNote(slug, sourceContent);
      }

      // Find relevant wiki pages by keyword matching
      const keywords = extractKeywords(sourceContent);
      const relevantPages: Record<string, string> = {};
      for (const keyword of keywords) {
        const results = wiki.searchPages(keyword);
        for (const result of results) {
          if (!relevantPages[result.path]) {
            const content = wiki.readPage(result.path);
            if (content) relevantPages[result.path] = content;
          }
        }
      }

      const index = wiki.readIndex();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                source_content: sourceContent.slice(0, 10000),
                source_slug: slug,
                relevant_pages: relevantPages,
                index,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── INGEST: apply_wiki_ops ──────────────────────────────────

  server.tool(
    "apply_wiki_ops",
    "Apply create/update operations to wiki pages. For updates, returns current page state first (read-before-write). Pass queue_item to mark a source queue entry as processed (operations can be empty if only marking processed).",
    {
      operations: z
        .array(
          z.object({
            op: z.enum(["create", "update"]),
            path: z.string().min(1),
            content: z.string(),
          })
        ),
      queue_item: z.string().optional(),
    },
    async (args) => {
      const input = ApplyWikiOpsInput.parse(args);
      if (input.operations.length === 0 && !input.queue_item) {
        throw new Error("Either operations or queue_item must be provided");
      }
      const currentState: Record<string, string | null> = {};
      let applied = 0;

      for (const op of input.operations) {
        // Read-before-write for updates
        if (op.op === "update") {
          currentState[op.path] = wiki.readPage(op.path);
        }

        wiki.writePage(op.path, op.content);
        wiki.appendLog(
          `${op.op}: ${op.path}`
        );
        applied++;
      }

      wiki.updateMetrics();

      // Mark queue item as processed if provided
      if (input.queue_item) {
        wiki.markProcessed(input.queue_item);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              applied,
              current_state: currentState,
              queue_item_processed: input.queue_item ?? null,
            }),
          },
        ],
      };
    }
  );

  // ── QUERY: search ───────────────────────────────────────────

  server.tool(
    "search",
    "Search wiki pages by keyword query. Returns matching page paths and excerpts.",
    { query: z.string().min(1) },
    async (args) => {
      const input = SearchInput.parse(args);
      const results = wiki.searchPages(input.query);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  // ── QUERY: read_page ────────────────────────────────────────

  server.tool(
    "read_page",
    "Read a wiki page by path. Returns the full page content.",
    { path: z.string().min(1) },
    async (args) => {
      const input = ReadPageInput.parse(args);
      const content = wiki.readPage(input.path);

      if (content === null) {
        return {
          content: [
            { type: "text" as const, text: `Page not found: ${input.path}` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: content }],
      };
    }
  );

  // ── QUERY: read_source ──────────────────────────────────────

  server.tool(
    "read_source",
    "Read a saved source by slug (from CLI queue or prior ingest). Checks sources/agent/ and sources/user/notes/.",
    { slug: z.string().min(1) },
    async (args) => {
      // Reject path traversal
      if (args.slug.includes("..") || args.slug.includes("/") || args.slug.includes("\\") || args.slug.includes("\0")) {
        throw new Error("Invalid slug: path traversal not allowed");
      }

      const filename = args.slug.endsWith(".md") ? args.slug : `${args.slug}.md`;

      // Try sources/agent/ first, then sources/user/notes/
      const candidates = [
        path.join(kbRoot, "sources", "agent", filename),
        path.join(kbRoot, "sources", "user", "notes", filename),
      ];

      for (const filePath of candidates) {
        if (fs.existsSync(filePath)) {
          // Symlink protection
          if (fs.lstatSync(filePath).isSymbolicLink()) {
            throw new Error(`Read rejected: ${filename} is a symlink`);
          }
          const content = fs.readFileSync(filePath, "utf-8");
          return {
            content: [{ type: "text" as const, text: content }],
          };
        }
      }

      return {
        content: [
          { type: "text" as const, text: `Source not found: ${args.slug}` },
        ],
        isError: true,
      };
    }
  );

  // ── STATUS: get_status ──────────────────────────────────────

  server.tool(
    "get_status",
    "Get wiki status: page count, recent log entries, metrics, unprocessed source count.",
    {},
    async () => {
      const pages = wiki.listPages();
      const logPath = path.join(kbRoot, "ops", "log.md");
      const logContent = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, "utf-8")
        : "";
      const logLines = logContent.split("\n").filter((l) => l.startsWith("- "));
      const recentLog = logLines.slice(-10);
      const unprocessed = wiki.listUnprocessedSources();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                page_count: pages.length,
                pages,
                recent_log: recentLog,
                unprocessed_sources: unprocessed.length,
                unprocessed_items: unprocessed,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── LINT: lint ──────────────────────────────────────────────

  server.tool(
    "lint",
    "Scan wiki for issues: stale pages (>30 days no update), orphan pages (no inlinks), missing cross-references.",
    {},
    async () => {
      const pages = wiki.listPages();
      const findings: string[] = [];

      // Build inlink map
      const inlinks = new Map<string, string[]>();
      const pageContents = new Map<string, string>();

      for (const page of pages) {
        const content = wiki.readPage(page);
        if (!content) continue;
        pageContents.set(page, content);

        // Find wikilinks [[page-name]]
        const linkPattern = /\[\[([^\]]+)\]\]/g;
        let match;
        while ((match = linkPattern.exec(content)) !== null) {
          const target = match[1];
          // Try to resolve the link to a page path
          const targetPath = target.endsWith(".md") ? target : `${target}.md`;
          if (!inlinks.has(targetPath)) {
            inlinks.set(targetPath, []);
          }
          inlinks.get(targetPath)!.push(page);
        }
      }

      // Check for orphan pages (no inlinks, excluding index.md)
      for (const page of pages) {
        if (page === "index.md") continue;
        if (!inlinks.has(page) || inlinks.get(page)!.length === 0) {
          findings.push(`orphan: ${page} has no inlinks`);
        }
      }

      // Check for stale pages (>30 days since last log mention)
      const logPath = path.join(kbRoot, "ops", "log.md");
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        for (const page of pages) {
          // Find the most recent log entry mentioning this page
          const logLines = logContent.split("\n").filter((l) => l.includes(page));
          if (logLines.length === 0) {
            findings.push(`stale: ${page} has never been logged`);
            continue;
          }

          const lastLine = logLines[logLines.length - 1];
          const dateMatch = lastLine.match(
            /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/
          );
          if (dateMatch) {
            const lastDate = new Date(dateMatch[1]);
            if (lastDate < thirtyDaysAgo) {
              findings.push(
                `stale: ${page} last updated ${dateMatch[1]} (>30 days ago)`
              );
            }
          }
        }
      }

      // Check for potential contradictions (pages with same topic keywords)
      // Simple heuristic: look for pages with very similar titles
      const pageNames = pages.map((p) =>
        p.replace(".md", "").replace(/\//g, "-")
      );
      for (let i = 0; i < pageNames.length; i++) {
        for (let j = i + 1; j < pageNames.length; j++) {
          if (
            pageNames[i].includes(pageNames[j]) ||
            pageNames[j].includes(pageNames[i])
          ) {
            findings.push(
              `possible-duplicate: ${pages[i]} and ${pages[j]} may cover the same topic`
            );
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ findings, total: findings.length }, null, 2),
          },
        ],
      };
    }
  );

  // ── LINT: question_assumptions ──────────────────────────────

  server.tool(
    "question_assumptions",
    "Find high-confidence claims in the wiki. Returns them for the host LLM to challenge. (Claudeopedia pattern)",
    {},
    async () => {
      const pages = wiki.listPages();
      const claims: Array<{ page: string; claim: string }> = [];

      const confidenceMarkers = [
        "always",
        "never",
        "definitely",
        "certainly",
        "obviously",
        "clearly",
        "everyone knows",
        "it is well known",
        "undoubtedly",
        "without question",
        "the best",
        "the only",
        "the worst",
      ];

      for (const page of pages) {
        const content = wiki.readPage(page);
        if (!content) continue;

        const lines = content.split("\n");
        for (const line of lines) {
          const lower = line.toLowerCase();
          for (const marker of confidenceMarkers) {
            if (lower.includes(marker)) {
              claims.push({ page, claim: line.trim() });
              break;
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                claims: claims.slice(0, 20),
                message:
                  claims.length > 0
                    ? "These claims use high-confidence language. Are they actually true? Consider challenging each one."
                    : "No high-confidence claims found in the wiki.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── ONBOARDING: complete_onboarding ─────────────────────────

  server.tool(
    "complete_onboarding",
    "Write the user's identity and interests to schema files after a conversational interview. Only call this after gathering enough information through conversation.",
    {
      identity: z.string().min(1, "Identity content is required"),
      interests: z.string().min(1, "Interests content is required"),
    },
    async (args) => {
      const MAX_SIZE = 10 * 1024; // 10KB
      if (args.identity.length > MAX_SIZE) {
        throw new Error(`Identity content too large (${args.identity.length} chars, max ${MAX_SIZE})`);
      }
      if (args.interests.length > MAX_SIZE) {
        throw new Error(`Interests content too large (${args.interests.length} chars, max ${MAX_SIZE})`);
      }

      const schemaDir = path.join(kbRoot, "schema");

      // Symlink protection: reject if schema/ directory itself is a symlink
      if (fs.existsSync(schemaDir) && fs.lstatSync(schemaDir).isSymbolicLink()) {
        throw new Error("Write rejected: schema/ directory is a symlink");
      }

      fs.mkdirSync(schemaDir, { recursive: true });

      const identityPath = path.join(schemaDir, "identity.md");
      const interestsPath = path.join(schemaDir, "interests.md");

      // Symlink protection: reject if target files are symlinks
      for (const filePath of [identityPath, interestsPath]) {
        if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
          throw new Error(`Write rejected: ${path.basename(filePath)} is a symlink`);
        }
      }

      fs.writeFileSync(identityPath, args.identity, "utf-8");
      fs.writeFileSync(interestsPath, args.interests, "utf-8");

      wiki.appendLog("onboarding: identity and interests updated");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "ok",
              identity_size: args.identity.length,
              interests_size: args.interests.length,
            }),
          },
        ],
      };
    }
  );

  // ── Resource: autopedia://prompt ────────────────────────────

  server.resource(
    "autopedia-prompt",
    "autopedia://prompt",
    {
      description:
        "The autopedia system prompt. Teaches the host LLM how to maintain the wiki.",
    },
    async () => {
      // Serve prompt from package dir (auto-updates on package upgrade)
      const promptPath = path.join(PACKAGE_SCHEMA_DIR, "prompt.md");
      const content = fs.existsSync(promptPath)
        ? fs.readFileSync(promptPath, "utf-8")
        : "# autopedia prompt\n\nNo prompt configured. Run `autopedia init` first.";

      return {
        contents: [
          {
            uri: "autopedia://prompt",
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    }
  );

  // ── Resource: autopedia://identity ───────────────────────────

  server.resource(
    "autopedia-identity",
    "autopedia://identity",
    {
      description:
        "The user's identity profile. Who they are, what they do, their background.",
    },
    async () => {
      const filePath = path.join(kbRoot, "schema", "identity.md");
      const content =
        fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink()
          ? fs.readFileSync(filePath, "utf-8")
          : "# Identity\n\nNo identity configured. Run onboarding first.";

      return {
        contents: [
          {
            uri: "autopedia://identity",
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    }
  );

  // ── Resource: autopedia://interests ─────────────────────────

  server.resource(
    "autopedia-interests",
    "autopedia://interests",
    {
      description:
        "The user's interests. Topics they follow, questions they explore, sources they trust.",
    },
    async () => {
      const filePath = path.join(kbRoot, "schema", "interests.md");
      const content =
        fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink()
          ? fs.readFileSync(filePath, "utf-8")
          : "# Interests\n\nNo interests configured. Run onboarding first.";

      return {
        contents: [
          {
            uri: "autopedia://interests",
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    }
  );

  return server;
}

// ── Helpers ───────────────────────────────────────────────────

// validateUrl is now imported from wiki.ts

function urlToSlug(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/\./g, "-").slice(0, 30);
  } catch {
    return "unknown";
  }
}

function textToSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: top frequent meaningful words
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "because", "but", "and", "or", "if", "this", "that", "these",
    "those", "it", "its", "they", "them", "their", "we", "our", "you",
    "your", "he", "him", "his", "she", "her", "i", "me", "my", "what",
    "which", "who", "whom",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

// ── Main entry point for `autopedia serve` ──────────────────

export async function startServer(kbRoot: string): Promise<void> {
  const server = createServer(kbRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
