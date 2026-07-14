import { randomUUID } from 'node:crypto';
import { normalizeScopeOptions } from '../scopes/index.js';

const ACTIVE_AUDIT_STATES = new Set(['queued', 'running']);

function requireOption(value, name) {
  if (value == null || value === '') throw new Error(`${name} is required.`);
}

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

function normalizedFutureIso(value, nowMs) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error('snoozedUntil must be a valid date-time.');
  if (parsed <= nowMs) throw new Error('snoozedUntil must be in the future.');
  return new Date(parsed).toISOString();
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

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function snoozeCandidate(store, scope, options = {}) {
  requireOption(options.candidateId, 'candidateId');
  requireOption(options.reason, 'reason');
  requireOption(options.actor, 'actor');
  const now = new Date();
  const snoozedUntil = normalizedFutureIso(options.snoozedUntil, now.getTime());
  const wakeUpStatus = options.wakeUpStatus || 'pending';
  if (wakeUpStatus !== 'pending') throw new Error('wakeUpStatus must be pending.');
  return store.withTransaction(() => {
    const candidate = store.getMemoryCandidate({ ...scope, candidateId: options.candidateId });
    if (!candidate) throw new Error(`Memory candidate not found: ${options.candidateId}`);
    if (candidate.status === 'snoozed') {
      const same = candidate.snoozedUntil === snoozedUntil && candidate.snoozeReason === options.reason &&
        candidate.snoozedBy === options.actor && candidate.wakeUpStatus === wakeUpStatus;
      if (same) return { kind: 'memory_candidate_snooze', deduplicated: true, candidate };
      throw codedError(`Memory candidate ${candidate.id} is already snoozed.`, 'CONTEXTFORGE_CANDIDATE_ALREADY_SNOOZED');
    }
    if (candidate.status !== 'pending') {
      throw codedError(`Memory candidate ${candidate.id} is ${candidate.status}; expected pending.`, 'CONTEXTFORGE_CANDIDATE_NOT_PENDING');
    }
    if (ACTIVE_AUDIT_STATES.has(candidate.auditState)) {
      throw codedError(`Memory candidate ${candidate.id} has an active ${candidate.auditState} audit.`, 'CONTEXTFORGE_CANDIDATE_AUDIT_ACTIVE');
    }
    const at = now.toISOString();
    const metadata = lifecycleMetadata(candidate, {
      type: 'snoozed', fromStatus: 'pending', toStatus: 'snoozed', at,
      actor: options.actor, reason: options.reason, snoozedUntil, wakeUpStatus,
      requestId: options.requestId || null,
    });
    const updated = store.db.prepare(`
      UPDATE memory_candidate_index
      SET status = 'snoozed', snoozed_until = ?, snooze_reason = ?, snoozed_by = ?, wake_up_status = ?,
          reviewed_at = ?, review_reason = ?, review_metadata_json = ?
      WHERE scope_type = ? AND scope_key = ? AND id = ? AND status = 'pending'
        AND audit_state NOT IN ('queued', 'running')
    `).run(
      snoozedUntil, options.reason, options.actor, wakeUpStatus, at, options.reason, JSON.stringify(metadata),
      scope.scopeType, scope.scopeKey, candidate.id,
    );
    if (updated.changes !== 1) {
      throw codedError(`Memory candidate ${candidate.id} changed before snooze committed.`, 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE');
    }
    return {
      kind: 'memory_candidate_snooze', deduplicated: false,
      candidate: store.getMemoryCandidate({ ...scope, candidateId: candidate.id }),
    };
  });
}

export function wakeCandidate(store, scope, options = {}) {
  requireOption(options.candidateId, 'candidateId');
  requireOption(options.reason, 'reason');
  requireOption(options.actor, 'actor');
  const now = new Date();
  return store.withTransaction(() => {
    const candidate = store.getMemoryCandidate({ ...scope, candidateId: options.candidateId });
    if (!candidate) throw new Error(`Memory candidate not found: ${options.candidateId}`);
    if (candidate.status !== 'snoozed') {
      const latestEvent = candidate.reviewMetadata?.lifecycleEvents?.at(-1);
      if (candidate.status === 'pending' && latestEvent?.type === 'woken') {
        return { kind: 'memory_candidate_wake_up', deduplicated: true, candidate };
      }
      throw codedError(`Memory candidate ${candidate.id} is ${candidate.status}; expected snoozed.`, 'CONTEXTFORGE_CANDIDATE_NOT_SNOOZED');
    }
    if (options.expectedSnoozedUntil && candidate.snoozedUntil !== options.expectedSnoozedUntil) {
      throw codedError(`Memory candidate ${candidate.id} snooze epoch changed.`, 'CONTEXTFORGE_CANDIDATE_SNOOZE_EPOCH_CHANGED');
    }
    if (truthy(options.onlyIfDue) && Date.parse(candidate.snoozedUntil || '') > now.getTime()) {
      throw codedError(`Memory candidate ${candidate.id} snooze is not due.`, 'CONTEXTFORGE_CANDIDATE_SNOOZE_NOT_DUE');
    }
    const wakeUpStatus = candidate.wakeUpStatus || 'pending';
    if (wakeUpStatus !== 'pending') {
      throw codedError(`Memory candidate ${candidate.id} has invalid wake-up status ${wakeUpStatus}.`, 'CONTEXTFORGE_CANDIDATE_WAKE_STATUS_INVALID');
    }
    const at = now.toISOString();
    const metadata = lifecycleMetadata(candidate, {
      type: 'woken', fromStatus: 'snoozed', toStatus: wakeUpStatus, at,
      actor: options.actor, reason: options.reason, snoozedUntil: candidate.snoozedUntil,
      snoozeReason: candidate.snoozeReason, snoozedBy: candidate.snoozedBy,
      requestId: options.requestId || null,
    });
    const updated = store.db.prepare(`
      UPDATE memory_candidate_index
      SET status = ?, snoozed_until = NULL, snooze_reason = NULL, snoozed_by = NULL, wake_up_status = NULL,
          reviewed_at = ?, review_reason = ?, review_metadata_json = ?
      WHERE scope_type = ? AND scope_key = ? AND id = ? AND status = 'snoozed' AND snoozed_until = ?
    `).run(
      wakeUpStatus, at, options.reason, JSON.stringify(metadata), scope.scopeType, scope.scopeKey,
      candidate.id, candidate.snoozedUntil,
    );
    if (updated.changes !== 1) {
      throw codedError(`Memory candidate ${candidate.id} changed before wake-up committed.`, 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE');
    }
    return {
      kind: 'memory_candidate_wake_up', deduplicated: false,
      candidate: store.getMemoryCandidate({ ...scope, candidateId: candidate.id }),
    };
  });
}

export function listDueCandidateWakeups(store, scope, options = {}) {
  const limit = boundedLimit(options.limit);
  const order = options.order === 'desc' ? 'DESC' : 'ASC';
  const asOf = new Date().toISOString();
  const rows = store.db.prepare(`
    SELECT id, snoozed_until FROM memory_candidate_index
    WHERE scope_type = ? AND scope_key = ? AND status = 'snoozed'
      AND snoozed_until IS NOT NULL AND snoozed_until <= ?
    ORDER BY snoozed_until ${order}, id ${order} LIMIT ?
  `).all(scope.scopeType, scope.scopeKey, asOf, limit);
  return {
    kind: 'due_memory_candidate_wakeups', scope, asOf, limit, dueCount: rows.length,
    candidates: rows.map((row) => store.getMemoryCandidate({ ...scope, candidateId: row.id })),
  };
}

export function processDueCandidateWakeups(store, scope, options = {}) {
  const dryRun = truthy(options.dryRun);
  const due = listDueCandidateWakeups(store, scope, options);
  const result = {
    kind: 'memory_candidate_wake_up_batch', scope, asOf: due.asOf, dryRun,
    limit: due.limit, dueCount: due.dueCount, woken: 0, deduplicated: 0, skipped: 0, failed: 0, results: [],
  };
  if (dryRun) return { ...result, candidates: due.candidates };
  for (const candidate of due.candidates) {
    try {
      const woken = wakeCandidate(store, scope, {
        candidateId: candidate.id,
        actor: options.actor || options.submittedBy || 'candidate-snooze-worker',
        reason: options.reason || 'Snooze expired.',
        requestId: options.requestId || null,
        expectedSnoozedUntil: candidate.snoozedUntil,
        onlyIfDue: true,
      });
      const status = woken.deduplicated ? 'deduplicated' : 'woken';
      result[status] += 1;
      result.results.push({ candidateId: candidate.id, status, candidate: woken.candidate });
    } catch (error) {
      if (['CONTEXTFORGE_CANDIDATE_NOT_SNOOZED', 'CONTEXTFORGE_CANDIDATE_SNOOZE_EPOCH_CHANGED',
        'CONTEXTFORGE_CANDIDATE_SNOOZE_NOT_DUE', 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE'].includes(error.code)) {
        result.skipped += 1;
        result.results.push({ candidateId: candidate.id, status: 'skipped', code: error.code });
      } else {
        result.failed += 1;
        result.results.push({ candidateId: candidate.id, status: 'failed', code: error.code || null, message: error.message });
      }
    }
  }
  return result;
}

export function candidateDispositionMethods({ config, useStore }) {
  return {
    snoozeMemoryCandidate(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => snoozeCandidate(store, scope, options));
    },
    wakeMemoryCandidate(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => wakeCandidate(store, scope, options));
    },
    listDueCandidateWakeups(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => listDueCandidateWakeups(store, scope, options));
    },
    processDueCandidateWakeups(options = {}) {
      if (!options.scope && !options.scopeType && !options.scopeKey && !options.cwd && !options.repoPath) {
        throw new Error('processDueCandidateWakeups requires one explicit canonical scope.');
      }
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => processDueCandidateWakeups(store, scope, options));
    },
    rejectMemoryCandidate(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.candidateId, 'candidateId');
      requireOption(options.reason, 'reason');
      return useStore((store) => {
        const candidate = store.getMemoryCandidate({ ...scope, candidateId: options.candidateId });
        if (!candidate) throw new Error(`Memory candidate not found: ${options.candidateId}`);
        if (candidate.status !== 'pending' && !truthy(options.allowStatusOverride)) {
          throw new Error(`Memory candidate ${candidate.id} is ${candidate.status}; expected pending. Pass allowStatusOverride to change it anyway.`);
        }
        return store.markMemoryCandidateReviewed({
          ...scope, candidateId: options.candidateId, status: 'rejected', reason: options.reason,
          allowStatusOverride: truthy(options.allowStatusOverride),
          metadata: { checkpointId: candidate.checkpointId, sessionId: candidate.sessionId, sourceCandidateIndex: candidate.index },
        });
      });
    },
  };
}
