import { describe, it, expect } from 'vitest';
import { resolveCallsForFile, resolveInheritanceForFile } from './resolver.js';
import { SymbolMap } from './symbols.js';
import type { ParsedFile } from './types.js';

function makeSymbolMap(entries: Record<string, string[]>): SymbolMap {
  const map = new SymbolMap();
  const data = new Map<string, Set<string>>();
  for (const [sym, paths] of Object.entries(entries)) {
    data.set(sym, new Set(paths));
  }
  map.bootstrapFromMap(data);
  return map;
}

describe('resolveCallsForFile', () => {
  it('resolves local function calls', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [
        { name: 'main', line_number: 1, end_line: 5, args: [], cyclomatic_complexity: 1,
          decorators: [], context: null, context_type: null, class_context: null, lang: 'typescript', is_dependency: false },
        { name: 'helper', line_number: 6, end_line: 8, args: [], cyclomatic_complexity: 1,
          decorators: [], context: null, context_type: null, class_context: null, lang: 'typescript', is_dependency: false },
      ],
      classes: [], variables: [], imports: [],
      function_calls: [{
        name: 'helper', full_name: 'helper()', line_number: 3, args: [],
        inferred_obj_type: null, context: ['main', 'function_declaration', 1],
        class_context: [null, null], lang: 'typescript', is_dependency: false,
      }],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({});
    const resolved = resolveCallsForFile(file, symbolMap, false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].called_file_path).toBe('/src/a.ts');
    expect(resolved[0].called_name).toBe('helper');
  });

  it('resolves imported function calls via symbol map', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [
        { name: 'main', line_number: 1, end_line: 5, args: [], cyclomatic_complexity: 1,
          decorators: [], context: null, context_type: null, class_context: null, lang: 'typescript', is_dependency: false },
      ],
      classes: [], variables: [],
      imports: [{ name: 'render', source: './renderer', alias: null, line_number: 1, lang: 'typescript' }],
      function_calls: [{
        name: 'render', full_name: 'render()', line_number: 3, args: [],
        inferred_obj_type: null, context: ['main', 'function_declaration', 1],
        class_context: [null, null], lang: 'typescript', is_dependency: false,
      }],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({ render: ['/src/renderer.ts'] });
    const resolved = resolveCallsForFile(file, symbolMap, false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].called_file_path).toBe('/src/renderer.ts');
  });

  it('resolves this.method() calls to same file', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [
        { name: 'doWork', line_number: 3, end_line: 5, args: [], cyclomatic_complexity: 1,
          decorators: [], context: 'MyClass', context_type: 'class_declaration', class_context: 'MyClass', lang: 'typescript', is_dependency: false },
      ],
      classes: [
        { name: 'MyClass', line_number: 1, end_line: 10, bases: [], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
      ],
      variables: [], imports: [],
      function_calls: [{
        name: 'helper', full_name: 'this.helper()', line_number: 4, args: [],
        inferred_obj_type: null, context: ['doWork', 'method_definition', 3],
        class_context: ['MyClass', 'class_declaration'], lang: 'typescript', is_dependency: false,
      }],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({});
    const resolved = resolveCallsForFile(file, symbolMap, false);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].called_file_path).toBe('/src/a.ts');
  });
});

describe('resolveInheritanceForFile', () => {
  it('resolves local class inheritance', () => {
    const file: ParsedFile = {
      path: '/src/a.ts', lang: 'typescript',
      functions: [], variables: [], imports: [], function_calls: [],
      classes: [
        { name: 'Base', line_number: 1, end_line: 3, bases: [], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
        { name: 'Child', line_number: 5, end_line: 8, bases: ['Base'], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
      ],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({});
    const resolved = resolveInheritanceForFile(file, symbolMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].parent_name).toBe('Base');
    expect(resolved[0].parent_file_path).toBe('/src/a.ts');
  });

  it('resolves imported class inheritance via symbol map', () => {
    const file: ParsedFile = {
      path: '/src/b.ts', lang: 'typescript',
      functions: [], variables: [], function_calls: [],
      imports: [{ name: 'BaseComponent', source: './base', alias: null, line_number: 1, lang: 'typescript' }],
      classes: [
        { name: 'MyWidget', line_number: 3, end_line: 10, bases: ['BaseComponent'], decorators: [],
          context: null, lang: 'typescript', is_dependency: false },
      ],
      is_dependency: false,
    };

    const symbolMap = makeSymbolMap({ BaseComponent: ['/src/base.ts'] });
    const resolved = resolveInheritanceForFile(file, symbolMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].parent_file_path).toBe('/src/base.ts');
  });
});
