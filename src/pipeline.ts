// src/pipeline.ts
import { existsSync } from 'fs';
import type { ParsedFile } from './types.js';
import type { GraphClient } from './graph.js';
import type { Parser } from './parser.js';
import type { SymbolMap } from './symbols.js';
import { resolveCallsForFile, resolveInheritanceForFile } from './resolver.js';

export interface PipelineOptions {
  indexSource: boolean;
  skipExternal: boolean;
}

export interface PipelineProgress {
  file: string;
  index: number;
  total: number;
  status: 'updated' | 'deleted' | 'error';
  error?: unknown;
}

/**
 * Process a batch of file paths through the parse → graph → resolve pipeline.
 * Shared by both the watcher (on file change) and the indexer (full scan).
 */
export async function processFiles(
  repoPath: string,
  filePaths: string[],
  graph: GraphClient,
  parser: Parser,
  symbolMap: SymbolMap,
  options: PipelineOptions,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<{ parsed: number; deleted: number; errors: number }> {
  // Phase 1: Clean old data
  for (const filePath of filePaths) {
    symbolMap.removeFile(filePath);
    await graph.deleteOutgoingCalls(filePath);
    await graph.deleteFile(filePath);
  }

  // Phase 2: Parse and write to graph
  const parsedFiles: ParsedFile[] = [];
  let deleted = 0;
  let errors = 0;

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];

    if (!existsSync(filePath)) {
      deleted++;
      onProgress?.({ file: filePath, index: i, total: filePaths.length, status: 'deleted' });
      continue;
    }

    try {
      const parsed = parser.parseFile(filePath, options.indexSource);
      symbolMap.addFile(filePath, parsed);
      await graph.addFileToGraph(parsed, repoPath);
      parsedFiles.push(parsed);
      onProgress?.({ file: filePath, index: i, total: filePaths.length, status: 'updated' });
    } catch (err) {
      errors++;
      onProgress?.({ file: filePath, index: i, total: filePaths.length, status: 'error', error: err });
    }
  }

  // Phase 3: Resolve cross-file relationships
  for (const parsed of parsedFiles) {
    const calls = resolveCallsForFile(parsed, symbolMap, options.skipExternal);
    for (const call of calls) {
      if (call.caller_name === '') {
        await graph.createFileLevelCallRelationship(
          call.caller_file_path, call.called_name, call.called_file_path,
          call.line_number, call.args, call.full_call_name,
        );
      } else {
        await graph.createCallRelationship(
          call.caller_name, call.caller_file_path, call.caller_line_number,
          call.called_name, call.called_file_path,
          call.line_number, call.args, call.full_call_name,
        );
      }
    }

    const inheritance = resolveInheritanceForFile(parsed, symbolMap);
    for (const inh of inheritance) {
      await graph.createInheritsRelationship(
        inh.child_name, inh.child_file_path, inh.parent_name, inh.parent_file_path,
      );
    }

    await graph.cleanStaleCallsTo(parsed.path);
  }

  return { parsed: parsedFiles.length, deleted, errors };
}
