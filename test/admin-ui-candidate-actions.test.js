import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { candidateActionAvailability } from '../src/admin-ui/candidate_actions.js';

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
    requiresReason: false,
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
    auditState: 'completed',
    recommendedAction: 'promote',
  });

  assert.equal(actions.promote.enabled, true);
  assert.equal(actions.promote.reason, null);
  assert.equal(actions.promote.requiresReason, false);
});

test('audited needs-review candidates allow an explicit human promotion decision', () => {
  const actions = candidateActionAvailability({
    disposition: 'pending',
    auditState: 'audited',
    auditDecision: 'needs_review',
    recommendedAction: 'review',
  });

  assert.equal(actions.promote.visible, true);
  assert.equal(actions.promote.enabled, true);
  assert.equal(actions.promote.requiresReason, true);
});

test('audit-approved candidates still require duplicate and update routing', () => {
  const actions = candidateActionAvailability({
    disposition: 'pending',
    auditState: 'audited',
    auditDecision: 'approve',
    recommendedAction: 'route_before_promote',
  });

  assert.equal(actions.promote.enabled, false);
  assert.equal(actions.promote.reason, '승인 후보 라우팅이 필요합니다.');
  assert.equal(actions.promote.requiresReason, false);
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
    '상세', '승격', '검토 후 승격', '미루기', '다시 열기', 'stale 해제', '거절',
    '감사 비용 dry-run', '선택 후보 감사 제출', '승인 후보 중복·업데이트 라우팅',
  ]) {
    assert.match(html, new RegExp(`<dt>${label}</dt>`));
  }
  assert.match(html, /감사, 라우팅, 승격은 별도 단계입니다/);
  assert.match(html, /영구 메모리를 직접 만들거나 수정하지 않습니다/);
  assert.match(html, /후보와 감사·근거 이력은 유지됩니다/);
});
