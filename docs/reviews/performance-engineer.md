# Performance Engineering Review

## Summary

The codes2graph codebase has **severe N+1 query patterns** in its Neo4j interaction layer that are the primary bottleneck for the reported 2-hour indexing time on 1,300+ file repos. A typical file generates **50-100 individual Neo4j round-trips** where 2-3 batched queries would suffice. Combined with session-per-query overhead, missing single-property indexes on hot query paths, WASM memory leaks from tree-sitter, and redundant query compilation, the system is operating at roughly 1/20th to 1/50th of achievable throughput.

**Estimated query count for 1,300-file repo (current):** ~130,000-200,000 individual Neo4j round-trips
**Estimated query count after batching:** ~5,000-8,000 round-trips
**Projected indexing time improvement:** 10-30x faster (2 hours to 5-15 minutes)

## Findings

### [CRITICAL] N+1 Neo4j queries in addFileToGraph -- individual query per node/relationship
**File:** `src/graph.ts:149-255`
**Description:** `addFileToGraph` executes a separate `session.run()` for every function, class, variable, interface, parameter, nested function relationship, class method relationship, and import in a file. For a file with 10 functions (3 params each), 2 classes, 5 variables, 10 imports, this is ~48 individual Neo4j queries.
**Impact:** For 1,300 files, ~65,000-85,000 individual Neo4j round-trips just for node creation. This is the single largest contributor to the 2-hour indexing time.
**Recommendation:** Use `UNWIND` with parameter lists to batch all nodes of the same label into a single query per file. Reduces ~50 queries per file to ~8.

---

### [CRITICAL] N+1 Neo4j queries for CALLS/INHERITS resolution
**File:** `src/pipeline.ts:69-93`
**Description:** Phase 3 creates CALLS and INHERITS relationships one at a time. Each resolved call opens a new session, runs the query, and closes the session.
**Impact:** 20-50 call expressions per file x 1,300 files = 26,000-65,000 additional round-trips. Likely accounts for 40-60% of total indexing time.
**Recommendation:** Collect all resolved calls into an array and use a single UNWIND query per batch.

---

### [CRITICAL] Session-per-query in runCypher creates excessive connection overhead
**File:** `src/graph.ts:37-44`
**Description:** Every call to `runCypher` opens a new Neo4j session and closes it after a single query. The hot path opens and closes 100,000+ sessions during a full index.
**Impact:** Session creation/teardown overhead of ~1-5ms per call. At 130,000+ calls, adds 2-10 minutes of pure session management overhead.
**Recommendation:** Add session reuse and explicit write transactions (`session.writeTransaction()`) to batch multiple writes.

---

### [HIGH] WASM memory leak -- tree-sitter trees and queries never freed
**File:** `src/parser.ts:200, 371, 466, 524, 554, 585, 687, 753`
**Description:** `web-tree-sitter` allocates trees and compiled queries in WASM linear memory, outside the JS garbage collector. Trees from `this.tsParser.parse(source)` and queries from `language.query(...)` are never freed via `.delete()`.
**Impact:** For 1,300 files: ~1,300 leaked trees + ~9,100 leaked queries. Can accumulate to 200MB-1GB+ of leaked WASM memory. For the long-running watcher, this is a continuous leak.
**Recommendation:** Call `tree.delete()` after use. Compile queries once during `init()` and cache per language.

---

### [HIGH] Tree-sitter queries recompiled on every file parse
**File:** `src/parser.ts:371, 466, 524, 554, 585, 687, 753`
**Description:** Every `parseSource` call compiles 7 tree-sitter queries from string. This is done for every single file.
**Impact:** 9,100 query compilations for 1,300 files. WASM memory leak compounds the problem.
**Recommendation:** Compile queries once during `init()` and cache them per language.

---

### [HIGH] Missing path-only indexes on Function, Class, Variable labels
**File:** `src/graph.ts:56-72`
**Description:** The schema creates composite constraints on `(name, path, line_number)`. Several hot-path queries filter on `path` alone (`deleteOutgoingCalls`, `cleanStaleCallsTo`), requiring full label scans.
**Impact:** Each `deleteOutgoingCalls` and `cleanStaleCallsTo` call performs a full scan, called once per file.
**Recommendation:** Add indexes: `CREATE INDEX function_path IF NOT EXISTS FOR (f:Function) ON (f.path)` etc.

---

### [HIGH] SymbolMap.removeFile scans entire map -- O(S) per file removal
**File:** `src/symbols.ts:12-17`
**Description:** `removeFile` iterates over every entry in the symbol map. No reverse index from file path to symbol names.
**Impact:** 1,300 calls x 5,000-10,000 map entries = 6.5M-13M iterations during full index.
**Recommendation:** Add a reverse index `Map<string, Set<string>>` mapping file paths to their symbol names.

---

### [HIGH] createCallRelationship uses label-OR pattern preventing index usage
**File:** `src/graph.ts:274-285`
**Description:** `MATCH (caller) WHERE (caller:Function OR caller:Class)` prevents Neo4j from using label-specific indexes.
**Impact:** 30,000-60,000 CALLS queries with full scans instead of indexed lookups.
**Recommendation:** Split into two targeted queries or batch all CALLS with UNWIND.

---

### [MEDIUM] No transaction batching -- every session.run is an auto-commit transaction
**File:** `src/graph.ts:149-255`
**Description:** Each `session.run()` is an auto-commit transaction, meaning 50+ separate transaction commits per file.
**Impact:** ~65,000 transaction commits at ~0.5-2ms each adds 30-130 seconds.
**Recommendation:** Wrap each file's writes in a single explicit write transaction.

---

### [MEDIUM] Sequential file processing with no parallelism
**File:** `src/pipeline.ts:47-66`
**Description:** Phase 2 processes files strictly sequentially: parse (CPU) then write to Neo4j (I/O), one at a time.
**Impact:** CPU sits idle during Neo4j writes. Pipelining could recover 10-20% of total time.
**Recommendation:** Implement a producer-consumer pattern where parsing runs ahead of graph writes.

---

### [MEDIUM] Synchronous readFileSync blocks event loop during parsing
**File:** `src/parser.ts:183`
**Description:** `readFileSync` blocks the Node.js event loop, preventing concurrent I/O.
**Impact:** Prevents Node.js from processing pending Neo4j driver responses during reads.
**Recommendation:** Use `readFile` from `fs/promises`.

---

### [MEDIUM] parsedFiles array retains all parsed data through entire batch
**File:** `src/pipeline.ts:43, 60, 69-94`
**Description:** All successfully parsed files are accumulated in memory through Phase 2, then iterated in Phase 3. With `indexSource` enabled, this includes full source code.
**Impact:** 50-200MB peak memory per batch with `indexSource`.
**Recommendation:** Clear source data after Phase 2, or resolve relationships per-file immediately after writing.

---

### [LOW] Polling interval of 2000ms may cause unnecessary CPU usage when idle
**File:** `src/watcher.ts:104`
**Description:** `fs.stat()` called on every watched file every 2 seconds. For 1,300 files, that's 650 stat calls per second.
**Impact:** Continuous ~1-3% CPU when idle, conflicting with the <1% target.
**Recommendation:** Increase polling interval to 5000ms.

---

### [LOW] deleteFile uses variable-length path traversal per file
**File:** `src/graph.ts:383-406`
**Description:** `deleteFile` uses `[:CONTAINS*]` variable-length path for directory cleanup, called for every file in batch.
**Impact:** 5-10 seconds during non-force re-indexing.
**Recommendation:** For bulk operations, do a single cleanup pass at the end.

---

### [INFO] getAllSymbols loads entire graph into memory
**File:** `src/graph.ts:357-371`
**Description:** One-time cost at watcher startup. For 10,000 symbols, ~2MB memory.
**Impact:** Acceptable for startup.

---

## Priority Summary

| Priority | Finding | Estimated Improvement |
|----------|---------|----------------------|
| CRITICAL | Batch Neo4j writes with UNWIND in addFileToGraph | 10-20x fewer queries |
| CRITICAL | Batch CALLS/INHERITS creation with UNWIND | 5-10x fewer queries |
| CRITICAL | Reuse sessions, use explicit transactions | 2-3x less overhead |
| HIGH | Free tree-sitter trees/queries (.delete()) | Prevent 200MB-1GB WASM leak |
| HIGH | Cache compiled tree-sitter queries | Eliminate 9,100 recompilations |
| HIGH | Add path-only indexes on Function/Class/Variable | Faster deletion queries |
| HIGH | Add reverse index to SymbolMap | O(1) vs O(n) file removal |
| HIGH | Fix label-OR pattern in CALLS query | Enable index usage |
| MEDIUM | Use explicit write transactions | 30-130s saved on commits |
| MEDIUM | Pipeline parsing and Neo4j writes | 10-20% throughput gain |
| MEDIUM | Use async file reads | Unblock event loop |
| MEDIUM | Clear source data between pipeline phases | 50-200MB less peak memory |
| LOW | Increase polling interval | Meet <1% idle CPU target |
| LOW | Batch directory cleanup | 5-10s saved on re-index |

The top three CRITICAL findings alone could reduce the 2-hour indexing time to 10-20 minutes. Addressing all HIGH findings as well would further improve to 5-10 minutes and fix the WASM memory leak that makes the watcher unstable for long-running service use.
