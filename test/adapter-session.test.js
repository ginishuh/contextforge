import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { adapterSessionFromEnv, withAdapterSession } from '../src/application/adapter_session.js';
import { createContextForge } from '../src/core.js';
import { startContextForgeServer } from '../src/server.js';
import { makeTempDir } from './helpers/temp.js';

const execFileAsync = promisify(execFile);
const scope = { scope: 'repo', scopeKey: 'github.com/example/adapter-project' };
const resultOf = (value) => value.structuredContent?.result || JSON.parse(value.content[0].text);

function syntheticEnv(dataDir) {
  return {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_STORAGE_MODE: 'local',
    CONTEXTFORGE_DISTILL_PROVIDER: 'mock', CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
    CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'false', CONTEXTFORGE_MCP_PROFILE: 'agent-core',
    CONTEXTFORGE_MCP_TOOLS: '', CONTEXTFORGE_SESSION_ID: '',
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '',
  };
}

async function seedSession(app, sessionId, content) {
  app.appendRaw({ ...scope, sessionId, role: 'user', content });
  return app.distillCheckpoint({ ...scope, sessionId, provider: 'mock' });
}

test('adapter binding is explicit or native, never inferred from recent server sessions', () => {
  assert.equal(adapterSessionFromEnv({}), null);
  assert.equal(adapterSessionFromEnv({ CODEX_THREAD_ID: 'native-1', CODEX_SESSION_ID: 'legacy-1' }), 'codex:native-1');
  assert.equal(adapterSessionFromEnv({ CODEX_SESSION_ID: 'legacy-1' }), 'codex:legacy-1');
  assert.equal(adapterSessionFromEnv({ CLAUDE_CODE_SESSION_ID: 'native-2' }), 'claude_code:native-2');
  assert.equal(adapterSessionFromEnv({ CONTEXTFORGE_SESSION_ID: 'codex:explicit', CODEX_THREAD_ID: 'native-1' }), 'codex:explicit');
  assert.throws(() => adapterSessionFromEnv({ CODEX_THREAD_ID: 'a', CLAUDE_CODE_SESSION_ID: 'b' }), /Multiple adapter identities/);
  assert.throws(() => adapterSessionFromEnv({ CONTEXTFORGE_SESSION_ID: 'unqualified' }), /namespaced session ID/);
  assert.deepEqual(withAdapterSession('distillCheckpoint', scope, 'codex:bound'), { ...scope, sessionId: 'codex:bound' });
  for (const explicit of [{ sessionId: 'codex:other' }, { checkpointId: 'exact-checkpoint' }]) {
    assert.deepEqual(withAdapterSession('agentCloseout', explicit, 'codex:bound'), explicit);
  }
  // Exact detail pointers and operator inventories must not acquire a hidden session filter.
  assert.deepEqual(withAdapterSession('listCheckpoints', scope, 'codex:bound'), scope);
});

test('CLI evidence capture uses native adapter identity without creating a second session', async () => {
  const dataDir = await makeTempDir();
  const env = { ...syntheticEnv(dataDir), CODEX_THREAD_ID: 'cli-native' };
  await execFileAsync(process.execPath, ['src/cli.js', 'appendRaw', '--scope', 'repo', '--scopeKey', scope.scopeKey,
    '--role', 'user', '--content', 'Synthetic adapter-bound evidence.'], { env });
  const app = createContextForge({ env });
  try {
    const rows = app.listRawEvents({ ...scope, sessionId: 'codex:cli-native' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'Synthetic adapter-bound evidence.');
  } finally { app.close(); }
});

test('stdio default tools resume and checkpoint the native session without session arguments', async () => {
  const dataDir = await makeTempDir();
  const env = { ...syntheticEnv(dataDir), CODEX_THREAD_ID: 'stdio-native' };
  const app = createContextForge({ env });
  const checkpoint = await seedSession(app, 'codex:stdio-native', 'Adapter project feature is paused before verification.');
  await seedSession(app, 'codex:other', 'Unrelated newer work.');
  app.close();
  const client = new Client({ name: 'adapter-stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.js'], env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 10);
    assert.equal(tools.some((tool) => tool.name === 'begin_session'), false);
    const resume = resultOf(await client.callTool({ name: 'bootstrap_context', arguments: {
      ...scope, query: 'feature verification', consultReason: 'resume',
    } }));
    assert.equal(resume.handoff.id, checkpoint.id);
    const saved = resultOf(await client.callTool({ name: 'distill_checkpoint', arguments: { ...scope, provider: 'mock' } }));
    assert.equal(saved.sessionId, 'codex:stdio-native');
  } finally { await client.close(); }
});

test('HTTP adapter identity is isolated per request and ignores the shared server environment', async () => {
  const dataDir = await makeTempDir();
  const env = { ...syntheticEnv(dataDir), CONTEXTFORGE_SESSION_ID: 'codex:server-process', CONTEXTFORGE_REMOTE_TOKEN: 'adapter-test-token' };
  const app = createContextForge({ env });
  const a = await seedSession(app, 'codex:client-a', 'Client A continuation.');
  const b = await seedSession(app, 'codex:client-b', 'Client B continuation.');
  await seedSession(app, 'codex:server-process', 'Server-owned session must never be a client default.');
  const remote = await startContextForgeServer({ app, env, host: '127.0.0.1', port: 0 });
  const clients = [];
  async function connect(sessionId) {
    const client = new Client({ name: 'adapter-http-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer adapter-test-token',
        ...(sessionId ? { 'x-contextforge-session-id': sessionId } : {}) } },
    }));
    return client;
  }
  try {
    const [clientA, clientB, unbound] = await Promise.all([connect('codex:client-a'), connect('codex:client-b'), connect()]);
    const args = { ...scope, query: 'continuation', consultReason: 'resume' };
    const [resumeA, resumeB, noBinding] = await Promise.all([clientA, clientB, unbound].map(async (client) =>
      resultOf(await client.callTool({ name: 'bootstrap_context', arguments: args }))));
    assert.equal(resumeA.handoff.id, a.id);
    assert.equal(resumeB.handoff.id, b.id);
    assert.equal(noBinding.handoffStatus, 'session_required');
    const missing = await unbound.callTool({ name: 'distill_checkpoint', arguments: { ...scope, provider: 'mock' } });
    assert.equal(missing.isError, true);
    const explicit = resultOf(await clientA.callTool({ name: 'bootstrap_context', arguments: { ...args, sessionId: 'codex:client-b' } }));
    assert.equal(explicit.handoff.id, b.id);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await remote.close();
    app.close();
  }
});
