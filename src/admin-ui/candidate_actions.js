const ACTIVE_AUDIT_STATES = new Set(['queued', 'running']);
const AUDIT_ELIGIBLE_STATES = new Set(['unaudited', 'failed_retryable', 'legacy_unknown']);

function hasCurrentPromotionRouting(candidate) {
  return Boolean(candidate.promotionRouting?.action) &&
    Boolean(candidate.latestAuditAttemptId) &&
    candidate.promotionRouting.auditAttemptId === candidate.latestAuditAttemptId;
}

function promotionBlockedReason(candidate) {
  if (candidate.auditState !== 'audited') {
    switch (candidate.auditState) {
      case 'unaudited':
        return '아직 감사되지 않았습니다.';
      case 'queued':
        return '감사 대기 중입니다.';
      case 'running':
        return '감사 진행 중입니다.';
      case 'failed_retryable':
        return '감사가 실패했습니다. 재시도가 필요합니다.';
      case 'failed_terminal':
        return '감사가 최종 실패했습니다. 사람 검토가 필요합니다.';
      case 'triaged_no_audit':
        return '자동 감사 제외 대상으로 분류되었습니다.';
      case 'legacy_unknown':
        return '기존 후보라 감사 상태를 확인할 수 없습니다.';
      default:
        return '현재 감사 상태로는 승격할 수 없습니다.';
    }
  }
  if (candidate.auditDecision === 'needs_review') return '감사 결과에 사람 검토가 필요합니다.';
  if (candidate.auditDecision === 'reject') return '감사에서 거절되었습니다.';
  if (candidate.auditDecision !== 'approve') return '감사 승인 상태를 확인할 수 없습니다.';
  if (candidate.promotionRouting && !hasCurrentPromotionRouting(candidate)) {
    return '현재 감사 결과에 대한 라우팅이 필요합니다.';
  }
  switch (candidate.promotionRouting?.action) {
    case 'promote_as_new_memory':
      return null;
    case 'review_memory_update_candidate':
      return '기존 메모리 업데이트 검토 대상입니다.';
    case 'do_not_create_duplicate_memory':
    case 'keep_as_checkpoint_context':
      return '중복 또는 체크포인트 유지 대상으로 분류되었습니다.';
    default:
      return '승인 후보 라우팅이 필요합니다.';
  }
}

export function candidateRecommendedAction(candidate) {
  if (candidate.auditState !== 'audited') return 'review';
  if (candidate.auditDecision === 'needs_review') return 'review';
  if (candidate.auditDecision === 'reject') return 'do_not_promote';
  if (candidate.auditDecision !== 'approve') return 'review';
  if (candidate.promotionRouting && !hasCurrentPromotionRouting(candidate)) {
    return 'route_before_promote';
  }
  switch (candidate.promotionRouting?.action) {
    case 'promote_as_new_memory':
      return 'promote';
    case 'review_memory_update_candidate':
      return 'review_update_candidate';
    case 'do_not_create_duplicate_memory':
    case 'keep_as_checkpoint_context':
      return 'do_not_promote';
    default:
      return 'route_before_promote';
  }
}

export function candidateBulkEligibility(candidate) {
  const pending = candidate?.disposition === 'pending';
  return {
    select: pending,
    audit: pending && AUDIT_ELIGIBLE_STATES.has(candidate.auditState),
    route: pending && candidate.auditState === 'audited' && candidate.auditDecision === 'approve',
    reject: pending,
  };
}

export function eligibleCandidateIndexes(candidates, indexes, action) {
  return indexes.filter((index) => candidateBulkEligibility(candidates[index])?.[action]);
}

export function candidateActionAvailability(candidate) {
  const pending = candidate.disposition === 'pending';
  const snoozed = candidate.disposition === 'snoozed';
  const stale = candidate.disposition === 'stale';
  const auditActive = ACTIVE_AUDIT_STATES.has(candidate.auditState);
  const promotable = pending &&
    candidate.auditState === 'audited' &&
    candidate.auditDecision === 'approve' &&
    hasCurrentPromotionRouting(candidate) &&
    candidate.promotionRouting.action === 'promote_as_new_memory';

  return {
    promote: {
      visible: pending,
      enabled: promotable,
      reason: promotable ? null : promotionBlockedReason(candidate),
    },
    snooze: {
      visible: pending,
      enabled: pending && !auditActive,
      reason: auditActive ? `감사 ${candidate.auditState} 중에는 미룰 수 없습니다.` : null,
    },
    wake: { visible: snoozed, enabled: snoozed, reason: null },
    reopenStale: { visible: stale, enabled: stale, reason: null },
    reject: { visible: pending, enabled: pending, reason: null },
  };
}
