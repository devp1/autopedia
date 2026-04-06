# autopedia

**Personal knowledge wiki maintained by your AI tool via MCP.**

Your AI tool (Claude Code, Cursor, etc.) maintains a Karpathy-style wiki through MCP. No separate LLM client. No API keys. Your existing AI tool IS the brain.

## Get started in 2 minutes

### 1. Install

```bash
npm install -g autopedia
```

### 2. Initialize

```bash
cd your-project   # or any directory
autopedia init
```

This creates `.autopedia/` with your wiki structure. Edit these to personalize:
- `.autopedia/schema/identity.md` — who you are
- `.autopedia/schema/interests.md` — what you care about

### 3. Add to your AI tool

**Claude Code** — add to `~/.claude.json` or project MCP config:

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

### 4. Use it

```
You: "Add this to my wiki: https://example.com/gpu-pricing-article"
AI:  → fetches article → creates/updates wiki page → done

You: "What do I know about GPU pricing?"
AI:  → searches your wiki → answers from YOUR research

You: "Run a lint check on my wiki"
AI:  → finds orphan pages, stale content, contradictions → fixes them
```

## CLI Commands

| Command | What it does |
|---------|-------------|
| `autopedia init` | Create `.autopedia/` directory structure |
| `autopedia add <url-or-text>` | Save a source (no LLM call, processed later) |
| `autopedia serve` | Start MCP server (stdio transport) |
| `autopedia status` | Show wiki stats and unprocessed sources |

## How it works

autopedia implements [Karpathy's three wiki operations](https://x.com/karpathy/status/1908177577476161890):

1. **INGEST** — Process new information into wiki pages
2. **QUERY** — Search and read from the wiki
3. **LINT** — Find and fix quality issues

The MCP server provides 7 tools to your AI tool:

| Tool | Operation | Purpose |
|------|-----------|---------|
| `add_source` | INGEST | Fetch a URL or save text |
| `apply_wiki_ops` | INGEST | Create/update wiki pages |
| `search` | QUERY | Search wiki by keyword |
| `read_page` | QUERY | Read a specific page |
| `get_status` | STATUS | Wiki stats and health |
| `lint` | LINT | Find orphans, stale pages, duplicates |
| `question_assumptions` | LINT | Challenge high-confidence claims |

## On-disk structure

```
.autopedia/
  sources/user/       ← Your raw sources (SACRED — never modified by the server)
  sources/agent/      ← Fetched content
  wiki/               ← LLM-maintained wiki pages
  wiki/index.md       ← TLDRs and routing table
  ops/log.md          ← Audit trail of all operations
  ops/metrics.md      ← Page count and health
  ops/queue.md        ← Unprocessed source queue
  schema/prompt.md    ← System prompt (teaches your AI tool)
  schema/identity.md  ← Who you are
  schema/interests.md ← What you care about
  schema/rules.md     ← Your wiki rules
```

Compatible with [Obsidian](https://obsidian.md/) — open `.autopedia/wiki/` as a vault.

## Security

- **Sacred boundary**: The server can only write to `wiki/`, `ops/`, and `sources/agent/`. All other paths are rejected.
- **Path traversal protection**: `path.resolve()` + `startsWith()` + symlink detection
- **SSRF protection**: URL fetching only allows `http://` and `https://`, blocks localhost and private IPs
- **No API keys**: The server makes no LLM calls — your AI tool does all the thinking

## Dependencies

7 runtime dependencies. No LLM SDK. No database. No Express.

```
@modelcontextprotocol/sdk  — MCP protocol
zod                        — Input validation
gray-matter                — Markdown frontmatter
@mozilla/readability       — Article extraction
jsdom                      — DOM for Readability
commander                  — CLI framework
glob                       — File globbing
```

## Development

```bash
git clone https://github.com/devp1/autopedia
cd autopedia
npm install
npm test          # 105 tests
npm run typecheck # TypeScript strict mode
npm run lint      # ESLint
```

## License

MIT
