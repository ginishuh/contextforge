import { randomUUID } from 'node:crypto';
import { normalizeScopeOptions } from '../scopes/index.js';

const ACTIVE_AUDIT_STATES = new Set(['queued', 'running']);
const POLICY_VERSION = 'candidate-sla.v1';
const SLA_ANCHOR_SQL = `CASE
  WHEN json_extract(review_metadata_json, '$.candidateSlaAnchorAt') > COALESCE(reviewed_at, created_at)
    THEN json_extract(review_metadata_json, '$.candidateSlaAnchorAt')
  ELSE COALESCE(reviewed_at, created_at)
END`;

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function boundedLimit(value, fallback = 50, max = 500) {
  const parsed = Number(value == null ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`limit must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lifecycleMetadata(candidate, event) {
  const existing = Array.isArray(candidate.reviewMetadata?.lifecycleEvents)
    ? candidate.reviewMetadata.lifecycleEvents
    : [];
  return {
    ...(candidate.reviewMetadata || {}),
    lifecycleEvents: [...existing, { id: randomUUID(), ...event }],
  };
}

function candidateQueue(candidate) {
  if (candidate.auditState === 'audited') {
    if (candidate.auditDecision === 'approve') return 'approvedAwaitingPromotion';
    if (candidate.auditDecision === 'needs_review') return 'needsReview';
    if (candidate.auditDecision === 'reject') return 'rejectRecommended';
    return 'auditedUnknown';
  }
  if (candidate.auditState === 'triaged_no_audit') return 'triagedNoAudit';
  if (candidate.auditState === 'failed_retryable') return 'failedRetryable';
  if (candidate.auditState === 'failed_terminal') return 'failedTerminal';
  if (candidate.auditState === 'legacy_unknown') return 'legacyUnknown';
  return 'unaudited';
}

function policyEntries(policy, asOfMs) {
  const definitions = [
    ['unaudited', "audit_state = 'unaudited'", policy.unauditedMs],
    ['triagedNoAudit', "audit_state = 'triaged_no_audit'", policy.triagedNoAuditMs],
    ['failedRetryable', "audit_state = 'failed_retryable'", policy.failedRetryableMs],
    ['failedTerminal', "audit_state = 'failed_terminal'", policy.failedTerminalMs],
    ['legacyUnknown', "audit_state = 'legacy_unknown'", policy.legacyUnknownMs],
    ['approvedAwaitingPromotion', "audit_state = 'audited' AND audit_decision = 'approve'", policy.approvedAwaitingPromotionMs],
    ['needsReview', "audit_state = 'audited' AND audit_decision = 'needs_review'", policy.needsReviewMs],
    ['rejectRecommended', "audit_state = 'audited' AND audit_decision = 'reject'", policy.rejectRecommendedMs],
    ['auditedUnknown', "audit_state = 'audited' AND audit_decision IS NULL", policy.auditedUnknownMs],
  ];
  return definitions.map(([queue, sql, slaMs]) => ({
    queue,
    sql,
    slaMs,
    cutoff: new Date(asOfMs - slaMs).toISOString(),
  }));
}

function expectedAnchor(candidate) {
  return [candidate.createdAt, candidate.reviewedAt, candidate.reviewMetadata?.candidateSlaAnchorAt]
    .filter(Boolean)
    .sort()
    .at(-1);
}

export function listDueCandidateStaleTransitions(store, scope, options = {}, policy) {
  const limit = boundedLimit(options.limit);
  const order = options.order === 'desc' ? 'DESC' : 'ASC';
  const asOf = new Date().toISOString();
  const asOfMs = Date.parse(asOf);
  const entries = policyEntries(policy, asOfMs);
  const dueSql = entries
    .map((entry) => `((${entry.sql}) AND ${SLA_ANCHOR_SQL} <= ?)`)
    .join(' OR ');
  const cutoffs = entries.map((entry) => entry.cutoff);
  const baseValues = [scope.scopeType, scope.scopeKey, ...cutoffs];
  const count = Number(store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_candidate_index
    WHERE scope_type = ? AND scope_key = ? AND status = 'pending'
      AND audit_state NOT IN ('queued', 'running') AND (${dueSql})
  `).get(...baseValues)?.count || 0);
  const rows = store.db.prepare(`
    SELECT id
    FROM memory_candidate_index
    WHERE scope_type = ? AND scope_key = ? AND status = 'pending'
      AND audit_state NOT IN ('queued', 'running') AND (${dueSql})
    ORDER BY ${SLA_ANCHOR_SQL} ${order}, id ${order}
    LIMIT ?
  `).all(...baseValues, limit);
  const candidates = rows.map((row) => {
    const candidate = store.getMemoryCandidate({ ...scope, candidateId: row.id });
    const queue = candidateQueue(candidate);
    const anchorAt = expectedAnchor(candidate);
    const slaMs = policy[`${queue}Ms`];
    return {
      candidate,
      queue,
      anchorAt,
      ageMs: Math.max(0, asOfMs - Date.parse(anchorAt)),
      slaMs,
      policyVersion: policy.version || POLICY_VERSION,
    };
  });
  return {
    kind: 'due_memory_candidate_stale_transitions',
    scope,
    asOf,
    limit,
    totalDueCount: count,
    dueCount: candidates.length,
    remainingCount: Math.max(0, count - candidates.length),
    policy: { ...policy },
    candidates,
  };
}

export function staleCandidate(store, scope, options = {}) {
  if (!options.candidateId) throw new Error('candidateId is required.');
  if (!options.reason) throw new Error('reason is required.');
  if (!options.actor) throw new Error('actor is required.');
  return store.withTransaction(() => {
    const candidate = store.getMemoryCandidate({ ...scope, candidateId: options.candidateId });
    if (!candidate) throw new Error(`Memory candidate not found: ${options.candidateId}`);
    if (candidate.status !== 'pending') {
      throw codedError(`Memory candidate ${candidate.id} is ${candidate.status}; expected pending.`, 'CONTEXTFORGE_CANDIDATE_NOT_PENDING');
    }
    if (ACTIVE_AUDIT_STATES.has(candidate.auditState)) {
      throw codedError(`Memory candidate ${candidate.id} has an active ${candidate.auditState} audit.`, 'CONTEXTFORGE_CANDIDATE_AUDIT_ACTIVE');
    }
    const queue = candidateQueue(candidate);
    const anchorAt = expectedAnchor(candidate);
    if (options.expectedQueue && options.expectedQueue !== queue) {
      throw codedError(`Memory candidate ${candidate.id} SLA queue changed.`, 'CONTEXTFORGE_CANDIDATE_SLA_EPOCH_CHANGED');
    }
    if (options.expectedAnchorAt && options.expectedAnchorAt !== anchorAt) {
      throw codedError(`Memory candidate ${candidate.id} SLA anchor changed.`, 'CONTEXTFORGE_CANDIDATE_SLA_EPOCH_CHANGED');
    }
    const at = new Date().toISOString();
    const metadata = lifecycleMetadata(candidate, {
      type: 'staled',
      fromStatus: 'pending',
      toStatus: 'stale',
      at,
      actor: options.actor,
      reason: options.reason,
      queue,
      anchorAt,
      ageMs: options.ageMs ?? null,
      slaMs: options.slaMs ?? null,
      policyVersion: options.policyVersion || POLICY_VERSION,
      requestId: options.requestId || null,
    });
    const updated = store.db.prepare(`
      UPDATE memory_candidate_index
      SET status = 'stale', review_metadata_json = ?
      WHERE scope_type = ? AND scope_key = ? AND id = ? AND status = 'pending'
        AND audit_state = ? AND COALESCE(audit_decision, '') = ?
        AND ${SLA_ANCHOR_SQL} = ?
        AND audit_state NOT IN ('queued', 'running')
    `).run(
      JSON.stringify(metadata), scope.scopeType, scope.scopeKey, candidate.id,
      candidate.auditState, candidate.auditDecision || '', anchorAt,
    );
    if (updated.changes !== 1) {
      throw codedError(`Memory candidate ${candidate.id} changed before stale transition committed.`, 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE');
    }
    return {
      kind: 'memory_candidate_stale_transition',
      candidate: store.getMemoryCandidate({ ...scope, candidateId: candidate.id }),
    };
  });
}

export function reopenStaleCandidate(store, scope, options = {}) {
  if (!options.candidateId) throw new Error('candidateId is required.');
  if (!options.reason) throw new Error('reason is required.');
  if (!options.actor) throw new Error('actor is required.');
  return store.withTransaction(() => {
    const candidate = store.getMemoryCandidate({ ...scope, candidateId: options.candidateId });
    if (!candidate) throw new Error(`Memory candidate not found: ${options.candidateId}`);
    if (candidate.status !== 'stale') {
      const latestEvent = candidate.reviewMetadata?.lifecycleEvents?.at(-1);
      if (candidate.status === 'pending' && latestEvent?.type === 'stale_reopened') {
        return { kind: 'memory_candidate_stale_reopen', deduplicated: true, candidate };
      }
      throw codedError(`Memory candidate ${candidate.id} is ${candidate.status}; expected stale.`, 'CONTEXTFORGE_CANDIDATE_NOT_STALE');
    }
    const at = new Date().toISOString();
    const metadata = {
      ...lifecycleMetadata(candidate, {
        type: 'stale_reopened',
        fromStatus: 'stale',
        toStatus: 'pending',
        at,
        actor: options.actor,
        reason: options.reason,
        requestId: options.requestId || null,
      }),
      candidateSlaAnchorAt: at,
    };
    const updated = store.db.prepare(`
      UPDATE memory_candidate_index SET status = 'pending', review_metadata_json = ?
      WHERE scope_type = ? AND scope_key = ? AND id = ? AND status = 'stale'
    `).run(JSON.stringify(metadata), scope.scopeType, scope.scopeKey, candidate.id);
    if (updated.changes !== 1) {
      throw codedError(`Memory candidate ${candidate.id} changed before reopen committed.`, 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE');
    }
    return {
      kind: 'memory_candidate_stale_reopen',
      deduplicated: false,
      candidate: store.getMemoryCandidate({ ...scope, candidateId: candidate.id }),
    };
  });
}

export function processDueCandidateStaleTransitions(store, scope, options = {}, policy) {
  const dryRun = truthy(options.dryRun);
  const due = listDueCandidateStaleTransitions(store, scope, options, policy);
  const result = {
    kind: 'memory_candidate_stale_transition_batch',
    scope,
    asOf: due.asOf,
    dryRun,
    limit: due.limit,
    totalDueCount: due.totalDueCount,
    dueCount: due.dueCount,
    remainingCount: due.remainingCount,
    policy: due.policy,
    staled: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };
  if (dryRun) return { ...result, candidates: due.candidates };
  for (const item of due.candidates) {
    try {
      const transitioned = staleCandidate(store, scope, {
        candidateId: item.candidate.id,
        actor: options.actor || options.submittedBy || 'candidate-stale-sla-worker',
        reason: options.reason || `Candidate exceeded the ${item.queue} review SLA.`,
        requestId: options.requestId || null,
        expectedQueue: item.queue,
        expectedAnchorAt: item.anchorAt,
        ageMs: item.ageMs,
        slaMs: item.slaMs,
        policyVersion: item.policyVersion,
      });
      result.staled += 1;
      result.results.push({ candidateId: item.candidate.id, status: 'staled', queue: item.queue, candidate: transitioned.candidate });
    } catch (error) {
      if (['CONTEXTFORGE_CANDIDATE_NOT_PENDING', 'CONTEXTFORGE_CANDIDATE_AUDIT_ACTIVE',
        'CONTEXTFORGE_CANDIDATE_SLA_EPOCH_CHANGED', 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE'].includes(error.code)) {
        result.skipped += 1;
        result.results.push({ candidateId: item.candidate.id, status: 'skipped', code: error.code });
      } else {
        result.failed += 1;
        result.results.push({ candidateId: item.candidate.id, status: 'failed', code: error.code || null, message: error.message });
      }
    }
  }
  return result;
}

export function candidateStaleSlaMethods({ config, useStore }) {
  return {
    listDueCandidateStaleTransitions(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => listDueCandidateStaleTransitions(store, scope, options, config.candidateSla));
    },
    processDueCandidateStaleTransitions(options = {}) {
      if (!((options.scope || options.scopeType) && options.scopeKey) && !options.cwd && !options.repoPath) {
        throw new Error('processDueCandidateStaleTransitions requires one explicit canonical scope.');
      }
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => processDueCandidateStaleTransitions(store, scope, options, config.candidateSla));
    },
    reopenStaleMemoryCandidate(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => reopenStaleCandidate(store, scope, options));
    },
  };
}
