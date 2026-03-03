# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**codes2graph** is an incremental file watcher that keeps a CodeGraphContext (CGC)-compatible Neo4j graph up-to-date as code is edited. It replaces CGC's broken `cgc watch` (O(n²-n³) on every save) with per-file incremental updates targeting <2s per change.

It writes to the **same Neo4j database and schema** that CGC uses — all existing CGC MCP tools (`find_code`, `find_callers`, `find_dead_code`) continue working unchanged. codes2graph only writes; CGC's MCP server remains the read interface.

## Architecture

```
Claude Code ←──MCP──► cgc mcp start ←──read──► Neo4j ◄──incremental write── codes2graph (watcher)
```

The architecture spec is in `docs/001-Architecture.md` — it is the authoritative reference for schema, algorithms, and implementation plan.

### Core Algorithm

On file change: parse only that file (tree-sitter) → delete old graph nodes for that file → create new nodes/relationships → resolve CALLS/INHERITS using incremental symbol map. The symbol map is the key innovation: maintained incrementally per-file instead of CGC's full-rebuild approach.

### Planned Source Layout

```
src/
├── index.ts       # CLI entry point
├── watcher.ts     # chokidar file watcher + debounce (5s quiet, 30s max)
├── parser.ts      # tree-sitter parsing for TS/JS
├── graph.ts       # Neo4j CRUD (must match CGC schema exactly)
├── symbols.ts     # Incremental global symbol map (symbolName → filePaths)
├── resolver.ts    # CALLS/INHERITS resolution (local → import → global)
└── ignore.ts      # .cgcignore parser
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **File watcher**: chokidar
- **Parser**: tree-sitter (web-tree-sitter or node-tree-sitter)
- **Database**: neo4j-driver (official)
- **Ignore**: picomatch / .cgcignore format
- **Config**: dotenv (`~/.codegraphcontext/.env` for Neo4j credentials)

## Neo4j Schema (CGC-Compatible)

Node labels: `Repository`, `File`, `Directory`, `Function`, `Class`, `Variable`, `Module`, `Parameter`
Relationships: `CONTAINS`, `CALLS` (with line_number, args), `IMPORTS` (with alias), `INHERITS`, `HAS_PARAMETER`

File nodes are keyed by `path`. Function/Class/Variable use composite `(name, path, line_number)`. See `docs/001-Architecture.md` for full schema details and Cypher constraints.

## Implementation Phases

1. **Phase 1**: Core incremental updater (TS/JS only) — graph.ts → parser.ts → symbols.ts → resolver.ts → watcher.ts → index.ts
2. **Phase 2**: Svelte support (extract `<script>` blocks, adjust line numbers)
3. **Phase 3**: Reverse CALLS staleness cleanup (delete all outgoing CALLS before re-creating)
4. **Phase 4**: Launchd/systemd background service

## Critical Constraints

- Graph writes must produce **identical schema** to `cgc index` output — CGC MCP tools must read the data without modification
- Symbol resolution priority must match CGC: local context → local definition → import map → global symbol map
- Debounce: 5s quiet period, 30s max wait, batch all changes into single processing pass
- Phase 1 targets: single file <2s, 10-file batch <5s, idle memory <50MB, idle CPU <1%
