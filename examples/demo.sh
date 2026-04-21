#!/usr/bin/env bash
set -euo pipefail

export CONTEXTFORGE_DATA_DIR="${CONTEXTFORGE_DATA_DIR:-$(mktemp -d -t contextforge-demo-XXXXXX)}"

node src/cli.js dbInfo

node src/cli.js remember \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key storage-mode \
  --category decision \
  --tag storage \
  --content "Use local SQLite in .contextforge for v0 runtime state."

node src/cli.js search \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --query "sqlite runtime"

node src/cli.js appendRaw \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session \
  --role user \
  --content "Decision: keep v0 retrieval lexical and explainable."

node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
