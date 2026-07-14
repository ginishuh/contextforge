import { createHash } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function idempotencyKey(identity) {
  return `audit_memory_candidates:${createHash('sha256').update(JSON.stringify(stable(identity))).digest('hex')}`;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

export function candidateAuditSourceWatermark({ store, scope, sessionId, checkpoint = null, latestCheckpoint = null }) {
  if (checkpoint) {
    return {
      version: 'candidate-audit-source.v1',
      checkpointId: checkpoint.id,
      coversTo: checkpoint.coversTo || null,
    };
  }
  const currentCheckpoint = latestCheckpoint || store.getLatestCheckpoint({ ...scope, sessionId, level: 0 });
  const raw = store.getRawEventFingerprint({ ...scope, sessionId });
  return {
    version: 'candidate-audit-source.v1',
    rawEventFingerprint: raw.fingerprint,
    rawEventCount: raw.rawEventCount,
    lastRawEventId: raw.lastRawEventId,
    lastRawEventAt: raw.lastRawEventAt,
    checkpointId: currentCheckpoint?.id || null,
    coversTo: currentCheckpoint?.coversTo || null,
  };
}

function assertExpectedSourceWatermark(expected, actual) {
  if (!expected || JSON.stringify(stable(expected)) === JSON.stringify(stable(actual))) return;
  const error = new Error('The candidate audit source changed after the idle epoch was selected.');
  error.name = 'CandidateAuditSourceWatermarkChangedError';
  error.code = 'CONTEXTFORGE_AUDIT_SOURCE_WATERMARK_CHANGED';
  error.expectedSourceWatermark = expected;
  error.currentSourceWatermark = actual;
  throw error;
}

function publicPayload(options, scope) {
  const keys = [
    'sessionId', 'checkpointId', 'trigger', 'limit', 'scanLimit', 'minConfidence', 'minStability',
    'allowedCategories', 'promotionRecommendation', 'force', 'candidateIds',
  ];
  return {
    ...Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]])),
    scope: scope.scopeType,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
  };
}

function submitMemoryCandidateAuditJobInTransaction({ store, scope, options, auditor }) {
  const requestedIds = Array.isArray(options.candidateIds)
    ? Array.from(new Set(options.candidateIds.map(String)))
    : [];
  if (!options.sessionId && !options.checkpointId && requestedIds.length === 0) {
    throw new Error('submitAuditJob requires sessionId, checkpointId, or an explicit candidateIds backlog batch.');
  }
  if (requestedIds.length > 10) throw new Error('candidateIds backlog batches support at most 10 candidates.');
  if (requestedIds.length > 0 && (options.sessionId || options.checkpointId)) {
    throw new Error('candidateIds backlog batches cannot be combined with sessionId or checkpointId.');
  }
  const requestedLimit = Math.min(10, positiveInteger(options.limit == null ? 3 : options.limit, 'limit'));
  const scanLimit = Math.max(requestedLimit, positiveInteger(options.scanLimit == null ? 50 : options.scanLimit, 'scanLimit'));
  const payload = publicPayload(options, scope);
  let checkpoint = null;
  if (options.checkpointId) {
    checkpoint = store.getCheckpointById({ ...scope, checkpointId: options.checkpointId });
    if (!checkpoint) throw new Error(`Checkpoint not found: ${options.checkpointId}`);
    if (options.sessionId && checkpoint.sessionId !== options.sessionId) {
      throw new Error('sessionId does not match the supplied checkpointId.');
    }
    payload.sessionId = checkpoint.sessionId;
    payload.checkpointId = checkpoint.id;
  }
  const sourceMode = requestedIds.length > 0 ? 'backlog_batch' : checkpoint ? 'checkpoint' : 'session';
  const sourceWatermark = sourceMode === 'backlog_batch'
    ? null
    : candidateAuditSourceWatermark({ store, scope, sessionId: checkpoint?.sessionId || options.sessionId, checkpoint });
  assertExpectedSourceWatermark(options._expectedSourceWatermark, sourceWatermark);
  const scanned = requestedIds.length > 0
    ? store.listMemoryCandidates({ ...scope, status: 'pending', candidateIds: requestedIds, limit: requestedIds.length })
    : store.listMemoryCandidates({
        ...scope,
        sessionId: checkpoint ? null : options.sessionId,
        checkpointId: checkpoint?.id || null,
        status: 'pending',
        sort: 'recommendation',
        limit: scanLimit,
      });
  if (requestedIds.length > 0 && scanned.length !== requestedIds.length) {
    throw new Error('Every candidateIds item must identify a pending candidate in the requested canonical scope.');
  }
  const candidates = scanned.filter((candidate) =>
    truthy(options.force) || ['unaudited', 'failed_retryable', 'legacy_unknown'].includes(candidate.auditState),
  ).slice(0, requestedLimit);
  if (candidates.length === 0) {
    const error = new Error('No eligible pending memory candidates matched the requested audit source.');
    error.code = 'CONTEXTFORGE_NO_ELIGIBLE_CANDIDATES';
    throw error;
  }
  const configuration = {
    provider: auditor?.metadata?.provider || 'none',
    model: auditor?.metadata?.model || null,
    reasoningEffort: auditor?.metadata?.reasoningEffort || null,
    promptVersion: auditor?.metadata?.promptVersion || null,
    outputSchemaVersion: auditor?.metadata?.outputSchemaVersion || null,
  };
  payload.sourceMode = sourceMode;
  payload.sourceWatermark = sourceWatermark;
  payload.candidateIds = candidates.map((candidate) => candidate.id);
  payload.limit = candidates.length;
  payload.scanLimit = candidates.length;
  payload.expectedAuditConfiguration = configuration;
  const sourceFingerprint = { sourceMode, sourceWatermark, candidateIds: payload.candidateIds };
  const { scope: _scope, scopeType: _scopeType, scopeKey: _scopeKey, sessionId: _sessionId,
    checkpointId: _checkpointId, sourceWatermark: _sourceWatermark, ...policy } = payload;
  const source = sourceMode === 'backlog_batch'
    ? { sourceMode, candidateIds: payload.candidateIds }
    : checkpoint
      ? { sourceMode, checkpointId: checkpoint.id }
      : { sourceMode, sessionId: options.sessionId };
  const jobKey = options.idempotencyKey
    ? idempotencyKey({ scope, providedKey: options.idempotencyKey })
    : idempotencyKey({ scope, source, sourceFingerprint, policy });
  const maxAttempts = positiveInteger(options.maxAttempts == null ? 3 : options.maxAttempts, 'maxAttempts');
  const priority = Number(options.priority || 0);
  if (!Number.isInteger(priority)) throw new Error('priority must be an integer.');
  const queued = store.enqueueOperationJob({
    operation: 'audit_memory_candidates',
    ...scope,
    sessionId: checkpoint?.sessionId || options.sessionId || null,
    checkpointId: checkpoint?.id || null,
    idempotencyKey: jobKey,
    payload,
    maxAttempts,
    priority,
    retryFailed: truthy(options.retryFailed),
    metadata: {
      submittedBy: options.submittedBy || 'api',
      requestId: options.requestId || null,
      authTokenId: options.authTokenId || null,
      authKind: options.authKind || null,
      sourceFingerprint,
      executionMode: 'durable_worker',
      providerBatchMode: 'per_candidate',
      requestedAuditConfiguration: configuration,
    },
  });
  const registeredCandidateIds = queued.deduplicated
    ? queued.job.payload?.candidateIds || []
    : payload.candidateIds;
  const jobCandidates = store.registerOperationJobCandidates({
    jobId: queued.job.id,
    candidateIds: registeredCandidateIds,
    force: truthy(options.force),
  });
  const submittedCandidateIds = registeredCandidateIds;
  const submittedIds = new Set(submittedCandidateIds);
  const skippedCandidates = scanned
    .filter((candidate) => !submittedIds.has(candidate.id))
    .map((candidate) => ({
      candidateId: candidate.id,
      auditState: candidate.auditState,
      reason: queued.deduplicated
        ? 'deduplicated_job_selection'
        : truthy(options.force) || ['unaudited', 'failed_retryable', 'legacy_unknown'].includes(candidate.auditState)
          ? 'batch_limit'
          : 'audit_state_ineligible',
    }));
  return {
    kind: 'operation_job_submission',
    operation: 'audit_memory_candidates',
    jobId: queued.job.id,
    status: queued.job.status,
    deduplicated: queued.deduplicated,
    requeued: queued.requeued,
    selection: {
      requestedCandidateIds: requestedIds,
      submittedCandidateIds,
      skippedCandidates,
    },
    job: { ...queued.job, candidates: jobCandidates },
  };
}

export function submitMemoryCandidateAuditJob(args) {
  return args.store.withTransaction(() => submitMemoryCandidateAuditJobInTransaction(args));
}
