// src/indexer.ts
import { resolve, relative, extname } from 'path';
import { readdirSync, statSync } from 'fs';
import type { IndexOptions } from './types.js';
import type { GraphClient } from './graph.js';
import type { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { loadIgnorePatterns, isIgnored } from './ignore.js';
import { processFiles } from './pipeline.js';

export class Indexer {
  constructor(
    private graph: GraphClient,
    private parser: Parser,
    private options: IndexOptions,
  ) {}

  /**
   * Walk directory tree and collect all eligible file paths,
   * respecting .cgcignore patterns and extension filter.
   */
  discoverFiles(repoPath: string): string[] {
    const extensions = new Set(this.options.extensions);
    const ignorePatterns = loadIgnorePatterns(repoPath);
    const files: string[] = [];

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = resolve(dir, entry);
        const rel = relative(repoPath, fullPath);

        if (isIgnored(rel, ignorePatterns)) continue;

        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && extensions.has(extname(fullPath))) {
          files.push(fullPath);
        }
      }
    };

    walk(repoPath);
    return files.sort();
  }

  /**
   * Delete all existing graph data for this repo.
   */
  async wipeRepo(repoPath: string): Promise<void> {
    console.log('Wiping existing graph data...');
    await this.graph.runCypher(
      `MATCH (f:File) WHERE f.path STARTS WITH $repoPath
       OPTIONAL MATCH (f)-[:CONTAINS]->(child)
       DETACH DELETE child, f`,
      { repoPath },
    );
    await this.graph.runCypher(
      `MATCH (d:Directory) WHERE d.path STARTS WITH $repoPath
       DETACH DELETE d`,
      { repoPath },
    );
    console.log('Wipe complete.');
  }

  /**
   * Index the entire repo: discover files, process in batches, report progress.
   */
  async run(repoPath: string): Promise<void> {
    const absRepoPath = resolve(repoPath);

    if (this.options.force) {
      await this.wipeRepo(absRepoPath);
    }

    console.log('Discovering files...');
    const files = this.discoverFiles(absRepoPath);
    console.log(`Found ${files.length} files to index.`);

    if (files.length === 0) return;

    const symbolMap = new SymbolMap();

    // If not force, bootstrap symbol map from existing graph data
    if (!this.options.force) {
      const existingSymbols = await this.graph.getAllSymbols();
      symbolMap.bootstrapFromMap(existingSymbols);
    }

    const batchSize = this.options.batchSize;
    let totalParsed = 0;
    let totalErrors = 0;
    const startTime = Date.now();

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(files.length / batchSize);

      process.stdout.write(`\rBatch ${batchNum}/${totalBatches} — ${i + batch.length}/${files.length} files`);

      const result = await processFiles(
        absRepoPath,
        batch,
        this.graph,
        this.parser,
        symbolMap,
        { indexSource: this.options.indexSource, skipExternal: this.options.skipExternal },
      );

      totalParsed += result.parsed;
      totalErrors += result.errors;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nIndex complete: ${totalParsed} files indexed, ${totalErrors} errors, ${elapsed}s`);
  }
}
