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

Goals:

- finalize distillation input/output schema
- validate provider outputs
- store distill run metadata
- handle provider failure safely
- add retry/error states where needed

## Milestone 2: Remote Mode

Tracking issue: #8.

Remote mode is an early first-class path for users whose canonical work already
lives on a VPS or server. Local mode remains the zero-friction install and a
useful fallback/cache shape.

Goals:

- server-backed canonical memory
- client auth
- multi-machine sync
- local fallback behavior
- clear shared/repo/local write policy

## Milestone 3: Shared + Repo Retrieval

Tracking issue: #7.

Goals:

- allow querying `repo` and `shared` together
- keep `local` opt-in
- provide result source metadata
- favor exact repo memory while including useful shared rules

## Milestone 4: First Real Distill Provider

Tracking issue: #6.

Recommended first provider: `codex_exec`.

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

## Milestone 6: Promotion Workflow

Tracking issue: #10.

Goals:

- review memory candidates from checkpoints
- promote to durable memory explicitly
- track provenance from raw/checkpoint to durable memory
- support correction/deactivation rather than destructive deletion

## Milestone 7: Retrieval Quality

Tracking issue: #9.

Possible improvements:

- SQLite FTS
- hybrid lexical/vector retrieval
- explainable ranking
- contradiction detection
- stale memory warnings

Keep vector search as a retrieval surface, not the canonical source of truth.

## Open Decisions

- What exact default should repo scope keys use: git remote URL, normalized
  `owner/repo`, absolute path hash, or explicit user config?
- Should `codex_exec` be the first real provider, or should direct API come first
  because it is easier to test in CI?
- In remote mode, should distillation providers run client-side, server-side, or
  both depending on provider type?
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

Those issues should stay narrow enough to produce reviewable PRs.
