import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import picomatch from 'picomatch';

const DEFAULT_PATTERNS = [
  'node_modules/**',
  '.svelte-kit/**',
  'coverage/**',
  'dist/**',
  'build/**',
  '.git/**',
  '**/*.min.js',
  '**/*.map',
];

export function loadIgnorePatterns(startPath: string): string[] {
  let dir = resolve(startPath);
  while (true) {
    const candidate = resolve(dir, '.cgcignore');
    if (existsSync(candidate)) {
      const lines = readFileSync(candidate, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      return lines.map(p => p.endsWith('/') ? p + '**' : p);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return DEFAULT_PATTERNS;
}

export function isIgnored(relativePath: string, patterns: string[]): boolean {
  return picomatch.isMatch(relativePath, patterns, { dot: true });
}
