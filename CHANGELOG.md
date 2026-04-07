# Changelog

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
