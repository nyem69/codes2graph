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

    console.log('Bootstrapping symbol map from Neo4j...');
    const symbols = await this.graph.getAllSymbols();
    this.symbolMap.bootstrapFromMap(symbols);
    console.log(`Symbol map loaded: ${symbols.size} unique symbols`);

    this.debouncer = new BatchDebouncer(
      (batch) => this.processBatch(absRepoPath, batch),
      { quietMs: this.options.debounceQuiet, maxMs: this.options.debounceMax },
    );

    this.fsWatcher = chokidar.watch(absRepoPath, {
      ignored: (filePath: string, stats) => {
        const rel = relative(absRepoPath, filePath);
        if (!rel) return false;
        if (isIgnored(rel, ignorePatterns)) return true;
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

  private async processBatch(repoPath: string, batch: Set<string>): Promise<void> {
    const startTime = Date.now();
    console.log(`Processing batch of ${batch.size} file(s)...`);

    for (const filePath of batch) {
      this.symbolMap.removeFile(filePath);
      await this.graph.deleteOutgoingCalls(filePath);
      await this.graph.deleteFile(filePath);
    }

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

      await this.graph.cleanStaleCallsTo(parsed.path);
    }

    const elapsed = Date.now() - startTime;
    console.log(`Batch complete in ${elapsed}ms`);
  }
}
