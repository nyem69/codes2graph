#!/usr/bin/env node
import { resolve, basename, relative } from 'path';
import { loadConfig } from './config.js';
import { GraphClient } from './graph.js';
import { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { Watcher } from './watcher.js';
import { loadIgnorePatterns, isIgnored } from './ignore.js';
import type { WatchOptions } from './types.js';

function printUsage() {
  console.log('Usage: codes2graph <command> <path> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  watch <path>        Watch repo for changes and update graph');
  console.log('  clean <path>        Remove ignored files from Neo4j graph');
  console.log('');
  console.log('Watch options:');
  console.log('  --debounce <ms>     Quiet period before processing (default: 5000)');
  console.log('  --max-wait <ms>     Max wait before forced processing (default: 30000)');
  console.log('  --index-source      Store full source code in graph');
  console.log('  --skip-external     Skip unresolved external calls');
  console.log('');
  console.log('Clean options:');
  console.log('  --dry-run           Show what would be deleted without deleting');
}

async function cleanIgnored(repoPath: string, dryRun: boolean) {
  const config = loadConfig();
  const patterns = loadIgnorePatterns(repoPath);

  console.log('codes2graph — clean ignored files from graph');
  console.log(`Repository: ${repoPath}`);
  console.log(`Neo4j: ${config.neo4jUri}`);
  console.log(`Ignore patterns: ${patterns.length} rules loaded`);
  if (dryRun) console.log('Mode: DRY RUN (no deletions)');
  console.log('');

  const graph = new GraphClient(config);
  await graph.connect();

  try {
    // Query all File nodes under this repo
    const files = await graph.runCypher(
      'MATCH (f:File) WHERE f.path STARTS WITH $repoPath RETURN f.path AS path',
      { repoPath },
    );

    const toDelete: string[] = [];
    for (const row of files) {
      const filePath = row.path as string;
      const rel = relative(repoPath, filePath);
      if (isIgnored(rel, patterns)) {
        toDelete.push(filePath);
      }
    }

    if (toDelete.length === 0) {
      console.log('No ignored files found in graph. Nothing to clean.');
      return;
    }

    // Group by top-level ignored directory for display
    const dirCounts = new Map<string, number>();
    for (const p of toDelete) {
      const rel = relative(repoPath, p);
      const topDir = rel.split('/')[0];
      dirCounts.set(topDir, (dirCounts.get(topDir) || 0) + 1);
    }
    console.log(`Found ${toDelete.length} ignored files in graph:`);
    for (const [dir, count] of [...dirCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${dir}/ — ${count} files`);
    }
    console.log('');

    if (dryRun) {
      console.log('Dry run complete. Run without --dry-run to delete.');
      return;
    }

    // Delete in batches — each file plus all its CONTAINS children
    const BATCH_SIZE = 100;
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE);
      await graph.runCypher(
        `UNWIND $paths AS path
         OPTIONAL MATCH (f:File {path: path})-[:CONTAINS]->(child)
         DETACH DELETE child
         WITH f
         DETACH DELETE f
         RETURN count(f) AS deleted`,
        { paths: batch },
      );
      deleted += batch.length;
      process.stdout.write(`\rDeleted ${deleted}/${toDelete.length} files...`);
    }

    // Clean up orphaned Directory nodes under ignored paths
    await graph.runCypher(
      `MATCH (d:Directory)
       WHERE d.path STARTS WITH $repoPath
       AND NOT EXISTS { (d)-[:CONTAINS]->() }
       AND NOT EXISTS { ()-[:CONTAINS]->(d) }
       DETACH DELETE d`,
      { repoPath },
    );

    console.log(`\nDone. Removed ${deleted} ignored files and their contents from the graph.`);
  } finally {
    await graph.close();
  }
}

async function watch(repoPath: string, args: string[]) {
  const debounceQuiet = parseInt(args[args.indexOf('--debounce') + 1] || '5000', 10);
  const debounceMax = parseInt(args[args.indexOf('--max-wait') + 1] || '30000', 10);

  const config = loadConfig();
  const options: WatchOptions = {
    debounceQuiet,
    debounceMax,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    indexSource: args.includes('--index-source') || config.indexSource,
    skipExternal: args.includes('--skip-external') || config.skipExternal,
  };

  console.log('codes2graph — incremental code graph watcher');
  console.log(`Repository: ${repoPath}`);
  console.log(`Neo4j: ${config.neo4jUri}`);

  const graph = new GraphClient(config);
  await graph.connect();
  await graph.ensureSchema();
  await graph.createRepository(repoPath, basename(repoPath));

  const parser = new Parser();
  await parser.init();

  const symbolMap = new SymbolMap();
  const watcher = new Watcher(graph, parser, symbolMap, options);

  const shutdown = async () => {
    console.log('\nShutting down...');
    await watcher.stop();
    await graph.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await watcher.start(repoPath);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['watch', 'clean'].includes(command) || args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const repoPath = resolve(args[1]);

  if (command === 'clean') {
    await cleanIgnored(repoPath, args.includes('--dry-run'));
  } else {
    await watch(repoPath, args);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
