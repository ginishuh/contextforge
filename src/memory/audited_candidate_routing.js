import { durableMemoryRevisionHash, memoryCandidateRevisionHash } from './candidate_revision.js';
import {
  memoryUpdateCandidateProposal,
  promotionAssessmentForIndexedCandidate,
  updateCandidateDraftForPromotionAssessment,
} from './candidate_promotion.js';

function routingAction(classification) {
  if (classification === 'new') return 'promote_as_new_memory';
  if (classification === 'duplicate') return 'do_not_create_duplicate_memory';
  if (classification === 'too_specific') return 'keep_as_checkpoint_context';
  return 'review_memory_update_candidate';
}

export function assertMemoryUpdateTarget(candidate, currentMemory, options = {}) {
  const expectedRevisionHash = candidate?.basis?.find((item) => item.type === 'memory')?.revisionHash || null;
  const targetMatches = (!candidate?.targetMemoryId || candidate.targetMemoryId === currentMemory?.id)
    && (!expectedRevisionHash || expectedRevisionHash === durableMemoryRevisionHash(currentMemory));
  if (targetMatches) return;
  if (options.allowTargetRevisionOverride === true || options.allowTargetRevisionOverride === 'true') {
    if (!options.reason) throw new Error('reason is required when overriding a changed memory update target.');
    return;
  }
  const error = new Error('The target durable memory changed after this update candidate was created. Re-route or explicitly override it with a reason.');
  error.name = 'MemoryUpdateCandidateTargetChangedError';
  error.code = 'CONTEXTFORGE_MEMORY_UPDATE_TARGET_CHANGED';
  error.expectedMemoryId = candidate.targetMemoryId;
  error.actualMemoryId = currentMemory?.id || null;
  throw error;
}

export function auditedCandidateRoutingMcpToolConfig(z, scopedSchema) {
  return {
    title: 'Route Audited Memory Candidates',
    description:
      'Dry-run or persist same-scope duplicate/refinement/supersedes/conflict routing for audited approved pending candidates. Duplicate routes never create a durable memory; refinement-like routes create review-only memory update candidates. Does not promote durable memory.',
    inputSchema: {
      ...scopedSchema,
      candidateIds: z.array(z.string()).max(100).optional(),
      limit: z.number().int().positive().max(100).optional(),
      dryRun: z.boolean().optional(),
    },
    annotations: { title: 'Route Audited Memory Candidates', destructiveHint: false, idempotentHint: true },
  };
}

export function promotionRoutingForIndexedCandidate({
  store,
  scope,
  indexedCandidate,
  persist = false,
}) {
  const assessment = promotionAssessmentForIndexedCandidate(store, scope, indexedCandidate);
  const updateDraft = updateCandidateDraftForPromotionAssessment(scope, indexedCandidate, assessment);
  const updateCandidate = persist && updateDraft ? store.createMemoryUpdateCandidate(updateDraft) : updateDraft;
  return {
    version: 'audited-candidate-routing.v1',
    auditAttemptId: indexedCandidate.latestAuditAttemptId,
    classification: assessment.classification,
    recommendedAction: assessment.recommendedAction,
    action: routingAction(assessment.classification),
    targetMemoryId: assessment.similarMemories[0]?.memoryId || null,
    targetMemoryKey: assessment.similarMemories[0]?.key || null,
    updateCandidate,
    assessment,
  };
}

export function persistPromotionRouting({ store, scope, indexedCandidate }) {
  const routing = promotionRoutingForIndexedCandidate({
    store, scope, indexedCandidate, persist: true,
  });
  const storedCandidate = store.markMemoryCandidatePromotionRouted({
    ...scope,
    candidateId: indexedCandidate.id,
    expectedAuditContentHash: indexedCandidate.auditContentHash,
    expectedAuditAttemptId: indexedCandidate.latestAuditAttemptId,
    routing: {
      version: routing.version,
      auditAttemptId: routing.auditAttemptId,
      classification: routing.classification,
      recommendedAction: routing.recommendedAction,
      action: routing.action,
      targetMemoryId: routing.targetMemoryId,
      targetMemoryKey: routing.targetMemoryKey,
      updateCandidateId: routing.updateCandidate?.id || null,
    },
  });
  return { ...routing, candidate: storedCandidate };
}

export function persistApprovedAuditRouting({
  store, scope, auditedCandidate, audit, assertLease, errorSummary,
}) {
  if (audit.approved !== true) return { candidate: auditedCandidate, routing: null, error: null };
  try {
    const routing = store.withTransaction(() => {
      assertLease();
      return persistPromotionRouting({ store, scope, indexedCandidate: auditedCandidate });
    });
    return { candidate: routing.candidate, routing, error: null };
  } catch (error) {
    if (error?.code === 'CONTEXTFORGE_JOB_LEASE_LOST') throw error;
    return { candidate: auditedCandidate, routing: null, error: errorSummary(error) };
  }
}

export function promotionRoutingResult(routing) {
  if (!routing) return null;
  return {
    version: routing.version,
    auditAttemptId: routing.auditAttemptId,
    classification: routing.classification,
    recommendedAction: routing.recommendedAction,
    action: routing.action,
    targetMemoryId: routing.targetMemoryId,
    targetMemoryKey: routing.targetMemoryKey,
    updateCandidate: routing.updateCandidate
      ? memoryUpdateCandidateProposal(routing.updateCandidate, routing.assessment)
      : null,
    promotionAssessment: routing.assessment,
  };
}

export function assertCurrentPromotionRouting(indexedCandidate, expectedAuditAttemptId = null) {
  if (!indexedCandidate || ['unaudited', 'legacy_unknown'].includes(indexedCandidate.auditState)) return;
  const routing = indexedCandidate.reviewMetadata?.promotionRouting || null;
  const currentApprovedRoute =
    indexedCandidate.auditState === 'audited' &&
    indexedCandidate.auditDecision === 'approve' &&
    Boolean(indexedCandidate.latestAuditAttemptId) &&
    routing?.action === 'promote_as_new_memory' &&
    routing.auditAttemptId === indexedCandidate.latestAuditAttemptId;
  const expectedAttemptMatches = !expectedAuditAttemptId ||
    expectedAuditAttemptId === indexedCandidate.latestAuditAttemptId;
  if (currentApprovedRoute && expectedAttemptMatches) return;
  const error = new Error(
    'Audited candidates require a current approved audit and promote_as_new_memory routing before promotion.',
  );
  error.name = 'MemoryCandidatePromotionRoutingRequiredError';
  error.code = 'CONTEXTFORGE_CANDIDATE_PROMOTION_ROUTING_REQUIRED';
  error.auditState = indexedCandidate.auditState;
  error.auditDecision = indexedCandidate.auditDecision;
  error.latestAuditAttemptId = indexedCandidate.latestAuditAttemptId;
  error.routedAuditAttemptId = routing?.auditAttemptId || null;
  throw error;
}

export function finalizeRoutedSourceCandidate(store, scope, updateCandidate, { outcome, reason, memory = null }) {
  if (!updateCandidate?.sourceCandidateId) return null;
  const sourceCandidate = store.getMemoryCandidate({ ...scope, candidateId: updateCandidate.sourceCandidateId });
  if (!sourceCandidate || sourceCandidate.status !== 'pending') return sourceCandidate || null;
  const status = outcome === 'applied' ? 'promoted' : outcome === 'rejected' ? 'rejected' : 'stale';
  return store.markMemoryCandidateReviewed({
    ...scope,
    candidateId: sourceCandidate.id,
    status,
    reason,
    promotedMemoryId: outcome === 'applied' ? memory?.id || null : null,
    metadata: {
      lifecycleEvents: [
        ...(Array.isArray(sourceCandidate.reviewMetadata?.lifecycleEvents)
          ? sourceCandidate.reviewMetadata.lifecycleEvents
          : []),
        {
          type: 'promotion_routing_resolved',
          updateCandidateId: updateCandidate.id,
          outcome,
          reason,
          at: new Date().toISOString(),
        },
      ],
      promotionRoutingResolution: {
        updateCandidateId: updateCandidate.id,
        outcome,
        memoryId: memory?.id || null,
        memoryKey: memory?.key || null,
      },
    },
  });
}

export function routeAuditedMemoryCandidates({
  store,
  scope,
  options,
  positiveNumber,
  truthyOption,
}) {
  const dryRun = options.dryRun == null ? true : truthyOption(options.dryRun);
  const requestedLimit = positiveNumber(options.limit == null ? 25 : Number(options.limit), 'limit');
  const limit = Math.min(100, requestedLimit);
  const candidateIds = Array.isArray(options.candidateIds)
    ? [...new Set(options.candidateIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  if (candidateIds.length > 100) throw new Error('candidateIds supports at most 100 candidates per routing batch.');
  const candidates = store.listMemoryCandidates({
    ...scope, status: 'pending', auditState: 'audited', auditDecision: 'approve', sort: 'oldest',
    limit: candidateIds.length || limit, candidateIds: candidateIds.length ? candidateIds : null,
  });
  const results = [];
  const loadedIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidateId of candidateIds.filter((id) => !loadedIds.has(id))) {
    const candidate = store.getMemoryCandidate({ ...scope, candidateId });
    results.push({
      candidateId,
      status: 'skipped',
      reason: !candidate
        ? 'candidate_not_found'
        : candidate.status !== 'pending'
          ? `disposition_${candidate.status}`
          : candidate.auditState !== 'audited'
            ? `audit_state_${candidate.auditState}`
            : `audit_decision_${candidate.auditDecision || 'none'}`,
    });
  }
  for (const candidate of candidates) {
    const currentHash = memoryCandidateRevisionHash(candidate.candidate);
    if (!candidate.auditContentHash || candidate.auditContentHash !== currentHash) {
      results.push({
        candidateId: candidate.id, status: 'skipped', reason: 'audit_revision_mismatch',
        auditedContentHash: candidate.auditContentHash || null, currentContentHash: currentHash,
      });
      continue;
    }
    const input = { store, scope, indexedCandidate: candidate };
    const routing = dryRun
      ? promotionRoutingForIndexedCandidate(input)
      : store.withTransaction(() => {
          const fresh = store.getMemoryCandidate({ ...scope, candidateId: candidate.id });
          if (!fresh || fresh.status !== 'pending' || fresh.auditState !== 'audited' || fresh.auditDecision !== 'approve') {
            return null;
          }
          if (!fresh.auditContentHash || fresh.auditContentHash !== memoryCandidateRevisionHash(fresh.candidate)) return null;
          return persistPromotionRouting({ ...input, indexedCandidate: fresh });
        });
    results.push(routing
      ? { candidateId: candidate.id, status: dryRun ? 'planned' : 'routed', routing: promotionRoutingResult(routing) }
      : { candidateId: candidate.id, status: 'skipped', reason: 'candidate_changed' });
  }
  const counts = results.reduce((acc, item) => {
    const key = item.routing?.classification || item.reason || item.status;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    kind: 'audited_memory_candidate_routing_result', dryRun, scope,
    policy: {
      requiresPending: true, requiresAuditState: 'audited', requiresAuditDecision: 'approve',
      maxBatchSize: 100, mutatesDurableMemory: false, createsUpdateCandidates: !dryRun,
    },
    scannedCount: candidates.length, resultCount: results.length, counts, results,
    requestWarnings: requestedLimit > 100 ? [{ code: 'limit_capped', requestedLimit, effectiveLimit: limit }] : [],
    nextActions: [
      dryRun
        ? 'Inspect the routing plan, then rerun with dryRun=false to persist update-candidate links.'
        : 'Review pending memory update candidates before applying, rejecting, or skipping them.',
      'Duplicate routes do not create a new durable memory.',
    ],
  };
}
