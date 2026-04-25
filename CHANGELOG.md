# Changelog

## Unreleased

- Remote HTTP requests that exceed `CONTEXTFORGE_REMOTE_MAX_BODY_BYTES` now
  return `413 Payload Too Large` instead of a generic `500` response.
- `sessionStatus` no longer recommends the first checkpoint from event count
  alone. Initial checkpoint recommendations now require the raw character
  threshold; after a checkpoint exists, event count is still paired with the
  interval threshold.
