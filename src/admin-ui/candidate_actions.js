const ACTIVE_AUDIT_STATES = new Set(['queued', 'running']);

function promotionBlockedReason(candidate) {
  switch (candidate.recommendedAction) {
    case 'route_before_promote':
      return '승인 후보 라우팅이 필요합니다.';
    case 'review_update_candidate':
      return '기존 메모리 업데이트 검토 대상입니다.';
    case 'do_not_promote':
      return '중복 또는 체크포인트 유지 대상으로 분류되었습니다.';
    default:
      return '감사 승인이 필요합니다.';
  }
}

export function candidateActionAvailability(candidate) {
  const pending = candidate.disposition === 'pending';
  const snoozed = candidate.disposition === 'snoozed';
  const stale = candidate.disposition === 'stale';
  const auditActive = ACTIVE_AUDIT_STATES.has(candidate.auditState);
  const humanReviewPromotable = pending &&
    candidate.recommendedAction === 'review' &&
    candidate.auditState === 'audited' &&
    candidate.auditDecision === 'needs_review';
  const promotable = pending && (candidate.recommendedAction === 'promote' || humanReviewPromotable);

  return {
    promote: {
      visible: pending,
      enabled: promotable,
      reason: promotable ? null : promotionBlockedReason(candidate),
      requiresReason: humanReviewPromotable,
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
