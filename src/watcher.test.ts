import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchDebouncer } from './watcher.js';

describe('BatchDebouncer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collects changes and fires after quiet period', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 500 });

    debouncer.add('/src/a.ts');
    debouncer.add('/src/b.ts');

    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(new Set(['/src/a.ts', '/src/b.ts']));
  });

  it('resets quiet timer on new events', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 500 });

    debouncer.add('/src/a.ts');
    await vi.advanceTimersByTimeAsync(80);
    debouncer.add('/src/b.ts');
    await vi.advanceTimersByTimeAsync(80);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forces processing at maxMs even if events keep coming', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 300 });

    for (let i = 0; i < 8; i++) {
      debouncer.add(`/src/file${i}.ts`);
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('deduplicates paths', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const debouncer = new BatchDebouncer(handler, { quietMs: 100, maxMs: 500 });

    debouncer.add('/src/a.ts');
    debouncer.add('/src/a.ts');
    debouncer.add('/src/a.ts');

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledWith(new Set(['/src/a.ts']));
  });
});
