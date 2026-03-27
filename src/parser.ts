// src/parser.ts — Tree-sitter parser porting CGC TS/JS queries to web-tree-sitter
// See CGC: tools/languages/typescript.py and tools/languages/javascript.py

import TreeSitter from 'web-tree-sitter';
import { readFileSync, statSync } from 'fs';
import { resolve, extname } from 'path';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
import type {
  ParsedFile, ParsedFunction, ParsedClass, ParsedVariable,
  ParsedImport, ParsedCall, ParsedInterface, ParsedTypeAlias,
} from './types.js';

// Tree-sitter query strings — copied verbatim from CGC typescript.py:6-90
const TS_QUERIES = {
  functions: `
    (function_declaration
      name: (identifier) @name
      parameters: (formal_parameters) @params
    ) @function_node

    (variable_declarator
      name: (identifier) @name
      value: (function_expression
        parameters: (formal_parameters) @params
      ) @function_node
    )

    (variable_declarator
      name: (identifier) @name
      value: (arrow_function
        parameters: (formal_parameters) @params
      ) @function_node
    )

    (variable_declarator
      name: (identifier) @name
      value: (arrow_function
        parameter: (identifier) @single_param
      ) @function_node
    )

    (method_definition
      name: (property_identifier) @name
      parameters: (formal_parameters) @params
    ) @function_node

    (assignment_expression
      left: (member_expression
        property: (property_identifier) @name
      )
      right: (function_expression
        parameters: (formal_parameters) @params
      ) @function_node
    )

    (assignment_expression
      left: (member_expression
        property: (property_identifier) @name
      )
      right: (arrow_function
        parameters: (formal_parameters) @params
      ) @function_node
    )
  `,
  classes: `
    (class_declaration) @class
    (abstract_class_declaration) @class
    (class) @class
  `,
  interfaces: `
    (interface_declaration
      name: (type_identifier) @name
    ) @interface_node
  `,
  type_aliases: `
    (type_alias_declaration
      name: (type_identifier) @name
    ) @type_alias_node
  `,
  imports: `
    (import_statement) @import
    (call_expression
      function: (identifier) @require_call (#eq? @require_call "require")
    ) @import
  `,
  calls: `
    (call_expression function: (identifier) @name)
    (call_expression function: (member_expression property: (property_identifier) @name))
    (new_expression constructor: (identifier) @name)
    (new_expression constructor: (member_expression property: (property_identifier) @name))
  `,
  variables: `
    (variable_declarator name: (identifier) @name)
  `,
};

// JavaScript-specific query overrides (JS grammar lacks abstract_class_declaration)
const JS_QUERIES = {
  ...TS_QUERIES,
  classes: `
    (class_declaration) @class
    (class) @class
  `,
};

/** Return the appropriate query set for a language. */
function queriesForLang(langName: string): typeof TS_QUERIES {
  return langName === 'javascript' ? JS_QUERIES : TS_QUERIES;
}

// Cyclomatic complexity node types — CGC typescript.py:126-130
const COMPLEXITY_NODES = new Set([
  'if_statement', 'for_statement', 'while_statement', 'do_statement',
  'switch_statement', 'case_statement', 'conditional_expression',
  'logical_expression', 'binary_expression', 'catch_clause',
]);

type SyntaxNode = TreeSitter.SyntaxNode;

export class Parser {
  private tsParser!: TreeSitter;
  private languages: Map<string, TreeSitter.Language> = new Map();
  private compiledQueries = new Map<string, Record<string, TreeSitter.Query>>();
  private initialized = false;

  async init(): Promise<void> {
    // Initialize web-tree-sitter WASM runtime
    const treeSitterWasm = new URL(
      '../node_modules/web-tree-sitter/tree-sitter.wasm',
      import.meta.url
    ).pathname;

    await TreeSitter.init({
      locateFile(_scriptName: string) {
        return treeSitterWasm;
      },
    });

    this.tsParser = new TreeSitter();
    this.initialized = true;

    // Load language grammars from tree-sitter-wasms package
    const wasmDir = new URL(
      '../node_modules/tree-sitter-wasms/out/',
      import.meta.url
    ).pathname;

    const langFiles: [string, string][] = [
      ['typescript', 'tree-sitter-typescript.wasm'],
      ['tsx', 'tree-sitter-tsx.wasm'],
      ['javascript', 'tree-sitter-javascript.wasm'],
    ];

    for (const [name, file] of langFiles) {
      try {
        const wasmPath = resolve(wasmDir, file);
        const lang = await TreeSitter.Language.load(wasmPath);
        this.languages.set(name, lang);
      } catch {
        // Language WASM not available — will be skipped
      }
    }

    // Pre-compile tree-sitter queries per language to avoid repeated compilation
    for (const [name, lang] of this.languages) {
      const qs = queriesForLang(name);
      const isTs = name === 'typescript' || name === 'tsx';
      const compiled: Record<string, TreeSitter.Query> = {
        functions: lang.query(qs.functions),
        classes: lang.query(qs.classes),
        imports: lang.query(qs.imports),
        calls: lang.query(qs.calls),
        variables: lang.query(qs.variables),
      };
      if (isTs) {
        compiled.interfaces = lang.query(TS_QUERIES.interfaces);
        compiled.type_aliases = lang.query(TS_QUERIES.type_aliases);
      }
      this.compiledQueries.set(name, compiled);
    }
  }

  /** Get the language name for a file extension. */
  private getLangName(ext: string): string | null {
    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'tsx',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    };
    return map[ext] || null;
  }

  /** Parse a file from disk. */
  parseFile(filePath: string, indexSource = false): ParsedFile {
    const absPath = resolve(filePath);
    const ext = extname(absPath);
    const langName = this.getLangName(ext);
    if (!langName) throw new Error(`Unsupported extension: ${ext}`);

    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_SIZE) {
      console.warn(`Skipping ${absPath}: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 2MB limit)`);
      return {
        path: absPath,
        lang: langName === 'tsx' ? 'typescript' : langName,
        functions: [],
        classes: [],
        variables: [],
        imports: [],
        function_calls: [],
        is_dependency: false,
      };
    }

    const source = readFileSync(absPath, 'utf-8');
    return this.parseSource(absPath, langName, source, indexSource);
  }

  /** Parse source code string (primary method, used for testing too). */
  parseSource(
    filePath: string,
    langName: string,
    source: string,
    indexSource = false,
  ): ParsedFile {
    if (!this.initialized) throw new Error('Parser not initialized. Call init() first.');

    const language = this.languages.get(langName);
    if (!language) throw new Error(`Language not loaded: ${langName}`);

    this.tsParser.setLanguage(language);
    const tree = this.tsParser.parse(source);
    const root = tree.rootNode;

    const isTs = langName === 'typescript' || langName === 'tsx';
    const lang = langName === 'tsx' ? 'typescript' : langName;

    const result: ParsedFile = {
      path: filePath,
      lang,
      functions: this.findFunctions(root, language, langName, indexSource),
      classes: this.findClasses(root, language, langName, indexSource),
      variables: this.findVariables(root, language, langName),
      imports: this.findImports(root, language, langName),
      function_calls: this.findCalls(root, language, langName),
      interfaces: isTs ? this.findInterfaces(root, language, langName, indexSource) : undefined,
      type_aliases: isTs ? this.findTypeAliases(root, language, langName, indexSource) : undefined,
      is_dependency: false,
    };

    // Free WASM tree memory to prevent leaks
    tree.delete();

    return result;
  }

  // ─── Helper methods (match CGC's Python methods) ─────────────────────

  private getText(node: SyntaxNode): string {
    return node.text;
  }

  /**
   * Walk up the AST to find the nearest enclosing context node.
   * CGC typescript.py:107-123
   */
  private getParentContext(
    node: SyntaxNode,
    types = [
      'function_declaration', 'class_declaration', 'abstract_class_declaration',
      'method_definition', 'function_expression', 'arrow_function',
    ],
  ): [string | null, string | null, number | null] {
    let curr = node.parent;
    while (curr) {
      if (types.includes(curr.type)) {
        let nameNode = curr.childForFieldName('name');
        if (!nameNode && ['function_expression', 'arrow_function'].includes(curr.type)) {
          // Try to find name from parent variable/assignment/pair
          if (curr.parent?.type === 'variable_declarator') {
            nameNode = curr.parent.childForFieldName('name');
          } else if (curr.parent?.type === 'assignment_expression') {
            nameNode = curr.parent.childForFieldName('left');
          } else if (curr.parent?.type === 'pair') {
            nameNode = curr.parent.childForFieldName('key');
          }
        }
        return [
          nameNode ? this.getText(nameNode) : null,
          curr.type,
          curr.startPosition.row + 1,
        ];
      }
      curr = curr.parent;
    }
    return [null, null, null];
  }

  /**
   * Calculate cyclomatic complexity for a node.
   * CGC typescript.py:125-139
   * Base = 1, +1 per complexity node found anywhere in the subtree.
   */
  private calculateComplexity(node: SyntaxNode): number {
    let count = 1;
    const traverse = (n: SyntaxNode) => {
      if (COMPLEXITY_NODES.has(n.type)) count++;
      for (const child of n.children) traverse(child);
    };
    traverse(node);
    return count;
  }

  /**
   * From a name capture node, walk up to find the actual function AST node.
   * CGC typescript.py:176-186 _fn_for_name
   */
  private findFunctionNode(nameNode: SyntaxNode): SyntaxNode | null {
    let current: SyntaxNode | null = nameNode.parent;
    while (current) {
      if ([
        'function_declaration', 'function', 'arrow_function',
        'method_definition', 'function_expression',
      ].includes(current.type)) {
        return current;
      }
      if (['variable_declarator', 'assignment_expression'].includes(current.type)) {
        for (const child of current.children) {
          if (['function', 'arrow_function', 'function_expression'].includes(child.type)) {
            return child;
          }
        }
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * From a params/single_param capture node, walk up to find the function node.
   * CGC typescript.py:187-193 _fn_for_params
   */
  private findFunctionNodeForParams(paramsNode: SyntaxNode): SyntaxNode | null {
    let current: SyntaxNode | null = paramsNode.parent;
    while (current) {
      if ([
        'function_declaration', 'function', 'arrow_function',
        'method_definition', 'function_expression',
      ].includes(current.type)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Extract parameter names from a formal_parameters node.
   * CGC typescript.py:258-287
   */
  private extractParameters(paramsNode: SyntaxNode): string[] {
    const params: string[] = [];
    if (paramsNode.type !== 'formal_parameters') return params;

    for (const child of paramsNode.children) {
      if (child.type === 'identifier') {
        params.push(this.getText(child));
      } else if (child.type === 'required_parameter') {
        const pattern = child.childForFieldName('pattern');
        if (pattern) {
          params.push(this.getText(pattern));
        } else {
          // Fallback: first child that is an identifier or pattern
          for (const sub of child.children) {
            if (['identifier', 'object_pattern', 'array_pattern'].includes(sub.type)) {
              params.push(this.getText(sub));
              break;
            }
          }
        }
      } else if (child.type === 'optional_parameter') {
        const pattern = child.childForFieldName('pattern');
        if (pattern) params.push(this.getText(pattern));
      } else if (child.type === 'assignment_pattern') {
        const left = child.childForFieldName('left');
        if (left?.type === 'identifier') params.push(this.getText(left));
      } else if (child.type === 'rest_pattern') {
        const arg = child.childForFieldName('argument');
        if (arg?.type === 'identifier') params.push(`...${this.getText(arg)}`);
      }
    }
    return params;
  }

  // ─── Finders (match CGC's _find_* methods) ───────────────────────────

  /**
   * Find all functions (declarations, expressions, arrows, methods).
   * CGC typescript.py:173-256
   */
  private findFunctions(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
    indexSource: boolean,
  ): ParsedFunction[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached ? cached.functions : language.query(queriesForLang(langName).functions);
    const matches = query.matches(root);

    type FuncKey = string;
    const buckets = new Map<FuncKey, {
      node: SyntaxNode;
      name: string | null;
      params: SyntaxNode | null;
      singleParam: SyntaxNode | null;
    }>();

    const key = (n: SyntaxNode): FuncKey =>
      `${n.startIndex}:${n.endIndex}:${n.type}`;

    const bucket = (node: SyntaxNode) => {
      const k = key(node);
      if (!buckets.has(k)) {
        buckets.set(k, { node, name: null, params: null, singleParam: null });
      }
      return buckets.get(k)!;
    };

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === 'function_node') {
          bucket(capture.node);
        } else if (capture.name === 'name') {
          const fn = this.findFunctionNode(capture.node);
          if (fn) bucket(fn).name = this.getText(capture.node);
        } else if (capture.name === 'params') {
          const fn = this.findFunctionNodeForParams(capture.node);
          if (fn) bucket(fn).params = capture.node;
        } else if (capture.name === 'single_param') {
          const fn = this.findFunctionNodeForParams(capture.node);
          if (fn) bucket(fn).singleParam = capture.node;
        }
      }
    }

    const lang = langName === 'tsx' ? 'typescript' : langName;
    const functions: ParsedFunction[] = [];

    for (const data of buckets.values()) {
      let name = data.name;
      // Fallback for method_definition without captured name
      if (!name && data.node.type === 'method_definition') {
        const nm = data.node.childForFieldName('name');
        if (nm) name = this.getText(nm);
      }
      if (!name) continue;

      let args: string[] = [];
      if (data.params) {
        args = this.extractParameters(data.params);
      } else if (data.singleParam) {
        args = [this.getText(data.singleParam)];
      }

      const [context, contextType] = this.getParentContext(data.node);
      const classContext = (contextType === 'class_declaration' || contextType === 'abstract_class_declaration') ? context : null;

      const func: ParsedFunction = {
        name,
        line_number: data.node.startPosition.row + 1,
        end_line: data.node.endPosition.row + 1,
        args,
        cyclomatic_complexity: this.calculateComplexity(data.node),
        decorators: [],
        context,
        context_type: contextType,
        class_context: classContext,
        lang,
        is_dependency: false,
      };
      if (indexSource) {
        func.source = this.getText(data.node);
        func.docstring = undefined;
      }
      functions.push(func);
    }

    return functions;
  }

  /**
   * Find all class declarations (including abstract).
   * CGC typescript.py:289-326
   */
  private findClasses(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
    indexSource: boolean,
  ): ParsedClass[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached ? cached.classes : language.query(queriesForLang(langName).classes);
    const matches = query.matches(root);
    const classes: ParsedClass[] = [];
    const lang = langName === 'tsx' ? 'typescript' : langName;

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name !== 'class') continue;
        const classNode = capture.node;
        const nameNode = classNode.childForFieldName('name');
        if (!nameNode) continue;

        const name = this.getText(nameNode);
        const bases: string[] = [];

        // Extract heritage (extends/implements) — CGC typescript.py:298-310
        const heritage = classNode.children.find(c => c.type === 'class_heritage');
        if (heritage) {
          for (const child of heritage.children) {
            if (child.type === 'extends_clause' || child.type === 'implements_clause') {
              for (const sub of child.children) {
                if (['identifier', 'type_identifier', 'member_expression'].includes(sub.type)) {
                  bases.push(this.getText(sub));
                }
              }
            }
          }
        }

        const cls: ParsedClass = {
          name,
          line_number: classNode.startPosition.row + 1,
          end_line: classNode.endPosition.row + 1,
          bases,
          decorators: [],
          context: null,
          lang,
          is_dependency: false,
        };
        if (indexSource) {
          cls.source = this.getText(classNode);
          cls.docstring = undefined;
        }
        classes.push(cls);
      }
    }
    return classes;
  }

  /**
   * Find all interface declarations (TypeScript only).
   * CGC typescript.py:328-346
   */
  private findInterfaces(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
    indexSource: boolean,
  ): ParsedInterface[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached?.interfaces ?? language.query(TS_QUERIES.interfaces);
    const interfaces: ParsedInterface[] = [];

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'interface_node') continue;
        const nameNode = capture.node.childForFieldName('name');
        if (!nameNode) continue;

        const iface: ParsedInterface = {
          name: this.getText(nameNode),
          line_number: capture.node.startPosition.row + 1,
          end_line: capture.node.endPosition.row + 1,
        };
        if (indexSource) iface.source = this.getText(capture.node);
        interfaces.push(iface);
      }
    }
    return interfaces;
  }

  /**
   * Find all type alias declarations (TypeScript only).
   * CGC typescript.py:348-366
   */
  private findTypeAliases(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
    indexSource: boolean,
  ): ParsedTypeAlias[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached?.type_aliases ?? language.query(TS_QUERIES.type_aliases);
    const aliases: ParsedTypeAlias[] = [];

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'type_alias_node') continue;
        const nameNode = capture.node.childForFieldName('name');
        if (!nameNode) continue;

        const alias: ParsedTypeAlias = {
          name: this.getText(nameNode),
          line_number: capture.node.startPosition.row + 1,
          end_line: capture.node.endPosition.row + 1,
        };
        if (indexSource) alias.source = this.getText(capture.node);
        aliases.push(alias);
      }
    }
    return aliases;
  }

  /**
   * Find all imports (ES import statements and require() calls).
   * CGC typescript.py:368-415
   */
  private findImports(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
  ): ParsedImport[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached ? cached.imports : language.query(queriesForLang(langName).imports);
    const imports: ParsedImport[] = [];
    const lang = langName === 'tsx' ? 'typescript' : langName;

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'import') continue;
        const node = capture.node;
        const lineNumber = node.startPosition.row + 1;

        if (node.type === 'import_statement') {
          const sourceNode = node.childForFieldName('source');
          if (!sourceNode) continue;
          const source = this.getText(sourceNode).replace(/['"]/g, '');

          // In web-tree-sitter, import_statement has an import_clause child
          // (not accessible via childForFieldName('import'))
          const importClause = node.children.find(c => c.type === 'import_clause');
          if (!importClause) {
            // Side-effect import: import 'module';
            imports.push({ name: source, source, alias: null, line_number: lineNumber, lang });
            continue;
          }

          // import_clause wraps the actual import form as its first named child
          const importForm = importClause.namedChildren[0];
          if (!importForm) {
            imports.push({ name: source, source, alias: null, line_number: lineNumber, lang });
            continue;
          }

          if (importForm.type === 'identifier') {
            // Default import: import foo from 'module';
            imports.push({
              name: 'default',
              source,
              alias: this.getText(importForm),
              line_number: lineNumber,
              lang,
            });
          } else if (importForm.type === 'namespace_import') {
            // Namespace import: import * as foo from 'module';
            // In web-tree-sitter, namespace_import has no 'alias' field;
            // the alias is the identifier child
            const aliasNode = importForm.children.find(c => c.type === 'identifier');
            if (aliasNode) {
              imports.push({
                name: '*',
                source,
                alias: this.getText(aliasNode),
                line_number: lineNumber,
                lang,
              });
            }
          } else if (importForm.type === 'named_imports') {
            // Named imports: import { a, b as c } from 'module';
            for (const specifier of importForm.children) {
              if (specifier.type === 'import_specifier') {
                const nameNode = specifier.childForFieldName('name');
                const aliasNode = specifier.childForFieldName('alias');
                if (nameNode) {
                  imports.push({
                    name: this.getText(nameNode),
                    source,
                    alias: aliasNode ? this.getText(aliasNode) : null,
                    line_number: lineNumber,
                    lang,
                  });
                }
              }
            }
          }
        } else if (node.type === 'call_expression') {
          // require() call — CGC typescript.py:402-414
          const argsNode = node.childForFieldName('arguments');
          if (!argsNode || argsNode.namedChildCount === 0) continue;
          const sourceNode = argsNode.namedChild(0);
          if (!sourceNode || sourceNode.type !== 'string') continue;
          const source = this.getText(sourceNode).replace(/['"]/g, '');

          let alias: string | null = null;
          if (node.parent?.type === 'variable_declarator') {
            const nameNode = node.parent.childForFieldName('name');
            if (nameNode) alias = this.getText(nameNode);
          }
          imports.push({ name: source, source, alias, line_number: lineNumber, lang });
        }
      }
    }
    return imports;
  }

  /**
   * Find all function calls and new expressions.
   * CGC typescript.py:417-452
   */
  private findCalls(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
  ): ParsedCall[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached ? cached.calls : language.query(queriesForLang(langName).calls);
    const calls: ParsedCall[] = [];
    const lang = langName === 'tsx' ? 'typescript' : langName;

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'name') continue;
        const node = capture.node;

        // Walk up to find call_expression or new_expression
        let callNode: SyntaxNode | null = node.parent;
        while (
          callNode &&
          !['call_expression', 'new_expression', 'program'].includes(callNode.type)
        ) {
          callNode = callNode.parent;
        }

        const name = this.getText(node);

        // Extract args
        const args: string[] = [];
        if (callNode && ['call_expression', 'new_expression'].includes(callNode.type)) {
          const argsNode = callNode.childForFieldName('arguments');
          if (argsNode) {
            for (const arg of argsNode.children) {
              if (!['(', ')', ','].includes(arg.type)) {
                args.push(this.getText(arg));
              }
            }
          }
        }

        const context = this.getParentContext(node);
        const classContext = this.getParentContext(node, [
          'class_declaration', 'abstract_class_declaration',
        ]);

        calls.push({
          name,
          full_name: callNode && callNode.type !== 'program'
            ? this.getText(callNode)
            : name,
          line_number: node.startPosition.row + 1,
          args,
          inferred_obj_type: null,
          context: context as [string, string, number] | [null, null, null],
          class_context: [classContext[0], classContext[1]] as [string, string] | [null, null],
          lang,
          is_dependency: false,
        });
      }
    }
    return calls;
  }

  /**
   * Find all variable declarations (excluding function-assigned ones).
   * CGC typescript.py:454-500
   */
  private findVariables(
    root: SyntaxNode,
    language: TreeSitter.Language,
    langName: string,
  ): ParsedVariable[] {
    const cached = this.compiledQueries.get(langName);
    const query = cached ? cached.variables : language.query(queriesForLang(langName).variables);
    const variables: ParsedVariable[] = [];
    const lang = langName === 'tsx' ? 'typescript' : langName;

    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'name') continue;
        const node = capture.node;
        const varNode = node.parent;
        if (!varNode) continue;

        const name = this.getText(node);

        // Skip function-assigned variables — CGC typescript.py:471-477
        const valueNode = varNode.childForFieldName('value');
        if (valueNode) {
          if (['function_expression', 'arrow_function'].includes(valueNode.type)) continue;
          if (valueNode.type.includes('function') || valueNode.type.includes('arrow')) continue;
        }

        let value: string | null = null;
        if (valueNode) {
          if (valueNode.type === 'call_expression') {
            const funcNode = valueNode.childForFieldName('function');
            value = funcNode ? this.getText(funcNode) : name;
          } else {
            value = this.getText(valueNode);
          }
        }

        const [context, contextType] = this.getParentContext(node);
        const classContext = (contextType === 'class_declaration' || contextType === 'abstract_class_declaration') ? context : null;

        variables.push({
          name,
          line_number: node.startPosition.row + 1,
          value,
          type: null,
          context,
          class_context: classContext,
          lang,
          is_dependency: false,
        });
      }
    }
    return variables;
  }

  // ─── Pre-scan for Symbol Map ─────────────────────────────────────────

  /**
   * Quick scan: extract just symbol names from a file (for the imports_map).
   * CGC typescript.py:502-577 pre_scan_typescript
   */
  preScanFile(filePath: string, source: string, langName: string): string[] {
    if (!this.initialized) throw new Error('Parser not initialized. Call init() first.');

    const language = this.languages.get(langName);
    if (!language) return [];

    this.tsParser.setLanguage(language);
    const tree = this.tsParser.parse(source);
    const root = tree.rootNode;

    const names: string[] = [];
    const queries = [
      '(class_declaration) @class',
      '(function_declaration) @function',
      '(variable_declarator) @var_decl',
      '(method_definition) @method',
    ];

    // TypeScript extras
    if (langName === 'typescript' || langName === 'tsx') {
      queries.push('(interface_declaration) @interface');
      queries.push('(type_alias_declaration) @type_alias');
    }

    for (const qStr of queries) {
      try {
        const q = language.query(qStr);
        for (const match of q.matches(root)) {
          for (const capture of match.captures) {
            const nameNode = capture.node.childForFieldName('name');
            if (capture.name === 'var_decl') {
              // Only include variable declarations where value is a function
              const valueNode = capture.node.childForFieldName('value');
              if (
                nameNode &&
                valueNode &&
                ['function', 'arrow_function', 'function_expression'].includes(valueNode.type)
              ) {
                names.push(this.getText(nameNode));
              }
            } else if (nameNode) {
              names.push(this.getText(nameNode));
            }
          }
        }
      } catch {
        // Query may not be valid for this language variant
      }
    }

    // Free WASM tree memory to prevent leaks
    tree.delete();

    return names;
  }
}
