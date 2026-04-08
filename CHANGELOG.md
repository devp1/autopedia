# Changelog

## v0.5.0

### Repository Scanning
- `autopedia add --repo <path>` or auto-detect by `.git/` presence
- Smart file discovery: role-based scoring (manifest/docs/config/entry/source/test)
- Gitignore-aware: respects `.gitignore` via `git ls-files`
- Security: 21 secret-file patterns excluded, symlink validation, credential URL redaction, path hash for slug uniqueness
- Structured markdown bundle: metadata, directory tree, git log, curated source files with dynamic code fences
- Prompt guidance for repo→wiki page synthesis (overview, architecture, flows, operations)

### CLI Lint
- `autopedia lint` — check wiki health from terminal (no MCP session needed)
- 7 check types: orphans, stale pages, broken links, low cross-refs, duplicates, unsourced claims, knowledge gaps
- Extracted from MCP-only to shared `Wiki.lint()` with structured `LintFinding` interface

### Source Display Names
- Headingless notes show first meaningful line as title (skips frontmatter)
- Consistent titles across sidebar, sources list, and source detail pages
- Cleaned literal `\n`, capitalized first letter, stripped repo path hashes

### Safety & Hardening
- Init guard: blocks `autopedia init --dir` inside code projects (ancestor walk)
- `.autopedia` excluded from repo scanner
- Queue dedup: re-scanning same repo won't create duplicate queue entries
- Graph: theme-reactive labels via CSS `var()` (works across light/dark toggle)
- Stronger `prepublishOnly`: typecheck + lint + test + build

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
