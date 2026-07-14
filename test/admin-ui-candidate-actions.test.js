import assert from 'node:assert/strict';
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
    reason: '감사 승인이 필요합니다.',
    requiresReason: false,
  });
  assert.equal(actions.snooze.enabled, true);
  assert.equal(actions.reject.enabled, true);
  assert.equal(actions.wake.visible, false);
  assert.equal(actions.reopenStale.visible, false);
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
