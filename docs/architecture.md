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
- default path: `.contextforge/`
- default storage mode
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

The remote boundary is intentionally narrow:

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

## Module And Operation Contracts

`src/operations/registry.js` is the canonical contract for every remotely
exposed application operation. Each entry fixes the public method name,
authorization capability, scope mode, remote dispatch mode, optional MCP tool
name, and MCP read-only semantics. The remote client, HTTP server authorization,
and MCP dispatch surface derive from this registry. Adding an operation without
a capability or adding duplicate capability/MCP mappings fails at module load;
contract tests also compare the generated surfaces.

Transport-specific schema and descriptions stay in `src/mcp.js`, but tool
handlers dispatch through the registry instead of repeating application method
names. CLI-specific argument parsing remains in `src/cli.js`. This keeps
transport presentation separate from application operation identity without a
large rewrite.

Reusable application plumbing begins under `src/application/`; bounded list
pagination and LLM usage accounting live there rather than inside the core
facade. `src/application/llm_usage.js` owns provider usage extraction, usage
event recording, and distill/rollup usage summaries; the core facade imports the
five entry points it actually calls and keeps none of the intermediate helpers.

Decomposition of the facade continued by operation cluster, not by line count.
Workspace profile/member/routing CRUD lives in `src/workspaces/methods.js`, the
memory-map and cluster builders in `src/memory/memory_map.js`, the embedding
queue helpers and operations in `src/embeddings/jobs.js` and
`src/embeddings/methods.js`, the consolidation window/plan/operations in
`src/memory/consolidation.js`, and `distillCheckpoint` in
`src/distill/methods.js`. Clusters that capture nothing from the
`createContextForge` closure move to plain module scope; the rest keep their
closure dependencies and receive them through a `*Methods()` factory whose
result is spread into the app object, so `src/mcp.js` can keep dispatching every
operation by name off that object. Leaf helpers with no ContextForge
imports belong in `src/common.js`; per-layer shared leaves live in
`src/storage/common.js`, `src/ingest/common.js`, and
`src/memory/candidate_lifecycle_common.js`. Helper variants whose bodies are not
identical are deliberately left duplicated rather than merged, because
`errorSummary` and `contentHash` differences change stored payloads and hashes.

Core facade size is enforced as a ratchet rather than a ceiling.
`scripts/line-budgets.json` records the current line count of each large file,
and `scripts/lint-source.js` fails both when a file exceeds its budget and when
a file drops far enough below it that the budget should be tightened. A file
that is not registered may not grow past 1,500 lines without an explicit budget
entry. This makes decomposition the cheap path and budget inflation the visible
one.

SQLite compatibility migrations begin under `src/storage/migrations/` as
ordered, versioned manifests. The v19 manifest preserves the existing
idempotent additive-column behavior; `v20-memory-candidate-lifecycle` and
`v21-operation-worker-freshness` follow it, and `SCHEMA_VERSION` is 21. New
schema work should add a new ordered manifest together with a
`SCHEMA_VERSION` bump, migration backup coverage, and downgrade fail-fast tests.

Tests are organized by topic, one file per subject area, with shared helpers in
`test/helpers/`. Domain contract tests live under `test/contracts/`, offline
quality evals under `test/eval/`, and opt-in provider smoke tests under
`test/live/`. There is no monolithic suite file. `scripts/run-tests.js`
enumerates the real `*.test.js` paths depth-first in sorted order rather than
handing the runner a glob, which keeps the per-file duration artifacts
comparable between runs and keeps helper modules from being reported as empty
test files.

`npm run lint` syntax-checks project JavaScript, rejects tabs/trailing
whitespace, and enforces the ratchet budgets described above: a budgeted file
may not grow, a budget may not be left loose after a file shrinks, and an
unbudgeted file may not pass 1,500 lines. `npm run lint:eslint` adds the checks
a hand-rolled linter cannot do — `no-undef`, `no-unused-vars`, `no-shadow` —
against `eslint.config.mjs`. It is a CI-only gate: the package keeps zero
devDependencies, so the script fetches a pinned `eslint` through `npx` instead
of adding one, and the config lists Node and browser globals by hand for the
same reason. `require-await` is intentionally off, because the codebase keeps
`async` on functions whose signature is part of an awaited API surface, and
`no-shadow` allows `options`, which `createContextForge(options = {})` shadows
by design. CI runs both source gates in the same job; `npm run verify` runs the
hand-rolled one before the complete test suite.

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

Repo scope keys should be stable without being surprising. Explicit `scopeKey`
arguments and `CONTEXTFORGE_DEFAULT_SCOPE_KEY` always win. Otherwise, repo scope
defaults to the current git checkout: common GitHub origin remotes normalize to
`github.com/owner/repo`, and directories without a usable git remote fall back
to a deterministic `path:<hash>:<name>` key.

## Workspace Profiles

Workspace profiles are retrieval topology, not storage authority.

```text
Storage modes answer where memory is authoritative.
Workspace profiles answer which existing scopes are consulted together.
They are independent.
```

The MVP keeps the existing `shared`, `repo`, and `local` scope types. It does
not add `scopeType=workspace` and it does not add `storageMode=workspace`.
Instead, a workspace profile stores:

- a `workspaceKey`
- an optional canonical scope, usually a suite or contract repo
- member scopes, usually repo scope keys
- routing rules that select members for a query

This lets a backend repo task consult a suite contract repo or frontend
consumer repo when the query contains contract signals such as `OpenAPI`,
`permission`, `E2E`, `frontend`, or `release`.

`repoPath` is not part of the canonical workspace profile. It is a machine-local
hint used to infer a repo `scopeKey` before a request is made. Workspace
profiles store scope identity, not local filesystem identity.

In remote mode, workspace profile reads, writes, and resolution go through the
remote canonical server. There is no local/project-local fallback for workspace
profile state. A single-repo user can ignore workspace profiles entirely; the
default retrieval behavior remains one explicit primary scope unless a caller
opts into workspace resolution.

Resolver output must stay explainable. A scope plan should include the primary
member, included and excluded scopes, `includedBecause`, matched rules or
matched terms, and warnings such as `primary_scope_not_workspace_member` or
`canonical_scope_not_member`.

`bootstrap_context` can opt into workspace federation with `workspaceKey`.
Workspace bootstrap keeps ordinary top-level `results` focused on the primary
scope and returns supplemental cross-repo retrieval in a separate `workspace`
block. `workspace.results` defaults to supplemental member scopes only; callers
can opt into duplicating the primary scope with
`includePrimaryInWorkspaceResults=true`.

Workspace retrieval is bounded and explainable. The default total limit is
`workspaceResultLimit=8`; the default per-member limit is
`workspacePerScopeLimit=4`. Result provenance includes `workspaceKey`,
`memberName`, `role`, and `includedBecause`. Checkpoint and memory-candidate
results remain lower-trust material and carry verification or review hints.
Workspace ranking keeps result type as the first tier, so durable memory is not
overtaken by checkpoint handoff state when handoffs are explicitly included.
Top-level `includeShared` belongs to the primary bootstrap view; workspace
shared retrieval is enabled by workspace routing rules with `includeShared`.

Standalone `search` can also opt into workspace federation with `workspaceKey`
for active-session targeted lookup. It preserves the existing array response
when `workspaceKey` is absent. When `workspaceKey` is present, it returns a
`workspace_search` envelope with primary-scope `results` and a separate bounded
`workspace` block. Search workspace federation uses the same scope plan,
per-scope limits, provenance, shared opt-in, and raw-evidence-free retrieval
policy as bootstrap.

`include_by_default` is a scope-plan convenience, not permission to retrieve an
unbounded amount of memory. Use it sparingly, usually for the canonical suite or
contract repo, and keep workspace retrieval bounded by per-scope and total
limits. Deactivating a workspace profile is a soft delete that marks the
profile inactive; upserting the same `workspaceKey` later reactivates the
existing profile.

## Agent Lifecycle Helpers

Agent lifecycle helpers are convenience wrappers over existing core operations,
not a separate adapter-specific workflow. `agentStart` delegates to
`bootstrapContext` and can include workspace federation. `agentCloseout`
requires an exact `sessionId` or `checkpointId`, preserves adapter-prefixed
session ids, optionally distills, runs closeout-scoped candidate audit and
promotion suggestions, and defaults to `dryRun=true`. It must not use broad
scope backlog fallback by default.

## Retrieval Quality

Durable memory remains canonical in the `memories` table. SQLite FTS5 is a
retrieval index over that table, not a second source of truth. The index is
rebuilt during startup migration and updated when durable memories are
remembered, corrected, promoted, or deactivated.

Search results should stay explainable. Each result includes lexical `why`
metadata describing matched query tokens, fields, and match types, plus
retrieval metadata such as the FTS rank and method. This keeps better ranking
debuggable and leaves room for future vector search as another retrieval
surface, not canonical storage.

Workspace retrieval evals use synthetic fixtures and, in the CLI path, an
isolated temporary local store even when the caller normally uses project-local
or remote mode. They seed workspace profiles, members, routing rules, and
durable memories, then run `bootstrapContext` queries and check expected terms
and scope roles in the top primary/workspace result windows. Evals must not
depend on private repositories, network access, raw transcripts, or the caller's
configured live storage mode. Library callers may still inject an app for
specialized harnesses, but should avoid writing synthetic fixtures to a live
canonical store.

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
- optional `structured` handoff state with
  `schemaVersion: "contextforge.structured_checkpoint.v1"`
- `memoryCandidates`
- `sourceEventCount`
- `provider`
- metadata sufficient to debug the run

Memory candidates must not automatically become durable memories unless the
caller explicitly chooses that policy.

Provider prompts and output schemas should be versioned. Distill run input
metadata records the provider prompt/schema version before execution, and
successful or failed output metadata keeps the same version context for later
debugging. A provider prompt change that can affect checkpoint shape or meaning
should bump the provider prompt version.

## Promotion Policy

Checkpoint memory candidates are review inputs, not canonical facts. A caller
can list candidates from checkpoint metadata and then promote a reviewed item
into durable memory. Promotion records source checkpoint, session, raw event, and
candidate metadata when supplied. Candidate v2 metadata may include type,
confidence, stability, sensitivity, recommendation, and source event ids for
review ordering; these fields do not trigger automatic promotion. Promotion
should warn or require explicit override when an active durable memory already
uses the same key, the same content exists under another key, or the candidate
signals high sensitivity, low stability/confidence, or a non-promote
recommendation.

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
2. latest ContextForge checkpoints from `handoff.latestCheckpoints` for recent
   work status, prior intent, recent decisions, open todos, branch/PR/CI flow,
   and next actions
3. ContextForge durable memory from `repo + shared` for stable contracts,
   policies, decisions, and runbooks
4. raw conversation evidence only when explicit
5. built-in agent memory and markdown fallback as supporting context

Avoid:

- auto-loading all checkpoints
- relying on query ranking alone to surface the latest checkpoint
- auto-loading raw events
- dumping giant memory files into prompt context
- treating vector results as unexplainable truth

ContextForge raw events are a distillation-ready conversation evidence stream,
not a canonical clone of native agent transcripts. Store user/assistant
dialogue for checkpointing; leave tool-call/tool-result payloads, long logs,
DB dumps, and shell output in the native transcript or an explicit artifact.

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
