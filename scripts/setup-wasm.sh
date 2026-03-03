#!/bin/bash
# scripts/setup-wasm.sh
# Copy tree-sitter WASM files from node_modules to project root

set -e
cd "$(dirname "$0")/.."

echo "Setting up tree-sitter WASM files..."

# Copy language grammars from tree-sitter-wasms
if [ -d "node_modules/tree-sitter-wasms/out" ]; then
  for f in node_modules/tree-sitter-wasms/out/tree-sitter-*.wasm; do
    base=$(basename "$f")
    if [ ! -f "$base" ]; then
      cp "$f" "$base"
      echo "  Copied $base"
    fi
  done
else
  echo "ERROR: tree-sitter-wasms not found. Run: npm install"
  exit 1
fi

# Copy core tree-sitter.wasm
if [ ! -f "tree-sitter.wasm" ]; then
  if [ -f "node_modules/web-tree-sitter/tree-sitter.wasm" ]; then
    cp "node_modules/web-tree-sitter/tree-sitter.wasm" .
    echo "  Copied tree-sitter.wasm"
  fi
fi

echo "WASM setup complete."
