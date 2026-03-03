#!/usr/bin/env node
import { resolve, basename } from 'path';
import { loadConfig } from './config.js';
import { GraphClient } from './graph.js';
import { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { Watcher } from './watcher.js';
import type { WatchOptions } from './types.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'watch' || args.length < 2) {
    console.log('Usage: codes2graph watch <path> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --debounce <ms>     Quiet period before processing (default: 5000)');
    console.log('  --max-wait <ms>     Max wait before forced processing (default: 30000)');
    console.log('  --index-source      Store full source code in graph');
    console.log('  --skip-external     Skip unresolved external calls');
    process.exit(1);
  }

  const repoPath = resolve(args[1]);

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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
