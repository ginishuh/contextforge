import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { compactRetrievalResponse } from '../src/application/compact_retrieval.js';
import { makeTempDir } from './helpers/temp.js';

const scope = { scope: 'repo', scopeKey: 'github.com/example/compact' };

async function fixture() {
  const app = createContextForge({
    cwd: process.cwd(),
    env: { CONTEXTFORGE_DATA_DIR: await makeTempDir(), CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
      CONTEXTFORGE_DISTILL_PROVIDER: 'fixture' },
    distillProviders: { fixture: async ({ rawEvents }) => {
      const sessionId = rawEvents[0].sessionId;
      return {
      summaryShort: `Resume ${sessionId}.`,
      summaryText: `Complete evidence for ${sessionId}. ${'Details. '.repeat(500)} END_OF_EVIDENCE`,
      decisions: ['Keep request identity stable across retries.'],
      todos: ['Verify the existing request before creating another.'],
      openQuestions: [],
      memoryCandidates: [{ key: `rule-${sessionId}`, content: 'Keep idempotency keys.', reason: 'Reusable contract.' }],
      structured: { schemaVersion: 'contextforge.structured_checkpoint.v1',
        work: { intent: `Continue ${sessionId}`, status: 'in_progress', outcome: 'Retry contract identified.' },
        nextActions: [{ action: 'Read the existing request.', reason: 'A timeout can hide success.' }] },
      };
    } },
  });
  async function checkpoint(sessionId) {
    app.appendRaw({ ...scope, sessionId, role: 'user', content: `Work on ${sessionId}.` });
    await app.distillCheckpoint({ ...scope, sessionId });
    return app.listCheckpoints({ ...scope, sessionId })[0];
  }
  return { app, checkpoint };
}

test('compact bootstrap does not present an unrelated latest checkpoint as current work', async () => {
  const { app, checkpoint } = await fixture();
  const older = await checkpoint('request-retry');
  await checkpoint('unrelated-style-change');
  const start = await app.bootstrapContext({ ...scope, query: 'retry', consultReason: 'startup', responseMode: 'compact' });
  assert.equal(start.handoff, null);
  assert.equal(start.handoffStatus, 'not_requested');
  assert.equal('memoryMap' in start, false);
  assert.equal('memoryLifecycle' in start, false);

  const resume = await app.bootstrapContext({ ...scope, query: 'retry', consultReason: 'resume',
    sessionId: 'request-retry', responseMode: 'compact' });
  assert.equal(resume.handoff.id, older.id);
  assert.equal(resume.handoff.context.intent, 'Continue request-retry');
  assert.equal(resume.handoff.context.nextActions[0], 'Read the existing request.');
  const detail = app.listCheckpoints(resume.handoff.detail.arguments);
  assert.equal(detail.length, 1);
  assert.match(detail[0].summaryText, /END_OF_EVIDENCE/);
  assert.deepEqual(app.listCheckpoints({ ...resume.handoff.detail.arguments, scopeKey: 'other-repo' }), []);
  const unknown = await app.bootstrapContext({ ...scope, query: 'retry', consultReason: 'resume',
    responseMode: 'compact' });
  assert.equal(unknown.handoffStatus, 'session_required');
  assert.equal(unknown.handoff, null);
});

test('compact search respects total JSON budget and leaves exact durable detail links', async () => {
  const { app } = await fixture();
  for (let index = 0; index < 12; index += 1) {
    app.remember({ ...scope, key: `retry-${index}`, content: `Retry contract ${index}. ${'Evidence '.repeat(400)} END` });
  }
  const result = await app.search({ ...scope, query: 'retry', limit: 12, responseMode: 'compact', maxChars: 2000 });
  assert.ok(JSON.stringify(result).length <= 2000);
  assert.ok(result.results.length > 0);
  assert.equal(result.budget.truncated, true);
  assert.ok(result.budget.omittedResults > 0);
  for (const item of result.results) {
    assert.equal(item.detail.tool, 'get_memory');
    assert.match(app.getMemory(item.detail.arguments).content, / END$/);
    assert.equal(item.excerpted, true);
  }
  const full = await app.search({ ...scope, query: 'retry', limit: 12 });
  assert.ok(Array.isArray(full));
  assert.equal(full.length, 12);
  assert.match(full[0].memory.content, / END$/);
});

test('full bootstrap preserves the legacy handoff and memory map contract', async (t) => {
  const { app, checkpoint } = await fixture();
  const latest = await checkpoint('legacy');
  const full = await app.bootstrapContext({ ...scope, query: 'legacy' });
  assert.equal(full.handoff.latestHandoff.id, latest.id);
  assert.ok(full.memoryMap);
  assert.ok(full.memoryLifecycle);
  const compact = await app.bootstrapContext({ ...scope, query: 'legacy', sessionId: 'legacy',
    consultReason: 'resume', responseMode: 'compact' });
  const fullChars = JSON.stringify(full).length;
  const compactChars = JSON.stringify(compact).length;
  assert.ok(compactChars < fullChars * 0.3);
  t.diagnostic(`Synthetic bootstrap JSON: full=${fullChars}, compact=${compactChars}, reduction=${Math.round((1 - compactChars / fullChars) * 100)}%`);
});

test('compact results deduplicate identities without crossing scopes and retain candidate detail', async () => {
  const { app, checkpoint } = await fixture();
  const cp = await checkpoint('candidate');
  const candidate = app.listMemoryCandidates({ ...scope, checkpointId: cp.id })[0];
  assert.ok(candidate);
  const source = { scopeType: scope.scope, scopeKey: scope.scopeKey };
  const row = { type: 'memory_candidate', candidate, source };
  const response = compactRetrievalResponse({ scope: source, options: {}, results: [row, row,
    { ...row, source: { ...source, scopeKey: 'github.com/example/other' } }] });
  assert.equal(response.results.length, 2);
  const pointer = response.results[0].detail;
  assert.equal(pointer.tool, 'list_memory_candidates');
  assert.equal(app.listMemoryCandidates(pointer.arguments)[0].id, candidate.id);
  assert.deepEqual(app.listMemoryCandidates({ ...pointer.arguments, scopeKey: 'other-repo' }), []);
});

test('compact options reject invalid modes and budgets before retrieval', async () => {
  const { app } = await fixture();
  assert.throws(() => app.search({ ...scope, query: 'retry', responseMode: 'tiny' }), /responseMode/);
  await assert.rejects(app.bootstrapContext({ ...scope, query: 'retry', responseMode: 'compact', maxChars: 100 }), /maxChars/);
  assert.throws(() => app.search({ ...scope, query: 'retry', responseMode: 'compact', maxChars: 2000.5 }), /maxChars/);
});

test('workspace routing diagnostics cannot crowd all useful results out of the compact budget', () => {
  const source = { scopeType: 'repo', scopeKey: scope.scopeKey, workspaceKey: 'suite', memberName: 'api' };
  const response = compactRetrievalResponse({ scope: source,
    options: { maxChars: 2000, workspaceKey: 'suite' },
    results: [{ type: 'memory', memory: { id: 'm1', key: 'retry', content: 'Use stable request keys.' }, source }],
    workspace: { warnings: ['Diagnostic '.repeat(500)] },
  });
  assert.ok(JSON.stringify(response).length <= 2000);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].source.workspaceKey, 'suite');
  assert.equal(response.workspace.omittedByBudget, true);
});
