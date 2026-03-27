# Consolidated Code Review

Five parallel reviews conducted: Security Auditor, Performance Engineer, Type Safety Reviewer, UX/Accessibility, Architecture Reviewer.

## CRITICAL (6 findings)

| # | Finding | Source | File |
|---|---------|--------|------|
| 1 | N+1 Neo4j queries in addFileToGraph (~50 queries/file) | Performance | `graph.ts:149-255` |
| 2 | N+1 Neo4j queries for CALLS/INHERITS resolution | Performance | `pipeline.ts:69-93` |
| 3 | Session-per-query in runCypher (130K+ sessions per index) | Performance | `graph.ts:37-44` |
| 4 | Nested function CONTAINS checks Python node type, never matches JS/TS | Architecture | `graph.ts:207` |
| 5 | Abstract class methods missing class_context (no Class-CONTAINS-Function) | Architecture | `parser.ts:430` |
| 6 | Neo4j connection failure produces opaque error with no guidance | UX | `graph.ts:21` |

## HIGH (14 findings)

| # | Finding | Source | File |
|---|---------|--------|------|
| 7 | WASM memory leak -- tree-sitter trees/queries never freed | Performance | `parser.ts:200+` |
| 8 | Tree-sitter queries recompiled on every file parse (9,100x) | Performance | `parser.ts:371+` |
| 9 | Missing path-only indexes on Function/Class/Variable | Performance | `graph.ts:56-72` |
| 10 | SymbolMap.removeFile scans entire map O(S) per removal | Performance | `symbols.ts:12-17` |
| 11 | createCallRelationship label-OR prevents index usage | Performance | `graph.ts:274-285` |
| 12 | Unsafe double cast `unknown[]` -> `Record<string, unknown>` erases types | Type Safety | `graph.ts:158-166` |
| 13 | Unsafe `as unknown as ParsedFunction` double cast | Type Safety | `graph.ts:187` |
| 14 | Cypher label interpolation via template literals | Type Safety | `graph.ts:121,133,174` |
| 15 | No transaction boundaries -- partial failures leave inconsistent graph | Architecture | `graph.ts`, `pipeline.ts` |
| 16 | Watcher ignores configured extensions, uses hardcoded constant | Architecture | `watcher.ts:67,120` |
| 17 | Unencrypted Neo4j connection by default | Security | `config.ts:23` |
| 18 | Symlink traversal allows indexer to escape repo boundary | Security | `indexer.ts:43` |
| 19 | No --help/-h flag (exits code 1), no --version | UX | `index.ts:201` |
| 20 | parseInt with no NaN validation for numeric arguments | UX | `index.ts:126,157,159` |

## MEDIUM (18 findings)

| # | Finding | Source | File |
|---|---------|--------|------|
| 21 | Default password 'password' connects silently, no config source shown | UX | `config.ts:25` |
| 22 | No progress ETA during multi-hour full index | UX | `indexer.ts:157` |
| 23 | Index command shows no per-file errors | UX | `indexer.ts:159-166` |
| 24 | No signal handling for index/clean commands | UX | `index.ts:123-153` |
| 25 | Signal handler may throw during shutdown | UX | `index.ts:185-189` |
| 26 | HOME fallback '~' not resolved by Node.js | UX | `config.ts:15` |
| 27 | Progress \r lost in piped output | UX | `indexer.ts:82,97` |
| 28 | Watcher error handler only logs, no recovery | UX | `watcher.ts:115` |
| 29 | Non-null assertion on `this.debouncer!` | Type Safety | `watcher.ts:121` |
| 30 | Neo4j results cast without validation | Type Safety | `graph.ts:365+` |
| 31 | `runCypher` return type forces unsafe casts everywhere | Type Safety | `graph.ts:37-44` |
| 32 | Unsafe tuple cast for call context | Type Safety | `parser.ts:733-734` |
| 33 | `tsParser` definite assignment without init guard in preScanFile | Type Safety | `parser.ts:120,807` |
| 34 | No file size limit on source reads | Security | `parser.ts:183` |
| 35 | SET n += $props passes internal fields to Neo4j | Security | `graph.ts:175` |
| 36 | Async shutdown race on double SIGINT | Security | `index.ts:185-192` |
| 37 | Supported extensions in four separate locations | Architecture | `index.ts,watcher.ts,parser.ts` |
| 38 | Unresolved calls fallback to self-referencing caller file | Architecture | `resolver.ts:82` |

## LOW (11 findings)

| # | Finding | Source | File |
|---|---------|--------|------|
| 39 | No explicit write transactions (auto-commit overhead) | Performance | `graph.ts:149-255` |
| 40 | Sequential processing, no parse/write pipelining | Performance | `pipeline.ts:47-66` |
| 41 | Sync readFileSync blocks event loop | Performance | `parser.ts:183` |
| 42 | Polling interval 2000ms vs <1% CPU target | Performance | `watcher.ts:104` |
| 43 | Default password fallback normalizes insecure creds | Security | `config.ts:25` |
| 44 | .cgcignore walks to filesystem root | Security | `ignore.ts:31-55` |
| 45 | Help text missing env var docs | UX | `index.ts:12-34` |
| 46 | Unused ParsedImport import | Architecture | `graph.ts:4` |
| 47 | Unused _ignorePatterns parameter | Architecture | `watcher.ts:118` |
| 48 | preScanFile unused in production | Architecture | `parser.ts:807-856` |
| 49 | addFileToGraph mutates input objects | Architecture | `graph.ts:168-169` |
