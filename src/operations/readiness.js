export function buildOperationalReadiness({ snapshot, dbState, config, embeddingEnabled }) {
  const embeddingState = dbState.embeddings;
  const workerState = snapshot.queues.operationWorker;
  const workerLastActivityAgeMs = workerState.lastActivityAt
    ? Math.max(0, new Date(snapshot.observedAt).getTime() - Date.parse(workerState.lastActivityAt))
    : null;
  const workerOperations = Object.fromEntries(
    Object.entries(snapshot.queues.operationWorkers).map(([operation, state]) => {
      const required = state.queued > 0;
      const fresh =
        !required ||
        state.activeLeases > 0 ||
        state.oldestQueuedWaitMs <= config.operations.readinessWorkerStaleAfterMs ||
        (state.lastActivityAgeMs != null &&
          state.lastActivityAgeMs <= config.operations.readinessWorkerStaleAfterMs);
      return [operation, { ...state, required, ok: fresh }];
    }),
  );
  const workerRequired = Object.values(workerOperations).some((state) => state.required);
  const staleOperations = Object.entries(workerOperations)
    .filter(([, state]) => !state.ok)
    .map(([operation]) => operation);
  const workerFresh = staleOperations.length === 0;
  const distillationHealth = snapshot.providers.distillationHealth;
  const distillationHealthy =
    distillationHealth.recentFailureCount <= config.operations.readinessMaxRecentDistillFailures;
  const checks = {
    database: {
      ok:
        snapshot.database.queryOk &&
        snapshot.database.writable &&
        snapshot.database.schemaVersion === snapshot.database.supportedSchemaVersion,
      schemaVersion: snapshot.database.schemaVersion,
      supportedSchemaVersion: snapshot.database.supportedSchemaVersion,
      writable: snapshot.database.writable,
    },
    disk: {
      ok: snapshot.disk.availableBytes >= config.operations.readinessMinFreeBytes,
      availableBytes: snapshot.disk.availableBytes,
      minimumBytes: config.operations.readinessMinFreeBytes,
    },
    operationQueue: {
      ok:
        snapshot.queues.operationJobs.queued <= config.operations.readinessMaxQueuedJobs &&
        snapshot.queues.staleRunningJobs === 0,
      queued: snapshot.queues.operationJobs.queued,
      running: snapshot.queues.operationJobs.running,
      staleRunning: snapshot.queues.staleRunningJobs,
      maximumQueued: config.operations.readinessMaxQueuedJobs,
    },
    operationWorker: {
      ok: workerFresh,
      required: workerRequired,
      activeLeases: workerState.activeLeases,
      lastActivityAt: workerState.lastActivityAt,
      lastActivityAgeMs: workerLastActivityAgeMs,
      oldestQueuedWaitMs: snapshot.queues.oldestQueuedWaitMs,
      staleAfterMs: config.operations.readinessWorkerStaleAfterMs,
      reason: workerFresh ? null : 'operation_worker_stale',
      staleOperations,
      operations: workerOperations,
    },
    distillation: {
      ok: distillationHealthy,
      recentFailureCount: distillationHealth.recentFailureCount,
      maximumRecentFailures: config.operations.readinessMaxRecentDistillFailures,
      windowMs: distillationHealth.windowMs,
      windowStartedAt: distillationHealth.windowStartedAt,
      lastFailureAt: distillationHealth.lastFailureAt,
      lastFailureProvider: distillationHealth.lastFailureProvider,
      lastFailureReasonCode: distillationHealth.lastFailureReasonCode,
      lastFailureReason: distillationHealth.lastFailureReason,
      reason: distillationHealthy ? null : 'recent_distill_failures',
    },
    embeddings: {
      ok:
        !embeddingEnabled ||
        (dbState.vector.sqliteVecAvailable && snapshot.queues.embeddingJobs.failed === 0),
      enabled: embeddingEnabled,
      degraded: embeddingState.degraded,
      vectorAvailable: dbState.vector.sqliteVecAvailable,
      pending: snapshot.queues.embeddingJobs.pending,
      processing: snapshot.queues.embeddingJobs.processing,
      failed: snapshot.queues.embeddingJobs.failed,
      staleSources: embeddingState.coverage?.staleSources || 0,
    },
  };
  const ready = Object.values(checks).every((check) => check.ok);
  return {
    kind: 'contextforge_readiness',
    ready,
    status: ready ? 'ready' : 'not_ready',
    observedAt: snapshot.observedAt,
    checks,
    sqlite: snapshot.database.sqlite,
  };
}
