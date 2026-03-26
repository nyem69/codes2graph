# codes2graph

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Neo4j](https://img.shields.io/badge/Neo4j-5.x-4581C3?logo=neo4j&logoColor=white)](https://neo4j.com)
[![Vitest](https://img.shields.io/badge/Tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

Watches your codebase and keeps a Neo4j graph of functions, classes, imports, and call relationships up-to-date as you edit. Changes are processed incrementally (<2s per file) instead of rebuilding the entire graph.

The graph follows the [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (CGC) schema, so CGC's MCP tools work out of the box. Any tool that reads Neo4j can also query the graph directly.

```
Editor --> file save --> codes2graph --> Neo4j <-- any Neo4j reader
                                              <-- cgc mcp start (CGC MCP tools)
                                              <-- Neo4j Browser
                                              <-- custom queries
```

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

## Prerequisites

- **Node.js** >= 18
- **Neo4j** running (Docker recommended, see below)
- **CGC** (`pip install codegraphcontext`) for initial indexing

### Neo4j via Docker (recommended)

```bash
docker run -d \
  --name cgc-neo4j \
  --restart unless-stopped \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  neo4j:5-community
```

The `--restart unless-stopped` flag auto-starts the container on boot.

---

## Step 1: Install codes2graph

```bash
git clone https://github.com/nyem69/codes2graph.git
cd codes2graph
npm install
bash scripts/setup-wasm.sh
```

Configure Neo4j credentials (pick one):

```bash
cp .env.example .env              # edit NEO4J_PASSWORD
# -- or reuse CGC's config at ~/.codegraphcontext/.env
```

## Step 2: Index a new project

Run from anywhere -- point it at your project:

```bash
npx tsx /path/to/codes2graph/src/index.ts index /path/to/your-project
```

This scans all `.ts`/`.js` files (respecting `.cgcignore`), parses them with tree-sitter, and writes the full graph to Neo4j. Progress is reported as it runs.

To re-index from scratch (wipes existing graph data for this repo):

```bash
npx tsx /path/to/codes2graph/src/index.ts index /path/to/your-project --force
```

### Index options

| Flag | Default | Description |
|------|---------|-------------|
| `--force` | false | Wipe existing graph data for this repo first |
| `--batch-size <n>` | 50 | Files per processing batch |
| `--index-source` | false | Store full source code in graph nodes |
| `--skip-external` | false | Skip unresolved external function calls |

## Step 3: Clean ignored files (only after `cgc index`)

> Skip this step if you used codes2graph's `index` command -- it already respects `.cgcignore`.

If you used `cgc index` (the Python tool) instead, you need to clean ignored files separately because `cgc index` does not respect `.cgcignore`:

```bash
npx tsx /path/to/codes2graph/src/index.ts clean /path/to/your-project --dry-run   # preview
npx tsx /path/to/codes2graph/src/index.ts clean /path/to/your-project              # delete
```

## Step 4: Start the watcher

```bash
npx tsx /path/to/codes2graph/src/index.ts watch /path/to/your-project
```

The watcher is now running. Edit any `.ts`/`.js` file and the graph updates within seconds.

### Watch options

| Flag | Default | Description |
|------|---------|-------------|
| `--debounce <ms>` | 5000 | Quiet period before processing a batch |
| `--max-wait <ms>` | 30000 | Max wait before forced processing |
| `--index-source` | false | Store full source code in graph nodes |
| `--skip-external` | false | Skip unresolved external function calls |

---

## Adding a New Project (cheatsheet)

Once codes2graph is installed, these are the only steps for each new project:

```bash
npx tsx /path/to/codes2graph/src/index.ts index /path/to/new-project
npx tsx /path/to/codes2graph/src/index.ts watch /path/to/new-project
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

| Placeholder | Example |
|-------------|---------|
| `REPO_NAME` | `plusdrive` |
| `NODE_PATH` | `/Users/you/.nvm/versions/node/v22.12.0/bin/node` (run `which node`) |
| `NODE_DIR` | `/Users/you/.nvm/versions/node/v22.12.0/bin` |
| `CODES2GRAPH_PATH` | `/Users/you/codes2graph` |
| `HOME_DIR` | `/Users/you` |
| `/path/to/repo` | `/Users/you/projects/plusdrive` |

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

On file save:

1. **Debounce** -- Collect changes for 5s of quiet (30s max), then process as a batch
2. **Delete** -- Remove old graph nodes for the changed file
3. **Parse** -- Parse the file with tree-sitter
4. **Write** -- Create new nodes and relationships
5. **Resolve** -- Resolve cross-file CALLS and INHERITS using an incremental symbol map

The symbol map (`symbolName -> Set<filePath>`) is maintained incrementally per-file instead of rebuilding the full graph.

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
  index.ts        CLI entry point
  watcher.ts      chokidar file watcher + BatchDebouncer
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
