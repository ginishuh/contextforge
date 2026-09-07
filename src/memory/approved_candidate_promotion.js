import { truthyOption } from '../common.js';
import { durableMemoryRevisionHash, memoryCandidateRevisionHash } from './candidate_revision.js';
import { candidatePromotionWarnings, promotionAssessment, promoteCandidateToMemory } from './candidate_promotion.js';

function hold(reason, extra = {}) {
  return { status: 'held', reason, ...extra };
}

function candidatePlan(store, scope, indexed) {
  const candidate = indexed.candidate;
  const audit = indexed.reviewMetadata?.audit;
  const revisionHash = memoryCandidateRevisionHash(candidate);
  if (!indexed.auditContentHash || indexed.auditContentHash !== revisionHash) return hold('audit_revision_mismatch');
  if (!audit?.approved || audit.decision !== 'approve' || !indexed.latestAuditAttemptId) return hold('audit_not_approved');
  if (!audit.metadata?.provider || audit.metadata.provider === 'none') return hold('audit_provider_missing');
  const decision = audit.promotion;
  if (decision && decision.candidateRevisionHash !== revisionHash) return hold('audit_revision_mismatch');
  const assessment = promotionAssessment(store, scope, { ...candidate, candidate });
  // Historical approvals can create new memories through the existing safety checks;
  // they never authorize overwriting a memory or linking an inferred duplicate.
  const action = decision?.action || (assessment.classification === 'new' ? 'new' : 'hold');
  if (action === 'hold') return hold(decision ? 'audit_requires_review' : 'needs_action_audit');
  if (action === 'new') {
    const warnings = candidatePromotionWarnings(store, scope, { ...candidate, candidate, assessment });
    if (warnings.length) return hold('promotion_warnings', { warnings });
    return { status: 'planned', action, content: candidate.content };
  }
  if (!['duplicate', 'update'].includes(action)) return hold('invalid_audit_action');
  const target = store.listMemories(scope).find((memory) => memory.id === decision.targetMemoryId);
  if (!target || target.status !== 'active') return hold('target_not_found');
  if (!decision.targetRevisionHash || durableMemoryRevisionHash(target) !== decision.targetRevisionHash) {
    return hold('target_revision_changed');
  }
  if (action === 'duplicate') return { status: 'planned', action, target };
  if (typeof decision.content !== 'string' || !decision.content.trim()) return hold('replacement_missing');
  const replacement = { ...candidate, key: target.key, content: decision.content };
  const warnings = candidatePromotionWarnings(store, scope, {
    ...replacement, candidate: replacement, assessment: { classification: 'new', similarMemories: [] },
  }).filter((warning) => !(['existing_key_conflict', 'duplicate_key'].includes(warning.code) && warning.memoryId === target.id));
  if (warnings.length) return hold('promotion_warnings', { warnings });
  return { status: 'planned', action, target, content: decision.content };
}

function finishCandidate(store, scope, indexed, plan, enqueueEmbeddings, actor) {
  const candidate = indexed.candidate;
  const reason = indexed.reviewMetadata.audit.reason || 'Applied approved durable-memory decision.';
  const provenance = {
    autoPromoted: true,
    auditAttemptId: indexed.latestAuditAttemptId,
    auditContentHash: indexed.auditContentHash,
    actor,
    automaticPromotion: { action: plan.action, auditAttemptId: indexed.latestAuditAttemptId, status: 'completed' },
  };
  let memory;
  if (plan.action === 'new') {
    memory = promoteCandidateToMemory(store, scope, {
      candidate, indexedCandidate: indexed, checkpointId: indexed.checkpointId,
      sessionId: indexed.sessionId, candidateIndex: indexed.index,
      key: candidate.key, content: candidate.content, category: candidate.category || 'note',
      tags: candidate.tags || [], importance: candidate.importance || 0, reason,
      eventMetadata: provenance, reviewMetadata: provenance,
    }, enqueueEmbeddings);
  } else if (plan.action === 'update') {
    const update = store.createMemoryUpdateCandidate({
      ...scope, action: 'correct_memory', targetMemoryId: plan.target.id, targetMemoryKey: plan.target.key,
      proposedKey: plan.target.key, proposedContent: plan.content, proposedCategory: plan.target.category,
      proposedTags: plan.target.tags, proposedImportance: plan.target.importance, reason,
      sourceCandidateId: indexed.id, sourceCheckpointId: indexed.checkpointId, sourceSessionId: indexed.sessionId,
      correction: plan.content, basis: [{ type: 'memory', memoryId: plan.target.id,
        revisionHash: durableMemoryRevisionHash(plan.target), content: plan.target.content }],
    });
    memory = store.rememberMemory({
      ...scope, key: plan.target.key, content: plan.content,
      category: plan.target.category, tags: plan.target.tags, importance: plan.target.importance,
      supersedesMemoryId: plan.target.id, eventType: 'correct',
      eventMetadata: {
        ...provenance, sourceUpdateCandidateId: update.id, sourceCandidateId: indexed.id, sourceCheckpointId: indexed.checkpointId,
        sourceSessionId: indexed.sessionId, candidateSourceEventIds: candidate.sourceEventIds || [],
        previousContent: plan.target.content, previousRevisionHash: durableMemoryRevisionHash(plan.target), reason,
      },
    });
    store.markMemoryCandidateReviewed({
      ...scope, candidateId: indexed.id, status: 'promoted', promotedMemoryId: memory.id, reason,
      metadata: provenance,
    });
    store.markMemoryUpdateCandidateReviewed({ ...scope, candidateId: update.id, status: 'applied', reason, appliedMemoryId: memory.id,
      metadata: { ...provenance, memoryId: memory.id } });
    store.db.prepare(`UPDATE memory_update_candidates SET status = 'skipped', reviewed_at = ?,
      review_reason = ? WHERE scope_type = ? AND scope_key = ? AND source_candidate_id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), 'Superseded by the exact audited replacement.', scope.scopeType, scope.scopeKey, indexed.id);
    enqueueEmbeddings(store, [store.embeddingSourceForMemory(memory)]);
  } else {
    memory = plan.target;
    store.markMemoryCandidateReviewed({
      ...scope, candidateId: indexed.id, status: 'rejected', reason: `Already covered by ${memory.key}. ${reason}`,
      metadata: { ...provenance, coveredByMemoryId: memory.id },
    });
  }
  return { candidateId: indexed.id, status: 'completed', action: plan.action, memoryId: memory.id, key: memory.key };
}

export function processApprovedMemoryCandidates({ store, scope, options = {}, enabled, enqueueEmbeddings }) {
  const dryRun = options.dryRun == null ? true : truthyOption(options.dryRun);
  const limit = Number(options.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.');
  const candidateIds = options.candidateIds;
  if (candidateIds != null && (!Array.isArray(candidateIds) || candidateIds.length > 100)) {
    throw new Error('candidateIds must be an array of at most 100 IDs.');
  }
  const result = {
    kind: 'approved_memory_candidate_promotion_result', scope, dryRun, enabled,
    processed: 0, promoted: 0, updated: 0, linked: 0, held: 0, failed: 0, results: [],
  };
  if (!dryRun && !enabled) return { ...result, reason: 'automatic_promotion_disabled' };
  // Persisted holds are tied to an audit attempt. They do not monopolize every
  // worker batch; a subsequent audit makes the candidate eligible again.
  const conditions = ["scope_type = ?", "scope_key = ?", "status = 'pending'",
    "audit_state = 'audited'", "audit_decision = 'approve'"];
  const params = [scope.scopeType, scope.scopeKey];
  if (candidateIds) {
    if (!candidateIds.length) return result;
    conditions.push(`id IN (${candidateIds.map(() => '?').join(',')})`);
    params.push(...candidateIds);
  } else {
    conditions.push("COALESCE(json_extract(review_metadata_json, '$.automaticPromotion.auditAttemptId'), '') != COALESCE(latest_audit_attempt_id, '')");
  }
  const ids = store.db.prepare(`SELECT id FROM memory_candidate_index WHERE ${conditions.join(' AND ')}
    ORDER BY reviewed_at ASC, id ASC LIMIT ?`).all(...params, limit);
  for (const { id } of ids) {
    try {
      const item = store.withTransaction(() => {
        const indexed = store.getMemoryCandidate({ ...scope, candidateId: id });
        if (!indexed || indexed.status !== 'pending' || indexed.auditState !== 'audited' || indexed.auditDecision !== 'approve') {
          return { candidateId: id, status: 'skipped', reason: 'candidate_changed' };
        }
        const plan = candidatePlan(store, scope, indexed);
        if (dryRun) return { candidateId: id, ...plan, target: undefined, memoryId: plan.target?.id };
        // Take the write lock with the same audit predicates before any durable write.
        // This also fences a concurrent audit or another worker's finalization.
        const changed = store.db.prepare(`UPDATE memory_candidate_index SET review_metadata_json = review_metadata_json
          WHERE id = ? AND scope_type = ? AND scope_key = ? AND status = 'pending'
            AND audit_state = 'audited' AND audit_decision = 'approve'
            AND latest_audit_attempt_id = ? AND audit_content_hash = ?`)
          .run(id, scope.scopeType, scope.scopeKey, indexed.latestAuditAttemptId, indexed.auditContentHash);
        if (changed.changes !== 1) throw new Error('Candidate audit changed before automatic promotion.');
        if (plan.status === 'held') {
          store.markMemoryCandidateReviewed({
            ...scope, candidateId: id, status: 'pending', reason: plan.reason,
            metadata: { automaticPromotion: {
              auditAttemptId: indexed.latestAuditAttemptId, status: 'held', reason: plan.reason,
              warnings: plan.warnings || [], at: new Date().toISOString(),
            } },
          });
          return { candidateId: id, ...plan };
        }
        return finishCandidate(store, scope, indexed, plan, enqueueEmbeddings, options.workerId || 'candidate-lifecycle');
      });
      result.results.push(item);
      result.processed += 1;
      if (item.status === 'held') result.held += 1;
      if (item.status === 'completed') {
        if (item.action === 'new') result.promoted += 1;
        if (item.action === 'update') result.updated += 1;
        if (item.action === 'duplicate') result.linked += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.results.push({ candidateId: id, status: 'failed', error: { message: error.message, code: error.code || null } });
    }
  }
  return result;
}
