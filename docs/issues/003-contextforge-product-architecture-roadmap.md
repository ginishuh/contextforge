# Issue 003: Capture the Full ContextForge Product Architecture and Roadmap

## Summary

Document and implement the full ContextForge direction beyond the v0 local core.

PR #2 builds a useful first slice, but it does not yet encode the broader product
design that led to ContextForge. Future agents need this issue as the guiding
architecture.

ContextForge should become a standalone, public, self-hosted memory and
distillation runtime for coding agents such as Codex, Claude Code, Cursor, and
other MCP-compatible tools.

## Core Thesis

ContextForge is not just another vector memory server or flat notes directory.

It should be an operational memory runtime with:

- canonical durable memory
- scoped retrieval
- append-only raw evidence
- LLM-distilled checkpoints
- bring-your-own distillation providers
- repo-aware and shared memory scopes
- local-first storage with remote/VPS mode for multi-machine users
- adapters for coding agents and MCP

The original inspiration was Codex-style memory, but private production memory
systems showed that the useful shape is more operational than a flat notes file.
ContextForge should extract that generic architecture without depending on any
private runtime.

## Product Positioning

Use this positioning:

```text
ContextForge is a self-hosted memory and distillation runtime for coding agents.
It turns raw agent interaction history into scoped, searchable, durable context.
```

Avoid positioning it as:

- a generic note-taking app
- a SaaS memory product
- a vector database wrapper
- a plugin for one private runtime
- a replacement for a coding agent's built-in memory

Better framing:

```text
ContextForge is a sidecar memory runtime. It complements existing agent memory
systems by providing canonical project/repo memory, evidence retention, and
LLM-backed distillation.
```

## Relationship to Existing Agent Memory

Codex, Claude Code, and similar coding agents already have their own memory or
session persistence. ContextForge should not fight that.

The intended relationship:

- Built-in agent memory remains useful for local agent behavior and general user
  preferences.
- ContextForge owns project/repo/shared canonical memory.
- ContextForge should be queried on demand instead of dumping large summaries
  into every prompt.
- ContextForge should not require disabling Codex/Claude/Cursor memory.

The safe rule:

```text
Do not replace built-in memory. Add a scoped, searchable project memory sidecar.
```

## Storage Model

Support three storage modes.

### 1. Local mode

Default mode for most users.

- SQLite on the local machine
- no server required
- simple install
- best for one developer on one machine

### 2. Project-local mode

Repo-bound storage in a gitignored directory.

- useful when memory should travel with one checkout but not git
- example: `.contextforge/`
- must never recommend committing the live DB

### 3. Remote/VPS mode

Canonical memory server for multi-machine and multi-agent users.

- best for users who work from several machines
- a VPS can become the source of truth
- local clients should act as retrieval/write clients
- useful for sharing memory between Codex, Claude Code, Cursor, and custom agents

Do not use git as the live storage backend for SQLite or raw events. Git can hold
source, docs, migrations, example exports, and reviewed snapshots only.

## Scope Model

The scope model is central. Keep it explicit.

### `shared`

Cross-repo and cross-agent durable knowledge.

Examples:

- user preferences
- global workflow rules
- organization-level conventions
- reusable architecture decisions

### `repo`

Repository-specific canonical memory.

Examples:

- architecture decisions
- module boundaries
- test conventions
- known pitfalls
- issue/PR history distilled into durable facts

### `local`

Machine-specific or temporary memory.

Examples:

- local paths
- one-off experiments
- machine-specific tool setup
- unpromoted scratch observations

Important:

- `shared` and `repo` should be queryable together when appropriate.
- `local` should not leak into shared or remote scopes by default.
- Promotion from `local` or checkpoint content into durable `repo/shared` memory
  should be explicit.

## Memory Layers

ContextForge should separate memory into layers.

### Durable memories

Canonical facts, rules, decisions, and preferences.

This is the highest-trust layer.

### Checkpoints

LLM-distilled recent continuity.

Checkpoints answer:

- where did we leave off?
- what was recently decided?
- what remains open?
- what should a new agent know to continue?

Checkpoints are important, but they are not canonical truth. They can suggest
durable memories, but should not silently become durable memory.

### Raw evidence

Append-only source material.

Raw evidence is useful for:

- auditability
- later distillation
- debugging bad summaries
- recovering context that was not promoted

Raw evidence should not be loaded by default. It should be opt-in and scoped.

### Daily summaries

Daily summaries are not part of the essential core.

They may be useful later for reporting, human review, or operations dashboards,
but they should not be required for ContextForge v1. Durable memory plus
checkpoints plus raw evidence is the stronger core.

## Distillation Policy

Distillation is a core capability.

Do not design checkpoints as string heuristics. Prior experience showed that
LLM-free checkpoint generation becomes noisy and unreliable because it cannot
reliably distinguish decisions, temporary chatter, durable facts, and open
questions.

Therefore:

- useful checkpoints require an LLM
- distillation should be explicit and provider-backed
- distillation failure must not destroy raw evidence
- raw capture and durable memory writes should work even if distillation fails

## Bring-Your-Own Distillation Provider

ContextForge should not require one vendor's API key.

Users should be able to use whichever coding agent or model access they already
have.

Provider examples:

- `codex_exec`: use Codex OAuth/session through `codex exec`
- `claude_code_exec`: use Claude Code's execution path
- direct OpenAI-compatible APIs
- z.ai-compatible APIs
- local model runners such as Ollama or LM Studio

The product idea:

```text
Bring your own model for distillation.
```

Implementation rule:

- define the distillation contract first
- implement providers as adapters
- never couple storage/retrieval to one provider

## Distillation Contract

Inputs should include:

- scope
- session id
- conversation id
- raw event slice
- optional previous checkpoint
- optional durable memories relevant to the session
- requested output schema

Outputs should include:

- `summaryShort`
- `summaryText`
- `decisions`
- `todos`
- `openQuestions`
- `memoryCandidates`
- `sourceEventCount`
- `provider`
- enough metadata to debug the run

Memory candidates must not automatically become durable memories unless the
caller explicitly chooses that policy.

## Retrieval Policy

Keep context cost controlled.

Default retrieval should be:

- compact
- explainable
- scoped
- on demand

Recommended order:

1. local reality from the current repository
2. ContextForge durable memory from `repo + shared`
3. checkpoints for recent continuity when requested
4. raw evidence only when explicit
5. built-in agent memory and markdown fallback as supporting context

Avoid:

- auto-loading all checkpoints
- auto-loading raw events
- dumping giant memory files into prompt context
- treating vector results as unexplainable truth

## Context Budget Rule

ContextForge should reduce prompt bloat, not increase it.

The correct model:

- preload only a tiny bootstrap summary if needed
- use `search` and `getMemory` for detail
- fetch checkpoints only when continuing recent work
- fetch raw evidence only for audit or repair

## Adapter Strategy

Build adapters after the core is stable.

Likely adapter layers:

- CLI
- MCP server
- Codex instructions/example integration
- Claude Code instructions/example integration
- remote HTTP API for VPS mode

The MCP server should expose a small tool surface first:

- `begin_session`
- `search`
- `get_memory`
- `remember`
- `append_raw`
- `distill_checkpoint`
- `promote_memory`

Keep MCP tools narrow and schema-stable.

## Public Repo Safety

ContextForge is intended to be public.

Never include:

- real user memory
- raw private transcripts
- private workspace data
- persona or user-specific files
- secrets or tokens
- live SQLite DB files
- machine-specific paths as required defaults

Examples should be synthetic.

Private implementations can remain reference material, but ContextForge must run
without any private runtime installed.

## Suggested Roadmap

### Milestone 0: v0 local core

Status: PR #2.

Expected:

- SQLite storage
- durable memories
- raw events
- checkpoints
- mock distill provider
- JSON CLI
- tests

### Milestone 1: provider abstraction hardening

Goals:

- finalize distillation input/output schema
- validate provider outputs
- store distill run metadata
- handle provider failure safely
- add retry/error states where needed

### Milestone 2: first real distill provider

Recommended first provider:

- `codex_exec`

Requirements:

- no API key required if Codex OAuth is already configured
- parse JSON-only model output robustly
- preserve raw events on failure
- clear timeout and token budget controls

After that:

- z.ai/OpenAI-compatible API provider
- Claude Code exec provider
- local model provider

### Milestone 3: shared + repo retrieval

Goals:

- allow querying `repo` and `shared` together
- keep `local` opt-in
- provide result source metadata
- add ranking that favors exact repo memory but includes useful shared rules

### Milestone 4: MCP server

Goals:

- expose core functions to Codex/Claude/Cursor through MCP
- keep tool schemas small
- include examples for agent integration
- document context budget guidance

### Milestone 5: remote/VPS mode

Goals:

- server-backed canonical memory
- client auth
- multi-machine sync
- local fallback behavior
- clear shared/repo/local write policy

### Milestone 6: promotion workflow

Goals:

- review memory candidates from checkpoints
- promote to durable memory explicitly
- track provenance from raw/checkpoint to durable memory
- support correction/deactivation rather than destructive deletion

### Milestone 7: retrieval quality

Possible improvements:

- SQLite FTS
- hybrid lexical/vector retrieval
- explainable ranking
- contradiction detection
- stale memory warnings

Keep vector search as a retrieval surface, not the canonical source of truth.

## Decisions Already Made

- App name: `ContextForge`
- Keep private implementations as reference material only
- Public repo should be standalone
- Distillation is required for high-quality checkpoints
- LLM provider should be pluggable
- Codex OAuth/`codex exec` can be a practical default distill path
- Users with z.ai or similar API keys can use direct provider adapters
- Default user mode is probably local SQLite
- VPS/remote mode is for multi-machine and multi-agent users
- Git-backed live DB storage is not recommended
- Daily summaries are not core
- Checkpoints are useful but should not be automatically preloaded as truth

## Open Questions

- What exact default should repo scope keys use: git remote URL, normalized
  `owner/repo`, absolute path hash, or explicit user config?
- Should `codex_exec` be the first real provider, or should direct API come first
  because it is easier to test in CI?
- How should provider prompts be versioned?
- Should checkpoint memory candidates require explicit human approval or allow a
  configurable auto-promote policy?
- What is the minimum auth model for remote/VPS mode?
- Should MCP be shipped before or after the first real provider?

## Acceptance Criteria for This Issue

This issue can close when:

- the README reflects the full product direction
- docs explain storage modes, scopes, memory layers, and distillation policy
- a roadmap exists in repo docs
- future issues are split from the roadmap into actionable implementation tasks
- no private assumptions are required to understand the architecture

## Follow-Up Issues

- #5: provider abstraction hardening
- #6: `codex_exec` distillation provider
- #7: shared plus repo scoped retrieval
- #4: MCP server surface
- #8: remote storage mode
- #10: explicit memory promotion workflow
- #9: retrieval quality improvements
