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

Use ContextForge as a scoped memory and distillation sidecar. Keep this file as
the decision router; load only the reference needed for the current operation.
Do not preload every reference.

If a linked file is unavailable, the runtime skill installation is incomplete;
reinstall it before performing that operation rather than improvising omitted
safety rules.

## Core Invariants

- Verify mutable repo, GitHub, CI, deployment, database, and runtime facts from
  their live source before acting.
- Use this trust order: live source > reviewed durable `memory` > recent
  `checkpoint` handoff > unreviewed `memory_candidate`.
- Treat raw evidence and working summaries as session material, not durable
  memory. Treat provider recommendations as review input, not approval.
- Set `repo`, `shared`, or `local` scope intentionally. Inspect
  `connection.accessMode` and `storageMode` before assuming storage authority.
- Pass `workspaceKey` explicitly only for intended cross-repo retrieval; there
  is no inferred or process-global workspace default.
- `bootstrap_context` does not create a session.
- Preserve adapter session IDs such as `codex:<id>` and `claude_code:<id>`. Do
  not create a fresh `cf_...` session at closeout for adapter-ingested evidence.
- Do not propose memory promotions during startup or resume.
- Distillation failure must not erase raw evidence.
- Candidate disposition, audit approval, and durable promotion are separate
  states. An audited approval is not itself a durable write.
- Never broaden an empty closeout into a scope backlog scan; ordinary closeout
  is session/checkpoint scoped. Automatic audit is limited to the current
  `sessionId` or explicit `checkpointId`; it never scans the whole scope backlog.
- `audit_memory_candidates` must not promote or mutate durable memory.
- Promote only reviewed, stable, scoped, non-secret facts. Prefer a reviewed
  update proposal over duplicate durable memory.

## Core Workflow

### Start Or Resume

1. Inspect storage authority and choose scope.
2. Call `bootstrap_context` with a task-derived query and `consultReason` of
   `startup`, `resume`, `compaction_recovery`, or `agent_switch`.
3. Read the latest handoff first, then recent checkpoints and durable memory.
4. Verify live-state fields and warnings before editing or reporting status.
5. Use targeted `search` only when more detail is needed.

### Work

- Continue from current conversation context during an uninterrupted session;
  do not repeatedly consult the latest handoff for self-confirmation.
- Capture only meaningful user/assistant evidence. Preserve the original
  adapter session ID throughout status, distillation, and closeout calls.
- Use live tools for current runtime, DB, git, GitHub, CI, and deployment state.

### Distill And Close Out

1. Call `session_status` before expensive distillation.
2. Distill at a meaningful boundary and retain the `checkpointId`.
3. Audit only the current session/checkpoint candidate batch unless the task
   explicitly requests scope-wide backlog review.
4. Review audit evidence, then promote, reject, or route an update proposal.
5. Keep write-side automatic promotion disabled unless explicitly intended,
   server-enabled, and invoked with `dryRun: false`.

## Reference Router

Read only references relevant to the current task:

- [Tool Profiles And Storage Authority](references/tool-profiles-and-authority.md):
  missing MCP tools, profile/allowlist selection, scope choice, or authority
  diagnosis.
- [Bootstrap, Search, And Resume](references/bootstrap-and-retrieval.md): startup,
  resume, handoff interpretation, related scopes, or targeted retrieval.
- [Sessions And Evidence](references/sessions-and-evidence.md): session ID origin,
  manual versus adapter-ingested evidence, raw capture, or CLI lifecycle wrappers.
- [Distillation And Durable Jobs](references/distillation-and-jobs.md): checkpoint
  boundaries, provider jobs, retries/cancellation, or checkpoint consolidation.
- [Closeout, Promotion, And Corrections](references/closeout-and-corrections.md):
  ordinary closeout audit, promotion/update decisions, duplicates, automatic
  promotion, or user corrections.
- [Candidate Backlog And Lifecycle Operations](references/candidate-lifecycle.md):
  explicit scope backlog review, routing audited candidates, snooze/wake/stale,
  or lifecycle workers.
- [Workspaces, Scope Migration, And Storage Authority](references/workspaces-and-scope-migration.md):
  workspace federation, repository aliases/migration, or detailed connection
  diagnostics.
- [Embeddings And Maintenance](references/embeddings-and-maintenance.md): pending,
  failed, or stale vectors; rebuild/GC; migration retrieval issues; or raw-event
  retention.
