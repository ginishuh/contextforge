import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createContextForge } from '../src/core.js';
import { startContextForgeServer } from '../src/server.js';
import { makeTempDir } from './helpers/temp.js';

test('HTTP MCP defaults to one compact handoff with an exact full-evidence pointer', async (t) => {
  const scope = { scope: 'repo', scopeKey: 'github.com/example/bootstrap' };
  const sessionId = 'codex:bootstrap-test';
  const evidence = `Retry evidence. ${'Keep the same request identity. '.repeat(300)} END_OF_EVIDENCE`;
  const app = createContextForge({
    cwd: process.cwd(),
    env: { CONTEXTFORGE_DATA_DIR: await makeTempDir(), CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
      CONTEXTFORGE_DISTILL_PROVIDER: 'fixture' },
    distillProviders: { fixture: async () => ({
      summaryShort: 'Resume retry work.', summaryText: evidence,
      decisions: ['Keep request identity.'], todos: ['Verify the request.'],
      openQuestions: [], memoryCandidates: [],
    }) },
  });
  app.appendRaw({ ...scope, sessionId, role: 'user', content: 'Review retry behavior.' });
  await app.distillCheckpoint({ ...scope, sessionId });
  const remote = await startContextForgeServer({ app, port: 0,
    env: { CONTEXTFORGE_REMOTE_TOKEN: 'synthetic-test-token' } });
  const client = new Client({ name: 'compact-bootstrap-test', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer synthetic-test-token' } },
    }));
    const args = { ...scope, sessionId, query: 'retry', consultReason: 'resume' };
    const response = await client.callTool({ name: 'bootstrap_context', arguments: args });
    assert.equal(response.isError, undefined);
    const compact = response.structuredContent.result;
    assert.equal(compact.responseMode, 'compact');
    assert.equal(compact.handoffStatus, 'matched_session');
    assert.equal(compact.handoff.sessionId, sessionId);
    assert.ok(compact.results.every((item) => item.id !== compact.handoff.id));
    assert.equal('latestByAgent' in compact.handoff, false);
    assert.equal('latestCheckpoints' in compact.handoff, false);
    assert.deepEqual(JSON.parse(response.content[0].text), compact);
    assert.ok(response.content[0].text.length <= compact.budget.maxChars);
    const detail = await client.callTool({ name: compact.handoff.detail.tool,
      arguments: compact.handoff.detail.arguments });
    assert.equal(detail.structuredContent.result[0].summaryText, evidence);
    const fullResponse = await client.callTool({ name: 'bootstrap_context',
      arguments: { ...args, responseMode: 'full' } });
    const full = fullResponse.structuredContent.result;
    assert.equal(full.handoff.latestHandoff.id, compact.handoff.id);
    assert.equal(full.handoff.latestHandoff.summaryText,
      (await app.bootstrapContext(args)).handoff.latestHandoff.summaryText);
    assert.ok(response.content[0].text.length < JSON.stringify(full).length * 0.3);
    t.diagnostic(`HTTP MCP JSON: compact=${response.content[0].text.length}, full=${JSON.stringify(full).length}`);
  } finally {
    await client.close();
    await remote.close();
  }
});
