// src/graph.ts
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type { Config } from './config.js';
import type { ParsedFile, ParsedFunction, ParsedImport } from './types.js';
import { resolve, relative, basename } from 'path';

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
   * CGC graph_builder.py:272 add_file_to_graph
   */
  async addFileToGraph(fileData: ParsedFile, repoPath: string): Promise<void> {
    const filePath = resolve(fileData.path);
    const relPath = relative(repoPath, filePath);

    await this.createFileNode(filePath, repoPath, relPath);

    const session = this.getSession();
    try {
      // Functions, Classes, Variables, Interfaces -- CGC graph_builder.py:330-356
      const itemMappings: [unknown[], string][] = [
        [fileData.functions, 'Function'],
        [fileData.classes, 'Class'],
        [fileData.variables, 'Variable'],
        [fileData.interfaces || [], 'Interface'],
      ];

      for (const [items, label] of itemMappings) {
        for (const item of items as Record<string, unknown>[]) {
          // Default cyclomatic_complexity for functions (CGC graph_builder.py:346-347)
          if (label === 'Function' && !('cyclomatic_complexity' in item)) {
            item.cyclomatic_complexity = 1;
          }

          await session.run(
            `MATCH (f:File {path: $path})
             MERGE (n:${label} {name: $name, path: $path, line_number: $line_number})
             SET n += $props
             MERGE (f)-[:CONTAINS]->(n)`,
            {
              path: filePath,
              name: item.name,
              line_number: item.line_number,
              props: item,
            }
          );

          // Parameters for functions -- CGC graph_builder.py:358-364
          if (label === 'Function') {
            const fn = item as unknown as ParsedFunction;
            for (const argName of fn.args) {
              await session.run(
                `MATCH (fn:Function {name: $func_name, path: $path, line_number: $line_number})
                 MERGE (p:Parameter {name: $arg_name, path: $path, function_line_number: $line_number})
                 MERGE (fn)-[:HAS_PARAMETER]->(p)`,
                {
                  func_name: fn.name,
                  path: filePath,
                  line_number: fn.line_number,
                  arg_name: argName,
                }
              );
            }
          }
        }
      }

      // Nested functions -- CGC graph_builder.py:374-381
      for (const func of fileData.functions) {
        if (func.context_type === 'function_definition' && func.context) {
          await session.run(
            `MATCH (outer:Function {name: $context, path: $path})
             MATCH (inner:Function {name: $name, path: $path, line_number: $line_number})
             MERGE (outer)-[:CONTAINS]->(inner)`,
            { context: func.context, path: filePath, name: func.name, line_number: func.line_number }
          );
        }
      }

      // Class methods -- CGC graph_builder.py:428-439
      for (const func of fileData.functions) {
        if (func.class_context) {
          await session.run(
            `MATCH (c:Class {name: $class_name, path: $path})
             MATCH (fn:Function {name: $func_name, path: $path, line_number: $func_line})
             MERGE (c)-[:CONTAINS]->(fn)`,
            {
              class_name: func.class_context,
              path: filePath,
              func_name: func.name,
              func_line: func.line_number,
            }
          );
        }
      }

      // Imports -- CGC graph_builder.py:383-425
      // For JS/TS: use source as module name, set imported_name, alias, line_number as rel props
      for (const imp of fileData.imports) {
        const moduleName = imp.source;
        if (!moduleName) continue;

        const relProps: Record<string, unknown> = { imported_name: imp.name };
        if (imp.alias) relProps.alias = imp.alias;
        if (imp.line_number) relProps.line_number = imp.line_number;

        await session.run(
          `MATCH (f:File {path: $path})
           MERGE (m:Module {name: $module_name})
           MERGE (f)-[r:IMPORTS]->(m)
           SET r += $props`,
          { path: filePath, module_name: moduleName, props: relProps }
        );
      }
    } finally {
      await session.close();
    }
  }

  // --- CALLS Relationships ------------------------------------

  /**
   * Create a single CALLS relationship when caller context is known (function/class caller).
   * CGC graph_builder.py:577-600
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
    await this.runCypher(
      `MATCH (caller) WHERE (caller:Function OR caller:Class)
         AND caller.name = $caller_name
         AND caller.path = $caller_file_path
         AND caller.line_number = $caller_line_number
       MATCH (called) WHERE (called:Function OR called:Class)
         AND called.name = $called_name
         AND called.path = $called_file_path
       WITH caller, called
       OPTIONAL MATCH (called)-[:CONTAINS]->(init:Function)
       WHERE called:Class AND init.name IN ["__init__", "constructor"]
       WITH caller, COALESCE(init, called) as final_target
       MERGE (caller)-[:CALLS {line_number: $line_number, args: $args, full_call_name: $full_call_name}]->(final_target)`,
      {
        caller_name: callerName,
        caller_file_path: callerFilePath,
        caller_line_number: callerLineNumber,
        called_name: calledName,
        called_file_path: calledFilePath,
        line_number: lineNumber,
        args,
        full_call_name: fullCallName,
      }
    );
  }

  /**
   * Create CALLS from file-level (no caller context).
   * CGC graph_builder.py:602-620
   */
  async createFileLevelCallRelationship(
    callerFilePath: string,
    calledName: string,
    calledFilePath: string,
    lineNumber: number,
    args: string[],
    fullCallName: string,
  ): Promise<void> {
    await this.runCypher(
      `MATCH (caller:File {path: $caller_file_path})
       MATCH (called) WHERE (called:Function OR called:Class)
         AND called.name = $called_name
         AND called.path = $called_file_path
       WITH caller, called
       OPTIONAL MATCH (called)-[:CONTAINS]->(init:Function)
       WHERE called:Class AND init.name IN ["__init__", "constructor"]
       WITH caller, COALESCE(init, called) as final_target
       MERGE (caller)-[:CALLS {line_number: $line_number, args: $args, full_call_name: $full_call_name}]->(final_target)`,
      {
        caller_file_path: callerFilePath,
        called_name: calledName,
        called_file_path: calledFilePath,
        line_number: lineNumber,
        args,
        full_call_name: fullCallName,
      }
    );
  }

  // --- INHERITS Relationships ---------------------------------

  /** CGC graph_builder.py:682-690 */
  async createInheritsRelationship(
    childName: string,
    childFilePath: string,
    parentName: string,
    parentFilePath: string,
  ): Promise<void> {
    await this.runCypher(
      `MATCH (child:Class {name: $child_name, path: $child_path})
       MATCH (parent:Class {name: $parent_name, path: $parent_path})
       MERGE (child)-[:INHERITS]->(parent)`,
      {
        child_name: childName,
        child_path: childFilePath,
        parent_name: parentName,
        parent_path: parentFilePath,
      }
    );
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
