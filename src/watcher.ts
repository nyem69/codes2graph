import chokidar, { type FSWatcher } from 'chokidar';
import { resolve, extname, relative } from 'path';
import type { WatchOptions } from './types.js';
import type { GraphClient } from './graph.js';
import type { Parser } from './parser.js';
import type { SymbolMap } from './symbols.js';
import { processFiles } from './pipeline.js';
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

export class Watcher {
  private fsWatcher: FSWatcher | null = null;
  private debouncer: BatchDebouncer | null = null;
  private supportedExtensions: Set<string>;

  constructor(
    private graph: GraphClient,
    private parser: Parser,
    private symbolMap: SymbolMap,
    private options: WatchOptions,
  ) {
    this.supportedExtensions = new Set(this.options.extensions);
  }

  async start(repoPath: string): Promise<void> {
    const absRepoPath = resolve(repoPath);
    const ignorePatterns = loadIgnorePatterns(absRepoPath);

    console.log('Bootstrapping symbol map from Neo4j...');
    const symbols = await this.graph.getAllSymbols();
    this.symbolMap.bootstrapFromMap(symbols);
    console.log(`Symbol map loaded: ${symbols.size} unique symbols`);

    this.debouncer = new BatchDebouncer(
      (batch) => this.processBatch(absRepoPath, batch),
      { quietMs: this.options.debounceQuiet, maxMs: this.options.debounceMax },
    );

    // Use chokidar with polling to avoid EMFILE under launchd's 256 fd limit.
    // Polling uses fs.stat() instead of fs.watch(), needing zero persistent fds.
    this.fsWatcher = chokidar.watch(absRepoPath, {
      ignored: (filePath: string) => {
        const rel = relative(absRepoPath, filePath);
        if (!rel) return false;
        if (isIgnored(rel, ignorePatterns)) return true;
        return false;
      },
      usePolling: true,
      interval: 5000,
      binaryInterval: 5000,
      persistent: true,
      ignoreInitial: true,
    });

    this.fsWatcher
      .on('add', (p) => this.onFileEvent(absRepoPath, p))
      .on('change', (p) => this.onFileEvent(absRepoPath, p))
      .on('unlink', (p) => this.onFileEvent(absRepoPath, p))
      .on('ready', () => console.log(`Watching ${absRepoPath} for changes (polling mode)...`))
      .on('error', (err: unknown) => {
        console.error('Watcher error:', err);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EMFILE' || code === 'EACCES' || code === 'EPERM') {
          console.error('Fatal watcher error, exiting.');
          process.exit(1);
        }
      });
  }

  private onFileEvent(repoPath: string, filePath: string): void {
    const absPath = resolve(filePath);
    if (!this.supportedExtensions.has(extname(absPath))) return;
    this.debouncer!.add(absPath);
  }

  async stop(): Promise<void> {
    this.debouncer?.stop();
    if (this.fsWatcher) await this.fsWatcher.close();
  }

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
}
