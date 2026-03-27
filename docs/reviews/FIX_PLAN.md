# Fix Plan

Numbered by priority. Each fix references consolidated finding numbers.

## Phase A: Correctness Bugs (do first -- these produce wrong graph data)

### Fix 1: Nested function CONTAINS uses wrong node type [#4]
**File:** `src/graph.ts:207`
**Change:** Replace `'function_definition'` with a set of JS/TS types: `function_declaration`, `function_expression`, `arrow_function`, `method_definition`.
**Effort:** 5 min

### Fix 2: Abstract class methods missing class_context [#5]
**File:** `src/parser.ts:230-234, 430`
**Change:** Add `abstract_class_declaration` to `getParentContext()` default types and the `classContext` check.
**Effort:** 5 min

### Fix 3: Watcher ignores configured extensions [#16]
**File:** `src/watcher.ts:67, 120`
**Change:** Replace hardcoded `SUPPORTED_EXTENSIONS` with `new Set(this.options.extensions)`. Remove the constant.
**Effort:** 5 min

### Fix 4: SET n += $props writes internal fields to Neo4j [#35]
**File:** `src/graph.ts:175`
**Change:** Allowlist properties per label instead of passing the raw object.
**Effort:** 30 min

### Fix 5: Unresolved calls self-reference creates phantom edges [#38]
**File:** `src/resolver.ts:82`
**Change:** Skip creating CALLS edge when symbol is not found in local scope or symbol map (instead of self-referencing).
**Effort:** 15 min

---

## Phase B: Performance (biggest impact -- 2h index → 10-15min)

### Fix 6: Batch Neo4j writes with UNWIND [#1, #2, #3, #11, #15, #39]
**Files:** `src/graph.ts` (major rewrite of addFileToGraph, createCallRelationship, etc.)
**Change:**
- Replace per-node `session.run()` with UNWIND-based batch queries per label
- Collect all CALLS/INHERITS into arrays and write with single UNWIND queries
- Reuse sessions, wrap file operations in write transactions
- Split label-OR queries into label-specific queries
**Effort:** 4-6 hours. This is the single biggest improvement.

### Fix 7: Fix tree-sitter WASM memory leak [#7, #8]
**File:** `src/parser.ts`
**Change:**
- Call `tree.delete()` after extracting data from AST
- Compile queries once during `init()` and cache per language (eliminates 9,100 recompilations)
**Effort:** 1-2 hours

### Fix 8: Add path-only Neo4j indexes [#9]
**File:** `src/graph.ts:56-72`
**Change:** Add `CREATE INDEX function_path`, `class_path`, `variable_path`, `interface_path` in `ensureSchema()`.
**Effort:** 10 min

### Fix 9: Add reverse index to SymbolMap [#10]
**File:** `src/symbols.ts`
**Change:** Add `reverseMap: Map<string, Set<string>>` mapping file paths to symbol names. Update `addFile`/`removeFile`.
**Effort:** 30 min

---

## Phase C: CLI UX

### Fix 10: Actionable Neo4j connection errors [#6, #21]
**File:** `src/graph.ts:connect()`, `src/config.ts`
**Change:** Catch neo4j-driver errors in `connect()` and print actionable message with config source. Log which config file was loaded at startup.
**Effort:** 30 min

### Fix 11: Add --help (exit 0), --version, NaN validation [#19, #20]
**File:** `src/index.ts`
**Change:** Add `--help`/`-h` (exit 0), `--version`/`-v`, validate parseInt results with `isNaN` check.
**Effort:** 20 min

### Fix 12: Index progress with ETA and per-file errors [#22, #23]
**File:** `src/indexer.ts`
**Change:** Add elapsed time + ETA to progress line. Pass `onProgress` callback that logs parse errors.
**Effort:** 20 min

### Fix 13: Signal handling for index/clean + shutdown guard [#24, #25, #36]
**Files:** `src/index.ts`
**Change:** Add SIGINT/SIGTERM handlers for all commands. Add `shuttingDown` guard flag. Use exit code 130.
**Effort:** 20 min

### Fix 14: Use os.homedir() instead of HOME env [#26]
**File:** `src/config.ts:15`
**Change:** `import { homedir } from 'os'` and replace `process.env.HOME || '~'` with `homedir()`.
**Effort:** 2 min

---

## Phase D: Type Safety

### Fix 15: Refactor graph.ts item mapping to preserve types [#12, #13]
**File:** `src/graph.ts:158-187`
**Change:** Replace `unknown[]` + `Record<string, unknown>` generic loop with explicit per-label handlers. Eliminates both unsafe cast chains.
**Effort:** 1 hour (can combine with Fix 6's UNWIND rewrite)

### Fix 16: Add Cypher label whitelist validation [#14]
**File:** `src/graph.ts`
**Change:** Add `assertValidLabel()` function. Apply before every template-literal interpolation.
**Effort:** 15 min

### Fix 17: Make runCypher generic [#31, #30]
**File:** `src/graph.ts:37-44`
**Change:** `async runCypher<T = Record<string, unknown>>(...)`. Callers specify expected result shape.
**Effort:** 30 min (can combine with Fix 6)

---

## Phase E: Security Hardening

### Fix 18: Symlink protection in file discovery [#18]
**File:** `src/indexer.ts:43`
**Change:** Use `lstatSync` to detect symlinks. Skip or verify resolved path is within repo root.
**Effort:** 15 min

### Fix 19: File size limit for source reads [#34]
**File:** `src/parser.ts:183`
**Change:** Check `statSync(absPath).size` before reading. Skip files > 2MB with warning.
**Effort:** 10 min

### Fix 20: Warn on unencrypted remote Neo4j [#17]
**File:** `src/config.ts` or `src/graph.ts:connect()`
**Change:** If URI scheme is `bolt://` and host is not localhost, log a warning.
**Effort:** 10 min

---

## Phase F: Cleanup (low priority)

### Fix 21: Consolidate extension definitions [#37]
**Change:** Single `SUPPORTED_EXTENSIONS` map in shared location.

### Fix 22: Extract clean command to its own module [Architecture #MEDIUM]

### Fix 23: Log warnings in silent catch blocks [Architecture #MEDIUM]

### Fix 24: Remove dead code (preScanFile, unused imports/params) [#46, #47, #48]

### Fix 25: TTY detection for progress output [#27]

### Fix 26: Increase polling interval to 5000ms [#42]

---

## Effort Summary

| Phase | Fixes | Estimated Effort | Impact |
|-------|-------|-----------------|--------|
| A: Correctness | 1-5 | 1 hour | Fixes wrong graph data |
| B: Performance | 6-9 | 6-8 hours | 2h index → 10-15 min |
| C: CLI UX | 10-14 | 1.5 hours | Better first-run experience |
| D: Type Safety | 15-17 | 1.5 hours | Compile-time bug prevention |
| E: Security | 18-20 | 35 min | Harden against edge cases |
| F: Cleanup | 21-26 | 1 hour | Maintainability |
| **Total** | **26** | **~12-14 hours** | |
