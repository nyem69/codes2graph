import { describe, it, expect } from 'vitest';
import { loadIgnorePatterns, isIgnored } from './ignore.js';

describe('ignore patterns', () => {
  it('returns default patterns when no .cgcignore exists', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(patterns).toContain('node_modules/**');
    expect(patterns).toContain('.git/**');
  });

  it('matches node_modules paths', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('node_modules/foo/bar.ts', patterns)).toBe(true);
    expect(isIgnored('src/index.ts', patterns)).toBe(false);
  });

  it('matches .svelte-kit paths', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('.svelte-kit/output/server.js', patterns)).toBe(true);
  });

  it('matches minified files', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('vendor/lib.min.js', patterns)).toBe(true);
    expect(isIgnored('src/lib.js', patterns)).toBe(false);
  });

  it('matches bare directory names (for chokidar early skip)', () => {
    const patterns = loadIgnorePatterns('/nonexistent/path');
    expect(isIgnored('node_modules', patterns)).toBe(true);
    expect(isIgnored('.svelte-kit', patterns)).toBe(true);
    expect(isIgnored('.git', patterns)).toBe(true);
    expect(isIgnored('src', patterns)).toBe(false);
  });
});
