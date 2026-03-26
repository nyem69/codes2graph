// src/indexer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { Indexer } from './indexer.js';

const TEST_DIR = resolve(tmpdir(), 'codes2graph-indexer-test-' + Date.now());

describe('Indexer.discoverFiles', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DIR, 'src', 'lib'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'dist'), { recursive: true });

    writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(TEST_DIR, 'src', 'lib', 'utils.ts'), 'export function add() {}');
    writeFileSync(join(TEST_DIR, 'src', 'styles.css'), 'body {}');
    writeFileSync(join(TEST_DIR, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
    writeFileSync(join(TEST_DIR, 'dist', 'bundle.js'), 'var x = 1;');
    writeFileSync(join(TEST_DIR, 'README.md'), '# Test');
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('finds .ts and .js files, ignores node_modules and dist', () => {
    const indexer = new Indexer(null as any, null as any, {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      indexSource: false,
      skipExternal: false,
      batchSize: 50,
      force: false,
    });

    const files = indexer.discoverFiles(TEST_DIR);
    const relative = files.map(f => f.replace(TEST_DIR + '/', ''));

    expect(relative).toContain('src/index.ts');
    expect(relative).toContain('src/lib/utils.ts');
    expect(relative).not.toContain('src/styles.css');
    expect(relative).not.toContain('node_modules/pkg/index.js');
    expect(relative).not.toContain('dist/bundle.js');
    expect(relative).not.toContain('README.md');
  });

  it('returns sorted file paths', () => {
    const indexer = new Indexer(null as any, null as any, {
      extensions: ['.ts'],
      indexSource: false,
      skipExternal: false,
      batchSize: 50,
      force: false,
    });

    const files = indexer.discoverFiles(TEST_DIR);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });
});
