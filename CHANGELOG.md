# Changelog

## Unreleased

- Added candidate-id review workflows: `promoteMemoryCandidate --candidateId`
  marks candidates as promoted with review metadata, and `rejectMemoryCandidate`
  marks reviewed candidates as rejected without creating durable memory.
- Exposed candidate rejection through the CLI, remote API, and MCP
  `reject_memory_candidate` tool.
- Added v2 memory-candidate review fields for type, confidence, stability,
  sensitivity, recommendation, and source event ids.
- Added lightweight candidate promotion warnings for duplicate keys, duplicate
  content, risky recommendation/sensitivity signals, and low confidence or
  stability. Callers must pass `allowWarnings` to promote through warnings.
- Added candidate review state guards so already promoted or rejected candidates
  cannot be changed again unless callers pass `allowStatusOverride`.
- Made memory-candidate index backfill run once per database instead of on every
  store open.
- Exposed `maxEvents` and `maxChars` on MCP `session_status` and
  `distill_checkpoint`, matching the CLI/core bounded-window controls.
- Preserved remote error names and warning details across the remote client
  boundary.

## 0.1.3 - 2026-04-26

- Made MCP agent guidance more discoverable by documenting startup bootstrap
  behavior and keeping repository `AGENTS.md` files small.
- Updated MCP server instructions to tell agents to inspect checkpoint memory
  candidates after distillation or when session status reports pending
  candidates.
- Added `memoryCandidateCount` to `distillCheckpoint` results and
  `latestCheckpointMemoryCandidateCount` plus a candidate hint to
  `sessionStatus`, so agents can discover candidate memories without guessing.

## 0.1.2 - 2026-04-26

- Added server/local raw evidence TTL pruning with `CONTEXTFORGE_RAW_TTL_DAYS`,
  preserving checkpoints, distill runs, and promoted durable memories.
- Added `pruneRawEvents` to the CLI, remote API, and MCP tools for explicit
  raw evidence cleanup.
- Reduced distillation cost risk by requiring
  `CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS` before char-threshold checkpoint
  creation after an existing checkpoint.
- Made checkpoint continuation use the last raw event actually covered by the
  previous checkpoint, so already-distilled raw evidence is skipped while raw
  appended during distillation remains eligible for the next checkpoint.
- Documented raw retention and distillation cost controls in the remote
  operation guide.

## 0.1.1 - 2026-04-26

- Added agent-level multi-repo routed ingest for Codex and Claude Code, so each
  adapter can scan its global session store once and route files to repo
  `scopeKey` values through a registry.
- Added repo registry matching with enabled flags, adapter filters, most-specific
  nested `repoPath` precedence, explicit unknown-cwd skips, and routed result
  logs that include matched repo names and canonical scope keys.
- Added systemd user service installers for `codex` and `claude_code` agent
  routers, keeping the older repo-specific watcher available for simple
  single-repo deployments.
- Strengthened README positioning with the explainer comic, remote-first
  architecture guidance, canonical repo `scopeKey` setup notes, and
  agent-router examples.

## 0.1.0 - 2026-04-25

- Added `ingestCodexRollout`, which ingests Codex TUI rollout JSONL artifacts
  into raw evidence without spending model tokens on capture, deduplicates
  records, and can optionally trigger checkpoint distillation.
- Added `ingestCodexSessions` for repeated multi-session scans of Codex rollout
  directories, including safe handling for actively-written trailing lines.
- Added `ingestCodexSessions --watch` for long-running local TUI capture loops
  with per-iteration JSON logs and bounded `--iterations` smoke checks.
- Codex ingest now namespaces session ids as `codex:<native-session-id>` and
  records standard agent/runtime provenance metadata for future multi-TUI use.
- Added Claude Code JSONL ingestion with `claude_code:<native-session-id>`
  session namespacing and the same raw evidence/checkpoint provenance model.
- Added `promoteMemoryCandidate` so reviewed checkpoint candidates can be
  promoted from CLI without copying candidate fields manually.
- Added a systemd user service installer for long-running Codex watch ingest
  against a remote ContextForge server.
- Repo-specific TUI ingest now skips transcript files whose recorded cwd is
  outside `--repoPath`, preventing global session scans from crossing repo
  scopes.
- Checkpoint distillation now uses bounded recent raw-event windows with
  configurable max event/character limits and records source window metadata.
- MCP now exposes `promote_memory_candidate` so reviewed checkpoint candidates
  can be promoted without manually copying candidate fields.
- The remote server now exposes a Streamable HTTP MCP endpoint at `/mcp`, so
  agents on multiple machines can connect directly to the same canonical memory
  store without launching a local stdio MCP bridge.
- Scoped CLI and MCP calls can now pass `repoPath` or `cwd` so repo memory is
  resolved for a target checkout even when the agent process starts elsewhere.
- Remote clients strip `repoPath` and `cwd` after resolving scope keys so local
  filesystem paths are not sent to the remote server.
- MCP instructions now call out intentional durable memory writes with
  `remember` and reviewed checkpoint promotion with `promote_memory`.
- Remote HTTP requests that exceed `CONTEXTFORGE_REMOTE_MAX_BODY_BYTES` now
  return `413 Payload Too Large` instead of a generic `500` response.
- `sessionStatus` no longer recommends the first checkpoint from event count
  alone. Initial checkpoint recommendations now require the raw character
  threshold; after a checkpoint exists, event count is still paired with the
  interval threshold.
