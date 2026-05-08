---
name: contextforge-memory
description: >-
  Use when working with ContextForge MCP as an agent memory runtime: scoped
  bootstrap/search, storage authority checks, repo/shared/local scopes,
  resume/handoff context, raw evidence capture, Codex/Claude session IDs,
  distillation checkpoints, working summaries, memory candidates, closeout
  promotion, automatic promotion, memory correction/reconciliation, embeddings,
  or debugging sessionId/checkpointId/missing_closeout_source behavior.
---

# ContextForge Memory

Use ContextForge as a scoped memory and distillation sidecar for coding agents. It is not a replacement for live verification: verify mutable repo/GitHub/CI/runtime facts from their source before acting.

## Mental Model

ContextForge has layered state:

- `memory`: reviewed durable facts, decisions, preferences, and runbooks.
- `checkpoint`: distilled recent handoff state for continuity and planning.
- `memory_candidate`: unreviewed candidate generated from a checkpoint; review material only.
- raw evidence: user/assistant conversation evidence used for distillation.
- working summary/context: mutable session state, not durable memory.

Trust order for action: live source > reviewed durable memory > checkpoint handoff > memory_candidate.

## Scopes And Storage

Always set scope intentionally:

- `repo`: project/repository-specific memory. Prefer canonical `scopeKey` like `github.com/owner/repo`; pass `repoPath` or `cwd` when the MCP process cwd differs from the checkout.
- `shared`: cross-repo/user-wide conventions. Include only when it may matter.
- `local`: machine-specific context; opt in only when appropriate.

Before relying on results, check connection metadata and storage authority from `bootstrap_context` or `db_info`:

- `connection.mode: "remote-client"`: this agent is delegating to a remote ContextForge server.
- `connection.mode: "http-server"`: the tool is running on the ContextForge HTTP server itself; the server may own a local SQLite store.
- `connection.mode: "direct-local"`: the tool is running as a local ContextForge process.
- `remote` storage from a remote-client wrapper means server-backed canonical memory for the configured scope.
- `local` or `project-local` storage from a direct local process is local context unless the user or repo `AGENTS.md` says it is authoritative.

Do not decide downstream repo connection mode from server storage alone. A remote MCP endpoint can report its server-owned SQLite store as `local`; that does not mean the consuming repo is local-only.

## Startup Bootstrap

At the start of non-trivial project work:

1. Call `bootstrap_context` with a task-derived query, `scope: "repo"`, and `repoPath`, `cwd`, or explicit `scopeKey`.
2. Set `includeShared: true` only for cross-repo/user-wide policy, credentials location, deployment, or recurring preference questions.
3. Read the storage block and result trust roles.
4. Use targeted `search` calls only when more detail is needed.
5. Use `get_memory` only when you already know the exact durable key.

`bootstrap_context` does not create a session. It retrieves scoped context.

## Session IDs

Do not create a fresh `cf_...` session at closeout to review candidates from an existing Codex or Claude Code run.

Use session IDs by origin:

- `codex:<native-session-id>`: raw evidence/checkpoints ingested from Codex rollout sessions.
- `claude_code:<native-session-id>`: raw evidence/checkpoints ingested from Claude Code transcripts.
- `cf_...`: ContextForge session from `begin_session`; use only for a manual evidence stream where this agent will call `append_raw` itself.

When resuming a known session, pass that `sessionId` to `bootstrap_context`, `sync_resume_context`, `session_status`, `distill_checkpoint`, and closeout tools as needed.

## Resume And Handoff

For "continue", "yesterday", prior issue/PR follow-up, or cross-agent handoff:

1. Prefer `sync_resume_context`.
2. Treat checkpoints as credible recent handoff notes.
3. Treat memory candidates as review material only.
4. Verify live mutable state before editing or reporting final status.
5. Do not propose memory promotions during start/resume sync.

## Evidence Capture

Use `append_raw` for meaningful user/assistant evidence when the current task needs later distillation. Do not store raw tool output dumps as conversation memory; summarize verified facts in assistant evidence or preserve tool payloads as artifacts.

Manual evidence stream:

1. `begin_session`
2. `append_raw`
3. `session_status`
4. `distill_checkpoint`
5. closeout candidate review

Adapter-ingested stream:

1. Preserve or recover the adapter session ID, for example `codex:<id>` or `claude_code:<id>`.
2. Use that ID for `session_status`, `distill_checkpoint`, and closeout.
3. Do not replace it with a new `cf_...` session.

## Distillation

Use `session_status` before expensive distillation. It reports raw counts, latest checkpoint, candidate counts, distill thresholds, and whether distillation is currently useful.

Call `distill_checkpoint` at meaningful boundaries:

- after a feature is implemented and tested
- after a PR/issue reaches a stable state
- after an incident is diagnosed or resolved
- before switching agents or machines
- before ending a long session

After `distill_checkpoint`, keep:

- returned `checkpointId`
- `memoryCandidateCount`
- usage from `distill_usage` when cost matters

Distillation failure must not erase raw evidence.

## Closeout Promotion

At closeout triggers only, review durable memory candidates:

1. If `distill_checkpoint` returned candidates, call `suggest_memory_promotions` with the returned `checkpointId` or the current `sessionId`.
2. If `session_status` reports `latestCheckpointMemoryCandidateCount > 0`, call `suggest_memory_promotions` or `list_memory_candidates` with that same `sessionId` or latest checkpoint id.
3. If `suggest_memory_promotions` returns `missing_closeout_source`, no current-session review happened. Provide `sessionId` or `checkpointId`.
4. Promote only reviewed, stable, scoped, non-secret facts.
5. Prefer `promote_memory_candidate` by `candidateId`.
6. Use `remember` or `promote_memory` for a corrected durable write when the candidate key/content is wrong.
7. Use `reject_memory_candidate` for wrong candidates.

`suggest_memory_promotions` defaults to `promotionRecommendation: "promote"`. If candidates exist but proposals are empty, inspect with `list_memory_candidates`; for `promotionRecommendation: "review"` candidates, either call `suggest_memory_promotions` with `promotionRecommendation: "review"` or manually review the listed candidates.

Use `auto_promote_memory_candidates` only when automatic promotion is explicitly wanted. It must include `sessionId` or `checkpointId`; real promotion requires server-side enablement and `dryRun: false`.

## What To Promote

Good durable memories:

- stable API contracts and permission/domain decisions
- final issue/PR outcomes that affect future work
- repo-specific runbooks or failure modes
- architecture decisions and rationale
- recurring repo/user preferences after review
- cross-agent lessons that should survive sessions

Do not promote:

- transient branch position or draft CI status
- raw command logs or raw commit logs
- secrets, tokens, credentials, customer data, or PII
- facts cheaper and safer to read live
- low-confidence or high-sensitivity candidates without explicit review

## Corrections

For user corrections such as "that's wrong" or "memory should say X":

1. Use `reconcile_memory` first.
2. Explain the basis for prior memory and assess conflicts.
3. Use `correct_memory`, `deactivate_memory`, or memory update candidates only after the correction is clear and approved when required.
4. Do not edit checkpoints directly; correct durable memory or reject candidates.

## Embeddings And Maintenance

Embeddings are the supported quality path for retrieval. If `db_info` or `bootstrap_context` reports pending, failed, or stale vector sources:

1. Call `list_embedding_jobs`.
2. Call `process_embedding_jobs`, using `retryFailed: true` when appropriate.
3. Use `rebuild_embeddings` only for intentional backfill or dimension changes.

Use `prune_raw_events` only according to retention policy; durable memory and checkpoints are preserved separately.
