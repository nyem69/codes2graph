import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import picomatch from 'picomatch';

const DEFAULT_PATTERNS = [
  'node_modules',
  'node_modules/**',
  '.svelte-kit',
  '.svelte-kit/**',
  'coverage',
  'coverage/**',
  'dist',
  'dist/**',
  'build',
  'build/**',
  '.wrangler',
  '.wrangler/**',
  '.git',
  '.git/**',
  '.claude',
  '.claude/**',
  '**/*.min.js',
  '**/*.map',
];

export function loadIgnorePatterns(startPath: string): string[] {
  // Always start with defaults
  const patterns = [...DEFAULT_PATTERNS];

  // Find and merge .cgcignore if it exists
  let dir = resolve(startPath);
  while (true) {
    const candidate = resolve(dir, '.cgcignore');
    if (existsSync(candidate)) {
      const lines = readFileSync(candidate, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.replace(/^\/+/, '')); // strip leading slashes (gitignore-style root anchors)
      for (const p of lines) {
        if (p.endsWith('/')) {
          patterns.push(p.slice(0, -1));  // bare dir name
          patterns.push(p + '**');         // contents
        } else {
          patterns.push(p);
          // Also add bare dir for dir/** patterns
          if (p.endsWith('/**')) patterns.push(p.slice(0, -3));
        }
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return patterns;
}

export function isIgnored(relativePath: string, patterns: string[]): boolean {
  return picomatch.isMatch(relativePath, patterns, { dot: true });
}
