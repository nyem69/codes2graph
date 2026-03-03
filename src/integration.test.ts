import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { GraphClient } from './graph.js';
import { Parser } from './parser.js';
import { SymbolMap } from './symbols.js';
import { resolveCallsForFile } from './resolver.js';
import { loadConfig } from './config.js';

const TEST_DIR = resolve(tmpdir(), 'codes2graph-test-' + Date.now());
const TEST_REPO = resolve(TEST_DIR, 'test-repo');

describe('Integration: full pipeline', () => {
  let graph: GraphClient;
  let parser: Parser;
  let neo4jAvailable = false;

  beforeAll(async () => {
    mkdirSync(join(TEST_REPO, 'src'), { recursive: true });

    writeFileSync(join(TEST_REPO, 'src', 'utils.ts'), `export function add(a: number, b: number): number {
  return a + b;
}

export class MathHelper {
  multiply(a: number, b: number): number {
    return a * b;
  }
}`);

    writeFileSync(join(TEST_REPO, 'src', 'main.ts'), `import { add, MathHelper } from './utils';

function main() {
  const result = add(1, 2);
  const helper = new MathHelper();
  console.log(result, helper.multiply(3, 4));
}`);

    const config = loadConfig();
    graph = new GraphClient(config);

    try {
      await graph.connect();
      neo4jAvailable = true;
      await graph.ensureSchema();
      await graph.createRepository(TEST_REPO, 'test-repo');
    } catch {
      // Neo4j not available — tests will be skipped
    }

    parser = new Parser();
    await parser.init();
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      await graph.runCypher(
        'MATCH (n) WHERE n.path STARTS WITH $prefix DETACH DELETE n',
        { prefix: TEST_REPO },
      );
      await graph.close();
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('parses and writes utils.ts to Neo4j', async () => {
    if (!neo4jAvailable) return;

    const parsed = parser.parseFile(join(TEST_REPO, 'src', 'utils.ts'));
    await graph.addFileToGraph(parsed, TEST_REPO);

    const functions = await graph.runCypher(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(fn:Function)
       RETURN fn.name as name ORDER BY fn.line_number`,
      { path: resolve(join(TEST_REPO, 'src', 'utils.ts')) },
    );
    expect(functions.map(r => r.name)).toEqual(['add', 'multiply']);

    const classes = await graph.runCypher(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(c:Class)
       RETURN c.name as name`,
      { path: resolve(join(TEST_REPO, 'src', 'utils.ts')) },
    );
    expect(classes.map(r => r.name)).toEqual(['MathHelper']);
  });

  it('resolves cross-file CALLS', async () => {
    if (!neo4jAvailable) return;

    const utilsParsed = parser.parseFile(join(TEST_REPO, 'src', 'utils.ts'));
    const mainParsed = parser.parseFile(join(TEST_REPO, 'src', 'main.ts'));
    await graph.addFileToGraph(mainParsed, TEST_REPO);

    const symbolMap = new SymbolMap();
    symbolMap.addFile(resolve(join(TEST_REPO, 'src', 'utils.ts')), utilsParsed);
    symbolMap.addFile(resolve(join(TEST_REPO, 'src', 'main.ts')), mainParsed);

    const calls = resolveCallsForFile(mainParsed, symbolMap, false);
    const addCall = calls.find(c => c.called_name === 'add');
    expect(addCall).toBeDefined();
    expect(addCall!.called_file_path).toContain('utils.ts');
  });

  it('survives file deletion and re-creation', async () => {
    if (!neo4jAvailable) return;

    const filePath = resolve(join(TEST_REPO, 'src', 'utils.ts'));

    await graph.deleteFile(filePath);
    const after = await graph.runCypher(
      'MATCH (f:File {path: $path}) RETURN f',
      { path: filePath },
    );
    expect(after).toHaveLength(0);

    const parsed = parser.parseFile(join(TEST_REPO, 'src', 'utils.ts'));
    await graph.addFileToGraph(parsed, TEST_REPO);
    const restored = await graph.runCypher(
      'MATCH (f:File {path: $path})-[:CONTAINS]->(fn:Function) RETURN fn.name as name',
      { path: filePath },
    );
    expect(restored.length).toBeGreaterThan(0);
  });
});
