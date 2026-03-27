# Architecture Review

## Summary

codes2graph has a clean, well-structured architecture with good separation between modules and no circular dependencies. The dependency graph flows strictly downward: `index.ts` -> `indexer.ts`/`watcher.ts` -> `pipeline.ts` -> `parser.ts`/`graph.ts`/`resolver.ts`/`symbols.ts`, with `types.ts`, `config.ts`, and `ignore.ts` as leaf modules. The shared `processFiles` pipeline is a good design choice.

However, the review identified two confirmed bugs, a significant performance concern, and several maintainability issues.

## Findings

### [CRITICAL] Nested function CONTAINS relationships never created for JS/TS
**File:** `src/graph.ts:207`
**Description:** The nested function detection checks for `context_type === 'function_definition'`, which is a Python tree-sitter node type. The JS/TS grammar uses `function_declaration`, `function_expression`, `arrow_function`, and `method_definition`. This condition will never be true for any JS/TS file.
**Impact:** Nested functions never get `(outer:Function)-[:CONTAINS]->(inner:Function)` relationships. CGC MCP queries that traverse CONTAINS hierarchies miss nested functions.
**Recommendation:** Change to check for JS/TS node types: `function_declaration`, `function_expression`, `arrow_function`, `method_definition`.

---

### [CRITICAL] Abstract class methods missing class_context -- no Class-CONTAINS-Function edge
**File:** `src/parser.ts:430`
**Description:** `class_context` only checks `contextType === 'class_declaration'`, missing `abstract_class_declaration`. Also, `getParentContext()` default types don't include `abstract_class_declaration`.
**Impact:** Methods inside TypeScript abstract classes have `class_context = null`. No `(Class)-[:CONTAINS]->(Function)` relationship is created.
**Recommendation:** Add `abstract_class_declaration` to both `getParentContext()` types array and the `class_context` check.

---

### [HIGH] Per-query session creation causes excessive Neo4j overhead
**File:** `src/graph.ts:37-44, 104, 155`
**Description:** Every `runCypher()` opens a new session, runs one query, and closes it. `addFileToGraph` also calls `createFileNode` which opens its own session. ~120+ separate sessions per file.
**Impact:** Primary bottleneck for the <2s single-file target.
**Recommendation:** Introduce session reuse, transaction functions, or UNWIND-based batched Cypher.

---

### [HIGH] No transaction boundaries -- partial failures leave inconsistent graph state
**File:** `src/graph.ts`, `src/pipeline.ts:35-94`
**Description:** No Neo4j transactions are used. The three pipeline phases each consist of many auto-committed queries. A crash mid-pipeline leaves the graph inconsistent.
**Impact:** After a crash, files may have missing nodes, dangling relationships, or incomplete data. Requires `--force` re-index to recover.
**Recommendation:** Wrap each file's complete pipeline in a single Neo4j transaction.

---

### [HIGH] Watcher ignores configured extensions -- uses hardcoded constant
**File:** `src/watcher.ts:67, 120`
**Description:** `onFileEvent()` checks against hardcoded `SUPPORTED_EXTENSIONS` instead of `this.options.extensions`. The configured extensions are never used.
**Impact:** Phase 2 (Svelte support) will silently fail -- `.svelte` file changes ignored by watcher.
**Recommendation:** Replace hardcoded constant with `this.options.extensions`.

---

### [MEDIUM] Supported extensions defined in four separate locations
**Files:** `src/index.ts:141,165`, `src/watcher.ts:67`, `src/parser.ts:165-172`
**Description:** Extension list duplicated in four places. Adding a new language requires updating four files.
**Impact:** Adding Svelte or Python support requires coordinated updates across files. Forgetting one causes silent failures.
**Recommendation:** Define a single `SUPPORTED_EXTENSIONS` map in a shared location.

---

### [MEDIUM] Duplicated import-map construction in resolver.ts
**File:** `src/resolver.ts:24-28, 131-135`
**Description:** The `localImports` map is built identically in both `resolveCallsForFile()` and `resolveInheritanceForFile()`.
**Impact:** Two places to update if import map logic changes.
**Recommendation:** Extract a shared `buildImportMap()` helper.

---

### [MEDIUM] Business logic for `clean` command embedded in CLI entry point
**File:** `src/index.ts:36-121`
**Description:** 85 lines of business logic in the CLI entry point. `index` and `watch` delegate to classes, but `clean` does not.
**Impact:** Cannot reuse or test clean logic independently.
**Recommendation:** Extract into `src/cleaner.ts` or add to `Indexer` class.

---

### [MEDIUM] Silent error swallowing in schema creation and file walking
**Files:** `src/graph.ts:76-78`, `src/parser.ts:157-159`, `src/indexer.ts:31-33,44-45`
**Description:** Multiple bare `catch {}` blocks silently discard errors. Schema creation errors, WASM loading failures, and filesystem errors are all hidden.
**Impact:** Real setup problems are hidden, leading to confusing downstream failures.
**Recommendation:** Log warnings in catch blocks.

---

### [MEDIUM] Unresolved calls always fallback to self-referencing the caller file
**File:** `src/resolver.ts:82`
**Description:** Unresolvable external calls (e.g., `console.log`, `JSON.parse`) get `resolvedPath = callerFilePath`, creating spurious self-referential CALLS edges.
**Impact:** Creates many phantom CALLS edges. `find_dead_code` may incorrectly report functions as "called".
**Recommendation:** Consider making `skipExternal: true` the default, or skip creating edges for unresolved symbols.

---

### [LOW] Unused `ParsedImport` type import in graph.ts
**File:** `src/graph.ts:4`
**Description:** `ParsedImport` is imported but never referenced.
**Recommendation:** Remove from import statement.

---

### [LOW] Unused parameter `_ignorePatterns` in Watcher.onFileEvent
**File:** `src/watcher.ts:118`
**Description:** Parameter accepted but never used. Ignore filtering is handled by chokidar's `ignored` option.
**Recommendation:** Remove the parameter.

---

### [LOW] `preScanFile` method in Parser is unused in production code
**File:** `src/parser.ts:807-856`
**Description:** Exported but only called from tests. 50 lines of dead code.
**Recommendation:** Remove or integrate into indexer's symbol map bootstrap.

---

### [LOW] `addFileToGraph` mutates the input ParsedFunction objects
**File:** `src/graph.ts:168-169`
**Description:** Missing `cyclomatic_complexity` is added directly to the input object, mutating the original parsed data.
**Recommendation:** Create a shallow copy before mutation.

---

### [INFO] Dependency graph is clean -- no circular imports
**Description:** Import graph flows strictly in one direction. No circular dependencies exist. Positive.

---

### [INFO] Good extensibility pattern via pipeline abstraction
**File:** `src/pipeline.ts`
**Description:** Shared `processFiles` cleanly separates pipeline from entry points. Positive.

---

### [INFO] Testing dependencies well-isolated via type-only imports
**Description:** Modules use `import type` for dependencies, making test doubles straightforward. Positive.
