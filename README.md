# codes2graph

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Neo4j](https://img.shields.io/badge/Neo4j-5.x-4581C3?logo=neo4j&logoColor=white)](https://neo4j.com)
[![Vitest](https://img.shields.io/badge/Tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

Incremental file watcher that keeps a [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (CGC)-compatible Neo4j graph up-to-date as you edit code. Replaces CGC's broken `cgc watch` (O(n²-n³) per save) with per-file incremental updates targeting <2s per change.

Writes to the **same Neo4j database and schema** that CGC uses — all existing CGC MCP tools (`find_code`, `find_callers`, `find_dead_code`, etc.) continue working unchanged.

```
Claude Code <--MCP--> cgc mcp start <--read--> Neo4j <--incremental write-- codes2graph
```

## Quick Start

```bash
# 1. Install
git clone <repo-url> && cd codes2graph
npm install
bash scripts/setup-wasm.sh

# 2. Configure Neo4j credentials (pick one)
cp .env.example .env              # edit with your Neo4j creds
# — or use CGC's existing config at ~/.codegraphcontext/.env

# 3. Run
npx tsx src/index.ts watch /path/to/repo
```

That's it — the watcher is running. Edit a `.ts`/`.js` file in your repo and the graph updates within seconds.

## Prerequisites

- Node.js >= 18
- Neo4j (running, with CGC schema — run `cgc index --force .` once for initial setup)

## Install as Global Command (optional)

```bash
npm run build     # compile TypeScript → dist/
npm link          # symlink "codes2graph" into your PATH

# now works anywhere:
codes2graph watch /path/to/repo
codes2graph clean /path/to/repo
```

> **Why `codes2graph` doesn't work without this:** the `bin` field in package.json points to `dist/index.js`, which only exists after `npm run build`. Without building, use `npx tsx src/index.ts` instead.

## Usage

```bash
# Watch for changes (dev)
npx tsx src/index.ts watch /path/to/repo

# Watch with options
npx tsx src/index.ts watch /path/to/repo --debounce 3000 --max-wait 20000 --index-source --skip-external

# Clean ignored files from graph
npx tsx src/index.ts clean /path/to/repo --dry-run   # preview
npx tsx src/index.ts clean /path/to/repo              # delete
```

If you installed globally (`npm link`), replace `npx tsx src/index.ts` with `codes2graph`.

### Watch Options

| Flag | Default | Description |
|------|---------|-------------|
| `--debounce <ms>` | 5000 | Quiet period before processing batch |
| `--max-wait <ms>` | 30000 | Max wait before forced processing |
| `--index-source` | false | Store full source code in graph nodes |
| `--skip-external` | false | Skip unresolved external function calls |

### Clean Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be deleted without deleting |

## Relationship to CGC

codes2graph **does not replace** `cgc mcp start` — it only replaces the broken `cgc watch` command. The workflow:

1. **`cgc index --force .`** — one-time full index of a repo (already done for your repos)
2. **`codes2graph watch /path/to/repo`** — keeps that repo's graph fresh as you edit
3. **`cgc mcp start`** — unchanged, reads from Neo4j as before

You only need to run `codes2graph watch` on the repo you're actively editing. If you're working on multiple repos simultaneously, run one watcher per repo. CGC MCP reads from the same shared Neo4j database regardless.

## Cleaning Ignored Files

`cgc index --force` does **not** respect `.cgcignore` — it indexes everything, including directories like `.wrangler/`, `node_modules/`, `.svelte-kit/`, etc. This pollutes the graph with thousands of irrelevant nodes that show up in `cgc analyze dead-code` and other queries.

Run `clean` after any full reindex to remove them:

```bash
# Preview what would be deleted
codes2graph clean /path/to/repo --dry-run

# Delete ignored files from the graph
codes2graph clean /path/to/repo
```

This reads your `.cgcignore` (plus built-in defaults), finds all matching File nodes in Neo4j, and deletes them along with their contained Functions, Classes, Variables, etc.

**Recommended workflow after reindexing:**
```bash
cgc index --force .                    # full reindex (doesn't respect .cgcignore)
codes2graph clean /path/to/repo        # remove ignored files from graph
```

## How It Works

On file change:

1. **Debounce** — Collect changes for 5s of quiet (or 30s max), then process as a batch
2. **Delete** — Remove old graph nodes for changed files
3. **Parse** — Parse each file with tree-sitter (TS/JS/TSX/JSX)
4. **Write** — Create new nodes (Function, Class, Variable, Module, Parameter) and relationships (CONTAINS, IMPORTS, HAS_PARAMETER)
5. **Resolve** — Resolve cross-file CALLS and INHERITS using an incremental symbol map

The symbol map (`symbolName -> Set<filePath>`) is maintained incrementally per-file instead of CGC's full-rebuild approach.

## Supported Languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)

## Project Structure

```
src/
  index.ts        CLI entry point
  watcher.ts      chokidar file watcher + BatchDebouncer
  parser.ts       tree-sitter parsing (ports CGC's Python queries)
  graph.ts        Neo4j CRUD matching CGC's exact Cypher queries
  symbols.ts      Incremental global symbol map
  resolver.ts     CALLS/INHERITS resolution (local -> import -> global)
  ignore.ts       .cgcignore pattern loading
  config.ts       .env config loading
  types.ts        Shared TypeScript interfaces
scripts/
  setup-wasm.sh   Copy tree-sitter WASM files from node_modules
```

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
```

Integration tests require a running Neo4j instance and will gracefully skip if unavailable.

## Viewing the Graph

Open the Neo4j Browser at [http://localhost:7474](http://localhost:7474) (already running with your Neo4j instance). Example queries:

```cypher
-- All nodes for a file
MATCH (f:File {relative_path: "src/lib/server/db.ts"})-[:CONTAINS]->(n) RETURN f, n

-- Call graph
MATCH (a)-[r:CALLS]->(b) RETURN a, r, b LIMIT 100

-- Inheritance tree
MATCH (a)-[r:INHERITS]->(b) RETURN a, r, b
```

Other viewers:

| Tool | Description |
|------|-------------|
| [Neo4j Desktop](https://neo4j.com/download/) | Free desktop app with browser + plugins |
| [Neo4j Bloom](https://neo4j.com/product/bloom/) | Interactive graph exploration (included in Neo4j Desktop) |
| [Neodash](https://neodash.graphapp.io) | Open-source dashboard builder for Neo4j |

## Environment Variables

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
INDEX_SOURCE=false
SKIP_EXTERNAL_RESOLUTION=false
```

## License

[MIT](LICENSE)
