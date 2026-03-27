import type { ParsedFile, ParsedImport, ResolvedCall, ResolvedInheritance } from './types.js';
import type { SymbolMap } from './symbols.js';

function buildImportMap(imports: ParsedImport[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const imp of imports) {
    const key = imp.alias || imp.name.split('.').pop()!;
    map[key] = imp.source;
  }
  return map;
}

/**
 * Resolve CALLS for a single file.
 * Port of CGC graph_builder.py:456-620 _create_function_calls
 *
 * Resolution priority (matches CGC):
 * 1. Local context (this/self/super) -> same file
 * 2. Local definition -> same file
 * 3. Import map -> imported module's file
 * 4. Global symbol map -> any file defining that symbol
 */
export function resolveCallsForFile(
  file: ParsedFile,
  symbolMap: SymbolMap,
  skipExternal: boolean,
): ResolvedCall[] {
  const callerFilePath = file.path;
  const localNames = new Set([
    ...file.functions.map(f => f.name),
    ...file.classes.map(c => c.name),
  ]);
  const localImports = buildImportMap(file.imports);

  const resolved: ResolvedCall[] = [];

  for (const call of file.function_calls) {
    const calledName = call.name;
    const fullCall = call.full_name || calledName;
    const baseObj = fullCall.includes('.') ? fullCall.split('.')[0] : null;
    const isChainedCall = fullCall.includes('.') ? fullCall.split('.').length > 2 : false;

    const lookupName = (isChainedCall && baseObj && ['self', 'this', 'super', 'super()', 'cls', '@'].includes(baseObj))
      ? calledName
      : (baseObj || calledName);

    let resolvedPath: string | null = null;

    // 1. Local context keywords (self/this/super) -- direct calls only
    if (baseObj && ['self', 'this', 'super', 'super()', 'cls', '@'].includes(baseObj) && !isChainedCall) {
      resolvedPath = callerFilePath;
    } else if (localNames.has(lookupName)) {
      resolvedPath = callerFilePath;
    }

    // 2. Inferred type
    if (!resolvedPath && call.inferred_obj_type) {
      const paths = symbolMap.resolve(call.inferred_obj_type);
      if (paths.length > 0) resolvedPath = paths[0];
    }

    // 3. Imports map lookup
    if (!resolvedPath) {
      const possiblePaths = symbolMap.resolve(lookupName);
      if (possiblePaths.length === 1) {
        resolvedPath = possiblePaths[0];
      } else if (possiblePaths.length > 1 && lookupName in localImports) {
        const fullImportName = localImports[lookupName];
        for (const path of possiblePaths) {
          if (path.includes(fullImportName.replace(/\./g, '/'))) {
            resolvedPath = path;
            break;
          }
        }
      }
    }

    // 4. Legacy fallback: check calledName directly
    if (!resolvedPath) {
      if (localNames.has(calledName)) {
        resolvedPath = callerFilePath;
      } else {
        const candidates = symbolMap.resolve(calledName);
        if (candidates.length > 0) {
          resolvedPath = candidates[0];
        }
        // If still unresolved, skip this call (don't self-reference)
        if (!resolvedPath) continue;
      }
    }

    if (skipExternal && resolvedPath === callerFilePath && !localNames.has(calledName)) {
      continue;
    }

    const context = call.context;
    if (context && context[0] !== null && context[1] !== null && context[2] !== null) {
      resolved.push({
        caller_name: context[0],
        caller_file_path: callerFilePath,
        caller_line_number: context[2],
        called_name: calledName,
        called_file_path: resolvedPath,
        line_number: call.line_number,
        args: call.args,
        full_call_name: fullCall,
      });
    } else {
      // File-level call (no function context) -- handled separately by graph client
      resolved.push({
        caller_name: '',  // empty = file-level
        caller_file_path: callerFilePath,
        caller_line_number: 0,
        called_name: calledName,
        called_file_path: resolvedPath,
        line_number: call.line_number,
        args: call.args,
        full_call_name: fullCall,
      });
    }
  }

  return resolved;
}

/**
 * Resolve INHERITS for a single file.
 * Port of CGC graph_builder.py:628-690 _create_inheritance_links
 */
export function resolveInheritanceForFile(
  file: ParsedFile,
  symbolMap: SymbolMap,
): ResolvedInheritance[] {
  const callerFilePath = file.path;
  const localClassNames = new Set(file.classes.map(c => c.name));
  const localImports = buildImportMap(file.imports);

  const resolved: ResolvedInheritance[] = [];

  for (const cls of file.classes) {
    if (!cls.bases || cls.bases.length === 0) continue;

    for (const baseStr of cls.bases) {
      if (baseStr === 'object') continue;

      let resolvedPath: string | null = null;
      const targetName = baseStr.split('.').pop()!;

      if (baseStr.includes('.')) {
        // Qualified name: module.Class
        const prefix = baseStr.split('.')[0];
        if (prefix in localImports) {
          const fullImport = localImports[prefix];
          const candidates = symbolMap.resolve(targetName);
          for (const path of candidates) {
            if (path.includes(fullImport.replace(/\./g, '/'))) {
              resolvedPath = path;
              break;
            }
          }
        }
      } else {
        // Simple name
        if (localClassNames.has(baseStr)) {
          resolvedPath = callerFilePath;
        } else if (baseStr in localImports) {
          const candidates = symbolMap.resolve(targetName);
          if (candidates.length === 1) {
            resolvedPath = candidates[0];
          } else if (candidates.length > 1) {
            const importSource = localImports[baseStr];
            for (const path of candidates) {
              if (path.includes(importSource.replace(/\./g, '/'))) {
                resolvedPath = path;
                break;
              }
            }
            if (!resolvedPath) resolvedPath = candidates[0];
          }
        } else {
          const candidates = symbolMap.resolve(baseStr);
          if (candidates.length === 1) resolvedPath = candidates[0];
        }
      }

      if (resolvedPath) {
        resolved.push({
          child_name: cls.name,
          child_file_path: callerFilePath,
          parent_name: targetName,
          parent_file_path: resolvedPath,
        });
      }
    }
  }

  return resolved;
}
