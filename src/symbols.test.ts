import { describe, it, expect } from 'vitest';
import { SymbolMap } from './symbols.js';
import type { ParsedFile } from './types.js';

function makeParsedFile(path: string, funcNames: string[], classNames: string[] = []): ParsedFile {
  return {
    path,
    lang: 'typescript',
    functions: funcNames.map((n, i) => ({
      name: n, line_number: i + 1, end_line: i + 2, args: [],
      cyclomatic_complexity: 1, decorators: [], context: null,
      context_type: null, class_context: null, lang: 'typescript', is_dependency: false,
    })),
    classes: classNames.map((n, i) => ({
      name: n, line_number: i + 1, end_line: i + 2, bases: [],
      decorators: [], context: null, lang: 'typescript', is_dependency: false,
    })),
    variables: [], imports: [], function_calls: [], is_dependency: false,
  };
}

describe('SymbolMap', () => {
  it('adds and resolves symbols', () => {
    const map = new SymbolMap();
    const file = makeParsedFile('/src/utils.ts', ['greet', 'add'], ['Helper']);
    map.addFile('/src/utils.ts', file);
    expect(map.resolve('greet')).toEqual(['/src/utils.ts']);
    expect(map.resolve('Helper')).toEqual(['/src/utils.ts']);
    expect(map.resolve('nonexistent')).toEqual([]);
  });

  it('removes symbols on file change', () => {
    const map = new SymbolMap();
    map.addFile('/src/a.ts', makeParsedFile('/src/a.ts', ['shared']));
    map.addFile('/src/b.ts', makeParsedFile('/src/b.ts', ['shared', 'unique']));
    map.removeFile('/src/a.ts');
    expect(map.resolve('shared')).toEqual(['/src/b.ts']);
    expect(map.resolve('unique')).toEqual(['/src/b.ts']);
  });

  it('handles multiple files defining same symbol', () => {
    const map = new SymbolMap();
    map.addFile('/src/a.ts', makeParsedFile('/src/a.ts', ['render']));
    map.addFile('/src/b.ts', makeParsedFile('/src/b.ts', ['render']));
    const paths = map.resolve('render');
    expect(paths).toHaveLength(2);
    expect(paths).toContain('/src/a.ts');
    expect(paths).toContain('/src/b.ts');
  });

  it('bootstraps from a pre-built map', () => {
    const map = new SymbolMap();
    const prebuilt = new Map<string, Set<string>>();
    prebuilt.set('foo', new Set(['/a.ts', '/b.ts']));
    prebuilt.set('bar', new Set(['/c.ts']));
    map.bootstrapFromMap(prebuilt);
    expect(map.resolve('foo')).toHaveLength(2);
    expect(map.resolve('bar')).toEqual(['/c.ts']);
  });
});
