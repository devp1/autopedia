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

This creates `~/.autopedia/` — a global knowledge base that follows you across every project and conversation.

### 3. Add to your AI tool

**Claude Code** — add to `~/.claude.json`:

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

### 4. Start a conversation

On your first session, autopedia's system prompt instructs your AI tool to run an onboarding interview — a few questions about who you are and what you care about. This personalizes everything going forward.

### 5. Use it

**Paste a URL or share a thought** — autopedia ingests it, synthesizes it into wiki pages, and connects it to your existing knowledge:

```
You: "Add this to my wiki: https://example.com/gpu-pricing-article"
AI:  → fetches article → creates/updates wiki pages → links to related topics

You: "What do I know about GPU pricing?"
AI:  → searches your wiki → answers from YOUR research, not generic training data

You: "Run a lint check on my wiki"
AI:  → finds orphan pages, stale content, contradictions → fixes them
```

**Between sessions**, queue things from the terminal:

```bash
autopedia add "https://example.com/interesting-article"
autopedia add "Note: GPU prices dropped 20% this quarter"
```

Queued sources are processed the next time your AI tool connects (the system prompt instructs it to check the queue on startup).

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

## CLI Commands

| Command | What it does |
|---------|-------------|
| `autopedia init` | Create `~/.autopedia/` directory structure |
| `autopedia add <url-or-text>` | Save a source to the queue (no LLM call, processed later) |
| `autopedia serve` | Start MCP server (stdio transport) |
| `autopedia status` | Show wiki stats and unprocessed sources |
| `autopedia view` | Browse your wiki locally with [Quartz](https://quartz.jzhao.xyz/) |

## Browsing your wiki

Your wiki lives at `~/.autopedia/wiki/` as plain markdown with `[[wikilinks]]`.

- **Obsidian** — Open `~/.autopedia/wiki/` as a vault. Graph view, backlinks, and search work out of the box.
- **Quartz** — Run `autopedia view` to serve your wiki as a local website with search, graph view, and backlinks.
- **Any editor** — The files are plain markdown. VS Code, Vim, whatever you prefer.

## On-disk structure

```
~/.autopedia/
  wiki/               ← LLM-maintained wiki pages (markdown + wikilinks)
  wiki/index.md       ← TLDRs and routing table
  sources/user/       ← Your raw sources (SACRED — never modified by the server)
  sources/user/notes/ ← Text notes added via CLI
  sources/agent/      ← Fetched URL content
  ops/log.md          ← Audit trail of all operations
  ops/metrics.md      ← Page count and health
  ops/queue.md        ← Unprocessed source queue
  schema/identity.md  ← Who you are (set during onboarding)
  schema/interests.md ← What you care about (set during onboarding)
  schema/rules.md     ← Your wiki rules
```

The system prompt (`schema/prompt.md`) is served from the installed package directory via MCP resource, not stored in `~/.autopedia/`. It auto-updates when you upgrade autopedia.

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
npm test          # 119 tests
npm run typecheck # TypeScript strict mode
npm run lint      # ESLint
```

## License

[MIT](LICENSE)
