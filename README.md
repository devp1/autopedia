# autopedia

**Personal knowledge wiki maintained by your AI tool via MCP.**

Your AI tool (Claude Code, Cursor, etc.) maintains a [Karpathy-style wiki](https://x.com/karpathy/status/1908177577476161890) through MCP. No separate LLM client. No API keys. Your existing AI tool IS the brain.

## Get started

### Step 1: Install

```bash
npm install -g autopedia
```

### Step 2: Initialize your knowledge base

```bash
autopedia init
```

This creates `~/.autopedia/` with the following structure:
```
~/.autopedia/
  wiki/           ← your synthesized knowledge (AI-maintained)
  sources/        ← raw inputs (URLs you've saved, text notes)
  ops/            ← audit trail (log, metrics, queue)
  schema/         ← your profile and rules
```

### Step 3: Connect to your AI tool

Add autopedia to your AI tool's MCP configuration. This is a one-time setup.

**Claude Code** — add to `~/.claude.json` under `"mcpServers"`:

```json
{
  "mcpServers": {
    "autopedia": {
      "command": "autopedia",
      "args": ["serve"]
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "autopedia": {
      "command": "autopedia",
      "args": ["serve"]
    }
  }
}
```

### Step 4: Verify it works

Start a new conversation in your AI tool. You should see autopedia listed as a connected MCP server. On your first session, it will ask you a few onboarding questions (your name, what you're interested in). This takes about 30 seconds and personalizes everything.

**How to check:** Run `autopedia status` in your terminal. You should see:
```
autopedia status
────────────────────────────────────────
  Wiki pages:          1
  Unprocessed sources: 0
```

If you see this, you're set up correctly. The wiki starts with just `index.md` and grows as you use it.

### Step 5: Start using it

Once connected, just talk to your AI tool naturally:

```
You: "Add this to my wiki: https://example.com/gpu-pricing-article"
AI:  → fetches the article
     → extracts key insights
     → creates/updates wiki pages with [[wikilinks]]
     → updates the index

You: "What do I know about GPU pricing?"
AI:  → searches your wiki
     → answers from YOUR research, not generic training data

You: "Run a lint check on my wiki"
AI:  → finds orphan pages, stale content, contradictions
     → fixes them automatically
```

**Between sessions**, you can queue things from any terminal:

```bash
autopedia add "https://example.com/interesting-article"
autopedia add "Note: GPU prices dropped 20% this quarter"
```

These are saved immediately and processed the next time your AI tool connects.

## CLI Commands

| Command | What it does |
|---------|-------------|
| `autopedia init` | Create `~/.autopedia/` directory structure |
| `autopedia add <url-or-text>` | Save a source to the queue (processed next session) |
| `autopedia serve` | Start MCP server (used by your AI tool, not run manually) |
| `autopedia status` | Show wiki page count and unprocessed sources |
| `autopedia search <query>` | Search wiki pages from the terminal |
| `autopedia export [--output file.md]` | Export wiki as a single markdown file |
| `autopedia view` | Browse your wiki locally with [Quartz](https://quartz.jzhao.xyz/) (pinned to v4.5.2) |

## How it works

autopedia implements [Karpathy's three wiki operations](https://x.com/karpathy/status/1908177577476161890):

1. **INGEST** — Fetch URLs, save notes, synthesize into wiki pages
2. **QUERY** — Search and read from the wiki, answer grounded in your research
3. **LINT** — Find orphan pages, stale content, contradictions, and fix them

### MCP Tools (9)

| Tool | Operation | Purpose |
|------|-----------|---------|
| `add_source` | INGEST | Fetch a URL or save text, return context for synthesis |
| `apply_wiki_ops` | INGEST | Create/update wiki pages (+ mark queue items processed) |
| `read_source` | QUERY | Read a saved source by slug (fetched or user notes) |
| `search` | QUERY | Search wiki pages by keyword |
| `read_page` | QUERY | Read a specific wiki page |
| `get_status` | STATUS | Page count, log, unprocessed queue |
| `lint` | LINT | Find orphans, stale pages, duplicates |
| `question_assumptions` | LINT | Challenge high-confidence claims |
| `complete_onboarding` | ONBOARDING | Write identity + interests after interview |

### MCP Resources (3)

| Resource | What |
|----------|------|
| `autopedia://prompt` | System prompt that teaches your AI tool how to use the wiki |
| `autopedia://identity` | Your profile (who you are) |
| `autopedia://interests` | Your interests (what you care about) |

## Browsing your wiki

Your wiki lives at `~/.autopedia/wiki/` as plain markdown with `[[wikilinks]]`.

- **Obsidian** — Open `~/.autopedia/wiki/` as a vault. Graph view, backlinks, and search work out of the box.
- **Quartz** — Run `autopedia view` to serve your wiki as a local website with search, graph view, and backlinks.
- **VS Code / any editor** — The files are plain markdown.
- **Terminal** — `autopedia search <query>` to search, `autopedia export` to dump everything.

## Security

- **Sacred boundary**: The server can only write to `wiki/`, `ops/`, and `sources/agent/`. Exception: `complete_onboarding` writes to `schema/identity.md` and `schema/interests.md` (hardcoded paths, symlink-checked, size-validated). User source content is never modified.
- **Path traversal protection**: `path.resolve()` + `startsWith()` + symlink chain validation
- **SSRF protection**: Blocks localhost, private IPs, IPv6, metadata endpoints, redirect-based bypasses
- **No API keys**: The server makes no LLM calls — your AI tool does all the thinking

## Dependencies

6 runtime dependencies. No LLM SDK. No database. No Express.

```
@modelcontextprotocol/sdk  — MCP protocol
zod                        — Input validation
@mozilla/readability       — Article extraction (v0.6.0, ReDoS-fixed)
jsdom                      — DOM for Readability
commander                  — CLI framework
glob                       — File globbing
```

## Development

```bash
git clone https://github.com/devp1/autopedia
cd autopedia
npm install
npm run build
npm test          # 143 tests
npm run typecheck # TypeScript strict mode
npm run lint      # ESLint
```

**To test locally without publishing:**

```bash
# 1. Link the package globally
npm link

# 2. Initialize
autopedia init

# 3. Add to Claude Code (~/.claude.json) under "mcpServers":
#    { "autopedia": { "command": "autopedia", "args": ["serve"] } }

# 4. Start a new Claude Code session — autopedia will connect and interview you

# 5. Verify
autopedia status
```

If you're developing and don't want to `npm link`, use the full path:
```json
{
  "mcpServers": {
    "autopedia": {
      "command": "node",
      "args": ["/path/to/autopedia/dist/cli.js", "serve"]
    }
  }
}
```

## Roadmap

### v0.3 (next)
- Sources visibility via curated wiki summary pages
- View improvements: custom Quartz layout, watch mode
- Better symlink test coverage on non-Linux platforms

### v0.4 (future)
- Claude Code skill alongside MCP (zero-friction entry point)
- `rules.md` as MCP resource
- Better duplicate detection in lint

## License

[MIT](LICENSE)
