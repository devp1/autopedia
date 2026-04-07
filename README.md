# autopedia

**Personal knowledge wiki maintained by your AI tool via MCP.**

Your AI tool (Claude Code, Cursor, etc.) maintains a [Karpathy-style wiki](https://x.com/karpathy/status/1908177577476161890) through MCP. No separate LLM client. No API keys. Your existing AI tool IS the brain.

## Get started

### 1. Install

```bash
npm install -g autopedia
```

### 2. Initialize

```bash
autopedia init
```

Creates `~/.autopedia/` with:
```
wiki/           ← synthesized knowledge (AI-maintained)
sources/        ← raw inputs (URLs, text notes, files)
ops/            ← audit trail (log, metrics, queue)
schema/         ← your profile and rules
```

### 3. Connect to your AI tool

Add to your AI tool's MCP config (one-time setup):

**Claude Code** (`~/.claude.json`):
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

**Cursor** (`.cursor/mcp.json`):
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

### 4. Start using it

Start a new conversation. On first session, autopedia interviews you (~30 seconds) to personalize your wiki.

```
You: "Add this: https://example.com/gpu-pricing-article"
AI:  → fetches, extracts, creates wiki pages with [[wikilinks]]

You: "What do I know about GPU pricing?"
AI:  → answers from YOUR research, not training data

You: "Lint my wiki"
AI:  → finds orphans, stale content, contradictions → fixes them
```

## CLI Commands

| Command | What it does |
|---------|-------------|
| `autopedia init` | Create `~/.autopedia/` directory structure |
| `autopedia add <source>` | Queue a URL, text note, file, or folder |
| `autopedia scan` | Detect files added outside autopedia (Obsidian, IDE) and queue them |
| `autopedia status` | Show wiki stats and unprocessed sources |
| `autopedia search <query>` | Search wiki pages from the terminal |
| `autopedia view` | Browse your wiki in a local dashboard |
| `autopedia export` | Export wiki as a single markdown file |
| `autopedia serve` | Start MCP server (used by AI tools, not run manually) |

### Braindump from anywhere

```bash
autopedia add "GPU prices dropped 20% this quarter"     # text note
autopedia add https://example.com/article                # URL
autopedia add ~/research/gpu-report.pdf                  # file
autopedia add ~/research/                                # whole folder
```

Everything is queued and processed the next time your AI tool connects.

## Dashboard

Run `autopedia view` to open a local dashboard.

- **Wiki index** with rendered markdown and clickable [[wikilinks]]
- **Knowledge graph** — force-directed visualization of page connections
- **Backlinks** — each page shows what links to it
- **Source browser** with content-derived titles
- **Status** — page count, queue, untracked files
- **Light/dark theme** with Newsreader + DM Sans typography

## Obsidian integration

Open `~/.autopedia/` as an Obsidian vault. Wikilinks, graph view, and backlinks work out of the box.

**Drag-and-drop workflow**: Drop files into the vault via Obsidian, then run `autopedia scan` to queue them for AI processing. Or let the AI detect them automatically via `get_status`.

## How it works

Implements [Karpathy's three wiki operations](https://x.com/karpathy/status/1908177577476161890):

1. **INGEST** — Fetch URLs, save notes, synthesize into wiki pages
2. **QUERY** — Search and read, answer grounded in your research
3. **LINT** — Find orphans, stale content, contradictions, fix them

### MCP Tools (9)

| Tool | Operation | Purpose |
|------|-----------|---------|
| `add_source` | INGEST | Fetch URL or save text (queue or ingest mode) |
| `apply_wiki_ops` | INGEST | Create/update wiki pages |
| `read_source` | QUERY | Read a saved source |
| `search` | QUERY | Search wiki pages |
| `read_page` | QUERY | Read a specific page |
| `get_status` | STATUS | Page count, queue, untracked files |
| `lint` | LINT | Orphans, stale pages, broken links, low crossrefs |
| `question_assumptions` | LINT | Challenge high-confidence claims |
| `complete_onboarding` | ONBOARDING | Write identity + interests |

### MCP Resources (3)

| Resource | What |
|----------|------|
| `autopedia://prompt` | System prompt (auto-updates on upgrade) |
| `autopedia://identity` | Your profile |
| `autopedia://interests` | What you care about |

## Security

- **Sacred boundary**: Server writes only to `wiki/`, `ops/`, `sources/agent/`. User content is never modified.
- **Path traversal**: `path.resolve()` + `startsWith()` + symlink chain validation
- **SSRF protection**: Blocks localhost, private IPs, IPv6, metadata endpoints, redirect bypasses
- **XSS prevention**: All rendered content HTML-escaped, link text escaped, graph JSON escaped
- **No API keys**: Server makes zero LLM calls — your AI tool does all the thinking

## Architecture

```
src/wiki.ts      — File I/O, boundary enforcement, wikilink graph, scan
src/mcp.ts       — 9 MCP tools + 3 resources
src/cli.ts       — CLI: init, add, scan, serve, status, view, search, export
src/dashboard.ts — Server-rendered HTML dashboard (graph, backlinks, source titles)
schema/prompt.md — System prompt (served via MCP, auto-updates on upgrade)
```

7 runtime dependencies. No LLM SDK. No database. No Express.

## Development

```bash
git clone https://github.com/devp1/autopedia
cd autopedia
npm install
npm run build
npm test          # 215 tests
npm run typecheck
npm run lint
```

## License

[MIT](LICENSE)
