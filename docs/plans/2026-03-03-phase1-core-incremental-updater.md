# Phase 1: Core Incremental Updater — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the core incremental file watcher that parses TS/JS files with tree-sitter and writes CGC-compatible nodes/relationships to Neo4j, replacing CGC's broken `cgc watch`.

**Architecture:** File watcher (chokidar) detects changes, debounces them into batches, parses each changed file with tree-sitter, deletes old graph data for that file, writes new nodes/relationships to Neo4j, and resolves cross-file CALLS/INHERITS using an incremental in-memory symbol map. All output must be schema-identical to CGC's `cgc index` so existing CGC MCP tools work unchanged.

**Tech Stack:** Node.js + TypeScript, web-tree-sitter (WASM), neo4j-driver 6.x, chokidar 4.x, picomatch, dotenv, vitest (testing), tsx (dev runner)

**Reference:** CGC source at `/Users/azmi/PROJECTS/LLM/CodeGraphContext/src/codegraphcontext/` — see `tools/languages/typescript.py`, `tools/languages/javascript.py`, and `tools/graph_builder.py` for exact queries and schema.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/types.ts`

**Step 1: Create package.json**

```json
{
  "name": "codes2graph",
  "version": "0.1.0",
  "description": "Incremental file watcher for CGC-compatible Neo4j code graphs",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "codes2graph": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "chokidar": "^4.0.3",
    "dotenv": "^16.4.7",
    "neo4j-driver": "^5.27.0",
    "picomatch": "^4.0.2",
    "web-tree-sitter": "^0.24.7"
  },
  "devDependencies": {
    "@types/node": "^22.13.5",
    "@types/picomatch": "^3.0.1",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.7"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Step 3: Create .env.example**

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
INDEX_SOURCE=false
SKIP_EXTERNAL_RESOLUTION=false
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
.env
*.wasm
```

**Step 5: Create src/types.ts**

This file defines all shared interfaces. These match CGC's Python data structures exactly (see `graph_builder.py:272` `add_file_to_graph` and `typescript.py:159` return format).

```typescript
// --- Parser output types (match CGC's Python dicts) ---

export interface ParsedFunction {
  name: string;
  line_number: number;
  end_line: number;
  args: string[];
  cyclomatic_complexity: number;
  source?: string;
  docstring?: string;
  decorators: string[];
  context: string | null;        // parent function/class name
  context_type: string | null;   // 'function_declaration' | 'class_declaration' | etc
  class_context: string | null;  // enclosing class name (if method)
  lang: string;
  is_dependency: boolean;
}

export interface ParsedClass {
  name: string;
  line_number: number;
  end_line: number;
  bases: string[];
  source?: string;
  docstring?: string;
  decorators: string[];
  context: string | null;
  lang: string;
  is_dependency: boolean;
}

export interface ParsedVariable {
  name: string;
  line_number: number;
  value: string | null;
  type: string | null;
  context: string | null;
  class_context: string | null;
  lang: string;
  is_dependency: boolean;
}

export interface ParsedImport {
  name: string;       // imported symbol name ('default', '*', or named)
  source: string;     // module path/name
  alias: string | null;
  line_number: number;
  lang: string;
}

export interface ParsedCall {
  name: string;       // called function/method name
  full_name: string;  // full call expression text (e.g. 'this.method()')
  line_number: number;
  args: string[];
  inferred_obj_type: string | null;
  context: [string, string, number] | [null, null, null]; // [caller_name, caller_type, caller_line]
  class_context: [string, string] | [null, null];         // [class_name, class_type]
  lang: string;
  is_dependency: boolean;
}

export interface ParsedInterface {
  name: string;
  line_number: number;
  end_line: number;
  source?: string;
}

export interface ParsedTypeAlias {
  name: string;
  line_number: number;
  end_line: number;
  source?: string;
}

export interface ParsedFile {
  path: string;
  lang: string;
  functions: ParsedFunction[];
  classes: ParsedClass[];
  variables: ParsedVariable[];
  imports: ParsedImport[];
  function_calls: ParsedCall[];
  interfaces?: ParsedInterface[];    // TS only
  type_aliases?: ParsedTypeAlias[];  // TS only
  is_dependency: boolean;
}

// --- Graph client types ---

export interface ResolvedCall {
  caller_name: string;
  caller_file_path: string;
  caller_line_number: number;
  called_name: string;
  called_file_path: string;
  line_number: number;
  args: string[];
  full_call_name: string;
}

export interface ResolvedInheritance {
  child_name: string;
  child_file_path: string;
  parent_name: string;
  parent_file_path: string;
}

// --- Watcher types ---

export interface WatchOptions {
  debounceQuiet: number;  // ms of quiet before processing (default: 5000)
  debounceMax: number;    // max ms before forced processing (default: 30000)
  extensions: string[];   // file extensions to watch
  indexSource: boolean;    // store full source code in graph
  skipExternal: boolean;  // skip unresolved external calls
}
```

**Step 6: Install dependencies**

Run: `npm install`

**Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add package.json tsconfig.json .env.example .gitignore src/types.ts
git commit -m "feat: project scaffolding with types matching CGC schema"
```

---

## Task 2: Config Module

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Step 1: Write the failing test**

```typescript
// src/config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, type Config } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when no env vars set', () => {
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    const config = loadConfig();
    expect(config.neo4jUri).toBe('bolt://localhost:7687');
    expect(config.neo4jUsername).toBe('neo4j');
    expect(config.neo4jPassword).toBe('password');
    expect(config.indexSource).toBe(false);
    expect(config.skipExternal).toBe(false);
  });

  it('reads from environment variables', () => {
    process.env.NEO4J_URI = 'bolt://custom:7688';
    process.env.NEO4J_USERNAME = 'admin';
    process.env.NEO4J_PASSWORD = 'secret';
    process.env.INDEX_SOURCE = 'true';
    process.env.SKIP_EXTERNAL_RESOLUTION = 'true';
    const config = loadConfig();
    expect(config.neo4jUri).toBe('bolt://custom:7688');
    expect(config.neo4jUsername).toBe('admin');
    expect(config.neo4jPassword).toBe('secret');
    expect(config.indexSource).toBe(true);
    expect(config.skipExternal).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — module `./config.js` not found

**Step 3: Write minimal implementation**

```typescript
// src/config.ts
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

export interface Config {
  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
  indexSource: boolean;
  skipExternal: boolean;
}

export function loadConfig(): Config {
  // Load from ~/.codegraphcontext/.env (CGC's config location)
  const cgcEnvPath = resolve(process.env.HOME || '~', '.codegraphcontext', '.env');
  if (existsSync(cgcEnvPath)) {
    dotenvConfig({ path: cgcEnvPath });
  }

  // Also load local .env (higher priority — dotenv won't overwrite existing)
  dotenvConfig();

  return {
    neo4jUri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4jUsername: process.env.NEO4J_USERNAME || 'neo4j',
    neo4jPassword: process.env.NEO4J_PASSWORD || 'password',
    indexSource: (process.env.INDEX_SOURCE || 'false').toLowerCase() === 'true',
    skipExternal: (process.env.SKIP_EXTERNAL_RESOLUTION || 'false').toLowerCase() === 'true',
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: config module loading from .env and CGC config"
```

---

## Task 3: Ignore Patterns (`ignore.ts`)

**Files:**
- Create: `src/ignore.ts`
- Test: `src/ignore.test.ts`

**Step 1: Write the failing test**

```typescript
// src/ignore.test.ts
import { describe, it, expect } from 'vitest';
import { loadIgnorePatterns, isIgnored } from './ignore.js';

describe('ignore patterns', () => {
  it('returns default patterns when no .cgcignore exists', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(patterns).toContain('node_modules/**');
    expect(patterns).toContain('.git/**');
  });

  it('matches node_modules paths', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('node_modules/foo/bar.ts', patterns)).toBe(true);
    expect(isIgnored('src/index.ts', patterns)).toBe(false);
  });

  it('matches .svelte-kit paths', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('.svelte-kit/output/server.js', patterns)).toBe(true);
  });

  it('matches minified files', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('vendor/lib.min.js', patterns)).toBe(true);
    expect(isIgnored('src/lib.js', patterns)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/ignore.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/ignore.ts
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import picomatch from 'picomatch';

const DEFAULT_PATTERNS = [
  'node_modules/**',
  '.svelte-kit/**',
  'coverage/**',
  'dist/**',
  'build/**',
  '.git/**',
  '**/*.min.js',
  '**/*.map',
];

/**
 * Load ignore patterns from .cgcignore, walking up from startPath.
 * Falls back to defaults if no .cgcignore found.
 */
export function loadIgnorePatterns(startPath: string): string[] {
  let dir = resolve(startPath);

  while (true) {
    const candidate = resolve(dir, '.cgcignore');
    if (existsSync(candidate)) {
      const lines = readFileSync(candidate, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      // Normalize: ensure directory patterns use glob suffix
      return lines.map(p => {
        if (p.endsWith('/')) return p + '**';
        return p;
      });
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return DEFAULT_PATTERNS;
}

/**
 * Check if a relative path matches any ignore pattern.
 */
export function isIgnored(relativePath: string, patterns: string[]): boolean {
  return picomatch.isMatch(relativePath, patterns, { dot: true });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/ignore.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ignore.ts src/ignore.test.ts
git commit -m "feat: .cgcignore pattern loading with picomatch matching"
```

---

## Task 4: Neo4j Graph Client (`graph.ts`)

This is the largest task. It implements all CRUD operations against Neo4j, matching CGC's exact Cypher queries from `graph_builder.py`.

**Files:**
- Create: `src/graph.ts`
- Test: `src/graph.test.ts`

### Subtask 4a: Connection and Schema

**Step 1: Write the failing test**

```typescript
// src/graph.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphClient } from './graph.js';
import { loadConfig } from './config.js';

// These tests require a running Neo4j instance
// Skip if NEO4J_URI is not set
const config = loadConfig();

describe('GraphClient', () => {
  let graph: GraphClient;

  beforeAll(async () => {
    graph = new GraphClient(config);
    await graph.connect();
    // Clean test data
    await graph.runCypher('MATCH (n) WHERE n.path STARTS WITH "/test/" DETACH DELETE n');
  });

  afterAll(async () => {
    await graph.runCypher('MATCH (n) WHERE n.path STARTS WITH "/test/" DETACH DELETE n');
    await graph.close();
  });

  it('connects and creates schema', async () => {
    await graph.ensureSchema();
    // Verify a constraint exists (won't throw if already created)
    const result = await graph.runCypher('SHOW CONSTRAINTS');
    expect(result.length).toBeGreaterThan(0);
  });

  it('creates and deletes a repository node', async () => {
    await graph.createRepository('/test/repo', 'repo');
    const result = await graph.runCypher(
      'MATCH (r:Repository {path: $path}) RETURN r.name as name',
      { path: '/test/repo' }
    );
    expect(result[0].name).toBe('repo');
  });

  it('creates a file with directory hierarchy', async () => {
    await graph.createRepository('/test/repo', 'repo');
    await graph.createFileNode('/test/repo/src/utils/helpers.ts', '/test/repo', 'src/utils/helpers.ts');

    // Verify directory chain: repo -> src -> utils -> file
    const dirs = await graph.runCypher(`
      MATCH (r:Repository {path: '/test/repo'})-[:CONTAINS]->(d1:Directory)-[:CONTAINS]->(d2:Directory)-[:CONTAINS]->(f:File)
      RETURN d1.name as d1, d2.name as d2, f.name as fname
    `);
    expect(dirs[0].d1).toBe('src');
    expect(dirs[0].d2).toBe('utils');
    expect(dirs[0].fname).toBe('helpers.ts');
  });

  it('deletes a file and cleans up empty directories', async () => {
    await graph.createRepository('/test/repo2', 'repo2');
    await graph.createFileNode('/test/repo2/src/delete-me.ts', '/test/repo2', 'src/delete-me.ts');
    await graph.deleteFile('/test/repo2/src/delete-me.ts');

    const files = await graph.runCypher(
      "MATCH (f:File {path: '/test/repo2/src/delete-me.ts'}) RETURN f"
    );
    expect(files.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/graph.test.ts`
Expected: FAIL — module not found

**Step 3: Write the graph client implementation**

```typescript
// src/graph.ts
import neo4j, { type Driver, type Session, type Record as Neo4jRecord } from 'neo4j-driver';
import type { Config } from './config.js';
import type { ParsedFile, ParsedFunction, ParsedImport } from './types.js';
import { resolve, relative, dirname, basename } from 'path';

export class GraphClient {
  private driver: Driver | null = null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.driver = neo4j.driver(
      this.config.neo4jUri,
      neo4j.auth.basic(this.config.neo4jUsername, this.config.neo4jPassword),
      { disableLosslessIntegers: true }
    );
    await this.driver.verifyConnectivity();
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  private getSession(): Session {
    if (!this.driver) throw new Error('Not connected. Call connect() first.');
    return this.driver.session();
  }

  /** Run raw Cypher — for tests and one-off queries. */
  async runCypher(query: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const session = this.getSession();
    try {
      const result = await session.run(query, params);
      return result.records.map(r => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  // ─── Schema ──────────────────────────────────────────

  /**
   * Create constraints and indexes matching CGC's schema.
   * See CGC graph_builder.py:127 create_schema()
   */
  async ensureSchema(): Promise<void> {
    const session = this.getSession();
    try {
      const constraints = [
        'CREATE CONSTRAINT repository_path IF NOT EXISTS FOR (r:Repository) REQUIRE r.path IS UNIQUE',
        'CREATE CONSTRAINT path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE',
        'CREATE CONSTRAINT directory_path IF NOT EXISTS FOR (d:Directory) REQUIRE d.path IS UNIQUE',
        'CREATE CONSTRAINT function_unique IF NOT EXISTS FOR (f:Function) REQUIRE (f.name, f.path, f.line_number) IS UNIQUE',
        'CREATE CONSTRAINT class_unique IF NOT EXISTS FOR (c:Class) REQUIRE (c.name, c.path, c.line_number) IS UNIQUE',
        'CREATE CONSTRAINT interface_unique IF NOT EXISTS FOR (i:Interface) REQUIRE (i.name, i.path, i.line_number) IS UNIQUE',
        'CREATE CONSTRAINT variable_unique IF NOT EXISTS FOR (v:Variable) REQUIRE (v.name, v.path, v.line_number) IS UNIQUE',
        'CREATE CONSTRAINT module_name IF NOT EXISTS FOR (m:Module) REQUIRE m.name IS UNIQUE',
      ];
      const indexes = [
        'CREATE INDEX function_lang IF NOT EXISTS FOR (f:Function) ON (f.lang)',
        'CREATE INDEX class_lang IF NOT EXISTS FOR (c:Class) ON (c.lang)',
        `CREATE FULLTEXT INDEX code_search_index IF NOT EXISTS
         FOR (n:Function|Class|Variable)
         ON EACH [n.name, n.source, n.docstring]`,
      ];
      for (const q of [...constraints, ...indexes]) {
        try {
          await session.run(q);
        } catch {
          // Index/constraint may already exist in different form
        }
      }
    } finally {
      await session.close();
    }
  }

  // ─── Repository ──────────────────────────────────────

  /** CGC graph_builder.py:256 add_repository_to_graph */
  async createRepository(repoPath: string, repoName: string): Promise<void> {
    await this.runCypher(
      `MERGE (r:Repository {path: $path})
       SET r.name = $name, r.is_dependency = false`,
      { path: repoPath, name: repoName }
    );
  }

  // ─── File + Directory Hierarchy ──────────────────────

  /**
   * Create File node and CONTAINS chain from Repository through Directories.
   * CGC graph_builder.py:287-323
   */
  async createFileNode(filePath: string, repoPath: string, relativePath: string): Promise<void> {
    const fileName = basename(filePath);
    const session = this.getSession();
    try {
      // Create File node
      await session.run(
        `MERGE (f:File {path: $path})
         SET f.name = $name, f.relative_path = $relative_path, f.is_dependency = false`,
        { path: filePath, name: fileName, relative_path: relativePath }
      );

      // Build directory chain
      const parts = relativePath.split('/').slice(0, -1); // directories only
      let parentPath = repoPath;
      let parentLabel = 'Repository';

      for (const part of parts) {
        const currentPath = parentPath + '/' + part;
        await session.run(
          `MATCH (p:${parentLabel} {path: $parent_path})
           MERGE (d:Directory {path: $current_path})
           SET d.name = $part
           MERGE (p)-[:CONTAINS]->(d)`,
          { parent_path: parentPath, current_path: currentPath, part }
        );
        parentPath = currentPath;
        parentLabel = 'Directory';
      }

      // Link final parent to file
      await session.run(
        `MATCH (p:${parentLabel} {path: $parent_path})
         MATCH (f:File {path: $path})
         MERGE (p)-[:CONTAINS]->(f)`,
        { parent_path: parentPath, path: filePath }
      );
    } finally {
      await session.close();
    }
  }

  // ─── Add Parsed File Contents ────────────────────────

  /**
   * Write all nodes and relationships for a parsed file.
   * CGC graph_builder.py:272 add_file_to_graph
   */
  async addFileToGraph(fileData: ParsedFile, repoPath: string): Promise<void> {
    const filePath = resolve(fileData.path);
    const relPath = relative(repoPath, filePath);

    await this.createFileNode(filePath, repoPath, relPath);

    const session = this.getSession();
    try {
      // Functions, Classes, Variables, Interfaces — CGC graph_builder.py:330-356
      const itemMappings: [unknown[], string][] = [
        [fileData.functions, 'Function'],
        [fileData.classes, 'Class'],
        [fileData.variables, 'Variable'],
        [fileData.interfaces || [], 'Interface'],
      ];

      for (const [items, label] of itemMappings) {
        for (const item of items as Record<string, unknown>[]) {
          // Default cyclomatic_complexity for functions (CGC graph_builder.py:346-347)
          if (label === 'Function' && !('cyclomatic_complexity' in item)) {
            item.cyclomatic_complexity = 1;
          }

          await session.run(
            `MATCH (f:File {path: $path})
             MERGE (n:${label} {name: $name, path: $path, line_number: $line_number})
             SET n += $props
             MERGE (f)-[:CONTAINS]->(n)`,
            {
              path: filePath,
              name: item.name,
              line_number: item.line_number,
              props: item,
            }
          );

          // Parameters for functions — CGC graph_builder.py:358-364
          if (label === 'Function') {
            const fn = item as unknown as ParsedFunction;
            for (const argName of fn.args) {
              await session.run(
                `MATCH (fn:Function {name: $func_name, path: $path, line_number: $line_number})
                 MERGE (p:Parameter {name: $arg_name, path: $path, function_line_number: $line_number})
                 MERGE (fn)-[:HAS_PARAMETER]->(p)`,
                {
                  func_name: fn.name,
                  path: filePath,
                  line_number: fn.line_number,
                  arg_name: argName,
                }
              );
            }
          }
        }
      }

      // Nested functions — CGC graph_builder.py:374-381
      for (const func of fileData.functions) {
        if (func.context_type === 'function_definition' && func.context) {
          await session.run(
            `MATCH (outer:Function {name: $context, path: $path})
             MATCH (inner:Function {name: $name, path: $path, line_number: $line_number})
             MERGE (outer)-[:CONTAINS]->(inner)`,
            { context: func.context, path: filePath, name: func.name, line_number: func.line_number }
          );
        }
      }

      // Class methods — CGC graph_builder.py:428-439
      for (const func of fileData.functions) {
        if (func.class_context) {
          await session.run(
            `MATCH (c:Class {name: $class_name, path: $path})
             MATCH (fn:Function {name: $func_name, path: $path, line_number: $func_line})
             MERGE (c)-[:CONTAINS]->(fn)`,
            {
              class_name: func.class_context,
              path: filePath,
              func_name: func.name,
              func_line: func.line_number,
            }
          );
        }
      }

      // Imports — CGC graph_builder.py:383-425
      for (const imp of fileData.imports) {
        const moduleName = imp.source;
        if (!moduleName) continue;

        const relProps: Record<string, unknown> = { imported_name: imp.name };
        if (imp.alias) relProps.alias = imp.alias;
        if (imp.line_number) relProps.line_number = imp.line_number;

        await session.run(
          `MATCH (f:File {path: $path})
           MERGE (m:Module {name: $module_name})
           MERGE (f)-[r:IMPORTS]->(m)
           SET r += $props`,
          { path: filePath, module_name: moduleName, props: relProps }
        );
      }
    } finally {
      await session.close();
    }
  }

  // ─── CALLS Relationships ─────────────────────────────

  /**
   * Create a single CALLS relationship.
   * CGC graph_builder.py:577-620 (the two MERGE variants)
   */
  async createCallRelationship(
    callerName: string,
    callerFilePath: string,
    callerLineNumber: number,
    calledName: string,
    calledFilePath: string,
    lineNumber: number,
    args: string[],
    fullCallName: string,
  ): Promise<void> {
    // When caller context is known (function/class caller)
    await this.runCypher(
      `MATCH (caller) WHERE (caller:Function OR caller:Class)
         AND caller.name = $caller_name
         AND caller.path = $caller_file_path
         AND caller.line_number = $caller_line_number
       MATCH (called) WHERE (called:Function OR called:Class)
         AND called.name = $called_name
         AND called.path = $called_file_path
       WITH caller, called
       OPTIONAL MATCH (called)-[:CONTAINS]->(init:Function)
       WHERE called:Class AND init.name IN ["__init__", "constructor"]
       WITH caller, COALESCE(init, called) as final_target
       MERGE (caller)-[:CALLS {line_number: $line_number, args: $args, full_call_name: $full_call_name}]->(final_target)`,
      {
        caller_name: callerName,
        caller_file_path: callerFilePath,
        caller_line_number: callerLineNumber,
        called_name: calledName,
        called_file_path: calledFilePath,
        line_number: lineNumber,
        args,
        full_call_name: fullCallName,
      }
    );
  }

  /**
   * Create CALLS from file-level (no caller context).
   * CGC graph_builder.py:602-620
   */
  async createFileLevelCallRelationship(
    callerFilePath: string,
    calledName: string,
    calledFilePath: string,
    lineNumber: number,
    args: string[],
    fullCallName: string,
  ): Promise<void> {
    await this.runCypher(
      `MATCH (caller:File {path: $caller_file_path})
       MATCH (called) WHERE (called:Function OR called:Class)
         AND called.name = $called_name
         AND called.path = $called_file_path
       WITH caller, called
       OPTIONAL MATCH (called)-[:CONTAINS]->(init:Function)
       WHERE called:Class AND init.name IN ["__init__", "constructor"]
       WITH caller, COALESCE(init, called) as final_target
       MERGE (caller)-[:CALLS {line_number: $line_number, args: $args, full_call_name: $full_call_name}]->(final_target)`,
      {
        caller_file_path: callerFilePath,
        called_name: calledName,
        called_file_path: calledFilePath,
        line_number: lineNumber,
        args,
        full_call_name: fullCallName,
      }
    );
  }

  // ─── INHERITS Relationships ──────────────────────────

  /** CGC graph_builder.py:682-690 */
  async createInheritsRelationship(
    childName: string,
    childFilePath: string,
    parentName: string,
    parentFilePath: string,
  ): Promise<void> {
    await this.runCypher(
      `MATCH (child:Class {name: $child_name, path: $child_path})
       MATCH (parent:Class {name: $parent_name, path: $parent_path})
       MERGE (child)-[:INHERITS]->(parent)`,
      {
        child_name: childName,
        child_path: childFilePath,
        parent_name: parentName,
        parent_path: parentFilePath,
      }
    );
  }

  // ─── Symbol Map Bootstrap ────────────────────────────

  /** Query all Function/Class names and their file paths for symbol map bootstrap. */
  async getAllSymbols(): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const results = await this.runCypher(
      `MATCH (n)
       WHERE (n:Function OR n:Class OR n:Interface)
       RETURN n.name AS name, n.path AS path`
    );
    for (const row of results) {
      const name = row.name as string;
      const path = row.path as string;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name)!.add(path);
    }
    return map;
  }

  // ─── Deletion ────────────────────────────────────────

  /**
   * Delete a file and all its contained elements.
   * CGC graph_builder.py:769-794
   */
  async deleteFile(filePath: string): Promise<void> {
    const session = this.getSession();
    try {
      // Get parent directories (for cleanup)
      const parentsResult = await session.run(
        `MATCH (f:File {path: $path})<-[:CONTAINS*]-(d:Directory)
         RETURN d.path as path ORDER BY d.path DESC`,
        { path: filePath }
      );
      const parentPaths = parentsResult.records.map(r => r.get('path') as string);

      // Delete file and contained elements
      await session.run(
        `MATCH (f:File {path: $path})
         OPTIONAL MATCH (f)-[:CONTAINS]->(element)
         DETACH DELETE f, element`,
        { path: filePath }
      );

      // Clean up empty directories
      for (const dirPath of parentPaths) {
        await session.run(
          `MATCH (d:Directory {path: $path})
           WHERE NOT (d)-[:CONTAINS]->()
           DETACH DELETE d`,
          { path: dirPath }
        );
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Clean stale CALLS pointing to functions that no longer exist in a file.
   * See docs/001-Architecture.md "Stale CALLS Cleanup"
   */
  async cleanStaleCallsTo(filePath: string): Promise<void> {
    await this.runCypher(
      `MATCH (caller)-[r:CALLS]->(callee)
       WHERE callee.path = $path
       AND NOT EXISTS { MATCH (:File {path: $path})-[:CONTAINS]->(callee) }
       DELETE r`,
      { path: filePath }
    );
  }

  /**
   * Delete all outgoing CALLS from functions in a file.
   * Phase 3 optimization — but we do it from the start for correctness.
   */
  async deleteOutgoingCalls(filePath: string): Promise<void> {
    await this.runCypher(
      `MATCH (caller)-[r:CALLS]->(callee)
       WHERE caller.path = $path
       DELETE r`,
      { path: filePath }
    );
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/graph.test.ts`
Expected: PASS (requires running Neo4j instance)

**Step 5: Commit**

```bash
git add src/graph.ts src/graph.test.ts
git commit -m "feat: Neo4j graph client with CGC-compatible CRUD operations"
```

---

## Task 5: Tree-Sitter Parser (`parser.ts`)

Port CGC's TypeScript/JavaScript tree-sitter queries to web-tree-sitter. The queries are copied verbatim from `typescript.py` and `javascript.py`.

**Files:**
- Create: `src/parser.ts`
- Test: `src/parser.test.ts`

**Step 1: Write the failing test**

```typescript
// src/parser.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { Parser } from './parser.js';

describe('Parser', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = new Parser();
    await parser.init();
  });

  describe('TypeScript parsing', () => {
    it('extracts functions', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function greet(name: string): string {
  return "hello " + name;
}

const add = (a: number, b: number) => a + b;
      `);

      expect(result.functions).toHaveLength(2);
      expect(result.functions[0].name).toBe('greet');
      expect(result.functions[0].args).toEqual(['name']);
      expect(result.functions[0].line_number).toBe(2);
      expect(result.functions[1].name).toBe('add');
      expect(result.functions[1].args).toEqual(['a', 'b']);
    });

    it('extracts classes with inheritance', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
class Animal {
  constructor(public name: string) {}
}

class Dog extends Animal {
  bark() { return "woof"; }
}
      `);

      expect(result.classes).toHaveLength(2);
      expect(result.classes[0].name).toBe('Animal');
      expect(result.classes[0].bases).toEqual([]);
      expect(result.classes[1].name).toBe('Dog');
      expect(result.classes[1].bases).toEqual(['Animal']);
    });

    it('extracts imports', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
import { readFile } from 'fs';
import path from 'path';
import * as utils from './utils';
      `);

      expect(result.imports).toHaveLength(3);
      expect(result.imports[0]).toMatchObject({ name: 'readFile', source: 'fs' });
      expect(result.imports[1]).toMatchObject({ name: 'default', source: 'path', alias: 'path' });
      expect(result.imports[2]).toMatchObject({ name: '*', source: './utils', alias: 'utils' });
    });

    it('extracts function calls', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function main() {
  const x = greet("world");
  console.log(x);
}
      `);

      const callNames = result.function_calls.map(c => c.name);
      expect(callNames).toContain('greet');
      expect(callNames).toContain('log');
    });

    it('extracts variables (not function-assigned)', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const PI = 3.14;
const greet = () => "hi";
let count = 0;
      `);

      // greet should NOT be in variables (it's a function)
      const varNames = result.variables.map(v => v.name);
      expect(varNames).toContain('PI');
      expect(varNames).toContain('count');
      expect(varNames).not.toContain('greet');
    });

    it('calculates cyclomatic complexity', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function complex(x: number) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      if (i % 2 === 0) {
        console.log(i);
      }
    }
  } else {
    while (x < 0) {
      x++;
    }
  }
}
      `);

      // Base 1 + if + for + if + while = 5
      const fn = result.functions.find(f => f.name === 'complex');
      expect(fn?.cyclomatic_complexity).toBeGreaterThanOrEqual(4);
    });

    it('extracts interfaces', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
interface User {
  id: string;
  name: string;
}
      `);

      expect(result.interfaces).toHaveLength(1);
      expect(result.interfaces![0].name).toBe('User');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/parser.test.ts`
Expected: FAIL

**Step 3: Write parser implementation**

The parser must use the exact same tree-sitter S-expression queries as CGC's `typescript.py` and `javascript.py`. The implementation follows the same `_find_functions`, `_find_classes`, etc. pattern.

```typescript
// src/parser.ts
import TreeSitter from 'web-tree-sitter';
import { readFileSync } from 'fs';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import type {
  ParsedFile, ParsedFunction, ParsedClass, ParsedVariable,
  ParsedImport, ParsedCall, ParsedInterface, ParsedTypeAlias,
} from './types.js';

// Tree-sitter query strings — copied from CGC typescript.py:6-90 and javascript.py:38-111
const TS_QUERIES = {
  functions: `
    (function_declaration
      name: (identifier) @name
      parameters: (formal_parameters) @params
    ) @function_node

    (variable_declarator
      name: (identifier) @name
      value: (function_expression
        parameters: (formal_parameters) @params
      ) @function_node
    )

    (variable_declarator
      name: (identifier) @name
      value: (arrow_function
        parameters: (formal_parameters) @params
      ) @function_node
    )

    (variable_declarator
      name: (identifier) @name
      value: (arrow_function
        parameter: (identifier) @single_param
      ) @function_node
    )

    (method_definition
      name: (property_identifier) @name
      parameters: (formal_parameters) @params
    ) @function_node

    (assignment_expression
      left: (member_expression
        property: (property_identifier) @name
      )
      right: (function_expression
        parameters: (formal_parameters) @params
      ) @function_node
    )

    (assignment_expression
      left: (member_expression
        property: (property_identifier) @name
      )
      right: (arrow_function
        parameters: (formal_parameters) @params
      ) @function_node
    )
  `,
  classes: `
    (class_declaration) @class
    (abstract_class_declaration) @class
    (class) @class
  `,
  interfaces: `
    (interface_declaration
      name: (type_identifier) @name
    ) @interface_node
  `,
  type_aliases: `
    (type_alias_declaration
      name: (type_identifier) @name
    ) @type_alias_node
  `,
  imports: `
    (import_statement) @import
    (call_expression
      function: (identifier) @require_call (#eq? @require_call "require")
    ) @import
  `,
  calls: `
    (call_expression function: (identifier) @name)
    (call_expression function: (member_expression property: (property_identifier) @name))
    (new_expression constructor: (identifier) @name)
    (new_expression constructor: (member_expression property: (property_identifier) @name))
  `,
  variables: `
    (variable_declarator name: (identifier) @name)
  `,
};

// Complexity node types — CGC typescript.py:126-130
const COMPLEXITY_NODES = new Set([
  'if_statement', 'for_statement', 'while_statement', 'do_statement',
  'switch_statement', 'case_statement', 'conditional_expression',
  'logical_expression', 'binary_expression', 'catch_clause',
]);

type SyntaxNode = TreeSitter.SyntaxNode;

export class Parser {
  private tsParser!: TreeSitter;
  private languages: Map<string, TreeSitter.Language> = new Map();
  private initialized = false;

  async init(): Promise<void> {
    await TreeSitter.init();
    this.tsParser = new TreeSitter();
    this.initialized = true;

    // Load language grammars — locate .wasm files
    // Users must place wasm files in the project root or node_modules
    const wasmDir = resolve(fileURLToPath(import.meta.url), '..', '..');
    for (const [name, files] of [
      ['typescript', ['tree-sitter-typescript.wasm']],
      ['tsx', ['tree-sitter-tsx.wasm']],
      ['javascript', ['tree-sitter-javascript.wasm']],
    ] as const) {
      for (const file of files) {
        try {
          const wasmPath = resolve(wasmDir, file);
          const lang = await TreeSitter.Language.load(wasmPath);
          this.languages.set(name, lang);
        } catch {
          // Try node_modules paths
          try {
            const nmPath = resolve(wasmDir, 'node_modules', 'tree-sitter-wasms', `${file}`);
            const lang = await TreeSitter.Language.load(nmPath);
            this.languages.set(name, lang);
          } catch {
            // Language not available — will skip
          }
        }
      }
    }
  }

  /** Get the language name for a file extension. */
  private getLangName(ext: string): string | null {
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'tsx',
      '.js': 'javascript', '.jsx': 'javascript',
      '.mjs': 'javascript', '.cjs': 'javascript',
    };
    return map[ext] || null;
  }

  /** Parse a file from disk. */
  parseFile(filePath: string, indexSource = false): ParsedFile {
    const absPath = resolve(filePath);
    const ext = extname(absPath);
    const langName = this.getLangName(ext);
    if (!langName) throw new Error(`Unsupported extension: ${ext}`);

    const source = readFileSync(absPath, 'utf-8');
    return this.parseSource(absPath, langName, source, indexSource);
  }

  /** Parse source code string (for testing). */
  parseSource(filePath: string, langName: string, source: string, indexSource = false): ParsedFile {
    if (!this.initialized) throw new Error('Parser not initialized. Call init() first.');

    const language = this.languages.get(langName);
    if (!language) throw new Error(`Language not loaded: ${langName}`);

    this.tsParser.setLanguage(language);
    const tree = this.tsParser.parse(source);
    const root = tree.rootNode;

    const isTs = langName === 'typescript' || langName === 'tsx';

    return {
      path: filePath,
      lang: langName === 'tsx' ? 'typescript' : langName,
      functions: this.findFunctions(root, language, filePath, langName, indexSource),
      classes: this.findClasses(root, language, langName, indexSource),
      variables: this.findVariables(root, language, langName),
      imports: this.findImports(root, language, langName),
      function_calls: this.findCalls(root, language, langName),
      interfaces: isTs ? this.findInterfaces(root, language, indexSource) : undefined,
      type_aliases: isTs ? this.findTypeAliases(root, language, indexSource) : undefined,
      is_dependency: false,
    };
  }

  // ─── Helper methods (match CGC's Python methods) ─────

  private getText(node: SyntaxNode): string {
    return node.text;
  }

  private getParentContext(
    node: SyntaxNode,
    types = ['function_declaration', 'class_declaration', 'method_definition', 'function_expression', 'arrow_function'],
  ): [string | null, string | null, number | null] {
    // CGC typescript.py:107-123
    let curr = node.parent;
    while (curr) {
      if (types.includes(curr.type)) {
        let nameNode = curr.childForFieldName('name');
        if (!nameNode && ['function_expression', 'arrow_function'].includes(curr.type)) {
          if (curr.parent?.type === 'variable_declarator') {
            nameNode = curr.parent.childForFieldName('name');
          } else if (curr.parent?.type === 'assignment_expression') {
            nameNode = curr.parent.childForFieldName('left');
          } else if (curr.parent?.type === 'pair') {
            nameNode = curr.parent.childForFieldName('key');
          }
        }
        return [nameNode ? this.getText(nameNode) : null, curr.type, curr.startPosition.row + 1];
      }
      curr = curr.parent;
    }
    return [null, null, null];
  }

  private calculateComplexity(node: SyntaxNode): number {
    // CGC typescript.py:125-139
    let count = 1;
    const traverse = (n: SyntaxNode) => {
      if (COMPLEXITY_NODES.has(n.type)) count++;
      for (const child of n.children) traverse(child);
    };
    traverse(node);
    return count;
  }

  private findFunctionNode(nameNode: SyntaxNode): SyntaxNode | null {
    // CGC typescript.py:176-186
    let current: SyntaxNode | null = nameNode.parent;
    while (current) {
      if (['function_declaration', 'function', 'arrow_function', 'method_definition', 'function_expression'].includes(current.type)) {
        return current;
      }
      if (['variable_declarator', 'assignment_expression'].includes(current.type)) {
        for (const child of current.children) {
          if (['function', 'arrow_function', 'function_expression'].includes(child.type)) return child;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private findFunctionNodeForParams(paramsNode: SyntaxNode): SyntaxNode | null {
    let current: SyntaxNode | null = paramsNode.parent;
    while (current) {
      if (['function_declaration', 'function', 'arrow_function', 'method_definition', 'function_expression'].includes(current.type)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private extractParameters(paramsNode: SyntaxNode): string[] {
    // CGC typescript.py:258-287
    const params: string[] = [];
    if (paramsNode.type !== 'formal_parameters') return params;

    for (const child of paramsNode.children) {
      if (child.type === 'identifier') {
        params.push(this.getText(child));
      } else if (child.type === 'required_parameter') {
        const pattern = child.childForFieldName('pattern');
        if (pattern) {
          params.push(this.getText(pattern));
        } else {
          for (const sub of child.children) {
            if (['identifier', 'object_pattern', 'array_pattern'].includes(sub.type)) {
              params.push(this.getText(sub));
              break;
            }
          }
        }
      } else if (child.type === 'optional_parameter') {
        const pattern = child.childForFieldName('pattern');
        if (pattern) params.push(this.getText(pattern));
      } else if (child.type === 'assignment_pattern') {
        const left = child.childForFieldName('left');
        if (left?.type === 'identifier') params.push(this.getText(left));
      } else if (child.type === 'rest_pattern') {
        const arg = child.childForFieldName('argument');
        if (arg?.type === 'identifier') params.push(`...${this.getText(arg)}`);
      }
    }
    return params;
  }

  // ─── Finders (match CGC's _find_* methods) ───────────

  private findFunctions(
    root: SyntaxNode, language: TreeSitter.Language,
    filePath: string, langName: string, indexSource: boolean,
  ): ParsedFunction[] {
    // CGC typescript.py:173-256 / javascript.py:195-298
    const query = language.query(TS_QUERIES.functions);
    const matches = query.matches(root);

    type FuncKey = string;
    const buckets = new Map<FuncKey, {
      node: SyntaxNode; name: string | null;
      params: SyntaxNode | null; singleParam: SyntaxNode | null;
    }>();

    const key = (n: SyntaxNode): FuncKey => `${n.startIndex}:${n.endIndex}:${n.type}`;

    const bucket = (node: SyntaxNode) => {
      const k = key(node);
      if (!buckets.has(k)) buckets.set(k, { node, name: null, params: null, singleParam: null });
      return buckets.get(k)!;
    };

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === 'function_node') {
          bucket(capture.node);
        } else if (capture.name === 'name') {
          const fn = this.findFunctionNode(capture.node);
          if (fn) bucket(fn).name = this.getText(capture.node);
        } else if (capture.name === 'params') {
          const fn = this.findFunctionNodeForParams(capture.node);
          if (fn) bucket(fn).params = capture.node;
        } else if (capture.name === 'single_param') {
          const fn = this.findFunctionNodeForParams(capture.node);
          if (fn) bucket(fn).singleParam = capture.node;
        }
      }
    }

    const functions: ParsedFunction[] = [];
    for (const data of buckets.values()) {
      let name = data.name;
      if (!name && data.node.type === 'method_definition') {
        const nm = data.node.childForFieldName('name');
        if (nm) name = this.getText(nm);
      }
      if (!name) continue;

      let args: string[] = [];
      if (data.params) args = this.extractParameters(data.params);
      else if (data.singleParam) args = [this.getText(data.singleParam)];

      const [context, contextType] = this.getParentContext(data.node);
      const classContext = contextType === 'class_declaration' ? context : null;

      const func: ParsedFunction = {
        name,
        line_number: data.node.startPosition.row + 1,
        end_line: data.node.endPosition.row + 1,
        args,
        cyclomatic_complexity: this.calculateComplexity(data.node),
        decorators: [],
        context,
        context_type: contextType,
        class_context: classContext,
        lang: langName === 'tsx' ? 'typescript' : langName,
        is_dependency: false,
      };
      if (indexSource) {
        func.source = this.getText(data.node);
        func.docstring = undefined;
      }
      functions.push(func);
    }

    return functions;
  }

  private findClasses(
    root: SyntaxNode, language: TreeSitter.Language,
    langName: string, indexSource: boolean,
  ): ParsedClass[] {
    // CGC typescript.py:289-326
    const query = language.query(TS_QUERIES.classes);
    const matches = query.matches(root);
    const classes: ParsedClass[] = [];

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name !== 'class') continue;
        const classNode = capture.node;
        const nameNode = classNode.childForFieldName('name');
        if (!nameNode) continue;

        const name = this.getText(nameNode);
        const bases: string[] = [];

        // Extract heritage (extends/implements) — CGC typescript.py:298-310
        const heritage = classNode.children.find(c => c.type === 'class_heritage');
        if (heritage) {
          for (const child of heritage.children) {
            if (child.type === 'extends_clause' || child.type === 'implements_clause') {
              for (const sub of child.children) {
                if (['identifier', 'type_identifier', 'member_expression'].includes(sub.type)) {
                  bases.push(this.getText(sub));
                }
              }
            }
          }
        }

        const cls: ParsedClass = {
          name,
          line_number: classNode.startPosition.row + 1,
          end_line: classNode.endPosition.row + 1,
          bases,
          decorators: [],
          context: null,
          lang: langName === 'tsx' ? 'typescript' : langName,
          is_dependency: false,
        };
        if (indexSource) {
          cls.source = this.getText(classNode);
          cls.docstring = undefined;
        }
        classes.push(cls);
      }
    }
    return classes;
  }

  private findInterfaces(root: SyntaxNode, language: TreeSitter.Language, indexSource: boolean): ParsedInterface[] {
    // CGC typescript.py:328-346
    const query = language.query(TS_QUERIES.interfaces);
    const interfaces: ParsedInterface[] = [];

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'interface_node') continue;
        const nameNode = capture.node.childForFieldName('name');
        if (!nameNode) continue;
        const iface: ParsedInterface = {
          name: this.getText(nameNode),
          line_number: capture.node.startPosition.row + 1,
          end_line: capture.node.endPosition.row + 1,
        };
        if (indexSource) iface.source = this.getText(capture.node);
        interfaces.push(iface);
      }
    }
    return interfaces;
  }

  private findTypeAliases(root: SyntaxNode, language: TreeSitter.Language, indexSource: boolean): ParsedTypeAlias[] {
    // CGC typescript.py:348-366
    const query = language.query(TS_QUERIES.type_aliases);
    const aliases: ParsedTypeAlias[] = [];

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'type_alias_node') continue;
        const nameNode = capture.node.childForFieldName('name');
        if (!nameNode) continue;
        const alias: ParsedTypeAlias = {
          name: this.getText(nameNode),
          line_number: capture.node.startPosition.row + 1,
          end_line: capture.node.endPosition.row + 1,
        };
        if (indexSource) alias.source = this.getText(capture.node);
        aliases.push(alias);
      }
    }
    return aliases;
  }

  private findImports(root: SyntaxNode, language: TreeSitter.Language, langName: string): ParsedImport[] {
    // CGC typescript.py:368-415 / javascript.py:400-458
    const query = language.query(TS_QUERIES.imports);
    const imports: ParsedImport[] = [];

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'import') continue;
        const node = capture.node;
        const lineNumber = node.startPosition.row + 1;
        const lang = langName === 'tsx' ? 'typescript' : langName;

        if (node.type === 'import_statement') {
          const sourceNode = node.childForFieldName('source');
          if (!sourceNode) continue;
          const source = this.getText(sourceNode).replace(/['"]/g, '');

          const importClause = node.childForFieldName('import');
          if (!importClause) {
            imports.push({ name: source, source, alias: null, line_number: lineNumber, lang });
            continue;
          }

          if (importClause.type === 'identifier') {
            // Default import
            imports.push({ name: 'default', source, alias: this.getText(importClause), line_number: lineNumber, lang });
          } else if (importClause.type === 'namespace_import') {
            const aliasNode = importClause.childForFieldName('alias');
            if (aliasNode) {
              imports.push({ name: '*', source, alias: this.getText(aliasNode), line_number: lineNumber, lang });
            }
          } else if (importClause.type === 'named_imports') {
            for (const specifier of importClause.children) {
              if (specifier.type === 'import_specifier') {
                const nameNode = specifier.childForFieldName('name');
                const aliasNode = specifier.childForFieldName('alias');
                if (nameNode) {
                  imports.push({
                    name: this.getText(nameNode),
                    source,
                    alias: aliasNode ? this.getText(aliasNode) : null,
                    line_number: lineNumber,
                    lang,
                  });
                }
              }
            }
          }
        } else if (node.type === 'call_expression') {
          // require() — CGC typescript.py:402-414
          const argsNode = node.childForFieldName('arguments');
          if (!argsNode || argsNode.namedChildCount === 0) continue;
          const sourceNode = argsNode.namedChild(0);
          if (!sourceNode || sourceNode.type !== 'string') continue;
          const source = this.getText(sourceNode).replace(/['"]/g, '');

          let alias: string | null = null;
          if (node.parent?.type === 'variable_declarator') {
            const nameNode = node.parent.childForFieldName('name');
            if (nameNode) alias = this.getText(nameNode);
          }
          imports.push({ name: source, source, alias, line_number: lineNumber, lang });
        }
      }
    }
    return imports;
  }

  private findCalls(root: SyntaxNode, language: TreeSitter.Language, langName: string): ParsedCall[] {
    // CGC typescript.py:417-452 / javascript.py:463-499
    const query = language.query(TS_QUERIES.calls);
    const calls: ParsedCall[] = [];
    const lang = langName === 'tsx' ? 'typescript' : langName;

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'name') continue;
        const node = capture.node;

        // Walk up to call/new expression
        let callNode: SyntaxNode | null = node.parent;
        while (callNode && !['call_expression', 'new_expression', 'program'].includes(callNode.type)) {
          callNode = callNode.parent;
        }

        const name = this.getText(node);

        // Extract args
        const args: string[] = [];
        if (callNode && ['call_expression', 'new_expression'].includes(callNode.type)) {
          const argsNode = callNode.childForFieldName('arguments');
          if (argsNode) {
            for (const arg of argsNode.children) {
              if (!['(', ')', ','].includes(arg.type)) {
                args.push(this.getText(arg));
              }
            }
          }
        }

        const context = this.getParentContext(node);
        const classContext = this.getParentContext(node, ['class_declaration', 'abstract_class_declaration']);

        calls.push({
          name,
          full_name: callNode ? this.getText(callNode) : name,
          line_number: node.startPosition.row + 1,
          args,
          inferred_obj_type: null,
          context,
          class_context: [classContext[0], classContext[1]],
          lang,
          is_dependency: false,
        });
      }
    }
    return calls;
  }

  private findVariables(root: SyntaxNode, language: TreeSitter.Language, langName: string): ParsedVariable[] {
    // CGC typescript.py:454-500 / javascript.py:502-550
    const query = language.query(TS_QUERIES.variables);
    const variables: ParsedVariable[] = [];
    const lang = langName === 'tsx' ? 'typescript' : langName;

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'name') continue;
        const node = capture.node;
        const varNode = node.parent;
        if (!varNode) continue;

        const name = this.getText(node);

        // Skip function-assigned variables — CGC typescript.py:471-477
        const valueNode = varNode.childForFieldName('value');
        if (valueNode) {
          if (['function_expression', 'arrow_function'].includes(valueNode.type)) continue;
          if (valueNode.type.includes('function') || valueNode.type.includes('arrow')) continue;
        }

        let value: string | null = null;
        if (valueNode) {
          if (valueNode.type === 'call_expression') {
            const funcNode = valueNode.childForFieldName('function');
            value = funcNode ? this.getText(funcNode) : name;
          } else {
            value = this.getText(valueNode);
          }
        }

        const [context, contextType] = this.getParentContext(node);
        const classContext = contextType === 'class_declaration' ? context : null;

        variables.push({
          name,
          line_number: node.startPosition.row + 1,
          value,
          type: null,
          context,
          class_context: classContext,
          lang,
          is_dependency: false,
        });
      }
    }
    return variables;
  }

  // ─── Pre-scan for Symbol Map ─────────────────────────

  /**
   * Quick scan: extract just symbol names from a file (for the imports_map).
   * CGC typescript.py:502-577 pre_scan_typescript
   */
  preScanFile(filePath: string, source: string, langName: string): string[] {
    const language = this.languages.get(langName);
    if (!language) return [];

    this.tsParser.setLanguage(language);
    const tree = this.tsParser.parse(source);
    const root = tree.rootNode;

    const names: string[] = [];
    const queries = [
      '(class_declaration) @class',
      '(function_declaration) @function',
      '(variable_declarator) @var_decl',
      '(method_definition) @method',
    ];

    // TypeScript extras
    if (langName === 'typescript' || langName === 'tsx') {
      queries.push('(interface_declaration) @interface');
      queries.push('(type_alias_declaration) @type_alias');
    }

    for (const qStr of queries) {
      try {
        const q = language.query(qStr);
        for (const match of q.matches(root)) {
          for (const capture of match.captures) {
            const nameNode = capture.node.childForFieldName('name');
            if (capture.name === 'var_decl') {
              // Only include if value is a function
              const valueNode = capture.node.childForFieldName('value');
              if (nameNode && valueNode && ['function', 'arrow_function', 'function_expression'].includes(valueNode.type)) {
                names.push(this.getText(nameNode));
              }
            } else if (nameNode) {
              names.push(this.getText(nameNode));
            }
          }
        }
      } catch {
        // Query may not be valid for this language variant
      }
    }

    return names;
  }
}
```

**Step 4: Set up WASM files**

Before tests pass, tree-sitter WASM files must be available. Add a setup script:

Run: `npm install tree-sitter-wasms` (or build/download `.wasm` files)

The WASM loading paths in `parser.ts` may need adjustment based on how `tree-sitter-wasms` packages them — check `node_modules/tree-sitter-wasms/` for available `.wasm` files and adjust the `init()` method accordingly.

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/parser.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: tree-sitter parser porting CGC TS/JS queries to web-tree-sitter"
```

---

## Task 6: Symbol Map (`symbols.ts`)

**Files:**
- Create: `src/symbols.ts`
- Test: `src/symbols.test.ts`

**Step 1: Write the failing test**

```typescript
// src/symbols.test.ts
import { describe, it, expect } from 'vitest';
import { SymbolMap } from './symbols.js';
import type { ParsedFile } from './types.js';

function makeParsedFile(path: string, funcNames: string[], classNames: string[] = []): ParsedFile {
  return {
    path,
    lang: 'typescript',
    functions: funcNames.map((n, i) => ({
      name: n, line_number: i + 1, end_line: i + 2, args: [],
      cyclomatic_complexity: 1, decorators: [], context: null,
      context_type: null, class_context: null, lang: 'typescript', is_dependency: false,
    })),
    classes: classNames.map((n, i) => ({
      name: n, line_number: i + 1, end_line: i + 2, bases: [],
      decorators: [], context: null, lang: 'typescript', is_dependency: false,
    })),
    variables: [], imports: [], function_calls: [], is_dependency: false,
  };
}

describe('SymbolMap', () => {
  it('adds and resolves symbols', () => {
    const map = new SymbolMap();
    const file = makeParsedFile('/src/utils.ts', ['greet', 'add'], ['Helper']);
    map.addFile('/src/utils.ts', file);

    expect(map.resolve('greet')).toEqual(['/src/utils.ts']);
    expect(map.resolve('Helper')).toEqual(['/src/utils.ts']);
    expect(map.resolve('nonexistent')).toEqual([]);
  });

  it('removes symbols on file change', () => {
    const map = new SymbolMap();
    map.addFile('/src/a.ts', makeParsedFile('/src/a.ts', ['shared']));
    map.addFile('/src/b.ts', makeParsedFile('/src/b.ts', ['shared', 'unique']));

    map.removeFile('/src/a.ts');

    expect(map.resolve('shared')).toEqual(['/src/b.ts']);
    expect(map.resolve('unique')).toEqual(['/src/b.ts']);
  });

  it('handles multiple files defining same symbol', () => {
    const map = new SymbolMap();
    map.addFile('/src/a.ts', makeParsedFile('/src/a.ts', ['render']));
    map.addFile('/src/b.ts', makeParsedFile('/src/b.ts', ['render']));

    const paths = map.resolve('render');
    expect(paths).toHaveLength(2);
    expect(paths).toContain('/src/a.ts');
    expect(paths).toContain('/src/b.ts');
  });

  it('bootstraps from a pre-built map', () => {
    const map = new SymbolMap();
    const prebuilt = new Map<string, Set<string>>();
    prebuilt.set('foo', new Set(['/a.ts', '/b.ts']));
    prebuilt.set('bar', new Set(['/c.ts']));

    map.bootstrapFromMap(prebuilt);

    expect(map.resolve('foo')).toHaveLength(2);
    expect(map.resolve('bar')).toEqual(['/c.ts']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/symbols.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/symbols.ts
import type { ParsedFile } from './types.js';

/**
 * Incremental global symbol map: symbolName → Set<filePath>
 * CGC builds this in _pre_scan_for_imports() but rebuilds fully on every change.
 * We maintain it incrementally — the core innovation of codes2graph.
 */
export class SymbolMap {
  private map = new Map<string, Set<string>>();

  /** Bootstrap from Neo4j query result (startup). */
  bootstrapFromMap(data: Map<string, Set<string>>): void {
    this.map = new Map(
      Array.from(data.entries()).map(([k, v]) => [k, new Set(v)])
    );
  }

  /** Remove all symbols defined in a file. */
  removeFile(filePath: string): void {
    for (const [symbol, paths] of this.map) {
      paths.delete(filePath);
      if (paths.size === 0) this.map.delete(symbol);
    }
  }

  /** Add symbols from a freshly parsed file. */
  addFile(filePath: string, data: ParsedFile): void {
    for (const fn of data.functions) {
      this.addSymbol(fn.name, filePath);
    }
    for (const cls of data.classes) {
      this.addSymbol(cls.name, filePath);
    }
    if (data.interfaces) {
      for (const iface of data.interfaces) {
        this.addSymbol(iface.name, filePath);
      }
    }
    if (data.type_aliases) {
      for (const ta of data.type_aliases) {
        this.addSymbol(ta.name, filePath);
      }
    }
  }

  /** Resolve a symbol name to file paths. */
  resolve(symbolName: string): string[] {
    const paths = this.map.get(symbolName);
    return paths ? Array.from(paths) : [];
  }

  private addSymbol(name: string, filePath: string): void {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name)!.add(filePath);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/symbols.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/symbols.ts src/symbols.test.ts
git commit -m "feat: incremental symbol map for cross-file resolution"
```

---

## Task 7: CALLS/INHERITS Resolver (`resolver.ts`)

**Files:**
- Create: `src/resolver.ts`
- Test: `src/resolver.test.ts`

**Step 1: Write the failing test**

```typescript
// src/resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveCallsForFile, resolveInheritanceForFile } from './resolver.js';
import { SymbolMap } from './symbols.js';
import type { ParsedFile, ParsedCall, ParsedClass } from './types.js';

function makeSymbolMap(entries: Record<string, string[]>): SymbolMap {
  const map = new SymbolMap();
  const data = new Map<string, Set<string>>();
  for (const [sym, paths] of Object.entries(entries)) {
    data.set(sym, new Set(paths));
  }
  map.bootstrapFromMap(data);
  return map;
}

describe('resolveCallsForFile', () => {
  it('resolves local function calls', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [
        { name: 'main', line_number: 1, end_line: 5, args: [], cyclomatic_complexity: 1,
          decorators: [], context: null, context_type: null, class_context: null, lang: 'typescript', is_dependency: false },
        { name: 'helper', line_number: 6, end_line: 8, args: [], cyclomatic_complexity: 1,
          decorators: [], context: null, context_type: null, class_context: null, lang: 'typescript', is_dependency: false },
      ],
      classes: [], variables: [], imports: [],
      function_calls: [{
        name: 'helper', full_name: 'helper()', line_number: 3, args: [],
        inferred_obj_type: null, context: ['main', 'function_declaration', 1],
        class_context: [null, null], lang: 'typescript', is_dependency: false,
      }],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({});
    const resolved = resolveCallsForFile(file, symbolMap, false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].called_file_path).toBe('/src/a.ts');
    expect(resolved[0].called_name).toBe('helper');
  });

  it('resolves imported function calls via symbol map', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [
        { name: 'main', line_number: 1, end_line: 5, args: [], cyclomatic_complexity: 1,
          decorators: [], context: null, context_type: null, class_context: null, lang: 'typescript', is_dependency: false },
      ],
      classes: [], variables: [],
      imports: [{ name: 'render', source: './renderer', alias: null, line_number: 1, lang: 'typescript' }],
      function_calls: [{
        name: 'render', full_name: 'render()', line_number: 3, args: [],
        inferred_obj_type: null, context: ['main', 'function_declaration', 1],
        class_context: [null, null], lang: 'typescript', is_dependency: false,
      }],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({ render: ['/src/renderer.ts'] });
    const resolved = resolveCallsForFile(file, symbolMap, false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].called_file_path).toBe('/src/renderer.ts');
  });

  it('resolves this.method() calls to same file', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [
        { name: 'doWork', line_number: 3, end_line: 5, args: [], cyclomatic_complexity: 1,
          decorators: [], context: 'MyClass', context_type: 'class_declaration', class_context: 'MyClass', lang: 'typescript', is_dependency: false },
      ],
      classes: [
        { name: 'MyClass', line_number: 1, end_line: 10, bases: [], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
      ],
      variables: [], imports: [],
      function_calls: [{
        name: 'helper', full_name: 'this.helper()', line_number: 4, args: [],
        inferred_obj_type: null, context: ['doWork', 'method_definition', 3],
        class_context: ['MyClass', 'class_declaration'], lang: 'typescript', is_dependency: false,
      }],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({});
    const resolved = resolveCallsForFile(file, symbolMap, false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].called_file_path).toBe('/src/a.ts');
  });
});

describe('resolveInheritanceForFile', () => {
  it('resolves local class inheritance', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [], variables: [], imports: [], function_calls: [],
      classes: [
        { name: 'Base', line_number: 1, end_line: 3, bases: [], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
        { name: 'Child', line_number: 5, end_line: 8, bases: ['Base'], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
      ],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({});
    const resolved = resolveInheritanceForFile(file, symbolMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].parent_name).toBe('Base');
    expect(resolved[0].parent_file_path).toBe('/src/a.ts');
  });

  it('resolves imported class inheritance via symbol map', () => {
    const file: ParsedFile = {
      path: '/src/b.ts', lang: 'typescript',
      functions: [], variables: [], function_calls: [],
      imports: [{ name: 'BaseComponent', source: './base', alias: null, line_number: 1, lang: 'typescript' }],
      classes: [
        { name: 'MyWidget', line_number: 3, end_line: 10, bases: ['BaseComponent'], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
      ],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({ BaseComponent: ['/src/base.ts'] });
    const resolved = resolveInheritanceForFile(file, symbolMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].parent_file_path).toBe('/src/base.ts');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/resolver.test.ts`
Expected: FAIL

**Step 3: Write resolver implementation**

```typescript
// src/resolver.ts
import type { ParsedFile, ResolvedCall, ResolvedInheritance } from './types.js';
import type { SymbolMap } from './symbols.js';

/**
 * Resolve CALLS for a single file.
 * Port of CGC graph_builder.py:456-620 _create_function_calls
 *
 * Resolution priority (matches CGC):
 * 1. Local context (this/self/super) → same file
 * 2. Local definition → same file
 * 3. Import map → imported module's file
 * 4. Global symbol map → any file defining that symbol
 */
export function resolveCallsForFile(
  file: ParsedFile,
  symbolMap: SymbolMap,
  skipExternal: boolean,
): ResolvedCall[] {
  const callerFilePath = file.path;
  const localNames = new Set([
    ...file.functions.map(f => f.name),
    ...file.classes.map(c => c.name),
  ]);
  const localImports: Record<string, string> = {};
  for (const imp of file.imports) {
    const key = imp.alias || imp.name.split('.').pop()!;
    localImports[key] = imp.name;
  }

  const resolved: ResolvedCall[] = [];

  for (const call of file.function_calls) {
    const calledName = call.name;
    const fullCall = call.full_name || calledName;
    const baseObj = fullCall.includes('.') ? fullCall.split('.')[0] : null;
    const isChainedCall = fullCall.includes('.') ? fullCall.split('.').length > 2 : false;

    const lookupName = (isChainedCall && baseObj && ['self', 'this', 'super', 'super()', 'cls', '@'].includes(baseObj))
      ? calledName
      : (baseObj || calledName);

    let resolvedPath: string | null = null;

    // 1. Local context keywords (self/this/super) — direct calls only
    if (baseObj && ['self', 'this', 'super', 'super()', 'cls', '@'].includes(baseObj) && !isChainedCall) {
      resolvedPath = callerFilePath;
    } else if (localNames.has(lookupName)) {
      resolvedPath = callerFilePath;
    }

    // 2. Inferred type
    if (!resolvedPath && call.inferred_obj_type) {
      const paths = symbolMap.resolve(call.inferred_obj_type);
      if (paths.length > 0) resolvedPath = paths[0];
    }

    // 3. Imports map lookup
    if (!resolvedPath) {
      const possiblePaths = symbolMap.resolve(lookupName);
      if (possiblePaths.length === 1) {
        resolvedPath = possiblePaths[0];
      } else if (possiblePaths.length > 1 && lookupName in localImports) {
        const fullImportName = localImports[lookupName];
        for (const path of possiblePaths) {
          if (path.includes(fullImportName.replace(/\./g, '/'))) {
            resolvedPath = path;
            break;
          }
        }
      }
    }

    // 4. Legacy fallback: check calledName directly
    if (!resolvedPath) {
      if (localNames.has(calledName)) {
        resolvedPath = callerFilePath;
      } else {
        const candidates = symbolMap.resolve(calledName);
        if (candidates.length > 0) {
          resolvedPath = candidates[0];
        } else {
          resolvedPath = callerFilePath; // last resort: same file
        }
      }
    }

    if (skipExternal && resolvedPath === callerFilePath && !localNames.has(calledName)) {
      continue;
    }

    const context = call.context;
    if (context && context[0] !== null && context[1] !== null && context[2] !== null) {
      resolved.push({
        caller_name: context[0],
        caller_file_path: callerFilePath,
        caller_line_number: context[2],
        called_name: calledName,
        called_file_path: resolvedPath,
        line_number: call.line_number,
        args: call.args,
        full_call_name: fullCall,
      });
    } else {
      // File-level call (no function context) — handled separately by graph client
      resolved.push({
        caller_name: '',  // empty = file-level
        caller_file_path: callerFilePath,
        caller_line_number: 0,
        called_name: calledName,
        called_file_path: resolvedPath,
        line_number: call.line_number,
        args: call.args,
        full_call_name: fullCall,
      });
    }
  }

  return resolved;
}

/**
 * Resolve INHERITS for a single file.
 * Port of CGC graph_builder.py:628-690 _create_inheritance_links
 */
export function resolveInheritanceForFile(
  file: ParsedFile,
  symbolMap: SymbolMap,
): ResolvedInheritance[] {
  const callerFilePath = file.path;
  const localClassNames = new Set(file.classes.map(c => c.name));
  const localImports: Record<string, string> = {};
  for (const imp of file.imports) {
    const key = imp.alias || imp.name.split('.').pop()!;
    localImports[key] = imp.name;
  }

  const resolved: ResolvedInheritance[] = [];

  for (const cls of file.classes) {
    if (!cls.bases || cls.bases.length === 0) continue;

    for (const baseStr of cls.bases) {
      if (baseStr === 'object') continue;

      let resolvedPath: string | null = null;
      const targetName = baseStr.split('.').pop()!;

      if (baseStr.includes('.')) {
        // Qualified name: module.Class
        const prefix = baseStr.split('.')[0];
        if (prefix in localImports) {
          const fullImport = localImports[prefix];
          const candidates = symbolMap.resolve(targetName);
          for (const path of candidates) {
            if (path.includes(fullImport.replace(/\./g, '/'))) {
              resolvedPath = path;
              break;
            }
          }
        }
      } else {
        // Simple name
        if (localClassNames.has(baseStr)) {
          resolvedPath = callerFilePath;
        } else if (baseStr in localImports) {
          const fullImport = localImports[baseStr];
          const candidates = symbolMap.resolve(targetName);
          for (const path of candidates) {
            if (path.includes(fullImport.replace(/\./g, '/'))) {
              resolvedPath = path;
              break;
            }
          }
        } else {
          const candidates = symbolMap.resolve(baseStr);
          if (candidates.length === 1) resolvedPath = candidates[0];
        }
      }

      if (resolvedPath) {
        resolved.push({
          child_name: cls.name,
          child_file_path: callerFilePath,
          parent_name: targetName,
          parent_file_path: resolvedPath,
        });
      }
    }
  }

  return resolved;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/resolver.ts src/resolver.test.ts
git commit -m "feat: CALLS/INHERITS resolver matching CGC resolution priority"
```

---

## Task 8: File Watcher (`watcher.ts`)

**Files:**
- Create: `src/watcher.ts`
- Test: `src/watcher.test.ts`

**Step 1: Write the failing test**

```typescript
// src/watcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchDebouncer } from './watcher.js';

describe('BatchDebouncer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllTimers(); });

  it('collects changes and fires after quiet period', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 500 });

    debouncer.add('/src/a.ts');
    debouncer.add('/src/b.ts');

    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(new Set(['/src/a.ts', '/src/b.ts']));
  });

  it('resets quiet timer on new events', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 500 });

    debouncer.add('/src/a.ts');
    await vi.advanceTimersByTimeAsync(80);
    debouncer.add('/src/b.ts'); // reset quiet timer
    await vi.advanceTimersByTimeAsync(80);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forces processing at maxMs even if events keep coming', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 300 });

    // Send events every 50ms (never quiet for 100ms)
    for (let i = 0; i < 8; i++) {
      debouncer.add(`/src/file${i}.ts`);
      await vi.advanceTimersByTimeAsync(50);
    }

    // maxMs (300) should have triggered by now
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('deduplicates paths', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 500 });

    debouncer.add('/src/a.ts');
    debouncer.add('/src/a.ts');
    debouncer.add('/src/a.ts');

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledWith(new Set(['/src/a.ts']));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/watcher.test.ts`
Expected: FAIL

**Step 3: Write watcher implementation**

```typescript
// src/watcher.ts
import chokidar, { type FSWatcher } from 'chokidar';
import { resolve, extname, relative } from 'path';
import { existsSync } from 'fs';
import type { WatchOptions, ParsedFile } from './types.js';
import type { GraphClient } from './graph.js';
import type { Parser } from './parser.js';
import type { SymbolMap } from './symbols.js';
import { resolveCallsForFile, resolveInheritanceForFile } from './resolver.js';
import { loadIgnorePatterns, isIgnored } from './ignore.js';

// ─── Debouncer (exported for testing) ──────────────────

export class BatchDebouncer {
  private pending = new Set<string>();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  constructor(
    private handler: (batch: Set<string>) => Promise<void>,
    private options: { quietMs: number; maxMs: number },
  ) {}

  add(filePath: string): void {
    this.pending.add(filePath);
    this.resetQuietTimer();
    if (!this.maxTimer) this.startMaxTimer();
  }

  private resetQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.flush(), this.options.quietMs);
  }

  private startMaxTimer(): void {
    this.maxTimer = setTimeout(() => this.flush(), this.options.maxMs);
  }

  private async flush(): Promise<void> {
    if (this.processing || this.pending.size === 0) return;
    this.processing = true;

    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }

    const batch = new Set(this.pending);
    this.pending.clear();

    try {
      await this.handler(batch);
    } finally {
      this.processing = false;
      // If new events arrived during processing, start timers again
      if (this.pending.size > 0) {
        this.resetQuietTimer();
        this.startMaxTimer();
      }
    }
  }

  stop(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
  }
}

// ─── Watcher ───────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class Watcher {
  private fsWatcher: FSWatcher | null = null;
  private debouncer: BatchDebouncer | null = null;

  constructor(
    private graph: GraphClient,
    private parser: Parser,
    private symbolMap: SymbolMap,
    private options: WatchOptions,
  ) {}

  async start(repoPath: string): Promise<void> {
    const absRepoPath = resolve(repoPath);
    const ignorePatterns = loadIgnorePatterns(absRepoPath);

    // Bootstrap symbol map from Neo4j
    console.log('Bootstrapping symbol map from Neo4j...');
    const symbols = await this.graph.getAllSymbols();
    this.symbolMap.bootstrapFromMap(symbols);
    console.log(`Symbol map loaded: ${symbols.size} unique symbols`);

    // Set up debouncer
    this.debouncer = new BatchDebouncer(
      (batch) => this.processBatch(absRepoPath, batch),
      { quietMs: this.options.debounceQuiet, maxMs: this.options.debounceMax },
    );

    // Set up chokidar
    this.fsWatcher = chokidar.watch(absRepoPath, {
      ignored: (filePath: string, stats) => {
        const rel = relative(absRepoPath, filePath);
        if (!rel) return false; // don't ignore root
        if (isIgnored(rel, ignorePatterns)) return true;
        // Only watch supported extensions (let directories through)
        if (stats?.isFile() && !SUPPORTED_EXTENSIONS.has(extname(filePath))) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.fsWatcher
      .on('add', (p) => this.debouncer!.add(resolve(p)))
      .on('change', (p) => this.debouncer!.add(resolve(p)))
      .on('unlink', (p) => this.debouncer!.add(resolve(p)))
      .on('ready', () => console.log(`Watching ${absRepoPath} for changes...`))
      .on('error', (err) => console.error('Watcher error:', err));
  }

  async stop(): Promise<void> {
    this.debouncer?.stop();
    if (this.fsWatcher) await this.fsWatcher.close();
  }

  /**
   * Process a batch of changed files.
   * See docs/001-Architecture.md "Incremental Update Algorithm"
   * and graph_builder.py:329-344 processBatch equivalent.
   */
  private async processBatch(repoPath: string, batch: Set<string>): Promise<void> {
    const startTime = Date.now();
    console.log(`Processing batch of ${batch.size} file(s)...`);

    // Phase 1: Remove old data for all changed files
    for (const filePath of batch) {
      this.symbolMap.removeFile(filePath);
      await this.graph.deleteOutgoingCalls(filePath);
      await this.graph.deleteFile(filePath);
    }

    // Phase 2: Parse and re-add files that still exist
    const parsedFiles: ParsedFile[] = [];
    for (const filePath of batch) {
      if (!existsSync(filePath)) {
        console.log(`  Deleted: ${relative(repoPath, filePath)}`);
        continue;
      }

      try {
        const parsed = this.parser.parseFile(filePath, this.options.indexSource);
        this.symbolMap.addFile(filePath, parsed);
        await this.graph.addFileToGraph(parsed, repoPath);
        parsedFiles.push(parsed);
        console.log(`  Updated: ${relative(repoPath, filePath)}`);
      } catch (err) {
        console.error(`  Error parsing ${filePath}:`, err);
      }
    }

    // Phase 3: Resolve relationships for parsed files
    for (const parsed of parsedFiles) {
      const calls = resolveCallsForFile(parsed, this.symbolMap, this.options.skipExternal);
      for (const call of calls) {
        if (call.caller_name === '') {
          await this.graph.createFileLevelCallRelationship(
            call.caller_file_path, call.called_name, call.called_file_path,
            call.line_number, call.args, call.full_call_name,
          );
        } else {
          await this.graph.createCallRelationship(
            call.caller_name, call.caller_file_path, call.caller_line_number,
            call.called_name, call.called_file_path,
            call.line_number, call.args, call.full_call_name,
          );
        }
      }

      const inheritance = resolveInheritanceForFile(parsed, this.symbolMap);
      for (const inh of inheritance) {
        await this.graph.createInheritsRelationship(
          inh.child_name, inh.child_file_path, inh.parent_name, inh.parent_file_path,
        );
      }

      // Clean stale CALLS pointing to this file
      await this.graph.cleanStaleCallsTo(parsed.path);
    }

    const elapsed = Date.now() - startTime;
    console.log(`Batch complete in ${elapsed}ms`);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/watcher.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/watcher.ts src/watcher.test.ts
git commit -m "feat: file watcher with debounced batch processing"
```

---

## Task 9: CLI Entry Point (`index.ts`)

**Files:**
- Create: `src/index.ts`

**Step 1: Write the CLI**

```typescript
#!/usr/bin/env node
// src/index.ts
import { resolve, basename } from 'path';
import { loadConfig } from './config.js';
import { GraphClient } from './graph.js';
import { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { Watcher } from './watcher.js';
import type { WatchOptions } from './types.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'watch' || args.length < 2) {
    console.log('Usage: codes2graph watch <path> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --debounce <ms>     Quiet period before processing (default: 5000)');
    console.log('  --max-wait <ms>     Max wait before forced processing (default: 30000)');
    console.log('  --index-source      Store full source code in graph');
    console.log('  --skip-external     Skip unresolved external calls');
    process.exit(1);
  }

  const repoPath = resolve(args[1]);

  // Parse CLI options
  const debounceQuiet = parseInt(args[args.indexOf('--debounce') + 1] || '5000', 10);
  const debounceMax = parseInt(args[args.indexOf('--max-wait') + 1] || '30000', 10);

  const config = loadConfig();
  const options: WatchOptions = {
    debounceQuiet,
    debounceMax,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    indexSource: args.includes('--index-source') || config.indexSource,
    skipExternal: args.includes('--skip-external') || config.skipExternal,
  };

  // Initialize components
  console.log('codes2graph — incremental code graph watcher');
  console.log(`Repository: ${repoPath}`);
  console.log(`Neo4j: ${config.neo4jUri}`);

  const graph = new GraphClient(config);
  await graph.connect();
  await graph.ensureSchema();
  await graph.createRepository(repoPath, basename(repoPath));

  const parser = new Parser();
  await parser.init();

  const symbolMap = new SymbolMap();
  const watcher = new Watcher(graph, parser, symbolMap, options);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await watcher.stop();
    await graph.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await watcher.start(repoPath);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 2: Test the CLI manually**

Run: `npx tsx src/index.ts watch /path/to/test/repo`
Expected: Connects to Neo4j, bootstraps symbol map, starts watching

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI entry point for codes2graph watch command"
```

---

## Task 10: Integration Test — End-to-End

**Files:**
- Create: `src/integration.test.ts`

This test verifies the full pipeline: parse a file, write to Neo4j, verify CGC tools can read it.

**Step 1: Write the integration test**

```typescript
// src/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { GraphClient } from './graph.js';
import { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { resolveCallsForFile, resolveInheritanceForFile } from './resolver.js';
import { loadConfig } from './config.js';

const TEST_DIR = resolve(tmpdir(), 'codes2graph-test-' + Date.now());
const TEST_REPO = resolve(TEST_DIR, 'test-repo');

describe('Integration: full pipeline', () => {
  let graph: GraphClient;
  let parser: Parser;

  beforeAll(async () => {
    // Create test repo with sample files
    mkdirSync(join(TEST_REPO, 'src'), { recursive: true });

    writeFileSync(join(TEST_REPO, 'src', 'utils.ts'), `
export function add(a: number, b: number): number {
  return a + b;
}

export class MathHelper {
  multiply(a: number, b: number): number {
    return a * b;
  }
}
    `.trim());

    writeFileSync(join(TEST_REPO, 'src', 'main.ts'), `
import { add, MathHelper } from './utils';

function main() {
  const result = add(1, 2);
  const helper = new MathHelper();
  console.log(result, helper.multiply(3, 4));
}
    `.trim());

    // Initialize
    const config = loadConfig();
    graph = new GraphClient(config);
    await graph.connect();
    await graph.ensureSchema();
    await graph.createRepository(TEST_REPO, 'test-repo');

    parser = new Parser();
    await parser.init();
  });

  afterAll(async () => {
    // Clean up
    await graph.runCypher(
      'MATCH (n) WHERE n.path STARTS WITH $prefix DETACH DELETE n',
      { prefix: TEST_REPO }
    );
    await graph.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('parses and writes utils.ts to Neo4j', async () => {
    const parsed = parser.parseFile(join(TEST_REPO, 'src', 'utils.ts'));
    await graph.addFileToGraph(parsed, TEST_REPO);

    // Verify Function nodes
    const functions = await graph.runCypher(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(fn:Function)
       RETURN fn.name as name ORDER BY fn.line_number`,
      { path: resolve(join(TEST_REPO, 'src', 'utils.ts')) }
    );
    expect(functions.map(r => r.name)).toEqual(['add', 'multiply']);

    // Verify Class nodes
    const classes = await graph.runCypher(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(c:Class)
       RETURN c.name as name`,
      { path: resolve(join(TEST_REPO, 'src', 'utils.ts')) }
    );
    expect(classes.map(r => r.name)).toEqual(['MathHelper']);

    // Verify method is CONTAINS by class
    const methods = await graph.runCypher(
      `MATCH (c:Class {name: 'MathHelper'})-[:CONTAINS]->(fn:Function)
       RETURN fn.name as name`,
    );
    expect(methods.map(r => r.name)).toContain('multiply');
  });

  it('resolves cross-file CALLS', async () => {
    const utilsParsed = parser.parseFile(join(TEST_REPO, 'src', 'utils.ts'));
    const mainParsed = parser.parseFile(join(TEST_REPO, 'src', 'main.ts'));

    await graph.addFileToGraph(mainParsed, TEST_REPO);

    // Build symbol map
    const symbolMap = new SymbolMap();
    symbolMap.addFile(resolve(join(TEST_REPO, 'src', 'utils.ts')), utilsParsed);
    symbolMap.addFile(resolve(join(TEST_REPO, 'src', 'main.ts')), mainParsed);

    // Resolve calls
    const calls = resolveCallsForFile(mainParsed, symbolMap, false);
    const addCall = calls.find(c => c.called_name === 'add');
    expect(addCall).toBeDefined();
    expect(addCall!.called_file_path).toContain('utils.ts');
  });

  it('survives file deletion and re-creation', async () => {
    const filePath = resolve(join(TEST_REPO, 'src', 'utils.ts'));

    // Delete from graph
    await graph.deleteFile(filePath);
    const after = await graph.runCypher(
      'MATCH (f:File {path: $path}) RETURN f',
      { path: filePath }
    );
    expect(after).toHaveLength(0);

    // Re-add
    const parsed = parser.parseFile(join(TEST_REPO, 'src', 'utils.ts'));
    await graph.addFileToGraph(parsed, TEST_REPO);
    const restored = await graph.runCypher(
      'MATCH (f:File {path: $path})-[:CONTAINS]->(fn:Function) RETURN fn.name as name',
      { path: filePath }
    );
    expect(restored.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run the integration test**

Run: `npx vitest run src/integration.test.ts`
Expected: PASS (requires running Neo4j)

**Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: end-to-end integration test for full parse-write-read pipeline"
```

---

## Task 11: WASM Setup and Build Script

**Files:**
- Create: `scripts/setup-wasm.sh`
- Modify: `package.json` (add postinstall script)

**Step 1: Create WASM setup script**

This script downloads or builds the tree-sitter WASM files needed by the parser.

```bash
#!/bin/bash
# scripts/setup-wasm.sh
# Download pre-built tree-sitter WASM files

set -e
WASM_DIR="$(dirname "$0")/.."
cd "$WASM_DIR"

echo "Setting up tree-sitter WASM files..."

# Check if tree-sitter-wasms package has the files
if [ -d "node_modules/tree-sitter-wasms/out" ]; then
  echo "Linking WASM files from tree-sitter-wasms..."
  for f in node_modules/tree-sitter-wasms/out/tree-sitter-*.wasm; do
    base=$(basename "$f")
    if [ ! -f "$base" ]; then
      cp "$f" "$base"
      echo "  Copied $base"
    fi
  done
else
  echo "tree-sitter-wasms not found. Install with: npm install tree-sitter-wasms"
  exit 1
fi

# Also need the core tree-sitter.wasm
if [ ! -f "tree-sitter.wasm" ] && [ -f "node_modules/web-tree-sitter/tree-sitter.wasm" ]; then
  cp "node_modules/web-tree-sitter/tree-sitter.wasm" .
  echo "  Copied tree-sitter.wasm"
fi

echo "WASM setup complete."
```

**Step 2: Update package.json scripts**

Add `"postinstall": "bash scripts/setup-wasm.sh"` to the scripts section, and add `tree-sitter-wasms` to dependencies.

**Step 3: Run setup and verify**

Run: `npm install && bash scripts/setup-wasm.sh`
Expected: WASM files appear in project root

**Step 4: Commit**

```bash
git add scripts/setup-wasm.sh
git commit -m "feat: WASM setup script for tree-sitter language grammars"
```

---

## Task 12: Final Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Run the watcher against a real repo**

Run: `npx tsx src/index.ts watch /path/to/a/small/repo`

Verify:
- Connects to Neo4j
- Bootstraps symbol map
- Starts watching
- Edit a .ts file → observe "Processing batch" output within ~5s
- Check Neo4j browser: file's Functions/Classes/CALLS are updated

**Step 3: Compare output with CGC**

Run: `cgc index --force /path/to/test/repo` on a small test repo, then compare:

```cypher
-- In Neo4j browser, count functions from both tools
MATCH (f:Function) WHERE f.path STARTS WITH '/path/to/test/repo'
RETURN f.name, f.line_number, f.cyclomatic_complexity
ORDER BY f.path, f.line_number
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: codes2graph Phase 1 complete — incremental TS/JS watcher"
```

---

## Dependency Graph

```
Task 1 (Scaffolding)
  ├── Task 2 (Config)
  ├── Task 3 (Ignore)
  │
  ├── Task 4 (Graph Client) ──────────┐
  ├── Task 5 (Parser) ────────────────┤
  ├── Task 6 (Symbol Map) ────────────┤
  │                                    │
  ├── Task 7 (Resolver) ← Tasks 5,6   │
  │                                    │
  ├── Task 8 (Watcher) ← Tasks 2-7    │
  ├── Task 9 (CLI) ← Tasks 2-8        │
  │                                    │
  ├── Task 10 (Integration) ← All     │
  └── Task 11 (WASM Setup) ← Task 5   │
                                       │
Task 12 (Verification) ← All ─────────┘
```

Tasks 2, 3, 4, 5, 6 can be built in parallel after Task 1.
Task 7 depends on Tasks 5 and 6.
Task 8 depends on Tasks 2-7.
Task 9 depends on Tasks 2-8.
Tasks 10-12 are sequential verification.
