# ContextForge

Self-hosted memory and distillation runtime for coding agents.

ContextForge is designed for agents that need more than a flat memory file:
canonical project memory, scoped retrieval, evidence-preserving raw logs, and
LLM-backed distillation into checkpoints.

## Goals

- Keep durable memory in a canonical local store.
- Support shared, repo, and local scopes without mixing them accidentally.
- Use retrieval on demand instead of dumping large memory files into context.
- Treat distillation as a core capability with pluggable providers.
- Work with coding agents such as Codex and Claude Code through adapters or MCP.

## Storage Modes

- `local`: default single-machine SQLite storage.
- `project-local`: repo-bound storage in a gitignored directory.
- `remote`: VPS or server-backed canonical memory for multiple machines.

## Distillation

ContextForge assumes useful checkpoints need an LLM. The runtime should support
bring-your-own distillation providers, such as:

- `codex_exec`
- `claude_code_exec`
- direct model APIs
- local model runners

The v0 implementation ships with a `mock` provider first. It gives the storage,
CLI, and checkpoint contract something deterministic to test before real model
adapters are added.

## Quick Start

Requirements:

- Node.js 20 or newer

Install dependencies:

```bash
npm install
```

Run the test suite:

```bash
npm test
```

Inspect or initialize the local store:

```bash
node src/cli.js dbInfo
```

By default, runtime data is stored in `.contextforge/contextforge.db` under the
current working directory. This directory and SQLite sidecar files are ignored by
git. To use another location, set `CONTEXTFORGE_DATA_DIR`.

## v0 CLI Workflow

Create or update a durable memory:

```bash
node src/cli.js remember \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key storage-mode \
  --category decision \
  --tag storage \
  --content "Use local SQLite in .contextforge for v0 runtime state."
```

Search durable memories:

```bash
node src/cli.js search \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --query "sqlite runtime"
```

Fetch one memory by key:

```bash
node src/cli.js getMemory \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key storage-mode
```

Start a session and append synthetic raw evidence:

```bash
node src/cli.js beginSession \
  --scope repo \
  --scopeKey github.com/example/contextforge

node src/cli.js appendRaw \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session \
  --role user \
  --content "Decision: keep v0 retrieval lexical and explainable."
```

Distill a checkpoint with the mock provider:

```bash
node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

CLI output is JSON so adapters and scripts can consume it directly.

## Public Repo Hygiene

- Runtime state lives under `.contextforge/` by default and is ignored by git.
- SQLite database files and sidecars are ignored.
- Examples and tests use synthetic data only.
- ContextForge does not require a private workspace or external agent runtime.

## Status

Early v0 core. The current implementation includes SQLite migrations, scoped
durable memories, raw event capture, lexical search with match reasons, and mock
checkpoint distillation. Real distillation providers and MCP/agent adapters are
future work.
