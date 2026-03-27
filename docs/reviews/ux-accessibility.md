# UX/Accessibility Review (CLI)

## Summary

codes2graph is a CLI tool with three commands (index, watch, clean) that manages a Neo4j code graph. The CLI is functional but has several UX gaps around error reporting, progress feedback for long operations, configuration transparency, argument validation, and missing standard CLI conventions (--help flag, --version). The most impactful issues relate to silent failures with default Neo4j credentials, no ETA/progress percentage during multi-hour indexing, and unhandled edge cases in argument parsing.

## Findings

### [CRITICAL] Neo4j connection failure produces an opaque error with no actionable guidance
**File:** `src/graph.ts:21` and `src/index.ts:217-219`
**Description:** When Neo4j is unreachable, `driver.verifyConnectivity()` throws a cryptic neo4j-driver error. There is no hint about checking the Neo4j URI, verifying the server is running, or which config file was used.
**Impact:** Users who haven't configured Neo4j or whose server is down will see an unhelpful error and not know what to do. This is the most common first-run failure.
**Recommendation:** Wrap `graph.connect()` in a try/catch that prints: `Error: Could not connect to Neo4j at bolt://localhost:7687. Is Neo4j running? Check your config at ~/.codegraphcontext/.env`

---

### [CRITICAL] Default Neo4j password 'password' connects silently without warning
**File:** `src/config.ts:25`
**Description:** When no `.env` file is found, the config silently defaults to `neo4j/password`. There is no log or warning that defaults are being used.
**Impact:** Users may unknowingly connect to the wrong Neo4j instance, or get auth errors with no understanding of why.
**Recommendation:** Log which config source was loaded during startup. If no config file was found, print a warning.

---

### [HIGH] No progress percentage or ETA during full index of large repos
**File:** `src/indexer.ts:157`
**Description:** Progress line is `Batch 5/26 -- 250/1300 files`. For repos taking ~2 hours, there is no ETA, no elapsed time display, and no per-batch timing.
**Impact:** Users have no sense of progress speed or remaining time.
**Recommendation:** Add elapsed time and estimated remaining time: `Batch 5/26 -- 250/1300 files [4m32s elapsed, ~36m remaining]`.

---

### [HIGH] No --help or -h flag support
**File:** `src/index.ts:201`
**Description:** `codes2graph --help` prints usage but exits with code 1 (error), not code 0 (success).
**Impact:** Package managers, shell completions, and CI scripts may interpret exit code 1 from `--help` as a failure.
**Recommendation:** Add explicit `--help`/`-h` detection that exits with code 0.

---

### [HIGH] No --version flag
**File:** `src/index.ts`
**Description:** There is no `--version` or `-v` flag.
**Impact:** Users cannot determine which version is installed, making bug reporting harder.
**Recommendation:** Add `--version`/`-v` that prints the version from package.json.

---

### [HIGH] parseInt with no NaN validation for numeric arguments
**File:** `src/index.ts:126,157,159`
**Description:** `--batch-size`, `--debounce`, and `--max-wait` values are parsed with `parseInt()` but never validated. `--batch-size foo` returns `NaN`, which silently causes no files to be indexed.
**Impact:** Malformed arguments cause silent misbehavior rather than a clear error.
**Recommendation:** Validate parsed integers: `if (isNaN(batchSize) || batchSize <= 0) { console.error('Error: --batch-size must be a positive integer'); process.exit(1); }`

---

### [HIGH] Missing argument value causes out-of-bounds array access
**File:** `src/index.ts:126`
**Description:** `codes2graph index /path --batch-size` (without a value) causes `parseInt(undefined, 10)` which returns `NaN`.
**Impact:** Silent NaN propagation.
**Recommendation:** Check that the value argument exists and is not another flag.

---

### [HIGH] Watcher error handler only logs to stderr, no recovery or exit
**File:** `src/watcher.ts:115`
**Description:** The chokidar `.on('error')` handler only does `console.error`. Fatal errors leave the watcher in a broken state.
**Impact:** In launchd mode, a broken watcher would sit idle consuming resources without processing changes.
**Recommendation:** Distinguish recoverable from fatal watcher errors. For fatal errors, exit with non-zero code for process supervisor restart.

---

### [MEDIUM] Index command shows no per-file errors during batch processing
**File:** `src/indexer.ts:159-166`
**Description:** Unlike `watch`, the `index` command calls `processFiles` without an `onProgress` callback. Parse errors are counted but never displayed.
**Impact:** When 20 files fail to parse, the user has no way to know which files or what the errors were.
**Recommendation:** Pass an `onProgress` callback that logs errors.

---

### [MEDIUM] Signal handler in watch mode may throw during shutdown
**File:** `src/index.ts:185-189`
**Description:** The SIGINT/SIGTERM handler calls `await watcher.stop()` and `await graph.close()`. If either throws, the error is unhandled.
**Impact:** Ctrl+C during a network interruption could produce a scary error instead of a clean shutdown.
**Recommendation:** Wrap the shutdown body in try/catch.

---

### [MEDIUM] No signal handling for index and clean commands
**File:** `src/index.ts:123-153` and `src/index.ts:36-121`
**Description:** Only `watch` registers SIGINT/SIGTERM handlers. Ctrl+C during indexing kills mid-transaction, potentially leaving inconsistent graph state.
**Impact:** Users may need to re-run with `--force` to clean up, but are not warned.
**Recommendation:** Add signal handlers that close the graph connection gracefully. Use exit code 130 per Unix convention.

---

### [MEDIUM] Startup banner does not show which config file was loaded
**File:** `src/index.ts:128-130`, `src/config.ts:13-29`
**Description:** Banner shows `Neo4j: bolt://localhost:7687` but not where this value came from.
**Impact:** When debugging connection issues, users cannot tell which config file is being used.
**Recommendation:** Display config source in startup banner.

---

### [MEDIUM] HOME environment variable fallback to '~' does not actually resolve
**File:** `src/config.ts:15`
**Description:** `resolve(process.env.HOME || '~', ...)` -- if `HOME` is not set, `'~'` is used as a literal path. Node.js `resolve()` does not expand tilde.
**Impact:** On systems where HOME is not set (CI, containers), config loading silently fails.
**Recommendation:** Use `os.homedir()` instead.

---

### [MEDIUM] Clean command progress line uses \r without newline, may be lost in piped output
**File:** `src/indexer.ts:82,97` and `src/index.ts:104`
**Description:** Carriage return progress is garbled when stdout is piped.
**Impact:** In CI/CD or redirected output, progress information is lost.
**Recommendation:** Detect `process.stdout.isTTY` and use line-based progress when not a TTY.

---

### [LOW] Help text does not show environment variable configuration options
**File:** `src/index.ts:12-34`
**Description:** `printUsage()` shows flags but not env vars or config file location.
**Impact:** New users do not know how to configure Neo4j connection without reading source.
**Recommendation:** Add configuration section to help text.

---

### [LOW] No command-specific help (e.g., `codes2graph index --help`)
**File:** `src/index.ts:197-214`
**Description:** `codes2graph index --help` treats `--help` as the path argument.
**Impact:** Confusing error instead of command-specific help.
**Recommendation:** Check for `--help` after command is parsed.

---

### [LOW] No color in output to distinguish errors from informational messages
**File:** Various
**Description:** All output uses plain `console.log` and `console.error`. Errors are not visually distinguished.
**Impact:** Errors during long indexing runs may be overlooked.
**Recommendation:** Consider ANSI colors for errors (red) and success (green), disabled when not a TTY.

---

### [INFO] Parser silent catch blocks may hide important errors
**File:** `src/parser.ts:157` and `src/parser.ts:850`
**Description:** Several `catch {}` blocks silently swallow errors. If a language grammar fails to load, files are silently skipped.
**Impact:** Corrupted tree-sitter-wasms package would cause silent parse failures.
**Recommendation:** Log warnings for these catch blocks.

---

### [INFO] Watcher startup does not log debounce settings
**File:** `src/index.ts:170-173`
**Description:** Users who pass `--debounce` or `--max-wait` have no confirmation their values were accepted.
**Recommendation:** Add debounce settings to startup banner.
