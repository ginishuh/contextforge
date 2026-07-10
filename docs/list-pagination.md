# List Pagination

ContextForge bounds public list operations to protect the event loop and remote
responses as stores grow.

## Contract

The following core/CLI/HTTP operations use the common contract:

- `listMemories`
- `listRawEvents`
- `listCheckpoints`
- `listEmbeddingJobs`
- `listMemoryCandidates`
- `listMemoryEvents`
- `listPreferenceOccurrences`
- `listMemoryUpdateCandidates`
- `listDistillRuns`
- `listLlmUsageEvents`

The default limit is `100` and the server hard maximum is `500`. A larger
requested limit is clamped to `500`. Existing callers continue to receive an
array, now bounded by that limit.

Pass `page: true` to receive an envelope:

```json
{
  "kind": "raw_events_page",
  "items": [],
  "page": {
    "requestedLimit": 100,
    "limit": 100,
    "returned": 0,
    "hasMore": false,
    "nextCursor": null
  }
}
```

When `nextCursor` is non-null, pass it unchanged as `cursor`. Supplying a cursor
implicitly selects the page envelope even when `page` is omitted.

Cursors are opaque, versioned, and bound to the operation plus its scope and
filters. A cursor from another session, scope, status, sort order, or list
operation fails clearly. Malformed cursors also fail; clients must not decode,
edit, or synthesize them. Cursor tuple arity and primitive types are validated
per operation before any SQL query is executed.

Ordering is deterministic and uses a unique tie-breaker:

- raw events and memory events: `createdAt ASC, id ASC`
- checkpoints and default memory candidates: `createdAt DESC, id DESC`
- embedding jobs: `updatedAt ASC, id ASC`
- distill runs and LLM usage: requested time order plus matching id order
- memories: `importance DESC, updatedAt DESC, key ASC`
- preference occurrences: `occurrenceCount DESC, updatedAt DESC, id DESC`
- memory update candidates: `createdAt DESC, id DESC`

Keyset cursors avoid duplicates when a new row is inserted before the current
cursor. They are not a database snapshot: rows inserted after the cursor may
appear on later pages, while newly inserted rows ordered before it are left for
a fresh traversal. Deleted cursor rows do not invalidate the position because
the cursor stores sort values rather than a row reference.

Recommendation-sorted memory candidates do not support cursor pagination
because that ranking has a wider mutable tuple. Use the default created order
for paging, or request one bounded recommendation-sorted array.

## CLI

Request one page:

```bash
node src/cli.js listCheckpoints \
  --scope repo \
  --scopeKey github.com/example/repo \
  --limit 50 \
  --page true
```

Collect every page explicitly:

```bash
node src/cli.js listRawEvents \
  --scope repo \
  --scopeKey github.com/example/repo \
  --sessionId codex:example \
  --limit 100 \
  --allPages true
```

`--allPages` follows server cursors and returns one `{ items, pages, returned }`
envelope. It is intentionally explicit because collecting all rows can still be
expensive even though each server request is bounded. A 10,000-page client-side
safety limit prevents a broken cursor loop.

Only the pageable list commands omit the CLI's historical implicit `limit=10`
so they can use the common server default of 100. Non-pageable commands retain
their existing CLI default; #175 does not widen worker, rollup, search, or scope
inventory calls.

## MCP And Compatibility

MCP list tools that expose these operations accept `limit`, `cursor`, and
`page`. HTTP remote clients use the same core response shapes and cursor
validation as local callers.

The compatibility window preserves array responses when neither `page` nor
`cursor` is present. The behavioral change is that formerly unbounded arrays
now stop at the default/server maximum. Clients that genuinely need more rows
must migrate to cursor pages or the explicit CLI `--allPages` flow.
