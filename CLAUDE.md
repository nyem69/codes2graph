# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**codes2graph** indexes codebases into a Neo4j graph and keeps them up-to-date incrementally as code is edited. It replaces both `cgc index` (full indexing) and `cgc watch` (file watching) with faster, `.cgcignore`-aware alternatives.

It writes to the **same Neo4j database and schema** that CGC uses — all existing CGC MCP tools (`find_code`, `find_callers`, `find_dead_code`) continue working unchanged. codes2graph only writes; CGC's MCP server remains the read interface.

## Architecture

```
codes2graph index ──► Neo4j ◄── cgc mcp start ←──MCP──► Claude Code
codes2graph watch ──►
```

The architecture spec is in `docs/001-Architecture.md` — it is the authoritative reference for schema, algorithms, and implementation plan.

### Three Commands

- **`index <path>`** — Full index: discover files (respecting `.cgcignore`), parse with tree-sitter, write graph, resolve cross-file CALLS/INHERITS. `--force` wipes existing data first.
- **`watch <path>`** — Incremental: on file change, debounce (5s quiet / 30s max), then delete old nodes → re-parse → write new nodes → re-resolve relationships.
- **`clean <path>`** — Remove `.cgcignore`-matched files from graph (only needed after `cgc index`, not after codes2graph `index`).

### Core Pipeline (src/pipeline.ts)

Both `index` and `watch` share the same pipeline: for a batch of file paths → clean old data → parse each file (tree-sitter) → write to Neo4j → resolve CALLS/INHERITS using incremental symbol map. The symbol map (`symbolName → Set<filePath>`) is maintained incrementally per-file.

### Source Layout

```
src/
├── index.ts       # CLI entry point (index, watch, clean commands)
├── indexer.ts     # Full repo indexer (file discovery + batch orchestration)
├── watcher.ts     # chokidar file watcher + BatchDebouncer
├── pipeline.ts    # Shared parse → graph → resolve pipeline
├── parser.ts      # tree-sitter parsing for TS/JS/TSX/JSX
├── graph.ts       # Neo4j CRUD (must match CGC schema exactly)
├── symbols.ts     # Incremental global symbol map
├── resolver.ts    # CALLS/INHERITS resolution (local → import → global)
├── ignore.ts      # .cgcignore parser (merged with built-in defaults)
├── config.ts      # .env config loading
└── types.ts       # Shared TypeScript interfaces
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **File watcher**: chokidar (polling mode for launchd compatibility)
- **Parser**: web-tree-sitter
- **Database**: neo4j-driver (official)
- **Ignore**: picomatch / .cgcignore format (always merged with built-in defaults)
- **Config**: dotenv (`~/.codegraphcontext/.env` for Neo4j credentials)
- **Tests**: vitest

## Neo4j Schema (CGC-Compatible)

Node labels: `Repository`, `File`, `Directory`, `Function`, `Class`, `Variable`, `Module`, `Parameter`, `Interface`
Relationships: `CONTAINS`, `CALLS` (with line_number, args), `IMPORTS` (with alias), `INHERITS`, `HAS_PARAMETER`

File nodes are keyed by `path`. Function/Class/Variable use composite `(name, path, line_number)`. See `docs/001-Architecture.md` for full schema details and Cypher constraints.

## SvelteKit Handler Parsing

codes2graph correctly parses `export const POST: RequestHandler = async () => {}` as a named Function node (not a Variable). The tree-sitter query matches `variable_declarator → arrow_function` patterns. Calls inside these handlers get proper caller context, producing Function→Function CALLS edges.

This is an improvement over `cgc index`, which creates file-level CALLS edges for these patterns, causing false positives in `find_dead_code` and broken `call_chain` traversal.

## Ignore Patterns

`.cgcignore` patterns are always **merged** with built-in defaults (node_modules, .svelte-kit, dist, build, .wrangler, .git, .claude, *.min.js, *.map). A project's `.cgcignore` adds to these defaults, never replaces them.

## Running as a Service

Watchers run as macOS launchd services. See `docs/002-Launchd-Deployment.md` for plist templates, the EMFILE fix (polling mode + ulimit), and troubleshooting. Key detail: services use compiled `dist/index.js` (run `npm run build` first), not tsx.

## Critical Constraints

- Graph writes must produce **identical schema** to `cgc index` output — CGC MCP tools must read the data without modification
- Symbol resolution priority must match CGC: local context → local definition → import map → global symbol map
- Debounce: 5s quiet period, 30s max wait, batch all changes into single processing pass
- `--force` wipe must clean stale sub-repo Repository nodes (left by cgc index on subdirectories)
