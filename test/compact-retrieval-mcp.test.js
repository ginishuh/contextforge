import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createContextForge } from '../src/core.js';
import { startContextForgeServer } from '../src/server.js';
import { makeTempDir } from './helpers/temp.js';

function resultOf(toolResult) {
  return toolResult.structuredContent.result;
}

function itemsOf(result) {
  return Array.isArray(result) ? result : result.items;
}

async function startSyntheticMcp() {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'compact_fixture',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
    },
    cwd: process.cwd(),
    distillProviders: {
      compact_fixture: async () => ({
        summaryShort: 'Compact checkpoint marker.',
        summaryText: 'The compact checkpoint detail pointer must return this exact scoped checkpoint.',
        decisions: ['Keep compact retrieval bounded.'],
        todos: [],
        openQuestions: [],
        memoryCandidates: [{
          key: 'compact.candidate',
          content: 'Compact candidate marker for exact scoped detail retrieval.',
          category: 'runbook',
          reason: 'Synthetic MCP compact retrieval test.',
        }],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });
  const scope = { scope: 'repo', scopeKey: 'compact-mcp-repo' };
  app.remember({ ...scope, key: 'compact.memory', content: 'Compact memory marker for exact detail retrieval.' });
  app.appendRaw({
    ...scope,
    sessionId: 'codex:compact-mcp-session',
    role: 'assistant',
    content: 'Create a compact checkpoint candidate marker.',
  });
  const checkpoint = await app.distillCheckpoint({ ...scope, sessionId: 'codex:compact-mcp-session' });
  const candidate = itemsOf(app.listMemoryCandidates({ ...scope, checkpointId: checkpoint.id }))[0];
  const remote = await startContextForgeServer({
    app,
    port: 0,
    env: { CONTEXTFORGE_REMOTE_TOKEN: 'compact-test-token' },
  });
  const client = new Client({ name: 'compact-retrieval-mcp-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer compact-test-token' } },
  });
  await client.connect(transport);
  return { app, candidate, checkpoint, client, remote, scope };
}

async function closeSyntheticMcp({ app, client, remote }) {
  await client.close();
  await remote.close();
  app.close();
}

test('MCP HTTP compact retrieval defaults to bounded detail pointers and full remains compatible', async () => {
  const fixture = await startSyntheticMcp();
  const { candidate, checkpoint, client, scope } = fixture;
  try {
    const bootstrapTool = await client.callTool({
      name: 'bootstrap_context',
      arguments: { ...scope, query: 'compact memory marker', maxChars: 2000 },
    });
    const bootstrap = resultOf(bootstrapTool);
    assert.equal(bootstrap.responseMode, 'compact');
    assert.equal(bootstrap.kind, 'bootstrap_context');
    assert.ok(JSON.stringify(bootstrap).length <= bootstrap.budget.maxChars);
    assert.equal(bootstrapTool.content[0].text, JSON.stringify(bootstrap));
    assert.ok(bootstrap.results.every((item) => item.detail?.tool && item.detail?.arguments?.scopeKey === scope.scopeKey));
    assert.equal(bootstrap.handoffStatus, 'not_requested');

    const compactSearchTool = await client.callTool({
      name: 'search',
      arguments: { ...scope, query: 'compact marker', maxChars: 2000 },
    });
    const compactSearch = resultOf(compactSearchTool);
    assert.equal(compactSearch.responseMode, 'compact');
    assert.equal(compactSearch.kind, 'search_results');
    assert.ok(JSON.stringify(compactSearch).length <= compactSearch.budget.maxChars);
    assert.equal(compactSearchTool.content[0].text, JSON.stringify(compactSearch));

    const memory = compactSearch.results.find((item) => item.type === 'memory');
    assert.deepEqual(memory.detail, { tool: 'get_memory', arguments: { scope: 'repo', scopeKey: scope.scopeKey, key: 'compact.memory' } });

    const resume = resultOf(await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        ...scope, query: 'compact checkpoint marker', consultReason: 'resume',
        sessionId: 'codex:compact-mcp-session', maxChars: 2000,
      },
    }));
    assert.equal(resume.handoffStatus, 'matched_session');
    assert.deepEqual(resume.handoff.detail, { tool: 'list_checkpoints', arguments: { scope: 'repo', scopeKey: scope.scopeKey, checkpointId: checkpoint.id } });
    const checkpointDetail = resultOf(await client.callTool({ name: resume.handoff.detail.tool, arguments: resume.handoff.detail.arguments }));
    assert.equal(itemsOf(checkpointDetail).length, 1);
    assert.equal(itemsOf(checkpointDetail)[0].id, checkpoint.id);
    const candidateDetail = resultOf(await client.callTool({
      name: 'list_memory_candidates', arguments: { ...scope, candidateId: candidate.id },
    }));
    assert.equal(itemsOf(candidateDetail).length, 1);
    assert.equal(itemsOf(candidateDetail)[0].id, candidate.id);
    const memoryDetail = resultOf(await client.callTool({ name: memory.detail.tool, arguments: memory.detail.arguments }));
    assert.equal(memoryDetail.key, 'compact.memory');

    const fullSearch = resultOf(await client.callTool({
      name: 'search', arguments: { ...scope, query: 'compact marker', responseMode: 'full' },
    }));
    assert.ok(Array.isArray(fullSearch));
    const fullBootstrap = resultOf(await client.callTool({
      name: 'bootstrap_context', arguments: { ...scope, query: 'compact marker', responseMode: 'full' },
    }));
    assert.ok(Array.isArray(fullBootstrap.results));
    assert.equal(fullBootstrap.memoryMap.kind, 'memory_map');
  } finally {
    await closeSyntheticMcp(fixture);
  }
});

test('MCP HTTP compact bootstrap retains canonical remote access metadata within its budget', async () => {
  const fixture = await startSyntheticMcp();
  const { client, scope } = fixture;
  try {
    const toolResult = await client.callTool({
      name: 'bootstrap_context',
      arguments: { ...scope, query: 'compact memory marker', maxChars: 2000 },
    });
    const result = resultOf(toolResult);
    assert.equal(result.responseMode, 'compact');
    assert.ok(JSON.stringify(result).length <= result.budget.maxChars);
    assert.equal(result.storage.mode, 'project-local');
    assert.equal(result.storage.connection.accessMode, 'remote-client');
    assert.equal(result.storage.connection.accessPath, 'http-mcp');
    assert.equal(result.storage.connection.storageAuthority, 'canonical');
    assert.match(result.storage.connection.summary, /remote-client over http-mcp/);
  } finally {
    await closeSyntheticMcp(fixture);
  }
});
