#!/bin/bash
# Wrapper for launchd that sets file descriptor limits before starting codes2graph
ulimit -n 65536
echo "ulimit -n: $(ulimit -n)" >&2
echo "Starting codes2graph with args: $@" >&2
exec /Users/azmi/.nvm/versions/node/v22.12.0/bin/node \
  /Users/azmi/PROJECTS/LLM/codes2graph/node_modules/.bin/tsx \
  /Users/azmi/PROJECTS/LLM/codes2graph/src/index.ts \
  "$@"
