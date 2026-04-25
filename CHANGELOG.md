# Changelog

## Unreleased

- Added `ingestCodexRollout`, which ingests Codex TUI rollout JSONL artifacts
  into raw evidence without spending model tokens on capture, deduplicates
  records, and can optionally trigger checkpoint distillation.
- Added `ingestCodexSessions` for repeated multi-session scans of Codex rollout
  directories, including safe handling for actively-written trailing lines.
- Added `ingestCodexSessions --watch` for long-running local TUI capture loops
  with per-iteration JSON logs and bounded `--iterations` smoke checks.
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
