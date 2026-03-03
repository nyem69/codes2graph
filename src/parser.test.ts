// src/parser.test.ts — Tests for tree-sitter parser
import { describe, it, expect, beforeAll } from 'vitest';
import { Parser } from './parser.js';

describe('Parser', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = new Parser();
    await parser.init();
  });

  describe('TypeScript parsing', () => {
    it('extracts function declarations', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function greet(name: string): string {
  return "hello " + name;
}

const add = (a: number, b: number) => a + b;
      `);

      expect(result.functions).toHaveLength(2);
      expect(result.functions[0].name).toBe('greet');
      expect(result.functions[0].args).toEqual(['name']);
      expect(result.functions[0].line_number).toBe(2);
      expect(result.functions[1].name).toBe('add');
      expect(result.functions[1].args).toEqual(['a', 'b']);
    });

    it('extracts arrow functions with single parameter (no parens)', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const double = x => x * 2;
      `);

      expect(result.functions).toHaveLength(1);
      expect(result.functions[0].name).toBe('double');
      expect(result.functions[0].args).toEqual(['x']);
    });

    it('extracts method definitions in classes', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
class Greeter {
  greet(name: string) {
    return "hello " + name;
  }
}
      `);

      const method = result.functions.find(f => f.name === 'greet');
      expect(method).toBeDefined();
      expect(method!.args).toEqual(['name']);
      expect(method!.context).toBe('Greeter');
      expect(method!.context_type).toBe('class_declaration');
      expect(method!.class_context).toBe('Greeter');
    });

    it('extracts function expressions assigned to variables', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const handler = function(req: Request, res: Response) {
  return res.send("ok");
};
      `);

      expect(result.functions).toHaveLength(1);
      expect(result.functions[0].name).toBe('handler');
      expect(result.functions[0].args).toEqual(['req', 'res']);
    });

    it('extracts classes with inheritance (extends)', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
class Animal {
  constructor(public name: string) {}
}

class Dog extends Animal {
  bark() { return "woof"; }
}
      `);

      expect(result.classes).toHaveLength(2);
      expect(result.classes[0].name).toBe('Animal');
      expect(result.classes[0].bases).toEqual([]);
      expect(result.classes[1].name).toBe('Dog');
      expect(result.classes[1].bases).toEqual(['Animal']);
    });

    it('extracts classes with implements', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
interface Serializable {
  serialize(): string;
}

class User implements Serializable {
  serialize() { return JSON.stringify(this); }
}
      `);

      const userClass = result.classes.find(c => c.name === 'User');
      expect(userClass).toBeDefined();
      expect(userClass!.bases).toContain('Serializable');
    });

    it('extracts named imports', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
import { readFile } from 'fs';
import path from 'path';
import * as utils from './utils';
      `);

      expect(result.imports).toHaveLength(3);
      expect(result.imports[0]).toMatchObject({ name: 'readFile', source: 'fs' });
      expect(result.imports[1]).toMatchObject({ name: 'default', source: 'path', alias: 'path' });
      expect(result.imports[2]).toMatchObject({ name: '*', source: './utils', alias: 'utils' });
    });

    it('extracts aliased imports', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
import { readFile as rf, writeFile } from 'fs';
      `);

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0]).toMatchObject({ name: 'readFile', alias: 'rf', source: 'fs' });
      expect(result.imports[1]).toMatchObject({ name: 'writeFile', alias: null, source: 'fs' });
    });

    it('extracts function calls', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function main() {
  const x = greet("world");
  console.log(x);
}
      `);

      const callNames = result.function_calls.map(c => c.name);
      expect(callNames).toContain('greet');
      expect(callNames).toContain('log');
    });

    it('extracts function call arguments', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
greet("world", 42);
      `);

      const greetCall = result.function_calls.find(c => c.name === 'greet');
      expect(greetCall).toBeDefined();
      expect(greetCall!.args).toEqual(['"world"', '42']);
    });

    it('extracts new expression calls', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const dog = new Dog("Rex");
      `);

      const dogCall = result.function_calls.find(c => c.name === 'Dog');
      expect(dogCall).toBeDefined();
      expect(dogCall!.args).toEqual(['"Rex"']);
    });

    it('provides call context (enclosing function)', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function main() {
  greet("world");
}
      `);

      const greetCall = result.function_calls.find(c => c.name === 'greet');
      expect(greetCall).toBeDefined();
      expect(greetCall!.context[0]).toBe('main');
      expect(greetCall!.context[1]).toBe('function_declaration');
    });

    it('extracts variables (not function-assigned)', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const PI = 3.14;
const greet = () => "hi";
let count = 0;
      `);

      // greet should NOT be in variables (it's a function)
      const varNames = result.variables.map(v => v.name);
      expect(varNames).toContain('PI');
      expect(varNames).toContain('count');
      expect(varNames).not.toContain('greet');
    });

    it('extracts variable values', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const PI = 3.14;
const name = "world";
      `);

      const pi = result.variables.find(v => v.name === 'PI');
      expect(pi).toBeDefined();
      expect(pi!.value).toBe('3.14');

      const nameVar = result.variables.find(v => v.name === 'name');
      expect(nameVar).toBeDefined();
      expect(nameVar!.value).toBe('"world"');
    });

    it('calculates cyclomatic complexity', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function complex(x: number) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      if (i % 2 === 0) {
        console.log(i);
      }
    }
  } else {
    while (x < 0) {
      x++;
    }
  }
}
      `);

      // Base 1 + if + for + if + while + binary_expressions for comparisons
      const fn = result.functions.find(f => f.name === 'complex');
      expect(fn).toBeDefined();
      expect(fn!.cyclomatic_complexity).toBeGreaterThanOrEqual(4);
    });

    it('calculates complexity = 1 for simple function', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function simple() {
  return 42;
}
      `);

      const fn = result.functions.find(f => f.name === 'simple');
      expect(fn).toBeDefined();
      expect(fn!.cyclomatic_complexity).toBe(1);
    });

    it('extracts interfaces', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
interface User {
  id: string;
  name: string;
}
      `);

      expect(result.interfaces).toHaveLength(1);
      expect(result.interfaces![0].name).toBe('User');
      expect(result.interfaces![0].line_number).toBe(2);
    });

    it('extracts type aliases', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
type ID = string | number;
type UserMap = Map<string, User>;
      `);

      expect(result.type_aliases).toHaveLength(2);
      expect(result.type_aliases![0].name).toBe('ID');
      expect(result.type_aliases![1].name).toBe('UserMap');
    });

    it('sets correct lang and path on ParsedFile', () => {
      const result = parser.parseSource('/src/app.ts', 'typescript', `const x = 1;`);

      expect(result.path).toBe('/src/app.ts');
      expect(result.lang).toBe('typescript');
      expect(result.is_dependency).toBe(false);
    });

    it('includes source when indexSource is true', () => {
      const source = `function hello() { return 1; }`;
      const result = parser.parseSource('/test/file.ts', 'typescript', source, true);

      expect(result.functions[0].source).toBeDefined();
      expect(result.functions[0].source).toContain('function hello');
    });

    it('does not include source when indexSource is false', () => {
      const source = `function hello() { return 1; }`;
      const result = parser.parseSource('/test/file.ts', 'typescript', source, false);

      expect(result.functions[0].source).toBeUndefined();
    });
  });

  describe('preScanFile', () => {
    it('returns symbol names for functions and classes', () => {
      const names = parser.preScanFile('/test/file.ts', `
function greet() {}
class Dog {}
const add = () => 1;
interface User {}
type ID = string;
      `, 'typescript');

      expect(names).toContain('greet');
      expect(names).toContain('Dog');
      expect(names).toContain('add');
      expect(names).toContain('User');
      expect(names).toContain('ID');
    });

    it('skips non-function variable declarations', () => {
      const names = parser.preScanFile('/test/file.ts', `
const PI = 3.14;
const add = () => 1;
      `, 'typescript');

      expect(names).toContain('add');
      expect(names).not.toContain('PI');
    });
  });

  describe('JavaScript parsing', () => {
    it('extracts functions from JavaScript', () => {
      const result = parser.parseSource('/test/file.js', 'javascript', `
function greet(name) {
  return "hello " + name;
}

const add = (a, b) => a + b;
      `);

      expect(result.lang).toBe('javascript');
      expect(result.functions).toHaveLength(2);
      expect(result.functions[0].name).toBe('greet');
      expect(result.functions[0].args).toEqual(['name']);
      expect(result.functions[1].name).toBe('add');
      expect(result.functions[1].args).toEqual(['a', 'b']);
    });

    it('does not include interfaces/type_aliases for JavaScript', () => {
      const result = parser.parseSource('/test/file.js', 'javascript', `const x = 1;`);

      expect(result.interfaces).toBeUndefined();
      expect(result.type_aliases).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = parser.parseSource('/test/empty.ts', 'typescript', '');

      expect(result.functions).toEqual([]);
      expect(result.classes).toEqual([]);
      expect(result.variables).toEqual([]);
      expect(result.imports).toEqual([]);
      expect(result.function_calls).toEqual([]);
    });

    it('handles rest parameters', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
function log(...args: any[]) {
  console.log(args);
}
      `);

      const fn = result.functions.find(f => f.name === 'log');
      expect(fn).toBeDefined();
      expect(fn!.args).toEqual(['...args']);
    });

    it('handles require() imports', () => {
      const result = parser.parseSource('/test/file.ts', 'typescript', `
const fs = require('fs');
      `);

      const fsImport = result.imports.find(i => i.source === 'fs');
      expect(fsImport).toBeDefined();
      expect(fsImport!.alias).toBe('fs');
    });
  });
});
