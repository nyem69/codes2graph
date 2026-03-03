# codes2graph

Incremental file watcher that keeps a [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (CGC)-compatible Neo4j graph up-to-date as you edit code. Replaces CGC's broken `cgc watch` (O(n²-n³) per save) with per-file incremental updates targeting <2s per change.

Writes to the **same Neo4j database and schema** that CGC uses — all existing CGC MCP tools (`find_code`, `find_callers`, `find_dead_code`, etc.) continue working unchanged.

```
Claude Code <--MCP--> cgc mcp start <--read--> Neo4j <--incremental write-- codes2graph
```

## Prerequisites

- Node.js >= 18
- Neo4j (running, with CGC schema — run `cgc index --force .` once for initial setup)

## Setup

```bash
npm install
bash scripts/setup-wasm.sh
cp .env.example .env  # edit with your Neo4j credentials
```

The WASM setup copies tree-sitter language grammars from `node_modules` to the project root. Config can also live at `~/.codegraphcontext/.env` (CGC's config location).

## Usage

```bash
# Development
npx tsx src/index.ts watch /path/to/repo

# With options
npx tsx src/index.ts watch /path/to/repo --debounce 3000 --max-wait 20000 --index-source --skip-external

# Production (after build)
npm run build
codes2graph watch /path/to/repo
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--debounce <ms>` | 5000 | Quiet period before processing batch |
| `--max-wait <ms>` | 30000 | Max wait before forced processing |
| `--index-source` | false | Store full source code in graph nodes |
| `--skip-external` | false | Skip unresolved external function calls |

## Relationship to CGC

codes2graph **does not replace** `cgc mcp start` — it only replaces the broken `cgc watch` command. The workflow:

1. **`cgc index --force .`** — one-time full index of a repo (already done for your repos)
2. **`codes2graph watch /path/to/repo`** — keeps that repo's graph fresh as you edit
3. **`cgc mcp start`** — unchanged, reads from Neo4j as before

You only need to run `codes2graph watch` on the repo you're actively editing. If you're working on multiple repos simultaneously, run one watcher per repo. CGC MCP reads from the same shared Neo4j database regardless.

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

## Environment Variables

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
INDEX_SOURCE=false
SKIP_EXTERNAL_RESOLUTION=false
```

## License

Private
