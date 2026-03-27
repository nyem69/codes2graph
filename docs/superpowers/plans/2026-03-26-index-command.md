# `index` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `index` command that does a full graph index of a repo, replacing `cgc index --force` with a native codes2graph equivalent that respects `.cgcignore` out of the box.

**Architecture:** New `src/indexer.ts` module with an `Indexer` class that walks the filesystem, filters by extensions + ignore patterns, and feeds files through the existing parse → graph → resolve pipeline in batches. The CLI (`src/index.ts`) gets a new `index` subcommand. The watcher's `processBatch` logic is extracted into a shared function both watcher and indexer use.

**Tech Stack:** Node.js `fs` + `path` for file discovery, existing parser/graph/symbols/resolver modules, no new dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/indexer.ts` | **Create** | `Indexer` class: discover files, batch process, progress reporting |
| `src/pipeline.ts` | **Create** | Shared `processFiles()` function extracted from watcher's `processBatch` |
| `src/watcher.ts` | **Modify** | Replace inline `processBatch` body with call to shared `processFiles()` |
| `src/index.ts` | **Modify** | Add `index` command to CLI |
| `src/types.ts` | **Modify** | Add `IndexOptions` interface |
| `src/indexer.test.ts` | **Create** | Unit tests for file discovery and batch orchestration |
| `src/pipeline.test.ts` | **Create** | Unit tests for the shared pipeline function |

---

### Task 1: Extract shared pipeline from watcher

The watcher's `processBatch` (watcher.ts:130-187) contains the parse → graph → resolve logic that both the watcher and indexer need. Extract it into a standalone function.

**Files:**
- Create: `src/pipeline.ts`
- Modify: `src/watcher.ts`
- Create: `src/pipeline.test.ts`

- [ ] **Step 1: Create `src/pipeline.ts` with the shared function**

```typescript
// src/pipeline.ts
import { existsSync } from 'fs';
import { relative } from 'path';
import type { ParsedFile } from './types.js';
import type { GraphClient } from './graph.js';
import type { Parser } from './parser.js';
import type { SymbolMap } from './symbols.js';
import { resolveCallsForFile, resolveInheritanceForFile } from './resolver.js';

export interface PipelineOptions {
  indexSource: boolean;
  skipExternal: boolean;
}

export interface PipelineProgress {
  file: string;
  index: number;
  total: number;
  status: 'updated' | 'deleted' | 'error';
  error?: unknown;
}

/**
 * Process a batch of file paths through the parse → graph → resolve pipeline.
 * Shared by both the watcher (on file change) and the indexer (full scan).
 *
 * @param onProgress Optional callback for each file processed.
 */
export async function processFiles(
  repoPath: string,
  filePaths: string[],
  graph: GraphClient,
  parser: Parser,
  symbolMap: SymbolMap,
  options: PipelineOptions,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<{ parsed: number; deleted: number; errors: number }> {
  // Phase 1: Clean old data
  for (const filePath of filePaths) {
    symbolMap.removeFile(filePath);
    await graph.deleteOutgoingCalls(filePath);
    await graph.deleteFile(filePath);
  }

  // Phase 2: Parse and write to graph
  const parsedFiles: ParsedFile[] = [];
  let deleted = 0;
  let errors = 0;

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];

    if (!existsSync(filePath)) {
      deleted++;
      onProgress?.({ file: filePath, index: i, total: filePaths.length, status: 'deleted' });
      continue;
    }

    try {
      const parsed = parser.parseFile(filePath, options.indexSource);
      symbolMap.addFile(filePath, parsed);
      await graph.addFileToGraph(parsed, repoPath);
      parsedFiles.push(parsed);
      onProgress?.({ file: filePath, index: i, total: filePaths.length, status: 'updated' });
    } catch (err) {
      errors++;
      onProgress?.({ file: filePath, index: i, total: filePaths.length, status: 'error', error: err });
    }
  }

  // Phase 3: Resolve cross-file relationships
  for (const parsed of parsedFiles) {
    const calls = resolveCallsForFile(parsed, symbolMap, options.skipExternal);
    for (const call of calls) {
      if (call.caller_name === '') {
        await graph.createFileLevelCallRelationship(
          call.caller_file_path, call.called_name, call.called_file_path,
          call.line_number, call.args, call.full_call_name,
        );
      } else {
        await graph.createCallRelationship(
          call.caller_name, call.caller_file_path, call.caller_line_number,
          call.called_name, call.called_file_path,
          call.line_number, call.args, call.full_call_name,
        );
      }
    }

    const inheritance = resolveInheritanceForFile(parsed, symbolMap);
    for (const inh of inheritance) {
      await graph.createInheritsRelationship(
        inh.child_name, inh.child_file_path, inh.parent_name, inh.parent_file_path,
      );
    }

    await graph.cleanStaleCallsTo(parsed.path);
  }

  return { parsed: parsedFiles.length, deleted, errors };
}
```

- [ ] **Step 2: Write unit test for pipeline**

```typescript
// src/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processFiles, type PipelineProgress } from './pipeline.js';

describe('processFiles', () => {
  it('calls onProgress for each file with correct index and total', async () => {
    const mockGraph = {
      deleteOutgoingCalls: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      addFileToGraph: vi.fn().mockResolvedValue(undefined),
      createCallRelationship: vi.fn().mockResolvedValue(undefined),
      createFileLevelCallRelationship: vi.fn().mockResolvedValue(undefined),
      createInheritsRelationship: vi.fn().mockResolvedValue(undefined),
      cleanStaleCallsTo: vi.fn().mockResolvedValue(undefined),
    };

    const mockParser = {
      parseFile: vi.fn().mockReturnValue({
        path: '/repo/src/a.ts',
        lang: 'typescript',
        functions: [],
        classes: [],
        variables: [],
        imports: [],
        function_calls: [],
        is_dependency: false,
      }),
    };

    const mockSymbolMap = {
      removeFile: vi.fn(),
      addFile: vi.fn(),
    };

    const progress: PipelineProgress[] = [];

    // processFiles expects real file paths that exist on disk.
    // Since /repo/src/a.ts doesn't exist, it will be treated as deleted.
    const result = await processFiles(
      '/repo',
      ['/repo/src/a.ts'],
      mockGraph as any,
      mockParser as any,
      mockSymbolMap as any,
      { indexSource: false, skipExternal: false },
      (p) => progress.push(p),
    );

    expect(result.deleted).toBe(1);
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe('deleted');
    expect(progress[0].index).toBe(0);
    expect(progress[0].total).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test -- --reporter verbose src/pipeline.test.ts`
Expected: PASS

- [ ] **Step 4: Update watcher to use shared pipeline**

In `src/watcher.ts`, replace the `processBatch` body with a call to `processFiles`:

```typescript
// At the top of watcher.ts, add import:
import { processFiles } from './pipeline.js';

// Replace the processBatch method body (lines 130-187):
private async processBatch(repoPath: string, batch: Set<string>): Promise<void> {
  const startTime = Date.now();
  console.log(`Processing batch of ${batch.size} file(s)...`);

  const result = await processFiles(
    repoPath,
    Array.from(batch),
    this.graph,
    this.parser,
    this.symbolMap,
    { indexSource: this.options.indexSource, skipExternal: this.options.skipExternal },
    ({ file, status, error }) => {
      const rel = relative(repoPath, file);
      if (status === 'deleted') console.log(`  Deleted: ${rel}`);
      else if (status === 'error') console.error(`  Error parsing ${rel}:`, error);
      else console.log(`  Updated: ${rel}`);
    },
  );

  const elapsed = Date.now() - startTime;
  console.log(`Batch complete in ${elapsed}ms (${result.parsed} parsed, ${result.deleted} deleted, ${result.errors} errors)`);
}
```

Also add the missing import at the top:
```typescript
import { relative } from 'path';
```

Wait -- `relative` is already imported on line 3. Just add the `processFiles` import.

- [ ] **Step 5: Run all existing tests to verify no regressions**

Run: `npm test -- --reporter verbose`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.ts src/pipeline.test.ts src/watcher.ts
git commit -m "refactor: extract shared processFiles pipeline from watcher"
```

---

### Task 2: Create the Indexer class

The indexer walks the filesystem, discovers eligible files, and feeds them through the pipeline in batches with progress reporting.

**Files:**
- Create: `src/indexer.ts`
- Modify: `src/types.ts`
- Create: `src/indexer.test.ts`

- [ ] **Step 1: Add `IndexOptions` to types**

In `src/types.ts`, add after the `WatchOptions` interface:

```typescript
export interface IndexOptions {
  extensions: string[];   // file extensions to index
  indexSource: boolean;    // store full source code in graph
  skipExternal: boolean;  // skip unresolved external calls
  batchSize: number;      // files per batch (default: 50)
  force: boolean;         // wipe existing graph for this repo first
}
```

- [ ] **Step 2: Create `src/indexer.ts`**

```typescript
// src/indexer.ts
import { resolve, relative, extname } from 'path';
import { readdirSync, statSync } from 'fs';
import type { IndexOptions } from './types.js';
import type { GraphClient } from './graph.js';
import type { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { loadIgnorePatterns, isIgnored } from './ignore.js';
import { processFiles } from './pipeline.js';

export class Indexer {
  constructor(
    private graph: GraphClient,
    private parser: Parser,
    private options: IndexOptions,
  ) {}

  /**
   * Walk directory tree and collect all eligible file paths,
   * respecting .cgcignore patterns and extension filter.
   */
  discoverFiles(repoPath: string): string[] {
    const extensions = new Set(this.options.extensions);
    const ignorePatterns = loadIgnorePatterns(repoPath);
    const files: string[] = [];

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return; // permission denied, etc.
      }

      for (const entry of entries) {
        const fullPath = resolve(dir, entry);
        const rel = relative(repoPath, fullPath);

        if (isIgnored(rel, ignorePatterns)) continue;

        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && extensions.has(extname(fullPath))) {
          files.push(fullPath);
        }
      }
    };

    walk(repoPath);
    return files.sort();
  }

  /**
   * Delete all existing graph data for this repo.
   */
  async wipeRepo(repoPath: string): Promise<void> {
    console.log('Wiping existing graph data...');
    await this.graph.runCypher(
      `MATCH (f:File) WHERE f.path STARTS WITH $repoPath
       OPTIONAL MATCH (f)-[:CONTAINS]->(child)
       DETACH DELETE child, f`,
      { repoPath },
    );
    await this.graph.runCypher(
      `MATCH (d:Directory) WHERE d.path STARTS WITH $repoPath
       DETACH DELETE d`,
      { repoPath },
    );
    console.log('Wipe complete.');
  }

  /**
   * Index the entire repo: discover files, process in batches, report progress.
   */
  async run(repoPath: string): Promise<void> {
    const absRepoPath = resolve(repoPath);

    if (this.options.force) {
      await this.wipeRepo(absRepoPath);
    }

    console.log('Discovering files...');
    const files = this.discoverFiles(absRepoPath);
    console.log(`Found ${files.length} files to index.`);

    if (files.length === 0) return;

    const symbolMap = new SymbolMap();

    // If not force, bootstrap symbol map from existing graph data
    if (!this.options.force) {
      const existingSymbols = await this.graph.getAllSymbols();
      symbolMap.bootstrapFromMap(existingSymbols);
    }

    const batchSize = this.options.batchSize;
    let totalParsed = 0;
    let totalErrors = 0;
    const startTime = Date.now();

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(files.length / batchSize);

      process.stdout.write(`\rBatch ${batchNum}/${totalBatches} — ${i + batch.length}/${files.length} files`);

      const result = await processFiles(
        absRepoPath,
        batch,
        this.graph,
        this.parser,
        symbolMap,
        { indexSource: this.options.indexSource, skipExternal: this.options.skipExternal },
      );

      totalParsed += result.parsed;
      totalErrors += result.errors;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nIndex complete: ${totalParsed} files indexed, ${totalErrors} errors, ${elapsed}s`);
  }
}
```

- [ ] **Step 3: Write unit tests for file discovery**

```typescript
// src/indexer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { Indexer } from './indexer.js';

const TEST_DIR = resolve(tmpdir(), 'codes2graph-indexer-test-' + Date.now());

describe('Indexer.discoverFiles', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DIR, 'src', 'lib'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'dist'), { recursive: true });

    writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(TEST_DIR, 'src', 'lib', 'utils.ts'), 'export function add() {}');
    writeFileSync(join(TEST_DIR, 'src', 'styles.css'), 'body {}');
    writeFileSync(join(TEST_DIR, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
    writeFileSync(join(TEST_DIR, 'dist', 'bundle.js'), 'var x = 1;');
    writeFileSync(join(TEST_DIR, 'README.md'), '# Test');
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('finds .ts and .js files, ignores node_modules and dist', () => {
    const indexer = new Indexer(null as any, null as any, {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      indexSource: false,
      skipExternal: false,
      batchSize: 50,
      force: false,
    });

    const files = indexer.discoverFiles(TEST_DIR);
    const relative = files.map(f => f.replace(TEST_DIR + '/', ''));

    expect(relative).toContain('src/index.ts');
    expect(relative).toContain('src/lib/utils.ts');
    expect(relative).not.toContain('src/styles.css');
    expect(relative).not.toContain('node_modules/pkg/index.js');
    expect(relative).not.toContain('dist/bundle.js');
    expect(relative).not.toContain('README.md');
  });

  it('returns sorted file paths', () => {
    const indexer = new Indexer(null as any, null as any, {
      extensions: ['.ts'],
      indexSource: false,
      skipExternal: false,
      batchSize: 50,
      force: false,
    });

    const files = indexer.discoverFiles(TEST_DIR);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --reporter verbose src/indexer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer.ts src/indexer.test.ts src/types.ts
git commit -m "feat: add Indexer class with file discovery and batch processing"
```

---

### Task 3: Wire up the CLI

Add the `index` command to `src/index.ts` and update the help text.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `printUsage` and `main`**

In `src/index.ts`:

1. Add import for `Indexer`:
```typescript
import { Indexer } from './indexer.js';
```

2. Update `printUsage`:
```typescript
function printUsage() {
  console.log('Usage: codes2graph <command> <path> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  index <path>        Full index of a repo into Neo4j');
  console.log('  watch <path>        Watch repo for changes and update graph');
  console.log('  clean <path>        Remove ignored files from Neo4j graph');
  console.log('');
  console.log('Index options:');
  console.log('  --force             Wipe existing graph data for this repo first');
  console.log('  --batch-size <n>    Files per batch (default: 50)');
  console.log('  --index-source      Store full source code in graph');
  console.log('  --skip-external     Skip unresolved external calls');
  console.log('');
  console.log('Watch options:');
  console.log('  --debounce <ms>     Quiet period before processing (default: 5000)');
  console.log('  --max-wait <ms>     Max wait before forced processing (default: 30000)');
  console.log('  --index-source      Store full source code in graph');
  console.log('  --skip-external     Skip unresolved external calls');
  console.log('');
  console.log('Clean options:');
  console.log('  --dry-run           Show what would be deleted without deleting');
}
```

3. Add the `index` function:
```typescript
async function index(repoPath: string, args: string[]) {
  const config = loadConfig();
  const batchSize = parseInt(args[args.indexOf('--batch-size') + 1] || '50', 10);

  console.log('codes2graph — full index');
  console.log(`Repository: ${repoPath}`);
  console.log(`Neo4j: ${config.neo4jUri}`);

  const graph = new GraphClient(config);
  await graph.connect();
  await graph.ensureSchema();
  await graph.createRepository(repoPath, basename(repoPath));

  const parser = new Parser();
  await parser.init();

  const indexer = new Indexer(graph, parser, {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    indexSource: args.includes('--index-source') || config.indexSource,
    skipExternal: args.includes('--skip-external') || config.skipExternal,
    batchSize,
    force: args.includes('--force'),
  });

  try {
    await indexer.run(repoPath);
  } finally {
    await graph.close();
  }
}
```

4. Update `main` to handle the new command:
```typescript
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['index', 'watch', 'clean'].includes(command) || args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const repoPath = resolve(args[1]);

  if (command === 'index') {
    await index(repoPath, args);
  } else if (command === 'clean') {
    await cleanIgnored(repoPath, args.includes('--dry-run'));
  } else {
    await watch(repoPath, args);
  }
}
```

- [ ] **Step 2: Smoke test the CLI help**

Run: `npx tsx src/index.ts`
Expected: Usage text showing all three commands (index, watch, clean)

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up index command in CLI"
```

---

### Task 4: Update README

Update the README to reflect that `cgc index` is no longer needed.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Step 2 in README**

Replace the "Step 2: Index a new project" section:

```markdown
## Step 2: Index a new project

Run from anywhere — point it at your project:

\`\`\`bash
npx tsx /path/to/codes2graph/src/index.ts index /path/to/your-project
\`\`\`

This scans all `.ts`/`.js` files (respecting `.cgcignore`), parses them with tree-sitter, and writes the full graph to Neo4j. Progress is reported as it runs.

To re-index from scratch (wipes existing graph data for this repo):

\`\`\`bash
npx tsx /path/to/codes2graph/src/index.ts index /path/to/your-project --force
\`\`\`
```

- [ ] **Step 2: Update Step 3 in README**

The `clean` step is no longer needed after indexing (codes2graph respects `.cgcignore`). Update it to say clean is only needed after `cgc index`:

```markdown
## Step 3: Clean ignored files (only after `cgc index`)

If you used `cgc index` instead of codes2graph's `index` command, you need to clean ignored files. `cgc index` does not respect `.cgcignore`. Skip this step if you used codes2graph to index.

\`\`\`bash
npx tsx /path/to/codes2graph/src/index.ts clean /path/to/your-project --dry-run
npx tsx /path/to/codes2graph/src/index.ts clean /path/to/your-project
\`\`\`
```

- [ ] **Step 3: Update the "Adding a New Project" cheatsheet**

```markdown
## Adding a New Project (cheatsheet)

\`\`\`bash
npx tsx /path/to/codes2graph/src/index.ts index /path/to/new-project
npx tsx /path/to/codes2graph/src/index.ts watch /path/to/new-project
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for built-in index command"
```

---

### Task 5: End-to-end test with real Neo4j

Manual verification that the full pipeline works against a real Neo4j instance. This is not automated — it requires a running Neo4j.

- [ ] **Step 1: Index the codes2graph repo itself**

Run: `npx tsx src/index.ts index /Users/azmi/PROJECTS/LLM/codes2graph --force`
Expected output:
```
codes2graph — full index
Repository: /Users/azmi/PROJECTS/LLM/codes2graph
Neo4j: bolt://localhost:7687
Wiping existing graph data...
Wipe complete.
Discovering files...
Found NN files to index.
Batch 1/1 — NN/NN files
Index complete: NN files indexed, 0 errors, X.Xs
```

- [ ] **Step 2: Verify graph in Neo4j Browser**

Open http://localhost:7474 and run:
```cypher
MATCH (r:Repository {name: 'codes2graph'})-[:CONTAINS*]->(f:File) RETURN count(f)
```
Expected: File count matching the number reported by the indexer.

- [ ] **Step 3: Verify functions are indexed**

```cypher
MATCH (f:Function) WHERE f.path STARTS WITH '/Users/azmi/PROJECTS/LLM/codes2graph'
RETURN f.name, f.path LIMIT 20
```
Expected: Functions like `loadConfig`, `processFiles`, `discoverFiles`, etc.

- [ ] **Step 4: Verify CALLS relationships exist**

```cypher
MATCH (a)-[r:CALLS]->(b) WHERE a.path STARTS WITH '/Users/azmi/PROJECTS/LLM/codes2graph'
RETURN a.name, b.name LIMIT 20
```
Expected: Call relationships between functions.
