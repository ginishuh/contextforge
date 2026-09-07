---
name: contextforge-memory
description: >-
  Use ContextForge for scoped memory retrieval, session continuity, and deliberate
  memory updates. Consult advanced references for evidence capture, candidate
  review, or runtime maintenance when the task needs them.
---

# ContextForge Memory

Use ContextForge as a scoped memory and distillation sidecar. Read only the
reference needed for the current operation.

## Everyday Rules

- Trust live state over reviewed `memory`, checkpoint handoff, and candidates.
- Check `connection.accessMode` before treating a store as remote canonical
  memory rather than checkout-local context.
- Keep `repo`, `shared`, and `local` scope explicit. `workspaceKey` is opt-in;
  neither membership nor host cwd proves or broadens the target scope.
- `bootstrap_context` does not create a session. Preserve an adapter session ID
  for save/resume; otherwise pass `sessionId` and never guess a latest session.
- Raw evidence is retained source material; working context is mutable session
  state. Durable memory needs a deliberate reviewed write; a provider
  recommendation is not approval.
- Distillation failure must not erase raw evidence.

Use the default `agent-core` surface for ordinary coding work. Its ten tools
are `db_info`, `bootstrap_context`, `search`, `get_memory`, `remember`,
`list_checkpoints`, `list_memory_candidates`, `distill_checkpoint`,
`correct_memory`, and `deactivate_memory`.

Use `bootstrap_context` for a task-relevant start or resume, then `search` and
detail pointers when needed. It does not create a session. Check mutable state
from its live source before acting.

Distill when the user or work boundary makes a checkpoint useful; this is not a
required daily lifecycle. With an adapter binding, omit `sessionId` for the
current session. Without a binding, supply the known session ID explicitly.

Use `remember`, `correct_memory`, and `deactivate_memory` deliberately for
durable reviewed facts. Candidate review, audit, jobs, evidence ingestion, and
workspace administration belong to the advanced references below.

## Reference Router

Read only references relevant to the current task:

- [Tool Profiles And Storage Authority](references/tool-profiles-and-authority.md):
  missing MCP tools, profile/allowlist selection, scope choice, or authority
  diagnosis.
- [Bootstrap, Search, And Resume](references/bootstrap-and-retrieval.md): retrieval,
  detail pointers, handoff, or related scopes.
- [Sessions And Evidence](references/sessions-and-evidence.md): binding, raw capture,
  manual or adapter sessions, or CLI lifecycle wrappers.
- [Distillation And Durable Jobs](references/distillation-and-jobs.md): checkpoint
  timing, provider jobs, retries, or consolidation.
- [Closeout, Promotion, And Corrections](references/closeout-and-corrections.md):
  ordinary closeout audit, promotion/update decisions, duplicates, automatic
  promotion, or user corrections.
- [Candidate Backlog And Lifecycle Operations](references/candidate-lifecycle.md):
  scope backlog review, audit routing, snooze/wake/stale, or lifecycle workers.
- [Workspaces, Scope Migration, And Storage Authority](references/workspaces-and-scope-migration.md):
  workspace federation, repository aliases/migration, or detailed connection
  diagnostics.
- [Embeddings And Maintenance](references/embeddings-and-maintenance.md): pending,
  failed, or stale vectors; rebuild/GC; migration retrieval issues; or raw-event
  retention.
