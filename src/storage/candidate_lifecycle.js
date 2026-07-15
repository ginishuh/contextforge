import { randomUUID } from 'node:crypto';
import { memoryCandidateRevisionHash } from '../memory/candidate_revision.js';

function nowIso() {
  return new Date().toISOString();
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function hydrateMemoryCandidateAuditAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidateId: row.candidate_id,
    operationJobId: row.operation_job_id,
    leaseAttempt: row.lease_attempt,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    sourceMode: row.source_mode,
    sourceSessionId: row.source_session_id,
    sourceCheckpointId: row.source_checkpoint_id,
    sourceWatermark: parseJson(row.source_watermark_json, null),
    contentHash: row.content_hash,
    policyVersion: row.policy_version,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    state: row.state,
    decision: row.decision,
    reason: row.reason,
    riskCodes: parseJson(row.risk_codes_json, []),
    usage: parseJson(row.usage_json, {}),
    failure: parseJson(row.failure_json, null),
    metadata: parseJson(row.metadata_json, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export function listCandidateAuditSessions(store, {
  scopeType = null,
  scopeKey = null,
  limit = 100,
  order = 'asc',
} = {}) {
  const filters = [
    "status = 'pending'",
    "audit_state IN ('unaudited', 'failed_retryable', 'legacy_unknown')",
  ];
  const values = [];
  if (scopeType) {
    filters.push('scope_type = ?');
    values.push(scopeType);
  }
  if (scopeKey) {
    filters.push('scope_key = ?');
    values.push(scopeKey);
  }
  const parsedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  return store.db.prepare(`
    SELECT scope_type, scope_key, session_id,
           COUNT(*) AS eligible_candidate_count,
           MIN(created_at) AS oldest_candidate_at,
           MAX(created_at) AS latest_candidate_at
    FROM memory_candidate_index
    WHERE ${filters.join(' AND ')}
    GROUP BY scope_type, scope_key, session_id
    ORDER BY oldest_candidate_at ${direction}, scope_type ${direction},
             scope_key ${direction}, session_id ${direction}
    LIMIT ?
  `).all(...values, parsedLimit).map((row) => ({
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    eligibleCandidateCount: Number(row.eligible_candidate_count || 0),
    oldestCandidateAt: row.oldest_candidate_at,
    latestCandidateAt: row.latest_candidate_at,
  }));
}

export function backfillMemoryCandidateAuditStateOnce(store) {
  const completed = store.db
    .prepare("SELECT value FROM schema_meta WHERE key = 'memory_candidate_audit_state_backfill_completed_at'")
    .get();
  if (completed?.value) return;
  const loadBatch = store.db.prepare(`
    SELECT * FROM memory_candidate_index
    WHERE audit_state = 'unaudited' AND id > ?
    ORDER BY id ASC LIMIT 250
  `);
  const insertAttempt = store.db.prepare(`
    INSERT OR IGNORE INTO memory_candidate_audit_attempts (
      id, candidate_id, operation_job_id, lease_attempt, scope_type, scope_key,
      source_mode, source_session_id, source_checkpoint_id, source_watermark_json,
      content_hash, policy_version, provider, model, reasoning_effort, prompt_version,
      schema_version, state, decision, reason, risk_codes_json, usage_json, failure_json,
      metadata_json, started_at, completed_at, created_at
    )
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, 'legacy.v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateCandidate = store.db.prepare(`
    UPDATE memory_candidate_index
    SET audit_state = ?, audit_decision = ?, audit_content_hash = ?, latest_audit_attempt_id = ?
    WHERE id = ? AND audit_state = 'unaudited'
  `);
  let afterId = '';
  while (true) {
    const rows = loadBatch.all(afterId);
    if (rows.length === 0) break;
    store.withTransaction(() => {
      for (const row of rows) {
        const reviewMetadata = parseJson(row.review_metadata_json, {});
        const audit = reviewMetadata.audit || reviewMetadata.autoPromotionAudit || null;
        if (!audit) {
          if (Object.keys(reviewMetadata).length > 0 || row.reviewed_at) {
            updateCandidate.run('legacy_unknown', null, null, null, row.id);
          }
          continue;
        }
        const decision = ['approve', 'needs_review', 'reject'].includes(audit.decision) ? audit.decision : null;
        const auditFailed = Array.isArray(audit.riskCodes) && audit.riskCodes.includes('audit_failed');
        const state = auditFailed ? (audit.retryable === true ? 'failed_retryable' : 'failed_terminal') : 'audited';
        const sourceModeRaw = reviewMetadata.auditMetadata?.sourceMode;
        const sourceMode = sourceModeRaw === 'backlog_batch'
          ? 'backlog_batch'
          : sourceModeRaw === 'session_pending_batch' || sourceModeRaw === 'session'
            ? 'session'
            : 'checkpoint';
        const attemptId = `legacy:${row.id}`;
        const hash = memoryCandidateRevisionHash({
          key: row.candidate_key,
          content: row.candidate_content,
          category: row.category,
          tags: parseJson(row.tags_json, []),
        });
        const metadata = audit.metadata || {};
        const completedAt = reviewMetadata.auditedAt || row.reviewed_at || row.created_at;
        insertAttempt.run(
          attemptId, row.id, row.scope_type, row.scope_key, sourceMode, row.session_id, row.checkpoint_id, hash,
          metadata.provider || 'legacy_unknown', metadata.model || null, metadata.reasoningEffort || null,
          metadata.promptVersion || null, metadata.outputSchemaVersion || metadata.schemaVersion || null,
          state, decision, audit.reason || row.review_reason || null, json(audit.riskCodes, []),
          json(metadata.usage, {}), auditFailed ? json({ retryable: audit.retryable === true }, {}) : null,
          json({ legacyBackfill: true, originalAuditMetadata: reviewMetadata.auditMetadata || null }, {}),
          completedAt, completedAt, completedAt,
        );
        updateCandidate.run(state, decision, hash, attemptId, row.id);
      }
    });
    afterId = rows.at(-1).id;
  }
  store.db.prepare(`
    INSERT INTO schema_meta (key, value)
    VALUES ('memory_candidate_audit_state_backfill_completed_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(nowIso());
}

export function markMemoryCandidateAudited(store, {
  scopeType, scopeKey, candidateId, audit, reason = null, metadata = {}, expectedStatus = 'pending',
}) {
  const existing = store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
  if (!existing) throw new Error(`Memory candidate not found: ${candidateId}`);
  if (existing.status !== expectedStatus) {
    throw new Error(`Memory candidate ${candidateId} is ${existing.status}; expected ${expectedStatus}.`);
  }
  const reviewedAt = nowIso();
  const auditMetadata = audit?.metadata || {};
  const riskCodes = Array.isArray(audit?.riskCodes) ? audit.riskCodes : [];
  const auditFailed = riskCodes.includes('audit_failed');
  const auditState = auditFailed ? (audit?.retryable === true ? 'failed_retryable' : 'failed_terminal') : 'audited';
  const auditDecision = ['approve', 'needs_review', 'reject'].includes(audit?.decision) ? audit.decision : null;
  const contentHash = memoryCandidateRevisionHash(existing.candidate);
  const sourceModeRaw = metadata.sourceMode || null;
  const sourceMode = sourceModeRaw === 'backlog_batch'
    ? 'backlog_batch'
    : sourceModeRaw === 'session' || sourceModeRaw === 'session_pending_batch'
      ? 'session'
      : sourceModeRaw === 'checkpoint' || metadata.checkpointId
        ? 'checkpoint'
        : 'session';
  const attemptId = metadata.auditAttemptId || randomUUID();
  const reviewMetadata = {
    ...(existing.reviewMetadata || {}),
    audit,
    auditMetadata: metadata,
    auditedAt: reviewedAt,
    latestAuditAttemptId: attemptId,
  };
  store.withTransaction(() => {
    store.db.prepare(`
      INSERT INTO memory_candidate_audit_attempts (
        id, candidate_id, operation_job_id, lease_attempt, scope_type, scope_key,
        source_mode, source_session_id, source_checkpoint_id, source_watermark_json,
        content_hash, policy_version, provider, model, reasoning_effort, prompt_version,
        schema_version, state, decision, reason, risk_codes_json, usage_json, failure_json,
        metadata_json, started_at, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId, candidateId, metadata.operationJobId || null, metadata.leaseAttempt ?? null, scopeType, scopeKey,
      sourceMode, metadata.sessionId || existing.sessionId || null,
      metadata.checkpointId || existing.checkpointId || null,
      metadata.sourceWatermark ? json(metadata.sourceWatermark, {}) : null, contentHash,
      metadata.policyVersion || 'candidate-audit.v1', auditMetadata.provider || 'none', auditMetadata.model || null,
      auditMetadata.reasoningEffort || null, auditMetadata.promptVersion || null,
      auditMetadata.outputSchemaVersion || auditMetadata.schemaVersion || null, auditState, auditDecision,
      reason || audit?.reason || existing.reviewReason || null, json(riskCodes, []), json(auditMetadata.usage, {}),
      auditFailed ? json({ retryable: audit?.retryable === true, errorName: auditMetadata.errorName || null }, {}) : null,
      json({ ...metadata, auditAttemptId: undefined }, {}), metadata.startedAt || reviewedAt, reviewedAt, reviewedAt,
    );
    const result = store.db.prepare(`
      UPDATE memory_candidate_index
      SET reviewed_at = ?, review_reason = ?, review_metadata_json = ?, audit_state = ?,
          audit_decision = ?, audit_content_hash = ?, latest_audit_attempt_id = ?
      WHERE scope_type = ? AND scope_key = ? AND id = ? AND status = ?
    `).run(
      reviewedAt, reason || audit?.reason || existing.reviewReason || null, json(reviewMetadata, {}),
      auditState, auditDecision, contentHash, attemptId, scopeType, scopeKey, candidateId, expectedStatus,
    );
    if (result.changes === 0) {
      throw new Error(`Memory candidate ${candidateId} changed before the audit could be committed.`);
    }
    if (metadata.operationJobId) {
      store.db.prepare(`
        UPDATE operation_job_candidates
        SET status = ?, audit_attempt_id = ?, reason = ?, updated_at = ?, completed_at = ?
        WHERE job_id = ? AND candidate_id = ?
      `).run(
        auditState === 'audited' ? 'succeeded' : auditState, attemptId, reason || audit?.reason || null,
        reviewedAt, reviewedAt, metadata.operationJobId, candidateId,
      );
    }
  });
  return store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
}

export function markMemoryCandidateReviewed(store, {
  scopeType, scopeKey, candidateId, status, reason = null, promotedMemoryId = null,
  metadata = {}, expectedStatus = 'pending', allowStatusOverride = false,
}) {
  const existing = store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
  if (!existing) throw new Error(`Memory candidate not found: ${candidateId}`);
  if (!allowStatusOverride && existing.status !== expectedStatus) {
    throw new Error(
      `Memory candidate ${candidateId} is ${existing.status}; expected ${expectedStatus}. Pass allowStatusOverride to change it anyway.`,
    );
  }
  const reviewedAt = nowIso();
  const reviewMetadata = { ...(existing.reviewMetadata || {}), ...metadata };
  const statusCondition = allowStatusOverride ? '' : 'AND status = ?';
  const statusValues = allowStatusOverride ? [] : [expectedStatus];
  const result = store.db.prepare(`
    UPDATE memory_candidate_index
    SET status = ?, reviewed_at = ?, review_reason = ?, review_metadata_json = ?, promoted_memory_id = ?
    WHERE scope_type = ? AND scope_key = ? AND id = ? ${statusCondition}
  `).run(
    status, reviewedAt, reason, json(reviewMetadata, {}), promotedMemoryId,
    scopeType, scopeKey, candidateId, ...statusValues,
  );
  if (result.changes === 0) {
    throw new Error(`Memory candidate ${candidateId} changed before the review could be committed.`);
  }
  return store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
}

export function markMemoryCandidatePromotionRouted(store, {
  scopeType, scopeKey, candidateId, expectedAuditContentHash, expectedAuditAttemptId, routing,
}) {
  const existing = store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
  if (!existing) throw new Error(`Memory candidate not found: ${candidateId}`);
  if (existing.status !== 'pending' || existing.auditState !== 'audited' || existing.auditDecision !== 'approve') {
    throw new Error(`Memory candidate ${candidateId} is not an audited approved pending candidate.`);
  }
  if (!expectedAuditContentHash || existing.auditContentHash !== expectedAuditContentHash) {
    throw new Error(`Memory candidate ${candidateId} audit revision changed before routing.`);
  }
  if (!expectedAuditAttemptId || existing.latestAuditAttemptId !== expectedAuditAttemptId) {
    throw new Error(`Memory candidate ${candidateId} audit attempt changed before routing.`);
  }
  const routedAt = nowIso();
  const reviewMetadata = {
    ...(existing.reviewMetadata || {}),
    promotionRouting: {
      ...routing,
      routedAt,
      auditContentHash: expectedAuditContentHash,
      auditAttemptId: expectedAuditAttemptId,
    },
  };
  const result = store.db.prepare(`
    UPDATE memory_candidate_index SET review_metadata_json = ?
    WHERE scope_type = ? AND scope_key = ? AND id = ?
      AND status = 'pending' AND audit_state = 'audited' AND audit_decision = 'approve'
      AND audit_content_hash = ? AND latest_audit_attempt_id = ?
  `).run(
    json(reviewMetadata, {}), scopeType, scopeKey, candidateId,
    expectedAuditContentHash, expectedAuditAttemptId,
  );
  if (result.changes === 0) {
    throw new Error(`Memory candidate ${candidateId} changed before promotion routing could be committed.`);
  }
  return store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
}

function candidateSummaryFilters({
  scopeType, scopeKey, sessionId = null, checkpointId = null, status = null,
  candidateType = null, promotionRecommendation = null, auditState = null,
  auditDecision = null, category = null, sourceAgent = null,
}) {
  const conditions = ['memory_candidate_index.scope_type = ?', 'memory_candidate_index.scope_key = ?'];
  const values = [scopeType, scopeKey];
  const filters = [
    ['sessionId', sessionId, 'memory_candidate_index.session_id = ?'],
    ['checkpointId', checkpointId, 'memory_candidate_index.checkpoint_id = ?'],
    ['status', status, 'memory_candidate_index.status = ?'],
    ['candidateType', candidateType, 'memory_candidate_index.candidate_type = ?'],
    ['promotionRecommendation', promotionRecommendation, 'memory_candidate_index.promotion_recommendation = ?'],
    ['auditState', auditState, 'memory_candidate_index.audit_state = ?'],
    ['auditDecision', auditDecision, 'memory_candidate_index.audit_decision = ?'],
    ['category', category, 'memory_candidate_index.category = ?'],
    ['sourceAgent', sourceAgent, "json_extract(checkpoints.metadata_json, '$.sourceProvenance.sourceAgent') = ?"],
  ];
  const applied = {};
  for (const [name, value, condition] of filters) {
    if (!value) continue;
    conditions.push(condition);
    values.push(value);
    applied[name] = value;
  }
  return { conditions, values, applied };
}

export function memoryLifecycleSummary(store, options) {
  const { scopeType, scopeKey, sinceIso } = options;
  const filtered = candidateSummaryFilters(options);
  const where = filtered.conditions.join(' AND ');
  const rows = store.db.prepare(`
    SELECT memory_candidate_index.status, memory_candidate_index.audit_state,
           memory_candidate_index.audit_decision, memory_candidate_index.promotion_recommendation,
           COUNT(*) AS count, MAX(memory_candidate_index.created_at) AS latest_created_at,
           MAX(memory_candidate_index.reviewed_at) AS latest_reviewed_at
    FROM memory_candidate_index
    JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
    WHERE ${where}
    GROUP BY memory_candidate_index.status, memory_candidate_index.audit_state,
             memory_candidate_index.audit_decision, memory_candidate_index.promotion_recommendation
  `).all(...filtered.values);
  const recentCandidates = store.db.prepare(`
    SELECT COUNT(*) AS count FROM memory_candidate_index
    JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
    WHERE ${where} AND memory_candidate_index.created_at >= ?
  `).get(...filtered.values, sinceIso).count;
  const recentPromoted = store.db.prepare(`
    SELECT COUNT(*) AS count FROM memories WHERE scope_type = ? AND scope_key = ? AND created_at >= ?
  `).get(scopeType, scopeKey, sinceIso).count;
  const latestMemory = store.db.prepare(`
    SELECT MAX(created_at) AS value FROM memories WHERE scope_type = ? AND scope_key = ?
  `).get(scopeType, scopeKey)?.value || null;
  const oldestPending = store.db.prepare(`
    SELECT MIN(memory_candidate_index.created_at) AS value FROM memory_candidate_index
    JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
    WHERE ${where} AND memory_candidate_index.status = 'pending'
  `).get(...filtered.values)?.value || null;
  const latestAudit = store.db.prepare(`
    SELECT MAX(memory_candidate_audit_attempts.completed_at) AS value
    FROM memory_candidate_audit_attempts
    JOIN memory_candidate_index ON memory_candidate_index.id = memory_candidate_audit_attempts.candidate_id
    JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
    WHERE ${where}
  `).get(...filtered.values)?.value || null;
  const summary = {
    latestCandidateAt: null, latestCandidateReviewedAt: null, latestPromotedAt: latestMemory,
    latestAuditedAt: latestAudit, oldestPendingAt: oldestPending, pendingCandidateCount: 0,
    pendingReviewCount: 0, candidatesLast7d: Number(recentCandidates || 0),
    promotedLast7d: Number(recentPromoted || 0), filteredCandidateCount: 0,
    approvedAwaitingPromotionCount: 0, pendingNeedsReviewCount: 0,
    pendingRejectRecommendedCount: 0, filters: filtered.applied,
    byStatus: {}, byRecommendation: {}, byAuditState: {}, byAuditDecision: {},
  };
  for (const row of rows) {
    const status = row.status || 'unknown';
    const recommendation = row.promotion_recommendation || 'none';
    const auditState = row.audit_state || 'unaudited';
    const auditDecision = row.audit_decision || 'none';
    const count = Number(row.count || 0);
    summary.filteredCandidateCount += count;
    summary.byStatus[status] = (summary.byStatus[status] || 0) + count;
    summary.byRecommendation[recommendation] = (summary.byRecommendation[recommendation] || 0) + count;
    summary.byAuditState[auditState] = (summary.byAuditState[auditState] || 0) + count;
    summary.byAuditDecision[auditDecision] = (summary.byAuditDecision[auditDecision] || 0) + count;
    if (status === 'pending') {
      summary.pendingCandidateCount += count;
      if (recommendation === 'review') summary.pendingReviewCount += count;
      if (auditState === 'audited' && auditDecision === 'approve') summary.approvedAwaitingPromotionCount += count;
      if (auditState === 'audited' && auditDecision === 'needs_review') summary.pendingNeedsReviewCount += count;
      if (auditState === 'audited' && auditDecision === 'reject') summary.pendingRejectRecommendedCount += count;
    }
    if (!summary.latestCandidateAt || row.latest_created_at > summary.latestCandidateAt) {
      summary.latestCandidateAt = row.latest_created_at || summary.latestCandidateAt;
    }
    if (!summary.latestCandidateReviewedAt || row.latest_reviewed_at > summary.latestCandidateReviewedAt) {
      summary.latestCandidateReviewedAt = row.latest_reviewed_at || summary.latestCandidateReviewedAt;
    }
  }
  return summary;
}

export function markMemoryCandidateTriagedNoAudit(store, {
  scopeType, scopeKey, candidateId, reason, metadata = {}, leaseOwner = null, leaseAttempt = null,
}) {
  return store.withTransaction(() => {
    if (metadata.operationJobId && leaseOwner && leaseAttempt != null) {
      store.assertOperationJobLease({ jobId: metadata.operationJobId, workerId: leaseOwner, attempt: leaseAttempt });
    }
    const existing = store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
    if (!existing) throw new Error(`Memory candidate not found: ${candidateId}`);
    const reviewedAt = nowIso();
    const reviewMetadata = { ...(existing.reviewMetadata || {}), triage: { reason, ...metadata, triagedAt: reviewedAt } };
    const result = store.db.prepare(`
      UPDATE memory_candidate_index
      SET audit_state = 'triaged_no_audit', reviewed_at = ?, review_reason = ?, review_metadata_json = ?
      WHERE scope_type = ? AND scope_key = ? AND id = ? AND status = 'pending'
    `).run(reviewedAt, reason, json(reviewMetadata, {}), scopeType, scopeKey, candidateId);
    if (result.changes === 0) throw new Error(`Memory candidate ${candidateId} changed before triage could be committed.`);
    if (metadata.operationJobId) {
      markOperationJobCandidateSkipped(store, { jobId: metadata.operationJobId, candidateId, reason, metadata });
    }
    return store.getMemoryCandidate({ scopeType, scopeKey, candidateId });
  });
}

export function listMemoryCandidateAuditAttempts(store, { scopeType, scopeKey, candidateId, limit = 100 }) {
  return store.db.prepare(`
    SELECT * FROM memory_candidate_audit_attempts
    WHERE scope_type = ? AND scope_key = ? AND candidate_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(scopeType, scopeKey, candidateId, Math.min(500, Math.max(1, Number(limit) || 100)))
    .map(hydrateMemoryCandidateAuditAttempt);
}

function hydrateJobCandidate(row) {
  return {
    jobId: row.job_id, candidateId: row.candidate_id, position: row.position, status: row.status,
    attempt: row.attempt, auditAttemptId: row.audit_attempt_id, reason: row.reason,
    metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function registerOperationJobCandidates(store, {
  jobId, candidateIds, force = false, leaseOwner = null, leaseAttempt = null,
}) {
  const ids = Array.from(new Set((candidateIds || []).map(String)));
  if (ids.length === 0) return [];
  if (ids.length > 500) throw new Error('candidateIds supports at most 500 items.');
  const timestamp = nowIso();
  store.withTransaction(() => {
    if (leaseOwner && leaseAttempt != null) {
      store.assertOperationJobLease({ jobId, workerId: leaseOwner, attempt: leaseAttempt });
    }
    const insert = store.db.prepare(`
      INSERT INTO operation_job_candidates (job_id, candidate_id, position, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', '{}', ?, ?) ON CONFLICT(job_id, candidate_id) DO NOTHING
    `);
    for (const [position, candidateId] of ids.entries()) insert.run(jobId, candidateId, position, timestamp, timestamp);
    const forceClause = force ? '' : "AND audit_state IN ('unaudited', 'failed_retryable', 'legacy_unknown')";
    store.db.prepare(`
      UPDATE memory_candidate_index SET audit_state = 'queued'
      WHERE status = 'pending' ${forceClause} AND id IN (${ids.map(() => '?').join(', ')})
    `).run(...ids);
  });
  return listOperationJobCandidates(store, { jobId });
}

export function listOperationJobCandidates(store, { jobId, status = null }) {
  const filters = ['job_id = ?'];
  const values = [jobId];
  if (status) { filters.push('status = ?'); values.push(status); }
  return store.db.prepare(`
    SELECT * FROM operation_job_candidates WHERE ${filters.join(' AND ')}
    ORDER BY position ASC, candidate_id ASC
  `).all(...values).map(hydrateJobCandidate);
}

export function settleOperationJobCandidates(store, { jobId, status, reason }) {
  const timestamp = nowIso();
  const auditState = status === 'queued' ? 'failed_retryable' : status === 'cancelled' ? 'unaudited' : 'failed_terminal';
  const jobStatus = status === 'queued' ? 'failed_retryable' : status === 'cancelled' ? 'skipped' : 'failed_terminal';
  store.withTransaction(() => {
    store.db.prepare(`
      UPDATE operation_job_candidates SET status = ?, reason = ?, updated_at = ?, completed_at = ?
      WHERE job_id = ? AND status IN ('queued', 'running', 'failed_retryable')
    `).run(jobStatus, reason, timestamp, status === 'queued' ? null : timestamp, jobId);
    store.db.prepare(`
      UPDATE memory_candidate_index SET audit_state = ?
      WHERE status = 'pending' AND audit_state IN ('queued', 'running', 'failed_retryable')
        AND id IN (SELECT candidate_id FROM operation_job_candidates WHERE job_id = ?)
    `).run(auditState, jobId);
  });
}

export function startOperationJobCandidate(store, {
  jobId, candidateId, attempt, leaseOwner = null, leaseAttempt = null,
}) {
  const timestamp = nowIso();
  return store.withTransaction(() => {
    if (leaseOwner && leaseAttempt != null) {
      store.assertOperationJobLease({ jobId, workerId: leaseOwner, attempt: leaseAttempt });
    }
    const result = store.db.prepare(`
      UPDATE operation_job_candidates SET status = 'running', attempt = ?, updated_at = ?, completed_at = NULL
      WHERE job_id = ? AND candidate_id = ? AND status IN ('queued', 'failed_retryable', 'running')
    `).run(Number(attempt || 0), timestamp, jobId, candidateId);
    if (result.changes > 0) {
      store.db.prepare("UPDATE memory_candidate_index SET audit_state = 'running' WHERE id = ? AND status = 'pending'")
        .run(candidateId);
    }
    return result.changes > 0;
  });
}

export function markOperationJobCandidateSkipped(store, {
  jobId, candidateId, reason, metadata = {}, candidateAuditState = null,
}) {
  const timestamp = nowIso();
  store.db.prepare(`
    UPDATE operation_job_candidates
    SET status = 'skipped', reason = ?, metadata_json = ?, updated_at = ?, completed_at = ?
    WHERE job_id = ? AND candidate_id = ? AND status != 'succeeded'
  `).run(reason, json(metadata, {}), timestamp, timestamp, jobId, candidateId);
  if (candidateAuditState) {
    store.db.prepare('UPDATE memory_candidate_index SET audit_state = ? WHERE id = ? AND status = \'pending\'')
      .run(candidateAuditState, candidateId);
  }
}
