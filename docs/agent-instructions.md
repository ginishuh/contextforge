# ContextForge Agent Instructions

Use this document as guidance for agents that have the ContextForge MCP server
registered. It can be copied into an `AGENTS.md`, a project-specific agent
instruction file, or an MCP client system prompt.

## Short Template

```text
Use ContextForge as a scoped memory sidecar.

At the start of a project task, call bootstrap_context when available. Pass
repoPath, cwd, or an explicit scopeKey so ContextForge can resolve the repo
scope, then use the returned trust and verification hints. Prefer canonical
GitHub scope keys such as github.com/owner/repo.

Use semantic repo retrieval early for loose continuation requests such as
"yesterday", "continue", "previous work", issue/PR follow-up, or cross-agent
handoff. Search results may include durable memories, recent checkpoints, and
memory candidates; use all three as context candidates.

When resuming a known session, pass `sessionId` to bootstrap_context. Use the
returned `workingSummary` as latest rolling handoff state, and keep it separate
from reviewed durable memory and checkpoint retrieval results.

Before relying on results, identify whether ContextForge is using remote
canonical storage or local/project-local storage. Remote results are shared
ContextForge state for the configured scope. Local/project-local results are
machine-local context unless the user says that store is authoritative.

Interpret search result types carefully:
- `memory`: reviewed durable fact, decision, preference, or runbook note.
- `checkpoint`: recent session continuity, not canonical truth.
- `memory_candidate`: unreviewed promotion candidate, useful for review.

Use bootstrap_context first, then targeted search if more detail is needed. Use
get_memory only when you know the exact key. Use local scope only when the
memory is machine-specific or explicitly requested.

Treat retrieved context as a lead, not live truth. Re-check current branch,
issue/PR state, CI, migrations, and runtime status with git, GitHub, tests, or
the live system before acting on time-sensitive claims.

Capture important raw evidence with append_raw during long work. Distill raw
evidence into checkpoints when a task reaches a meaningful boundary, when the
session_status thresholds recommend it, or before handing off work.

After distill_checkpoint, inspect list_memory_candidates. Promote candidates
only when they are reviewed, clearly durable, and useful beyond the current
checkpoint. Use promote_memory_candidate for a reviewed candidate, remember for
new reviewed durable facts, correct_memory for changed facts, and
deactivate_memory for stale facts.

Do not automatically promote every candidate. Keep durable memory small,
actionable, and scoped.
```

## Keeping AGENTS.md Small

Do not paste this whole document into every repository's `AGENTS.md`. Keep the
project instruction file short and use ContextForge plus a linked guide for the
details.

A good `AGENTS.md` should contain only:

- the repository's own build/test/release rules
- the canonical ContextForge `scopeKey`, if it cannot be inferred reliably
- a short ContextForge bootstrap instruction
- a link or reference to the longer ContextForge agent guide

Recommended minimal `AGENTS.md` snippet:

```text
Use ContextForge MCP for scoped project memory.

At task start, call bootstrap_context for this task. Include shared memory only
when cross-repo/user-wide policy may matter. Use scopeKey
github.com/example/repo unless the user says otherwise.

Check whether ContextForge is remote canonical storage or local/project-local
storage before treating retrieval results as shared state.

Interpret search result types by trust level: memory is reviewed durable state,
checkpoint is recent continuity, and memory_candidate is review material.

For loose continuation prompts like "yesterday", "continue", "previous work",
issue/PR follow-up, or cross-agent handoff, search ContextForge before guessing
from the current checkout. Review `checkpoint` and `memory_candidate` hits as
context candidates, then verify current state in git/GitHub/runtime.

Keep durable memory intentional. After distilling a checkpoint, review
list_memory_candidates and promote only stable, reviewed facts. Promote durable
lessons, not whole worklogs.

For full ContextForge MCP usage rules, follow docs/agent-instructions.md from
the ContextForge repo or the equivalent shared memory guide.
```

If an agent environment supports external instruction references, prefer a link
to this file over copying it. If it does not, copy only the short snippet above
and rely on MCP `search` for detailed, scoped guidance.

## AGENTS.md Examples

Use a remote-canonical snippet when the repo should share memory across
machines, agents, or deployment hosts:

```text
Use ContextForge MCP for scoped project memory.

This repo uses remote ContextForge as the canonical shared memory store. At
task start, call bootstrap_context for this task. Use scopeKey
github.com/example/repo unless the user says otherwise. Include shared scope
only for user-wide policy, deployment, credential-location, or cross-repo
conventions.

Interpret search result types by trust level:
- memory: reviewed durable fact or decision.
- checkpoint: recent session continuity; verify important claims before acting.
- memory_candidate: unreviewed promotion candidate and review material.

For loose continuation prompts such as "yesterday", "continue", "previous
work", issue/PR follow-up, or cross-agent handoff, search repo scope before
guessing from the checkout. Use semantic hits from memory, checkpoint, and
memory_candidate together as context candidates, then verify current branch,
issue/PR state, CI, migrations, and runtime status with live sources.

When distilling, treat checkpoints as compressed retrieval indexes. Preserve
concrete names, numbers, intervals, APIs, paths, commands, errors, decisions,
rationale, risks, conditions, next actions, and retrieval hooks. After
distill_checkpoint, review list_memory_candidates and promote only stable,
reviewed facts.

Do not store secrets in memory. In remote mode, provider credentials such as
OpenAI embedding keys belong on the ContextForge server, not in this repo.
```

Use a local or project-local snippet when the repo intentionally keeps memory
inside the current machine or checkout:

```text
Use ContextForge MCP for scoped local project memory.

This repo uses local/project-local ContextForge storage. Treat retrieval as
machine-local context, not shared canonical memory, unless the user explicitly
says this store is authoritative. At task start, call bootstrap_context when
available, or db_info plus search when bootstrap_context is unavailable. Use
local scope only for machine-specific notes.

Interpret search result types by trust level:
- memory: reviewed durable fact for this local store.
- checkpoint: recent continuity from this machine/check-out.
- memory_candidate: unreviewed promotion candidate and review material.

Before making deployment or cross-machine claims, verify against current code,
runtime, remote memory, or user confirmation. Keep durable memory intentional:
promote only stable, scoped, non-secret facts.
```

## Startup Bootstrap

At the beginning of a non-trivial project task, do a small bootstrap instead of
loading a large memory dump. Prefer the single `bootstrap_context` tool when it
is available; it resolves scope, summarizes storage/vector readiness, searches
repo semantic memory, optionally searches shared memory, and annotates result
trust levels.

1. Resolve the intended scope. Use `scope: "repo"` with `repoPath`, `cwd`, or an
   explicit `scopeKey`.
2. Call `bootstrap_context` with a query derived from the user's task.
3. Include shared scope only if user-wide conventions, deployment
   policy, credentials locations, or cross-repo decisions may matter. Shared
   bootstrap results are capped at three items.
4. If `bootstrap_context` is unavailable, call `db_info` when storage mode,
   remote/local authority, schema version, raw retention, or vector readiness
   may affect the task, then call `search`.
5. If resuming a known session, call `session_status` for that `sessionId` to
   inspect recent checkpoint state.
6. If the task needs live handoff state, pass `sessionId` to
   `bootstrap_context` or call `get_working_summary`. Treat the returned
   working summary as current session state, not durable truth.
7. If the task depends on recent handoff state, call `list_memory_candidates`
   for the relevant session or checkpoint and review candidates before
   promoting anything.

Keep bootstrap small. Prefer one or two targeted `search` calls over loading all
memory. Do not load raw evidence during bootstrap unless the user asks for
forensics or provenance.

For vague continuation language such as "yesterday", "continue", "previous
work", "pick this back up", issue/PR follow-up, or cross-agent handoff, treat
ContextForge as the first recall step. Use semantic search over the repo scope
before inferring from visible files alone. Include the issue number, PR number,
branch name, feature name, failing command, or date phrase in the query when the
user gives one.

Example bootstrap sequence:

```json
{ "tool": "bootstrap_context", "args": { "scope": "repo", "repoPath": "/path/to/repo", "query": "user task keywords", "includeShared": false, "limit": 8 } }
```

Example continuation query:

```json
{ "tool": "bootstrap_context", "args": { "scope": "repo", "scopeKey": "github.com/example/service", "query": "yesterday issue 123 migration follow-up previous work", "limit": 8 } }
```

Equivalent CLI:

```bash
node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/service \
  --query "yesterday issue 123 migration follow-up previous work" \
  --limit 8
```

## Retrieval Order

For most coding tasks, use this order:

1. `db_info` when you need to know whether the server is remote canonical
   storage or local/project-local storage.
2. `bootstrap_context` repo scope for the active project when available.
3. `search` repo scope if you need additional targeted retrieval after
   bootstrap.
4. `search` shared scope if the task may depend on user-wide or organization
   conventions.
5. `get_memory` only for exact durable keys returned by search or supplied by
   the user.
6. Use checkpoints for recent continuity, not canonical truth.
7. Use memory candidates only as review material, not as canonical memory.
8. Avoid raw evidence unless debugging distillation, reconstructing provenance,
   or explicitly asked.

When the agent process starts outside the target checkout, pass `repoPath` or
`cwd` on scoped calls. For cross-machine continuity, prefer an explicit
`scopeKey`, for example `github.com/example/service`.

## Storage Authority

ContextForge can run in `local`, `project-local`, or `remote` storage mode.
Agents should not treat these modes as equivalent.

- `remote`: server-backed canonical memory for multiple machines or agents.
  Treat retrieved `memory` results as shared reviewed state for the configured
  scope. OpenAI embedding keys and canonical SQLite storage should live on the
  server side.
- `local`: single-machine storage. Treat results as useful local context, not
  shared deployment memory, unless the user confirms this host is the intended
  authority.
- `project-local`: repo-bound storage in a gitignored directory. Treat results
  as checkout-local context. Do not assume other machines or agents can see it.

Use `db_info` to inspect the active backend and sqlite-vec readiness. If a
client is configured for remote mode, clients normally need the remote bearer
token only; embedding provider credentials belong to the remote server process.

## Search Result Types

`search` can return multiple result types. The type is part of the trust model.

- `memory`: reviewed durable memory. These are the best retrieval results for
  decisions, preferences, and reusable runbook facts.
- `checkpoint`: LLM-distilled recent continuity from one session. Use it to
  resume work and understand recent context, then verify important claims
  against current code, status, or durable memory.
- `memory_candidate`: a checkpoint-generated candidate that might deserve
  promotion. Use it as review material. Do not treat it as final truth until it
  is promoted or rewritten as durable memory.

Vector-backed checkpoint and candidate hits are useful for "what happened last
time?" queries. They are intentionally not a replacement for durable memory.

Vector matches are context candidates, not live truth. Always verify
time-sensitive or externally mutable state against the current source of truth:

- current branch, staged changes, and commits: git
- issue, PR, review, and CI state: GitHub or the relevant forge
- runtime health, migrations, queues, and deployed version: the live system
- generated artifacts or local files: the filesystem and current tests

This separation is the core safety rule: use ContextForge to remember what may
matter, then use live tools to decide what is true now.

## Writing Memory

Use `remember` only for durable facts that should survive the session, such as:

- repo-specific architecture decisions
- validated runbook steps
- user preferences that affect future work
- operational constraints or failure modes
- decisions from merged PRs or resolved incidents
- long-lived API contracts, permission rules, or domain boundaries
- final issue/PR conclusions that affect future implementation
- cross-agent lessons that change how future work should be approached

Do not use durable memory for:

- temporary status like "tests are running"
- speculative guesses
- unresolved CI output unless the uncertainty is itself important
- raw logs or large transcripts
- secrets, tokens, private customer data, or personal data
- current branch location, draft status, or one-time command output
- raw commit logs or facts that git/GitHub/runtime can answer more safely

Use `correct_memory` when a durable memory is still conceptually the same key
but its content changed. Use `deactivate_memory` when a durable memory should no
longer appear in retrieval, while preserving provenance.

Write promoted memories as durable lessons, not worklogs. A good durable memory
is short enough to scan, includes the decision and rationale when relevant, and
keeps retrieval hooks such as API names, issue numbers, commands, paths, or
domain terms. If the important part is "what happened today", leave it in a
checkpoint; if the important part is "how future agents should decide", promote
it.

## Checkpoints And Candidates

Checkpoints are recent continuity. They are useful for handoff, but they are
not canonical truth.

Good checkpoints are compressed retrieval indexes, not generic summaries. They
should preserve the names, numbers, intervals, commands, paths, APIs, error
strings, issue numbers, and domain terms that a future agent is likely to
search for. A useful checkpoint keeps decision, rationale, risks, conditions,
and next action together when the raw evidence supports them.

Distillation providers should populate `metadata.retrievalHooks` with concise
future-search keywords. Those hooks are embedded with the checkpoint so later
queries can find the right session even when the exact summary wording differs.

After `distill_checkpoint`, call `list_memory_candidates` for the same
`sessionId` or `checkpointId` when:

- a long implementation thread ends
- a PR or issue reaches a stable decision
- the user asks what should be remembered
- the agent is preparing a handoff
- repeated future work would benefit from a durable note

The MCP result makes candidate discovery explicit. If `distill_checkpoint`
returns `memoryCandidateCount > 0`, call `list_memory_candidates` before ending
the task or deciding what to promote. If `session_status` reports
`latestCheckpointMemoryCandidateCount > 0`, use the latest checkpoint id or the
session id to review those candidates.

Promote with `promote_memory_candidate` only after review. A good candidate is:

- stable beyond the current checkpoint
- specific enough to retrieve later
- scoped to the right repo/shared/local boundary
- free of secrets and private runtime data
- not duplicated by an existing durable memory

At the end of a substantial task, review the candidate queue and usually select
only one to three items for promotion. It is normal for many `memory_candidate`
records to accumulate; treat them as a review queue, not as a backlog that must
be emptied.

Candidate records may include review signals such as `candidateType`,
`confidence`, `stability`, `sensitivity`, `promotionRecommendation`, and
`sourceEventIds`. Use those fields to prioritize review. Treat `ignore`,
`reject`, low-confidence, low-stability, and high-sensitivity candidates as
reasons to skip or reject unless the user explicitly asks to keep them.

If a candidate key looks wrong, too broad, or belongs to the wrong repo, do not
promote it as-is. Use `remember` with a corrected key/content or leave it as a
checkpoint candidate.

Example candidate review:

```json
{ "tool": "list_memory_candidates", "args": { "scope": "repo", "scopeKey": "github.com/example/service", "sessionId": "session-123", "limit": 10, "promotionRecommendation": "promote" } }
```

Example promotion after review:

```json
{ "tool": "promote_memory_candidate", "args": { "candidateId": "candidate-uuid", "reason": "Stable API contract that future agents need for issue follow-up." } }
```

Example corrected durable write instead of promoting a noisy candidate:

```json
{ "tool": "remember", "args": { "scope": "repo", "scopeKey": "github.com/example/service", "key": "api-contract-widget-delete", "category": "decision", "content": "Widget delete endpoints must remain idempotent: missing widgets return 204 so retrying cleanup jobs is safe.", "tags": ["api-contract", "delete", "idempotency"], "importance": 4 } }
```

## Raw Evidence And Retention

Raw evidence exists for auditability and future distillation. It should be
small enough to keep useful and scoped enough to avoid accidental leakage.

Agents should append raw evidence for meaningful work, not every trivial status
line. Prefer concise evidence that explains:

- what changed
- what command or check proved it
- what decision was made
- what remains unresolved

Raw retention is controlled by the server or local runtime, for example
`CONTEXTFORGE_RAW_TTL_DAYS=30`. Agents should not assume raw evidence is
permanent. Durable memory and checkpoints are the long-lived layers.

## Cost Discipline

Distillation uses an LLM provider. Avoid distilling after every small event.
Use `session_status` to check thresholds before calling `distill_checkpoint`
unless a handoff or explicit user request makes a checkpoint necessary.

Prefer distilling at meaningful boundaries:

- after a feature is implemented and tested
- after a PR is opened, merged, or abandoned
- after an incident is diagnosed or resolved
- before switching agents or machines
- before ending a long session

## Tool Summary

- `db_info`: inspect storage mode, table counts, raw retention, schema version,
  and sqlite-vec/embedding readiness.
- `bootstrap_context`: resolve scoped startup context in one call. It searches
  repo memory/checkpoints/candidates semantically, optionally includes up to
  three shared-scope results, and annotates trust plus verification hints.
- `search`: retrieve scoped results. Results can include reviewed durable
  `memory`, recent-continuity `checkpoint`, and unreviewed
  `memory_candidate` records.
- `get_memory`: load one known durable memory by key.
- `remember`: write a reviewed durable memory.
- `correct_memory`: update a durable memory while preserving provenance.
- `deactivate_memory`: remove a durable memory from retrieval without deleting
  history.
- `append_raw`: capture scoped evidence for distillation and debugging.
- `session_status`: inspect raw/checkpoint thresholds before distilling.
- `distill_checkpoint`: create a recent-continuity checkpoint.
- `distill_usage`: summarize distillation run counts, selected input size,
  estimated input tokens, elapsed time, and actual provider usage when recorded.
- `list_memory_candidates`: inspect checkpoint-generated durable-memory
  candidates.
- `promote_memory_candidate`: promote a reviewed candidate by candidate id.
- `reject_memory_candidate`: reject a reviewed candidate that should not become
  durable memory.
- `promote_memory`: promote a reviewed fact with explicit provenance.
- `list_memory_events`: inspect memory provenance.
- `prune_raw_events`: manually prune raw evidence older than the configured TTL.
- `rebuild_embeddings`: backfill or rebuild the derived vector index for
  durable memories, checkpoints, and memory candidates. If embedding dimensions
  changed, pass `force=true` only when the operator intentionally wants to reset
  the derived sqlite-vec index.
