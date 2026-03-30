#!/usr/bin/env node
import { resolve, basename, relative } from 'path';
import { readFileSync } from 'fs';
import { loadConfig } from './config.js';
import { GraphClient } from './graph.js';
import { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { Watcher } from './watcher.js';
import { Indexer } from './indexer.js';
import { loadIgnorePatterns, isIgnored } from './ignore.js';
import type { WatchOptions } from './types.js';

function printUsage() {
  console.log('Usage: codes2graph <command> <path> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  index <path>        Full index of a repo into Neo4j');
  console.log('  watch <path>        Watch repo for changes and update graph');
  console.log('  clean <path>        Remove ignored files from Neo4j graph');
  console.log('  stats               Show graph statistics grouped by repo');
  console.log('');
  console.log('Index options:');
  console.log('  --force             Wipe existing graph data for this repo first');
  console.log('  --batch-size <n>    Files per batch (default: 50)');
  console.log('  --index-source      Store full source code in graph');
  console.log('  --skip-external     Skip unresolved external calls');
  console.log('');
  console.log('Watch options:');
  console.log('  --debounce <ms>     Quiet period before processing (default: 5000)');
  console.log('  --max-wait <ms>     Max wait before forced processing (default: 30000)');
  console.log('  --index-source      Store full source code in graph');
  console.log('  --skip-external     Skip unresolved external calls');
  console.log('');
  console.log('Clean options:');
  console.log('  --dry-run           Show what would be deleted without deleting');
  console.log('');
  console.log('Environment:');
  console.log('  NEO4J_URI             Neo4j connection URI (default: bolt://localhost:7687)');
  console.log('  NEO4J_USERNAME        Neo4j username (default: neo4j)');
  console.log('  NEO4J_PASSWORD        Neo4j password');
  console.log('');
  console.log('Config files (in priority order):');
  console.log('  .env                  Local project config');
  console.log('  ~/.codegraphcontext/.env  CGC shared config');
}

function warnUnencryptedRemote(neo4jUri: string) {
  try {
    const uri = new URL(neo4jUri.replace('bolt://', 'http://').replace('neo4j://', 'http://'));
    if (!neo4jUri.includes('+s') && uri.hostname !== 'localhost' && uri.hostname !== '127.0.0.1' && uri.hostname !== '::1') {
      console.warn('Warning: Neo4j connection is not encrypted. Use bolt+s:// for remote servers.');
    }
  } catch {
    // Ignore URL parse errors
  }
}

async function cleanIgnored(repoPath: string, dryRun: boolean) {
  const config = loadConfig();
  const patterns = loadIgnorePatterns(repoPath);

  console.log('codes2graph — clean ignored files from graph');
  console.log(`Repository: ${repoPath}`);
  console.log(`Neo4j: ${config.neo4jUri}`);
  console.log(`Config: ${config.configSource}`);
  console.log(`Ignore patterns: ${patterns.length} rules loaded`);
  if (dryRun) console.log('Mode: DRY RUN (no deletions)');
  console.log('');

  const graph = new GraphClient(config);

  process.on('SIGINT', async () => {
    console.log('\nInterrupted.');
    try { await graph.close(); } catch {}
    process.exit(130);
  });

  try {
    await graph.connect();
  } catch (err) {
    console.error(`Error: Could not connect to Neo4j at ${config.neo4jUri}`);
    console.error(`Is Neo4j running? Check your config at ${config.configSource}`);
    process.exit(1);
  }

  warnUnencryptedRemote(config.neo4jUri);

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

async function index(repoPath: string, args: string[]) {
  const config = loadConfig();
  const batchSizeIdx = args.indexOf('--batch-size');
  const batchSize = batchSizeIdx !== -1 ? parseInt(args[batchSizeIdx + 1], 10) : 50;

  if (isNaN(batchSize) || batchSize <= 0) {
    console.error('Error: --batch-size must be a positive integer');
    process.exit(1);
  }

  console.log('codes2graph — full index');
  console.log(`Repository: ${repoPath}`);
  console.log(`Neo4j: ${config.neo4jUri}`);
  console.log(`Config: ${config.configSource}`);

  const graph = new GraphClient(config);

  process.on('SIGINT', async () => {
    console.log('\nInterrupted.');
    try { await graph.close(); } catch {}
    process.exit(130);
  });

  try {
    await graph.connect();
  } catch (err) {
    console.error(`Error: Could not connect to Neo4j at ${config.neo4jUri}`);
    console.error(`Is Neo4j running? Check your config at ${config.configSource}`);
    process.exit(1);
  }

  warnUnencryptedRemote(config.neo4jUri);

  await graph.ensureSchema();
  await graph.createRepository(repoPath, basename(repoPath));

  const parser = new Parser();
  await parser.init();

  const indexer = new Indexer(graph, parser, {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    indexSource: args.includes('--index-source') || config.indexSource,
    skipExternal: args.includes('--skip-external') || config.skipExternal,
    batchSize,
    force: args.includes('--force'),
  });

  try {
    await indexer.run(repoPath);
  } finally {
    await graph.close();
  }
}

async function watch(repoPath: string, args: string[]) {
  const debounceIdx = args.indexOf('--debounce');
  const debounceQuiet = debounceIdx !== -1 ? parseInt(args[debounceIdx + 1], 10) : 5000;
  const maxWaitIdx = args.indexOf('--max-wait');
  const debounceMax = maxWaitIdx !== -1 ? parseInt(args[maxWaitIdx + 1], 10) : 30000;

  if (isNaN(debounceQuiet) || debounceQuiet <= 0) {
    console.error('Error: --debounce must be a positive integer');
    process.exit(1);
  }
  if (isNaN(debounceMax) || debounceMax <= 0) {
    console.error('Error: --max-wait must be a positive integer');
    process.exit(1);
  }

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
  console.log(`Config: ${config.configSource}`);

  const graph = new GraphClient(config);

  try {
    await graph.connect();
  } catch (err) {
    console.error(`Error: Could not connect to Neo4j at ${config.neo4jUri}`);
    console.error(`Is Neo4j running? Check your config at ${config.configSource}`);
    process.exit(1);
  }

  warnUnencryptedRemote(config.neo4jUri);

  await graph.ensureSchema();
  await graph.createRepository(repoPath, basename(repoPath));

  const parser = new Parser();
  await parser.init();

  const symbolMap = new SymbolMap();
  const watcher = new Watcher(graph, parser, symbolMap, options);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    try { await watcher.stop(); } catch {}
    try { await graph.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await watcher.start(repoPath);
}

async function stats() {
  const config = loadConfig();
  const graph = new GraphClient(config);

  try {
    await graph.connect();
  } catch {
    console.error(`Error: Could not connect to Neo4j at ${config.neo4jUri}`);
    process.exit(1);
  }

  try {
    // Per-repo stats
    const repos = await graph.runCypher(`
      MATCH (r:Repository)
      OPTIONAL MATCH (r)-[:CONTAINS*]->(f:File)
      WITH r.name AS repo, r.path AS path, count(DISTINCT f) AS files
      ORDER BY files DESC
      RETURN repo, path, files
    `);

    // Per-repo function/class/variable/interface counts
    const perRepo = await graph.runCypher(`
      MATCH (r:Repository)
      OPTIONAL MATCH (fn:Function) WHERE fn.path STARTS WITH r.path
      WITH r.name AS repo, r.path AS path, count(DISTINCT fn) AS functions
      OPTIONAL MATCH (c:Class) WHERE c.path STARTS WITH path
      WITH repo, path, functions, count(DISTINCT c) AS classes
      OPTIONAL MATCH (v:Variable) WHERE v.path STARTS WITH path
      WITH repo, path, functions, classes, count(DISTINCT v) AS variables
      OPTIONAL MATCH (i:Interface) WHERE i.path STARTS WITH path
      RETURN repo, functions, classes, variables, count(DISTINCT i) AS interfaces
      ORDER BY functions DESC
    `);

    // Merge into one table
    const repoMap = new Map<string, Record<string, unknown>>();
    for (const r of repos) repoMap.set(r.repo as string, { ...r });
    for (const r of perRepo) {
      const existing = repoMap.get(r.repo as string) || {};
      repoMap.set(r.repo as string, { ...existing, ...r });
    }

    // Total counts
    const totals = await graph.runCypher(`
      MATCH (n)
      WITH labels(n)[0] AS label, count(n) AS cnt
      RETURN label, cnt ORDER BY cnt DESC
    `);

    // Print per-repo table
    console.log('\ncodes2graph — graph statistics\n');

    // Header
    const pad = (s: string, n: number) => s.padEnd(n);
    const rpad = (s: string, n: number) => s.padStart(n);
    console.log(
      pad('Repository', 22) +
      rpad('Files', 8) +
      rpad('Functions', 11) +
      rpad('Classes', 9) +
      rpad('Variables', 11) +
      rpad('Interfaces', 12)
    );
    console.log('-'.repeat(73));

    let totalFiles = 0, totalFn = 0, totalCls = 0, totalVar = 0, totalIface = 0;
    for (const [name, data] of repoMap) {
      const files = (data.files as number) || 0;
      const fn = (data.functions as number) || 0;
      const cls = (data.classes as number) || 0;
      const vars = (data.variables as number) || 0;
      const ifaces = (data.interfaces as number) || 0;
      totalFiles += files; totalFn += fn; totalCls += cls; totalVar += vars; totalIface += ifaces;
      console.log(
        pad(name, 22) +
        rpad(String(files), 8) +
        rpad(String(fn), 11) +
        rpad(String(cls), 9) +
        rpad(String(vars), 11) +
        rpad(String(ifaces), 12)
      );
    }
    console.log('-'.repeat(73));
    console.log(
      pad('TOTAL', 22) +
      rpad(String(totalFiles), 8) +
      rpad(String(totalFn), 11) +
      rpad(String(totalCls), 9) +
      rpad(String(totalVar), 11) +
      rpad(String(totalIface), 12)
    );

    // Node type summary
    console.log('\nNode counts:');
    for (const t of totals) {
      console.log(`  ${pad(t.label as string, 14)} ${t.cnt}`);
    }

    console.log(`\nConfig: ${config.configSource}`);
  } finally {
    await graph.close();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
  }

  const command = args[0];

  if (command === 'stats') {
    await stats();
    return;
  }

  if (!command || !['index', 'watch', 'clean'].includes(command) || args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const repoPath = resolve(args[1]);

  if (command === 'index') {
    await index(repoPath, args);
  } else if (command === 'clean') {
    await cleanIgnored(repoPath, args.includes('--dry-run'));
  } else {
    await watch(repoPath, args);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
