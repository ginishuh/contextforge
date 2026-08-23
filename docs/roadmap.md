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

Status: implemented. Note that "multi-machine sync" was met by one canonical
server every machine talks to, not by replication or an offline cache.

Remote mode is an early first-class path for users whose canonical work already
lives on a VPS or server. Local mode remains the zero-friction install and a
useful fallback/cache shape.

Goals:

- server-backed canonical memory
- client auth
- multi-machine sync
- local fallback behavior
- clear shared/repo/local write policy

Initial implementation:

- JSON HTTP server for the stable core methods
- remote client mode selected by `CONTEXTFORGE_STORAGE_MODE=remote`
- bearer token auth with `CONTEXTFORGE_REMOTE_TOKEN`
- visible failure when remote is unavailable instead of silent local fallback
- server-side distillation for canonical checkpoint writes

## Milestone 3: Shared + Repo Retrieval

Tracking issue: #7.

Status: implemented. Repo preference is a tie-breaker between equally relevant
results rather than a ranking policy.

Goals:

- allow querying `repo` and `shared` together
- keep `local` opt-in
- provide result source metadata
- favor exact repo memory while including useful shared rules

Initial implementation:

- `searchScopes` option for `scope`, `repo`, `shared`, `repo+shared`, and
  `local`
- `sharedScopeKey` option with `CONTEXTFORGE_SHARED_SCOPE_KEY` fallback
- result `source` metadata describing the returned scope and role
- local memory remains excluded from `repo+shared`

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

Fixing automatic promotion after #208 grew this into a much larger candidate
lifecycle than the goals above describe: audit state, snooze/wake/stale
handling, backlog planning, update-candidate routing, and supervised workers.
Whether that depth is warranted is an open question, not a settled design.

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

Workspace profiles, members, and routing rules, with a federation block on
`search` and `bootstrapContext`. Adjacent to Milestone 3 but a separate
mechanism: `searchScopes` merges scopes into one ranked list, while federation
returns a separate block.

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
- What is the minimum auth model for remote mode?
- Is the candidate lifecycle built after #208 more than the problem needed? The
  original goal was that candidates get audited at closeout and safe ones get
  promoted; what exists now is a multi-state workflow. Reviewing that for
  over-design comes before extending it further.
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
