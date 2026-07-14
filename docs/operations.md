# ContextForge Operations

This runbook covers readiness, metrics, SQLite backup/restore, and graceful
shutdown for the process that owns the canonical store.

## Liveness And Readiness

`GET /healthz` is process liveness only and stays intentionally cheap:

```json
{ "ok": true }
```

`GET /readyz` is unauthenticated so an orchestrator can probe it, but it omits
paths, credentials, and provider secrets. It returns HTTP 200 only when all
required checks pass, otherwise 503. Checks include:

- a SQLite query and exact supported schema version;
- available filesystem bytes;
- queued operation-job threshold and expired running leases;
- operation-worker freshness when queued work outlives its startup grace;
- failed embedding jobs when embeddings are enabled;
- the effective WAL, synchronous, busy-timeout, and foreign-key policy.

Tune the required thresholds on the server process:

```text
CONTEXTFORGE_READINESS_MIN_FREE_BYTES=104857600
CONTEXTFORGE_READINESS_MAX_QUEUED_JOBS=1000
CONTEXTFORGE_READINESS_WORKER_STALE_AFTER_MS=300000
```

An empty queue does not require a continuously running worker. When work is
queued, readiness allows `CONTEXTFORGE_READINESS_WORKER_STALE_AFTER_MS` for a
supervised worker or timer to claim it. After that boundary, no active lease and
no recent worker-observed timestamp makes `/readyz` return 503 with
`checks.operationWorker.reason=operation_worker_stale`. Claim, lease renewal,
completion, and retry update the worker timestamp. Expired-lease recovery does
not count as worker activity because a different operation worker may trigger
that recovery scan.

Provider credentials are never returned or actively exercised by readiness.
Credential/provider smoke checks remain explicit operator actions so a health
probe cannot spend money or trigger an external process.
Pending/stale embedding coverage remains visible in the response and metrics,
but does not by itself make the process unready; unavailable sqlite-vec or
failed embedding jobs do.

## Metrics And Correlation

`GET /metrics` uses Prometheus text format and requires the same bearer token or
admin session as the remote API. It exposes bounded aggregates for:

- HTTP request count, duration, active requests, and status;
- operation and embedding queue depth, oldest queued wait, and stale leases;
- distill outcome/latency aggregates and LLM usage/failure/token totals;
- provider concurrency, disk availability, retrieval latency/candidate scans;
- raw-prune eligible/blocked results observed through the HTTP API.
- memory-candidate throughput, queue age, audit/promotion latency, decisions,
  and durable-write routing classifications;
- 7/30-day post-promotion correction/deactivation, active duplicate,
  transient-promotion, and candidate-to-durable conversion rates;
- bounded provider/model/prompt audit quality slices and active durable-memory
  retrieval-use coverage.

Search and bootstrap retrieval update `memory_retrieval_stats` with only a
memory id, counter, first-use time, and last-use time. Query text and raw result
content are not stored. A query-only store skips this optional counter write so
retrieval remains available. Other counter-write failures are isolated from the
retrieval result and exposed through a process-lifetime failure counter. Audit
quality uses the actual provider, model, and prompt-version strings as
Prometheus labels, with cardinality capped at 100 combinations in one metrics
snapshot. Negative audit-to-promotion intervals are excluded from the latency
average and reported as clock-skew anomalies.

Every HTTP response includes `X-Request-Id`. A supplied `X-Request-Id` is
preserved (bounded to 128 characters); otherwise the server generates one.
Durable distill/audit submissions over HTTP JSON or HTTP MCP persist that
request id with the existing job, session, and checkpoint identifiers.

## SQLite Runtime Policy

ContextForge applies and reports these defaults on every store connection:

```text
journal_mode = WAL
synchronous = NORMAL
busy_timeout = 5000ms
foreign_keys = ON
```

WAL supports concurrent readers while one writer commits. `NORMAL` avoids an
extra sync on common WAL commits while preserving consistency after application
crashes. The busy timeout bounds transient writer contention instead of failing
immediately.

When an existing database schema is older than the running binary, ContextForge
creates a private `contextforge.db.pre-migration-v*.bak` with `VACUUM INTO`
before migration. A newer schema still fails before backup or mutation.

## Backup And Verification

Run backups on the process/host that owns the canonical SQLite store. Remote
clients must not back up checkout-local `.contextforge` and call it canonical.

```bash
node src/cli.js dbInfo
node src/cli.js backupDatabase --file /srv/backups/contextforge-2026-07-11.db
node src/cli.js verifyBackup --file /srv/backups/contextforge-2026-07-11.db
```

Online backup uses SQLite's backup API, writes private database and metadata
files, and records schema version, size, timestamp, and SHA-256. Verification
opens the snapshot read-only and requires metadata hash equality,
`PRAGMA quick_check = ok`, zero `PRAGMA foreign_key_check` rows, and a valid
schema version not newer than this binary. Copy both the database and its
`.metadata.json` file off-host.
Forced replacement is staged and verified at temporary paths first. The prior
database/metadata pair remains in place until the new pair is ready, and an
install error rolls the prior pair back.

## Restore Verification

Restore is dry-run by default:

```bash
node src/cli.js restoreDatabase --file /srv/backups/contextforge-2026-07-11.db
```

To apply, stop the HTTP server, ingest watchers, job workers, and every process
that can open the canonical DB. Then explicitly confirm the offline boundary:

```bash
node src/cli.js restoreDatabase \
  --file /srv/backups/contextforge-2026-07-11.db \
  --dryRun false \
  --confirmOffline true
```

The command verifies the source, makes and verifies a timestamped pre-restore
backup, copies through a private temporary file, removes stale WAL/SHM sidecars,
installs the snapshot, and verifies it again. Start the server only after
`verification.ok` is true, then check `/readyz` and application retrieval.

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` by entering drain mode, stopping new
connections, returning 503 to new API/MCP/UI work on existing connections,
allowing active HTTP requests to finish, closing idle connections,
and then closing ContextForge/SQLite. During drain, `/readyz` reports 503 with
`draining: true` when the connection can still reach the process.

`CONTEXTFORGE_SHUTDOWN_TIMEOUT_MS` defaults to 30000. At the deadline the server
force-closes remaining connections, closes the store, and exits non-zero.
On drain, registered Codex CLI and Python audit children receive SIGTERM and a
bounded SIGKILL fallback while retaining their normal close/reap lifecycle.
Stop separate durable-worker processes before maintenance; the HTTP process can
terminate only children that it spawned itself.
