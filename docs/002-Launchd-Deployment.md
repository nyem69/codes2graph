# Launchd Deployment Guide

Running codes2graph as a macOS launchd service to keep the Neo4j graph updated in the background.

## The EMFILE Problem

Large repos (e.g. road-asset-tagging with 69,290 files across 11,136 directories) cause `EMFILE: too many open files` when using filesystem watchers under launchd.

**Root cause:** macOS launchd enforces a **256 file descriptor soft limit** on launched services (`launchctl limit maxfiles` shows `256 unlimited`). Chokidar's default mode opens a persistent `fs.watch()` fd per watched file/directory, quickly exhausting this limit.

This does NOT reproduce in a terminal session because terminals inherit an unlimited hard limit, allowing libuv (Node's I/O layer) to silently raise the soft limit via `setrlimit()`. Under launchd, the hard limit is also restricted, so libuv cannot self-elevate.

### What didn't work

| Attempt | Why it failed |
|---------|---------------|
| `SoftResourceLimits` / `HardResourceLimits` in plist | These set limits for the launched process, but chokidar already opens fds during `chokidar.watch()` before Node can raise limits |
| Node native `fs.watch({ recursive: true })` | macOS FSEvents still opens fds internally — same EMFILE |
| Ignore patterns only | Reduced file count but not enough for 69k-file repos with deep `node_modules` |

### What worked — three-part fix

1. **Polling mode** — `usePolling: true` in chokidar uses `fs.stat()` instead of `fs.watch()`, needing zero persistent file descriptors
2. **Compiled JS** — Run `dist/index.js` (compiled via `tsc`) instead of `tsx` runtime, reducing fd overhead from the TypeScript compiler
3. **ulimit wrapper** — `ulimit -n 65536` in a bash wrapper within `ProgramArguments`, raising the fd limit before Node starts

### Bare directory names in ignore patterns

Chokidar checks ignore patterns at the directory level for pruning. The pattern `node_modules/**` matches files inside node_modules but does NOT match the bare directory name `node_modules` itself. Both are needed:

```
node_modules       ← matches the directory (chokidar skips traversal)
node_modules/**    ← matches files inside (safety net)
```

This is handled automatically in `src/ignore.ts` for both default patterns and `.cgcignore` files.

## Creating a Plist

### File location

```
~/Library/LaunchAgents/com.codes2graph.<repo-name>.plist
```

### Template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codes2graph.REPO_NAME</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>ulimit -n 65536; exec /path/to/node /path/to/codes2graph/dist/index.js watch /path/to/repo</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/path/to/codes2graph</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/path/to/node/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/USERNAME</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/USERNAME/Library/Logs/codes2graph-REPO_NAME.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/Library/Logs/codes2graph-REPO_NAME.err</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>

    <key>HardResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>
</dict>
</plist>
```

### Key plist fields

| Field | Purpose |
|-------|---------|
| `ProgramArguments` | Uses `/bin/bash -c` to run `ulimit -n 65536` before `exec node` — this is the critical fd limit fix |
| `KeepAlive.SuccessfulExit = false` | Restarts only on crashes (non-zero exit), not on clean shutdown |
| `ThrottleInterval` | Minimum 10 seconds between restart attempts to avoid rapid respawn loops |
| `SoftResourceLimits` / `HardResourceLimits` | Belt-and-suspenders fd limit alongside the ulimit wrapper |
| `EnvironmentVariables.HOME` | Required — launchd doesn't set HOME by default, and dotenv needs it to find `~/.codegraphcontext/.env` |

## Managing the Service

```bash
# Load and start
launchctl load ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist

# Stop and unload
launchctl unload ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist

# Check status
launchctl list | grep codes2graph

# View logs
tail -f ~/Library/Logs/codes2graph-REPO_NAME.log
tail -f ~/Library/Logs/codes2graph-REPO_NAME.err
```

## Rebuilding After Code Changes

The plist points to `dist/index.js` (compiled output), not the TypeScript source. After modifying codes2graph source:

```bash
cd /path/to/codes2graph
npm run build
launchctl unload ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist
launchctl load ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist
```

## Debugging Stale Processes

A common trap: failed `launchctl load` attempts can leave zombie Node processes holding log file handles. New launches then fail with confusing errors because the old process still occupies resources.

```bash
# Check for stale processes
ps aux | grep codes2graph

# Kill them
kill <PID>

# Clean stale log files if needed
rm ~/Library/Logs/codes2graph-REPO_NAME.{log,err}

# Then reload
launchctl load ~/Library/LaunchAgents/com.codes2graph.REPO_NAME.plist
```

## Verifying It Works

After loading, check the log for successful startup:

```
codes2graph — incremental code graph watcher
Repository: /path/to/repo
Neo4j: bolt://localhost:7687
Symbol map loaded: NNNN unique symbols
Watching /path/to/repo for changes (polling mode)...
```

The `(polling mode)` suffix confirms chokidar is using `fs.stat()` instead of `fs.watch()`.
