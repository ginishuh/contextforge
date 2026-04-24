# ContextForge Architecture

ContextForge is a self-hosted memory and distillation runtime for coding agents.
It turns raw agent interaction history into scoped, searchable, durable context.

It is not a note-taking app, a SaaS memory product, or a vector database wrapper.
It is a sidecar runtime that complements existing agent memory with canonical
project/repo memory, evidence retention, and LLM-backed distillation.

## Relationship to Agent Memory

Coding agents such as Codex, Claude Code, Cursor, and other MCP-compatible tools
may already have built-in memory or session persistence. ContextForge should not
fight those systems.

The intended relationship is:

- built-in agent memory remains useful for local behavior and broad user
  preferences
- ContextForge owns canonical `repo` and `shared` memory
- ContextForge is queried on demand instead of being dumped into every prompt
- ContextForge does not require disabling a coding agent's own memory

The safe rule is:

```text
Do not replace built-in memory. Add a scoped, searchable project memory sidecar.
```

## Storage Modes

ContextForge supports three storage modes.

ContextForge starts project-local for zero-friction setup, but remote mode is a
first-class canonical deployment model. Local mode is a single-machine
home-directory store; project-local mode keeps a repo-bound store near one
checkout; remote mode is the power-user path for multi-machine and multi-agent
workflows.

### Local

Single-machine home-directory mode.

- SQLite on the local machine
- no server required
- simple install
- best for one developer on one machine
- configured with `CONTEXTFORGE_STORAGE_MODE=local`
- default path: `~/.contextforge/contextforge.db`

### Project-Local

Repo-bound storage in a gitignored directory.

- useful when memory should stay near one checkout
- default v0 path: `.contextforge/`
- default v0 storage mode
- live DB files must not be committed

### Remote

First-class server-backed canonical memory for multi-machine and multi-agent
users.

- best for users who work from several machines
- a VPS can become the source of truth
- local clients act as retrieval/write clients
- useful for sharing memory between Codex, Claude Code, Cursor, and custom
  agents
- should be considered an early product path, not a distant enterprise add-on
- configured on clients with `CONTEXTFORGE_STORAGE_MODE=remote`,
  `CONTEXTFORGE_REMOTE_URL`, and optional `CONTEXTFORGE_REMOTE_TOKEN`
- served by `contextforge-server` or `node src/cli.js serve`

Do not use git as the live storage backend for SQLite or raw runtime data. Git
can hold source, docs, migrations, example exports, and reviewed snapshots.

### Remote Client/Server Boundary

The v0 remote boundary is intentionally narrow:

- the client keeps no canonical SQLite database when `storageMode=remote`
- the client sends JSON requests to `/v0/<method>`
- the server executes the same core methods as local mode
- bearer-token auth is optional but recommended for every networked server
- scope type and scope key are part of every read/write request, so remote mode
  does not change `shared`, `repo`, or `local` semantics

Remote distillation currently runs server-side. This keeps raw evidence and
provider run metadata in the canonical store and avoids split-brain checkpoint
writes. Client-side provider execution may be added later for providers that
must use client-local credentials or tools, but such writes still need to go
through the remote canonical API.

There is no automatic offline cache or write fallback in v0. If a remote client
cannot reach the server, the operation should fail visibly. Users may configure
`project-local` or `local` as an explicit fallback profile, but ContextForge
should not silently fork canonical memory.

## Scope Model

Scopes are intentionally explicit.

- `shared`: common user or organization knowledge
- `repo`: project-specific memory
- `local`: machine-specific notes and temporary state

`shared` and `repo` should be queryable together when appropriate. `local`
should not leak into shared or remote scopes by default. Promotion from `local`
or checkpoint content into durable `repo` or `shared` memory should be explicit.

The default shared scope key is `global` unless configured with
`CONTEXTFORGE_SHARED_SCOPE_KEY`. Combined retrieval should include source
metadata for every result so callers can explain whether a memory came from the
current repo, shared durable memory, or an explicitly requested local scope.

## Memory Layers

ContextForge separates memory into layers.

### Durable Memories

Canonical facts, rules, decisions, and preferences. This is the highest-trust
layer.

### Checkpoints

LLM-distilled recent continuity. Checkpoints answer:

- where did we leave off?
- what was recently decided?
- what remains open?
- what should a new agent know to continue?

Checkpoints are important, but they are not canonical truth. They can suggest
durable memories, but should not silently become durable memory.

### Raw Evidence

Append-only source material used for auditability, later distillation, summary
debugging, and context recovery.

Raw evidence should not be loaded by default. It should be opt-in and scoped.

### Daily Summaries

Daily summaries are not part of the essential core. They may become useful later
for reporting or human review, but ContextForge v1 should center on durable
memory, checkpoints, and raw evidence.

## Distillation Policy

Distillation is a core capability.

Useful checkpoints require an LLM because string heuristics cannot reliably
distinguish decisions, temporary chatter, durable facts, and open questions.

Therefore:

- distillation should be explicit and provider-backed
- providers must be pluggable
- distillation failure must not destroy raw evidence
- raw capture and durable memory writes must work even if distillation fails

## Provider Contract

ContextForge should support bring-your-own distillation providers:

- `codex_exec`
- `claude_code_exec`
- direct OpenAI-compatible APIs
- z.ai-compatible APIs
- local model runners such as Ollama or LM Studio

Provider inputs should include:

- scope
- session id
- conversation id
- raw event slice
- optional previous checkpoint
- optional relevant durable memories
- requested output schema

The first real provider is `codex_exec`, which shells out to `codex exec`,
requests structured JSON output, applies timeout and raw-input budget controls,
and then uses the same provider validation path as every other adapter.

Provider outputs should include:

- `summaryShort`
- `summaryText`
- `decisions`
- `todos`
- `openQuestions`
- `memoryCandidates`
- `sourceEventCount`
- `provider`
- metadata sufficient to debug the run

Memory candidates must not automatically become durable memories unless the
caller explicitly chooses that policy.

## Promotion Policy

Checkpoint memory candidates are review inputs, not canonical facts. A caller
can list candidates from checkpoint metadata and then promote a reviewed item
into durable memory. Promotion records source checkpoint, session, raw event, and
candidate metadata when supplied.

Durable memory should be corrected or deactivated rather than deleted. A
correction updates the durable key while preserving previous content in the
memory event history. Deactivation marks a memory inactive so retrieval excludes
it, while exact lookup can still inspect the retained record and provenance.

## Distill Run Metadata

Every distillation attempt should be recorded separately from checkpoints.

Distill run records should capture:

- provider name
- run status: `started`, `succeeded`, or `failed`
- source event count and raw event ids
- previous checkpoint id when present
- requested output schema
- provider metadata on success
- error message and stack on failure

Failed distillation must not delete or mutate raw evidence. A checkpoint should
only be inserted after provider output passes validation.

## Retrieval Policy

Default retrieval should be compact, explainable, scoped, and on demand.

Recommended order:

1. current repository reality
2. ContextForge durable memory from `repo + shared`
3. checkpoints for recent continuity when requested
4. raw evidence only when explicit
5. built-in agent memory and markdown fallback as supporting context

Avoid:

- auto-loading all checkpoints
- auto-loading raw events
- dumping giant memory files into prompt context
- treating vector results as unexplainable truth

The default runtime should minimize prompt bloat by preloading only tiny
bootstrap context, then using `search` and `getMemory` for detail.

Search modes:

- `scope`: search only the explicit scope and scope key
- `repo`: search the repo scope
- `shared`: search shared durable memory
- `repo+shared`: search repo memory and shared durable memory together
- `local`: search local memory only when explicitly requested

When `repo+shared` is used, exact repo memory should rank ahead of equally
relevant shared memory. Shared memory is still returned when relevant, and local
memory is excluded unless requested.

## Adapter Strategy

Build adapters after the core storage and provider boundaries are stable.

Likely adapter layers:

- CLI
- MCP server
- Codex integration examples
- Claude Code integration examples
- remote HTTP API for VPS mode

The first MCP surface should stay small:

- `begin_session`
- `search`
- `get_memory`
- `remember`
- `append_raw`
- `distill_checkpoint`
- `promote_memory`

## Public Repo Safety

ContextForge is public. Never include real user memory, raw private transcripts,
user-specific files, secrets, tokens, live SQLite DB files, or machine-specific
paths as required defaults.

Examples and tests should be synthetic.
