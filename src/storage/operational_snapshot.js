import fs from 'node:fs';

export function buildOperationalSnapshot(store, { now = new Date(), supportedSchemaVersion } = {}) {
  const nowIsoText = now.toISOString();
  const operationJobs = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of store.db.prepare('SELECT status, COUNT(*) AS count FROM operation_jobs GROUP BY status').all()) {
    operationJobs[row.status] = row.count;
  }
  const oldestQueuedAt = store.db
    .prepare("SELECT MIN(created_at) AS value FROM operation_jobs WHERE status = 'queued'")
    .get().value;
  const staleRunningJobs = store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM operation_jobs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
    )
    .get(nowIsoText).count;
  const operationWorker = store.db
    .prepare(
      `SELECT MAX(worker_observed_at) AS last_activity_at,
              MAX(started_at) AS last_started_at,
              MAX(completed_at) AS last_completed_at,
              COALESCE(SUM(CASE
                WHEN status = 'running' AND lease_expires_at > ? THEN 1 ELSE 0
              END), 0) AS active_leases
       FROM operation_jobs`,
    )
    .get(nowIsoText);
  const operationWorkers = Object.fromEntries(store.db.prepare(`
    SELECT operation,
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest_queued_at,
           MAX(worker_observed_at) AS last_activity_at,
           COALESCE(SUM(CASE
             WHEN status = 'running' AND lease_expires_at > ? THEN 1 ELSE 0
           END), 0) AS active_leases
    FROM operation_jobs
    GROUP BY operation
    ORDER BY operation ASC
  `).all(nowIsoText).map((row) => [row.operation, {
    queued: Number(row.queued || 0),
    oldestQueuedAt: row.oldest_queued_at || null,
    oldestQueuedWaitMs: row.oldest_queued_at
      ? Math.max(0, now.getTime() - Date.parse(row.oldest_queued_at))
      : 0,
    activeLeases: Number(row.active_leases || 0),
    lastActivityAt: row.last_activity_at || null,
    lastActivityAgeMs: row.last_activity_at
      ? Math.max(0, now.getTime() - Date.parse(row.last_activity_at))
      : null,
  }]));
  const distill = store.db
    .prepare(
      `SELECT provider, status, COUNT(*) AS count,
                AVG(CASE WHEN completed_at IS NOT NULL
                    THEN (julianday(completed_at) - julianday(created_at)) * 86400000
                    ELSE NULL END) AS average_elapsed_ms
       FROM distill_runs GROUP BY provider, status`,
    )
    .all()
    .map((row) => ({
      provider: row.provider,
      status: row.status,
      count: row.count,
      averageElapsedMs: row.average_elapsed_ms,
    }));
  const usage = store.db
    .prepare(
      `SELECT COUNT(*) AS events,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failures,
              AVG(elapsed_ms) AS average_elapsed_ms
       FROM llm_usage_events`,
    )
    .get();
  const usageByOperation = store.db
    .prepare(
      `SELECT operation, status, COUNT(*) AS events,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              AVG(elapsed_ms) AS average_elapsed_ms
       FROM llm_usage_events
       GROUP BY operation, status
       ORDER BY operation ASC, status ASC`,
    )
    .all()
    .map((row) => ({
      operation: row.operation,
      status: row.status,
      events: row.events,
      totalTokens: row.total_tokens,
      averageElapsedMs: row.average_elapsed_ms,
    }));
  const providerTimeouts = store.db
    .prepare(
      `SELECT COUNT(*) AS count FROM distill_runs
       WHERE status = 'failed'
         AND (lower(error_message) LIKE '%timeout%' OR lower(error_message) LIKE '%timed out%')`,
    )
    .get().count;
  const disk = fs.statfsSync(store.dataDir);
  let writable = true;
  try {
    fs.accessSync(store.dataDir, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(store.dbPath, fs.constants.R_OK | fs.constants.W_OK);
    writable = Number(store.db.pragma('query_only', { simple: true })) === 0;
  } catch {
    writable = false;
  }
  return {
    observedAt: nowIsoText,
    database: {
      queryOk: store.db.prepare('SELECT 1 AS ok').get().ok === 1,
      writable,
      schemaVersion: Number(store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value),
      supportedSchemaVersion,
      sqlite: store.sqlitePolicy(),
    },
    disk: {
      availableBytes: Number(disk.bavail) * Number(disk.bsize),
      totalBytes: Number(disk.blocks) * Number(disk.bsize),
    },
    queues: {
      operationJobs,
      oldestQueuedAt: oldestQueuedAt || null,
      oldestQueuedWaitMs: oldestQueuedAt ? Math.max(0, now.getTime() - Date.parse(oldestQueuedAt)) : 0,
      staleRunningJobs,
      operationWorker: {
        activeLeases: Number(operationWorker.active_leases || 0),
        lastActivityAt: operationWorker.last_activity_at || null,
        lastActivityAgeMs: operationWorker.last_activity_at
          ? Math.max(0, now.getTime() - Date.parse(operationWorker.last_activity_at))
          : null,
        lastStartedAt: operationWorker.last_started_at || null,
        lastCompletedAt: operationWorker.last_completed_at || null,
      },
      operationWorkers,
      embeddingJobs: store.countEmbeddingJobs(),
    },
    providers: {
      distill,
      usage: {
        events: usage.events,
        totalTokens: usage.total_tokens,
        failures: usage.failures,
        averageElapsedMs: usage.average_elapsed_ms,
        byOperation: usageByOperation,
        timeouts: providerTimeouts,
      },
    },
  };
}
