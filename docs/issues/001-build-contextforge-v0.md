# Issue 001: Build the ContextForge v0 Core

## Summary

Build the first useful local version of ContextForge: a standalone, self-hosted
memory and distillation runtime for coding agents.

This work should happen inside this repository. Do not modify external reference
implementations while working here.

## Background

ContextForge is inspired by a working private agent-memory system, but it must
become a clean public project. The goal is not to copy a private implementation
as-is. The goal is to extract the generic product:

- canonical durable memory
- scoped retrieval
- raw evidence capture
- LLM-distilled checkpoints
- pluggable distillation providers
- future adapters for Codex, Claude Code, and MCP

Any private reference implementation is reference only. Do not mutate it from
this repository, and do not copy private data, paths, names, hooks, secrets, or
deployment assumptions.

## Product Direction

ContextForge should be positioned as:

```text
A self-hosted memory and distillation runtime for coding agents.
```

Important principles:

- Distillation is a core capability, not a cosmetic add-on.
- LLM providers are pluggable.
- Users can bring their own agent execution path, such as `codex exec`,
  `claude code`, direct API keys, or local model runners.
- Runtime data must stay out of git.
- Retrieval should be on demand, not prompt-dump based.
- `shared`, `repo`, and `local` scopes must be explicit.

## Non-Goals for v0

- Do not build a UI.
- Do not build multi-tenant SaaS.
- Do not require any private runtime or workspace.
- Do not require a remote VPS.
- Do not implement every provider.
- Do not commit real user memory, raw logs, SQLite DB files, or secrets.
- Do not make git the live storage backend for SQLite or raw runtime data.

## Proposed v0 Scope

### 1. Project Skeleton

Create a clean Node.js project structure.

Expected shape:

```text
src/
  cli.js
  config/
  storage/
  retrieval/
  distill/
  scopes/
  mcp/
scripts/
examples/
docs/
test/
```

Adjust if a simpler shape is better, but keep modules small and obvious.

### 2. SQLite Storage

Implement a local SQLite-backed store.

Suggested tables:

- `memories`
- `raw_events`
- `checkpoints`
- `memory_events`
- `schema_meta`

Minimum memory fields:

- `id`
- `scope_type`: `shared`, `repo`, or `local`
- `scope_key`
- `memory_key`
- `category`
- `content`
- `tags_json`
- `importance`
- `created_at`
- `updated_at`

Minimum raw event fields:

- `id`
- `scope_type`
- `scope_key`
- `session_id`
- `conversation_id`
- `role`
- `content`
- `metadata_json`
- `created_at`

Minimum checkpoint fields:

- `id`
- `scope_type`
- `scope_key`
- `session_id`
- `conversation_id`
- `summary_short`
- `summary_text`
- `decisions_json`
- `todos_json`
- `open_questions_json`
- `source_event_count`
- `provider`
- `created_at`

Use migrations rather than ad hoc schema creation if practical.

### 3. CLI Commands

Implement a small CLI with these commands first:

```bash
contextforge dbInfo
contextforge remember --scope repo --scopeKey <repo> --key <key> --content <text>
contextforge search --scope repo --scopeKey <repo> --query <query>
contextforge getMemory --scope repo --scopeKey <repo> --key <key>
contextforge appendRaw --scope repo --scopeKey <repo> --sessionId <id> --role user --content <text>
contextforge beginSession --scope repo --scopeKey <repo>
contextforge distillCheckpoint --scope repo --scopeKey <repo> --sessionId <id>
```

Names can be refined, but keep the surface small.

### 4. Retrieval

Start with explainable lexical retrieval.

Requirements:

- Search durable memories first.
- Include checkpoints only when requested or when the command explicitly asks for
  recent continuity.
- Do not include raw events by default.
- Return enough metadata to debug why a result matched.

FTS is preferred if easy, but plain lexical search is acceptable for v0 if tests
cover it.

### 5. Distillation Provider Contract

Define a provider interface before implementing adapters.

Input should include:

- session metadata
- raw event slice
- optional previous checkpoint
- requested output schema

Output should include:

- `summaryShort`
- `summaryText`
- `decisions`
- `todos`
- `openQuestions`
- `memoryCandidates`

The first provider can be a test/mock provider. After that, add one practical
provider.

Preferred first real provider:

- `codex_exec`

But keep the interface generic enough for:

- `claude_code_exec`
- direct model APIs
- local model runners
- z.ai-compatible API providers

### 6. Configuration

Support config from environment variables and/or a small config file.

Must include:

- data directory
- default scope
- distill provider
- provider command or API settings

Default data directory should be local and gitignored, for example:

```text
.contextforge/
```

or an OS user-data path. Document the final choice.

### 7. Tests

Add smoke tests for:

- DB initialization
- `remember`
- `search`
- `getMemory`
- `appendRaw`
- mock `distillCheckpoint`
- DB files not being required in git

Use synthetic data only.

## Acceptance Criteria

The next Codex session should finish this issue when all are true:

- `npm test` passes.
- `node src/cli.js dbInfo` works on a fresh checkout.
- A synthetic memory can be remembered and searched.
- A synthetic raw conversation can be appended.
- A checkpoint can be produced through a mock or real distill provider.
- Runtime DB files are ignored by git.
- README documents the v0 workflow.
- No private data, private names, or machine-specific paths are required at
  runtime.

## Suggested First Commands

From the repo:

```bash
sed -n '1,240p' AGENTS.md
sed -n '1,240p' README.md
sed -n '1,260p' docs/issues/001-build-contextforge-v0.md
git status --short --branch
```

Private reference implementations may be inspected only outside the public repo
and only as reference material. Do not edit them from this worktree.

## Implementation Notes

Prefer incremental extraction over bulk copying. The v0 repo should feel clean to
outside users who have never seen the private reference implementation.

If copying code from the original implementation:

- remove hardcoded private paths
- remove agent-specific or user-specific defaults
- remove private namespace assumptions
- replace private examples with synthetic examples
- keep only generic storage, retrieval, and distillation logic

## Open Questions

- Should the default storage be `.contextforge/` in the project or an OS data
  directory?
- Should `repo` scope keys default to the git remote URL, absolute path hash, or
  explicit user-provided key?
- Should MCP be in v0 or v0.1 after the CLI core is stable?
- Should the first real distill provider be `codex_exec` or direct API?
