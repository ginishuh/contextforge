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
- Treat checkpoints as recent continuity, not canonical truth.
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

## VPS 운영 공통 원칙 (/srv)
- 운영 작업은 항상 대상 리포의 `/srv/<repo>` 경로에서 직접 수행합니다.
- 작업 시작 전 `pwd`와 `git remote -v`로 리포/원격을 확인합니다.
- 서로 다른 리포의 배포 스크립트, Compose 파일, 환경 파일을 혼용하지 않습니다.
- 환경 변수는 대문자 스네이크 케이스를 사용하고, 새 값은 `.env.example` 또는 해당 예제 파일에 설명을 남깁니다.
- `.env`, 키 파일, 인증서, DB 백업, 토큰은 절대 커밋하지 않습니다.
- 공개 포트는 최소화하고 가능하면 `127.0.0.1`에 바인딩합니다. 외부 노출은 Nginx/리버스 프록시에서 처리합니다.
- 배포 전 백업/롤백 경로를 확인하고, 위험 작업은 되돌릴 수 있는 상태에서만 진행합니다.
- 배포 후에는 같은 리포 기준으로 상태, 헬스체크, 최근 로그를 검증합니다.

## 공통 운영 명령
- `docker compose ps`: 컨테이너 상태 확인.
- `docker compose logs --since 10m`: 최근 로그 확인.
- `/root/scripts/post_deploy_check.sh <repo-name|repo-path> [health_url ...]`: 배포 후 공통 점검.
- `journalctl -u <service> --since "1 hour ago" --no-pager`: systemd 서비스 장애 추적.
- `certbot certificates`: 인증서 만료와 도메인 매핑 점검.

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

Before relying on retrieval, distinguish storage authority. Remote ContextForge
storage is canonical shared memory for the configured scope; local or
project-local storage is machine/check-out local context unless the user says
otherwise.

Interpret search result types by trust level:
- `memory`: reviewed durable fact or decision.
- `checkpoint`: recent session continuity, not canonical truth.
- `memory_candidate`: unreviewed promotion candidate and review material.

Keep durable memory intentional. After distilling a checkpoint, review
`list_memory_candidates` and promote only stable, reviewed facts.

Use `remember` for new reviewed durable facts, decisions, preferences, or
runbook notes. Use `promote_memory_candidate` only after reviewing a checkpoint
candidate and confirming it is stable beyond the current task, scoped correctly,
and free of secrets or private data. Use `correct_memory` for changed facts and
`deactivate_memory` for stale facts.

For full ContextForge MCP usage rules, follow
`docs/agent-instructions.md`. That guide covers startup bootstrap, retrieval
order, repo scope keys, checkpoint candidate review, durable memory promotion,
raw evidence retention, and distillation cost discipline.

## JavaScript REPL (Node)

- Use `js_repl` for Node-backed JavaScript scratch work when it is more useful
  than one-off shell commands.
- Send raw JavaScript only. Do not wrap direct `js_repl` calls in JSON, quotes,
  or markdown fences.
- Prefer dynamic `await import(...)` over static import declarations.
- Top-level bindings persist across cells; reuse names carefully or reset the
  kernel with `js_repl_reset` when a clean state is needed.
- Avoid direct `process.stdin` / `process.stdout` / `process.stderr` access; use
  `console.log`, `codex.tool(...)`, and `codex.emitImage(...)`.
