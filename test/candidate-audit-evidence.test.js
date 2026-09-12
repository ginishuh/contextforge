import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';
import { candidateAuditEvidence } from '../src/memory/candidate_audit_evidence.js';
import { auditAutoPromotionCandidate } from '../src/memory/candidate_promotion.js';
import { processApprovedMemoryCandidates } from '../src/memory/approved_candidate_promotion.js';

const scope = { scopeType: 'repo', scopeKey: 'github.com/example/audit-evidence' };
const sessionId = 'codex:evidence-test';

for (const scenario of ['long_candidate', 'event_limit', 'event_chars', 'total_chars', 'missing_event']) {
  test(`incomplete evidence holds all automatic actions and preserves durable memory: ${scenario}`, async (t) => {
    const store = new ContextForgeStore({ dataDir: await makeTempDir() });
    t.after(() => store.close());
    const original = 'Preserve source evidence when distillation fails.';
    const target = store.rememberMemory({ ...scope, key: 'source-contract', content: original, category: 'runbook' });
    const count = scenario === 'event_limit' ? 9 : scenario === 'total_chars' ? 7 : 1;
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const content = scenario === 'event_chars' ? 'Evidence. '.repeat(300)
        : scenario === 'total_chars' ? 'Evidence. '.repeat(200)
          : index === 8 ? 'Correction: withdraw the earlier instruction.' : original;
      const event = store.appendRawEvent({ ...scope, sessionId, role: 'user', content });
      store.db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?')
        .run(`2026-01-01T00:00:0${index}.000Z`, event.id);
      ids.push(event.id);
    }
    if (scenario === 'missing_event') ids.push('missing-event');
    const checkpoint = store.insertCheckpoint({ ...scope, sessionId, provider: 'synthetic',
      summaryShort: 'Source contract.', summaryText: original,
      metadata: { sourceRawEventIds: ids, memoryCandidates: [{
        key: 'source-contract', content: scenario === 'long_candidate' ? original.repeat(100) : original,
        category: 'runbook', sourceEventIds: ids,
      }] },
    });
    const [indexed] = store.listMemoryCandidates({ ...scope, checkpointId: checkpoint.id });
    const evidence = candidateAuditEvidence(store, scope, indexed, checkpoint);
    assert.equal(evidence.citedEventCount, ids.length);
    assert.equal(evidence.returnedEventCount, evidence.rawEvents.length);
    assert.equal(evidence.omittedEventCount, ids.length - evidence.rawEvents.length);
    if (scenario === 'long_candidate') assert.equal(evidence.candidateContentTruncated, true);
    else assert.equal(evidence.rawEvidenceIncomplete, true);
    if (scenario === 'event_limit') {
      assert.equal(evidence.omittedEventCount, 1);
      assert.ok(!evidence.rawEvents.some((event) => event.id === ids[8]));
    }
    if (scenario === 'event_chars') assert.ok(evidence.truncatedEventCount > 0);
    if (scenario === 'total_chars') assert.ok(evidence.omittedEventCount > 0);
    const rejected = await auditAutoPromotionCandidate({ store, scope, providerConcurrencyLimit: 1,
      item: { candidate: indexed, warnings: [] },
      auditor: async () => ({ approved: false, decision: 'reject', reason: 'Unsupported claim.', riskCodes: [] }),
    });
    assert.equal(rejected.decision, 'reject');
    for (const action of ['new', 'update', 'duplicate', 'legacy']) {
      const audit = await auditAutoPromotionCandidate({ store, scope, providerConcurrencyLimit: 1,
        item: { candidate: indexed, warnings: [] },
        auditor: async ({ auditEvidence: e }) => ({
          approved: true, decision: 'approve', riskCodes: [], metadata: { provider: 'synthetic' },
          ...(action === 'legacy' ? {} : { promotion: {
            action, candidateRevisionHash: e.candidateRevisionHash,
            targetMemoryId: action === 'new' ? null : target.id,
            targetRevisionHash: action === 'new' ? null : e.relatedMemories[0].revisionHash,
            content: action === 'duplicate' ? null : action === 'new' ? indexed.candidate.content : 'Replacement contract.',
          } }),
        }),
      });
      assert.equal(audit.approved, false);
      assert.equal(audit.decision, 'needs_review');
      assert.equal(audit.promotion.action, 'hold');
      assert.ok(audit.riskCodes.includes('incomplete_audit_evidence'));
      store.markMemoryCandidateAudited({ ...scope, candidateId: indexed.id, audit });
      const finalized = processApprovedMemoryCandidates({ store, scope, options: { dryRun: false }, enabled: true,
        enqueueEmbeddings: () => assert.fail('Incomplete evidence must not enqueue a durable write.'),
      });
      assert.equal(finalized.processed, 0);
      assert.equal(store.getMemoryById({ ...scope, memoryId: target.id }).content, original);
      assert.equal(store.getMemoryCandidate({ ...scope, candidateId: indexed.id }).status, 'pending');
    }
  });
}

test('checkpoint fallback evidence reports a complete source window', async (t) => {
  const store = new ContextForgeStore({ dataDir: await makeTempDir() });
  t.after(() => store.close());
  const event = store.appendRawEvent({ ...scope, sessionId, role: 'user', content: 'Complete evidence.' });
  const evidence = candidateAuditEvidence(store, scope, { sessionId, candidate: { content: 'Complete candidate.' } },
    { metadata: { sourceRawEventIds: [event.id] } });
  assert.equal(evidence.rawEvidenceMode, 'checkpoint_source_window');
  assert.equal(evidence.rawEvidenceIncomplete, false);
  assert.equal(evidence.citedEventCount, 1);
  assert.equal(evidence.returnedEventCount, 1);
  assert.equal(evidence.omittedEventCount, 0);
  assert.equal(evidence.truncatedEventCount, 0);
});
