# Changelog

## Unreleased

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
