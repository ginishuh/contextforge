import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createContextForge } from '../src/core.js';
import { validateDistillOutput } from '../src/distill/validate.js';
import { watchCodexSessions } from '../src/ingest/codex.js';
import { searchMemories } from '../src/retrieval/search.js';
import { startContextForgeServer } from '../src/server.js';
import { SCHEMA_VERSION } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-test-'));
}

async function makeGitRepo(remoteUrl = 'git@github.com:example/contextforge.git') {
  const cwd = await makeTempDir();
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.git', 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
  return cwd;
}

async function writeSyntheticCodexRollout(filePath, sessionId = 'codex-rollout-session') {
  const records = [
    {
      timestamp: '2026-04-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: path.dirname(filePath),
      },
    },
    {
      timestamp: '2026-04-25T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Developer instructions should not be captured.' }],
      },
    },
    {
      timestamp: '2026-04-25T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Please continue the ContextForge ingest work.' }],
      },
    },
    {
      timestamp: '2026-04-25T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"npm test"}',
      },
    },
    {
      timestamp: '2026-04-25T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'tests passed',
      },
    },
    {
      timestamp: '2026-04-25T00:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I added Codex rollout ingestion.' }],
      },
    },
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

async function appendSyntheticCodexAssistantMessage(filePath, text) {
  const record = {
    timestamp: '2026-04-25T00:00:06.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`);
}

async function writeSyntheticSessionsTree(rootDir) {
  const first = path.join(rootDir, '2026', '04', '25', 'rollout-first.jsonl');
  const second = path.join(rootDir, '2026', '04', '25', 'rollout-second.jsonl');
  await fs.mkdir(path.dirname(first), { recursive: true });
  await writeSyntheticCodexRollout(first, 'codex-session-first');
  await writeSyntheticCodexRollout(second, 'codex-session-second');
  await fs.appendFile(second, '{"timestamp":"2026-04-25T00:00:06.000Z","type":"response_item"');
  return { first, second };
}

test('dbInfo initializes a fresh SQLite store', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const info = app.dbInfo();

  assert.equal(info.schemaVersion, SCHEMA_VERSION);
  assert.equal(info.tables.memories, 0);
  assert.match(info.dbPath, /contextforge\.db$/);
});

test('repo scope key defaults to normalized GitHub origin remote', async () => {
  const cwd = await makeGitRepo();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: path.join(cwd, 'data') }, cwd });

  assert.equal(app.config.defaultScopeKey, 'github.com/example/contextforge');

  const memory = app.remember({
    key: 'default-scope',
    content: 'Repo scope key can be inferred from origin remote.',
  });
  assert.equal(memory.scopeType, 'repo');
  assert.equal(memory.scopeKey, 'github.com/example/contextforge');
});

test('repo scope key falls back to a deterministic path key outside git', async () => {
  const cwd = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: path.join(cwd, 'data') }, cwd });

  assert.match(app.config.defaultScopeKey, /^path:[a-f0-9]{16}:contextforge-test-/);

  const explicit = app.remember({
    scope: 'repo',
    scopeKey: 'explicit/repo',
    key: 'explicit-scope',
    content: 'Explicit repo scope keys still win.',
  });
  assert.equal(explicit.scopeKey, 'explicit/repo');
});

test('repoPath and cwd resolve repo scope independently of the app cwd', async () => {
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/target-repo.git');
  const repoSubdir = path.join(repoPath, 'src');
  await fs.mkdir(repoSubdir);
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: path.join(appCwd, 'data') }, cwd: appCwd });

  const fromRepoPath = app.remember({
    scope: 'repo',
    repoPath,
    key: 'repo-path-memory',
    content: 'Repo path selects the target checkout.',
  });
  assert.equal(fromRepoPath.scopeKey, 'github.com/example/target-repo');

  const fromCwd = app.beginSession({
    scope: 'repo',
    cwd: repoSubdir,
    sessionId: 'repo-cwd-session',
  });
  assert.equal(fromCwd.scopeKey, 'github.com/example/target-repo');

  const explicit = app.remember({
    scope: 'repo',
    scopeKey: 'explicit/repo',
    repoPath,
    key: 'explicit-wins',
    content: 'Explicit scopeKey still wins over repoPath.',
  });
  assert.equal(explicit.scopeKey, 'explicit/repo');
});

test('default shared and local scopes get usable default keys', async () => {
  const cwd = await makeTempDir();
  const sharedApp = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: path.join(cwd, 'shared-data'),
      CONTEXTFORGE_DEFAULT_SCOPE: 'shared',
      CONTEXTFORGE_SHARED_SCOPE_KEY: 'team',
    },
    cwd,
  });
  const sharedMemory = sharedApp.remember({
    key: 'shared-default',
    content: 'Shared scope has a default key.',
  });
  assert.equal(sharedMemory.scopeType, 'shared');
  assert.equal(sharedMemory.scopeKey, 'team');

  const localApp = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: path.join(cwd, 'local-data'),
      CONTEXTFORGE_DEFAULT_SCOPE: 'local',
    },
    cwd,
  });
  assert.match(localApp.config.defaultScopeKey, /^path:[a-f0-9]{16}:contextforge-test-/);
});

test('remember, getMemory, and search use explicit scopes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const memory = app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'storage-mode',
    content: 'Use local SQLite in .contextforge for v0 runtime state.',
    category: 'decision',
    tags: ['storage', 'sqlite'],
    importance: 5,
  });

  assert.equal(memory.key, 'storage-mode');
  assert.equal(memory.scopeType, 'repo');

  const fetched = app.getMemory({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'storage-mode',
  });
  assert.equal(fetched.content, memory.content);

  const results = app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    query: 'sqlite runtime',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'storage-mode');
  assert.ok(results[0].why.some((hit) => hit.token === 'sqlite'));
});

test('promoteMemory writes durable memory with explicit provenance', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const memory = app.promoteMemory({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'promotion-rule',
    content: 'Checkpoint candidates require explicit promotion before becoming durable memory.',
    category: 'decision',
    tags: ['promotion'],
    importance: 3,
    sourceCheckpointId: 'checkpoint-1',
    sourceSessionId: 'session-1',
    sourceRawEventIds: ['raw-1'],
    reason: 'Reviewed during MCP implementation.',
  });

  assert.equal(memory.key, 'promotion-rule');
  assert.equal(memory.category, 'decision');

  const fetched = app.getMemory({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'promotion-rule',
  });
  assert.equal(fetched.content, memory.content);
});

test('memory candidates require explicit promotion and can be corrected or deactivated', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'Candidate checkpoint.',
        summaryText: 'The checkpoint proposes one durable memory candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'candidate-rule',
            content: 'Promote reviewed checkpoint candidates explicitly.',
            category: 'policy',
            tags: ['promotion'],
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
    role: 'assistant',
    content: 'Candidate: promote reviewed checkpoint candidates explicitly.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
  });

  assert.equal(
    app.getMemory({
      scope: 'repo',
      scopeKey: 'repo-promote',
      key: 'candidate-rule',
    }),
    null,
  );

  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].checkpointId, checkpoint.id);
  assert.equal(candidates[0].index, 0);
  assert.equal(candidates[0].candidate.key, 'candidate-rule');

  const promoted = app.promoteMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: candidates[0].candidate.key,
    content: candidates[0].candidate.content,
    category: candidates[0].candidate.category,
    tags: candidates[0].candidate.tags,
    sourceCheckpointId: candidates[0].checkpointId,
    sourceSessionId: candidates[0].sessionId,
    sourceCandidateIndex: candidates[0].index,
    reason: 'Reviewed synthetic candidate.',
  });
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.key, 'candidate-rule');

  const promoteEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
  });
  assert.equal(promoteEvents.length, 1);
  assert.equal(promoteEvents[0].eventType, 'promote');
  assert.equal(promoteEvents[0].metadata.sourceCheckpointId, checkpoint.id);
  assert.equal(promoteEvents[0].metadata.sourceCandidateIndex, 0);

  const corrected = app.correctMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
    content: 'Promote reviewed checkpoint candidates explicitly after human or agent review.',
    reason: 'Clarify review requirement.',
  });
  assert.equal(corrected.supersedesMemoryId, promoted.id);
  assert.match(corrected.content, /agent review/);

  const correctEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
  });
  assert.equal(correctEvents.length, 2);
  assert.equal(correctEvents[1].eventType, 'correct');
  assert.equal(correctEvents[1].metadata.previousContent, promoted.content);

  const searchBeforeDeactivate = app.search({
    scope: 'repo',
    scopeKey: 'repo-promote',
    query: 'agent review',
  });
  assert.equal(searchBeforeDeactivate.length, 1);
  assert.equal(searchBeforeDeactivate[0].memory.key, 'candidate-rule');

  const inactive = app.deactivateMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
    reason: 'Superseded outside this test.',
  });
  assert.equal(inactive.status, 'inactive');
  assert.ok(inactive.deactivatedAt);

  const deactivateEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
  });
  assert.equal(deactivateEvents.length, 3);
  assert.equal(deactivateEvents[2].eventType, 'deactivate');

  const searchAfterDeactivate = app.search({
    scope: 'repo',
    scopeKey: 'repo-promote',
    query: 'agent review',
  });
  assert.deepEqual(searchAfterDeactivate, []);
});

test('CLI supports promoteMemory', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const promoted = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'promoteMemory',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--key',
      'promoted-rule',
      '--content',
      'Promoted memories are durable.',
      '--sourceCheckpointId',
      'checkpoint-cli',
      '--reason',
      'Synthetic CLI test.',
    ],
    { env },
  );
  assert.match(promoted.stdout, /"key": "promoted-rule"/);

  const fetched = await execFileAsync(
    'node',
    ['src/cli.js', 'getMemory', '--scope', 'repo', '--scopeKey', 'cli-repo', '--key', 'promoted-rule'],
    { env },
  );
  assert.match(fetched.stdout, /Promoted memories are durable/);
});

test('CLI accepts repoPath for repo-scoped memory', async () => {
  const dataDir = await makeTempDir();
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('git@github.com:example/cli-repo.git');
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const remembered = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'remember',
      '--scope',
      'repo',
      '--repoPath',
      repoPath,
      '--key',
      'repo-path-cli',
      '--content',
      'CLI repoPath resolves repo scope.',
    ],
    { cwd: appCwd, env },
  );
  assert.match(remembered.stdout, /"scopeKey": "github.com\/example\/cli-repo"/);
});

test('CLI reports invalid metadata JSON clearly', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  await assert.rejects(
    () =>
      execFileAsync(
        'node',
        [
          'src/cli.js',
          'appendRaw',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-repo',
          '--sessionId',
          'cli-session',
          '--role',
          'user',
          '--content',
          'Invalid metadata should fail clearly.',
          '--metadata',
          '{bad',
        ],
        { env },
      ),
    /Invalid --metadata JSON/,
  );
});

test('CLI ingests Codex rollout JSONL idempotently without capturing developer messages', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-ingest-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DEFAULT_SCOPE_KEY: 'codex-ingest-repo',
  };

  const first = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-ingest-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.parsedEvents, 4);
  assert.equal(firstResult.appendedEvents, 4);
  assert.equal(firstResult.skippedEvents, 0);
  assert.equal(firstResult.status.rawEventCount, 4);

  const second = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-ingest-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.appendedEvents, 0);
  assert.equal(secondResult.skippedEvents, 4);
  assert.equal(secondResult.status.rawEventCount, 4);

  const rawEvents = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listRawEvents',
      '--scope',
      'repo',
      '--scopeKey',
      'codex-ingest-repo',
      '--sessionId',
      'codex:codex-ingest-session',
    ],
    { env },
  );
  const events = JSON.parse(rawEvents.stdout);
  assert.deepEqual(
    events.map((event) => event.role),
    ['user', 'tool_call', 'tool_result', 'assistant'],
  );
  assert.equal(events.some((event) => event.content.includes('Developer instructions')), false);
  assert.ok(events.every((event) => event.metadata.ingestId));
  assert.ok(events.every((event) => event.metadata.sourceAgent === 'codex'));
  assert.ok(events.every((event) => event.metadata.sourceRuntime === 'codex_tui'));
  assert.ok(events.every((event) => event.metadata.sourceAdapter === 'codex_rollout_jsonl'));
  assert.ok(events.every((event) => event.metadata.nativeSessionId === 'codex-ingest-session'));
  assert.equal(firstResult.sessionId, 'codex:codex-ingest-session');
});

test('CLI ingest can auto-distill Codex rollout evidence', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-auto-distill-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DEFAULT_SCOPE_KEY: 'codex-auto-distill-repo',
    CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
  };

  const ingested = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-auto-distill-repo',
      '--distill',
      'auto',
      '--charThreshold',
      '1',
    ],
    { env },
  );
  const result = JSON.parse(ingested.stdout);
  assert.equal(result.appendedEvents, 4);
  assert.equal(result.status.shouldDistill, true);
  assert.equal(result.checkpoint.sessionId, 'codex:codex-auto-distill-session');
  assert.equal(result.checkpoint.provider, 'mock');
  assert.deepEqual(result.checkpoint.metadata.sourceProvenance, {
    sourceAgent: 'codex',
    sourceRuntime: 'codex_tui',
    sourceAdapter: 'codex_rollout_jsonl',
    nativeSessionId: 'codex-auto-distill-session',
  });

  const app = createContextForge({ env, cwd: process.cwd() });
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'codex-auto-distill-repo',
    sessionId: 'codex:codex-auto-distill-session',
  });
  assert.deepEqual(runs[0].inputMetadata.sourceProvenance, result.checkpoint.metadata.sourceProvenance);
});

test('CLI ingest works through remote storage mode', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-remote-ingest-session');
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const env = {
      ...process.env,
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: remote.url,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    };
    const ingested = await execFileAsync(
      'node',
      [
        'src/cli.js',
        'ingestCodexRollout',
        '--file',
        file,
        '--scope',
        'repo',
        '--scopeKey',
        'codex-remote-ingest-repo',
        '--distill',
        'never',
      ],
      { env },
    );
    const result = JSON.parse(ingested.stdout);
    assert.equal(result.appendedEvents, 4);
    assert.equal(result.status.rawEventCount, 4);

    const app = createContextForge({ env, cwd: process.cwd() });
    const rawEvents = await app.listRawEvents({
      scope: 'repo',
      scopeKey: 'codex-remote-ingest-repo',
      sessionId: 'codex:codex-remote-ingest-session',
    });
    assert.equal(rawEvents.length, 4);
  } finally {
    await remote.close();
  }
});

test('CLI ingests multiple Codex session rollout files safely', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  await writeSyntheticSessionsTree(sessionsDir);
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const first = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexSessions',
      '--sessionsDir',
      sessionsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-multi-session-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.filesScanned, 2);
  assert.equal(firstResult.parsedEvents, 8);
  assert.equal(firstResult.appendedEvents, 8);
  assert.equal(firstResult.skippedEvents, 0);
  assert.deepEqual(
    firstResult.fileResults.map((result) => result.sessionId).sort(),
    ['codex:codex-session-first', 'codex:codex-session-second'],
  );
  assert.equal(firstResult.fileResults.some((result) => result.warnings.length > 0), true);

  const second = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexSessions',
      '--sessionsDir',
      sessionsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-multi-session-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.filesScanned, 2);
  assert.equal(secondResult.appendedEvents, 0);
  assert.equal(secondResult.skippedEvents, 8);

  const app = createContextForge({ env, cwd: process.cwd() });
  const firstEvents = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-multi-session-repo',
    sessionId: 'codex:codex-session-first',
  });
  const secondEvents = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-multi-session-repo',
    sessionId: 'codex:codex-session-second',
  });
  assert.equal(firstEvents.length, 4);
  assert.equal(secondEvents.length, 4);
});

test('Codex sessions watch loop picks up new events without duplicates', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const rolloutDir = path.join(sessionsDir, '2026', '04', '25');
  const file = path.join(rolloutDir, 'rollout-watch.jsonl');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(file, 'codex-watch-session');
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
  });
  const iterationResults = [];

  const result = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-watch-repo',
    distill: 'never',
    iterations: 2,
    intervalMs: 1,
    onResult: async (iterationResult) => {
      iterationResults.push(iterationResult);
      if (iterationResult.iteration === 1) {
        await appendSyntheticCodexAssistantMessage(file, 'A new active TUI event arrived.');
      }
    },
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.totals.appendedEvents, 5);
  assert.equal(iterationResults[0].appendedEvents, 4);
  assert.equal(iterationResults[1].appendedEvents, 1);
  assert.equal(iterationResults[1].skippedEvents, 4);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-watch-repo',
    sessionId: 'codex:codex-watch-session',
  });
  assert.equal(events.length, 5);
  assert.equal(events.at(-1).content, 'A new active TUI event arrived.');
});

test('CLI Codex sessions scan is not capped by search limit defaults', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const rolloutDir = path.join(sessionsDir, '2026', '04', '25');
  await fs.mkdir(rolloutDir, { recursive: true });
  for (let index = 0; index < 11; index += 1) {
    await writeSyntheticCodexRollout(
      path.join(rolloutDir, `rollout-${String(index).padStart(2, '0')}.jsonl`),
      `codex-session-${index}`,
    );
  }
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexSessions',
      '--sessionsDir',
      sessionsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-uncapped-session-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.filesScanned, 11);
  assert.equal(parsed.appendedEvents, 44);
});

test('search can combine repo and shared scopes while excluding local by default', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-combined',
    key: 'repo-rule',
    content: 'Always inspect repository code before changing retrieval behavior.',
    category: 'decision',
    importance: 1,
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'shared-rule',
    content: 'Always keep retrieval explanations visible.',
    category: 'policy',
    importance: 10,
  });
  app.remember({
    scope: 'local',
    scopeKey: 'machine-a',
    key: 'local-rule',
    content: 'Always keep this local-only retrieval note private to this machine.',
    category: 'note',
    importance: 99,
  });

  const combined = app.search({
    scope: 'repo',
    scopeKey: 'repo-combined',
    searchScopes: 'repo+shared',
    query: 'always retrieval',
  });

  assert.deepEqual(
    combined.map((result) => result.memory.key),
    ['repo-rule', 'shared-rule'],
  );
  assert.deepEqual(
    combined.map((result) => result.source.role),
    ['repo', 'shared'],
  );
  assert.ok(combined.every((result) => result.source.scopeType !== 'local'));
  assert.ok(combined.every((result) => result.why.some((hit) => hit.token === 'retrieval')));

  const local = app.search({
    scope: 'local',
    scopeKey: 'machine-a',
    searchScopes: 'local',
    query: 'retrieval',
  });
  assert.equal(local.length, 1);
  assert.equal(local[0].memory.key, 'local-rule');
  assert.equal(local[0].source.role, 'local');
});

test('search supports shared-only retrieval with an explicit shared scope key', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-shared-only',
    key: 'repo-rule',
    content: 'Repo retrieval should not appear in a shared-only query.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'team',
    key: 'team-rule',
    content: 'Shared retrieval can be requested independently.',
  });

  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-shared-only',
    searchScopes: 'shared',
    sharedScopeKey: 'team',
    query: 'retrieval',
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'team-rule');
  assert.equal(results[0].source.scopeType, 'shared');
  assert.equal(results[0].source.scopeKey, 'team');
});

test('search uses explainable FTS-backed ranking while keeping durable memory canonical', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-quality',
    key: 'retrieval-quality',
    content: 'Use SQLite FTS for explainable retrieval ranking.',
    category: 'decision',
    tags: ['search'],
    importance: 1,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-quality',
    key: 'general-note',
    content: 'Retrieval can mention ranking in a lower priority note.',
    category: 'note',
    tags: [],
    importance: 10,
  });

  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-quality',
    query: 'retriev qual',
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].memory.key, 'retrieval-quality');
  assert.equal(results[0].retrieval.method, 'fts5+lexical');
  assert.ok(results[0].why.some((hit) => hit.token === 'retriev' && hit.matchTypes.includes('prefix')));
  assert.ok(results[0].why.some((hit) => hit.fields.includes('key')));
  assert.ok(results.every((result) => result.retrieval.ftsRank != null));

  const fetched = app.getMemory({
    scope: 'repo',
    scopeKey: 'repo-quality',
    key: 'retrieval-quality',
  });
  assert.equal(fetched.content, 'Use SQLite FTS for explainable retrieval ranking.');
});

test('search scores only FTS candidates when the index returns matches', () => {
  const memory = {
    id: 'memory-1',
    key: 'indexed-memory',
    category: 'decision',
    content: 'Use indexed candidate search.',
    tags: [],
    importance: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const results = searchMemories(
    {
      searchMemoryIndex: () => [{ memory, ftsRank: -0.0001 }],
      listMemories: () => {
        throw new Error('listMemories should not be called when FTS returns candidates.');
      },
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-index',
      query: 'indexed',
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'indexed-memory');
  assert.equal(results[0].retrieval.method, 'fts5+lexical');
});

test('appendRaw and mock distillCheckpoint preserve raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const session = app.beginSession({ scope: 'repo', scopeKey: 'repo-a' });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    role: 'user',
    content: 'Decision: use a mock provider for the first distillation smoke test.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    role: 'assistant',
    content: 'Next implement the provider contract and CLI command.',
  });

  const statusBefore = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    minEvents: 2,
  });
  assert.equal(statusBefore.rawEventCount, 2);
  assert.equal(statusBefore.eventsSinceLastCheckpoint, 2);
  assert.equal(statusBefore.latestCheckpointId, null);
  assert.equal(statusBefore.shouldDistill, false);

  const statusWithEnoughContent = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    minEvents: 2,
    charThreshold: 1,
  });
  assert.equal(statusWithEnoughContent.shouldDistill, true);
  assert.ok(statusWithEnoughContent.reasons.includes('initial_event_and_char_threshold'));

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
  });

  assert.equal(checkpoint.provider, 'mock');
  assert.equal(checkpoint.sourceEventCount, 2);
  assert.ok(checkpoint.distillRunId);
  assert.deepEqual(checkpoint.metadata.providerMetadata, { roles: 'user, assistant' });
  assert.equal(checkpoint.decisions.length, 1);
  assert.equal(checkpoint.todos.length, 1);

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 2);
  assert.equal(info.tables.checkpoints, 1);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].outputMetadata.checkpointId, checkpoint.id);

  const statusAfter = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    minEvents: 1,
  });
  assert.equal(statusAfter.latestCheckpointId, checkpoint.id);
  assert.equal(statusAfter.eventsSinceLastCheckpoint, 0);
  assert.equal(statusAfter.shouldDistill, false);
});

test('distillCheckpoint rejects malformed provider output and preserves raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'bad_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      bad_provider: async () => ({
        summaryShort: 'Missing required arrays.',
        summaryText: 'Malformed output should be rejected.',
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-b',
    sessionId: 'bad-session',
    role: 'user',
    content: 'Keep this raw event even when validation fails.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-b',
        sessionId: 'bad-session',
      }),
    /decisions.*array/,
  );

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 1);
  assert.equal(info.tables.checkpoints, 0);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-b',
    sessionId: 'bad-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].outputMetadata.validationFailed, true);
});

test('distill output validation includes received types', () => {
  assert.throws(() => validateDistillOutput(null), /received null/);
  assert.throws(
    () =>
      validateDistillOutput({
        summaryShort: 'Invalid checkpoint.',
        summaryText: 'Array fields are not valid here.',
        decisions: 'not-array',
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
      }),
    /decisions.*received string/,
  );
});

test('distillCheckpoint records provider failures without deleting raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'failing_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      failing_provider: async () => {
        throw new Error('synthetic provider failure');
      },
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-c',
    sessionId: 'failing-session',
    role: 'assistant',
    content: 'Raw evidence should survive provider exceptions.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-c',
        sessionId: 'failing-session',
      }),
    /synthetic provider failure/,
  );

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 1);
  assert.equal(info.tables.checkpoints, 0);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-c',
    sessionId: 'failing-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].errorMessage, 'synthetic provider failure');
  assert.equal(runs[0].outputMetadata.providerFailed, true);
});

test('codex_exec provider distills synthetic raw events through a runner', async () => {
  const dataDir = await makeTempDir();
  let invocation;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-fake',
      CONTEXTFORGE_CODEX_EXEC_MODEL: 'gpt-test',
      CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT: 'low',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1234',
      CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS: '5000',
    },
    cwd: process.cwd(),
    codexExecRunner: async (args) => {
      invocation = args;
      return {
        stdout: JSON.stringify({
          summaryShort: 'Codex checkpoint for synthetic events.',
          summaryText: 'The user decided to test the codex_exec provider path.',
          decisions: ['Use codex_exec behind the provider contract.'],
          todos: ['Document setup expectations.'],
          openQuestions: [],
          memoryCandidates: [{ key: 'provider', content: 'codex_exec is available.' }],
          sourceEventCount: 1,
          metadata: { synthetic: true },
        }),
      };
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
    role: 'user',
    content: 'Decision: test codex_exec with synthetic raw events.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
  });

  assert.equal(checkpoint.provider, 'codex_exec');
  assert.equal(checkpoint.sourceEventCount, 1);
  assert.equal(checkpoint.metadata.providerMetadata.synthetic, true);
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.command, 'codex-fake');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.model, 'gpt-test');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.reasoningEffort, 'low');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.timeoutMs, 1234);
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.promptVersion, 'codex_exec.prompt.v1');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.outputSchemaVersion, 'contextforge.checkpoint.v1');
  assert.match(invocation.prompt, /Return exactly one JSON object/);
  assert.deepEqual(invocation.args.slice(0, 2), ['exec', '--skip-git-repo-check']);
  assert.ok(invocation.args.includes('--output-schema'));
  assert.ok(invocation.args.includes('--output-last-message'));
  assert.ok(invocation.args.includes('-c'));
  assert.ok(invocation.args.includes('model_reasoning_effort="low"'));
  assert.equal(invocation.timeoutMs, 1234);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
  });
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].inputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v1');
  assert.equal(runs[0].inputMetadata.providerMetadata.outputSchemaVersion, 'contextforge.checkpoint.v1');
  assert.equal(runs[0].outputMetadata.providerMetadata.codexExec.promptVersion, 'codex_exec.prompt.v1');
});

test('codex_exec records JSON brace fallback recovery metadata', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => ({
      stdout: `prefix ${JSON.stringify({
        summaryShort: 'Recovered checkpoint.',
        summaryText: 'The provider output needed brace fallback recovery.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        provider: 'codex_exec',
        metadata: { providerNotes: 'synthetic recovery' },
      })} suffix`,
    }),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-json-recovery',
    sessionId: 'json-recovery-session',
    role: 'assistant',
    content: 'Provider output may include recoverable surrounding text.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-json-recovery',
    sessionId: 'json-recovery-session',
  });

  assert.equal(checkpoint.metadata.providerMetadata.codexExec.jsonRecovery, 'brace-fallback');
});

test('codex_exec doctor reports dry and live smoke readiness through a runner', async () => {
  const dataDir = await makeTempDir();
  const invocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-fake',
      CONTEXTFORGE_CODEX_EXEC_MODEL: 'gpt-test',
      CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT: 'low',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1234',
    },
    cwd: process.cwd(),
    codexExecRunner: async (args) => {
      invocations.push(args);
      if (args.args.includes('--version')) {
        return { stdout: 'codex-fake 1.2.3\n' };
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          provider: 'codex_exec',
          message: 'codex_exec smoke ok',
        }),
      };
    },
  });

  const dry = await app.checkCodexExec();
  assert.equal(dry.ok, true);
  assert.equal(dry.commandAvailable, true);
  assert.equal(dry.version, 'codex-fake 1.2.3');
  assert.equal(dry.live, false);
  assert.equal(dry.command, 'codex-fake');
  assert.equal(dry.model, 'gpt-test');
  assert.equal(dry.reasoningEffort, 'low');
  assert.equal(invocations.length, 1);

  const live = await app.checkCodexExec({ live: true });
  assert.equal(live.ok, true);
  assert.equal(live.live, true);
  assert.equal(live.smoke.output.provider, 'codex_exec');
  assert.ok(invocations[1].args.includes('--version'));
  assert.ok(invocations[2].args.includes('--output-schema'));
  assert.ok(invocations[2].args.includes('model_reasoning_effort="low"'));
  assert.equal(invocations[2].timeoutMs, 1234);
});

test('codex_exec rejects unsupported reasoning effort values', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT: 'low\" other=\"x',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => ({ stdout: '{}' }),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-invalid-reasoning',
    sessionId: 'invalid-reasoning-session',
    role: 'user',
    content: 'This should fail before codex exec receives invalid config.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-invalid-reasoning',
        sessionId: 'invalid-reasoning-session',
      }),
    /Invalid codex_exec reasoning effort/,
  );
});

test('codex_exec doctor returns structured errors', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-missing',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => {
      throw new Error('spawn codex-missing ENOENT');
    },
  });

  const result = await app.checkCodexExec({ live: true });
  assert.equal(result.ok, false);
  assert.equal(result.commandAvailable, false);
  assert.equal(result.command, 'codex-missing');
  assert.match(result.error.message, /ENOENT/);
});

test('memory tags are normalized before FTS indexing', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const memory = app.remember({
    scope: 'repo',
    scopeKey: 'repo-tags',
    key: 'string-tags',
    content: 'String tags should not break memory indexing.',
    tags: 'not-an-array',
  });

  assert.deepEqual(memory.tags, []);
  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-tags',
    query: 'indexing',
  });
  assert.equal(results[0].memory.key, 'string-tags');
});

test('codex_exec parse failures preserve raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => ({ stdout: 'not json' }),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-codex-fail',
    sessionId: 'codex-fail-session',
    role: 'assistant',
    content: 'Raw evidence should survive codex_exec parse failures.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-codex-fail',
        sessionId: 'codex-fail-session',
      }),
    /valid JSON/,
  );

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 1);
  assert.equal(info.tables.checkpoints, 0);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-codex-fail',
    sessionId: 'codex-fail-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].outputMetadata.providerFailed, true);
  assert.equal(runs[0].inputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v1');
  assert.equal(runs[0].outputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v1');
});

test('CLI supports the v0 workflow with synthetic data', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const dbInfo = await execFileAsync('node', ['src/cli.js', 'dbInfo'], { env });
  assert.match(dbInfo.stdout, new RegExp(`"schemaVersion": ${SCHEMA_VERSION}`));

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'remember',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--key',
      'retrieval',
      '--content',
      'Search durable memories before checkpoints.',
      '--tag',
      'retrieval',
    ],
    { env },
  );

  const search = await execFileAsync(
    'node',
    ['src/cli.js', 'search', '--scope', 'repo', '--scopeKey', 'cli-repo', '--query', 'durable'],
    { env },
  );
  assert.match(search.stdout, /"key": "retrieval"/);

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'appendRaw',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
      '--role',
      'user',
      '--content',
      'What should happen next?',
    ],
    { env },
  );

  const checkpoint = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'distillCheckpoint',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(checkpoint.stdout, /"provider": "mock"/);

  const status = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'sessionStatus',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(status.stdout, /"latestCheckpointId":/);

  const runs = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listDistillRuns',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(runs.stdout, /"status": "succeeded"/);
});

test('MCP stdio server exposes core tools for synthetic integration', async () => {
  const dataDir = await makeTempDir();
  const repoPath = await makeGitRepo('git@github.com:example/mcp-repo.git');
  const client = new Client({ name: 'contextforge-test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['src/mcp.js'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'append_raw',
      'begin_session',
      'correct_memory',
      'deactivate_memory',
      'distill_checkpoint',
      'get_memory',
      'list_memory_candidates',
      'list_memory_events',
      'promote_memory',
      'remember',
      'search',
      'session_status',
    ]);
    const rememberTool = toolList.tools.find((tool) => tool.name === 'remember');
    assert.ok(rememberTool.inputSchema.properties.repoPath);
    assert.ok(rememberTool.inputSchema.properties.cwd);

    const rememberResult = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        key: 'mcp-rule',
        content: 'Use MCP retrieval on demand.',
        category: 'policy',
      },
    });
    assert.equal(rememberResult.structuredContent.result.key, 'mcp-rule');

    const searchResult = await client.callTool({
      name: 'search',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        query: 'retrieval demand',
      },
    });
    assert.equal(searchResult.structuredContent.result[0].memory.key, 'mcp-rule');

    const repoPathResult = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        repoPath,
        key: 'mcp-repo-path-rule',
        content: 'MCP repoPath resolves the target checkout.',
      },
    });
    assert.equal(repoPathResult.structuredContent.result.scopeKey, 'github.com/example/mcp-repo');

    const sessionResult = await client.callTool({
      name: 'begin_session',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
      },
    });
    assert.equal(sessionResult.structuredContent.result.sessionId, 'mcp-session');

    await client.callTool({
      name: 'append_raw',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        role: 'user',
        content: 'Decision: MCP agents should inspect session status before distilling.',
      },
    });

    const statusResult = await client.callTool({
      name: 'session_status',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        minEvents: 1,
        charThreshold: 1,
      },
    });
    assert.equal(statusResult.structuredContent.result.shouldDistill, true);

    const promotedResult = await client.callTool({
      name: 'promote_memory',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        key: 'promoted-mcp-rule',
        content: 'Reviewed checkpoint candidates can become durable memory.',
        sourceCheckpointId: 'checkpoint-mcp',
        reason: 'Synthetic MCP test.',
      },
    });
    assert.equal(promotedResult.structuredContent.result.key, 'promoted-mcp-rule');
  } finally {
    await client.close();
  }
});

test('MCP streamable HTTP endpoint exposes core tools with bearer auth', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const client = new Client({ name: 'contextforge-http-test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: {
      headers: {
        authorization: 'Bearer test-token',
      },
    },
  });

  try {
    await client.connect(transport);
    const toolList = await client.listTools();
    assert.ok(toolList.tools.some((tool) => tool.name === 'remember'));

    const remembered = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        key: 'http-mcp-rule',
        content: 'HTTP MCP should share canonical remote memory.',
      },
    });
    assert.equal(remembered.structuredContent.result.scopeKey, 'http-mcp-repo');

    const searched = await client.callTool({
      name: 'search',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        query: 'canonical remote',
      },
    });
    assert.equal(searched.structuredContent.result[0].memory.key, 'http-mcp-rule');
  } finally {
    await client.close();
    await remote.close();
  }
});

test('MCP streamable HTTP endpoint rejects missing bearer auth', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const client = new Client({ name: 'contextforge-http-unauthorized-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`));

  try {
    await assert.rejects(() => client.connect(transport), /Unauthorized|Streamable HTTP error|401/);
  } finally {
    await client.close().catch(() => {});
    await remote.close();
  }
});

test('remote storage mode delegates core calls and preserves scope semantics', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const app = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      },
      cwd: process.cwd(),
    });

    await app.remember({
      scope: 'repo',
      scopeKey: 'repo-remote',
      key: 'storage-mode',
      content: 'Remote repo memory stays in repo scope.',
      category: 'decision',
    });
    await app.remember({
      scope: 'shared',
      scopeKey: 'global',
      key: 'storage-mode',
      content: 'Shared memory stays in shared scope.',
      category: 'policy',
    });

    const repoMemory = await app.getMemory({
      scope: 'repo',
      scopeKey: 'repo-remote',
      key: 'storage-mode',
    });
    const sharedMemory = await app.getMemory({
      scope: 'shared',
      scopeKey: 'global',
      key: 'storage-mode',
    });
    assert.equal(repoMemory.scopeType, 'repo');
    assert.equal(repoMemory.content, 'Remote repo memory stays in repo scope.');
    assert.equal(sharedMemory.scopeType, 'shared');
    assert.equal(sharedMemory.content, 'Shared memory stays in shared scope.');

    const repoResults = await app.search({
      scope: 'repo',
      scopeKey: 'repo-remote',
      query: 'remote scope',
    });
    assert.equal(repoResults.length, 1);
    assert.equal(repoResults[0].memory.scopeType, 'repo');

    await app.appendRaw({
      scope: 'repo',
      scopeKey: 'repo-remote',
      sessionId: 'remote-session',
      role: 'user',
      content: 'Remote clients can inspect whether a session should distill.',
    });
    const status = await app.sessionStatus({
      scope: 'repo',
      scopeKey: 'repo-remote',
      sessionId: 'remote-session',
      minEvents: 1,
      charThreshold: 1,
    });
    assert.equal(status.shouldDistill, true);
    assert.equal(status.rawEventCount, 1);

    const info = await app.dbInfo();
    assert.equal(info.tables.memories, 2);
  } finally {
    await remote.close();
  }
});

test('remote storage mode resolves repoPath before sending scoped calls', async () => {
  const dataDir = await makeTempDir();
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/remote-client-repo.git');
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const app = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      },
      cwd: appCwd,
    });

    const memory = await app.remember({
      scope: 'repo',
      repoPath,
      key: 'remote-client-repo-path',
      content: 'Remote clients resolve repoPath locally before posting.',
    });
    assert.equal(memory.scopeKey, 'github.com/example/remote-client-repo');

    const fetched = await app.getMemory({
      scope: 'repo',
      scopeKey: 'github.com/example/remote-client-repo',
      key: 'remote-client-repo-path',
    });
    assert.equal(fetched.content, 'Remote clients resolve repoPath locally before posting.');
  } finally {
    await remote.close();
  }
});

test('remote storage mode strips local path hints after resolving scope', async () => {
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/remote-strip-repo.git');
  let postedBody = null;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
    cwd: appCwd,
    fetchImpl: async (_url, request) => {
      postedBody = JSON.parse(request.body);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            result: {
              key: postedBody.key,
              scopeType: postedBody.scopeType,
              scopeKey: postedBody.scopeKey,
            },
          }),
      };
    },
  });

  const memory = await app.remember({
    scope: 'repo',
    repoPath,
    cwd: appCwd,
    key: 'remote-strip-paths',
    content: 'Remote payloads should not include local paths.',
  });

  assert.equal(memory.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBody.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBody.repoPath, undefined);
  assert.equal(postedBody.cwd, undefined);
});

test('remote storage mode rejects unauthorized writes', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const app = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'wrong-token',
      },
      cwd: process.cwd(),
    });

    await assert.rejects(
      () =>
        app.remember({
          scope: 'repo',
          scopeKey: 'repo-remote',
          key: 'unauthorized',
          content: 'This should not be written.',
        }),
      /Unauthorized/,
    );
  } finally {
    await remote.close();
  }
});

test('remote server requires a token on non-loopback hosts', async () => {
  assert.throws(
    () =>
      startContextForgeServer({
        host: '0.0.0.0',
        port: 0,
        env: {
          CONTEXTFORGE_DATA_DIR: '/tmp/contextforge-token-required',
        },
      }),
    /CONTEXTFORGE_REMOTE_TOKEN is required/,
  );
});

test('remote server supports configurable request body limits', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_REMOTE_MAX_BODY_BYTES: '8',
    },
  });

  try {
    const response = await fetch(`${remote.url}/v0/dbInfo`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: '{"tooLarge":true}',
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error.name, 'RequestBodyTooLargeError');
    assert.match(body.error.message, /too large/);
  } finally {
    await remote.close();
  }
});

test('runtime database artifacts are ignored by git rules', async () => {
  const gitignore = await fs.readFile('.gitignore', 'utf8');
  assert.match(gitignore, /^\.contextforge\/$/m);
  assert.match(gitignore, /^\*\.db$/m);
  assert.match(gitignore, /^\*\.db-wal$/m);
  assert.match(gitignore, /^\*\.db-shm$/m);
});
