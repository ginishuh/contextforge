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

At task start, call `bootstrap_context` with this task, `scope: "repo"`, and
this repo path or the canonical scope key `github.com/example/repo`. Include
shared memory only when cross-repo or user-wide policy may matter.

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
```

## Remote Canonical Variant

Use this when the repository intentionally shares ContextForge memory across
machines, agents, or deployment hosts.

```text
Use remote ContextForge as the canonical shared memory store for this repo.

Connection mode: external remote client. Storage authority: remote canonical
ContextForge. Agents may be sandboxed and may not be able to inspect the
ContextForge server env files, service manager, or local database.

At task start, call `bootstrap_context` with `scope: "repo"` and the canonical
scope key `github.com/example/repo`. Include shared scope only for user-wide
policy, deployment, credential-location, or cross-repo conventions.

Read `handoff.latestCheckpoints` before durable memory for recent work status,
recent decisions, open todos, branch/PR/CI flow, and next actions. Treat
`memory` as reviewed durable state for stable contracts, policies, and
runbooks; treat `checkpoint` as credible recent handoff state that still needs
live verification; and treat `memory_candidate` as review material.

For loose continuation prompts such as "yesterday", "continue", "previous
work", issue/PR follow-up, or cross-agent handoff, call `bootstrap_context`
first. It includes latest checkpoint handoff independently from semantic search
ranking. Use `sync_resume_context` only when the exact session id is known and
session working state or raw tail is needed. Use checkpoints for prior intent,
recent decisions, and unfinished work, then verify current git/GitHub/CI/runtime
state from live sources.

Use the installed `contextforge-memory` skill for session IDs, distillation,
candidate review, closeout promotion, correction, and embedding maintenance.

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
