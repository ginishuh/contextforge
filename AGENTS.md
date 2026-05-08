# AGENTS.md - ContextForge

ContextForge is a standalone public project. Treat it as separate from any private reference implementation.

## Mission
Build a self-hosted memory and distillation runtime for coding agents.

The core idea is not another flat memory file. ContextForge should provide:
- canonical durable memory
- scoped retrieval
- raw evidence capture
- LLM-distilled checkpoints
- adapters for coding agents such as Codex and Claude Code
- optional MCP access

## Source Boundary
Private agent-memory systems may be useful reference material, but do not mutate them while working in this repo.

- Do not edit external/private workspaces unless the user explicitly asks.
- Do not copy private persona, user, customer, or runtime data into this repo.
- When borrowing code, extract generic engine logic only.
- Remove private paths, agent names, hooks, secrets, and assumptions.
- Keep this repo usable without any private runtime installed.

## Product Principles
- Distillation is a core capability, not a cosmetic add-on.
- Distillation providers must be pluggable.
- Prefer bring-your-own execution: `codex_exec`, `claude_code_exec`, direct APIs, or local model runners.
- Keep prompt preload small. Retrieve details on demand.
- Store runtime data locally by default and keep it out of git.
- Support `shared`, `repo`, and `local` scopes explicitly.
- Treat checkpoints as credible recent handoff state for continuity and
  planning; verify mutable live state before acting.
- Treat distilled checkpoints as compressed retrieval indexes: preserve
  concrete names, numbers, intervals, APIs, paths, commands, error strings,
  decisions, rationale, risks, conditions, next actions, and retrieval hooks.
- Promote durable facts and decisions intentionally.

## Storage Modes
Design for three storage modes:
- `local`: default single-machine SQLite storage
- `project-local`: repo-bound storage in a gitignored directory
- `remote`: VPS/server-backed canonical memory for multiple machines

Do not recommend git as the live storage backend for SQLite or raw runtime data. Git may be used for source code, examples, docs, and reviewed exports only.

## Build, Test, and Development Commands
- `npm test`: run the Node test suite.
- `node src/cli.js dbInfo`: inspect the configured storage backend.
- `node src/server.js`: run the HTTP server entrypoint when needed.
- `node src/mcp.js`: run the MCP server entrypoint when needed.

## Runtime Mode
Runtime mode is checkout-local. Do not assume a clone is the live server.

At task start, check `connection.mode` with `node src/cli.js dbInfo` or
`bootstrap_context`. Verify `/healthz`, the service manager, and current git
state before making live runtime claims.

Keep env files, tokens, API keys, DB files, and raw runtime data out of git and
reports. For local all-in-one, HTTP server, and external remote client
distinctions, follow `docs/runtime-modes.md`.

## 한국어 응대 원칙
- 운영 보고, 장애 공유, 작업 결과는 한국어로 작성합니다.
- 명령어, 경로, 환경 변수는 원문 그대로 백틱(``)으로 표기합니다.
- 긴급 이슈는 `현상 → 영향 → 조치 → 검증 → 재발 방지` 순서로 간결하게 보고합니다.
- 날짜/시간은 절대값으로 명시합니다. 예: `2026-04-26 14:30 KST`.

## Safety
- Never commit `.db`, `.db-wal`, `.db-shm`, raw logs, or `.env` files.
- Keep examples synthetic and non-personal.
- Document failure modes clearly.
- Distill failure should not erase raw evidence.
- Retrieval should be explainable enough to debug why a memory was returned.

## Style
- Keep code and docs boring, explicit, and portable.
- Favor small modules and clear contracts over clever abstractions.
- Prefer Node.js for continuity with the original implementation unless there is a strong reason to introduce another runtime.
- Use ASCII unless an existing file already requires otherwise.

## ContextForge MCP Bootstrap

Use ContextForge MCP for scoped project memory when it is available.

At task start, run a small bootstrap: search repo memory for this task, and
search shared memory only when cross-repo or user-wide policy may matter. Use
the inferred repo scope key, or an explicit `github.com/owner/repo` key when
cross-machine continuity matters.

Before relying on retrieval, distinguish storage authority. Remote
ContextForge storage is canonical shared memory for the configured scope;
local or project-local storage is machine/check-out local context unless the
user says otherwise.

Interpret search result types by trust role: `memory` is reviewed durable
state, `checkpoint` is credible recent handoff state that still needs live
verification, and `memory_candidate` is review material.

Critical session invariant: `bootstrap_context` does not create a session. In
Codex/Claude auto-ingest flows, use the adapter session id such as
`codex:<id>` or `claude_code:<id>` for `session_status`,
`distill_checkpoint`, and closeout promotion. Use `begin_session` only for a
manual `append_raw` evidence stream. Do not create a fresh `cf_...` session at
closeout to review candidates from an existing Codex/Claude session.

For full ContextForge MCP workflow rules, use the installed
`contextforge-memory` skill.
