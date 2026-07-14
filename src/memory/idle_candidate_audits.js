import { candidateAuditSourceWatermark } from './candidate_audit_jobs.js';

function positiveInteger(value, name, max = 500) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

function nonnegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function latestIso(...values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function errorSummary(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
  };
}

export function dueDistillSessionSummary(candidate, status, idleElapsedMs) {
  return {
    scopeType: candidate.scopeType,
    scopeKey: candidate.scopeKey,
    sessionId: candidate.sessionId,
    latestCheckpointAt: candidate.latestCheckpointAt || null,
    firstRawAfterCheckpointAt: candidate.firstRawAfterCheckpointAt || null,
    latestRawAt: candidate.latestRawAt || null,
    idleElapsedMs,
    latestRunStatus: candidate.latestRunStatus || null,
    latestRunAt: candidate.latestRunAt || null,
    latestRunCompletedAt: candidate.latestRunCompletedAt || null,
    eventsSinceLastCheckpoint: status.eventsSinceLastCheckpoint,
    charsSinceLastCheckpoint: status.charsSinceLastCheckpoint,
    distillWindow: status.distillWindow,
    reasons: status.reasons,
  };
}

export function listIdleCandidateAudits({
  store,
  scope = null,
  options = {},
  defaultIdleMs = 600000,
  defaultBatchLimit = 5,
}) {
  const limit = positiveInteger(options.limit == null ? 20 : options.limit, 'limit');
  const scanLimit = positiveInteger(options.scanLimit == null ? Math.max(50, limit * 5) : options.scanLimit, 'scanLimit');
  const idleMs = nonnegativeNumber(options.idleMs == null ? defaultIdleMs : options.idleMs, 'idleMs');
  const requestedBatchLimit = options.batchLimit == null ? Math.min(10, Number(defaultBatchLimit)) : options.batchLimit;
  const batchLimit = positiveInteger(requestedBatchLimit, 'batchLimit', 10);
  const order = options.order === 'desc' ? 'desc' : 'asc';
  const asOf = new Date().toISOString();
  const nowMs = Date.parse(asOf);
  const candidates = store.listCandidateAuditSessions({
    scopeType: scope?.scopeType || null,
    scopeKey: scope?.scopeKey || null,
    limit: scanLimit,
    order,
  });
  const sessions = [];
  const skipped = [];
  for (const candidate of candidates) {
    const candidateScope = { scopeType: candidate.scopeType, scopeKey: candidate.scopeKey };
    const latestCheckpoint = store.getLatestCheckpoint({
      ...candidateScope,
      sessionId: candidate.sessionId,
      level: 0,
    });
    if (!latestCheckpoint) {
      skipped.push({ ...candidate, reason: 'missing_checkpoint' });
      continue;
    }
    const raw = store.getRawEventFingerprint({ ...candidateScope, sessionId: candidate.sessionId });
    const latestActivityAt = latestIso(raw.lastRawEventAt, candidate.latestCandidateAt, latestCheckpoint.createdAt);
    const latestActivityMs = Date.parse(latestActivityAt || '');
    const idleElapsedMs = Number.isFinite(latestActivityMs) ? Math.max(0, nowMs - latestActivityMs) : null;
    if (idleElapsedMs != null && idleElapsedMs < idleMs) {
      skipped.push({ ...candidate, latestActivityAt, idleElapsedMs, reason: 'idle_window' });
      continue;
    }
    const sourceWatermark = candidateAuditSourceWatermark({
      store,
      scope: candidateScope,
      sessionId: candidate.sessionId,
      latestCheckpoint,
    });
    sessions.push({
      ...candidate,
      latestActivityAt,
      idleElapsedMs,
      latestCheckpointId: latestCheckpoint.id,
      latestCheckpointAt: latestCheckpoint.createdAt,
      coversTo: latestCheckpoint.coversTo || null,
      selectedCandidateCount: Math.min(batchLimit, candidate.eligibleCandidateCount),
      remainingCandidateCount: Math.max(0, candidate.eligibleCandidateCount - batchLimit),
      sourceSignal: 'inferred_idle',
      trigger: 'idle_closeout',
      sourceWatermark,
    });
    if (sessions.length >= limit) break;
  }
  return {
    kind: 'idle_candidate_audit_inventory',
    scope,
    asOf,
    limit,
    scanLimit,
    idleMs,
    batchLimit,
    scanned: candidates.length,
    dueCount: sessions.length,
    skippedCount: skipped.length,
    skipReasonCounts: skipped.reduce((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1;
      return counts;
    }, {}),
    sessions,
  };
}

export async function processIdleCandidateAudits({ app, options = {} }) {
  if (!options.scope && !options.scopeType && !options.scopeKey && !options.cwd && !options.repoPath) {
    throw new Error('processDueCandidateAudits requires one explicit canonical scope.');
  }
  const limit = positiveInteger(options.limit == null ? 5 : options.limit, 'limit');
  const dryRun = truthy(options.dryRun);
  const due = app.listDueCandidateAudits({ ...options, limit });
  const result = {
    kind: 'idle_candidate_audit_batch',
    dryRun,
    asOf: due.asOf,
    limit,
    scanLimit: due.scanLimit,
    idleMs: due.idleMs,
    batchLimit: due.batchLimit,
    scanned: due.scanned,
    dueCount: due.dueCount,
    skippedCount: due.skippedCount,
    skipReasonCounts: due.skipReasonCounts,
    enqueued: 0,
    requeued: 0,
    deduplicated: 0,
    blocked: 0,
    drained: 0,
    staleEpochs: 0,
    failed: 0,
    sessions: due.sessions,
    results: [],
  };
  if (dryRun) return result;
  for (const session of due.sessions) {
    try {
      const submission = app.submitAuditJob({
        scope: session.scopeType,
        scopeKey: session.scopeKey,
        sessionId: session.sessionId,
        trigger: 'idle_closeout',
        limit: due.batchLimit,
        scanLimit: Math.min(500, Math.max(due.batchLimit, due.batchLimit * 10)),
        retryFailed: true,
        submittedBy: options.submittedBy || 'idle_candidate_audit_worker',
        _expectedSourceWatermark: session.sourceWatermark,
      });
      if (!submission.deduplicated) result.enqueued += 1;
      else if (submission.requeued) result.requeued += 1;
      else if (submission.status === 'queued') result.deduplicated += 1;
      else result.blocked += 1;
      result.results.push({
        scopeType: session.scopeType,
        scopeKey: session.scopeKey,
        sessionId: session.sessionId,
        status: submission.requeued
          ? 'requeued'
          : submission.deduplicated
            ? submission.status === 'queued' ? 'deduplicated' : `blocked_${submission.status}`
            : 'queued',
        jobId: submission.jobId,
        candidateIds: submission.selection.submittedCandidateIds,
        sourceWatermark: session.sourceWatermark,
      });
    } catch (error) {
      const staleEpoch = error?.code === 'CONTEXTFORGE_AUDIT_SOURCE_WATERMARK_CHANGED';
      const drained = error?.code === 'CONTEXTFORGE_NO_ELIGIBLE_CANDIDATES';
      if (staleEpoch) result.staleEpochs += 1;
      else if (drained) result.drained += 1;
      else result.failed += 1;
      result.results.push({
        scopeType: session.scopeType,
        scopeKey: session.scopeKey,
        sessionId: session.sessionId,
        status: staleEpoch ? 'stale_epoch' : drained ? 'drained' : 'failed',
        error: errorSummary(error),
      });
    }
  }
  return result;
}
