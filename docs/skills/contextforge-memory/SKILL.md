---
name: contextforge-memory
description: >-
  Use when working with ContextForge MCP as an agent memory runtime: scoped
  bootstrap/search, storage authority checks, repo/shared/local scopes,
  resume/handoff context, raw evidence capture, Codex/Claude session IDs,
  distillation checkpoints, working summaries, memory candidates, scope backlog
  review, candidate audit lifecycle, snooze/stale handling, supervised lifecycle
  workers, closeout promotion, automatic promotion, memory
  correction/reconciliation, embeddings, or debugging
  sessionId/checkpointId/missing_closeout_source behavior.
---

# ContextForge Memory

Use ContextForge as a scoped memory and distillation sidecar for coding agents. It is not a replacement for live verification: verify mutable repo/GitHub/CI/runtime facts from their source before acting.

Linked files under `references/` are on-demand guidance. If a linked file is
unavailable, the runtime skill installation is incomplete; reinstall it before
performing that operation rather than improvising omitted safety rules.

## Mental Model

ContextForge has layered state:

- `memory`: reviewed durable facts, decisions, preferences, and runbooks.
- `checkpoint`: distilled recent handoff state for continuity and planning. A
  checkpoint may include `structured` handoff state for the next agent.
- `memory_candidate`: unreviewed candidate generated from a checkpoint; review
  material only. Candidate v2 review fields such as `durabilityReason`,
  `riskReason`, `evidenceRefs`, and `suggestedAction` may be present, but a
  provider suggestion is not approval. Candidate disposition and audit state
  are independent; an audited `approve` decision is not itself a durable write.
- raw evidence: user/assistant conversation evidence used for distillation.
- working summary/context: mutable session state, not durable memory.

Trust order for action: live source > reviewed durable memory > checkpoint handoff > memory_candidate.

## MCP Tool Profiles

ContextForge intentionally keeps the default prompt surface small. Missing MCP
tools may mean the server selected a narrower profile; this is not evidence that
the underlying core or remote API lacks the operation.

- `agent-core` (default): bootstrap, scoped retrieval, manual evidence,
  checkpointing, durable distill submission/status, and ordinary closeout.
- `review`: `agent-core` plus candidate backlog planning, audit inventory and
  submission, snooze/wake/stale review actions, duplicate/update review,
  correction, promotion, and deactivation.
- `operator`: all runtime operations except workspace mutations; use for job
  workers, due distills/consolidations, mutating candidate lifecycle stages,
  retention, embeddings, and usage.
- `workspace-admin`: workspace profiles/members/routing and scope migration.
- `all`: compatibility surface for clients that previously received every tool.

Operators can inspect the exact selected surface with
`node src/mcp.js --describe-surface`. Set `CONTEXTFORGE_MCP_PROFILE` on either
stdio or HTTP server processes, or `CONTEXTFORGE_MCP_TOOLS` for an exact
allowlist. Do not broaden a normal agent registration merely because one
maintenance task is needed; use a separate operator/admin registration where
the client supports it. Profile selection remains functional when this skill is
not installed, but this skill is the authoritative detailed workflow guide.

`migrate_scope` is also available to `operator` because scope migration is a
storage-maintenance operation; workspace mutation tools remain excluded there.

## Scopes And Storage

Always set scope intentionally:

- `repo`: project/repository-specific memory. Prefer canonical `scopeKey` like `github.com/owner/repo`; pass `repoPath` or `cwd` when the MCP process cwd differs from the checkout.
- `shared`: cross-repo/user-wide conventions. Include only when it may matter.
- `local`: machine-specific context; opt in only when appropriate.

Workspace profiles are retrieval topology; storage modes are authority. Workspace
selection is explicit per call, so pass `workspaceKey` only when cross-repo
retrieval is intended. There is no inferred or process-global default.

Before relying on results, inspect `connection.summary`,
`connection.accessMode`, and top-level `storageMode` from `bootstrap_context` or
`db_info`. `remote-client` access is server-backed canonical memory for the
configured scope. `direct-local` with `local` or `project-local` storage is
checkout- or machine-local unless repo instructions say otherwise.

Read [Workspaces, Scope Migration, And Storage Authority](references/workspaces-and-scope-migration.md)
when configuring workspace federation, repository aliases or migrations,
agent-neutral CLI wrappers, or detailed connection diagnostics.

## Session-First Consult Policy

Latest handoff is for continuity recovery. Do not use it as routine
self-confirmation when the current uninterrupted session still contains the
user's intent and recent decisions.

Use paths by reason:

- `startup`, `resume`, `compaction_recovery`, `agent_switch`: call
  `bootstrap_context` with that `consultReason` and read latest handoff.
- active uninterrupted session: proceed from current conversation context.
- file/API/error/domain lookup during active work: use targeted `search`.
- runtime/DB/git/GitHub/CI/health/deployment questions: use live checks such as
  `db_info`, SQL, git, GitHub, `/healthz`, or service manager.

If current session context conflicts with a handoff, prefer current context or
live verification. Treat handoff as compressed stale-prone context.

## Startup Bootstrap

At the start of non-trivial project work:

1. Call `bootstrap_context` with a task-derived query, `scope: "repo"`,
   `repoPath`, `cwd`, or explicit `scopeKey`, and `consultReason: "startup"`.
2. Read `handoff.latestHandoff` first when present. It is the deterministic
   newest handoff checkpoint and is loaded independently from search ranking.
3. Inspect `handoff.latestHandoff.structured`, especially
   `structured.liveState`, `warnings`, `staleReasons`, and `verifyHints`.
   Treat repo/branch/PR/head commit/CI/worktree/runtime/deployment values as
   observed mutable state and verify them from live sources before acting.
4. Read `handoff.latestCheckpoints` next for recent work status, decisions,
   open todos, branch/PR/CI flow, and next actions.
5. Read `handoff.latestConsolidation.thread` and
   `handoff.latestConsolidation.repo` when present. These are time-window
   checkpoint summaries for period context, not durable memory.
6. Inspect `memoryLifecycle` for candidate/promotion freshness:
   `latestCandidateAt`, `latestPromotedAt`, pending counts, and recent
   candidate/promotion counts.
7. For multi-repo work, pass repo `relatedScopeKeys` for parent/suite/subrepo scopes whose latest handoff may matter. `latestCheckpointLimit` applies per scope.
8. When a workspace profile is configured and the task needs cross-repo context, pass `workspaceKey` to receive bounded supplemental workspace results in `workspace.results`.
9. Set `includeShared: true` only for cross-repo/user-wide policy, credentials location, deployment, or recurring preference questions.
10. Read the storage block and result trust roles.
11. Use targeted `search` calls only when more detail is needed. For active-session cross-repo lookups, pass `workspaceKey`; without it, `search` keeps the ordinary scoped array response.
12. Use `get_memory` only when you already know the exact durable key.

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

1. Call `bootstrap_context` first with `consultReason: "resume"` or
   `consultReason: "compaction_recovery"`; its latest checkpoint handoff is not
   dependent on semantic search ranking.
2. Prefer `handoff.latestHandoff` for the immediate resume state, then read
   other `handoff.latestCheckpoints` if more recent context is needed.
3. Use `handoff.latestConsolidation` for broader thread/repo period context
   when ordinary latest checkpoints are too thin.
4. If structured handoff includes live-state warnings or verification hints,
   run those checks before editing files, reporting status, or making git/GitHub
   claims.
5. Use `sync_resume_context` only when the exact `sessionId` is known and session working state or raw tail is needed.
6. Treat checkpoints as credible recent handoff notes and prefer them over durable memory for fast-moving work status.
7. Treat memory candidates as review material only.
8. Verify live mutable state before editing or reporting final status.
9. Do not propose memory promotions during start/resume sync.

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

For CLI closeout, `agentCloseout --agent <adapter> --sessionId <adapter:id>`
wraps `sessionStatus`, optional `distillCheckpoint`, `auditMemoryCandidates`,
and `suggestMemoryPromotions`. It defaults to dry-run and does not promote
durable memory by itself.

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

Checkpoint `structured` output is recent handoff state, not durable truth. It
can preserve work status, live-state observations, changes, verification,
risks, and next actions. Do not promote structured live state directly into
durable memory unless it is stable, reviewed, and no cheaper live source exists.

For distill or candidate-audit provider work that must survive a client
disconnect or server restart:

1. Submit with `submit_distill_job` or `submit_audit_job` and keep the returned
   `jobId`.
2. Poll with `get_job`; use `list_jobs` for bounded operator inspection.
3. A server-side operator must run `process_jobs`. Submission does not execute
   the provider inside the client request.
4. Duplicate source-window/policy submissions reuse a job by default. Supply a
   deliberate `idempotencyKey` only when the caller needs a distinct run.
5. `cancel_job` guarantees cancellation only while a job is queued. A running
   provider call returns `running_not_interruptible` and is not force-killed.
6. Candidate audit jobs still call the provider once per selected candidate;
   the durable queue is not a true provider batch contract.
7. Provider execution is at-least-once. Lease-attempt fencing blocks stale
   checkpoint/audit commits, but a lost lease may already have incurred model
   cost. After `maxAttempts` exhaustion, review the failure before using a new
   `idempotencyKey`; `retryFailed` does not reset the budget.

## Checkpoint Consolidation

Use checkpoint consolidation when a repo or thread has many short checkpoints
and bootstrap would otherwise expose only a thin latest slice.

- `list_due_consolidations` is the read-only planning call.
- `process_consolidations` creates a time-window checkpoint summary; use
  `dryRun: true` first for unattended or scripted flows.
- Set `target: "thread"` with `sessionId` for one agent thread, or
  `target: "repo"` for the scoped repo window.
- Use `windowKind: "daily"` plus `day` for a UTC day window, or
  `windowKind: "custom"` with explicit `coversFrom` and `coversTo`.
- Consolidation uses existing `source: "distill"` checkpoints as evidence. It
  does not read raw evidence, does not create durable memory by itself, and
  should create at most a few review candidates for reinforced durable facts.

## Candidate Backlog Operations

Ordinary closeout is session/checkpoint scoped. Never broaden an empty closeout
proposal into an implicit scope scan. Read
[Candidate Backlog And Lifecycle Operations](references/candidate-lifecycle.md)
only when explicitly reviewing a scope-wide backlog, routing audited candidates,
using snooze/wake/stale actions, or operating lifecycle workers.

## Closeout Promotion

At closeout triggers only, make sure durable memory candidates are audited:

1. When distilling closeout evidence, pass `auditTrigger` to `distill_checkpoint`
   so ContextForge selects a bounded candidate batch automatically and invokes
   the configured audit provider once per selected candidate.
2. Automatic candidate audit is scoped to the current `sessionId` or explicit
   `checkpointId`. It never scans the whole scope backlog.
3. Audit results are stored on pending candidates. Automatic promotion controls
   only whether audit-approved strict-safe results are written to durable memory.
4. Use `audit_memory_candidates` to inspect stored audited recommendations or to
   audit unaudited candidates in the same closeout selection batch. It persists
   append-only audit attempt provenance, compatibility review metadata, and
   usage events, but must not promote or mutate durable memory.
5. Promote only reviewed, stable, scoped, non-secret facts.
6. Prefer `promote_memory_candidate` by `candidateId`.
7. If `suggest_memory_promotions` reports a duplicate, refinement, supersedes,
   or conflict assessment, prefer reviewing its `memory_update_candidates`
   proposal over writing a new durable memory.
8. Use `remember` or `promote_memory` for a corrected durable write when the candidate key/content is wrong.
9. Use `reject_memory_candidate` for wrong candidates.

`suggest_memory_promotions` defaults to `promotionRecommendation: "promote"`. If candidates exist but proposals are empty, inspect with `list_memory_candidates`; for `promotionRecommendation: "review"` candidates, either call `suggest_memory_promotions` with `promotionRecommendation: "review"` or manually review the listed candidates.

Use `audit_memory_duplicates` to inspect existing active durable memories for
merge candidates. It is read-only unless `createUpdateCandidates=true`, and even
then it only creates `merge_duplicate_memories` review proposals. For large
scopes, set `scanLimit` intentionally because duplicate audit compares memory
pairs inside the scanned window.

Use `auto_promote_memory_candidates` only when automatic write-side promotion is
explicitly wanted. It must include `sessionId` or `checkpointId`; real promotion
requires server-side enablement and `dryRun: false`. Candidate audit itself is
not the toggle; promotion writes are the toggle.

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

Read [Embeddings And Maintenance](references/embeddings-and-maintenance.md) when
retrieval reports pending, failed, or stale vector sources; when rebuilding or
garbage-collecting derived data; or when applying raw-event retention.
