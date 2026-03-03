import type { ParsedFile } from './types.js';

export class SymbolMap {
  private map = new Map<string, Set<string>>();

  bootstrapFromMap(data: Map<string, Set<string>>): void {
    this.map = new Map(
      Array.from(data.entries()).map(([k, v]) => [k, new Set(v)])
    );
  }

  removeFile(filePath: string): void {
    for (const [symbol, paths] of this.map) {
      paths.delete(filePath);
      if (paths.size === 0) this.map.delete(symbol);
    }
  }

  addFile(filePath: string, data: ParsedFile): void {
    for (const fn of data.functions) {
      this.addSymbol(fn.name, filePath);
    }
    for (const cls of data.classes) {
      this.addSymbol(cls.name, filePath);
    }
    if (data.interfaces) {
      for (const iface of data.interfaces) {
        this.addSymbol(iface.name, filePath);
      }
    }
    if (data.type_aliases) {
      for (const ta of data.type_aliases) {
        this.addSymbol(ta.name, filePath);
      }
    }
  }

  resolve(symbolName: string): string[] {
    const paths = this.map.get(symbolName);
    return paths ? Array.from(paths) : [];
  }

  private addSymbol(name: string, filePath: string): void {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name)!.add(filePath);
  }
}
