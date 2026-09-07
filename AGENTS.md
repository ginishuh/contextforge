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
- `npm run lint`: run the source gate (syntax, whitespace, line-budget ratchet).
- `npm run lint:eslint`: run the CI-only ESLint gate (`no-undef`,
  `no-unused-vars`, `no-shadow`). No devDependency; fetches a pinned `eslint`
  through `npx`, so it needs network access.
- `npm test`: run the Node test suite. Tests are organized by topic, one file
  per subject area, with shared helpers in `test/helpers/`.
- `node src/cli.js dbInfo`: inspect the configured storage backend.
- `node src/server.js`: run the HTTP server entrypoint when needed.
- `node src/mcp.js`: run the MCP server entrypoint when needed.

## GitHub Workflow
- Work on a branch and open a PR; do not push directly to `main`.
- Agents may create and update PRs, but must not merge them.
- CI is useful but not required for every docs-only change; run focused local
  verification before opening the PR.

## Runtime Mode
Runtime mode is checkout-local. Do not assume a clone is the live server.

At task start, check `connection.summary` or `connection.accessMode` with
`node src/cli.js dbInfo` or `bootstrap_context`. Verify `/healthz`, the service
manager, and current git state before making live runtime claims.

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

Use ContextForge for task-relevant project memory when available. Start or
resume with `bootstrap_context`, use `search` for targeted lookup, and follow
returned detail pointers. Prefer scope `repo` with the canonical scope key
`github.com/ginishuh/contextforge`. Shared and workspace retrieval remain opt-in.

Check `connection` metadata before treating a store as canonical. Memory is
reviewed knowledge; checkpoints are recent handoff state and candidates are
review material. Verify mutable Git, CI, runtime, and deployment state live.

Use the adapter-bound session for save/resume. If no binding exists, pass the
known session ID explicitly; never guess the latest session or create a new
manual session for an existing adapter stream. Save a checkpoint when useful;
durable memory writes remain deliberate. For concise agent guidance and links
to detailed topics, see `docs/agent-guide.md`.
