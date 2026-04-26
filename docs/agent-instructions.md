# ContextForge Agent Instructions

Use this document as guidance for agents that have the ContextForge MCP server
registered. It can be copied into an `AGENTS.md`, a project-specific agent
instruction file, or an MCP client system prompt.

## Short Template

```text
Use ContextForge as a scoped memory sidecar.

At the start of a project task, run a small ContextForge bootstrap. Resolve the
repo scope with repoPath, cwd, or an explicit scopeKey, then search durable
memory for the current repo and, when useful, shared scope. Prefer canonical
GitHub scope keys such as github.com/owner/repo.

Treat durable memories as reviewed facts, decisions, preferences, and runbook
notes. Do not treat checkpoints or raw evidence as canonical truth.

Use search first. Use get_memory only when you know the exact key. Use local
scope only when the memory is machine-specific or explicitly requested.

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

At task start, run a small bootstrap: search repo memory for this task, and
search shared memory only when cross-repo/user-wide policy may matter. Use
scopeKey github.com/example/repo unless the user says otherwise.

Keep durable memory intentional. After distilling a checkpoint, review
list_memory_candidates and promote only stable, reviewed facts.

For full ContextForge MCP usage rules, follow docs/agent-instructions.md from
the ContextForge repo or the equivalent shared memory guide.
```

If an agent environment supports external instruction references, prefer a link
to this file over copying it. If it does not, copy only the short snippet above
and rely on MCP `search` for detailed, scoped guidance.

## Startup Bootstrap

At the beginning of a non-trivial project task, do a small bootstrap instead of
loading a large memory dump.

1. Resolve the intended scope. Use `scope: "repo"` with `repoPath`, `cwd`, or an
   explicit `scopeKey`.
2. Search repo durable memory with a query derived from the user's task.
3. Search shared durable memory only if user-wide conventions, deployment
   policy, credentials locations, or cross-repo decisions may matter.
4. If resuming a known session, call `session_status` for that `sessionId` to
   inspect recent checkpoint state.
5. If the task depends on recent handoff state, call `list_memory_candidates`
   for the relevant session or checkpoint and review candidates before
   promoting anything.

Keep bootstrap small. Prefer one or two targeted `search` calls over loading all
memory. Do not load raw evidence during bootstrap unless the user asks for
forensics or provenance.

Example bootstrap sequence:

```json
{ "tool": "search", "args": { "scope": "repo", "repoPath": "/path/to/repo", "query": "user task keywords", "limit": 5 } }
{ "tool": "search", "args": { "scope": "shared", "query": "relevant shared policy keywords", "limit": 3 } }
```

## Retrieval Order

For most coding tasks, use this order:

1. `search` repo scope for the active project.
2. `search` shared scope if the task may depend on user-wide or organization
   conventions.
3. `get_memory` only for exact durable keys returned by search or supplied by
   the user.
4. Use checkpoint candidates only as review material, not as canonical memory.
5. Avoid raw evidence unless debugging distillation, reconstructing provenance,
   or explicitly asked.

When the agent process starts outside the target checkout, pass `repoPath` or
`cwd` on scoped calls. For cross-machine continuity, prefer an explicit
`scopeKey`, for example `github.com/example/service`.

## Writing Memory

Use `remember` only for durable facts that should survive the session, such as:

- repo-specific architecture decisions
- validated runbook steps
- user preferences that affect future work
- operational constraints or failure modes
- decisions from merged PRs or resolved incidents

Do not use durable memory for:

- temporary status like "tests are running"
- speculative guesses
- unresolved CI output unless the uncertainty is itself important
- raw logs or large transcripts
- secrets, tokens, private customer data, or personal data

Use `correct_memory` when a durable memory is still conceptually the same key
but its content changed. Use `deactivate_memory` when a durable memory should no
longer appear in retrieval, while preserving provenance.

## Checkpoints And Candidates

Checkpoints are recent continuity. They are useful for handoff, but they are
not canonical truth.

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

If a candidate key looks wrong, too broad, or belongs to the wrong repo, do not
promote it as-is. Use `remember` with a corrected key/content or leave it as a
checkpoint candidate.

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

- `search`: retrieve reviewed durable memories.
- `get_memory`: load one known durable memory by key.
- `remember`: write a reviewed durable memory.
- `correct_memory`: update a durable memory while preserving provenance.
- `deactivate_memory`: remove a durable memory from retrieval without deleting
  history.
- `append_raw`: capture scoped evidence for distillation and debugging.
- `session_status`: inspect raw/checkpoint thresholds before distilling.
- `distill_checkpoint`: create a recent-continuity checkpoint.
- `list_memory_candidates`: inspect checkpoint-generated durable-memory
  candidates.
- `promote_memory_candidate`: promote a reviewed candidate by checkpoint and
  index.
- `promote_memory`: promote a reviewed fact with explicit provenance.
- `list_memory_events`: inspect memory provenance.
- `prune_raw_events`: manually prune raw evidence older than the configured TTL.
