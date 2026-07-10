# Retrieval Performance

ContextForge search uses bounded index candidates by default. It no longer
loads every active durable memory in a scope into JavaScript for lexical
rescoring.

## Default Strategy

For each selected scope, search materializes at most a bounded window from each
available source:

- SQLite FTS5 durable-memory candidates using Unicode-aware exact/prefix terms;
- sqlite-vec durable-memory candidates when a query embedding is available;
- sqlite-vec checkpoint candidates when available;
- sqlite-vec memory-candidate rows when available.

The result limit is capped at `100`. The default candidate window is at least
`50`, grows up to four times the effective result limit, and is capped at `200`
rows per index source. Callers may lower it or raise it only as far as the hard
cap of `500` with `candidateLimit`. Increasing `limit` therefore cannot restore
an unbounded scope scan.

FTS5 preserves the supported exact/prefix, path, API/error identifier, Korean,
and mixed-language query behavior. Arbitrary substring matching inside a token
is intentionally not part of the indexed default. For diagnosis and ranking
comparison only, `legacyFullScan: true` restores the old scope-wide lexical
scan. That option is linear in scope size and should not be enabled in normal
agent traffic.

CLI example:

```bash
node src/cli.js search \
  --scope repo \
  --scopeKey github.com/example/repo \
  --query 'POST /v0/dbInfo SQLITE_BUSY' \
  --candidateLimit 100
```

Diagnostic substring comparison:

```bash
node src/cli.js search \
  --scope repo \
  --scopeKey github.com/example/repo \
  --query 'internal-fragment' \
  --legacyFullScan true
```

Each returned result includes the same `retrieval.diagnostics` block:

- `elapsedMs`: in-process search time;
- `requestedLimit` and capped `resultLimit`;
- effective per-index `candidateLimit`;
- `scopeCount`;
- `scannedRows`: rows materialized from index queries plus an optional legacy
  scan (not SQLite's internal query-plan page visits);
- unique `candidateRows` and final `returnedRows`;
- row counts by FTS, vector memory/checkpoint/candidate, and legacy lexical
  source.
- `degradedSources` when an optional vector index cannot be queried; bounded FTS
  results continue to work instead of expanding to a scope scan.

## Synthetic Benchmark

Run the reproducible local benchmark with:

```bash
npm run benchmark:retrieval -- --sizes 100,1000,10000,100000 --iterations 10
```

Add `--vectors --vector-max 10000` to seed 3-dimensional synthetic embeddings
up to the selected size. The script creates temporary SQLite stores, reports
p50/p95 latency and scanned/candidate rows, and removes only its own temporary
directories.

Illustrative 2026-07-10 result on Node.js `v24.18.0` / `aarch64` with three
measured iterations after one warm-up:

| Memories | FTS prefix p95 | FTS scanned | Korean FTS p95 | Path/error FTS p95 | Legacy substring p95 | Legacy scanned |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0.664 ms | 1 | 1.332 ms | 0.757 ms | 2.379 ms | 100 |
| 1,000 | 0.355 ms | 1 | 0.331 ms | 0.397 ms | 11.690 ms | 1,000 |
| 10,000 | 0.607 ms | 1 | 0.557 ms | 0.739 ms | 96.616 ms | 10,000 |
| 100,000 | 0.849 ms | 1 | 0.890 ms | 1.168 ms | 1,049.202 ms | 100,000 |

At 1,000 memories with five measured iterations and synthetic vectors, vector
search materialized 50 rows at p95 `1.915 ms`; hybrid search materialized 51
source rows / 50 unique candidates at p95 `3.099 ms`. These numbers are a
regression reference, not a cross-machine service-level objective. Candidate
counts and golden ranking are the portable correctness signals.
