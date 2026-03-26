// --- Parser output types (match CGC's Python dicts) ---
// See CGC: tools/languages/typescript.py:159 and tools/graph_builder.py:272

export interface ParsedFunction {
  name: string;
  line_number: number;
  end_line: number;
  args: string[];
  cyclomatic_complexity: number;
  source?: string;
  docstring?: string;
  decorators: string[];
  context: string | null;        // parent function/class name
  context_type: string | null;   // 'function_declaration' | 'class_declaration' | etc
  class_context: string | null;  // enclosing class name (if method)
  lang: string;
  is_dependency: boolean;
}

export interface ParsedClass {
  name: string;
  line_number: number;
  end_line: number;
  bases: string[];
  source?: string;
  docstring?: string;
  decorators: string[];
  context: string | null;
  lang: string;
  is_dependency: boolean;
}

export interface ParsedVariable {
  name: string;
  line_number: number;
  value: string | null;
  type: string | null;
  context: string | null;
  class_context: string | null;
  lang: string;
  is_dependency: boolean;
}

export interface ParsedImport {
  name: string;       // imported symbol name ('default', '*', or named)
  source: string;     // module path/name
  alias: string | null;
  line_number: number;
  lang: string;
}

export interface ParsedCall {
  name: string;       // called function/method name
  full_name: string;  // full call expression text (e.g. 'this.method()')
  line_number: number;
  args: string[];
  inferred_obj_type: string | null;
  context: [string, string, number] | [null, null, null]; // [caller_name, caller_type, caller_line]
  class_context: [string, string] | [null, null];         // [class_name, class_type]
  lang: string;
  is_dependency: boolean;
}

export interface ParsedInterface {
  name: string;
  line_number: number;
  end_line: number;
  source?: string;
}

export interface ParsedTypeAlias {
  name: string;
  line_number: number;
  end_line: number;
  source?: string;
}

export interface ParsedFile {
  path: string;
  lang: string;
  functions: ParsedFunction[];
  classes: ParsedClass[];
  variables: ParsedVariable[];
  imports: ParsedImport[];
  function_calls: ParsedCall[];
  interfaces?: ParsedInterface[];    // TS only
  type_aliases?: ParsedTypeAlias[];  // TS only
  is_dependency: boolean;
}

// --- Graph client types ---

export interface ResolvedCall {
  caller_name: string;
  caller_file_path: string;
  caller_line_number: number;
  called_name: string;
  called_file_path: string;
  line_number: number;
  args: string[];
  full_call_name: string;
}

export interface ResolvedInheritance {
  child_name: string;
  child_file_path: string;
  parent_name: string;
  parent_file_path: string;
}

// --- Watcher types ---

export interface WatchOptions {
  debounceQuiet: number;  // ms of quiet before processing (default: 5000)
  debounceMax: number;    // max ms before forced processing (default: 30000)
  extensions: string[];   // file extensions to watch
  indexSource: boolean;    // store full source code in graph
  skipExternal: boolean;  // skip unresolved external calls
}

export interface IndexOptions {
  extensions: string[];   // file extensions to index
  indexSource: boolean;    // store full source code in graph
  skipExternal: boolean;  // skip unresolved external calls
  batchSize: number;      // files per batch (default: 50)
  force: boolean;         // wipe existing graph for this repo first
}
