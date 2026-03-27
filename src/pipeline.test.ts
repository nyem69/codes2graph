// src/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processFiles, type PipelineProgress } from './pipeline.js';

describe('processFiles', () => {
  it('calls onProgress for each file with correct index and total', async () => {
    const mockGraph = {
      deleteOutgoingCalls: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      addFileToGraph: vi.fn().mockResolvedValue(undefined),
      createCallRelationship: vi.fn().mockResolvedValue(undefined),
      createFileLevelCallRelationship: vi.fn().mockResolvedValue(undefined),
      createCallRelationshipsBatch: vi.fn().mockResolvedValue(undefined),
      createInheritsRelationship: vi.fn().mockResolvedValue(undefined),
      createInheritsRelationshipsBatch: vi.fn().mockResolvedValue(undefined),
      cleanStaleCallsTo: vi.fn().mockResolvedValue(undefined),
    };

    const mockParser = {
      parseFile: vi.fn().mockReturnValue({
        path: '/repo/src/a.ts',
        lang: 'typescript',
        functions: [],
        classes: [],
        variables: [],
        imports: [],
        function_calls: [],
        is_dependency: false,
      }),
    };

    const mockSymbolMap = {
      removeFile: vi.fn(),
      addFile: vi.fn(),
    };

    const progress: PipelineProgress[] = [];

    // /repo/src/a.ts doesn't exist on disk, so it will be treated as deleted
    const result = await processFiles(
      '/repo',
      ['/repo/src/a.ts'],
      mockGraph as any,
      mockParser as any,
      mockSymbolMap as any,
      { indexSource: false, skipExternal: false },
      (p) => progress.push(p),
    );

    expect(result.deleted).toBe(1);
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe('deleted');
    expect(progress[0].index).toBe(0);
    expect(progress[0].total).toBe(1);
  });
});
