import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';
import { makeTempDir } from './helpers/temp.js';
import { processCandidateLifecycle } from '../src/memory/candidate_lifecycle_worker.js';
import { startContextForgeServer } from '../src/server.js';
import { processApprovedMemoryCandidates } from '../src/memory/approved_candidate_promotion.js';

async function fixture({ action = 'new', enabled = true, legacy = false, minBatchCandidates = 10, category = 'runbook', content = 'Retain source evidence when a distillation provider fails.' } = {}) {
  const dataDir = await makeTempDir();
  const source = { scope: 'repo', scopeKey: 'github.com/example/atlas', sessionId: 'codex:promotion-fixture' };
  const env = { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_DISTILL_PROVIDER: 'fixture',
    CONTEXTFORGE_AUTO_PROMOTE_ENABLED: String(enabled), CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: String(minBatchCandidates) };
  const app = createContextForge({ env, cwd: process.cwd(),
    autoPromoteAuditor: async ({ auditEvidence }) => ({
      approved: true, decision: 'approve', reason: 'Reviewed durable source contract.', riskCodes: [],
      metadata: { provider: 'fixture', model: 'fixture' },
      ...(!legacy ? { promotion: {
        action, candidateRevisionHash: auditEvidence.candidateRevisionHash,
        targetMemoryId: ['update', 'duplicate'].includes(action) ? auditEvidence.relatedMemories[0]?.id : null,
        targetRevisionHash: ['update', 'duplicate'].includes(action) ? auditEvidence.relatedMemories[0]?.revisionHash : null,
        content: ['new', 'update'].includes(action) ? content : null,
      } } : {}),
    }),
    distillProviders: { fixture: async ({ rawEvents }) => ({
      summaryShort: 'Durable source contract.', summaryText: content,
      decisions: [content], todos: [], openQuestions: [],
      memoryCandidates: [{ key: 'source-evidence-contract', content, category, candidateType: category,
        confidence: 0.95, stability: 0.95, sensitivity: 'low', promotionRecommendation: 'promote',
        sourceEventIds: [rawEvents[0].id] }],
    }) },
  });
  if (['update', 'duplicate'].includes(action)) {
    app.remember({ ...source, key: 'source-evidence-contract', category: 'runbook',
      content: action === 'duplicate' ? content : 'Keep source evidence while distilling.' });
  }
  app.appendRaw({ ...source, role: 'user', content });
  const checkpoint = await app.distillCheckpoint(source);
  await app.auditMemoryCandidates({ ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' });
  const store = new ContextForgeStore({ dataDir });
  const scope = { scopeType: 'repo', scopeKey: source.scopeKey };
  const [candidate] = store.listMemoryCandidates(scope);
  return { app, env, dataDir, source, scope, candidate, store, checkpoint };
}

test('lifecycle completes audited memory promotion and a fresh session retrieves persisted memory', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const dry = f.app.processApprovedMemoryCandidates(f.source);
  assert.equal(dry.results[0].action, 'new');
  assert.equal(f.store.listMemories(f.scope).length, 0);
  const iteration = await processCandidateLifecycle(f.app, { ...f.source, dryRun: false });
  assert.equal(iteration.failedScopes, 0);
  assert.equal(iteration.scopes[0].promotion.promoted, 1);
  const stored = f.store.getMemoryCandidate({ ...f.scope, candidateId: f.candidate.id });
  assert.equal(stored.status, 'promoted');
  assert.ok(stored.promotedMemoryId);
  const fresh = createContextForge({ env: f.env, cwd: process.cwd() });
  const found = await fresh.search({ ...f.source, sessionId: 'codex:next-session', query: 'source evidence distillation provider fails' });
  assert.ok(found.some((item) => item.type === 'memory' && item.memory.key === 'source-evidence-contract'));
  const second = fresh.processApprovedMemoryCandidates({ ...f.source, dryRun: false });
  assert.equal(second.promoted, 0);
  assert.equal(f.store.listMemories(f.scope).length, 1);
  const events = f.store.db.prepare("SELECT * FROM memory_events WHERE event_type = 'promote'").all();
  assert.equal(events.length, 1);
  const attempts = f.store.listMemoryCandidateAuditAttempts({ ...f.scope, candidateId: f.candidate.id });
  assert.equal(attempts[0].metadata.promotion.action, 'new');
});

test('automatic promotion requires server enablement and the explicit candidate scope', async (t) => {
  const f = await fixture({ enabled: false }); t.after(() => f.store.close());
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).reason, 'automatic_promotion_disabled');
  assert.equal(f.store.listMemories(f.scope).length, 0);
  assert.throws(() => f.app.processApprovedMemoryCandidates({ dryRun: false }), /scopeKey/);
  const wrongScope = f.app.processApprovedMemoryCandidates({ ...f.source, scopeKey: 'github.com/example/boreal', candidateIds: [f.candidate.id] });
  assert.equal(wrongScope.results.length, 0);
});

test('audited duplicate links to existing memory without creating another durable row', async (t) => {
  const f = await fixture({ action: 'duplicate' }); t.after(() => f.store.close());
  const result = f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false });
  assert.equal(result.linked, 1, JSON.stringify(result));
  assert.equal(f.store.listMemories(f.scope).length, 1);
  const candidate = f.store.getMemoryCandidate({ ...f.scope, candidateId: f.candidate.id });
  assert.equal(candidate.status, 'rejected');
  assert.equal(candidate.reviewMetadata.coveredByMemoryId, result.results[0].memoryId);
});

test('audited replacement is applied exactly with provenance and an applied update proposal', async (t) => {
  const f = await fixture({ action: 'update' }); t.after(() => f.store.close());
  const result = f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false });
  assert.equal(result.updated, 1, JSON.stringify(result));
  const memory = f.store.getMemory({ ...f.scope, key: 'source-evidence-contract' });
  assert.equal(memory.content, f.candidate.candidate.content);
  const update = f.store.listMemoryUpdateCandidates(f.scope).find((item) => item.status === 'applied');
  assert.equal(update.proposedContent, memory.content);
  assert.equal(update.appliedMemoryId, memory.id);
  assert.equal(f.store.getMemoryCandidate({ ...f.scope, candidateId: f.candidate.id }).status, 'promoted');
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).updated, 0);
});

test('changed update target is held and does not monopolize subsequent worker batches', async (t) => {
  const f = await fixture({ action: 'update' }); t.after(() => f.store.close());
  f.app.remember({ ...f.source, key: 'source-evidence-contract', content: 'A separately reviewed newer contract.' });
  const result = f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false });
  assert.equal(result.held, 1);
  assert.equal(result.results[0].reason, 'target_revision_changed');
  assert.equal(f.store.getMemory({ ...f.scope, key: 'source-evidence-contract' }).content, 'A separately reviewed newer contract.');
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).processed, 0);
});

test('changed candidate revision and unaudited decisions cannot become durable memory', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  f.store.db.prepare('UPDATE memory_candidate_index SET candidate_content = ? WHERE id = ?')
    .run('Unreviewed replacement text.', f.candidate.id);
  const result = f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false });
  assert.equal(result.results[0].reason, 'audit_revision_mismatch');
  assert.equal(f.store.listMemories(f.scope).length, 0);
  f.store.db.prepare("UPDATE memory_candidate_index SET audit_state = 'unaudited', audit_decision = NULL WHERE id = ?").run(f.candidate.id);
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).processed, 0);
});

test('legacy approvals can promote new facts but cannot overwrite an existing memory', async (t) => {
  const f = await fixture({ legacy: true }); t.after(() => f.store.close());
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).promoted, 1);
  const update = await fixture({ action: 'update', legacy: true }); t.after(() => update.store.close());
  const held = update.app.processApprovedMemoryCandidates({ ...update.source, dryRun: false });
  assert.equal(held.results[0].reason, 'needs_action_audit');
});

test('failed promotion transaction preserves the candidate and can be retried without a partial memory', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const failed = processApprovedMemoryCandidates({
    store: f.store, scope: f.scope, options: { dryRun: false }, enabled: true,
    enqueueEmbeddings: () => { throw new Error('synthetic enqueue failure'); },
  });
  assert.equal(failed.failed, 1);
  assert.equal(f.store.listMemories(f.scope).length, 0);
  assert.equal(f.store.getMemoryCandidate({ ...f.scope, candidateId: f.candidate.id }).status, 'pending');
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).promoted, 1);
});

test('an audit result cannot approve a candidate revision that changed while the provider ran', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const audit = f.candidate.reviewMetadata.audit;
  f.store.db.prepare('UPDATE memory_candidate_index SET candidate_content = ? WHERE id = ?')
    .run('Content changed during provider execution.', f.candidate.id);
  assert.throws(() => f.store.markMemoryCandidateAudited({ ...f.scope, candidateId: f.candidate.id, audit }),
    /changed while its audit was running/);
  assert.equal(f.store.listMemoryCandidateAuditAttempts({ ...f.scope, candidateId: f.candidate.id }).length, 1);
});

test('remote worker finalization is authorized by capability and scope and is idempotent under concurrent requests', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const server = await startContextForgeServer({ app: f.app, port: 0, env: {
    OPERATOR_TOKEN: 'promotion-test-token', READER_TOKEN: 'promotion-reader-token',
    CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
      { id: 'operator', tokenEnv: 'OPERATOR_TOKEN', capabilities: ['operator', 'read'], scopes: [`repo:${f.scope.scopeKey}`] },
      { id: 'reader', tokenEnv: 'READER_TOKEN', capabilities: ['read'], scopes: [`repo:${f.scope.scopeKey}`] },
    ]),
  } });
  t.after(() => server.close());
  const remote = createContextForge({ env: {
    CONTEXTFORGE_STORAGE_MODE: 'remote', CONTEXTFORGE_REMOTE_URL: server.url,
    CONTEXTFORGE_REMOTE_TOKEN: 'promotion-test-token',
  } });
  const unauthorized = await fetch(`${server.url}/v0/processApprovedMemoryCandidates`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...f.source, dryRun: false }),
  });
  assert.equal(unauthorized.status, 401);
  for (const [token, scopeKey] of [['promotion-reader-token', f.scope.scopeKey], ['promotion-test-token', 'github.com/example/boreal']]) {
    const denied = await fetch(`${server.url}/v0/processApprovedMemoryCandidates`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...f.source, scopeKey, dryRun: false }),
    });
    assert.equal(denied.status, 403);
  }
  const results = await Promise.all([1, 2].map(() => remote.processApprovedMemoryCandidates({ ...f.source, dryRun: false })));
  assert.equal(results.reduce((sum, result) => sum + result.promoted, 0), 1);
  const retrieved = await remote.getMemory({ ...f.source, key: 'source-evidence-contract' });
  assert.equal(retrieved.content, f.candidate.candidate.content);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM memory_events WHERE event_type = 'promote'").get().n, 1);
});


test('architecture_decision produced by distillation reaches audit and durable promotion', async (t) => {
  const f = await fixture({ category: 'architecture_decision' }); t.after(() => f.store.close());
  assert.equal(f.candidate.auditDecision, 'approve');
  assert.equal(f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false }).promoted, 1);
});


test('an approved hold does not become a failed checkpoint or a direct automatic write', async (t) => {
  const f = await fixture({ action: 'hold', minBatchCandidates: 1 }); t.after(() => f.store.close());
  assert.equal(f.checkpoint.candidateAudit.audited, 1);
  assert.equal(f.checkpoint.candidateAudit.promoted, 0);
  assert.equal(f.checkpoint.candidateAudit.error, null);
  assert.equal(f.store.listMemories(f.scope).length, 0);
  const result = f.app.processApprovedMemoryCandidates({ ...f.source, dryRun: false });
  assert.equal(result.held, 1);
  assert.equal(result.results[0].reason, 'audit_requires_review');
});
