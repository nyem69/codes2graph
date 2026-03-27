import type { ParsedFile } from './types.js';

export class SymbolMap {
  private map = new Map<string, Set<string>>();
  private reverseMap = new Map<string, Set<string>>();

  bootstrapFromMap(data: Map<string, Set<string>>): void {
    this.map = new Map(
      Array.from(data.entries()).map(([k, v]) => [k, new Set(v)])
    );
    this.reverseMap.clear();
    for (const [symbol, paths] of this.map) {
      for (const path of paths) {
        if (!this.reverseMap.has(path)) this.reverseMap.set(path, new Set());
        this.reverseMap.get(path)!.add(symbol);
      }
    }
  }

  removeFile(filePath: string): void {
    const symbols = this.reverseMap.get(filePath);
    if (!symbols) return;
    for (const symbol of symbols) {
      const paths = this.map.get(symbol);
      if (paths) {
        paths.delete(filePath);
        if (paths.size === 0) this.map.delete(symbol);
      }
    }
    this.reverseMap.delete(filePath);
  }

  addFile(filePath: string, data: ParsedFile): void {
    const symbolNames = new Set<string>();
    for (const fn of data.functions) {
      this.addSymbol(fn.name, filePath);
      symbolNames.add(fn.name);
    }
    for (const cls of data.classes) {
      this.addSymbol(cls.name, filePath);
      symbolNames.add(cls.name);
    }
    if (data.interfaces) {
      for (const iface of data.interfaces) {
        this.addSymbol(iface.name, filePath);
        symbolNames.add(iface.name);
      }
    }
    if (data.type_aliases) {
      for (const ta of data.type_aliases) {
        this.addSymbol(ta.name, filePath);
        symbolNames.add(ta.name);
      }
    }
    this.reverseMap.set(filePath, symbolNames);
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
