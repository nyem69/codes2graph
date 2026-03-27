# Security Audit Review

**Project:** codes2graph
**Date:** 2026-03-27
**Scope:** All source files in `src/`, configuration files, and dependency manifest

## Summary

codes2graph is a local-only CLI tool that connects to Neo4j, parses source code via tree-sitter, and writes graph data. The threat model is primarily local: a developer runs this against their own codebase with their own Neo4j instance. There are no network-facing services, no user authentication layer, and no multi-tenant concerns.

Within that context, I identified **2 HIGH**, **4 MEDIUM**, and **3 LOW** severity findings. There are no critical vulnerabilities. The most significant issues are the unencrypted default Neo4j connection and symlink-following behavior that could cause the indexer to escape the intended repository boundary.

All Cypher queries properly use parameterized values (`$param`) for data, which prevents Cypher injection. Label interpolation in queries uses only hardcoded strings from internal arrays, not user input.

## Findings

### [HIGH] Unencrypted Neo4j connection by default
**File:** `src/config.ts:23`
**Description:** The default Neo4j URI is `bolt://localhost:7687`, which uses unencrypted Bolt protocol. There is no validation or warning when a non-TLS connection scheme is used.
**Risk:** Neo4j credentials are transmitted in cleartext. If a user configures a remote Neo4j instance, credentials and all graph data traverse the network unencrypted.
**Recommendation:** Add a warning at connection time if the URI scheme is `bolt://` and the host is not `localhost`/`127.0.0.1`. Update `.env.example` to recommend encrypted connections for non-local deployments.

---

### [HIGH] Symlink traversal allows indexer to escape repository boundary
**File:** `src/indexer.ts:43`
**Description:** The `discoverFiles` method uses `statSync(fullPath)` which follows symbolic links. If a symlink inside the repository points outside it, the recursive walk will follow it and index files outside the intended repository.
**Risk:** Sensitive files outside the repository could be read, parsed, and their contents stored in Neo4j (especially with `--index-source`). In a scenario where the repo is untrusted, an attacker could craft a symlink to exfiltrate data into the graph.
**Recommendation:** Use `lstatSync` to detect symlinks without following them. Either skip symlinks entirely, or resolve them with `realpathSync` and verify the resolved path is still within the repository root.

---

### [MEDIUM] No file size limit on source file reads
**File:** `src/parser.ts:183`
**Description:** `readFileSync(absPath, 'utf-8')` reads the entire file into memory with no size limit.
**Risk:** A single very large file (minified bundle, generated code) could cause excessive memory consumption and OOM crashes.
**Recommendation:** Add a file size check before reading (e.g., 1-5MB limit). Log a warning and skip files that exceed the threshold.

---

### [MEDIUM] Unvalidated CLI numeric arguments can produce NaN
**File:** `src/index.ts:126, 157, 159`
**Description:** `parseInt()` is called without checking if the result is `NaN`. `NaN` batch size causes no files to be indexed; `NaN` debounce values cause timers to fire immediately.
**Risk:** Silent misbehavior from malformed arguments.
**Recommendation:** Validate parsed integers and exit with error for invalid values.

---

### [MEDIUM] SET n += $props passes entire parsed object as node properties
**File:** `src/graph.ts:175`
**Description:** `SET n += $props` passes the full parsed item object directly as Neo4j node properties, including internal routing fields (`context`, `context_type`, `class_context`) that CGC does not store.
**Risk:** Schema drift from CGC's expected output. The project's critical constraint is identical schema to `cgc index`.
**Recommendation:** Explicitly allowlist the properties to write for each node label, matching CGC's schema exactly.

---

### [MEDIUM] Async shutdown handler race condition on double SIGINT
**File:** `src/index.ts:185-192`
**Description:** If the user presses Ctrl+C twice quickly, the shutdown handler is invoked concurrently, potentially calling `graph.close()` on an already-closed driver.
**Risk:** Unhandled promise rejections, incomplete cleanup.
**Recommendation:** Add a `shuttingDown` guard flag.

---

### [LOW] Default password fallback in configuration
**File:** `src/config.ts:25`
**Description:** When `NEO4J_PASSWORD` is not set, the code falls back to `'password'`.
**Risk:** Normalizes insecure credentials.
**Recommendation:** Remove the default password fallback. Print an error directing the user to configure it.

---

### [LOW] .cgcignore path traversal via directory walk
**File:** `src/ignore.ts:31-55`
**Description:** The `loadIgnorePatterns` function walks up the directory tree looking for `.cgcignore` files, potentially reading one from a parent directory the user does not control.
**Risk:** A malicious `.cgcignore` in a parent directory could manipulate which files are excluded. Low severity because it can only exclude files, not execute them.
**Recommendation:** Limit the upward walk to the repository root.

---

### [LOW] Error details from Neo4j and file system are logged to console
**File:** `src/index.ts:218`, `src/watcher.ts:115`
**Description:** Neo4j connection errors may include the URI. In launchd mode, these logs go to system log files.
**Risk:** Connection URIs could be exposed in log files.
**Recommendation:** Sanitize error output. Ensure launchd plist files set appropriate permissions on log files.

---

## Positive Observations

1. **Cypher injection is mitigated.** All data values use parameterized `$param` syntax. Label interpolations use only hardcoded strings.
2. **Credentials are not logged.** The code logs `config.neo4jUri` but never logs `config.neo4jPassword`.
3. **`.env` is properly gitignored.**
4. **No child process spawning.** Eliminates command injection vectors.
5. **No network listeners.** The tool acts only as a client.
6. **Dependencies are minimal and reputable.** No known critical vulnerabilities.
