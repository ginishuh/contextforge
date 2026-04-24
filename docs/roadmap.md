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

Status: initial implementation in progress.

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

Status: initial implementation in progress.

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

Status: initial implementation in progress.

Goals:

- expose core functions to Codex, Claude Code, Cursor, and other MCP clients
- keep tool schemas small
- include examples for agent integration
- document context budget guidance

Initial tool surface:

- `begin_session`
- `search`
- `get_memory`
- `remember`
- `append_raw`
- `distill_checkpoint`
- `promote_memory`

Initial implementation:

- stdio MCP server entrypoint for local agent integrations
- package binary `contextforge-mcp`
- tool schemas for stable core methods
- structured JSON results plus text fallback content
- explicit `promote_memory` primitive for reviewed durable-memory writes

## Milestone 6: Promotion Workflow

Tracking issue: #10.

Status: initial implementation in progress.

Goals:

- review memory candidates from checkpoints
- promote to durable memory explicitly
- track provenance from raw/checkpoint to durable memory
- support correction/deactivation rather than destructive deletion

Initial implementation:

- checkpoint `memoryCandidates` can be listed without promotion
- `promoteMemory` writes durable memory with source checkpoint/session/candidate metadata
- `correctMemory` updates a durable key while preserving previous content in memory-event metadata
- `deactivateMemory` marks memories inactive instead of deleting them
- `listMemoryEvents` exposes provenance events for audit/debug flows
- search excludes inactive memories while exact `getMemory` can still inspect them

## Milestone 7: Retrieval Quality

Tracking issue: #9.

Status: initial implementation in progress.

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
- inactive memories remain excluded from search

## Open Decisions

- Default repo scope keys now infer from git remotes when possible, normalize
  common GitHub remotes to `github.com/owner/repo`, and fall back to
  deterministic path keys. Explicit user config still wins.
- Which remote provider types should eventually support client-side execution
  while still writing checkpoints through the remote canonical API?
- How should provider prompts be versioned?
- Should checkpoint memory candidates require explicit human approval or allow a
  configurable auto-promote policy?
- What is the minimum auth model for remote mode?
- Should MCP ship before or after the first real provider?

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

Those issues should stay narrow enough to produce reviewable PRs.
