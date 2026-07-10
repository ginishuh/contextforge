# ContextForge

Self-hosted memory and distillation runtime for coding agents.

[한국어 README](README.ko.md) · [Full reference](docs/reference.md) ·
[Architecture](docs/architecture.md) · [Operations](docs/operations.md)

Current package version: `0.5.1`

ContextForge keeps scoped durable memory, raw evidence, and distilled checkpoint
handoffs in a self-hosted runtime. It gives Codex, Claude Code, OpenCode, Grok,
Cursor CLI, and MCP clients a shared memory boundary without treating every old
conversation as durable truth.

![ContextForge explainer comic](https://raw.githubusercontent.com/ginishuh/contextforge/main/docs/assets/contextforge-explainer-comic-en.jpg)

## Core Model

- `memory`: reviewed durable facts, decisions, contracts, preferences, and
  runbooks.
- `checkpoint`: compressed recent handoff state. Verify mutable git, CI,
  deployment, and runtime claims against live sources.
- `memory_candidate`: review material produced by distillation; never durable
  truth until explicitly promoted.
- `raw evidence`: user/assistant conversation evidence that survives failed
  distillation.
- `shared`, `repo`, and `local`: explicit retrieval scopes.

ContextForge supports three storage modes:

- `project-local` (default): repo-bound SQLite under `.contextforge/`.
- `local`: single-machine SQLite under the user data directory.
- `remote`: canonical HTTP server for several agents or machines.

Do not use Git as the live backend for SQLite or raw runtime data.

## What's New In 0.5.1

- Periodic thread/repo checkpoint consolidation and lifecycle visibility.
- Structured checkpoint handoffs with verification hints for mutable state.
- Durable distill/audit jobs, provider concurrency controls, and retry fencing.
- Bounded indexed retrieval, Unicode/Korean lexical search, pagination, and
  embedding lifecycle maintenance.
- MCP tool profiles, capability-scoped API tokens, readiness/metrics, verified
  backup/restore, and deterministic offline memory-quality gates.

See [CHANGELOG.md](CHANGELOG.md) for the complete unreleased and historical
record. English and Korean release summaries are checked against the package
version in CI.

## Quick Start

Requirements: Node.js 20 or newer.

```bash
npm install
npm run verify
node src/cli.js dbInfo
```

Create synthetic repo-scoped evidence and distill it with the built-in mock
provider:

```bash
export CONTEXTFORGE_STORAGE_MODE=project-local
export CONTEXTFORGE_DISTILL_PROVIDER=mock

node src/cli.js appendRaw \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session \
  --role assistant \
  --content "Synthetic handoff evidence for the demo."

node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session

node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --query "demo handoff" \
  --consultReason startup
```

All examples are synthetic. Keep `.env`, tokens, database files, sidecars, raw
logs, and private runtime evidence out of Git.

## Run As A Server Or MCP Sidecar

Local HTTP server:

```bash
node src/server.js
```

Local stdio MCP server:

```bash
node src/mcp.js
```

For a remote canonical deployment, start with the public template and follow
the runtime/operations guides:

```bash
cp examples/server.env.example .env
node src/server.js
```

- [Runtime modes](docs/runtime-modes.md)
- [Operator readiness, metrics, backup, and restore](docs/operations.md)
- [Capability and scope authorization](docs/api-token-authorization.md)
- [MCP profiles and context budgets](docs/mcp-surface-budget.md)

## Providers And Agent Integration

Distillation providers are pluggable. The repository ships `mock`, `codex_exec`,
and `openai_compatible`; candidate audit can use a separate execution provider.
Ordinary tests fail closed before external provider execution. Live-provider
tests require explicit opt-in.

```bash
CONTEXTFORGE_LIVE_TESTS=true npm run test:live
```

Agent adapters can ingest Codex, Claude Code, OpenCode, Grok, and Cursor CLI
sessions while preserving source provenance. The packaged memory skill explains
bootstrap, scoped search, session IDs, closeout, and promotion rules:

- [Install the contextforge-memory skill](docs/skills/contextforge-memory/INSTALL.md)
- [Skill workflow](docs/skills/contextforge-memory/SKILL.md)
- [Agent instruction snippets](docs/agent-instructions.md)
- [Full CLI/provider/operator reference](docs/reference.md)

## Retrieval And Quality

Workspace profiles are explicit opt-in retrieval topology. ContextForge does
not infer a workspace from the current repo scope, and creating a profile does
not enable federation by itself. There is no process-global default workspace.
The caller must pass `workspaceKey` to relevant MCP calls such as
`resolve_workspace`, `bootstrap_context`, and `search`. Core callers use
`resolveWorkspace`; the corresponding CLI command is `workspaceResolve`.
`bootstrapContext`, `search`, and `agentStart` also accept the option on their
core/CLI surfaces. Record the key in repo-local agent instructions or a wrapper
configuration when it should be used consistently. Without `workspaceKey`,
bootstrap and search retain their ordinary single-repo behavior.

- [Workspace profiles and architecture](docs/architecture.md)
- [Retrieval performance and diagnostics](docs/retrieval-performance.md)
- [Cursor pagination contracts](docs/list-pagination.md)
- [Offline memory quality evals](docs/quality-evals.md)

```bash
npm run benchmark:retrieval
npm run eval:quality
```

The offline quality suite uses public synthetic fixtures and isolated temporary
SQLite stores. Live LLM writing quality remains a separate opt-in concern.

## Development

```bash
npm run lint
npm test
npm run eval:quality
npm run verify:release
```

`npm run verify:release` checks README/docs links, command references, version
drift, npm package contents, and package size budgets. See
[Release and package policy](docs/releases.md).

## Safety

- Distillation failure must not erase raw evidence.
- Checkpoints are credible handoff state, not unquestioned live truth.
- Memory candidates require review before durable promotion.
- Secrets, credentials, customer data, and private runtime evidence do not
  belong in committed examples, reports, or durable memory.
- Remote mode is canonical only when clients actually use the remote server;
  verify runtime mode before making operational claims.

License: [MIT](LICENSE)
