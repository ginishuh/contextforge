# ContextForge Roadmap

This roadmap turns the product architecture into implementation milestones.

## Milestone 0: v0 Local Core

Status: merged in PR #2.

Delivered:

- SQLite storage
- durable memories
- raw events
- checkpoints
- mock distill provider
- JSON CLI
- tests
- public repo hygiene

## Milestone 1: Provider Abstraction Hardening

Tracking issue: #5.

Status: merged in PR #12.

Goals:

- finalize distillation input/output schema
- validate provider outputs
- store distill run metadata
- handle provider failure safely
- add retry/error states where needed

## Milestone 2: Remote Mode

Tracking issue: #8.

Status: implemented. Two goals were restated below to match what was built;
see Remaining for what is genuinely open.

Remote mode is a first-class path for users whose canonical work already lives
on a VPS or server. Local mode remains the zero-friction install.

Goals:

- server-backed canonical memory
- client auth
- one canonical store shared by every machine, with scope keys that resolve to
  the same scope regardless of checkout path
- visible failure when the server is unreachable, rather than an offline cache
  or silent local write
- clear shared/repo/local write policy

The third and fourth goals previously read "multi-machine sync" and "local
fallback behavior". Neither describes the design that shipped. There is no
replication, conflict resolution, or offline cache: every machine reads and
writes the one server directly, and losing it is an error rather than a
degraded mode. Keeping the old wording implied a distributed-sync feature that
was never intended.

Implemented:

- JSON HTTP server exposing the stable core methods (88 operations)
- remote client mode selected by `CONTEXTFORGE_STORAGE_MODE=remote`
- bearer token auth with `CONTEXTFORGE_REMOTE_TOKEN`, plus capability and
  scope-scoped policy tokens via `CONTEXTFORGE_API_TOKENS_JSON`; the server
  re-binds scope from the token rather than trusting the client
- no fallback path at all: a remote client never constructs a local store, and
  local-authority commands such as `backupDatabase` refuse to run
- server-side distillation for canonical checkpoint writes
- git-remote-derived repo scope keys, and local path hints stripped from
  request bodies once the scope is resolved
- health, readiness, authenticated Prometheus metrics, graceful drain,
  request-size limits, admin UI sessions, and Streamable HTTP MCP

Remaining:

- `clear shared/repo/local write policy` is prose, not code.
  `docs/architecture.md` says `local` should not leak into shared or remote
  scopes, while `docs/runtime-modes.md` says the remote server owns reads and
  writes for all three. Nothing enforces either, and a remote client writing
  `scope: 'local'` lands in the server's local scope.
- No regression test covers the server being unreachable. The visible-failure
  guarantee is tested for authorization failures (401) but not for connection
  refusal or client timeout.

## Milestone 3: Shared + Repo Retrieval

Tracking issue: #7.

Status: implemented. The fourth goal is narrower in practice than its wording
suggests; see Remaining.

Goals:

- allow querying `repo` and `shared` together
- keep `local` opt-in
- provide result source metadata
- favor exact repo memory while including useful shared rules

Implemented:

- `searchScopes` option for `scope`, `repo`, `shared`, `repo+shared`, and
  `local`, wired through the CLI, MCP, and remote API
- `sharedScopeKey` option with `CONTEXTFORGE_SHARED_SCOPE_KEY` fallback
- result `source` metadata describing the returned scope and role, carried
  through to bootstrap results
- local memory remains excluded from `repo+shared`, and workspace members
  cannot reach `local` without `allowLocal`

Remaining:

- Repo preference is a tie-breaker, not a ranking policy. `scopeBoost` sorts
  after relevance, so a shared result outranks a repo result whenever their
  scores differ at all, and scoring itself never looks at scope.
  `docs/architecture.md` states this accurately ("ahead of equally relevant
  shared memory"); the goal wording above promises more than that.
- The scope-leakage slice in the quality eval exercises `bootstrapContext`'s
  `includeShared` merge, not `searchScopes`. The `repo+shared` exclusion of
  `local` rests on a single unit test.
- No test covers `CONTEXTFORGE_SHARED_SCOPE_KEY` falling back on the search
  path specifically.

## Milestone 4: First Real Distill Provider

Tracking issue: #6.

Status: merged in PR #13.

Selected first provider: `codex_exec`.

Requirements:

- no API key required if Codex OAuth is already configured
- parse JSON-only model output robustly
- preserve raw events on failure
- provide clear timeout and context budget controls

Follow-on providers:

- OpenAI-compatible API provider
- Claude Code exec provider
- local model provider

## Milestone 5: MCP Server

Tracking issue: #4.

Status: broad 0.3.x surface implemented.

Goals:

- expose core functions to Codex, Claude Code, Cursor, and other MCP clients
- keep tool schemas small
- include examples for agent integration
- document context budget guidance

Tool surface:

- `begin_session`
- `session_status`
- `sync_resume_context`
- `search`
- `get_memory`
- `remember`
- `list_memory_events`
- `list_memory_candidates`
- `list_memory_update_candidates`
- `append_raw`
- `prune_raw_events`
- `distill_checkpoint`
- `submit_distill_job`
- `submit_audit_job`
- `get_job`
- `list_jobs`
- `process_jobs`
- `cancel_job`
- `distill_usage`
- `suggest_memory_promotions`
- `auto_promote_memory_candidates`
- `reconcile_memory`
- `promote_memory`
- `promote_memory_candidate`
- `reject_memory_candidate`
- `correct_memory`
- `deactivate_memory`
- `embedding_inventory`
- `prune_embedding_artifacts`
- `process_embedding_jobs`
- `list_embedding_jobs`
- `rebuild_embeddings`

Initial implementation:

- stdio MCP server entrypoint for local agent integrations
- Streamable HTTP MCP endpoint for remote canonical deployments
- package binary `contextforge-mcp`
- tool schemas for stable core methods
- structured JSON results plus text fallback content
- start/resume, closeout promotion review, safe auto-promotion dry-run/apply,
  and memory reconciliation wrappers over the lower-level memory primitives

## Milestone 6: Promotion Workflow

Tracking issue: #10.

Status: 0.3.x implementation in place.

Goals:

- review memory candidates from checkpoints
- promote to durable memory explicitly
- track provenance from raw/checkpoint to durable memory
- support correction/deactivation rather than destructive deletion

Initial implementation:

- checkpoint `memoryCandidates` can be listed without promotion
- `suggestMemoryPromotions` proposes at most one to three high-signal closeout
  candidates without scope-wide fallback by default
- `autoPromoteMemoryCandidates` supports strict closeout-scoped automatic
  promotion with dry-run defaults and environment-gated real promotion
- `reconcileMemory` surfaces prior knowledge basis and applies only safe,
  explicit user corrections
- preference candidates can record repeated occurrences for later merge/review
- `promoteMemory` writes durable memory with source checkpoint/session/candidate metadata
- `correctMemory` updates a durable key while preserving previous content in memory-event metadata
- `deactivateMemory` marks memories inactive instead of deleting them
- `listMemoryEvents` exposes provenance events for audit/debug flows
- search excludes inactive memories while exact `getMemory` can still inspect them

Grown well past the original goals since:

The registry classifies 24 of 88 registered operations as `review` capability,
which makes this the largest area of the operation surface after plain reads.
None of the following was in the goals above. It is recorded here rather than
left implicit, because a reader deciding what to work on next should see where
the code actually went.

- audited promotion: `submitAuditJob`, `auditMemoryCandidates`,
  `listMemoryCandidateAuditAttempts`, `planMemoryCandidateBacklogAudit`
- routing of audited candidates into update proposals rather than duplicate
  durable memory: `routeAuditedMemoryCandidates`, `applyMemoryUpdateCandidate`,
  `rejectMemoryUpdateCandidate`, `skipMemoryUpdateCandidate`
- candidate lifecycle states: snooze, wake, and stale transitions, with
  `listDue*` queries beside them
- `memoryCandidateBacklog` and `auditMemoryDuplicates`

The supervised workers that drive those transitions (`processDue*`,
`processConsolidations`) are `operator` capability rather than `review`, so
they sit outside that count while belonging to the same machinery.

Whether this depth is proportionate for a product with no users yet is an open
question, not a settled direction. It is listed under Open Decisions.

## Milestone 7: Retrieval Quality

Tracking issue: #9.

Status: 0.3.x hybrid retrieval and embedding queue implemented.

Possible improvements:

- SQLite FTS
- hybrid lexical/vector retrieval
- explainable ranking
- contradiction detection
- stale memory warnings

Keep vector search as a retrieval surface, not the canonical source of truth.

Initial implementation:

- SQLite FTS5 index over active durable memories
- canonical memory remains in `memories`; FTS is rebuilt/updated as a retrieval index
- weighted FTS rank is combined with explainable lexical scoring
- result metadata includes `why` token/field/match-type details and `retrieval.ftsRank`
- sqlite-vec hybrid retrieval is available when embeddings are configured
- embedding jobs decouple vector indexing from memory/checkpoint writes
- `processEmbeddingJobs` retries failed work and resets stale `processing` jobs
- `embeddingInventory` classifies derived-data lifecycle drift without writes
- `pruneEmbeddingArtifacts` applies dry-run-first, bounded transactional GC
- `dbInfo` and bootstrap storage metadata report vector readiness, stale
  sources, failed jobs, and degraded retrieval state
- inactive memories remain excluded from search

## Milestone 8: Embedding Queue Operations

Tracking issues: #77 and #82.

Status: implemented in PR #98.

Delivered:

- persistent `embedding_jobs` table with status, attempts, content hash, and
  last-error metadata
- queueing from durable memory, checkpoint, and memory-candidate write paths
- explicit processing through CLI, remote API, and MCP
- atomic job claiming for multi-worker safety
- stale `processing` reset with configurable
  `CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS`
- rebuild path that enqueues and processes derived vector work

## Milestone 9: Workspace Federation

Tracking issue: none yet.

Status: implemented, previously unrecorded here.

Federation was built without a milestone entry, so the roadmap described a
narrower product than the one that exists. It is adjacent to Milestone 3 but a
separate mechanism: `searchScopes` merges scopes into one ranked list, while
federation leaves the primary search alone and returns a separate workspace
block with its own ordering and its own shared-scope policy.

Implemented:

- workspace profiles, members, and routing rules with `off`/`auto`/`strict`
  modes
- a federation block on `search` and `bootstrapContext` carrying per-member
  results with role and workspace metadata
- member-level scope permissions, including `allowLocal` gating
- workspace-scoped repository aliases and scope migration

Remaining:

- no tracking issue, and no entry in the follow-up split below
- the relationship to Milestone 3 is undocumented outside this paragraph

## Open Decisions

- Default repo scope keys now infer from git remotes when possible, normalize
  common GitHub remotes to `github.com/owner/repo`, and fall back to
  deterministic path keys. Explicit user config still wins.
- Which remote provider types should eventually support client-side execution
  while still writing checkpoints through the remote canonical API?
- Provider prompt/schema versions are now recorded for `codex_exec` distill
  runs; future providers should expose the same metadata contract.
- `codex_exec` can be checked with a dry doctor command and an opt-in live
  structured smoke before users enable it as the distillation provider.
- Is the depth of the candidate review workflow proportionate? It is 24 of 88
  operations by the registry's own `review` classification, plus the operator
  workers that drive it, and most recent work, while the core it
  sits on top of has not moved in comparison. Deciding this is a prerequisite
  for planning anything else, because it determines whether the next work
  extends the review surface or deliberately stops.
- Should `local` scope be writable through a remote server? Milestone 2 records
  the contradiction; resolving it means picking one of the two documented
  positions and enforcing it in code.
- Should embedding queue dead-letter/max-attempt behavior preserve stale reset
  attempts, reset them, or introduce a separate retry budget?
- Should large-store coverage and `dbInfo` checks move to SQL aggregation or
  cached counters?

## Follow-Up Issue Split

Each milestone after v0 has a focused tracking issue:

- #5: provider abstraction hardening
- #8: remote storage mode
- #7: shared plus repo scoped retrieval
- #6: `codex_exec` distillation provider
- #4: MCP server surface
- #10: explicit memory promotion workflow
- #9: retrieval quality improvements
- #19: default repo scope key inference
- #21: distillation provider prompt versioning
- #77: embedding queue separation
- #82: embedding job processing operations

Those issues should stay narrow enough to produce reviewable PRs.

Milestone 9 (workspace federation) has no tracking issue. Neither does the
candidate review workflow that grew out of Milestone 6, which is why its scope
was never weighed against anything.
