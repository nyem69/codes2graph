// src/graph.ts
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type { Config } from './config.js';
import type { ParsedFile, ParsedFunction } from './types.js';
import type { ResolvedCall, ResolvedInheritance } from './types.js';
import { resolve, relative, basename } from 'path';

// Fix 16: Label whitelist validation for Cypher interpolation safety
const VALID_LABELS = new Set([
  'Repository', 'Directory', 'File', 'Function', 'Class',
  'Variable', 'Interface', 'Module', 'Parameter',
]);

function assertValidLabel(label: string): void {
  if (!VALID_LABELS.has(label)) throw new Error(`Invalid Neo4j label: ${label}`);
}

// Fix 4: Allowlisted properties per label (prevents internal fields leaking to Neo4j)
const ALLOWED_PROPS: Record<string, string[]> = {
  Function: ['name', 'line_number', 'end_line', 'args', 'cyclomatic_complexity', 'source', 'docstring', 'decorators', 'lang', 'is_dependency', 'path'],
  Class: ['name', 'line_number', 'end_line', 'bases', 'source', 'docstring', 'decorators', 'lang', 'is_dependency', 'path'],
  Variable: ['name', 'line_number', 'value', 'type', 'lang', 'is_dependency', 'path'],
  Interface: ['name', 'line_number', 'end_line', 'source', 'path'],
};

function filterProps(item: Record<string, unknown>, label: string): Record<string, unknown> {
  const allowed = ALLOWED_PROPS[label];
  if (!allowed) return item;
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in item && item[key] !== undefined && item[key] !== null) {
      filtered[key] = item[key];
    }
  }
  return filtered;
}

export class GraphClient {
  private driver: Driver | null = null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.driver = neo4j.driver(
      this.config.neo4jUri,
      neo4j.auth.basic(this.config.neo4jUsername, this.config.neo4jPassword),
      { disableLosslessIntegers: true }
    );
    await this.driver.verifyConnectivity();
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  private getSession(): Session {
    if (!this.driver) throw new Error('Not connected. Call connect() first.');
    return this.driver.session();
  }

  /** Run raw Cypher -- for tests and one-off queries. */
  async runCypher(query: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const session = this.getSession();
    try {
      const result = await session.run(query, params);
      return result.records.map(r => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  // --- Schema -------------------------------------------------

  /**
   * Create constraints and indexes matching CGC's schema.
   * See CGC graph_builder.py:127 create_schema()
   */
  async ensureSchema(): Promise<void> {
    const session = this.getSession();
    try {
      const constraints = [
        'CREATE CONSTRAINT repository_path IF NOT EXISTS FOR (r:Repository) REQUIRE r.path IS UNIQUE',
        'CREATE CONSTRAINT path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE',
        'CREATE CONSTRAINT directory_path IF NOT EXISTS FOR (d:Directory) REQUIRE d.path IS UNIQUE',
        'CREATE CONSTRAINT function_unique IF NOT EXISTS FOR (f:Function) REQUIRE (f.name, f.path, f.line_number) IS UNIQUE',
        'CREATE CONSTRAINT class_unique IF NOT EXISTS FOR (c:Class) REQUIRE (c.name, c.path, c.line_number) IS UNIQUE',
        'CREATE CONSTRAINT interface_unique IF NOT EXISTS FOR (i:Interface) REQUIRE (i.name, i.path, i.line_number) IS UNIQUE',
        'CREATE CONSTRAINT variable_unique IF NOT EXISTS FOR (v:Variable) REQUIRE (v.name, v.path, v.line_number) IS UNIQUE',
        'CREATE CONSTRAINT module_name IF NOT EXISTS FOR (m:Module) REQUIRE m.name IS UNIQUE',
      ];
      const indexes = [
        'CREATE INDEX function_lang IF NOT EXISTS FOR (f:Function) ON (f.lang)',
        'CREATE INDEX class_lang IF NOT EXISTS FOR (c:Class) ON (c.lang)',
        // Fix 8: Path-only indexes for faster per-file queries
        'CREATE INDEX function_path IF NOT EXISTS FOR (f:Function) ON (f.path)',
        'CREATE INDEX class_path IF NOT EXISTS FOR (c:Class) ON (c.path)',
        'CREATE INDEX variable_path IF NOT EXISTS FOR (v:Variable) ON (v.path)',
        'CREATE INDEX interface_path IF NOT EXISTS FOR (i:Interface) ON (i.path)',
        `CREATE FULLTEXT INDEX code_search_index IF NOT EXISTS
         FOR (n:Function|Class|Variable)
         ON EACH [n.name, n.source, n.docstring]`,
      ];
      for (const q of [...constraints, ...indexes]) {
        try {
          await session.run(q);
        } catch {
          // Index/constraint may already exist in different form
        }
      }
    } finally {
      await session.close();
    }
  }

  // --- Repository ---------------------------------------------

  /** CGC graph_builder.py:256 add_repository_to_graph */
  async createRepository(repoPath: string, repoName: string): Promise<void> {
    await this.runCypher(
      `MERGE (r:Repository {path: $path})
       SET r.name = $name, r.is_dependency = false`,
      { path: repoPath, name: repoName }
    );
  }

  // --- File + Directory Hierarchy -----------------------------

  /**
   * Create File node and CONTAINS chain from Repository through Directories.
   * CGC graph_builder.py:287-323
   */
  async createFileNode(filePath: string, repoPath: string, relativePath: string): Promise<void> {
    const fileName = basename(filePath);
    const session = this.getSession();
    try {
      // Create File node
      await session.run(
        `MERGE (f:File {path: $path})
         SET f.name = $name, f.relative_path = $relative_path, f.is_dependency = false`,
        { path: filePath, name: fileName, relative_path: relativePath }
      );

      // Build directory chain
      const parts = relativePath.split('/').slice(0, -1); // directories only
      let parentPath = repoPath;
      let parentLabel = 'Repository';

      for (const part of parts) {
        assertValidLabel(parentLabel);
        const currentPath = parentPath + '/' + part;
        await session.run(
          `MATCH (p:${parentLabel} {path: $parent_path})
           MERGE (d:Directory {path: $current_path})
           SET d.name = $part
           MERGE (p)-[:CONTAINS]->(d)`,
          { parent_path: parentPath, current_path: currentPath, part }
        );
        parentPath = currentPath;
        parentLabel = 'Directory';
      }

      // Link final parent to file
      assertValidLabel(parentLabel);
      await session.run(
        `MATCH (p:${parentLabel} {path: $parent_path})
         MATCH (f:File {path: $path})
         MERGE (p)-[:CONTAINS]->(f)`,
        { parent_path: parentPath, path: filePath }
      );
    } finally {
      await session.close();
    }
  }

  // --- Add Parsed File Contents -------------------------------

  /**
   * Write all nodes and relationships for a parsed file.
   * Fix 6: Batched with UNWIND queries instead of per-node queries.
   * CGC graph_builder.py:272 add_file_to_graph
   */
  async addFileToGraph(fileData: ParsedFile, repoPath: string): Promise<void> {
    const filePath = resolve(fileData.path);
    const relPath = relative(repoPath, filePath);

    await this.createFileNode(filePath, repoPath, relPath);

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        // --- Batch Functions ---
        if (fileData.functions.length > 0) {
          // Fix 49: Don't mutate input - create shallow copies with default cyclomatic_complexity
          const funcProps = fileData.functions.map(f => {
            const copy = { ...f, path: filePath };
            if (!('cyclomatic_complexity' in copy) || copy.cyclomatic_complexity === undefined) {
              copy.cyclomatic_complexity = 1;
            }
            return filterProps(copy, 'Function');
          });
          await tx.run(
            `MATCH (f:File {path: $path})
             UNWIND $items AS item
             MERGE (n:Function {name: item.name, path: $path, line_number: item.line_number})
             SET n += item
             MERGE (f)-[:CONTAINS]->(n)`,
            { path: filePath, items: funcProps }
          );
        }

        // --- Batch Classes ---
        if (fileData.classes.length > 0) {
          const classProps = fileData.classes.map(c =>
            filterProps({ ...c, path: filePath }, 'Class')
          );
          await tx.run(
            `MATCH (f:File {path: $path})
             UNWIND $items AS item
             MERGE (n:Class {name: item.name, path: $path, line_number: item.line_number})
             SET n += item
             MERGE (f)-[:CONTAINS]->(n)`,
            { path: filePath, items: classProps }
          );
        }

        // --- Batch Variables ---
        if (fileData.variables.length > 0) {
          const varProps = fileData.variables.map(v =>
            filterProps({ ...v, path: filePath }, 'Variable')
          );
          await tx.run(
            `MATCH (f:File {path: $path})
             UNWIND $items AS item
             MERGE (n:Variable {name: item.name, path: $path, line_number: item.line_number})
             SET n += item
             MERGE (f)-[:CONTAINS]->(n)`,
            { path: filePath, items: varProps }
          );
        }

        // --- Batch Interfaces ---
        const interfaces = fileData.interfaces || [];
        if (interfaces.length > 0) {
          const ifaceProps = interfaces.map(i =>
            filterProps({ ...i, path: filePath }, 'Interface')
          );
          await tx.run(
            `MATCH (f:File {path: $path})
             UNWIND $items AS item
             MERGE (n:Interface {name: item.name, path: $path, line_number: item.line_number})
             SET n += item
             MERGE (f)-[:CONTAINS]->(n)`,
            { path: filePath, items: ifaceProps }
          );
        }

        // --- Batch Parameters ---
        const paramRows: { func_name: string; line_number: number; arg_name: string }[] = [];
        for (const fn of fileData.functions) {
          for (const argName of fn.args) {
            paramRows.push({ func_name: fn.name, line_number: fn.line_number, arg_name: argName });
          }
        }
        if (paramRows.length > 0) {
          await tx.run(
            `UNWIND $params AS p
             MATCH (fn:Function {name: p.func_name, path: $path, line_number: p.line_number})
             MERGE (param:Parameter {name: p.arg_name, path: $path, function_line_number: p.line_number})
             MERGE (fn)-[:HAS_PARAMETER]->(param)`,
            { path: filePath, params: paramRows }
          );
        }

        // --- Batch Nested Function CONTAINS ---
        // Fix 1: Use JS/TS node types instead of Python's function_definition
        const nestedFunctionTypes = new Set([
          'function_declaration', 'function_expression', 'arrow_function', 'method_definition',
        ]);
        const nestedRows = fileData.functions
          .filter(f => f.context_type && nestedFunctionTypes.has(f.context_type) && f.context)
          .map(f => ({ context: f.context, name: f.name, line_number: f.line_number }));
        if (nestedRows.length > 0) {
          await tx.run(
            `UNWIND $rows AS r
             MATCH (outer:Function {name: r.context, path: $path})
             MATCH (inner:Function {name: r.name, path: $path, line_number: r.line_number})
             MERGE (outer)-[:CONTAINS]->(inner)`,
            { path: filePath, rows: nestedRows }
          );
        }

        // --- Batch Class Method CONTAINS ---
        const methodRows = fileData.functions
          .filter(f => f.class_context)
          .map(f => ({ class_name: f.class_context, func_name: f.name, func_line: f.line_number }));
        if (methodRows.length > 0) {
          await tx.run(
            `UNWIND $rows AS r
             MATCH (c:Class {name: r.class_name, path: $path})
             MATCH (fn:Function {name: r.func_name, path: $path, line_number: r.func_line})
             MERGE (c)-[:CONTAINS]->(fn)`,
            { path: filePath, rows: methodRows }
          );
        }

        // --- Batch Imports ---
        const importRows = fileData.imports
          .filter(imp => imp.source)
          .map(imp => {
            const row: Record<string, unknown> = {
              module_name: imp.source,
              imported_name: imp.name,
            };
            if (imp.alias) row.alias = imp.alias;
            if (imp.line_number) row.line_number = imp.line_number;
            return row;
          });
        if (importRows.length > 0) {
          await tx.run(
            `MATCH (f:File {path: $path})
             UNWIND $imports AS imp
             MERGE (m:Module {name: imp.module_name})
             MERGE (f)-[r:IMPORTS]->(m)
             SET r.imported_name = imp.imported_name,
                 r.alias = imp.alias,
                 r.line_number = imp.line_number`,
            { path: filePath, imports: importRows }
          );
        }
      });
    } finally {
      await session.close();
    }
  }

  // --- Batch CALLS Relationships --------------------------------

  /**
   * Create CALLS relationships in batch using UNWIND.
   * Fix 6: Replaces per-call createCallRelationship / createFileLevelCallRelationship.
   */
  async createCallRelationshipsBatch(calls: ResolvedCall[]): Promise<void> {
    if (calls.length === 0) return;

    // Split into function-level and file-level calls
    const funcCalls = calls.filter(c => c.caller_name !== '');
    const fileCalls = calls.filter(c => c.caller_name === '');

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        if (funcCalls.length > 0) {
          await tx.run(
            `UNWIND $calls AS c
             MATCH (caller) WHERE (caller:Function OR caller:Class)
               AND caller.name = c.caller_name
               AND caller.path = c.caller_file_path
               AND caller.line_number = c.caller_line_number
             MATCH (called) WHERE (called:Function OR called:Class)
               AND called.name = c.called_name
               AND called.path = c.called_file_path
             WITH caller, called, c
             OPTIONAL MATCH (called)-[:CONTAINS]->(init:Function)
             WHERE called:Class AND init.name IN ["__init__", "constructor"]
             WITH caller, COALESCE(init, called) AS final_target, c
             MERGE (caller)-[:CALLS {line_number: c.line_number, args: c.args, full_call_name: c.full_call_name}]->(final_target)`,
            { calls: funcCalls }
          );
        }

        if (fileCalls.length > 0) {
          await tx.run(
            `UNWIND $calls AS c
             MATCH (caller:File {path: c.caller_file_path})
             MATCH (called) WHERE (called:Function OR called:Class)
               AND called.name = c.called_name
               AND called.path = c.called_file_path
             WITH caller, called, c
             OPTIONAL MATCH (called)-[:CONTAINS]->(init:Function)
             WHERE called:Class AND init.name IN ["__init__", "constructor"]
             WITH caller, COALESCE(init, called) AS final_target, c
             MERGE (caller)-[:CALLS {line_number: c.line_number, args: c.args, full_call_name: c.full_call_name}]->(final_target)`,
            { calls: fileCalls }
          );
        }
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Create a single CALLS relationship when caller context is known (function/class caller).
   * CGC graph_builder.py:577-600
   * Kept for backward compatibility; prefer createCallRelationshipsBatch.
   */
  async createCallRelationship(
    callerName: string,
    callerFilePath: string,
    callerLineNumber: number,
    calledName: string,
    calledFilePath: string,
    lineNumber: number,
    args: string[],
    fullCallName: string,
  ): Promise<void> {
    await this.createCallRelationshipsBatch([{
      caller_name: callerName,
      caller_file_path: callerFilePath,
      caller_line_number: callerLineNumber,
      called_name: calledName,
      called_file_path: calledFilePath,
      line_number: lineNumber,
      args,
      full_call_name: fullCallName,
    }]);
  }

  /**
   * Create CALLS from file-level (no caller context).
   * CGC graph_builder.py:602-620
   * Kept for backward compatibility; prefer createCallRelationshipsBatch.
   */
  async createFileLevelCallRelationship(
    callerFilePath: string,
    calledName: string,
    calledFilePath: string,
    lineNumber: number,
    args: string[],
    fullCallName: string,
  ): Promise<void> {
    await this.createCallRelationshipsBatch([{
      caller_name: '',
      caller_file_path: callerFilePath,
      caller_line_number: 0,
      called_name: calledName,
      called_file_path: calledFilePath,
      line_number: lineNumber,
      args,
      full_call_name: fullCallName,
    }]);
  }

  // --- Batch INHERITS Relationships -----------------------------

  /**
   * Create INHERITS relationships in batch using UNWIND.
   * Fix 6: Replaces per-call createInheritsRelationship.
   */
  async createInheritsRelationshipsBatch(inheritance: ResolvedInheritance[]): Promise<void> {
    if (inheritance.length === 0) return;

    await this.runCypher(
      `UNWIND $items AS i
       MATCH (child:Class {name: i.child_name, path: i.child_file_path})
       MATCH (parent:Class {name: i.parent_name, path: i.parent_file_path})
       MERGE (child)-[:INHERITS]->(parent)`,
      { items: inheritance }
    );
  }

  /** CGC graph_builder.py:682-690 */
  async createInheritsRelationship(
    childName: string,
    childFilePath: string,
    parentName: string,
    parentFilePath: string,
  ): Promise<void> {
    await this.createInheritsRelationshipsBatch([{
      child_name: childName,
      child_file_path: childFilePath,
      parent_name: parentName,
      parent_file_path: parentFilePath,
    }]);
  }

  // --- Symbol Map Bootstrap -----------------------------------

  /** Query all Function/Class/Interface names and their file paths for symbol map bootstrap. */
  async getAllSymbols(): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const results = await this.runCypher(
      `MATCH (n)
       WHERE (n:Function OR n:Class OR n:Interface)
       RETURN n.name AS name, n.path AS path`
    );
    for (const row of results) {
      const name = row.name as string;
      const path = row.path as string;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name)!.add(path);
    }
    return map;
  }

  // --- Deletion -----------------------------------------------

  /**
   * Delete a file and all its contained elements.
   * CGC graph_builder.py:769-794
   */
  async deleteFile(filePath: string): Promise<void> {
    const session = this.getSession();
    try {
      // Get parent directories (for cleanup)
      const parentsResult = await session.run(
        `MATCH (f:File {path: $path})<-[:CONTAINS*]-(d:Directory)
         RETURN d.path as path ORDER BY d.path DESC`,
        { path: filePath }
      );
      const parentPaths = parentsResult.records.map(r => r.get('path') as string);

      // Delete file and contained elements
      await session.run(
        `MATCH (f:File {path: $path})
         OPTIONAL MATCH (f)-[:CONTAINS]->(element)
         DETACH DELETE f, element`,
        { path: filePath }
      );

      // Clean up empty directories
      for (const dirPath of parentPaths) {
        await session.run(
          `MATCH (d:Directory {path: $path})
           WHERE NOT (d)-[:CONTAINS]->()
           DETACH DELETE d`,
          { path: dirPath }
        );
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Clean stale CALLS pointing to functions that no longer exist in a file.
   * See docs/001-Architecture.md "Stale CALLS Cleanup"
   */
  async cleanStaleCallsTo(filePath: string): Promise<void> {
    await this.runCypher(
      `MATCH (caller)-[r:CALLS]->(callee)
       WHERE callee.path = $path
       AND NOT EXISTS { MATCH (:File {path: $path})-[:CONTAINS]->(callee) }
       DELETE r`,
      { path: filePath }
    );
  }

  /**
   * Delete all outgoing CALLS from functions in a file.
   * Phase 3 optimization -- but we do it from the start for correctness.
   */
  async deleteOutgoingCalls(filePath: string): Promise<void> {
    await this.runCypher(
      `MATCH (caller)-[r:CALLS]->(callee)
       WHERE caller.path = $path
       DELETE r`,
      { path: filePath }
    );
  }
}
