import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  candidateActionAvailability,
  candidateBulkEligibility,
  candidateRecommendedAction,
  eligibleCandidateIndexes,
} from '../src/admin-ui/candidate_actions.js';

test('pending review candidates expose only valid review actions', () => {
  const actions = candidateActionAvailability({
    disposition: 'pending',
    auditState: 'unaudited',
    recommendedAction: 'review',
  });

  assert.deepEqual(actions.promote, {
    visible: true,
    enabled: false,
    reason: '아직 감사되지 않았습니다.',
  });
  assert.equal(actions.snooze.enabled, true);
  assert.equal(actions.reject.enabled, true);
  assert.equal(actions.wake.visible, false);
  assert.equal(actions.reopenStale.visible, false);
});

test('promotion guidance distinguishes each non-promotable audit state', () => {
  const cases = [
    ['queued', null, '감사 대기 중입니다.'],
    ['running', null, '감사 진행 중입니다.'],
    ['failed_retryable', null, '감사가 실패했습니다. 재시도가 필요합니다.'],
    ['failed_terminal', null, '감사가 최종 실패했습니다. 사람 검토가 필요합니다.'],
    ['triaged_no_audit', null, '자동 감사 제외 대상으로 분류되었습니다.'],
    ['legacy_unknown', null, '기존 후보라 감사 상태를 확인할 수 없습니다.'],
    ['audited', 'reject', '감사에서 거절되었습니다.'],
  ];

  for (const [auditState, auditDecision, reason] of cases) {
    const actions = candidateActionAvailability({
      disposition: 'pending',
      auditState,
      auditDecision,
      recommendedAction: 'review',
    });
    assert.equal(actions.promote.enabled, false);
    assert.equal(actions.promote.reason, reason);
  }
});

test('pending candidates cannot be snoozed while an audit is active', () => {
  for (const auditState of ['queued', 'running']) {
    const actions = candidateActionAvailability({
      disposition: 'pending',
      auditState,
      recommendedAction: 'review',
    });

    assert.equal(actions.snooze.visible, true);
    assert.equal(actions.snooze.enabled, false);
    assert.match(actions.snooze.reason, new RegExp(auditState));
  }
});

test('routed new-memory candidates can be promoted', () => {
  const actions = candidateActionAvailability({
    disposition: 'pending',
    auditState: 'audited',
    auditDecision: 'approve',
    latestAuditAttemptId: 'audit-current',
    promotionRouting: { action: 'promote_as_new_memory', auditAttemptId: 'audit-current' },
  });

  assert.equal(actions.promote.enabled, true);
  assert.equal(actions.promote.reason, null);
});

test('audited needs-review candidates require a new approving audit before promotion', () => {
  const actions = candidateActionAvailability({
    disposition: 'pending',
    auditState: 'audited',
    auditDecision: 'needs_review',
  });

  assert.equal(actions.promote.visible, true);
  assert.equal(actions.promote.enabled, false);
  assert.equal(actions.promote.reason, '감사 결과에 사람 검토가 필요합니다.');
});

test('audit-approved candidates still require duplicate and update routing', () => {
  const actions = candidateActionAvailability({
    disposition: 'pending',
    auditState: 'audited',
    auditDecision: 'approve',
    promotionRouting: null,
  });

  assert.equal(actions.promote.enabled, false);
  assert.equal(actions.promote.reason, '승인 후보 라우팅이 필요합니다.');
});

test('stale promotion routing never overrides the current audit state or decision', () => {
  const cases = [
    ['queued', null],
    ['running', null],
    ['failed_retryable', null],
    ['failed_terminal', null],
    ['audited', 'needs_review'],
    ['audited', 'reject'],
  ];

  for (const [auditState, auditDecision] of cases) {
    const candidate = {
      disposition: 'pending',
      auditState,
      auditDecision,
      latestAuditAttemptId: 'audit-current',
      promotionRouting: { action: 'promote_as_new_memory', auditAttemptId: 'audit-old' },
    };
    assert.equal(candidateActionAvailability(candidate).promote.enabled, false);
    assert.notEqual(candidateRecommendedAction(candidate), 'promote');
  }
});

test('new-memory routing must belong to the latest approved audit attempt', () => {
  const candidate = {
    disposition: 'pending',
    auditState: 'audited',
    auditDecision: 'approve',
    latestAuditAttemptId: 'audit-current',
    promotionRouting: { action: 'promote_as_new_memory', auditAttemptId: 'audit-old' },
  };

  assert.equal(candidateRecommendedAction(candidate), 'route_before_promote');
  assert.equal(candidateActionAvailability(candidate).promote.enabled, false);
  assert.equal(candidateActionAvailability(candidate).promote.reason, '현재 감사 결과에 대한 라우팅이 필요합니다.');

  candidate.promotionRouting.auditAttemptId = 'audit-current';
  assert.equal(candidateRecommendedAction(candidate), 'promote');
  assert.equal(candidateActionAvailability(candidate).promote.enabled, true);
});

test('approved candidate routing actions remain distinct', () => {
  const base = {
    disposition: 'pending', auditState: 'audited', auditDecision: 'approve', latestAuditAttemptId: 'audit-1',
  };
  assert.equal(candidateRecommendedAction({
    ...base, promotionRouting: { action: 'review_memory_update_candidate', auditAttemptId: 'audit-1' },
  }), 'review_update_candidate');
  assert.equal(candidateRecommendedAction({
    ...base, promotionRouting: { action: 'do_not_create_duplicate_memory', auditAttemptId: 'audit-1' },
  }), 'do_not_promote');
  assert.equal(candidateRecommendedAction({ ...base, promotionRouting: null }), 'route_before_promote');
});

test('bulk actions only accept candidates eligible for that transition', () => {
  const cases = [
    [{ disposition: 'pending', auditState: 'unaudited' }, [true, true, false, true]],
    [{ disposition: 'pending', auditState: 'failed_retryable' }, [true, true, false, true]],
    [{ disposition: 'pending', auditState: 'legacy_unknown' }, [true, true, false, true]],
    [{ disposition: 'pending', auditState: 'audited', auditDecision: 'approve' }, [true, false, true, true]],
    [{ disposition: 'pending', auditState: 'audited', auditDecision: 'needs_review' }, [true, false, false, true]],
    [{ disposition: 'snoozed', auditState: 'unaudited' }, [false, false, false, false]],
    [{ disposition: 'stale', auditState: 'audited', auditDecision: 'approve' }, [false, false, false, false]],
    [{ disposition: 'promoted', auditState: 'audited', auditDecision: 'approve' }, [false, false, false, false]],
    [{ disposition: 'rejected', auditState: 'audited', auditDecision: 'reject' }, [false, false, false, false]],
  ];

  for (const [candidate, expected] of cases) {
    const eligibility = candidateBulkEligibility(candidate);
    assert.deepEqual(
      [eligibility.select, eligibility.audit, eligibility.route, eligibility.reject],
      expected,
    );
  }

  const candidates = cases.map(([candidate]) => candidate);
  assert.deepEqual(eligibleCandidateIndexes(candidates, candidates.map((_, index) => index), 'audit'), [0, 1, 2]);
  assert.deepEqual(eligibleCandidateIndexes(candidates, candidates.map((_, index) => index), 'route'), [3]);
  assert.deepEqual(eligibleCandidateIndexes(candidates, candidates.map((_, index) => index), 'reject'), [0, 1, 2, 3, 4]);
});

test('snoozed and stale candidates expose only their reopen transition', () => {
  const snoozed = candidateActionAvailability({ disposition: 'snoozed', auditState: 'completed' });
  assert.equal(snoozed.wake.visible, true);
  assert.equal(snoozed.promote.visible, false);
  assert.equal(snoozed.snooze.visible, false);
  assert.equal(snoozed.reject.visible, false);

  const stale = candidateActionAvailability({ disposition: 'stale', auditState: 'completed' });
  assert.equal(stale.reopenStale.visible, true);
  assert.equal(stale.promote.visible, false);
  assert.equal(stale.wake.visible, false);
  assert.equal(stale.reject.visible, false);
});

test('candidate review UI explains individual and bulk action effects', async () => {
  const html = await fs.readFile(new URL('../src/admin-ui/index.html', import.meta.url), 'utf8');
  for (const label of [
    '상세', '승격', '미루기', '다시 열기', 'stale 해제', '거절',
    '감사 비용 dry-run', '선택 후보 감사 제출', '승인 후보 중복·업데이트 라우팅',
  ]) {
    assert.match(html, new RegExp(`<dt>${label}</dt>`));
  }
  assert.match(html, /감사, 라우팅, 승격은 별도 단계입니다/);
  assert.match(html, /영구 메모리를 직접 만들거나 수정하지 않습니다/);
  assert.match(html, /후보와 감사·근거 이력은 유지됩니다/);
  assert.match(html, /needs_review<\/code> 후보는 감사 의견을 사람이 검토해야 하며 직접 승격할 수 없습니다/);
  for (const id of ['selectAllCandidates', 'auditSelectedCandidates', 'routeSelectedCandidates', 'rejectSelectedCandidates']) {
    assert.match(html, new RegExp(`id="${id}" disabled`));
  }
});
