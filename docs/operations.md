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
- recent distillation failures within a bounded observation window;
- failed embedding jobs when embeddings are enabled;
- the effective WAL, synchronous, busy-timeout, and foreign-key policy.

Tune the required thresholds on the server process:

```text
CONTEXTFORGE_READINESS_MIN_FREE_BYTES=104857600
CONTEXTFORGE_READINESS_MAX_QUEUED_JOBS=1000
CONTEXTFORGE_READINESS_WORKER_STALE_AFTER_MS=300000
CONTEXTFORGE_READINESS_DISTILL_FAILURE_WINDOW_MS=86400000
CONTEXTFORGE_READINESS_MAX_RECENT_DISTILL_FAILURES=10
```

An empty queue does not require a continuously running worker. When work is
queued, readiness allows `CONTEXTFORGE_READINESS_WORKER_STALE_AFTER_MS` for a
supervised worker or timer to claim it. After that boundary, no active lease and
no recent worker-observed timestamp makes `/readyz` return 503 with
`checks.operationWorker.reason=operation_worker_stale`. Claim, lease renewal,
completion, and retry update the worker timestamp. Expired-lease recovery does
not count as worker activity because a different operation worker may trigger
that recovery scan.

`checks.distillation` reports the recent failure count, observation window,
last failure time, provider, and a sanitized reason code/summary. Raw provider
errors are never returned from the unauthenticated endpoint. When failures in
the configured window exceed
`CONTEXTFORGE_READINESS_MAX_RECENT_DISTILL_FAILURES`, `/readyz` returns 503 with
`checks.distillation.reason=recent_distill_failures`. The defaults allow ten
one-off failures but detect a repeating one-minute watcher failure within
eleven minutes; set the maximum to `0` when every recent failure should make
the process unready.

Provider credentials are never returned or actively exercised by readiness.
Credential/provider smoke checks remain explicit operator actions so a health
probe cannot spend money or trigger an external process.
Pending/stale embedding coverage remains visible in the response and metrics,
but does not by itself make the process unready; unavailable sqlite-vec or
failed embedding jobs do.

## Durable distill job worker

Automatic ingest distillation and durable distill jobs are separate execution
paths:

- an ingest watcher started with `--distill auto` calls `distillCheckpoint`
  directly when a session crosses its configured threshold;
- `submitDistillJob` only persists a `distill_checkpoint` operation job and
  returns immediately.

The second path requires a server-side `processJobs` caller. A healthy ingest
watcher does not consume that queue. If clients can call `submitDistillJob`,
deploy the worker with the canonical server instead of depending on a client
process to remain connected.

### Timeout requirements by environment

Apply the remote timeout to the process that keeps a remote provider-backed
request open. Do not copy the same timeout requirement to every client:

| Environment | Primary flow | Provider-bound request? | Timeout requirement |
| --- | --- | --- | --- |
| Local or project-local all-in-one | Direct `distillCheckpoint` against its own store | No remote boundary | `CONTEXTFORGE_REMOTE_TIMEOUT_MS` is unused; configure the provider timeout itself. |
| Canonical HTTP server | Owns the store and executes providers | Not a remote client | Configure server-side provider timeouts; callers still need the appropriate row below. |
| Server-side durable worker | Remote `processJobs` call to the canonical server | Yes | Set the remote timeout above the full bounded provider wall-clock; `180000ms` covers one default 120-second distill call. |
| Remote ingest watcher or agent router | Synchronous `distillCheckpoint` through `--distill auto` | Yes | Set the remote timeout above the provider wall-clock; packaged watchers default to `180000ms`. |
| Durable-submit-only client | `submitDistillJob`, then `getJob` polling | No | It only needs enough time for a queue write/read. It does not need to cover provider execution, so a normal short HTTP timeout is valid. |
| Mixed remote agent or operator | May call both `submitDistillJob` and synchronous provider tools | Sometimes | Use the long-running value unless its permissions and workflow restrict it to submission and status calls. |

A client timeout such as 30 seconds is therefore not inherently wrong. It is
wrong for synchronous `distillCheckpoint`, `processJobs`, or another remote
call that executes a provider whose configured timeout is 120 seconds. It is
valid for a client that only submits durable work and polls status.

For a low-volume deployment, install a systemd user oneshot service:

```ini
# ~/.config/systemd/user/contextforge-operation-worker.service
[Unit]
Description=ContextForge durable distill job worker
After=network-online.target contextforge-remote.service

[Service]
Type=oneshot
WorkingDirectory=/srv/contextforge
EnvironmentFile=/home/contextforge/.config/contextforge/client.env
ExecStart=/usr/bin/node /srv/contextforge/src/cli.js processJobs --operation distill_checkpoint --workerId vps-distill-worker-1 --limit 2 --leaseMs 600000
TimeoutStartSec=10min
```

For the server-side durable worker row above, the environment file must be
private and select the canonical remote server:

```text
CONTEXTFORGE_STORAGE_MODE=remote
CONTEXTFORGE_REMOTE_URL=http://127.0.0.1:8765
CONTEXTFORGE_REMOTE_TOKEN=replace-me
CONTEXTFORGE_REMOTE_TIMEOUT_MS=180000
```

Keep this worker's `CONTEXTFORGE_REMOTE_TIMEOUT_MS` strictly greater than the
configured distill-provider timeout. The default `codex_exec` provider timeout
is 120 seconds; a 30-second worker timeout makes the server reject provider
execution and can create repeated failed `distill_runs` rows.

Run the oneshot from a timer. A one-minute interval stays below the default
five-minute readiness stale boundary while avoiding a resident process for an
empty queue:

```ini
# ~/.config/systemd/user/contextforge-operation-worker.timer
[Unit]
Description=Run ContextForge durable distill job worker periodically

[Timer]
OnBootSec=30s
OnUnitInactiveSec=1min
AccuracySec=10s
Persistent=true
Unit=contextforge-operation-worker.service

[Install]
WantedBy=timers.target
```

Enable the timer and exercise the intended control flow once:

```bash
systemctl --user daemon-reload
systemctl --user enable --now contextforge-operation-worker.timer
systemctl --user start contextforge-operation-worker.service
systemctl --user status contextforge-operation-worker.timer
journalctl --user -u contextforge-operation-worker.service -n 50 --no-pager
curl -fsS http://127.0.0.1:8765/readyz
```

After a representative durable submission, confirm all of the following:

- the job changes from `queued` to `running` to `succeeded`;
- the result contains a real `checkpointId`;
- canonical checkpoint readback returns that identifier;
- `/readyz` reports `ready: true`, `operationQueue.queued: 0`, and
  `operationWorker.ok: true`.

If `/healthz` is healthy while `/readyz` reports
`checks.operationWorker.reason=operation_worker_stale`, the server is alive but
the durable queue is not operational. Deploy or recover `processJobs`; do not
mistake a healthy synchronous `distillCheckpoint` call for proof that the
durable worker path is working.

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

## Candidate lifecycle worker

The lifecycle APIs are bounded and safe to call independently, but unattended
convergence requires a supervised caller. Preview one pass with no mutations:

```bash
node src/cli.js candidateLifecycleWorker \
  --repoRegistry /srv/contextforge/repos.json
```

Apply one pass only after reviewing that output:

```bash
node src/cli.js candidateLifecycleWorker \
  --repoRegistry /srv/contextforge/repos.json \
  --dryRun false
```

Each enabled registry entry is a separate canonical repo scope. The worker
wakes expired snoozes, queues idle-session audits, applies stale-SLA transitions,
and claims audit jobs in that same scope. Defaults are 5 due sessions, 5
candidates per session, 25 wake-ups, 25 stale transitions, and 5 audit jobs per
scope per iteration. A failure is isolated to its scope and reported in the
iteration summary. Unbounded watch mode rejects intervals below 1000ms to avoid
a database busy loop.

Install the remote-backed systemd user service:

```bash
scripts/install-candidate-lifecycle-worker-service.sh \
  --name all-repos \
  --repo-registry /srv/contextforge/repos.json \
  --remote-url https://memory.example.com
```

The installer writes a mutating worker unit with `--dryRun false`; use
`--dry-run true` for an observation-only canary. Its token environment file must
grant review and operator capabilities for every configured scope. Queue work
then appears in `/readyz` operation-worker freshness and `/metrics`. The unit
uses conservative service defaults of one due session, two candidates in that
session, and one audit job per scope per iteration. It sets the remote timeout
to 300 seconds, covering two sequential default 120-second provider calls plus
bounded overhead. If you raise the audit or job limits, scale the remote timeout
for the worst-case provider-call count and configured provider concurrency. The
unit loads a generated `0600` authority environment file after the token
environment file to force remote storage mode and the configured URL. Systemd
environment files override unit-level `Environment=` values, and later
environment files override earlier ones. The remote URL therefore stays out of
the process command line while the last-file-wins order provides the
storage-authority boundary.
Other packaged ingest watchers set `CONTEXTFORGE_REMOTE_TIMEOUT_MS=180000` by
default, which is longer than one default 120-second provider call. Override it
with `--remote-timeout-ms` or `CONTEXTFORGE_REMOTE_TIMEOUT_MS`, but keep the
remote timeout strictly greater than the full bounded provider wall-clock the
watcher can invoke, not merely one provider timeout. This prevents a client
disconnect from abandoning a provider call that the canonical server is still
completing.

The registry must cover every repo scope this worker owns. Keep a separate
distill-job worker (or an explicitly authorized all-scope operation worker) for
jobs outside that registry; otherwise expired leases outside the lifecycle
worker's fence remain visible as degraded queue readiness until their owning
worker recovers them.

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

Each of those copies is the size of the whole database, so they are pruned to
the newest `CONTEXTFORGE_MIGRATION_BACKUP_KEEP` (default `3`) once a migration
succeeds. A failed migration prunes nothing — that is the moment the backups
exist for. The newest is never removed regardless of the setting, and only
files matching the `pre-migration-v*` naming are touched, so a copy an operator
placed in the same directory is left alone.

`dbInfo` reports what remains:

```json
"migrationBackups": { "count": 2, "bytes": 765952, "keep": 3 }
```

Pruning happens during a migration, so backups already on disk stay until the
next one. Remove them by hand if they need to go sooner.

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
