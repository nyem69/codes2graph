# codes2graph — Incremental Code Graph Watcher

## Problem

[CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (CGC) provides a code graph database that indexes codebases into Neo4j (Functions, Classes, Modules + CALLS, IMPORTS, INHERITS relationships). Its MCP server exposes powerful analysis tools (`find_callers`, `find_dead_code`, `find_most_complex_functions`, etc.) to Claude Code.

However, **`cgc watch` is fundamentally broken** for repos > ~100 files. Every single file save triggers a full repository re-index (O(n²) to O(n³) work), causing runaway CPU (708%+ observed). The root cause is in `watcher.py:84-119` — see [road-asset-tagging docs/141-CGC-MCP.md](../../SITE/AHN/road-asset-tagging/docs/141-CGC-MCP.md) for the full analysis.

Currently we use manual `cgc index --force .` (~14 min) which works but makes the graph stale between reindexes.

## Goal

Build `codes2graph` — a lightweight, incremental file watcher that keeps a CGC-compatible Neo4j graph up-to-date. It writes to the **same Neo4j database and schema** that CGC uses, so all existing CGC MCP tools (`find_code`, `find_callers`, `find_dead_code`, etc.) continue to work unchanged.

### Non-Goals

- Replace CGC's MCP server — we keep using `cgc mcp start`
- Replace CGC's parser — we reuse tree-sitter with CGC's language queries
- Replace CGC's initial indexer — `cgc index --force .` handles first-time full indexing
- Support all 14 CGC languages — start with TypeScript/JavaScript only (our stack)

## Architecture

```
┌──────────────┐     MCP      ┌──────────────┐     Cypher    ┌──────────────┐
│  Claude Code │◄────────────►│  cgc mcp     │◄─────────────►│   Neo4j      │
│  (session)   │   stdio      │  start       │   (read)      │  (Docker)    │
└──────────────┘              └──────────────┘               └──────┬───────┘
                                                                    ▲
                              ┌──────────────┐     Cypher          │
                              │ codes2graph  │─────────────────────►│
                              │  (watcher)   │   (incremental      │
                              └──────────────┘    write)            │
```

- **CGC MCP server**: Unchanged. Reads from Neo4j as before.
- **codes2graph**: New watcher. Writes incremental updates to Neo4j on file changes.
- **Neo4j**: Shared database. Same schema, same data, two writers (non-conflicting).

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | **Node.js** | Same stack as road-asset-tagging, avoids Python dependency issues |
| File watcher | **chokidar** | Battle-tested, handles macOS FSEvents properly, configurable ignore |
| Parser | **tree-sitter** (via `web-tree-sitter` or `node-tree-sitter`) | Same parser CGC uses — ensures identical AST extraction |
| Neo4j client | **neo4j-driver** | Official Neo4j JavaScript driver |
| Ignore patterns | **picomatch** or `.cgcignore` parser | Respects same ignore rules as CGC |
| Config | **dotenv** + CLI args | Reads `~/.codegraphcontext/.env` for Neo4j credentials |

## CGC-Compatible Neo4j Schema

codes2graph must write to the exact same schema that CGC uses. This ensures CGC MCP tools can read our data.

### Node Labels

| Label | Unique Key | Key Properties |
|-------|------------|----------------|
| `Repository` | `path` | `name`, `is_dependency` |
| `File` | `path` | `name`, `relative_path`, `is_dependency` |
| `Directory` | `path` | `name` |
| `Function` | `(name, path, line_number)` | `source`, `docstring`, `cyclomatic_complexity`, `decorators`, `args`, `lang` |
| `Class` | `(name, path, line_number)` | `source`, `docstring`, `bases`, `lang` |
| `Variable` | `(name, path, line_number)` | `value`, `type`, `lang` |
| `Module` | `name` | `alias`, `full_import_name`, `lang` |
| `Parameter` | composite | `name`, `path`, `function_line_number` |

### Relationships

| Type | Direction | Properties |
|------|-----------|------------|
| `CONTAINS` | Parent → Child | — |
| `CALLS` | Caller → Callee | `line_number`, `args`, `full_call_name` |
| `IMPORTS` | File → Module | `line_number`, `alias`, `imported_name` |
| `INHERITS` | Child → Parent | — |
| `HAS_PARAMETER` | Function → Parameter | — |

### Indexes

```cypher
CREATE CONSTRAINT IF NOT EXISTS FOR (r:Repository) REQUIRE r.path IS UNIQUE;
CREATE CONSTRAINT IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE;
CREATE CONSTRAINT IF NOT EXISTS FOR (d:Directory) REQUIRE d.path IS UNIQUE;
CREATE CONSTRAINT IF NOT EXISTS FOR (m:Module) REQUIRE m.name IS UNIQUE;
-- Function/Class/Variable use composite uniqueness (name, path, line_number)
CREATE FULLTEXT INDEX code_search_index IF NOT EXISTS
  FOR (n:Function|Class|Variable) ON EACH [n.name, n.source, n.docstring];
```

## Incremental Update Algorithm

This is the core innovation — what `cgc watch` should have done.

### On File Change (create/modify)

```
1. Parse ONLY the changed file (tree-sitter)
2. Delete old graph for that file:
     MATCH (f:File {path: $path})-[:CONTAINS]->(element)
     DETACH DELETE f, element
3. Create new File node + contained Functions/Classes/Variables/Parameters
4. Create IMPORTS relationships (File → Module)
5. Resolve CALLS for functions IN THIS FILE ONLY:
   - For each function_call in parsed data:
     a. Check local file first (same file)
     b. Check imports_map (global symbol → file lookup)
     c. MERGE CALLS relationship
6. Resolve INHERITS for classes IN THIS FILE ONLY:
   - Same resolution: local → imported → global
```

### On File Delete

```
1. MATCH (f:File {path: $path})-[:CONTAINS]->(element)
   DETACH DELETE f, element
2. Clean up empty Directory nodes
3. Remove stale CALLS pointing TO deleted functions
```

### On File Move/Rename

```
1. Treat as delete(old) + create(new)
```

### Global Symbol Map (imports_map)

The imports_map is critical for cross-file CALLS resolution. CGC rebuilds it from scratch on every change (the expensive part). We maintain it incrementally:

```
In-memory map: symbolName → [filePath1, filePath2, ...]

On file change:
  1. Remove all entries where value contains the changed file
  2. Re-parse the changed file
  3. Add new entries for functions/classes defined in the changed file

On startup:
  1. Query Neo4j for all Function/Class nodes
  2. Build initial map from existing graph data
  3. No need to re-parse — graph already has the data
```

### Stale CALLS Cleanup

When a file changes, functions it previously called may have outgoing CALLS from other files pointing to functions that no longer exist. These are cleaned up lazily:

```cypher
-- After updating file X, clean up any CALLS pointing to functions
-- that were in file X but no longer exist
MATCH (caller)-[r:CALLS]->(callee)
WHERE callee.path = $changedFilePath
AND NOT EXISTS { MATCH (f:File {path: $changedFilePath})-[:CONTAINS]->(callee) }
DELETE r
```

## File Watcher Design

### Debouncing Strategy

```
┌─────────┐   file events   ┌──────────┐   batch (5s quiet)   ┌───────────┐
│ chokidar │──────────────►  │ debounce │────────────────────► │ processor │
│          │                 │ (5s)     │                      │           │
└─────────┘                  └──────────┘                      └───────────┘
```

- Accumulate all changed file paths into a Set
- After 5 seconds of quiet (no new events), process the entire batch
- Single imports_map rebuild for the batch, not per file
- Max wait: 30 seconds (process even if events keep coming)

### Ignore Patterns

Read `.cgcignore` (same format as CGC) and apply to chokidar's `ignored` option:

```
node_modules/
.svelte-kit/
coverage/
dist/
build/
.git/
*.min.js
*.map
```

### Supported Extensions (Phase 1)

```
.ts, .tsx, .js, .jsx, .mjs, .cjs
```

Phase 2: `.svelte` (extract `<script>` block, parse as TS/JS)
Phase 3: `.py`, `.go`, etc.

## Implementation Plan

### Phase 1: Core Incremental Updater

**Files to create:**

```
codes2graph/
├── package.json
├── tsconfig.json
├── .env.example              # NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD
├── src/
│   ├── index.ts              # CLI entry point
│   ├── watcher.ts            # chokidar setup, debouncing, batch processing
│   ├── parser.ts             # tree-sitter parsing (TS/JS)
│   ├── graph.ts              # Neo4j read/write operations
│   ├── symbols.ts            # Global symbol map (imports_map equivalent)
│   ├── resolver.ts           # CALLS/INHERITS resolution logic
│   └── ignore.ts             # .cgcignore parser
└── docs/
    └── 001-Architecture.md   # This file
```

#### Step 1: Neo4j Graph Client (`graph.ts`)

CRUD operations against Neo4j using CGC's exact schema:

```typescript
interface GraphClient {
  // File operations
  deleteFile(path: string): Promise<void>;
  createFile(path: string, repoPath: string, data: ParsedFile): Promise<void>;

  // Relationship operations
  createCallRelationship(caller: FunctionRef, callee: FunctionRef, meta: CallMeta): Promise<void>;
  createInheritsRelationship(child: ClassRef, parent: ClassRef): Promise<void>;
  createImportRelationship(filePath: string, moduleName: string, meta: ImportMeta): Promise<void>;

  // Symbol map bootstrap
  getAllSymbols(): Promise<Map<string, string[]>>;

  // Cleanup
  cleanStaleCallsTo(filePath: string): Promise<void>;
  cleanEmptyDirectories(): Promise<void>;
}
```

#### Step 2: Tree-Sitter Parser (`parser.ts`)

Parse a single file and return a structure matching CGC's `parse_file()` output:

```typescript
interface ParsedFile {
  path: string;
  lang: string;
  functions: ParsedFunction[];
  classes: ParsedClass[];
  variables: ParsedVariable[];
  imports: ParsedImport[];
  functionCalls: ParsedCall[];
}

function parseFile(filePath: string): ParsedFile;
```

Must extract the same data CGC does:
- Functions: name, line_number, args, cyclomatic_complexity, source, docstring, decorators, context (parent function/class)
- Classes: name, line_number, bases, source, docstring
- Variables: name, line_number, value, type
- Imports: name, source, alias, line_number
- Function calls: name, line_number, args, context (caller), full_name

#### Step 3: Symbol Map (`symbols.ts`)

Incremental global symbol map:

```typescript
class SymbolMap {
  private map: Map<string, Set<string>>;  // symbol → file paths

  // Bootstrap from Neo4j on startup
  async bootstrap(graph: GraphClient): Promise<void>;

  // Update on file change
  removeFile(filePath: string): void;
  addFile(filePath: string, data: ParsedFile): void;

  // Lookup
  resolve(symbolName: string): string[];
}
```

#### Step 4: CALLS/INHERITS Resolver (`resolver.ts`)

Resolve function calls and inheritance for a single file's parsed data:

```typescript
function resolveCallsForFile(
  parsedFile: ParsedFile,
  symbolMap: SymbolMap,
): ResolvedCall[];

function resolveInheritanceForFile(
  parsedFile: ParsedFile,
  symbolMap: SymbolMap,
): ResolvedInheritance[];
```

Resolution priority (matches CGC):
1. Local context (this/self/super) → same file
2. Local definition → same file
3. Import map → imported module's file
4. Global symbol map → any file defining that symbol

#### Step 5: File Watcher (`watcher.ts`)

```typescript
class Watcher {
  private pendingChanges: Set<string>;
  private debounceTimer: NodeJS.Timeout | null;
  private symbolMap: SymbolMap;
  private graph: GraphClient;

  start(repoPath: string, options: WatchOptions): void;
  stop(): void;

  private onFileChange(filePath: string): void;
  private processBatch(): Promise<void>;
}
```

Batch processing flow:
```
processBatch():
  changedFiles = drain pendingChanges set
  for each file in changedFiles:
    1. symbolMap.removeFile(file)
    2. graph.deleteFile(file)
  for each file in changedFiles (if still exists):
    3. parsed = parseFile(file)
    4. symbolMap.addFile(file, parsed)
    5. graph.createFile(file, repoPath, parsed)
    6. calls = resolveCallsForFile(parsed, symbolMap)
    7. inheritance = resolveInheritanceForFile(parsed, symbolMap)
    8. graph.createCallRelationships(calls)
    9. graph.createInheritsRelationships(inheritance)
    10. graph.cleanStaleCallsTo(file)
```

#### Step 6: CLI Entry Point (`index.ts`)

```bash
# Watch a directory
codes2graph watch /path/to/repo

# Watch with options
codes2graph watch /path/to/repo --debounce 5000 --extensions .ts,.js

# Check status
codes2graph status
```

### Phase 2: Svelte Support

Extract `<script>` / `<script lang="ts">` blocks from `.svelte` files before parsing:

```typescript
function extractSvelteScript(content: string): { code: string; offset: number } | null;
```

The offset is needed to adjust line numbers so they match the original `.svelte` file (CGC has this same limitation — it parses `<script>` blocks but may miss template-level expressions).

### Phase 3: Reverse CALLS Staleness

When file A changes and no longer calls function X in file B, the old `A -[:CALLS]-> X` relationship is stale. Phase 1 handles forward staleness (calls TO the changed file). Phase 3 handles reverse staleness (calls FROM the changed file):

```cypher
-- Before creating new CALLS from file A, delete all old CALLS from file A
MATCH (caller)-[r:CALLS]->(callee)
WHERE caller.path = $changedFilePath
DELETE r
-- Then re-create only the current calls
```

This is simpler and more correct — just delete all outgoing CALLS from the changed file and re-create from the fresh parse.

### Phase 4: Launchd / systemd Service

Run codes2graph as a background daemon:

```bash
# macOS
codes2graph install   # Creates ~/Library/LaunchAgents/com.codes2graph.watcher.plist
codes2graph uninstall # Removes it

# Linux
codes2graph install   # Creates systemd user service
```

## Performance Targets

| Operation | Target | CGC watch (actual) |
|-----------|--------|-------------------|
| Single file change | < 2 seconds | 5–15 seconds (+ cascade) |
| 10 files batch | < 5 seconds | 50–150 seconds |
| Memory (idle) | < 50 MB | Grows unbounded (timer leak) |
| CPU (idle) | < 1% | 0% → 708% (runaway) |
| Startup (symbol map bootstrap) | < 5 seconds | N/A |

## Testing Strategy

1. **Unit tests**: Parser output matches CGC's for the same file
2. **Integration tests**: Write to Neo4j, verify CGC MCP tools can read the data correctly
3. **Compatibility tests**: Index a repo with both `cgc index` and `codes2graph`, compare graph contents
4. **Stress tests**: Rapid file saves (IDE simulation), verify no cascade or memory leak
5. **Staleness tests**: Rename a function, verify old CALLS are cleaned up

## Open Questions

1. **tree-sitter queries**: Should we port CGC's Python tree-sitter queries to JS, or write our own? CGC's queries are in `languages/*.py` — they use `tree_sitter.Query` with S-expression patterns. `node-tree-sitter` supports the same query language.

2. **Cyclomatic complexity**: CGC calculates this during parsing. Should we replicate it or skip it? The `find_most_complex_functions` MCP tool depends on this field.

3. **Source indexing**: CGC optionally stores full function source code (`INDEX_SOURCE=true`). This makes the graph much larger but enables `find_code` search. Should we include it?

4. **Multi-repo**: CGC supports indexing multiple repos into one graph. Should codes2graph support watching multiple repos simultaneously?

5. **Conflict with `cgc index`**: If someone runs `cgc index --force .` while codes2graph is watching, both write to the same Neo4j. CGC deletes and re-creates everything. codes2graph should detect this (e.g., via a Neo4j lock node or timestamp) and re-bootstrap its symbol map.
