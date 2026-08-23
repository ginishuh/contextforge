import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { operationByName } from '../src/operations/registry.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';
import { makeTempDir } from './helpers/temp.js';

function candidate(key, content, overrides = {}) {
  return {
    key,
    content,
    reason: 'A stable repository contract that future agents need.',
    category: 'architecture',
    confidence: 0.95,
    stability: 0.95,
    sensitivity: 'low',
    promotionRecommendation: 'promote',
    sourceEventIds: ['synthetic-evidence'],
    ...overrides,
  };
}

test('candidate backlog audit plan is provider-free and estimates a bounded deduplicated batch', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let auditInvocations = 0;
  const auditor = async () => {
    auditInvocations += 1;
    throw new Error('The dry-run planner must never invoke the provider.');
  };
  auditor.metadata = {
    provider: 'synthetic_auditor',
    model: 'synthetic-model',
    reasoningEffort: 'low',
    promptVersion: 'synthetic-audit.v1',
    outputSchemaVersion: 'synthetic-output.v1',
  };
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
    store,
    autoPromoteAuditor: auditor,
  });
  const scope = { scope: 'repo', scopeType: 'repo', scopeKey: 'candidate-plan-repo' };
  const sessionId = 'codex:candidate-plan';
  app.remember({
    ...scope,
    key: 'already-durable',
    content: 'This exact content is already durable.',
    category: 'architecture',
  });
  app.remember({
    ...scope,
    key: 'key-collision',
    content: 'The older durable wording.',
    category: 'architecture',
  });
  store.insertCheckpoint({
    ...scope,
    sessionId,
    summaryShort: 'Synthetic audit plan.',
    summaryText: 'Exercise deterministic triage, duplicate grouping, and provider cost estimates.',
    provider: 'synthetic_provider',
    sourceEventCount: 0,
    metadata: {
      memoryCandidates: [
        candidate('duplicate-rule', 'Use the same bounded contract.'),
        candidate('duplicate-rule', 'Use the same bounded contract.'),
        candidate('independent-rule', 'Keep audit planning separate from provider execution.'),
        candidate('already-durable', 'This exact content is already durable.'),
        candidate('key-collision', 'The newer candidate wording.'),
        candidate('one-off-status', 'PR #212 CI passed and the branch was cleaned.', {
          category: 'project-status',
          sourceEventIds: [],
        }),
        candidate('preference-note', 'The user likes terse status messages.', {
          category: 'preference',
          sourceEventIds: [],
        }),
        candidate('weak-old-runbook', 'This plausible runbook has no source evidence.', {
          sourceEventIds: [],
        }),
        candidate('already-audited', 'This candidate is already audited.'),
        candidate('active-queued', 'This candidate already has an active audit.'),
      ],
    },
  });
  const indexed = app.listMemoryCandidates({ ...scope, sessionId, status: 'pending', limit: 20 });
  const audited = indexed.find((item) => item.candidate.key === 'already-audited');
  store.db.prepare(`
    UPDATE memory_candidate_index SET audit_state = 'audited', audit_decision = 'needs_review' WHERE id = ?
  `).run(audited.id);
  const activeQueued = indexed.find((item) => item.candidate.key === 'active-queued');
  store.db.prepare("UPDATE memory_candidate_index SET audit_state = 'queued' WHERE id = ?").run(activeQueued.id);
  const asOf = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  const plan = app.planMemoryCandidateBacklogAudit({
    ...scope,
    asOf,
    limit: 20,
    maxProviderCalls: 2,
    staleAfterMs: 30 * 24 * 60 * 60 * 1000,
    charsPerToken: 4,
    estimatedOutputTokensPerCall: 200,
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 8,
  });

  assert.equal(plan.kind, 'memory_candidate_backlog_audit_plan');
  assert.equal(plan.readOnly, true);
  assert.equal(plan.providerInvoked, false);
  assert.equal(plan.provider.provider, 'synthetic_auditor');
  assert.equal(plan.inventory.scannedCount, 10);
  assert.equal(plan.inventory.exactCandidateDuplicateGroupCount, 1);
  assert.equal(plan.inventory.byClassification.exact_candidate_duplicate, 1);
  assert.equal(plan.inventory.byClassification.exact_durable_duplicate, 1);
  assert.equal(plan.inventory.byClassification.preference_policy, 1);
  assert.equal(plan.inventory.byClassification.audit_state_ineligible, 2);
  assert.equal(plan.inventory.byClassification.stale_suggested, 1);
  assert.ok(plan.inventory.byClassification.deterministic_triage >= 1);
  assert.equal(plan.inventory.plannedProviderCallCount, 2);
  assert.equal(plan.costEstimate.plannedBatch.providerCalls, 2);
  assert.ok(plan.costEstimate.plannedBatch.inputChars > 0);
  assert.ok(plan.costEstimate.plannedBatch.estimatedInputTokens > 0);
  assert.equal(plan.costEstimate.plannedBatch.estimatedOutputTokens, 400);
  assert.ok(plan.costEstimate.plannedBatch.estimatedUsd > 0);
  assert.equal(plan.costEstimate.assumptions.pricingSource, 'caller_supplied');
  assert.equal(plan.candidates.find((item) => item.key === 'one-off-status').staleSuggested, true);
  assert.equal(plan.candidates.find((item) => item.key === 'preference-note').staleSuggested, true);
  const weakOld = plan.candidates.find((item) => item.key === 'weak-old-runbook');
  assert.equal(weakOld.staleSuggested, true);
  assert.equal(weakOld.plannedProviderCall, false);
  assert.equal(plan.plannedCandidateIds.includes(weakOld.candidateId), false);
  assert.equal(plan.candidates.find((item) => item.key === 'active-queued').staleSuggested, false);
  assert.equal(auditInvocations, 0);
  assert.equal(app.listMemoryCandidateAuditAttempts({
    ...scope,
    candidateId: indexed[0].id,
  }).length, 0);
  assert.equal(app.listMemoryCandidates({ ...scope, sessionId, status: 'pending', limit: 20 }).length, 10);

  const keyCollision = indexed.find((item) => item.candidate.key === 'key-collision');
  const collisionPlan = app.planMemoryCandidateBacklogAudit({
    ...scope,
    candidateIds: [keyCollision.id],
    maxProviderCalls: 1,
  });
  assert.equal(collisionPlan.candidates[0].classification, 'provider_audit');
  assert.equal(collisionPlan.candidates[0].plannedProviderCall, true);
  assert.equal(collisionPlan.candidates[0].reasonCodes.includes('durable_key_collision'), true);

  const oldestPage = app.listMemoryCandidates({ ...scope, sessionId, status: 'pending', sort: 'oldest', page: true, limit: 1 });
  const nextOldestPage = app.listMemoryCandidates({
    ...scope, sessionId, status: 'pending', sort: 'oldest', page: true, limit: 1, cursor: oldestPage.page.nextCursor,
  });
  assert.equal(oldestPage.items.length, 1);
  assert.equal(nextOldestPage.items.length, 1);
  assert.notEqual(oldestPage.items[0].id, nextOldestPage.items[0].id);

  assert.throws(
    () => app.planMemoryCandidateBacklogAudit({
      ...scope,
      inputUsdPerMillionTokens: 2,
    }),
    /must be supplied together/,
  );
  assert.throws(
    () => app.planMemoryCandidateBacklogAudit({ ...scope, maxProviderCalls: 11 }),
    /no greater than 10/,
  );
  app.close();
});

test('candidate backlog audit plan reports missing explicit ids and has a scoped review contract', async () => {
  const operation = operationByName('planMemoryCandidateBacklogAudit');
  assert.deepEqual(
    {
      capability: operation.capability,
      scopeMode: operation.scopeMode,
      mcpTool: operation.mcp.tool,
      readOnlyHint: operation.mcp.annotations.readOnlyHint,
    },
    {
      capability: 'review',
      scopeMode: 'scoped',
      mcpTool: 'plan_memory_candidate_backlog_audit',
      readOnlyHint: true,
    },
  );
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const plan = app.planMemoryCandidateBacklogAudit({
    scope: 'repo',
    scopeKey: 'empty-plan-repo',
    candidateIds: ['missing-candidate'],
  });
  assert.deepEqual(plan.inventory.missingCandidateIds, ['missing-candidate']);
  assert.equal(plan.inventory.scannedCount, 0);
  assert.equal(plan.policy.scanLimit, 1);
  assert.equal(plan.policy.requestedScanLimit, 100);
  assert.equal(plan.costEstimate.plannedBatch.providerCalls, 0);
  app.close();
});
