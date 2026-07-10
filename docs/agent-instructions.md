# ContextForge Agent Instruction Snippets

This document is a compact compatibility entrypoint for agents that need
copyable instructions. It is not the full ContextForge MCP manual.

For full workflow rules, use the installed `contextforge-memory` skill. The
ContextForge repo packages that skill from:

- `docs/skills/contextforge-memory/SKILL.md`

For rules about what belongs in a repository `AGENTS.md`, use:

- `docs/agents-md-guide.md`

For local all-in-one, HTTP server, and external remote client distinctions,
use:

- `docs/runtime-modes.md`

## Minimal AGENTS.md Snippet

Use this when a repository only needs a short ContextForge bootstrap pointer.
Replace `github.com/example/repo` when a canonical scope key is required.

```text
Use ContextForge MCP for scoped project memory when it is available.

At task start, after context compaction, or when resuming prior work, call
`bootstrap_context` with this task, `scope: "repo"`, this repo path or the
canonical scope key `github.com/example/repo`, and an explicit
`consultReason` such as `startup`, `resume`, `compaction_recovery`, or
`agent_switch`. Include shared memory only when cross-repo or user-wide policy
may matter.

If the repository belongs to a configured multi-repo workspace, use
`resolve_workspace` first to inspect the scope plan, or pass `workspaceKey` to
`bootstrap_context` when cross-repo context is needed during startup/resume.
ContextForge does not infer this key from the current repo or workspace
membership. Creating the profile does not activate federation by itself, so
repo-local instructions or an adapter/wrapper must supply the intended
`workspaceKey` on each relevant `resolve_workspace`, `bootstrap_context`, or
`search` call, or through `workspaceResolve`, `bootstrapContext`, or
`agentStart`. There is no process-global default workspace. Without the key,
retrieval remains single-repo.
Workspace profiles do not change storage mode; they only define which existing
scopes are consulted together. Keep ordinary single-repo bootstrap as the
default unless the task needs cross-repo context. When workspace bootstrap is
enabled, read top-level `results` as the primary-scope view and
`workspace.results` as bounded supplemental member-scope context. Top-level
`includeShared=true` does not by itself enable workspace shared retrieval;
workspace shared results require a workspace routing rule with `includeShared`.
During active work, targeted `search` calls may also pass `workspaceKey` when a
file/API/error/domain lookup needs cross-repo memory. Without `workspaceKey`,
`search` keeps its ordinary scoped array response; with `workspaceKey`, inspect
the separate `workspace` block for supplemental member-scope results.

Do not call `bootstrap_context` just to re-confirm current intent inside the
same uninterrupted active session. For active-session file/API/error/domain
lookups, use targeted `search`. For runtime, DB, git, GitHub, CI, health, or
deployment state, use live checks such as `db_info`, SQL, git, GitHub,
`/healthz`, or the service manager.

Before relying on retrieval, distinguish storage authority. Remote
ContextForge storage is canonical shared memory for the configured scope;
local or project-local storage is machine/check-out local context unless the
user says otherwise.

Interpret search result types by trust role: `memory` is reviewed durable
state, `checkpoint` is credible recent handoff state that still needs live
verification, and `memory_candidate` is review material.

Use `bootstrap_context.memoryMap` for durable-memory orientation before reading
raw retrieval hits. Expand a cluster with `expand_memory_cluster` only when
atomic memories or provenance are needed. The map covers the requested primary
scope; include shared memory through search results when needed.

Critical session invariant: `bootstrap_context` does not create a session. In
Codex/Claude auto-ingest flows, use the adapter session id such as
`codex:<id>` or `claude_code:<id>` for `session_status`,
`distill_checkpoint`, and closeout promotion. Use `begin_session` only for a
manual `append_raw` evidence stream. Do not create a fresh `cf_...` session at
closeout to review candidates from an existing Codex/Claude session.

For full ContextForge MCP workflow rules, use the installed
`contextforge-memory` skill.
```

## Remote Canonical Variant

Use this when the repository intentionally shares ContextForge memory across
machines, agents, or deployment hosts.

```text
Use remote ContextForge as the canonical shared memory store for this repo.

Connection mode: external remote client. Storage authority: remote canonical
ContextForge. Agents may be sandboxed and may not be able to inspect the
ContextForge server env files, service manager, or local database.

At task start, after context compaction, or when resuming prior work, call
`bootstrap_context` with `scope: "repo"`, the canonical scope key
`github.com/example/repo`, and an explicit `consultReason` such as `startup`,
`resume`, `compaction_recovery`, or `agent_switch`. Include shared scope only
for user-wide policy, deployment, credential-location, or cross-repo
conventions.

For multi-repo products, a workspace profile may define a federation plan for
related repo scopes. In remote mode, workspace profile reads/writes/resolve
calls must go to the remote canonical server and must not fall back to local
state. Use `resolve_workspace` to see included/excluded scopes and routing
reasons before relying on cross-repo context, or pass `workspaceKey` to
`bootstrap_context` to retrieve bounded supplemental member-scope results.
Workspace membership is not auto-discovery: the caller must explicitly supply
the intended `workspaceKey`, normally from repo-local agent instructions or an
adapter/wrapper configuration. A persisted profile is not consulted unless the
key is supplied, there is no process-global default workspace, and calls
without `workspaceKey` remain single-repo.
Workspace bootstrap result provenance should preserve `workspaceKey`,
`memberName`, `role`, and `includedBecause`; checkpoint results from member
repos require live-state verification before action.

For CLI-driven agent lifecycle, use `agentStart` and `agentCloseout` as
agent-neutral convenience wrappers. `agentStart` calls `bootstrapContext` with
the selected adapter id and optional `workspaceKey`. `agentCloseout` requires
`sessionId` or `checkpointId`, preserves adapter-prefixed session ids such as
`codex:<id>` and `claude_code:<id>`, defaults to `dryRun=true`, and must not
review broad scope backlog unless an explicit lower-level closeout command is
used for that purpose.

Read `handoff.latestCheckpoints` before durable memory for recent work status,
recent decisions, open todos, branch/PR/CI flow, and next actions. Treat
`handoff.latestConsolidation` as optional thread/repo period context when
bootstrap would otherwise show only a thin latest checkpoint. Inspect
`memoryLifecycle` for candidate/promotion freshness, pending candidate counts,
and recent candidate/promotion flow. Treat
`memory` as reviewed durable state for stable contracts, policies, and
runbooks; treat `checkpoint` as credible recent handoff state that still needs
live verification; and treat `memory_candidate` as review material.
Use `memoryMap` as the compact durable-memory overview and call
`expand_memory_cluster` only for the cluster whose details are needed.

For loose continuation prompts such as "yesterday", "continue", "previous
work", issue/PR follow-up, or cross-agent handoff, call `bootstrap_context`
first. It includes latest checkpoint handoff independently from semantic search
ranking. Use `sync_resume_context` only when the exact session id is known and
session working state or raw tail is needed. Use checkpoints for prior intent,
recent decisions, and unfinished work, then verify current git/GitHub/CI/runtime
state from live sources.

Inside the same uninterrupted active session, current conversation context is
the source for current intent. Do not use latest handoff as routine
self-confirmation. Use targeted `search` for stable memory lookup by
file/API/error/domain names, and use live source checks for mutable state.

Use the installed `contextforge-memory` skill for session IDs, distillation,
checkpoint consolidation, candidate review, closeout promotion, correction, and
embedding maintenance.

Use `connection.summary` or `connection.accessMode` from `db_info` or
`bootstrap_context` when present. `accessMode` is `direct-local`,
`server-process`, or `remote-client`. Treat local `.contextforge/` state as
relevant only for local/project-local modes.
```

## Local Or Project-Local Variant

Use this when the repository intentionally keeps ContextForge state on the
current machine or checkout.

```text
Use ContextForge as local/project-local scoped memory for this repo.

Treat retrieval as machine-local context, not shared canonical memory, unless
the user explicitly says this store is authoritative. At task start, call
`bootstrap_context` when available, or `db_info` plus `search` when
`bootstrap_context` is unavailable.

Interpret `memory` as reviewed durable state for this local store,
`checkpoint` as recent continuity from this machine/check-out, and
`memory_candidate` as review material.

Before making deployment or cross-machine claims, verify against current code,
runtime, remote memory, or user confirmation.
```

## Placement Rule

Keep repository `AGENTS.md` files short. Put only the local operating contract
and a ContextForge bootstrap pointer there. Tell agents to use the installed
`contextforge-memory` skill for the full workflow. Use
`docs/agents-md-guide.md` when deciding whether a rule belongs in `AGENTS.md`.
