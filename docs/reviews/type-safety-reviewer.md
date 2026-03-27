# Type Safety Review

## Summary

The codebase has **strict mode enabled** in tsconfig.json, which is good. The source files are generally well-typed with explicit interfaces in `types.ts`. However, there are several type safety issues concentrated primarily in `src/graph.ts` where parsed data is cast through `unknown[]` to `Record<string, unknown>` to work with a generic item-mapping loop. There are also unsafe non-null assertions, type-erasing casts in Cypher result handling, and a Cypher injection surface via template-literal label interpolation.

Test files use `as any` casts for mocking, which is standard practice and not flagged here.

## Findings

### [HIGH] Unsafe double cast through `unknown[]` and `Record<string, unknown>` erases all type information
**File:** `src/graph.ts:158-166`
**Description:** The `itemMappings` array is typed as `[unknown[], string][]`, immediately erasing the concrete types (`ParsedFunction[]`, `ParsedClass[]`, etc.). Then on line 166, items are cast back to `Record<string, unknown>[]`. This means all property access on `item` (e.g., `item.name`, `item.line_number`) is completely unchecked by TypeScript.
**Risk:** Silent runtime failures when interface shapes diverge. The `SET n += $props` Cypher passes the entire raw `item` object as Neo4j properties with no type validation.
**Recommendation:** Replace the generic loop with explicit per-label handlers, or create a shared base interface and type the array properly.

---

### [HIGH] Unsafe cast `item as unknown as ParsedFunction` after type erasure
**File:** `src/graph.ts:187`
**Description:** After the item has been cast to `Record<string, unknown>`, it is cast back to `ParsedFunction` via a double cast (`as unknown as ParsedFunction`). This bypasses all compiler safety.
**Risk:** If this code path is reached for a non-Function item, the cast will silently succeed and `fn.args` could be `undefined`, causing a runtime crash.
**Recommendation:** Refactor to handle functions in their own dedicated code block rather than relying on a string label check + double cast.

---

### [HIGH] Cypher label interpolation via template literals -- potential injection surface
**File:** `src/graph.ts:121, 133, 174`
**Description:** Cypher queries use template literal interpolation for Neo4j node labels: `` `MATCH (p:${parentLabel} ...` ``. While values are currently hardcoded strings, this pattern is fragile.
**Risk:** If any future code path passes user-derived data into these label variables, it becomes a Cypher injection vulnerability.
**Recommendation:** Add a whitelist validation function that throws if the label is not in an allowed set. Apply it before every interpolation.

---

### [MEDIUM] Non-null assertion on `this.debouncer!` in event handler
**File:** `src/watcher.ts:121`
**Description:** `this.debouncer!.add(absPath)` uses a non-null assertion. If chokidar emits an event before `start()` completes, this will throw.
**Risk:** Runtime `TypeError: Cannot read properties of null`.
**Recommendation:** Either initialize `debouncer` in the constructor, or add a guard: `if (!this.debouncer) return;`.

---

### [MEDIUM] Neo4j query results cast to `string` and `number` without validation
**File:** `src/graph.ts:365-366, 388` and `src/indexer.ts:79, 94, 109`
**Description:** Results from `runCypher` are typed as `Record<string, unknown>[]`, but values are immediately cast with `as string` or `as number` without runtime validation.
**Risk:** Neo4j can return `null` for missing properties, leading to `null` typed as `string`.
**Recommendation:** Add runtime checks or use a validation helper.

---

### [MEDIUM] `runCypher` return type `Record<string, unknown>[]` forces unsafe casts everywhere
**File:** `src/graph.ts:37-44`
**Description:** Every caller must cast individual fields, creating a pattern of unchecked `as` casts throughout the codebase.
**Risk:** No compile-time safety for any Cypher query result.
**Recommendation:** Make `runCypher` generic: `async runCypher<T = Record<string, unknown>>(...)`.

---

### [MEDIUM] Unsafe tuple cast in parser for call context
**File:** `src/parser.ts:733-734`
**Description:** The `context` field is cast with `as [string, string, number] | [null, null, null]` but `getParentContext` returns `[string | null, string | null, number | null]`, which does not match either branch.
**Risk:** A partial null result like `["foo", null, 5]` would be incorrectly typed.
**Recommendation:** Change `ParsedCall.context` to `[string | null, string | null, number | null]` to match reality.

---

### [MEDIUM] `tsParser` uses definite assignment assertion without initialization guard
**File:** `src/parser.ts:120`
**Description:** `private tsParser!: TreeSitter;` -- the `preScanFile` method (line 807) does not check `this.initialized` before using `tsParser`.
**Risk:** Runtime crash if `preScanFile` is called before `init()`.
**Recommendation:** Add an `if (!this.initialized)` guard to `preScanFile`.

---

### [LOW] Non-null assertions after `.get()` on Maps
**File:** `src/graph.ts:368`, `src/symbols.ts:45`
**Description:** Pattern `if (!map.has(name)) map.set(name, new Set()); map.get(name)!.add(path);` uses `!` after confirming the key exists.
**Risk:** Minimal in single-threaded Node.js, but fragile under refactoring.
**Recommendation:** Use `const set = map.get(name) ?? new Set(); set.add(path); map.set(name, set);`.

---

### [LOW] `imp.line_number` falsy check skips line 0
**File:** `src/graph.ts:242`
**Description:** `if (imp.line_number) relProps.line_number = imp.line_number;` -- a value of `0` would be treated as falsy.
**Risk:** Very low given 1-based line numbers.
**Recommendation:** Use `if (imp.line_number !== undefined)`.

---

### [INFO] tsconfig.json strict mode is properly enabled
**File:** `tsconfig.json:9`
**Description:** `"strict": true` is set. This is the correct configuration.

---

### [INFO] Test files use `as any` for mock objects
**File:** `src/indexer.test.ts:29, 49`, `src/pipeline.test.ts:41-43`
**Description:** Standard TypeScript testing practice.

---

## Key Metrics

| Category | Count |
|---|---|
| Explicit `any` in source (non-test) | 0 |
| Unsafe `as` casts in source | 8 |
| Non-null assertions (`!`) in source | 4 |
| Definite assignment assertions (`!:`) | 1 |
| Empty `catch` blocks (swallowed errors) | 5 |
| Template-literal Cypher interpolation | 3 |
