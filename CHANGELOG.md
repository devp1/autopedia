# Changelog

## v0.4.0

### Knowledge Graph
- `/graph` route: interactive force-directed SVG visualization of wiki page connections
- Per-page backlinks: "Linked from" section on every wiki page
- Shared wikilink extraction in `wiki.ts` (extractLinks, buildGraph, getBacklinks)

### Filesystem Scan
- `autopedia scan` CLI command: detects files added via Obsidian, IDE, or drag-and-drop
- `get_status` MCP tool reports untracked file count automatically
- System prompt instructs AI to offer processing when untracked files detected

### Dashboard Polish
- Pinned index as "Home" at top of sidebar
- Source titles extracted from content headings (not raw slugs)
- YAML frontmatter stripped before rendering
- Mobile layout fix (no blank content)
- Breadcrumb navigation on wiki and source pages
- Getting-started card for empty wikis
- Dark mode stat card visibility improved
- XSS hardening: link text escaped, graph JSON escaped with \u003c/\u003e

### Tests
- 215 tests (up from 186)

## v0.3.0

### Quick Capture
- `add_source` now accepts `capture_mode: "queue"` (instant, no fetch) or `"ingest"` (default, full processing)
- CLI `autopedia add` is instant for all inputs — validates and queues, no fetch or JSDOM

### Local Dashboard
- `autopedia view` now serves a built-in dashboard (Notion light / Linear dark design)
- Routes: wiki pages, sources, queue status — all server-rendered HTML
- Replaced Quartz dependency with zero-dependency Node.js http server + marked
- Binds to 127.0.0.1 only, XSS prevention (HTML escaping, javascript: link blocking)

### Wiki Discipline
- Ingest ripple: each source should touch 3-10 wiki pages (entities, concepts, cross-refs)
- Page creation threshold: main subject of source OR 2+ source mentions
- Minimum 2 outbound wikilinks per page
- 4 new lint checks: broken wikilinks, low cross-ref density, unsourced claims, knowledge gap analysis
- Kaizen-style gap analysis: lint surfaces topics referenced but not yet covered

### Prompt
- Quick Capture guidance for when to queue vs ingest
- User-request-first startup behavior
- Prescriptive deep review checklist (8 points, mapped to lint finding prefixes)

## v0.2.0

- CLI commands: `search`, `export`, `view`
- `--dir` flag for all commands
- URL validation (SSRF protection)
- Sacred boundary hardening (symlink chain validation, TOCTOU mitigation)
- 143 tests

## v0.1.0

- MCP server with 9 tools + 3 resources
- CLI: `init`, `add`, `serve`, `status`
- System prompt (Karpathy's 3 operations)
- Onboarding interview via `complete_onboarding` tool
- Sacred boundary enforcement (`safeWrite`)
- 105 tests
