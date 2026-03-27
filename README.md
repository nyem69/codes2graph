# codes2graph

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Neo4j](https://img.shields.io/badge/Neo4j-5.x-4581C3?logo=neo4j&logoColor=white)](https://neo4j.com)
[![Vitest](https://img.shields.io/badge/Tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

Indexes your codebase into a Neo4j graph and keeps it up-to-date as you edit. Parses functions, classes, imports, and call relationships using tree-sitter, with incremental updates targeting <2s per file change.

The graph follows the [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (CGC) schema, so CGC's MCP tools work out of the box. Any tool that reads Neo4j can also query the graph directly.

```
codes2graph index  -->  Neo4j  <--  cgc mcp start (MCP tools)
codes2graph watch  -->          <--  Neo4j Browser
                                <--  custom Cypher queries
```

## Why a Graph?

Standard code search tools (grep, ripgrep, IDE find-references) work on text patterns. A graph database stores the actual structure -- which function calls which, what imports what, how classes inherit. This enables queries that text search can't do well or at all:

| Task | Text search (grep) | Graph query (Neo4j) |
|------|-------------------|---------------------|
| Find callers of a function | `grep -r "funcName"` -- includes false matches from comments, strings, similar names | Exact caller→callee edges with line numbers and args |
| Downstream call analysis | Read source manually, file by file | All callees in one query with full call chain |
| Cyclomatic complexity | Manual count of branches -- misses ternaries, short-circuits, nested callbacks (~3x underestimate) | AST-based calculation, accurate per function |
| Cross-repo dependencies | Not possible (one repo at a time) | All indexed repos in one query -- finds importers across projects |
| Dead code detection | `grep` for each export, manually verify each hit | Automated scan for functions with no incoming CALLS edges |
| Module coupling | Count imports manually | Structured import graph with inbound/outbound counts |

**Known limitation:** SvelteKit anonymous route handlers (`export const POST = async () => {}`) are correctly parsed by codes2graph as named functions. However, if a repo was indexed with `cgc index` (the Python tool), these show up as file-level calls, causing false positives in dead code detection and broken call chain traversal. Re-indexing with codes2graph fixes this.

### Real-world comparison (plusdrive, 1,314 files, 2,846 functions)

**Find callers of `autoResolveProjectLrs`:**
- Grep: 10 files match (includes definition, imports, type references, comments)
- Graph: 4 exact callers with line numbers -- `POST` in `+server.ts:327`, `POST` in `bulk-resolve/+server.ts:107`, etc.

**Find callees (downstream calls):**
- Grep: not practical without reading the function body and parsing every call expression
- Graph: 13 callees in one query -- `sampleTrackPoints`, `findNearestSegments`, `detectSegments`, `buildConsensus`, `deriveProjectSummary`, `precomputeProjectLrs`, etc. with exact line numbers

**Complexity hotspots:**
- Grep: manual count of `if`/`for`/`while` -- typically ~3x underestimate
- Graph: AST-based, top functions across all repos in one query:

  | CC | Function | File |
  |----|----------|------|
  | 350 | `layoutSun` | nasab/wall-chart-sun-layout.ts |
  | 189 | `POST` | plusdrive/api/projects/[id]/assets/+server.ts |
  | 171 | `getProgressDashboard` | plusdrive/job-list.service.ts |
  | 116 | `vincentyDistance` | plusdrive/geodesic.ts |

**Dead code detection:**
- Grep: search for each exported function, manually verify -- hours of work
- Graph: 1,180 of 2,846 functions have no incoming CALLS (41%) -- instant query, then filter for false positives (route handlers, entry points)

**Module coupling (LRS module):**
- Grep: `grep -r "from.*lrs"` + manual dedup
- Graph: 24 files import from `/lrs/`, 17 outbound dependencies -- structured, instant

## Quick Start

```bash
# Install
git clone https://github.com/nyem69/codes2graph.git
cd codes2graph
npm install && bash scripts/setup-wasm.sh

# Configure (pick one)
cp .env.example .env              # edit NEO4J_PASSWORD
# -- or reuse CGC's config at ~/.codegraphcontext/.env

# Index a project
npx tsx src/index.ts index /path/to/your-project

# Watch for changes
npx tsx src/index.ts watch /path/to/your-project
```

## Prerequisites

- **Node.js** >= 18
- **Neo4j** running (Docker recommended):

```bash
docker run -d \
  --name cgc-neo4j \
  --restart unless-stopped \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  neo4j:5-community
```

The `--restart unless-stopped` flag auto-starts the container on boot.

## What's in the Graph

| Node type | Examples |
|-----------|----------|
| `Repository` | The indexed project |
| `File`, `Directory` | Source files and their directory tree |
| `Function`, `Class`, `Variable`, `Module` | Code entities extracted by tree-sitter |
| `Parameter` | Function parameters |

| Relationship | Meaning |
|--------------|---------|
| `CONTAINS` | File/directory contains entities |
| `CALLS` | Function calls another function (with line number) |
| `IMPORTS` | File imports from another file/module |
| `INHERITS` | Class extends another class |
| `HAS_PARAMETER` | Function has parameter |

---

## Commands

All examples use `npx tsx src/index.ts` run from the codes2graph directory. If you prefer a global command, run `npm run build && npm link` and substitute `codes2graph`.

### index -- Full index of a project

```bash
npx tsx src/index.ts index /path/to/project
npx tsx src/index.ts index /path/to/project --force    # wipe and re-index from scratch
```

Scans all `.ts`/`.js` files (respecting `.cgcignore`), parses them with tree-sitter, and writes the full graph to Neo4j.

| Flag | Default | Description |
|------|---------|-------------|
| `--force` | false | Wipe existing graph data for this repo first |
| `--batch-size <n>` | 50 | Files per processing batch |
| `--index-source` | false | Store full source code in graph nodes |
| `--skip-external` | false | Skip unresolved external function calls |

### watch -- Incremental updates on file change

```bash
npx tsx src/index.ts watch /path/to/project
```

Watches the project for file changes and updates the graph incrementally. Run this after `index` to keep the graph fresh.

| Flag | Default | Description |
|------|---------|-------------|
| `--debounce <ms>` | 5000 | Quiet period before processing a batch |
| `--max-wait <ms>` | 30000 | Max wait before forced processing |
| `--index-source` | false | Store full source code in graph nodes |
| `--skip-external` | false | Skip unresolved external function calls |

### clean -- Remove ignored files from graph

```bash
npx tsx src/index.ts clean /path/to/project --dry-run   # preview
npx tsx src/index.ts clean /path/to/project              # delete
```

Only needed if you used `cgc index` (the Python tool), which does not respect `.cgcignore`. The codes2graph `index` command respects `.cgcignore` automatically.

---

## Adding a New Project

```bash
npx tsx src/index.ts index /path/to/new-project
npx tsx src/index.ts watch /path/to/new-project
```

That's it. Create a `.cgcignore` in your project root to exclude directories (same syntax as `.gitignore`):

```
node_modules
.svelte-kit
dist
build
.wrangler
```

---

## Running as a Background Service (macOS)

Instead of keeping a terminal open, install the watcher as a launchd service that starts automatically on login and restarts on crash.

### Build first

The service uses compiled JS for lower overhead:

```bash
cd /path/to/codes2graph
npm run build
```

### Create the plist

Create `~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codes2graph.REPO_NAME</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>ulimit -n 65536; exec NODE_PATH dist/index.js watch /path/to/repo</string>
    </array>

    <key>WorkingDirectory</key>
    <string>CODES2GRAPH_PATH</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>HOME_DIR</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>HOME_DIR/Library/Logs/codes2graph-REPO_NAME.log</string>

    <key>StandardErrorPath</key>
    <string>HOME_DIR/Library/Logs/codes2graph-REPO_NAME.err</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>

    <key>HardResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>
</dict>
</plist>
```

Replace the placeholders:

| Placeholder | Find with | Example |
|-------------|-----------|---------|
| `REPO_NAME` | -- | `plusdrive` |
| `NODE_PATH` | `which node` | `/Users/you/.nvm/versions/node/v22.12.0/bin/node` |
| `NODE_DIR` | `dirname $(which node)` | `/Users/you/.nvm/versions/node/v22.12.0/bin` |
| `CODES2GRAPH_PATH` | -- | `/Users/you/codes2graph` |
| `HOME_DIR` | `echo $HOME` | `/Users/you` |
| `/path/to/repo` | -- | `/Users/you/projects/plusdrive` |

### Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist
```

### Manage the service

```bash
# Check running watchers
launchctl list | grep codes2graph

# View logs
tail -f ~/Library/Logs/codes2graph-REPO_NAME.log

# Stop
launchctl unload ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist

# Restart (after code changes to codes2graph)
cd /path/to/codes2graph && npm run build
launchctl unload ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist
launchctl load ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist
```

See [docs/002-Launchd-Deployment.md](docs/002-Launchd-Deployment.md) for troubleshooting (EMFILE errors, stale processes, debugging).

---

## Viewing the Graph

Open [http://localhost:7474](http://localhost:7474) (Neo4j Browser) and run Cypher queries:

```cypher
-- All nodes for a file
MATCH (f:File {relative_path: "src/lib/server/db.ts"})-[:CONTAINS]->(n) RETURN f, n

-- Call graph
MATCH (a)-[r:CALLS]->(b) RETURN a, r, b LIMIT 100

-- Inheritance tree
MATCH (a)-[r:INHERITS]->(b) RETURN a, r, b

-- List all indexed repos
MATCH (r:Repository) RETURN r.name, r.path
```

Other viewers: [Neo4j Desktop](https://neo4j.com/download/), [Neo4j Bloom](https://neo4j.com/product/bloom/), [Neodash](https://neodash.graphapp.io)

## Supported Languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)

## How It Works

**Full index (`index`):** Walk repo, discover files, filter by `.cgcignore`, parse each file with tree-sitter, write nodes and relationships to Neo4j, resolve cross-file CALLS and INHERITS using a symbol map.

**Incremental updates (`watch`):** On file save, debounce changes (5s quiet / 30s max), then for each changed file: delete old nodes, re-parse, write new nodes, re-resolve relationships. The symbol map is maintained incrementally per-file.

## Environment Variables

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
INDEX_SOURCE=false
SKIP_EXTERNAL_RESOLUTION=false
```

Config is loaded from (in priority order):
1. `.env` in your project directory
2. `.env` in the codes2graph directory
3. `~/.codegraphcontext/.env` (CGC's default)

## Project Structure

```
src/
  index.ts        CLI entry point (index, watch, clean commands)
  indexer.ts      Full repo indexer (file discovery + batch orchestration)
  watcher.ts      chokidar file watcher + BatchDebouncer
  pipeline.ts     Shared parse -> graph -> resolve pipeline
  parser.ts       tree-sitter parsing (TS/JS/TSX/JSX)
  graph.ts        Neo4j CRUD (CGC-compatible schema)
  symbols.ts      Incremental global symbol map
  resolver.ts     CALLS/INHERITS resolution
  ignore.ts       .cgcignore parser
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

Integration tests require a running Neo4j instance and will skip if unavailable.

## License

[MIT](LICENSE)
