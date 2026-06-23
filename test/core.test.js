import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { createCodexSdkPythonAutoPromoteAuditor } from '../src/audit/codex_sdk_python.js';
import { canonicalizeScope, parseScopeAliases } from '../src/config/index.js';
import { createContextForge } from '../src/core.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION, validateDistillOutput } from '../src/distill/validate.js';
import { createOpenAiEmbeddingProvider } from '../src/embeddings/index.js';
import { createInterruptibleSleep, normalizeRepoIdentity, shouldSkipRecentFailedAutoDistill } from '../src/ingest/common.js';
import { watchClaudeCodeSessions } from '../src/ingest/claude_code.js';
import { ingestCodexRolloutFile, watchCodexSessions } from '../src/ingest/codex.js';
import { ingestAgentRoutedSessions, ingestAgentSessions, listAgentAdapters, watchAgentRoutedSessions } from '../src/ingest/agents.js';
import { searchMemories } from '../src/retrieval/search.js';
import { REMOTE_METHODS } from '../src/remote/client.js';
import { startContextForgeServer } from '../src/server.js';
import { ContextForgeStore, SCHEMA_VERSION } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-test-'));
}

async function makeNonGitTempDir() {
  return makeTempDir();
}

function testAdminPasswordHash(password) {
  const salt = Buffer.from('contextforge-test-admin-salt');
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `${iterations}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

test('interruptible ingest sleep wakes when stopped', async () => {
  const sleeper = createInterruptibleSleep();
  let resolved = false;
  const wait = sleeper.sleep(10000).then(() => {
    resolved = true;
  });
  sleeper.stop();
  await wait;
  assert.equal(resolved, true);
});

async function makeGitRepo(remoteUrl = 'git@github.com:example/contextforge.git') {
  const cwd = await makeTempDir();
  await fs.mkdir(path.join(cwd, '.git', 'objects'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(cwd, '.git', 'config'),
    `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
[remote "origin"]
\turl = ${remoteUrl}
`,
  );
  return cwd;
}

async function writeSyntheticCodexRollout(filePath, sessionId = 'codex-rollout-session', cwd = path.dirname(filePath)) {
  const records = [
    {
      timestamp: '2026-04-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd,
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

async function writeSyntheticClaudeCodeTranscript(filePath, sessionId = 'claude-code-session', cwd = path.dirname(filePath)) {
  const records = [
    {
      type: 'summary',
      sessionId,
      timestamp: '2026-04-25T00:00:00.000Z',
      content: 'Summaries should not be captured as raw dialogue.',
    },
    {
      type: 'user',
      sessionId,
      uuid: 'claude-user-1',
      cwd,
      timestamp: '2026-04-25T00:00:01.000Z',
      message: {
        role: 'user',
        content: 'Continue the ContextForge Claude Code ingest work.',
      },
    },
    {
      type: 'assistant',
      sessionId,
      uuid: 'claude-assistant-tool',
      cwd,
      timestamp: '2026-04-25T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }],
      },
    },
    {
      type: 'user',
      sessionId,
      uuid: 'claude-tool-result',
      cwd,
      timestamp: '2026-04-25T00:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README contents.' }],
      },
    },
    {
      type: 'assistant',
      sessionId,
      uuid: 'claude-assistant-1',
      cwd,
      timestamp: '2026-04-25T00:00:04.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I added Claude Code transcript ingestion.' },
          { type: 'tool_use', id: 'toolu_2', name: 'TodoWrite', input: { todos: [] } },
        ],
      },
    },
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

async function writeSyntheticGrokChatHistory(
  sessionsDir,
  sessionId = 'grok-session',
  cwd = path.dirname(sessionsDir),
) {
  const sessionDir = path.join(sessionsDir, encodeURIComponent(cwd), sessionId);
  const file = path.join(sessionDir, 'chat_history.jsonl');
  const records = [
    {
      type: 'system',
      content: 'System prompts should not be captured as raw dialogue.',
    },
    {
      type: 'user',
      content: [{ type: 'text', text: 'Continue the ContextForge Grok ingest work.' }],
    },
    {
      type: 'reasoning',
      summary: ['Reasoning should not be captured as raw dialogue.'],
    },
    {
      type: 'assistant',
      content: 'I added Grok chat history ingestion.',
      model_id: 'grok-test',
    },
  ];
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

async function writeSyntheticCursorTranscript(
  projectsDir,
  sessionId = 'cursor-session',
  projectName = 'home-ubuntu',
) {
  const sessionDir = path.join(projectsDir, projectName, 'agent-transcripts', sessionId);
  const file = path.join(sessionDir, `${sessionId}.jsonl`);
  const records = [
    {
      role: 'user',
      message: {
        content: [{ type: 'text', text: 'Continue the ContextForge Cursor CLI ingest work.' }],
      },
    },
    {
      role: 'assistant',
      message: {
        content: [{ type: 'text', text: 'I added Cursor CLI transcript ingestion.' }],
      },
    },
  ];
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

async function writeSyntheticOpenCodeDb(dbPath, sessionId = 'opencode-session', cwd = path.dirname(dbPath)) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      create table session (
        id text primary key,
        directory text not null,
        title text not null,
        agent text,
        model text,
        time_created integer not null,
        time_updated integer not null
      );
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `);
    db.prepare(
      'insert into session (id, directory, title, agent, model, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sessionId,
      cwd,
      'Synthetic OpenCode ingest test',
      'build',
      JSON.stringify({ id: 'test-model', providerID: 'test-provider' }),
      1,
      4,
    );
    const messages = [
      {
        id: 'opencode-user-1',
        role: 'user',
        content: 'Continue the ContextForge OpenCode ingest work.',
        time: 2,
      },
      {
        id: 'opencode-assistant-1',
        role: 'assistant',
        content: 'I added OpenCode SQLite ingestion.',
        time: 3,
      },
    ];
    for (const message of messages) {
      db.prepare('insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)').run(
        message.id,
        sessionId,
        message.time,
        message.time,
        JSON.stringify({ role: message.role, path: { cwd, root: cwd }, agent: 'build', modelID: 'test-model' }),
      );
      db.prepare(
        'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)',
      ).run(
        `${message.id}-part`,
        message.id,
        sessionId,
        message.time,
        message.time,
        JSON.stringify({ type: 'text', text: message.content }),
      );
    }
  } finally {
    db.close();
  }
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
  assert.equal(info.tables.llmUsageEvents, 0);
  assert.equal(info.tables.embeddingJobs, 0);
  assert.equal(info.embeddings.requiredForQuality, true);
  assert.equal(info.embeddings.staleAfterMs, 10 * 60 * 1000);
  assert.equal(info.embeddings.degraded, true);
  assert.deepEqual(info.embeddings.jobs, { pending: 0, processing: 0, completed: 0, failed: 0 });
  assert.equal(info.connection.mode, 'direct-local');
  assert.equal(info.connection.accessMode, 'direct-local');
  assert.equal(info.connection.accessPath, 'direct-local');
  assert.equal(info.connection.processRole, 'local-process');
  assert.equal(info.connection.serverRole, null);
  assert.equal(info.connection.summary, 'direct-local local-process');
  assert.equal(info.connection.storageMode, 'project-local');
  assert.match(info.dbPath, /contextforge\.db$/);
});

test('dbInfo reports configured embedding stale timeout', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS: '1234',
    },
    cwd: process.cwd(),
  });

  assert.equal(app.dbInfo().embeddings.staleAfterMs, 1234);
});

test('ContextForgeStore.withTransaction returns results and rolls back on throw', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  try {
    const memory = store.withTransaction(() =>
      store.rememberMemory({
        scopeType: 'repo',
        scopeKey: 'tx-repo',
        key: 'tx-memory',
        content: 'Transaction return value survives.',
      }),
    );

    assert.equal(memory.key, 'tx-memory');
    assert.equal(
      store.getMemory({ scopeType: 'repo', scopeKey: 'tx-repo', key: 'tx-memory' }).content,
      'Transaction return value survives.',
    );

    assert.throws(
      () =>
        store.withTransaction(() => {
          store.rememberMemory({
            scopeType: 'repo',
            scopeKey: 'tx-repo',
            key: 'rolled-back-memory',
            content: 'This should roll back.',
          });
          throw new Error('rollback please');
        }),
      /rollback please/,
    );
    assert.equal(store.getMemory({ scopeType: 'repo', scopeKey: 'tx-repo', key: 'rolled-back-memory' }), null);
  } finally {
    store.close();
  }
});

test('processEmbeddingJobs reports an explicit no-op when the scoped queue is empty', async () => {
  const dataDir = await makeTempDir();
  let embedCalls = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_OPENAI_API_KEY: 'test-key',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: {
        name: 'test',
        model: 'test-embedding',
        dimensions: 3,
        async embed() {
          embedCalls += 1;
          return [];
        },
      },
    },
  });

  const result = await app.processEmbeddingJobs({ scope: 'repo', scopeKey: 'empty-queue-repo', retryFailed: true });

  assert.equal(result.noOp, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.embedded, 0);
  assert.equal(result.failed, 0);
  assert.equal(embedCalls, 0);
  assert.deepEqual(result.jobs, { pending: 0, processing: 0, completed: 0, failed: 0 });
});

test('MCP instructions require checking embedding queue state before processing jobs', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'mcp.js'), 'utf8');

  assert.match(source, /Before calling process_embedding_jobs/);
  assert.match(source, /pending=0, failed=0, processing=0/);
  assert.match(source, /failed jobs exist.*retryFailed=true/i);
  assert.match(source, /skip/i);
});

test('embedding jobs claim atomically and stale processing jobs reset', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  try {
    const [job] = store.enqueueEmbeddingJobs(
      [
        {
          sourceType: 'memory',
          scopeType: 'repo',
          scopeKey: 'embedding-job-repo',
          recordId: 'memory-1',
          contentHash: 'hash-1',
        },
      ],
      { model: 'test-embedding', dimensions: 3 },
    );

    const claimed = store.markEmbeddingJobProcessing(job.id);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.attempts, 1);
    assert.equal(store.markEmbeddingJobProcessing(job.id), null);

    store.db.prepare("UPDATE embedding_jobs SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(job.id);
    const reset = store.resetStaleEmbeddingJobs({
      scopeType: 'repo',
      scopeKey: 'embedding-job-repo',
      staleBeforeIso: '2000-01-01T00:00:01.000Z',
    });
    assert.equal(reset.reset, 1);
    const reclaimed = store.markEmbeddingJobProcessing(job.id);
    assert.equal(reclaimed.status, 'processing');
    assert.equal(reclaimed.attempts, 2);
  } finally {
    store.close();
  }
});

test('session working context is mutable scoped session state', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const context = app.upsertSessionWorkingContext({
    scope: 'repo',
    scopeKey: 'working-context-repo',
    sessionId: 'working-context-session',
    currentTask: 'Implement structured resume handoff.',
    currentUserIntent: 'Continue design follow-up work.',
    targetSubject: 'session_working_context',
    nonGoals: ['durable memory promotion'],
    avoidMisreadings: ['structured context is canonical memory'],
    confidence: 0.8,
  });

  assert.equal(context.scopeType, 'repo');
  assert.equal(context.scopeKey, 'working-context-repo');
  assert.equal(context.mode, 'task_execution');
  assert.equal(context.currentTask, 'Implement structured resume handoff.');
  assert.deepEqual(context.nonGoals, ['durable memory promotion']);
  assert.deepEqual(context.avoidMisreadings, ['structured context is canonical memory']);
  assert.equal(context.confidence, 0.8);

  app.upsertSessionWorkingContext({
    scope: 'repo',
    scopeKey: 'working-context-repo',
    sessionId: 'working-context-session',
    currentTask: 'Update structured resume handoff tests.',
    confidence: 2,
  });

  const updated = app.getSessionWorkingContext({
    scope: 'repo',
    scopeKey: 'working-context-repo',
    sessionId: 'working-context-session',
  });
  assert.equal(updated.id, context.id);
  assert.equal(updated.currentTask, 'Update structured resume handoff tests.');
  assert.equal(updated.currentUserIntent, 'Continue design follow-up work.');
  assert.equal(updated.targetSubject, 'session_working_context');
  assert.deepEqual(updated.nonGoals, ['durable memory promotion']);
  assert.deepEqual(updated.avoidMisreadings, ['structured context is canonical memory']);
  assert.equal(updated.confidence, 1);

  const otherSession = app.getSessionWorkingContext({
    scope: 'repo',
    scopeKey: 'working-context-repo',
    sessionId: 'other-session',
  });
  assert.equal(otherSession, null);
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

test('repo identity normalization preserves nested namespace paths', () => {
  assert.equal(normalizeRepoIdentity('git@github.com:Example/ContextForge.git'), 'github.com/example/contextforge');
  assert.equal(
    normalizeRepoIdentity('https://gitlab.com/group/subgroup/repo-a.git'),
    'gitlab.com/group/subgroup/repo-a',
  );
  assert.equal(
    normalizeRepoIdentity('git@gitlab.com:group/subgroup/repo-b.git'),
    'gitlab.com/group/subgroup/repo-b',
  );
});

test('repo scope key falls back to a deterministic path key outside git', async () => {
  const cwd = await makeNonGitTempDir();
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

test('scope aliases canonicalize explicit repo keys', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_SCOPE_ALIASES: 'repo:github.com/old/suite=repo:github.com/new/suite',
    },
    cwd: process.cwd(),
  });

  const memory = app.remember({
    scope: 'repo',
    scopeKey: 'github.com/old/suite',
    key: 'canonical-memory',
    content: 'Old repo scope writes are stored under the canonical repo scope.',
  });
  assert.equal(memory.scopeKey, 'github.com/new/suite');

  const fetchedViaOld = app.getMemory({
    scope: 'repo',
    scopeKey: 'github.com/old/suite',
    key: 'canonical-memory',
  });
  assert.equal(fetchedViaOld.scopeKey, 'github.com/new/suite');

  const scopes = app.listScopeKeys({ scope: 'repo' }).map((item) => item.scopeKey);
  assert.deepEqual(scopes, ['github.com/new/suite']);
});

test('scope aliases reject unsafe definitions and support chained canonicalization', () => {
  const aliases = parseScopeAliases('repo:A=repo:B, repo:B=repo:C');
  assert.deepEqual(canonicalizeScope({ scopeType: 'repo', scopeKey: 'A' }, aliases), {
    scopeType: 'repo',
    scopeKey: 'C',
  });

  assert.throws(
    () => parseScopeAliases('repo:A=shared:B'),
    /cannot change scope type/,
  );
  assert.throws(
    () => parseScopeAliases('{broken json'),
    /CONTEXTFORGE_SCOPE_ALIASES must be valid JSON/,
  );
  assert.throws(
    () =>
      canonicalizeScope(
        { scopeType: 'repo', scopeKey: 'A' },
        parseScopeAliases('repo:A=repo:B, repo:B=repo:A'),
      ),
    /cycle/,
  );
});

test('migrateScope dry-runs and moves existing scoped rows into the canonical scope', async () => {
  const dataDir = await makeTempDir();
  const seedApp = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scope_migration_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      scope_migration_provider: async () => ({
        summaryShort: 'Scope migration checkpoint.',
        summaryText: 'Existing old-scope rows should migrate to the canonical scope.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'scope-migration-candidate',
            content: 'Scope migration should move candidate index rows.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  const oldScope = {
    scope: 'repo',
    scopeKey: 'github.com/old/suite',
  };
  seedApp.remember({
    ...oldScope,
    key: 'old-scope-memory',
    content: 'Existing rows can be moved from a deprecated repo scope.',
  });
  seedApp.appendRaw({
    ...oldScope,
    sessionId: 'scope-migration-session',
    role: 'assistant',
    content: 'Raw evidence in the old scope.',
  });
  await seedApp.distillCheckpoint({
    ...oldScope,
    sessionId: 'scope-migration-session',
  });
  seedApp.close();

  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_SCOPE_ALIASES: 'repo:github.com/old/suite=repo:github.com/new/suite',
    },
    cwd: process.cwd(),
  });

  const dryRun = app.migrateScope({
    fromScope: 'repo',
    fromScopeKey: 'github.com/old/suite',
    toScope: 'repo',
    toScopeKey: 'github.com/new/suite',
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.requestedDryRun, true);
  assert.equal(dryRun.blocked, false);
  assert.equal(dryRun.canMigrate, true);
  assert.equal(dryRun.hasRows, true);
  assert.equal(dryRun.empty, false);
  assert.equal(dryRun.totalRows, 6);
  assert.equal(dryRun.counts.memories, 1);
  assert.equal(dryRun.counts.raw_events, 1);
  assert.equal(dryRun.counts.checkpoints, 1);
  assert.equal(dryRun.counts.memory_candidate_index, 1);
  assert.equal(dryRun.derivedRows.memory_fts, 1);

  const migrated = app.migrateScope({
    fromScope: 'repo',
    fromScopeKey: 'github.com/old/suite',
    toScope: 'repo',
    toScopeKey: 'github.com/new/suite',
    dryRun: false,
  });
  assert.equal(migrated.dryRun, false);
  assert.equal(migrated.requestedDryRun, false);
  assert.equal(migrated.blocked, false);
  assert.equal(migrated.totalRows, 6);
  assert.equal(migrated.updated.memories, 1);
  assert.equal(migrated.updated.raw_events, 1);
  assert.equal(migrated.updated.checkpoints, 1);
  assert.equal(migrated.updated.memory_candidate_index, 1);
  assert.equal(migrated.updated.memory_fts, undefined);
  assert.equal(migrated.rebuilt.memory_fts, 1);

  const scopes = app.listScopeKeys({ scope: 'repo' }).map((item) => item.scopeKey);
  assert.deepEqual(scopes, ['github.com/new/suite']);
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'github.com/new/suite', key: 'old-scope-memory' }).content,
    'Existing rows can be moved from a deprecated repo scope.',
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/new/suite',
      sessionId: 'scope-migration-session',
    }).length,
    1,
  );
  assert.equal(
    app.listCheckpoints({
      scope: 'repo',
      scopeKey: 'github.com/new/suite',
      sessionId: 'scope-migration-session',
    }).length,
    1,
  );
});

test('migrateScope reports conflicts without pretending an actual request was a dry-run', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/old/suite',
    key: 'conflicting-memory',
    content: 'Old scope value.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/new/suite',
    key: 'conflicting-memory',
    content: 'New scope value.',
  });

  const result = app.migrateScope({
    fromScope: 'repo',
    fromScopeKey: 'github.com/old/suite',
    toScope: 'repo',
    toScopeKey: 'github.com/new/suite',
    dryRun: false,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.requestedDryRun, false);
  assert.equal(result.blocked, true);
  assert.equal(result.blockedReason, 'conflicts');
  assert.equal(result.hasRows, true);
  assert.equal(result.empty, false);
  assert.equal(result.canMigrate, false);
  assert.equal(result.conflicts[0].table, 'memories');
  assert.deepEqual(result.conflicts[0].sampleKeys, ['conflicting-memory']);
});

test('default shared and local scopes get usable default keys', async () => {
  const cwd = await makeNonGitTempDir();
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
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('candidate-rule') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
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
            importance: 7,
            candidateType: 'project_policy',
            confidence: 0.91,
            stability: 0.88,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
            sourceEventIds: ['raw-candidate-1'],
          },
          {
            key: 'candidate-runbook',
            content: 'Review checkpoint candidates before promotion.',
            reason: 'Documents review queue behavior.',
            candidateType: 'runbook',
            confidence: 0.7,
            stability: 0.6,
            sensitivity: 'low',
            promotionRecommendation: 'review',
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
  assert.equal(checkpoint.memoryCandidateCount, 2);
  await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
  });

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
  });
  assert.equal(status.latestCheckpointId, checkpoint.id);
  assert.equal(status.latestCheckpointMemoryCandidateCount, 2);
  assert.match(status.memoryCandidateHint, /list_memory_candidates/);

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
  assert.equal(candidates.length, 2);
  const candidateRule = candidates.find((candidate) => candidate.candidate.key === 'candidate-rule');
  assert.ok(candidateRule.id);
  assert.equal(candidateRule.status, 'pending');
  assert.equal(candidateRule.checkpointId, checkpoint.id);
  assert.equal(candidateRule.index, 0);
  assert.equal(candidateRule.candidate.reason, '');
  assert.deepEqual(candidateRule.candidate.tags, ['promotion']);
  assert.equal(candidateRule.candidate.importance, 7);
  assert.equal(candidateRule.candidate.candidateType, 'project_policy');
  assert.equal(candidateRule.candidate.confidence, 0.91);
  assert.equal(candidateRule.candidate.stability, 0.88);
  assert.equal(candidateRule.candidate.sensitivity, 'low');
  assert.equal(candidateRule.candidate.promotionRecommendation, 'promote');
  assert.deepEqual(candidateRule.candidate.sourceEventIds, ['raw-candidate-1']);
  assert.equal(candidateRule.source.provider, 'candidate_provider');
  const candidateRunbook = candidates.find((candidate) => candidate.candidate.key === 'candidate-runbook');
  assert.ok(candidateRunbook.id);

  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 2);

  const promotedRecommendationCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
    candidateType: 'project_policy',
    promotionRecommendation: 'promote',
    sort: 'recommendation',
  });
  assert.equal(promotedRecommendationCandidates.length, 1);
  assert.equal(promotedRecommendationCandidates[0].id, candidateRule.id);

  const limitedCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
    limit: 1,
  });
  assert.equal(limitedCandidates.length, 1);

  const candidateInfo = app.dbInfo();
  assert.equal(candidateInfo.tables.memoryCandidates, 2);

  const promotedFromCandidate = app.promoteMemoryCandidate({
    scope: 'repo',
    scopeKey: 'repo-promote',
    candidateId: candidateRule.id,
    key: 'candidate-rule-via-helper',
    reason: 'Reviewed via helper.',
  });
  assert.equal(promotedFromCandidate.key, 'candidate-rule-via-helper');
  assert.equal(promotedFromCandidate.content, candidateRule.candidate.content);
  const helperEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.deepEqual(
    helperEmbeddingJobs.map((job) => job.sourceType),
    ['memory'],
  );
  await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
  });

  const helperEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule-via-helper',
  });
  assert.equal(helperEvents[0].metadata.sourceCheckpointId, checkpoint.id);
  assert.equal(helperEvents[0].metadata.sourceSessionId, 'candidate-session');
  assert.equal(helperEvents[0].metadata.sourceCandidateId, candidateRule.id);
  assert.deepEqual(helperEvents[0].metadata.candidateSourceEventIds, ['raw-candidate-1']);

  const promotedCandidate = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'promoted',
  });
  assert.equal(promotedCandidate.length, 1);
  assert.equal(promotedCandidate[0].id, candidateRule.id);
  assert.equal(promotedCandidate[0].promotedMemoryId, promotedFromCandidate.id);
  assert.equal(promotedCandidate[0].reviewReason, 'Reviewed via helper.');
  assert.ok(promotedCandidate[0].reviewedAt);
  assert.throws(
    () =>
      app.rejectMemoryCandidate({
        scope: 'repo',
        scopeKey: 'repo-promote',
        candidateId: candidateRule.id,
        reason: 'Should not reject after promotion.',
      }),
    /expected pending/,
  );

  const rejectedCandidate = app.rejectMemoryCandidate({
    scope: 'repo',
    scopeKey: 'repo-promote',
    candidateId: candidateRunbook.id,
    reason: 'Too procedural for durable memory.',
  });
  assert.equal(rejectedCandidate.status, 'rejected');
  assert.equal(rejectedCandidate.reviewReason, 'Too procedural for durable memory.');
  assert.equal(rejectedCandidate.reviewMetadata.sourceCandidateIndex, 1);
  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'repo-promote',
        candidateId: candidateRunbook.id,
      }),
    /expected pending/,
  );

  const pendingAfterReview = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.equal(pendingAfterReview.length, 0);

  app.deactivateMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule-via-helper',
    reason: 'Keep the helper assertion isolated from search assertions.',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('DELETE FROM memory_candidate_index').run();
    db.prepare("DELETE FROM schema_meta WHERE key = 'memory_candidate_index_backfill_completed_at'").run();
  } finally {
    db.close();
  }
  const appAfterBackfill = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  assert.equal(
    appAfterBackfill.listMemoryCandidates({
      scope: 'repo',
      scopeKey: 'repo-promote',
      sessionId: 'candidate-session',
    }).length,
    2,
  );

  const promoted = app.promoteMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: candidateRule.candidate.key,
    content: candidateRule.candidate.content,
    category: candidateRule.candidate.category,
    tags: candidateRule.candidate.tags,
    sourceCheckpointId: candidateRule.checkpointId,
    sourceSessionId: candidateRule.sessionId,
    sourceCandidateIndex: candidateRule.index,
    reason: 'Reviewed synthetic candidate.',
  });
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.key, 'candidate-rule');
  const promoteMemoryEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.ok(promoteMemoryEmbeddingJobs.some((job) => job.sourceType === 'memory'));

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
  const processedPromoteMemoryEmbedding = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
  });
  assert.ok(processedPromoteMemoryEmbedding.bySourceType.memory >= 1);

  const searchBeforeDeactivate = await app.search({
    scope: 'repo',
    scopeKey: 'repo-promote',
    query: 'human agent review',
  });
  const memoryBeforeDeactivate = searchBeforeDeactivate.find((result) => result.type === 'memory');
  assert.ok(memoryBeforeDeactivate, 'expected memory result before deactivation');
  assert.equal(memoryBeforeDeactivate.memory.key, 'candidate-rule');

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

  const searchAfterDeactivate = await app.search({
    scope: 'repo',
    scopeKey: 'repo-promote',
    query: 'agent review',
  });
  assert.equal(searchAfterDeactivate.find((result) => result.type === 'memory'), undefined);
});

test('CLI supports promoteMemory', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const promoted = await execFileAsync(
      'node',
      [
      path.resolve('src/cli.js'),
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

test('CLI supports candidate id promotion and rejection', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'CLI candidate checkpoint.',
        summaryText: 'The checkpoint proposes CLI candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'cli-candidate-promote',
            content: 'CLI can promote a memory candidate by id.',
          },
          {
            key: 'cli-candidate-reject',
            content: 'CLI can reject a memory candidate by id.',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'cli-review',
    sessionId: 'cli-review-session',
    role: 'assistant',
    content: 'Candidate review queue CLI smoke.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'cli-review',
    sessionId: 'cli-review-session',
  });
  const cliCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'cli-review',
    status: 'pending',
  });
  const promoteCandidate = cliCandidates.find((candidate) => candidate.candidate.key === 'cli-candidate-promote');
  const rejectCandidate = cliCandidates.find((candidate) => candidate.candidate.key === 'cli-candidate-reject');

  const promoted = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'promoteMemoryCandidate',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-review',
      '--candidateId',
      promoteCandidate.id,
      '--reason',
      'Reviewed from CLI.',
    ],
    { env },
  );
  assert.match(promoted.stdout, /"key": "cli-candidate-promote"/);

  const rejected = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'rejectMemoryCandidate',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-review',
      '--candidateId',
      rejectCandidate.id,
      '--reason',
      'Rejected from CLI.',
    ],
    { env },
  );
  assert.match(rejected.stdout, /"status": "rejected"/);
  assert.match(rejected.stdout, /Rejected from CLI/);

  const listed = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'listMemoryCandidates',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-review',
      '--status',
      'promoted',
    ],
    { env },
  );
  assert.match(listed.stdout, /"promotedMemoryId":/);
});

test('candidate promotion warnings require explicit override', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'warning_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      warning_provider: async () => ({
        summaryShort: 'Warning checkpoint.',
        summaryText: 'The checkpoint proposes risky candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'existing-rule',
            content: 'Different content for the same key.',
            reason: 'Tests key conflict detection.',
            candidateType: 'project_policy',
            confidence: 0.4,
            stability: 0.4,
            sensitivity: 'high',
            promotionRecommendation: 'reject',
          },
          {
            key: 'duplicate-content-rule',
            content: 'Existing durable memory content.',
            reason: 'Tests exact content duplicate detection.',
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'warning-repo',
    key: 'existing-rule',
    content: 'Original durable memory content.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'warning-repo',
    key: 'existing-content-rule',
    content: 'Existing durable memory content.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'warning-repo',
    sessionId: 'warning-session',
    role: 'assistant',
    content: 'Candidate: risky promotion.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'warning-repo',
    sessionId: 'warning-session',
  });
  const warningCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'warning-repo',
    status: 'pending',
    sort: 'recommendation',
  });
  const conflictCandidate = warningCandidates.find((candidate) => candidate.candidate.key === 'existing-rule');
  const duplicateContentCandidate = warningCandidates.find(
    (candidate) => candidate.candidate.key === 'duplicate-content-rule',
  );

  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'warning-repo',
        candidateId: conflictCandidate.id,
      }),
    /allowWarnings/,
  );

  try {
    app.promoteMemoryCandidate({
      scope: 'repo',
      scopeKey: 'warning-repo',
      candidateId: conflictCandidate.id,
    });
    assert.fail('Expected warning error.');
  } catch (error) {
    assert.equal(error.name, 'MemoryCandidatePromotionWarningError');
    assert.deepEqual(
      error.warnings.map((warning) => warning.code),
      ['existing_key_conflict', 'high_sensitivity', 'recommendation_not_promote', 'low_confidence', 'low_stability'],
    );
  }

  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'warning-repo',
        candidateId: duplicateContentCandidate.id,
      }),
    /allowWarnings/,
  );

  const promoted = app.promoteMemoryCandidate({
    scope: 'repo',
    scopeKey: 'warning-repo',
    candidateId: conflictCandidate.id,
    allowWarnings: true,
    reason: 'Reviewed warnings and accepted.',
  });
  assert.equal(promoted.key, 'existing-rule');

  const events = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'warning-repo',
    key: 'existing-rule',
  });
  assert.equal(events.at(-1).eventType, 'promote');
  assert.ok(events.at(-1).metadata.promotionWarnings.length >= 1);
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

test('Codex watch service installer pins explicit repo scope key', async () => {
  const home = await makeTempDir();
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  await execFileAsync(
    'bash',
    [
      'scripts/install-codex-watch-service.sh',
      '--name',
      'scope-test',
      '--repo-path',
      '/work/repo',
      '--scope-key',
      'github.com/example/repo',
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-codex-watch-scope-test.service'),
    'utf8',
  );
  assert.match(unit, /--repoPath \/work\/repo --scopeKey github\.com\/example\/repo/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
});

test('Codex watch service installer reports and pins inferred repo scope key', async () => {
  const home = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/inferred-watch-repo.git');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-codex-watch-service.sh',
      '--name',
      'inferred-scope-test',
      '--repo-path',
      repoPath,
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-codex-watch-inferred-scope-test.service'),
    'utf8',
  );
  assert.match(result.stdout, /Resolved repo scope key: github\.com\/example\/inferred-watch-repo/);
  assert.match(unit, /--scopeKey github\.com\/example\/inferred-watch-repo/);
});

test('Codex watch service installer rejects non-canonical repo scope keys', async () => {
  const home = await makeTempDir();

  await assert.rejects(
    () =>
      execFileAsync(
        'bash',
        [
          'scripts/install-codex-watch-service.sh',
          '--name',
          'scope-test',
          '--repo-path',
          '/work/repo',
          '--scope-key',
          'github.com/example/my repo',
          '--remote-url',
          'https://memory.example.com',
          '--token-env-file',
          path.join(home, 'token.env'),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
          },
        },
      ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--scope-key must be a canonical key/);
      return true;
    },
  );
});

test('Codex router service installer creates an agent-level router unit', async () => {
  const home = await makeTempDir();
  const registryPath = path.join(home, 'repos.json');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: '/work/repo-a',
          scopeKey: 'github.com/example/repo-a',
          adapters: ['codex'],
        },
        {
          name: 'repo-b',
          repoPath: '/work/repo-b',
          scopeKey: 'github.com/example/repo-b',
          adapters: ['claude_code'],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-codex-router-service.sh',
      '--name',
      'codex',
      '--repo-registry',
      registryPath,
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-codex-router-codex.service'),
    'utf8',
  );
  assert.match(result.stdout, /Installed codex agent router unit:/);
  assert.match(result.stdout, /Enabled Codex repos: 1/);
  assert.match(unit, /ingestCodexRoutedSessions/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
  assert.match(unit, new RegExp(`--repoRegistry ${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(unit, /--repoPath/);
});

test('Claude Code router service installer creates an agent-level router unit', async () => {
  const home = await makeTempDir();
  const registryPath = path.join(home, 'repos.json');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: '/work/repo-a',
          scopeKey: 'github.com/example/repo-a',
          adapters: ['claude_code'],
        },
        {
          name: 'repo-b',
          repoPath: '/work/repo-b',
          scopeKey: 'github.com/example/repo-b',
          adapters: ['codex'],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-claude-code-router-service.sh',
      '--name',
      'claude-code',
      '--repo-registry',
      registryPath,
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-claude-code-router-claude-code.service'),
    'utf8',
  );
  assert.match(result.stdout, /Installed claude_code agent router unit:/);
  assert.match(result.stdout, /Enabled Claude Code repos: 1/);
  assert.match(unit, /ingestClaudeCodeRoutedSessions/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
  assert.match(unit, new RegExp(`--repoRegistry ${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(unit, /--repoPath/);
});

test('unified agent router service installer creates one auto-detecting router unit', async () => {
  const homeRoot = await makeTempDir();
  const home = path.join(homeRoot, 'home with spaces');
  await fs.mkdir(home, { recursive: true });
  const registryPath = path.join(home, 'repos.json');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: '/work/repo-a',
          scopeKey: 'github.com/example/repo-a',
        },
        {
          name: 'repo-b',
          repoPath: '/work/repo-b',
          scopeKey: 'github.com/example/repo-b',
          adapters: ['cursor_cli'],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-agent-router-service.sh',
      '--name',
      'all-agents',
      '--repo-registry',
      registryPath,
      '--remote-url',
      'https://memory.example.com/api?token=abc$def',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--codex-sessions-dir',
      path.join(home, 'codex $sessions'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-agent-router-all-agents.service'),
    'utf8',
  );
  assert.match(result.stdout, /Installed unified agent router unit:/);
  assert.match(result.stdout, /Enabled repos: 2/);
  assert.match(result.stdout, /Requested adapters: auto-detect installed adapters/);
  assert.match(unit, /ingestAgentRoutedSessions/);
  assert.doesNotMatch(unit, /--adapters/);
  assert.match(unit, new RegExp(`WorkingDirectory=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(unit, new RegExp(`EnvironmentFile=-${path.join(home, 'token.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(unit, /Environment="CONTEXTFORGE_REMOTE_URL=https:\/\/memory\.example\.com\/api\?token=abc\$\$def"/);
  assert.match(unit, /--codexSessionsDir/);
  assert.match(unit, new RegExp(`--codexSessionsDir "${path.join(home, 'codex $$sessions').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(unit, /--claudeCodeProjectsDir/);
  assert.match(unit, /--opencodeDb/);
  assert.match(unit, /--grokSessionsDir/);
  assert.match(unit, /--cursorProjectsDir/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
  assert.match(unit, new RegExp(`--repoRegistry "${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('CLI reports invalid metadata JSON clearly', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  await assert.rejects(
    () =>
      execFileAsync(
      'node',
      [
      path.resolve('src/cli.js'),
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
      path.resolve('src/cli.js'),
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
  assert.equal(firstResult.parsedEvents, 2);
  assert.equal(firstResult.appendedEvents, 2);
  assert.equal(firstResult.skippedEvents, 0);
  assert.equal(firstResult.status.rawEventCount, 2);

  const second = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
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
  assert.equal(secondResult.skippedEvents, 2);
  assert.equal(secondResult.status.rawEventCount, 2);

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
    ['user', 'assistant'],
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
  assert.equal(result.appendedEvents, 2);
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

test('Codex ingest preserves raw evidence when auto distill fails', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-auto-fail-session');
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

  const result = await ingestCodexRolloutFile(app, {
    file,
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    distill: 'auto',
    charThreshold: 1,
  });

  assert.equal(result.appendedEvents, 2);
  assert.equal(result.checkpoint, null);
  assert.match(result.checkpointError.message, /synthetic provider failure/);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    sessionId: 'codex:codex-auto-fail-session',
  });
  assert.equal(events.length, 2);
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    sessionId: 'codex:codex-auto-fail-session',
  });
  assert.equal(runs[0].status, 'failed');

  const retry = await ingestCodexRolloutFile(app, {
    file,
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    distill: 'auto',
    charThreshold: 1,
  });
  assert.equal(retry.appendedEvents, 0);
  assert.equal(retry.checkpointSkippedReason, 'recent_failed_distill');
  assert.equal(
    app.listDistillRuns({
      scope: 'repo',
      scopeKey: 'codex-auto-fail-repo',
      sessionId: 'codex:codex-auto-fail-session',
    }).length,
    1,
  );
});

test('recent failed auto distill suppression uses the newest run', async () => {
  const skip = await shouldSkipRecentFailedAutoDistill(
    {
      listDistillRuns: async () => [
        {
          status: 'succeeded',
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          status: 'failed',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    },
    { scope: 'repo', scopeKey: 'repo-failed-distill' },
    'session-failed-distill',
    { thresholds: { minIntervalMs: 600000 } },
  );

  assert.equal(skip, true);
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
    assert.equal(result.appendedEvents, 2);
    assert.equal(result.status.rawEventCount, 2);

    const app = createContextForge({ env, cwd: process.cwd() });
    const rawEvents = await app.listRawEvents({
      scope: 'repo',
      scopeKey: 'codex-remote-ingest-repo',
      sessionId: 'codex:codex-remote-ingest-session',
    });
    assert.equal(rawEvents.length, 2);
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
  assert.equal(firstResult.parsedEvents, 4);
  assert.equal(firstResult.appendedEvents, 4);
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
  assert.equal(secondResult.skippedEvents, 4);

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
  assert.equal(firstEvents.length, 2);
  assert.equal(secondEvents.length, 2);
});

test('repoPath ingest skips Codex session files from other working directories', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const otherRepo = await makeTempDir();
  const targetRepo = await makeGitRepo('https://github.com/example/filter-target.git');
  const file = path.join(otherRepo, 'rollout-outside.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-outside-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--repoPath',
      targetRepo,
      '--distill',
      'never',
    ],
    { cwd: sessionsDir, env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.skippedReason, 'cwd_outside_repo_path');
  assert.equal(parsed.appendedEvents, 0);

  const app = createContextForge({ env, cwd: process.cwd() });
  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/filter-target',
    sessionId: 'codex:codex-outside-session',
  });
  assert.equal(events.length, 0);
});

test('Codex sessions watch loop picks up new events without duplicates', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const watchStateDir = await makeTempDir();
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
    watchStateDir,
    onResult: async (iterationResult) => {
      iterationResults.push(iterationResult);
      if (iterationResult.iteration === 1) {
        await appendSyntheticCodexAssistantMessage(file, 'A new active TUI event arrived.');
      }
    },
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.totals.appendedEvents, 3);
  assert.equal(iterationResults[0].appendedEvents, 2);
  assert.equal(iterationResults[1].appendedEvents, 1);
  assert.equal(iterationResults[1].skippedEvents, 0);
  assert.equal(iterationResults[1].filesChanged, 1);
  assert.equal('fileResults' in iterationResults[0], false);
  assert.ok(iterationResults[0].stateFile.startsWith(watchStateDir));

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-watch-repo',
    sessionId: 'codex:codex-watch-session',
  });
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).content, 'A new active TUI event arrived.');
});

test('Codex incremental watch keeps trailing partial JSON uncommitted until complete', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const rolloutDir = path.join(sessionsDir, '2026', '04', '25');
  const file = path.join(rolloutDir, 'rollout-partial.jsonl');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(file, 'codex-partial-session');
  await fs.appendFile(
    file,
    '{"timestamp":"2026-04-25T00:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial append',
  );
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
  });

  const first = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchStateDir,
    watchVerbose: true,
  });
  assert.equal(first.totals.appendedEvents, 2);
  assert.equal(first.results[0].fileResults[0].warnings.length, 0);

  await fs.appendFile(file, '"}]} }\n');
  const second = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchStateDir,
    watchVerbose: true,
  });
  assert.equal(second.totals.appendedEvents, 1);
  assert.equal(second.results[0].fileResults[0].parsedEvents, 1);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    sessionId: 'codex:codex-partial-session',
  });
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).content, 'partial append');

  await fs.appendFile(file, '{"malformed":\n');
  await appendSyntheticCodexAssistantMessage(file, 'Recovered after a malformed complete JSONL line.');
  const third = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchStateDir,
    watchVerbose: true,
  });
  assert.equal(third.totals.appendedEvents, 1);
  assert.equal(
    third.results[0].fileResults[0].warnings.some((warning) => warning.type === 'malformed_json_line'),
    true,
  );

  const recoveredEvents = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    sessionId: 'codex:codex-partial-session',
  });
  assert.equal(recoveredEvents.length, 4);
  assert.equal(recoveredEvents.at(-1).content, 'Recovered after a malformed complete JSONL line.');
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
  assert.equal(parsed.appendedEvents, 22);
});

test('CLI routes Codex global sessions through a repo registry', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const suiteRepo = await makeTempDir();
  const appRepo = path.join(suiteRepo, 'app');
  const frontendRepo = path.join(suiteRepo, 'app', 'frontend');
  const unknownRepo = await makeTempDir();
  await fs.mkdir(frontendRepo, { recursive: true });
  const rolloutDir = path.join(sessionsDir, '2026', '04', '26');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-suite.jsonl'), 'codex-suite', suiteRepo);
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-app.jsonl'), 'codex-app', path.join(appRepo, 'src'));
  await writeSyntheticCodexRollout(
    path.join(rolloutDir, 'rollout-frontend.jsonl'),
    'codex-frontend',
    path.join(frontendRepo, 'src'),
  );
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-unknown.jsonl'), 'codex-unknown', unknownRepo);
  const registryPath = path.join(sessionsDir, 'repo-registry.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      {
        repos: [
          {
            name: 'suite',
            repoPath: suiteRepo,
            scopeKey: 'github.com/example/suite',
            adapters: ['codex'],
          },
          {
            name: 'app',
            repoPath: appRepo,
            scopeKey: 'github.com/example/app',
          },
          {
            name: 'frontend',
            repoPath: frontendRepo,
            scopeKey: 'github.com/example/frontend',
          },
          {
            name: 'disabled',
            repoPath: unknownRepo,
            scopeKey: 'github.com/example/disabled',
            enabled: false,
          },
        ],
      },
      null,
      2,
    ),
  );
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexRoutedSessions',
      '--sessionsDir',
      sessionsDir,
      '--repoRegistry',
      registryPath,
      '--distill',
      'never',
    ],
    { env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.source, 'codex_sessions_router');
  assert.equal(parsed.filesScanned, 4);
  assert.equal(parsed.routedFiles, 3);
  assert.equal(parsed.skippedFiles, 1);
  assert.equal(parsed.appendedEvents, 6);
  assert.deepEqual(
    parsed.fileResults
      .filter((item) => item.matchedRepo)
      .map((item) => [item.sessionId, item.matchedRepo.name, item.matchedRepo.scopeKey])
      .sort(),
    [
      ['codex:codex-app', 'app', 'github.com/example/app'],
      ['codex:codex-frontend', 'frontend', 'github.com/example/frontend'],
      ['codex:codex-suite', 'suite', 'github.com/example/suite'],
    ],
  );
  const skipped = parsed.fileResults.find((item) => item.sessionId === 'codex:codex-unknown');
  assert.equal(skipped.skippedReason, 'unmatched_repo_cwd');

  const app = createContextForge({ env, cwd: process.cwd() });
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/frontend',
      sessionId: 'codex:codex-frontend',
    }).length,
    2,
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/app',
      sessionId: 'codex:codex-frontend',
    }).length,
    0,
  );
});

test('CLI ingests Claude Code JSONL transcripts with agent provenance', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const file = path.join(projectsDir, 'project-a', 'claude-session.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(file, 'claude-native-session');
  await fs.appendFile(file, '{"type":"assistant","sessionId":"claude-native-session"');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const first = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestClaudeCodeSessions',
      '--projectsDir',
      projectsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'claude-code-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.filesScanned, 1);
  assert.equal(firstResult.parsedEvents, 2);
  assert.equal(firstResult.appendedEvents, 2);
  assert.equal(firstResult.fileResults[0].sessionId, 'claude_code:claude-native-session');
  assert.equal(firstResult.fileResults[0].warnings.length, 1);

  const second = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestClaudeCodeSessions',
      '--projectsDir',
      projectsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'claude-code-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.appendedEvents, 0);
  assert.equal(secondResult.skippedEvents, 2);

  const rawEvents = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listRawEvents',
      '--scope',
      'repo',
      '--scopeKey',
      'claude-code-repo',
      '--sessionId',
      'claude_code:claude-native-session',
    ],
    { env },
  );
  const events = JSON.parse(rawEvents.stdout);
  assert.deepEqual(
    events.map((event) => event.role),
    ['user', 'assistant'],
  );
  assert.deepEqual(
    events.map((event) => event.content),
    ['Continue the ContextForge Claude Code ingest work.', 'I added Claude Code transcript ingestion.'],
  );
  assert.ok(events.every((event) => event.metadata.sourceAgent === 'claude_code'));
  assert.ok(events.every((event) => event.metadata.sourceAdapter === 'claude_code_jsonl'));
  assert.ok(events.every((event) => event.metadata.nativeSessionId === 'claude-native-session'));
});

test('Claude Code incremental watch skips unchanged transcript bytes', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const file = path.join(projectsDir, 'project-a', 'claude-watch.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(file, 'claude-watch-session');
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
  });

  const result = await watchClaudeCodeSessions(app, {
    projectsDir,
    scope: 'repo',
    scopeKey: 'claude-watch-repo',
    distill: 'never',
    iterations: 2,
    intervalMs: 1,
    watchStateDir,
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.results[0].filesChanged, 1);
  assert.equal(result.results[0].appendedEvents, 2);
  assert.equal(result.results[1].filesChanged, 0);
  assert.equal(result.results[1].parsedEvents, 0);
  assert.equal(result.results[1].skippedEvents, 0);
  assert.equal('fileResults' in result.results[0], false);
  assert.ok(result.results[0].stateFile.startsWith(watchStateDir));
});

test('CLI routes Claude Code global transcripts through a repo registry', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const suiteRepo = await makeTempDir();
  const appRepo = path.join(suiteRepo, 'app');
  const frontendRepo = path.join(suiteRepo, 'app', 'frontend');
  const unknownRepo = await makeTempDir();
  await fs.mkdir(frontendRepo, { recursive: true });
  await fs.mkdir(path.join(projectsDir, 'suite'), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(path.join(projectsDir, 'suite', 'suite.jsonl'), 'claude-suite', suiteRepo);
  await writeSyntheticClaudeCodeTranscript(
    path.join(projectsDir, 'suite', 'app.jsonl'),
    'claude-app',
    path.join(appRepo, 'src'),
  );
  await writeSyntheticClaudeCodeTranscript(
    path.join(projectsDir, 'suite', 'frontend.jsonl'),
    'claude-frontend',
    path.join(frontendRepo, 'src'),
  );
  await writeSyntheticClaudeCodeTranscript(
    path.join(projectsDir, 'suite', 'unknown.jsonl'),
    'claude-unknown',
    unknownRepo,
  );
  const registryPath = path.join(projectsDir, 'repo-registry.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      {
        repos: [
          {
            name: 'suite',
            repoPath: suiteRepo,
            scopeKey: 'github.com/example/suite',
            adapters: ['claude_code'],
          },
          {
            name: 'app',
            repoPath: appRepo,
            scopeKey: 'github.com/example/app',
          },
          {
            name: 'frontend',
            repoPath: frontendRepo,
            scopeKey: 'github.com/example/frontend',
          },
          {
            name: 'disabled',
            repoPath: unknownRepo,
            scopeKey: 'github.com/example/disabled',
            enabled: false,
          },
        ],
      },
      null,
      2,
    ),
  );
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestClaudeCodeRoutedSessions',
      '--projectsDir',
      projectsDir,
      '--repoRegistry',
      registryPath,
      '--distill',
      'never',
    ],
    { env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.source, 'claude_code_sessions_router');
  assert.equal(parsed.filesScanned, 4);
  assert.equal(parsed.routedFiles, 3);
  assert.equal(parsed.skippedFiles, 1);
  assert.equal(parsed.appendedEvents, 6);
  assert.deepEqual(
    parsed.fileResults
      .filter((item) => item.matchedRepo)
      .map((item) => [item.sessionId, item.matchedRepo.name, item.matchedRepo.scopeKey])
      .sort(),
    [
      ['claude_code:claude-app', 'app', 'github.com/example/app'],
      ['claude_code:claude-frontend', 'frontend', 'github.com/example/frontend'],
      ['claude_code:claude-suite', 'suite', 'github.com/example/suite'],
    ],
  );
  const skipped = parsed.fileResults.find((item) => item.sessionId === 'claude_code:claude-unknown');
  assert.equal(skipped.skippedReason, 'unmatched_repo_cwd');

  const app = createContextForge({ env, cwd: process.cwd() });
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/frontend',
      sessionId: 'claude_code:claude-frontend',
    }).length,
    2,
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/app',
      sessionId: 'claude_code:claude-frontend',
    }).length,
    0,
  );
});

test('agent adapter registry exposes the built-in multi-agent ingest set', () => {
  assert.deepEqual(
    listAgentAdapters()
      .map((adapter) => adapter.id)
      .sort(),
    ['claude_code', 'codex', 'cursor_cli', 'grok', 'opencode'],
  );
});

test('multi-agent routed ingest shares repo scope while preserving source provenance', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const claudeCodeProjectsDir = path.join(root, 'claude');
  const grokSessionsDir = path.join(root, 'grok');
  const cursorProjectsDir = path.join(root, 'cursor');
  const opencodeDb = path.join(root, 'opencode', 'opencode.db');

  await fs.mkdir(path.join(codexSessionsDir, '2026', '06', '04'), { recursive: true });
  await writeSyntheticCodexRollout(
    path.join(codexSessionsDir, '2026', '06', '04', 'rollout-codex.jsonl'),
    'registry-codex',
    repo,
  );
  await fs.mkdir(path.join(claudeCodeProjectsDir, 'project-a'), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(
    path.join(claudeCodeProjectsDir, 'project-a', 'claude.jsonl'),
    'registry-claude',
    repo,
  );
  await writeSyntheticGrokChatHistory(grokSessionsDir, 'registry-grok', repo);
  await writeSyntheticCursorTranscript(cursorProjectsDir, 'registry-cursor');
  await writeSyntheticOpenCodeDb(opencodeDb, 'registry-opencode', repo);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'shared-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/shared-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async (input) => ({
        provider: 'candidate_provider',
        summaryShort: `Candidate checkpoint for ${input.session.sessionId}.`,
        summaryText: `Multi-agent candidate checkpoint for ${input.session.sessionId}.`,
        workingSummary: `Working summary for ${input.session.sessionId}.`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: `multi_agent.${input.session.sessionId.replace(/[^a-z0-9]+/gi, '_')}`,
            content: 'ContextForge multi-agent ingest keeps origin provenance while sharing repo-scoped handoff.',
            reason: 'This is a stable cross-agent ingest contract.',
            category: 'architecture',
            tags: ['multi-agent', 'ingest'],
            importance: 1,
            candidateType: 'architecture_decision',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: input.rawEvents.length,
        metadata: {},
      }),
    },
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'codex,claude_code,grok,cursor_cli,opencode',
    codexSessionsDir,
    claudeCodeProjectsDir,
    grokSessionsDir,
    cursorProjectsDir,
    opencodeDb,
    repoRegistry: registryPath,
    cwd: repo,
    distill: 'always',
  });

  assert.equal(result.source, 'agent_sessions_router');
  assert.deepEqual(result.adapters, ['codex', 'claude_code', 'grok', 'cursor_cli', 'opencode']);
  assert.equal(result.filesScanned, 5);
  assert.equal(result.routedFiles, 5);
  assert.equal(result.appendedEvents, 10);
  assert.equal(result.checkpointsCreated, 5);
  const opencodeResult = result.adapterResults.find((adapterResult) => adapterResult.adapter === 'opencode');
  assert.equal(opencodeResult.stateLoaded, false);
  assert.equal(opencodeResult.stateUpdated, false);
  assert.equal(opencodeResult.corruptStateFile, null);
  assert.deepEqual(
    result.adapterResults.map((adapterResult) => [adapterResult.adapter, adapterResult.routedFiles]).sort(),
    [
      ['claude_code', 1],
      ['codex', 1],
      ['cursor_cli', 1],
      ['grok', 1],
      ['opencode', 1],
    ],
  );

  for (const [sessionId, sourceAgent] of [
    ['codex:registry-codex', 'codex'],
    ['claude_code:registry-claude', 'claude_code'],
    ['grok:registry-grok', 'grok'],
    ['cursor_cli:registry-cursor', 'cursor_cli'],
    ['opencode:registry-opencode', 'opencode'],
  ]) {
    const events = app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/shared-repo',
      sessionId,
    });
    assert.equal(events.length, 2, sessionId);
    assert.ok(events.every((event) => event.metadata.sourceAgent === sourceAgent), sessionId);
    assert.ok(events.every((event) => event.metadata.nativeSessionId), sessionId);
  }

  const opencodeCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    sessionId: 'opencode:registry-opencode',
    status: 'pending',
  });
  assert.equal(opencodeCandidates.length, 1);
  assert.equal(opencodeCandidates[0].source.sourceAgent, 'opencode');
  assert.equal(opencodeCandidates[0].source.sourceProvenance.sourceAdapter, 'opencode_sqlite');

  const suggestions = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    sessionId: 'opencode:registry-opencode',
    trigger: 'manual_closeout',
  });
  assert.equal(suggestions.proposals.length, 1);
  assert.equal(suggestions.proposals[0].evidence.sourceAgent, 'opencode');
  assert.equal(suggestions.proposals[0].evidence.sourceProvenance.sourceRuntime, 'opencode_cli');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    query: 'multi agent handoff',
    latestCheckpointLimit: 1,
  });
  assert.deepEqual(Object.keys(bootstrap.handoff.latestByAgent).sort(), [
    'claude_code',
    'codex',
    'cursor_cli',
    'grok',
    'opencode',
  ]);
  assert.equal(bootstrap.handoff.latestByAgent.codex.sourceProvenance.sourceAgent, 'codex');
  assert.equal(bootstrap.handoff.latestByAgent.opencode.sourceProvenance.sourceAdapter, 'opencode_sqlite');
  assert.equal(bootstrap.handoff.latestCheckpoints.length, 1);
  const resume = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    sessionId: 'opencode:registry-opencode',
    query: 'multi agent handoff',
  });
  assert.equal(resume.handoff.memoryCandidates.items[0].sourceAgent, 'opencode');
  assert.equal(resume.handoff.memoryCandidates.items[0].sourceProvenance.sourceAdapter, 'opencode_sqlite');
});

test('multi-agent routed ingest matches temporary checkouts by git remote scopeKey', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const canonicalRepo = await makeTempDir();
  const reviewCheckout = await makeGitRepo('git@github.com:example/shared-repo.git');
  const opencodeDb = path.join(root, 'opencode', 'opencode.db');
  await writeSyntheticOpenCodeDb(opencodeDb, 'opencode-review-checkout', reviewCheckout);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'shared-repo',
          repoPath: canonicalRepo,
          scopeKey: 'github.com/example/shared-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'opencode',
    opencodeDb,
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.equal(result.adapters[0], 'opencode');
  assert.equal(result.routedFiles, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.appendedEvents, 2);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'github.com/example/shared-repo');
  assert.equal(result.adapterResults[0].fileResults[0].cwd, undefined);
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/shared-repo',
      sessionId: 'opencode:opencode-review-checkout',
    }).length,
    2,
  );
});

test('multi-agent routed ingest keeps nested namespace git remotes distinct', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repoA = await makeTempDir();
  const repoB = await makeTempDir();
  const reviewCheckout = await makeGitRepo('git@gitlab.com:group/subgroup/repo-b.git');
  const opencodeDb = path.join(root, 'opencode', 'opencode.db');
  await writeSyntheticOpenCodeDb(opencodeDb, 'opencode-nested-namespace', reviewCheckout);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: repoA,
          scopeKey: 'gitlab.com/group/subgroup/repo-a',
        },
        {
          name: 'repo-b',
          repoPath: repoB,
          scopeKey: 'gitlab.com/group/subgroup/repo-b',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'opencode',
    opencodeDb,
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.equal(result.routedFiles, 1);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'gitlab.com/group/subgroup/repo-b');
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'gitlab.com/group/subgroup/repo-a',
      sessionId: 'opencode:opencode-nested-namespace',
    }).length,
    0,
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'gitlab.com/group/subgroup/repo-b',
      sessionId: 'opencode:opencode-nested-namespace',
    }).length,
    2,
  );
});

test('Cursor CLI routed ingest matches temporary checkouts by git remote scopeKey', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const canonicalRepo = await makeTempDir();
  const reviewCheckout = await makeGitRepo('https://github.com/example/cursor-repo.git');
  const cursorProjectsDir = path.join(root, 'cursor');
  await writeSyntheticCursorTranscript(cursorProjectsDir, 'cursor-review-checkout', 'unmatched-review-project');

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'cursor-repo',
          repoPath: canonicalRepo,
          scopeKey: 'github.com/example/cursor-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'cursor_cli',
    cursorProjectsDir,
    repoRegistry: registryPath,
    cwd: reviewCheckout,
    distill: 'never',
  });

  assert.equal(result.routedFiles, 1);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'github.com/example/cursor-repo');
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/cursor-repo',
      sessionId: 'cursor_cli:cursor-review-checkout',
    }).length,
    2,
  );
});

test('Cursor CLI routed ingest matches project names without lossy path decoding', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = path.join(root, 'repo-with-hyphen');
  await fs.mkdir(repo, { recursive: true });
  const cursorProjectsDir = path.join(root, 'cursor');
  const cursorProjectName = repo
    .split(path.sep)
    .filter(Boolean)
    .join('-');
  await writeSyntheticCursorTranscript(cursorProjectsDir, 'cursor-hyphen-session', cursorProjectName);
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'hyphen-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/repo-with-hyphen',
          adapters: ['cursor_cli'],
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'cursor_cli',
    cursorProjectsDir,
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.equal(result.routedFiles, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.appendedEvents, 2);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'github.com/example/repo-with-hyphen');
  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/repo-with-hyphen',
    sessionId: 'cursor_cli:cursor-hyphen-session',
  });
  assert.equal(events.length, 2);
});

test('multi-agent routed ingest auto-detects installed adapters for one-shot scans', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const rolloutDir = path.join(codexSessionsDir, '2026', '06', '04');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-one-shot.jsonl'), 'one-shot-codex', repo);
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'one-shot-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/one-shot-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: path.join(root, 'missing-claude'),
    grokSessionsDir: path.join(root, 'missing-grok'),
    cursorProjectsDir: path.join(root, 'missing-cursor'),
    opencodeDb: path.join(root, 'missing-opencode', 'opencode.db'),
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.deepEqual(result.adapters, ['codex']);
  assert.equal(result.inactiveAdapters.length, 4);
  assert.equal(result.filesScanned, 1);
  assert.equal(result.appendedEvents, 2);
});

test('OpenCode adapter rejects ambiguous --file ingest', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  await assert.rejects(
    () =>
      ingestAgentSessions(app, {
        adapters: 'opencode',
        file: '/tmp/not-a-session-file',
        scope: 'repo',
        scopeKey: 'github.com/example/opencode-file',
        distill: 'never',
      }),
    /--file is not supported for opencode/,
  );
});

test('multi-agent routed watch isolates bad units and continues ingesting good files', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const rolloutDir = path.join(codexSessionsDir, '2026', '06', '04');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-good.jsonl'), 'isolated-good-codex', repo);
  await fs.writeFile(
    path.join(rolloutDir, 'rollout-bad.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-04-25T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'This file has no session metadata.' }],
      },
    })}\n`,
  );
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'watch-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/isolated-watch-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await watchAgentRoutedSessions(app, {
    adapters: 'codex',
    codexSessionsDir,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.equal(result.totals.filesScanned, 2);
  assert.equal(result.totals.appendedEvents, 2);
  const fileResults = result.results[0].adapterResults[0].fileResults;
  assert.equal(fileResults.some((fileResult) => fileResult.skippedReason === 'unit_error'), true);
  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/isolated-watch-repo',
    sessionId: 'codex:isolated-good-codex',
  });
  assert.equal(events.length, 2);
});

test('multi-agent routed watch auto-detects installed adapters and uses incremental state', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const missingClaudeCodeProjectsDir = path.join(root, 'missing-claude');
  const missingGrokSessionsDir = path.join(root, 'missing-grok');
  const missingCursorProjectsDir = path.join(root, 'missing-cursor');
  const missingOpenCodeDb = path.join(root, 'missing-opencode', 'opencode.db');
  const rolloutDir = path.join(codexSessionsDir, '2026', '06', '04');
  const rolloutFile = path.join(rolloutDir, 'rollout-unified-watch.jsonl');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(rolloutFile, 'unified-watch-codex', repo);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'watch-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/watch-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const first = await watchAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: missingClaudeCodeProjectsDir,
    grokSessionsDir: missingGrokSessionsDir,
    cursorProjectsDir: missingCursorProjectsDir,
    opencodeDb: missingOpenCodeDb,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.deepEqual(first.adapters, ['codex']);
  assert.deepEqual(
    first.inactiveAdapters.map((adapter) => [adapter.adapter, adapter.reason]).sort(),
    [
      ['claude_code', 'missing_root'],
      ['cursor_cli', 'missing_root'],
      ['grok', 'missing_root'],
      ['opencode', 'missing_root'],
    ],
  );
  assert.equal(first.totals.filesScanned, 1);
  assert.equal(first.totals.appendedEvents, 2);
  assert.equal(first.results[0].adapterResults[0].stateUpdated, true);

  const second = await watchAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: missingClaudeCodeProjectsDir,
    grokSessionsDir: missingGrokSessionsDir,
    cursorProjectsDir: missingCursorProjectsDir,
    opencodeDb: missingOpenCodeDb,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.deepEqual(second.adapters, ['codex']);
  assert.equal(second.totals.filesScanned, 1);
  assert.equal(second.totals.filesChanged, 0);
  assert.equal(second.totals.appendedEvents, 0);
  assert.equal(second.results[0].adapterResults[0].stateLoaded, true);

  await fs.appendFile(rolloutFile, '{"malformed":\n');
  await appendSyntheticCodexAssistantMessage(rolloutFile, 'Recovered after a malformed complete JSONL line.');
  const third = await watchAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: missingClaudeCodeProjectsDir,
    grokSessionsDir: missingGrokSessionsDir,
    cursorProjectsDir: missingCursorProjectsDir,
    opencodeDb: missingOpenCodeDb,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.equal(third.totals.filesChanged, 1);
  assert.equal(third.totals.appendedEvents, 1);
  assert.equal(
    third.results[0].adapterResults[0].fileResults[0].warnings.some(
      (warning) => warning.type === 'malformed_json_line',
    ),
    true,
  );

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/watch-repo',
    sessionId: 'codex:unified-watch-codex',
  });
  assert.equal(events.length, 3);
});

test('multi-agent routed watch reports explicitly requested missing adapters without scanning files', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const missingCursorProjectsDir = path.join(root, 'missing-cursor');
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'watch-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/watch-repo',
          adapters: ['cursor_cli'],
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await watchAgentRoutedSessions(app, {
    adapters: 'cursor_cli',
    cursorProjectsDir: missingCursorProjectsDir,
    repoRegistry: registryPath,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.deepEqual(result.adapters, ['cursor_cli']);
  assert.equal(result.inactiveAdapters.length, 0);
  assert.equal(result.totals.filesScanned, 0);
  assert.equal(result.results[0].adapterResults[0].skippedAdapter, true);
  assert.equal(result.results[0].adapterResults[0].skippedReason, 'missing_root');
});

test('repoPath ingest skips Claude Code transcripts from other working directories', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const targetRepo = await makeGitRepo('https://github.com/example/claude-filter-target.git');
  const otherDir = await makeTempDir();
  const file = path.join(otherDir, 'claude-outside.jsonl');
  await writeSyntheticClaudeCodeTranscript(file, 'claude-outside-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'ingestClaudeCodeFile',
      '--file',
      file,
      '--scope',
      'repo',
      '--repoPath',
      targetRepo,
      '--distill',
      'never',
    ],
    { cwd: projectsDir, env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.skippedReason, 'cwd_outside_repo_path');
  assert.equal(parsed.appendedEvents, 0);
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

test('embedding rebuild populates sqlite-vec index for hybrid retrieval', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const value = String(text).toLowerCase();
        if (value.includes('semantic fruit')) return [1, 0, 0];
        if (value.includes('apple')) return [1, 0, 0];
        if (value.includes('database')) return [0, 1, 0];
        return [0, 0, 1];
      });
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: provider,
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector',
    key: 'apple-note',
    content: 'Apple orchards need pollination planning.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector',
    key: 'database-note',
    content: 'Database migrations need rollback planning.',
  });

  const rebuilt = await app.rebuildEmbeddings({
    scope: 'repo',
    scopeKey: 'repo-vector',
  });
  assert.equal(rebuilt.embedded, 2);
  assert.equal(rebuilt.dimensions, 3);
  assert.deepEqual(rebuilt.bySourceType, { memory: 2 });

  const results = await app.search({
    scope: 'repo',
    scopeKey: 'repo-vector',
    query: 'semantic fruit',
  });

  assert.equal(results[0].memory.key, 'apple-note');
  assert.equal(results[0].retrieval.method, 'vector');
  assert.equal(results[0].retrieval.vectorDistance, 0);
  assert.equal(results[0].retrieval.vectorModel, 'test-embedding');
  assert.equal(results[0].retrieval.vectorDimensions, 3);

  const info = app.dbInfo();
  assert.equal(info.tables.embeddings, 2);
  assert.equal(info.vector.sqliteVecAvailable, true);
  assert.equal(info.vector.dimensions, 3);
});

test('vector search still runs for Korean queries that have no lexical tokens', () => {
  const memory = {
    id: 'memory-korean',
    key: 'korean-memory',
    category: 'note',
    content: '한국어 의미 검색은 벡터 경로로 동작해야 한다.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const results = searchMemories(
    {
      searchMemoryVectorIndex: () => [{ memory, distance: 0, model: 'test-embedding', dimensions: 3 }],
      listMemories: () => {
        throw new Error('listMemories should not be called when the query has no lexical tokens.');
      },
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-korean',
      query: '체크포인트 후보',
      queryEmbedding: [1, 0, 0],
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'korean-memory');
  assert.equal(results[0].retrieval.method, 'vector');
});

test('hybrid ranking keeps strong lexical matches ahead of weak vector-only matches', () => {
  const exactMemory = {
    id: 'memory-exact',
    key: 'sqlite-vec-upsert',
    category: 'decision',
    content: 'Track sqlite-vec upsert behavior.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const vectorMemory = {
    id: 'memory-vector',
    key: 'unrelated-vector',
    category: 'note',
    content: 'A weak semantic neighbor.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  const results = searchMemories(
    {
      searchMemoryVectorIndex: () => [{ memory: vectorMemory, distance: 0.99, model: 'test-embedding', dimensions: 3 }],
      listMemories: () => [exactMemory],
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-ranking',
      query: 'sqlite-vec-upsert',
      queryEmbedding: [1, 0, 0],
    },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].memory.key, 'sqlite-vec-upsert');
  assert.equal(results[0].retrieval.method, 'lexical');
  assert.equal(results[1].memory.key, 'unrelated-vector');
  assert.equal(results[1].retrieval.method, 'vector');
});

test('distillCheckpoint queues embedding jobs and processEmbeddingJobs indexes them', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const value = String(text).toLowerCase();
        if (value.includes('candidate')) return [0, 1, 0];
        if (value.includes('checkpoint')) return [1, 0, 0];
        return [0, 0, 1];
      });
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'Checkpoint summary.',
        summaryText: 'Checkpoint detail for embedding.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'embedded-candidate',
            content: 'Candidate content for embedding.',
            reason: 'Candidate reason.',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    sessionId: 'distill-vector-session',
    role: 'assistant',
    content: 'Checkpoint should embed immediately after successful distillation.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    sessionId: 'distill-vector-session',
  });

  assert.equal(checkpoint.embedding.reason, 'queued');
  assert.equal(checkpoint.embedding.queued, 2);
  assert.deepEqual(checkpoint.embedding.bySourceType, {
    checkpoint: 1,
    memory_candidate: 1,
  });
  assert.equal(app.dbInfo().tables.embeddings, 0);
  assert.equal(app.dbInfo().embeddings.jobs.pending, 2);

  const processed = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
  });
  assert.equal(processed.embedded, 2);
  assert.deepEqual(processed.bySourceType, {
    checkpoint: 1,
    memory_candidate: 1,
  });
  assert.equal(app.dbInfo().tables.embeddings, 2);
  assert.equal(app.dbInfo().embeddings.jobs.completed, 2);
  assert.equal(app.dbInfo().embeddings.coverage.staleSources, 0);

  const checkpointResults = await app.search({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    query: 'checkpoint search',
  });
  assert.equal(checkpointResults[0].type, 'checkpoint');
  assert.equal(checkpointResults[0].checkpoint.id, checkpoint.id);
  assert.equal(checkpointResults[0].retrieval.method, 'vector');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    query: 'checkpoint search',
  });
  const bootstrapCheckpoint = bootstrap.results.find((item) => item.type === 'checkpoint');
  assert.equal(bootstrapCheckpoint.trust, 'credible_recent_handoff');
  assert.match(bootstrapCheckpoint.whyUse, /Credible recent handoff state/);

  const candidateResults = await app.search({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    query: 'candidate search',
  });
  assert.equal(candidateResults[0].type, 'memory_candidate');
  assert.equal(candidateResults[0].candidate.candidate.key, 'embedded-candidate');
  assert.equal(candidateResults[0].retrieval.vectorModel, 'test-embedding');
});

test('embedding jobs can fail and be retried independently after distill succeeds', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('bad-candidate-vector') ? [0, 1] : [1, 0, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'partial_embedding_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      partial_embedding_provider: async () => ({
        summaryShort: 'Checkpoint summary.',
        summaryText: 'Checkpoint detail.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'bad-candidate-vector',
            content: 'Candidate content.',
            reason: 'The second vector has the wrong dimension.',
          },
        ],
        sourceEventCount: 1,
        metadata: {},
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
    sessionId: 'partial-embedding-session',
    role: 'assistant',
    content: 'Create a checkpoint and candidate.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
    sessionId: 'partial-embedding-session',
  });

  assert.equal(checkpoint.embedding.reason, 'queued');
  assert.equal(checkpoint.embedding.queued, 2);
  const processed = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
  });
  assert.equal(processed.embedded, 1);
  assert.equal(processed.failed, 1);
  assert.deepEqual(processed.bySourceType, { checkpoint: 1 });
  const failedJobs = app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
    status: 'failed',
  });
  assert.equal(failedJobs.length, 1);
  assert.match(failedJobs[0].lastError, /dimensions/);
  assert.equal(app.dbInfo().embeddings.coverage.staleSources, 1);
});

test('search unions lexical candidates with FTS candidates', () => {
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
      listMemories: () => [],
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

test('embedding dimension changes require an explicit forced rebuild', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map(() => Array.from({ length: provider.dimensions }, (_, index) => (index === 0 ? 1 : 0)));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: provider,
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-dimensions',
    key: 'dimension-note',
    content: 'Dimension changes should be explicit.',
  });
  await app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-dimensions' });

  provider.dimensions = 2;
  await assert.rejects(
    () => app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-dimensions' }),
    /Embedding dimensions changed from 3 to 2/,
  );
  const rebuilt = await app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-dimensions', force: true });
  assert.equal(rebuilt.dimensions, 2);
});

test('checkpoint embedding text flattens selected structured handoff fields', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  try {
    const checkpoint = store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-structured-embedding',
      sessionId: 'structured-embedding-session',
      summaryShort: 'Structured embedding checkpoint.',
      summaryText: 'Structured embedding detail.',
      decisions: [],
      todos: [],
      openQuestions: [],
      provider: 'test',
      metadata: {
        structured: {
          schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
          work: {
            intent: 'Index structured checkpoint handoff fields.',
            status: 'verified',
            outcome: 'Embedding text includes selected structured facts.',
          },
          liveState: {
            repo: 'github.com/ginishuh/contextforge',
            branch: 'feature/structured-checkpoints',
            headCommit: 'abc1234',
            prNumber: 119,
            ciStatus: 'pass',
          },
          changes: [
            {
              type: 'storage',
              name: 'candidate_json',
              description: 'Preserve raw memory candidate fields.',
            },
          ],
          verification: [
            {
              command: 'npm test',
              result: 'pass',
              details: 'structured checkpoint tests pass',
            },
          ],
          risks: [
            {
              risk: 'Live state may be stale.',
              mitigation: 'Recheck GitHub before acting.',
            },
          ],
          nextActions: [
            {
              action: 'Open a PR.',
              priority: 'medium',
            },
          ],
        },
      },
    });
    const text = store.embeddingTextForCheckpoint(checkpoint);
    assert.match(text, /feature\/structured-checkpoints/);
    assert.match(text, /PR #119/);
    assert.match(text, /candidate_json/);
    assert.match(text, /npm test pass/);
    assert.doesNotMatch(text, /schemaVersion/);
  } finally {
    store.close();
  }
});

test('OpenAI embeddings omit dimensions for legacy embedding models', async () => {
  let requestBody = null;
  const provider = createOpenAiEmbeddingProvider(
    {
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
      model: 'text-embedding-ada-002',
      dimensions: 1536,
      timeoutMs: 1000,
    },
    {
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0) }] };
          },
        };
      },
    },
  );

  await provider.embed(['legacy model']);

  assert.equal(requestBody.model, 'text-embedding-ada-002');
  assert.equal(Object.hasOwn(requestBody, 'dimensions'), false);
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
  assert.equal(statusBefore.distillWindow.selectedEventCount, 2);
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
  assert.equal(checkpoint.memoryCandidateCount, 0);

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 2);
  assert.equal(info.tables.checkpoints, 1);
  assert.equal(info.tables.distillRuns, 1);
  assert.equal(info.tables.workingSummaries, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].outputMetadata.checkpointId, checkpoint.id);
  assert.equal(runs[0].outputMetadata.workingSummaryUpdated, true);
  assert.ok(runs[0].outputMetadata.workingSummaryId);
  assert.equal(runs[0].inputMetadata.sourceEventWindow.selectedEventCount, 2);
  assert.equal(runs[0].inputMetadata.previousWorkingSummaryId, null);

  const workingSummary = app.getWorkingSummary({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
  });
  assert.equal(workingSummary.sessionId, session.sessionId);
  assert.equal(workingSummary.sourceCheckpointId, checkpoint.id);
  assert.match(workingSummary.summaryText, /Current session state/);

  const statusAfter = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    minEvents: 1,
  });
  assert.equal(statusAfter.latestCheckpointId, checkpoint.id);
  assert.equal(statusAfter.eventsSinceLastCheckpoint, 0);
  assert.equal(statusAfter.distillWindow.selectedEventCount, 0);
  assert.equal(statusAfter.latestCheckpointMemoryCandidateCount, 0);
  assert.equal(statusAfter.memoryCandidateHint, null);
  assert.equal(statusAfter.shouldDistill, false);
});

test('listDistillRuns can return newest runs first when limited', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'run-order-repo',
    sessionId: 'older-session',
    role: 'user',
    content: 'Create the older run.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'run-order-repo',
    sessionId: 'older-session',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'run-order-repo',
    sessionId: 'newer-session',
    role: 'user',
    content: 'Create the newer run.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'run-order-repo',
    sessionId: 'newer-session',
  });

  const oldestFirst = app.listDistillRuns({ scope: 'repo', scopeKey: 'run-order-repo', limit: 1 });
  assert.equal(oldestFirst[0].sessionId, 'older-session');
  const newestFirst = app.listDistillRuns({ scope: 'repo', scopeKey: 'run-order-repo', limit: 1, order: 'desc' });
  assert.equal(newestFirst[0].sessionId, 'newer-session');
});

test('listRecentDistillRuns returns newest runs across scopes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'older-repo',
    sessionId: 'older-session',
    role: 'user',
    content: 'Create the older cross-scope run.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'older-repo',
    sessionId: 'older-session',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'newer-repo',
    sessionId: 'newer-session',
    role: 'user',
    content: 'Create the newer cross-scope run.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'newer-repo',
    sessionId: 'newer-session',
  });

  const recent = app.listRecentDistillRuns({ limit: 2 });
  assert.deepEqual(
    recent.map((run) => [run.scopeKey, run.sessionId]),
    [
      ['newer-repo', 'newer-session'],
      ['older-repo', 'older-session'],
    ],
  );

  const filtered = app.listRecentDistillRuns({ scope: 'repo', scopeKey: 'older-repo', limit: 1 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sessionId, 'older-session');
});

test('distillCheckpoint records checkpoint level and coverage metadata', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'level_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      level_provider: async () => ({
        summaryShort: 'Daily checkpoint.',
        summaryText: 'Consolidated daily checkpoint state.',
        decisions: [],
        todos: [],
        openQuestions: [],
        workingSummary: 'Daily working summary.',
        memoryCandidates: [],
        sourceEventCount: 2,
        metadata: {},
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-level',
    sessionId: 'level-session',
    role: 'user',
    content: 'First level event.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-level',
    sessionId: 'level-session',
    role: 'assistant',
    content: 'Second level event.',
  });

  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-level',
    sessionId: 'level-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-level',
    sessionId: 'level-session',
    role: 'assistant',
    content: 'Third level event.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-level',
    sessionId: 'level-session',
    level: 1,
    source: 'daily_consolidation',
    sourceRef: '2026-05-08',
  });

  assert.equal(checkpoint.level, 1);
  assert.ok(checkpoint.coversFrom);
  assert.ok(checkpoint.coversTo);
  assert.equal(checkpoint.source, 'daily_consolidation');
  assert.equal(checkpoint.sourceRef, '2026-05-08');
  assert.equal(app.listCheckpoints({ scope: 'repo', scopeKey: 'repo-level', level: 1 }).length, 1);
  assert.equal(app.listCheckpoints({ scope: 'repo', scopeKey: 'repo-level', level: 0 }).length, 1);
  assert.equal(store.getLatestCheckpoint({ scopeType: 'repo', scopeKey: 'repo-level', sessionId: 'level-session' }).level, 1);
  assert.equal(
    store.getLatestCheckpoint({ scopeType: 'repo', scopeKey: 'repo-level', sessionId: 'level-session', level: 0 })
      .level,
    0,
  );
});

test('appendRaw accepts only user and assistant conversation evidence roles', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  assert.throws(
    () =>
      app.appendRaw({
        scope: 'repo',
        scopeKey: 'repo-roles',
        sessionId: 'role-session',
        role: 'tool_result',
        content: 'tool output belongs in the native transcript.',
      }),
    /role must be one of: user, assistant/,
  );

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-roles',
    sessionId: 'role-session',
    role: 'assistant',
    content: 'The assistant summarized the verification result.',
  });

  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'repo-roles',
      sessionId: 'role-session',
    }).length,
    1,
  );
});

test('bootstrapContext includes working summary and recent raw tail separately from search results', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'working_summary_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      working_summary_provider: async () => ({
        summaryShort: 'Working summary checkpoint.',
        summaryText: 'Checkpoint delta: the agent implemented storage scaffolding.',
        workingSummary: 'Current state: storage is done, bootstrap wiring is next.',
        decisions: [],
        todos: ['Wire bootstrapContext to include working summary.'],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-working',
    key: 'durable-rule',
    content: 'Durable memory remains reviewed canonical state.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    role: 'user',
    content: 'Implement working summaries.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    role: 'assistant',
    content: 'Bootstrap wiring is now in progress.',
  });

  const defaultBootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
  });
  assert.deepEqual(defaultBootstrap.rawTail, []);
  assert.equal(defaultBootstrap.rawTailLimit, 0);

  const zeroBootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
    rawTailLimit: 0,
  });
  assert.deepEqual(zeroBootstrap.rawTail, []);
  assert.equal(zeroBootstrap.rawTailLimit, 0);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
    rawTailLimit: 1,
  });

  assert.equal(bootstrap.results.some((item) => item.type === 'memory' && item.key === 'durable-rule'), true);
  assert.equal(bootstrap.workingSummary.type, 'working_summary');
  assert.equal(bootstrap.workingSummary.trust, 'live_continuity');
  assert.match(bootstrap.workingSummary.content, /storage is done/);
  assert.equal(bootstrap.rawTail.length, 1);
  assert.match(bootstrap.rawTail[0].content, /Bootstrap wiring/);
});

test('bootstrapContext includes latest checkpoints independently from search results', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'handoff_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      handoff_provider: async (input) => ({
        summaryShort: 'Latest handoff.',
        summaryText: `Recent checkpoint: ${input.rawEvents.at(-1).content}`,
        decisions: ['Recent decision.'],
        todos: ['Recent todo.'],
        openQuestions: [],
        memoryCandidates: [],
        structured: {
          schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
          work: {
            intent: 'Preserve latest handoff independently from search ranking.',
            status: 'verified',
            outcome: 'Latest checkpoint should appear in handoff.latestHandoff.',
          },
          liveState: {
            repo: 'github.com/example/mcp-repo',
            branch: 'feature/handoff',
            headCommit: 'abc1234',
            ciStatus: 'pass',
            observedAt: '2026-06-03T00:00:00Z',
            verificationRequired: true,
            staleReasons: ['branch, commit, and CI are mutable live state'],
            verifyHints: ['git status --short --branch', 'gh pr view 123 --json statusCheckRollup'],
          },
          changes: [],
          verification: [],
          risks: [],
          nextActions: [],
        },
        sourceEventCount: input.rawEvents.length,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    key: 'durable-bootstrap-hit',
    content: 'Durable bootstrap memory should win ordinary search ranking.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'handoff-session',
    role: 'assistant',
    content: 'PR #123 merged after all CI passed.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'handoff-session',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    query: 'durable bootstrap memory',
  });

  assert.equal(bootstrap.results.some((item) => item.type === 'memory' && item.key === 'durable-bootstrap-hit'), true);
  assert.equal(bootstrap.handoff.latestCheckpointLimit, 1);
  assert.deepEqual(bootstrap.handoff.relatedScopeKeys, []);
  assert.equal(bootstrap.handoff.latestHandoff.id, bootstrap.handoff.latestCheckpoints[0].id);
  assert.equal(bootstrap.handoff.latestHandoff.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(bootstrap.handoff.latestHandoff.structured.liveState.branch, 'feature/handoff');
  assert.equal(bootstrap.handoff.latestHandoff.structuredWarnings[0].code, 'live_state_may_be_stale');
  assert.ok(bootstrap.handoff.latestHandoff.structuredWarnings[0].fields.includes('liveState.branch'));
  assert.deepEqual(bootstrap.handoff.latestHandoff.structuredWarnings[0].verifyHints, [
    'git status --short --branch',
    'gh pr view 123 --json statusCheckRollup',
  ]);
  assert.equal(bootstrap.handoff.latestCheckpoints.length, 1);
  assert.equal(bootstrap.handoff.latestCheckpoints[0].trust, 'credible_recent_handoff');
  assert.equal(bootstrap.handoff.latestCheckpoints[0].scope.scopeKey, 'repo-handoff');
  assert.match(bootstrap.handoff.latestCheckpoints[0].summaryText, /PR #123 merged/);
  assert.ok(bootstrap.handoff.latestCheckpoints[0].useFor.includes('recent_status'));

  const disabled = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    query: 'durable bootstrap memory',
    latestCheckpointLimit: 0,
  });
  assert.deepEqual(disabled.handoff.latestCheckpoints, []);
  assert.equal(disabled.handoff.latestHandoff, null);
});

test('processConsolidations creates scope-window checkpoints and bootstrap exposes them', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let providerInput = null;
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('consolidated') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'consolidation_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    store,
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      consolidation_provider: async (input) => {
        providerInput = input;
        return {
          summaryShort: 'Daily consolidated context.',
          summaryText: `Daily consolidated context from ${input.sourceCheckpoints.length} source checkpoints.`,
          decisions: ['Use period consolidation for bootstrap context.'],
          todos: ['Verify mutable live state before acting.'],
          openQuestions: [],
          memoryCandidates: [
            {
              key: 'period-consolidation-runbook',
              content: 'Period consolidation should preserve repeated durable runbook signals.',
              reason: 'Repeated across source checkpoints.',
              promotionRecommendation: 'review',
            },
          ],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: { synthetic: true, codexExec: { inputTruncated: true } },
        };
      },
    },
  });

  for (const [sessionId, summaryText] of [
    ['thread-a', 'First checkpoint mentions bootstrap being too thin.'],
    ['thread-a', 'Second checkpoint mentions preserving period context.'],
    ['thread-b', 'Third checkpoint from another session mentions memory candidates.'],
  ]) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-consolidation',
      sessionId,
      summaryShort: 'Source checkpoint.',
      summaryText,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {
        sourceProvenance: {
          sourceAgent: sessionId === 'thread-b' ? 'claude_code' : 'codex',
        },
      },
    });
  }
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    key: 'existing-memory',
    content: 'Existing durable memory for lifecycle summary.',
  });

  const due = app.listDueConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(due.count, 1);
  assert.equal(due.items[0].target, 'repo');
  assert.equal(due.items[0].sourceCheckpointCount, 3);
  assert.equal(due.memoryLifecycle.latestPromotedAt != null, true);

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(result.created, 1);
  assert.equal(result.checkpoint.source, 'daily_consolidation');
  assert.equal(result.checkpoint.metadata.consolidation.target, 'repo');
  assert.equal(result.checkpoint.metadata.consolidation.windowKind, 'daily');
  assert.equal(result.checkpoint.metadata.consolidation.inputTruncated, true);
  assert.equal(result.checkpoint.metadata.consolidation.sourceCheckpointIds.length, 3);
  assert.deepEqual(result.checkpoint.metadata.consolidation.sourceAgents.sort(), ['claude_code', 'codex']);
  assert.equal(result.memoryCandidateCount, 1);
  assert.equal(result.embedding.queued, 2);
  assert.equal(providerInput.consolidation.target, 'repo');
  assert.equal(providerInput.rawEvents.length, 0);
  assert.equal(providerInput.sourceCheckpoints.length, 3);
  assert.throws(
    () =>
      store.insertCheckpoint({
        scopeType: 'repo',
        scopeKey: 'repo-consolidation',
        sessionId: 'duplicate-consolidation',
        summaryShort: 'Duplicate consolidation.',
        summaryText: 'This should be blocked by the consolidation uniqueness index.',
        decisions: [],
        todos: [],
        openQuestions: [],
        sourceEventCount: 1,
        provider: 'test',
        source: 'daily_consolidation',
        sourceRef: result.checkpoint.sourceRef,
        metadata: {
          consolidation: {
            target: 'repo',
          },
        },
      }),
    /UNIQUE constraint failed|constraint/i,
  );
  assert.throws(
    () =>
      app.listDueConsolidations({
        scope: 'repo',
        scopeKey: 'repo-consolidation',
        target: 'repo',
        windowKind: 'rolling',
      }),
    /windowKind must be one of: daily, custom/,
  );

  const duplicate = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(duplicate.created, 0);
  assert.equal(duplicate.skipped, 1);
  assert.equal(duplicate.items[0].reason, 'already_exists');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    query: 'period consolidation bootstrap',
  });
  assert.equal(bootstrap.handoff.latestConsolidation.repo.id, result.checkpoint.id);
  assert.equal(bootstrap.handoff.latestConsolidation.repo.consolidation.target, 'repo');
  assert.equal(bootstrap.memoryLifecycle.pendingReviewCount, 1);
  assert.equal(bootstrap.memoryLifecycle.candidatesLast7d >= 1, true);
  assert.equal(bootstrap.rawTail, undefined);
});

test('processConsolidations collapses race duplicate insertions into already_exists', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'race_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      race_provider: async (input) => {
        store.insertCheckpoint({
          scopeType: input.session.scopeType,
          scopeKey: input.session.scopeKey,
          sessionId: 'competing-worker',
          summaryShort: 'Competing consolidation.',
          summaryText: 'A competing worker inserted this consolidation first.',
          decisions: [],
          todos: [],
          openQuestions: [],
          sourceEventCount: input.sourceCheckpoints.length,
          provider: 'race_provider',
          level: 1,
          coversFrom: input.consolidation.coversFrom,
          coversTo: input.consolidation.coversTo,
          source: 'daily_consolidation',
          sourceRef: input.consolidation.sourceRef,
          metadata: {
            consolidation: {
              target: input.consolidation.target,
            },
          },
        });
        return {
          summaryShort: 'Losing consolidation.',
          summaryText: 'This output should be collapsed to the existing checkpoint.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: {},
        };
      },
    },
  });

  for (const summaryText of ['First source checkpoint.', 'Second source checkpoint.']) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-consolidation-race',
      sessionId: 'thread-race',
      summaryShort: 'Source checkpoint.',
      summaryText,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {},
    });
  }

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation-race',
    target: 'repo',
    day: new Date().toISOString(),
  });

  assert.equal(result.processed, 1);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0].reason, 'already_exists');
  assert.equal(result.checkpoint.summaryShort, 'Competing consolidation.');
});

test('processConsolidations supports thread windows without mixing sessions', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let sourceSessionIds = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'thread_consolidation_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      thread_consolidation_provider: async (input) => {
        sourceSessionIds = input.sourceCheckpoints.map((checkpoint) => checkpoint.sessionId);
        return {
          summaryShort: 'Thread consolidated context.',
          summaryText: 'Thread consolidated context from one session.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: {},
        };
      },
    },
  });

  for (const sessionId of ['target-thread', 'target-thread', 'other-thread']) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-thread-consolidation',
      sessionId,
      summaryShort: 'Thread source checkpoint.',
      summaryText: `Checkpoint for ${sessionId}.`,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {},
    });
  }

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-thread-consolidation',
    target: 'thread',
    sessionId: 'target-thread',
    day: new Date().toISOString(),
  });

  assert.equal(result.created, 1);
  assert.deepEqual(sourceSessionIds, ['target-thread', 'target-thread']);
  assert.deepEqual(result.checkpoint.metadata.consolidation.sourceSessionIds, ['target-thread']);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-thread-consolidation',
    sessionId: 'target-thread',
    query: 'thread consolidated context',
  });
  assert.equal(bootstrap.handoff.latestConsolidation.thread.id, result.checkpoint.id);
});

test('bootstrapContext can include latest checkpoints from related repo scopes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'related_handoff_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      related_handoff_provider: async (input) => ({
        summaryShort: 'Latest related handoff.',
        summaryText: `Recent related checkpoint: ${input.rawEvents.at(-1).content}`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: input.rawEvents.length,
        metadata: {},
      }),
    },
  });

  for (const scopeKey of ['repo-child', 'repo-suite']) {
    app.appendRaw({
      scope: 'repo',
      scopeKey,
      sessionId: `${scopeKey}-session`,
      role: 'assistant',
      content: `Checkpoint evidence for ${scopeKey}.`,
    });
    await app.distillCheckpoint({
      scope: 'repo',
      scopeKey,
      sessionId: `${scopeKey}-session`,
    });
  }

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-child',
    relatedScopeKeys: ['repo-suite', 'repo-suite', 'repo-child'],
    query: 'unrelated query still needs latest handoff',
  });

  assert.deepEqual(
    bootstrap.handoff.latestCheckpoints.map((checkpoint) => checkpoint.scope.scopeKey).sort(),
    ['repo-child', 'repo-suite'],
  );
  assert.deepEqual(bootstrap.handoff.relatedScopeKeys, ['repo-suite']);

  await assert.rejects(
    () =>
      app.bootstrapContext({
        scope: 'repo',
        scopeKey: 'repo-child',
        query: 'invalid handoff limit',
        latestCheckpointLimit: 4,
      }),
    /latestCheckpointLimit must be an integer between 0 and 3/,
  );
});

test('distillCheckpoint passes previous working summary to provider for rolling updates', async () => {
  const dataDir = await makeTempDir();
  const seenPreviousWorkingSummaries = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'rolling_summary_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      rolling_summary_provider: async (input) => {
        seenPreviousWorkingSummaries.push(input.previousWorkingSummary);
        return {
          summaryShort: 'Rolling summary checkpoint.',
          summaryText: 'Checkpoint delta for rolling summary.',
          workingSummary: input.previousWorkingSummary
            ? `${input.previousWorkingSummary.summaryText}\nUpdated with second pass.`
            : 'Initial rolling state.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.rawEvents.length,
          metadata: {},
        };
      },
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
    role: 'user',
    content: 'Initial raw event.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
    role: 'assistant',
    content: 'Second raw event.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
  });

  assert.equal(seenPreviousWorkingSummaries[0], null);
  assert.match(seenPreviousWorkingSummaries[1].summaryText, /Initial rolling state/);
  const workingSummary = app.getWorkingSummary({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
  });
  assert.match(workingSummary.summaryText, /Updated with second pass/);
});

test('distillCheckpoint recovers when working summary update fails after checkpoint insert', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'summary_fail_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      summary_fail_provider: async () => ({
        summaryShort: 'Checkpoint survives.',
        summaryText: 'The checkpoint should persist even if working summary update fails.',
        workingSummary: 'This working summary update will fail.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: {},
      }),
    },
  });
  store.upsertWorkingSummary = () => {
    throw new Error('synthetic working summary failure');
  };

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-summary-fail',
    sessionId: 'summary-fail-session',
    role: 'assistant',
    content: 'Checkpoint should still be inserted.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-summary-fail',
    sessionId: 'summary-fail-session',
  });

  assert.equal(checkpoint.summaryShort, 'Checkpoint survives.');
  assert.equal(checkpoint.workingSummary.updated, false);
  assert.match(checkpoint.workingSummary.error.message, /synthetic working summary failure/);
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-summary-fail',
    sessionId: 'summary-fail-session',
  });
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].outputMetadata.checkpointId, checkpoint.id);
  assert.match(runs[0].outputMetadata.workingSummaryError.message, /synthetic working summary failure/);
  app.close();
});

test('distillCheckpoint records working summary if checkpoint insert fails', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'checkpoint_fail_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      checkpoint_fail_provider: async () => ({
        summaryShort: 'Summary survives.',
        summaryText: 'Checkpoint insert will fail.',
        workingSummary: 'Current state can still be saved for handoff.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: {},
      }),
    },
  });
  store.insertCheckpoint = () => {
    throw new Error('synthetic checkpoint insert failure');
  };

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
    role: 'assistant',
    content: 'Working summary should still be attempted.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-checkpoint-fail',
        sessionId: 'checkpoint-fail-session',
      }),
    /synthetic checkpoint insert failure/,
  );

  const workingSummary = app.getWorkingSummary({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
  });
  assert.match(workingSummary.summaryText, /still be saved/);
  assert.equal(workingSummary.sourceCheckpointId, null);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].outputMetadata.checkpointFailed, true);
  assert.equal(runs[0].outputMetadata.workingSummaryUpdated, true);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
    query: 'checkpoint failed handoff',
  });
  assert.equal(bootstrap.workingSummary.degraded, true);
  assert.equal(bootstrap.workingSummary.checkpointInsertFailed, true);
  app.close();
});

test('raw event TTL pruning is controlled by environment config', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
    role: 'user',
    content: 'old raw evidence',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
    role: 'assistant',
    content: 'fresh raw evidence',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'old raw evidence',
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents();
  assert.equal(result.ttlDays, 7);
  assert.equal(result.deletedRawEvents, 1);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
  });
  assert.deepEqual(
    events.map((event) => event.content),
    ['fresh raw evidence'],
  );
});

test('char-threshold distillation waits for the char minimum interval after a checkpoint', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS: '600000',
      CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS: '600000',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
    role: 'user',
    content: 'first checkpoint seed',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
    role: 'assistant',
    content: 'x'.repeat(500),
  });

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
    charThreshold: 10,
  });
  assert.equal(status.charsSinceLastCheckpoint >= 10, true);
  assert.equal(status.shouldDistill, false);
  assert.equal(status.reasons.includes('char_threshold_since_checkpoint'), false);
  assert.equal(status.thresholds.charMinIntervalMs, 600000);
});

test('sessionStatus continues after the last raw event covered by a checkpoint', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
    role: 'user',
    content: 'covered raw event',
  });
  const firstRaw = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
  })[0];
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
    role: 'assistant',
    content: 'raw appended while distillation was finishing',
  });

  const betweenFirstRawAndCheckpoint = new Date(Date.parse(firstRaw.createdAt) + 1).toISOString();
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      betweenFirstRawAndCheckpoint,
      'raw appended while distillation was finishing',
    );
  } finally {
    db.close();
  }

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
    charThreshold: 1,
    charMinIntervalMs: 1,
  });
  assert.equal(checkpoint.metadata.sourceRawEventIds.length, 1);
  assert.equal(status.latestCheckpointId, checkpoint.id);
  assert.equal(status.eventsSinceLastCheckpoint, 1);
  assert.equal(status.distillWindow.selectedEventCount, 1);
  assert.equal(status.distillWindow.firstRawEventId !== checkpoint.metadata.sourceRawEventIds[0], true);
});

test('listDueDistillSessions finds raw evidence after checkpoint coverage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    sessionId: 'catch-up-session',
  };

  app.appendRaw({
    ...scope,
    role: 'user',
    content: 'covered raw event',
  });
  const coveredRaw = app.listRawEvents(scope)[0];
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      coveredRaw.id,
    );
  } finally {
    db.close();
  }

  const checkpoint = await app.distillCheckpoint(scope);
  app.appendRaw({
    ...scope,
    role: 'assistant',
    content: 'tail raw appended after the checkpoint run',
  });
  const tailRaw = app.listRawEvents(scope).find((event) => event.content.includes('tail raw appended'));
  const dbAfterTail = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    dbAfterTail.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:01:00.000Z',
      tailRaw.id,
    );
    dbAfterTail.prepare('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:02:00.000Z',
      checkpoint.id,
    );
  } finally {
    dbAfterTail.close();
  }

  const due = app.listDueDistillSessions({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 5,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
  });

  assert.equal(due.dueCount, 1);
  assert.equal(due.skippedCount, 0);
  assert.deepEqual(due.skipReasonCounts, {});
  assert.equal(due.sessions[0].sessionId, 'catch-up-session');
  assert.equal(due.sessions[0].eventsSinceLastCheckpoint, 1);
  assert.equal(due.sessions[0].charsSinceLastCheckpoint, tailRaw.content.length);
  assert.equal(due.sessions[0].latestCheckpointAt, '2026-01-01T00:02:00.000Z');

  const dryRun = await app.processDueDistills({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 1,
    dryRun: true,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.processed, 0);
  assert.equal(dryRun.dueCount, 1);

  const processed = await app.processDueDistills({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 1,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
  });
  assert.equal(processed.processed, 1);
  assert.equal(processed.failed, 0);
  assert.equal(processed.results[0].status, 'succeeded');
  assert.equal(processed.results[0].sourceEventCount, 1);

  const after = app.listDueDistillSessions({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 5,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
    idleMs: 0,
  });
  assert.equal(after.dueCount, 0);
});

test('listDueDistillSessions skips sessions inside the idle window', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-idle-catch-up',
    sessionId: 'idle-session',
    role: 'user',
    content: 'fresh raw event that should wait for the idle window',
  });

  const due = app.listDueDistillSessions({
    scope: 'repo',
    scopeKey: 'repo-idle-catch-up',
    limit: 5,
    minEvents: 1,
    charThreshold: 1,
    idleMs: 600000,
  });
  assert.equal(due.dueCount, 0);
  assert.equal(due.skippedCount, 1);
  assert.deepEqual(due.skipReasonCounts, { idle_window: 1 });
});

test('CLI due distill commands preserve core default limits', async () => {
  const dataDir = await makeTempDir();
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const listed = await execFileAsync('node', ['src/cli.js', 'listDueDistillSessions'], { env });
  assert.equal(JSON.parse(listed.stdout).limit, 20);

  const dryRun = await execFileAsync('node', ['src/cli.js', 'processDueDistills', '--dryRun', 'true'], { env });
  assert.equal(JSON.parse(dryRun.stdout).limit, 5);

  const explicit = await execFileAsync('node', ['src/cli.js', 'processDueDistills', '--dryRun', 'true', '--limit', '2'], {
    env,
  });
  assert.equal(JSON.parse(explicit.stdout).limit, 2);
});

test('distillCheckpoint drains bounded conversation windows oldest first', async () => {
  const dataDir = await makeTempDir();
  const seen = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'window_provider',
      CONTEXTFORGE_DISTILL_MAX_EVENTS: '3',
      CONTEXTFORGE_DISTILL_MAX_CHARS: '60',
    },
    cwd: process.cwd(),
    distillProviders: {
      window_provider: async (input) => {
        seen.push(input.rawEvents.map((event) => event.content));
        return {
          summaryShort: 'Window checkpoint.',
          summaryText: 'The provider saw a bounded oldest-first conversation window.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.rawEvents.length,
          metadata: {
            providerNotes: 'synthetic provider output',
            retrievalHooks: ['codex_exec', 'provider contract', 'synthetic raw events'],
          },
        };
      },
    },
  });

  for (let index = 0; index < 6; index += 1) {
    app.appendRaw({
      scope: 'repo',
      scopeKey: 'repo-window',
      sessionId: 'window-session',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `event-${index}`,
    });
  }
  const rawBeforeLegacyTool = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    const toolCreatedAt = new Date(Date.parse(rawBeforeLegacyTool[1].createdAt) + 1).toISOString();
    db.prepare(
      `INSERT INTO raw_events (
        id, scope_type, scope_key, session_id, conversation_id,
        role, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-tool-result',
      'repo',
      'repo-window',
      'window-session',
      null,
      'tool_result',
      'legacy tool output should not enter distillation',
      '{}',
      toolCreatedAt,
    );
  } finally {
    db.close();
  }

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(status.rawEventCount, 7);
  assert.equal(status.distillWindow.candidateEventCount, 6);
  assert.equal(status.distillWindow.selectedEventCount, 3);
  assert.equal(status.distillWindow.truncated, true);

  const firstCheckpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.deepEqual(seen[0], ['event-0', 'event-1', 'event-2']);
  assert.equal(firstCheckpoint.sourceEventCount, 3);
  assert.equal(firstCheckpoint.metadata.sourceRawEventIds.length, 3);
  assert.equal(firstCheckpoint.metadata.sourceEventWindow.selectedEventCount, 3);
  assert.equal(firstCheckpoint.metadata.sourceEventWindow.truncated, true);

  const statusAfterFirst = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(statusAfterFirst.eventsSinceLastCheckpoint, 3);
  assert.equal(statusAfterFirst.distillWindow.selectedEventCount, 3);
  assert.deepEqual(
    app
      .listRawEvents({
        scope: 'repo',
        scopeKey: 'repo-window',
        sessionId: 'window-session',
      })
      .filter(
        (event) =>
          statusAfterFirst.distillWindow.firstRawEventId === event.id ||
          statusAfterFirst.distillWindow.lastRawEventId === event.id,
      )
      .map((event) => event.content),
    ['event-3', 'event-5'],
  );

  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.deepEqual(seen[1], ['event-3', 'event-4', 'event-5']);

  const statusAfterSecond = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(statusAfterSecond.eventsSinceLastCheckpoint, 0);
  assert.equal(statusAfterSecond.distillWindow.selectedEventCount, 0);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(runs[0].inputMetadata.rawEventIds.length, 3);
  assert.equal(runs[0].inputMetadata.sourceEventWindow.totalRawEventCount, 7);
  assert.equal(runs[0].inputMetadata.sourceEventWindow.candidateEventCount, 6);
});

test('distillUsage summarizes estimated and actual provider usage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'usage_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      usage_provider: async () => ({
        summaryShort: 'Usage checkpoint.',
        summaryText: 'The provider returned usage metadata.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        provider: 'usage_provider',
        metadata: {
          usage: {
            inputTokens: 42,
            outputTokens: 8,
            totalTokens: 50,
            prompt_cache_hit_tokens: 10,
            prompt_cache_miss_tokens: 32,
          },
        },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
    role: 'user',
    content: '1234567890',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
  });

  const usage = app.distillUsage({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
    charsPerToken: 5,
  });
  assert.equal(usage.totals.runs, 1);
  assert.equal(usage.totals.succeeded, 1);
  assert.equal(usage.totals.completedRuns, 1);
  assert.equal(usage.totals.selectedCharCount, 10);
  assert.equal(usage.totals.estimatedInputTokens, 2);
  assert.deepEqual(usage.totals.actualUsage, {
    runs: 1,
    inputTokens: 42,
    outputTokens: 8,
    totalTokens: 50,
    promptCacheRuns: 1,
    promptCacheHitTokens: 10,
    promptCacheMissTokens: 32,
    promptCacheHitRatio: 10 / 42,
  });
  assert.equal(usage.totals.persistedUsage.events, 1);
  assert.equal(usage.totals.persistedUsage.inputTokens, 42);
  assert.equal(usage.totals.persistedUsage.cachedInputTokens, 10);
  assert.equal(usage.totals.persistedUsage.uncachedInputTokens, 32);
  assert.equal(usage.totals.persistedUsage.outputTokens, 8);
  assert.equal(usage.totals.persistedUsage.totalTokens, 50);
  assert.equal(usage.totals.persistedUsage.byOperation.checkpoint_distill.events, 1);
  assert.equal(usage.totals.persistedUsage.byProviderModel.usage_provider.events, 1);
  assert.equal(usage.totals.persistedUsage.byProviderModelOperation['usage_provider:checkpoint_distill'].events, 1);
  assert.equal(usage.totals.canonicalUsage.source, 'persisted_usage_events');
  assert.equal(usage.totals.canonicalUsage.totalTokens, 50);
  assert.equal(usage.runs[0].usage.totalTokens, 50);
  assert.equal(usage.runs[0].usage.promptCacheHitTokens, 10);

  const store = new ContextForgeStore({ dataDir });
  const events = store.listLlmUsageEvents({
    scopeType: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'checkpoint_distill');
  assert.equal(events[0].inputTokens, 42);
  assert.equal(events[0].cachedInputTokens, 10);
  assert.equal(events[0].uncachedInputTokens, 32);
  assert.equal(events[0].usage.prompt_cache_hit_tokens, 10);
  store.close();

  const rollup = app.llmUsageRollup({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
  });
  assert.equal(rollup.totals.events, 1);
  assert.equal(rollup.totals.byOperation.checkpoint_distill.totalTokens, 50);
  assert.equal(rollup.totals.byProviderModel.usage_provider.inputTokens, 42);
  assert.equal(rollup.totals.byProviderModelOperation['usage_provider:checkpoint_distill'].outputTokens, 8);
});

test('distillUsage averages elapsed time across completed runs only', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd(), store });
  const scope = { scopeType: 'repo', scopeKey: 'repo-usage-average' };

  store.startDistillRun({
    ...scope,
    sessionId: 'usage-average-session',
    provider: 'mock',
    sourceEventCount: 1,
    inputMetadata: {
      sourceEventWindow: {
        selectedEventCount: 1,
        selectedCharCount: 20,
      },
    },
  });
  const completed = store.startDistillRun({
    ...scope,
    sessionId: 'usage-average-session',
    provider: 'mock',
    sourceEventCount: 1,
    inputMetadata: {
      sourceEventWindow: {
        selectedEventCount: 1,
        selectedCharCount: 40,
      },
    },
  });
  store.completeDistillRun({ id: completed.id });

  const usage = app.distillUsage({
    scope: 'repo',
    scopeKey: 'repo-usage-average',
    sessionId: 'usage-average-session',
  });

  assert.equal(usage.totals.runs, 2);
  assert.equal(usage.totals.started, 1);
  assert.equal(usage.totals.completedRuns, 1);
  assert.equal(usage.totals.estimatedInputTokens, 15);
  assert.equal(usage.totals.averageElapsedMs, usage.totals.elapsedMs);
  app.close();
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
  const legacy = validateDistillOutput({
    summaryShort: 'Legacy checkpoint.',
    summaryText: 'Legacy output has no structured payload.',
    decisions: [],
    todos: [],
    openQuestions: [],
    memoryCandidates: [],
  });
  assert.equal(legacy.structured, null);
  const structured = validateDistillOutput({
    summaryShort: 'Structured checkpoint.',
    summaryText: 'Structured output has handoff state.',
    decisions: [],
    todos: [],
    openQuestions: [],
    memoryCandidates: [],
    structured: {
      schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
      work: {
        status: 'verified',
      },
    },
  });
  assert.equal(structured.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.throws(
    () =>
      validateDistillOutput({
        summaryShort: 'Invalid structured checkpoint.',
        summaryText: 'Structured output has the wrong schema version.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        structured: {
          schemaVersion: 'contextforge.structured_checkpoint.v999',
        },
      }),
    /structured\.schemaVersion/,
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
  let schema;
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
      const schemaPath = args.args[args.args.indexOf('--output-schema') + 1];
      schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
      return {
        stdout: JSON.stringify({
          summaryShort: 'Codex checkpoint for synthetic events.',
          summaryText: 'The user decided to test the codex_exec provider path.',
          workingSummary: 'Current state: codex_exec provider path is under synthetic test.',
          decisions: ['Use codex_exec behind the provider contract.'],
          todos: ['Document setup expectations.'],
          openQuestions: [],
          memoryCandidates: [
            {
              schemaVersion: 'contextforge.memory_candidate.v2',
              key: 'provider',
              content: 'codex_exec is available.',
              reason: 'Synthetic provider output.',
              category: 'note',
              tags: [],
              importance: 1,
              candidateType: null,
              confidence: 0.9,
              stability: 0.9,
              sensitivity: null,
              promotionRecommendation: 'promote',
              sourceEventIds: [],
              durabilityReason: 'Provider contract details can guide future distill debugging.',
              riskReason: 'This is synthetic test evidence, not an operational incident.',
              evidenceRefs: ['test:codex_exec provider distills synthetic raw events through a runner'],
              suggestedAction: 'promote',
            },
          ],
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            work: {
              intent: 'Test the codex_exec provider path.',
              status: 'verified',
              outcome: 'Synthetic distill completed.',
            },
            liveState: {
              repo: 'github.com/ginishuh/contextforge',
              branch: 'feature/structured-checkpoints',
              headCommit: 'synthetic',
              observedAt: '2026-06-03T00:00:00Z',
              verificationRequired: true,
              staleReasons: ['branch and headCommit are mutable live state'],
              verifyHints: ['git status --short --branch', 'git rev-parse HEAD'],
            },
            changes: [
              {
                type: 'provider',
                name: 'codex_exec',
                description: 'Synthetic provider schema accepted structured output.',
              },
            ],
            verification: [
              {
                type: 'smoke',
                result: 'pass',
                details: 'Synthetic runner returned valid checkpoint JSON.',
              },
            ],
            risks: [],
            nextActions: [],
          },
          sourceEventCount: 1,
          metadata: {
            providerNotes: 'synthetic provider output',
            retrievalHooks: ['codex_exec', 'provider contract', 'synthetic raw events'],
          },
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
  assert.equal(checkpoint.metadata.providerMetadata.providerNotes, 'synthetic provider output');
  assert.deepEqual(checkpoint.metadata.providerMetadata.retrievalHooks, [
    'codex_exec',
    'provider contract',
    'synthetic raw events',
  ]);
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.command, 'codex-fake');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.model, 'gpt-test');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.reasoningEffort, 'low');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.timeoutMs, 1234);
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.promptVersion, 'codex_exec.prompt.v9');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.outputSchemaVersion, 'contextforge.checkpoint.v6');
  assert.equal(checkpoint.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(checkpoint.metadata.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(checkpoint.metadata.providerMetadata.structured, undefined);
  assert.match(invocation.prompt, /Return exactly one JSON object/);
  const promptPayload = JSON.parse(invocation.prompt.slice(invocation.prompt.indexOf('{')));
  assert.equal(promptPayload.requestedOutputSchema.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.match(invocation.prompt, /structured\.liveState/);
  assert.match(invocation.prompt, /human-readable memoryCandidate review fields in Korean/);
  assert.match(invocation.prompt, /content, reason, durabilityReason, and riskReason/);
  assert.match(invocation.prompt, /one-time PR status updates/);
  assert.match(invocation.prompt, /review comments posted/);
  assert.deepEqual(invocation.args.slice(0, 2), ['exec', '--skip-git-repo-check']);
  assert.ok(invocation.args.includes('--output-schema'));
  assert.ok(invocation.args.includes('--output-last-message'));
  assert.ok(invocation.args.includes('-c'));
  assert.ok(invocation.args.includes('model_reasoning_effort="low"'));
  assert.equal(invocation.timeoutMs, 1234);
  assert.equal(schema.required.includes('structured'), true);
  assert.ok(schema.properties.structured);
  assert.deepEqual(schema.properties.structured.type, ['object', 'null']);
  assert.equal(schema.properties.structured.additionalProperties, false);
  assert.deepEqual(schema.properties.structured.required, [
    'schemaVersion',
    'work',
    'liveState',
    'changes',
    'verification',
    'risks',
    'nextActions',
  ]);
  assert.deepEqual(schema.properties.structured.properties.schemaVersion.enum, [STRUCTURED_CHECKPOINT_SCHEMA_VERSION]);
  assert.equal(schema.properties.structured.properties.liveState.additionalProperties, false);
  assert.ok(schema.properties.structured.properties.liveState.required.includes('verifyHints'));
  const candidateSchema = schema.properties.memoryCandidates.items;
  assert.equal(candidateSchema.required.includes('schemaVersion'), true);
  assert.ok(candidateSchema.properties.durabilityReason);
  assert.ok(candidateSchema.properties.riskReason);
  assert.deepEqual(candidateSchema.properties.evidenceRefs.type, ['array', 'null']);
  assert.ok(candidateSchema.properties.suggestedAction);
  assert.ok(schema.properties.sessionWorkingContext);
  assert.deepEqual(
    schema.properties.sessionWorkingContext.required,
    Object.keys(schema.properties.sessionWorkingContext.properties),
  );
  assert.deepEqual(schema.properties.metadata.required, ['providerNotes', 'retrievalHooks']);
  const indexedCandidate = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-codex',
    checkpointId: checkpoint.id,
  })[0];
  assert.equal(indexedCandidate.candidate.schemaVersion, 'contextforge.memory_candidate.v2');
  assert.equal(indexedCandidate.candidate.durabilityReason, 'Provider contract details can guide future distill debugging.');
  assert.equal(indexedCandidate.candidate.riskReason, 'This is synthetic test evidence, not an operational incident.');
  assert.deepEqual(indexedCandidate.candidate.evidenceRefs, [
    'test:codex_exec provider distills synthetic raw events through a runner',
  ]);
  assert.equal(indexedCandidate.candidate.suggestedAction, 'promote');
  const suggestions = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'repo-codex',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(suggestions.proposals[0].whyDurable, 'Provider contract details can guide future distill debugging.');
  assert.equal(suggestions.proposals[0].riskReason, 'This is synthetic test evidence, not an operational incident.');
  assert.equal(suggestions.proposals[0].recommendedAction, 'ask_user');
  assert.equal(suggestions.proposals[0].providerSuggestedAction, 'promote');
  assert.deepEqual(suggestions.proposals[0].evidence.evidenceRefs, [
    'test:codex_exec provider distills synthetic raw events through a runner',
  ]);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
  });
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].inputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v9');
  assert.equal(runs[0].inputMetadata.providerMetadata.outputSchemaVersion, 'contextforge.checkpoint.v6');
  assert.equal(runs[0].outputMetadata.providerMetadata.codexExec.promptVersion, 'codex_exec.prompt.v9');
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
        workingSummary: 'Current state: brace fallback recovery succeeded.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        provider: 'codex_exec',
        metadata: { providerNotes: 'synthetic recovery', retrievalHooks: ['brace fallback', 'codex_exec JSON'] },
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

test('runtime settings are DB-backed, redacted, and hot-apply to session status', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
      CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS: '600000',
    },
    cwd: process.cwd(),
  });

  const updated = app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_object',
      },
      distillPolicy: {
        minEvents: 1,
        minIntervalMs: 1,
        charMinIntervalMs: 1,
        charThreshold: 1,
        maxEvents: 10,
        maxChars: 2000,
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });

  assert.equal(updated.effective.distillProvider, 'openai_compatible');
  assert.equal(updated.effective.openAiCompatible.model, 'deepseek-v4-flash');
  assert.equal(updated.effective.openAiCompatible.secretPresent, true);
  assert.equal(updated.effective.openAiCompatible.apiKey, undefined);
  assert.equal(updated.stored['openAiCompatible.apiKey'].value, null);
  assert.equal(updated.stored['openAiCompatible.apiKey'].secretPresent, true);
  assert.throws(
    () =>
      app.updateRuntimeSettings({
        values: {
          openAiCompatible: {
            apiKey: 'not-through-values',
          },
        },
      }),
    /write-only secrets channel/,
  );
  const cleared = app.updateRuntimeSettings({
    clearSecrets: ['openAiCompatibleApiKey'],
  });
  assert.equal(cleared.effective.openAiCompatible.secretPresent, false);
  assert.equal(cleared.effective.openAiCompatible.apiKey, undefined);
  assert.equal(cleared.stored['openAiCompatible.apiKey'], undefined);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'settings-repo',
    sessionId: 'settings-session',
    role: 'user',
    content: 'Enough content to cross the UI-managed char threshold.',
  });
  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'settings-repo',
    sessionId: 'settings-session',
  });
  assert.equal(status.thresholds.minIntervalMs, 1);
  assert.equal(status.thresholds.charThreshold, 1);
  assert.equal(status.shouldDistill, true);
});

test('codex_exec prompt preserves previous structured checkpoint handoff', async () => {
  const dataDir = await makeTempDir();
  const invocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-fake',
    },
    cwd: process.cwd(),
    codexExecRunner: async (args) => {
      invocations.push(args);
      const pass = invocations.length;
      return {
        stdout: JSON.stringify({
          summaryShort: `Structured checkpoint pass ${pass}.`,
          summaryText: `Structured checkpoint detail pass ${pass}.`,
          workingSummary: `Working summary pass ${pass}.`,
          sessionWorkingContext: {
            mode: 'task_execution',
            currentTask: 'Preserve previous structured checkpoint.',
            currentUserIntent: 'Verify structured handoff continuity.',
            targetSubject: null,
            sourceSubject: null,
            lastUserCorrection: null,
            openQuestion: null,
            nonGoals: [],
            avoidMisreadings: [],
            confidence: 0.9,
          },
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            work: {
              intent: `Structured handoff pass ${pass}.`,
              status: pass === 1 ? 'in_progress' : 'verified',
              outcome: `Pass ${pass} stored structured handoff.`,
            },
            liveState: {
              branch: `feature/pass-${pass}`,
              observedAt: '2026-06-03T00:00:00Z',
              verificationRequired: true,
              staleReasons: ['branch is mutable'],
              verifyHints: ['git status --short --branch'],
            },
            changes: [],
            verification: [],
            risks: [],
            nextActions: [],
          },
          sourceEventCount: 1,
          provider: 'codex_exec',
          metadata: {
            providerNotes: 'synthetic structured continuity',
            retrievalHooks: ['structured checkpoint continuity'],
          },
        }),
      };
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
    role: 'assistant',
    content: 'First structured checkpoint event.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
    role: 'assistant',
    content: 'Second structured checkpoint event.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
  });

  const secondPromptPayload = JSON.parse(invocations[1].prompt.slice(invocations[1].prompt.indexOf('{')));
  assert.equal(secondPromptPayload.previousCheckpoint.id, first.id);
  assert.equal(secondPromptPayload.previousCheckpoint.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(secondPromptPayload.previousCheckpoint.structured.work.status, 'in_progress');
});

test('openai_compatible provider distills through a fake DeepSeek-style chat completions endpoint', async () => {
  const dataDir = await makeTempDir();
  let requestBody;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, request) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer deepseek-secret');
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summaryShort: 'OpenAI-compatible checkpoint.',
                    summaryText: 'The DeepSeek-style provider returned valid JSON.',
                    workingSummary: 'Current state: openai_compatible provider is under test.',
                    sessionWorkingContext: {
                      mode: 'task_execution',
                      currentTask: 'Test provider',
                      currentUserIntent: 'Verify DeepSeek-style distill',
                      targetSubject: null,
                      sourceSubject: null,
                      lastUserCorrection: null,
                      openQuestion: null,
                      nonGoals: [],
                      avoidMisreadings: [],
                      confidence: 0.9,
                    },
                    decisions: ['Use OpenAI-compatible Chat Completions for DeepSeek.'],
                    todos: [],
                    openQuestions: [],
                    memoryCandidates: [],
                    sourceEventCount: 1,
                    provider: 'openai_compatible',
                    metadata: {
                      providerNotes: 'synthetic openai-compatible output',
                      retrievalHooks: ['deepseek-v4-flash', 'openai_compatible'],
                    },
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20,
            },
          }),
      };
    },
  });

  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'manual-model',
        responseFormat: 'json_object',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'openai-compatible-repo',
    sessionId: 'openai-compatible-session',
    role: 'user',
    content: 'Decision: test DeepSeek-compatible distillation.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'openai-compatible-repo',
    sessionId: 'openai-compatible-session',
  });

  assert.equal(requestBody.model, 'manual-model');
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.equal(requestBody.thinking, undefined);
  assert.equal(checkpoint.provider, 'openai_compatible');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.baseUrlHost, 'api.deepseek.com');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.model, 'manual-model');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.usage.total_tokens, 20);
});

test('openai_compatible provider repairs invalid JSON output and records retry metadata', async () => {
  const dataDir = await makeTempDir();
  const requests = [];
  const validOutput = {
    summaryShort: 'Repaired OpenAI-compatible checkpoint.',
    summaryText: 'The repair retry returned the complete checkpoint schema.',
    workingSummary: 'Current state: repair retry is under test.',
    sessionWorkingContext: {
      mode: 'task_execution',
      currentTask: 'Test repair retry',
      currentUserIntent: 'Verify OpenAI-compatible repair validation',
      targetSubject: null,
      sourceSubject: null,
      lastUserCorrection: null,
      openQuestion: null,
      nonGoals: [],
      avoidMisreadings: [],
      confidence: 0.88,
    },
    decisions: ['Re-validate repaired provider output before accepting it.'],
    todos: [],
    openQuestions: [],
    memoryCandidates: [],
    sourceEventCount: 1,
    provider: 'openai_compatible',
    metadata: {
      retrievalHooks: ['repair-retry'],
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
    fetchImpl: async (url, request) => {
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    requests.length === 1
                      ? '{"summaryShort":"missing required fields"}'
                      : JSON.stringify(validOutput),
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 10,
              total_tokens: 30,
            },
          }),
      };
    },
  });
  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_object',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repair-openai-compatible-repo',
    sessionId: 'repair-openai-compatible-session',
    role: 'user',
    content: 'Provider should repair an incomplete checkpoint.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repair-openai-compatible-repo',
    sessionId: 'repair-openai-compatible-session',
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].thinking.type, 'disabled');
  assert.match(requests[1].messages.at(-1).content, /failed validation/);
  assert.equal(checkpoint.summaryShort, 'Repaired OpenAI-compatible checkpoint.');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.retryCount, 1);
  assert.match(checkpoint.metadata.providerMetadata.openAiCompatible.validationFailure, /Provider output field/);
});

test('openai_compatible provider preserves raw evidence when provider output is malformed', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"summaryShort":"missing required fields"}' } }],
        }),
    }),
  });
  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_object',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'bad-openai-compatible-repo',
    sessionId: 'bad-openai-compatible-session',
    role: 'user',
    content: 'Raw evidence should survive malformed provider output.',
  });

  await assert.rejects(
    app.distillCheckpoint({
      scope: 'repo',
      scopeKey: 'bad-openai-compatible-repo',
      sessionId: 'bad-openai-compatible-session',
    }),
    /Provider output field/,
  );

  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'bad-openai-compatible-repo',
      sessionId: 'bad-openai-compatible-session',
    }).length,
    1,
  );
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'bad-openai-compatible-repo',
    sessionId: 'bad-openai-compatible-session',
  });
  assert.equal(runs[0].status, 'failed');
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
  assert.equal(runs[0].inputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v9');
  assert.equal(runs[0].outputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v9');
});

test('bootstrapContext returns semantic retrieval with trust and verification hints', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    key: 'issue-69-contract',
    content: 'Issues and PRs changed the bootstrap API contract for agents.',
    category: 'decision',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    key: 'indentation-style',
    content: 'Use four spaces for generated examples in this repo.',
    category: 'preference',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'agent-bootstrap-policy',
    content: 'Agents should verify PR and CI state before acting on retrieved context.',
    category: 'policy',
  });

  const result = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    query: 'issue 69 bootstrap contract previous work',
    includeShared: true,
    limit: 5,
  });

  assert.deepEqual(result.scope, { scopeType: 'repo', scopeKey: 'repo-bootstrap' });
  assert.equal(result.storage.mode, 'project-local');
  assert.equal(result.storage.authority, 'project-local');
  assert.match(result.summary, /Found/);
  assert.ok(result.results.some((item) => item.group === 'primary' && item.key === 'issue-69-contract'));
  assert.ok(result.results.some((item) => item.group === 'shared' && item.key === 'agent-bootstrap-policy'));
  const repoHit = result.results.find((item) => item.key === 'issue-69-contract');
  assert.equal(repoHit.trust, 'reviewed_durable');
  assert.equal(repoHit.verificationRequired, true);
  assert.ok(Array.isArray(repoHit.why));
  assert.equal(Object.hasOwn(repoHit, 'score'), false);
  assert.match(repoHit.whyUse, /Reviewed durable/);
  assert.ok(result.nextActions.some((item) => item.includes('Verify current git')));

  const stableResult = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    query: 'indentation style examples',
    limit: 3,
    rawTailLimit: 0,
  });
  const stableHit = stableResult.results.find((item) => item.key === 'indentation-style');
  assert.equal(stableHit.verificationRequired, false);
  assert.equal(Object.hasOwn(stableResult, 'rawTailLimit'), false);
});

test('bootstrapContext reuses one query embedding across repo and shared retrieval', async () => {
  const dataDir = await makeTempDir();
  let embedCalls = 0;
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      embedCalls += 1;
      return texts.map(() => [1, 0, 0]);
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: provider,
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap-embed',
    key: 'repo-bootstrap-memory',
    content: 'Repo bootstrap retrieval should reuse embeddings.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'shared-bootstrap-memory',
    content: 'Shared bootstrap retrieval should reuse embeddings.',
  });

  const result = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap-embed',
    query: 'bootstrap retrieval',
    includeShared: true,
  });

  assert.equal(embedCalls, 1);
  assert.equal(result.sharedLimit, 3);
  assert.ok(result.results.some((item) => item.group === 'primary'));
  assert.ok(result.results.some((item) => item.group === 'shared'));
});

test('syncResumeContext returns handoff context without promotion proposals', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'resume_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      resume_provider: async () => ({
        summaryShort: 'Resume handoff for usage observability.',
        summaryText:
          'Usage observability work left unfinished migration checks and PR verification for the next agent.',
        decisions: ['Use checkpoint handoff for prior intent.'],
        todos: ['Verify CI before acting.'],
        openQuestions: [],
        structured: {
          schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
          work: {
            intent: 'Resume usage observability verification.',
            status: 'in_progress',
            outcome: 'Next agent should verify CI live.',
          },
          liveState: {
            prNumber: 321,
            ciStatus: 'unknown',
            observedAt: '2026-06-03T00:00:00Z',
            verificationRequired: true,
            staleReasons: ['PR and CI state can change after checkpoint creation'],
            verifyHints: ['gh pr view 321 --json statusCheckRollup'],
          },
          changes: [],
          verification: [],
          risks: [],
          nextActions: [
            {
              action: 'Verify CI before acting.',
              priority: 'high',
              requiresLiveVerification: true,
            },
          ],
        },
        sessionWorkingContext: {
          currentTask: 'Continue usage observability closeout verification.',
          currentUserIntent: 'Resume unfinished PR verification without proposing memory promotions.',
          targetSubject: 'usage observability',
          openQuestion: 'Has CI passed on the latest PR commit?',
          nonGoals: ['memory promotion review during resume'],
          avoidMisreadings: ['checkpoint is weak memory'],
          confidence: 0.82,
        },
        memoryCandidates: [
          {
            key: 'resume-candidate-runbook',
            content: 'Review usage observability closeout candidates only at closeout.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'resume-repo',
    key: 'resume-durable-rule',
    content: 'Usage observability resume must verify CI live.',
    category: 'runbook',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
    role: 'assistant',
    content: 'Usage observability checkpoint should preserve unfinished work.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
  });

  const result = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
    query: 'usage observability resume unfinished work closeout candidates',
  });

  assert.equal(result.kind, 'resume_context');
  assert.equal(result.handoff.latestHandoff.structured.work.status, 'in_progress');
  assert.equal(result.handoff.latestHandoff.structuredWarnings[0].code, 'live_state_may_be_stale');
  assert.equal(result.handoff.structuredWorkingContext.type, 'session_working_context');
  assert.equal(result.handoff.structuredWorkingContext.trust, 'mutable_session_state');
  assert.match(result.handoff.structuredWorkingContext.currentTask, /usage observability/);
  assert.deepEqual(result.handoff.structuredWorkingContext.nonGoals, ['memory promotion review during resume']);
  assert.equal(result.handoff.recentCheckpoints[0].trust, 'credible_recent_handoff');
  assert.match(result.handoff.recentCheckpoints[0].useHint, /Use actively/);
  assert.equal(result.handoff.memoryCandidates.count, 1);
  assert.equal(result.handoff.memoryCandidates.items[0].trust, 'review_material');
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  assert.ok(result.nextActions.includes('Do not propose memory promotions during resume sync.'));
});

test('syncResumeContext handles empty bootstrap results without proposals', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const result = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'empty-resume-repo',
    query: 'no matching resume context',
  });

  assert.equal(result.kind, 'resume_context');
  assert.deepEqual(result.handoff.durableMemories, []);
  assert.deepEqual(result.handoff.recentCheckpoints, []);
  assert.equal(result.handoff.memoryCandidates.count, 0);
  assert.equal(Object.hasOwn(result, 'proposals'), false);
});

test('suggestMemoryPromotions avoids scope fallback unless explicitly allowed', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'suggest_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      suggest_provider: async () => ({
        summaryShort: 'Promotion suggestion checkpoint.',
        summaryText: 'Closeout produced a stable runbook candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'closeout-runbook',
            content: 'Closeout should verify branch parity before frontend follow-up.',
            reason: 'PR #595 merge and main parity were verified.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.91,
            stability: 0.92,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    sessionId: 'suggest-session',
    role: 'assistant',
    content: 'Closeout candidate: branch parity runbook.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    sessionId: 'suggest-session',
  });

  const noFallback = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    trigger: 'manual_closeout',
  });
  assert.deepEqual(noFallback.proposals, []);
  assert.equal(noFallback.source.mode, 'none');
  assert.ok(noFallback.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));
  assert.ok(
    noFallback.nextActions.some((action) =>
      action.includes('No current-session closeout candidates were reviewed'),
    ),
  );

  await assert.rejects(
    () =>
      app.suggestMemoryPromotions({
        scope: 'repo',
        scopeKey: 'suggest-repo',
        trigger: 'agent_merged_pr',
        allowScopeFallback: true,
      }),
    /allowScopeFallback/,
  );

  const fallback = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    trigger: 'manual_closeout',
    allowScopeFallback: true,
  });
  assert.equal(fallback.source.mode, 'scope_fallback');
  assert.equal(fallback.proposals.length, 1);
  assert.equal(fallback.proposals[0].key, 'closeout-runbook');
});

test('suggestMemoryPromotions honors scanLimit and reports capped proposal limits', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scan_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      scan_provider: async () => ({
        summaryShort: 'Many candidates.',
        summaryText: 'Closeout produced many promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: Array.from({ length: 5 }, (_, index) => ({
          key: `scan-runbook-${index + 1}`,
          content: `Runbook candidate ${index + 1}.`,
          category: 'runbook',
          candidateType: 'runbook',
          confidence: 0.9,
          stability: 0.9,
          sensitivity: 'low',
          promotionRecommendation: 'promote',
        })),
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
    role: 'assistant',
    content: 'Many closeout candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
  });

  const result = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
    trigger: 'manual_closeout',
    scanLimit: 2,
    limit: 5,
  });

  assert.equal(result.proposals.length, 2);
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'limit_capped'));
});

test('suggestMemoryPromotions uses only latest checkpoint for a session and skips risky candidates', async () => {
  const dataDir = await makeTempDir();
  let callCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'latest_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      latest_provider: async () => {
        callCount += 1;
        return {
          summaryShort: `Checkpoint ${callCount}.`,
          summaryText: `Checkpoint ${callCount} contains candidates.`,
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates:
            callCount === 1
              ? [
                  {
                    key: 'old-runbook',
                    content: 'Old checkpoint candidate should not be suggested from latest session closeout.',
                    category: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  },
                ]
              : [
                  {
                    key: 'latest-runbook',
                    content: 'Latest checkpoint candidate should be suggested.',
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  },
                  {
                    key: 'latest-secret',
                    content: 'Risky candidate should not be suggested.',
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'high',
                    promotionRecommendation: 'promote',
                  },
                ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    role: 'assistant',
    content: 'First checkpoint raw.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    role: 'assistant',
    content: 'Second checkpoint raw.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
  });

  const result = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    trigger: 'user_declared_work_done',
  });

  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key),
    ['latest-runbook'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('high_sensitivity')));
});

test('autoPromoteMemoryCandidates requires closeout scope and defaults to dry-run', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      auto_provider: async () => ({
        summaryShort: 'Auto promote checkpoint.',
        summaryText: 'Closeout produced strict automatic promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'auto-runbook',
            content: 'Closeout automation can promote strict runbook candidates.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
    role: 'assistant',
    content: 'Strict auto promotion candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
  });

  const noSource = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    trigger: 'manual_closeout',
  });
  assert.equal(noSource.kind, 'auto_memory_promotion_result');
  assert.deepEqual(noSource.wouldPromote, []);
  assert.equal(noSource.source.mode, 'none');
  assert.ok(noSource.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));
  assert.ok(
    noSource.nextActions.some((action) =>
      action.includes('No current-session closeout candidates were reviewed'),
    ),
  );

  const dryRun = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
    trigger: 'user_declared_work_done',
    limit: 5,
  });
  assert.equal(dryRun.kind, 'auto_memory_promotion_result');
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.wouldPromote.length, 1);
  assert.deepEqual(dryRun.promoted, []);
  assert.equal(dryRun.wouldPromote[0].key, 'auto-runbook');
  assert.ok(dryRun.requestWarnings.some((warning) => warning.code === 'limit_capped'));
  assert.equal(app.listMemoryCandidates({ scope: 'repo', scopeKey: 'auto-repo', status: 'promoted' }).length, 0);

  const checkpointOnly = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(checkpointOnly.source.mode, 'checkpoint');
  assert.equal(checkpointOnly.wouldPromote.length, 1);

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        minConfidence: 1.5,
      }),
    /minConfidence/,
  );

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        minStability: -1,
      }),
    /minStability/,
  );

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        dryRun: false,
      }),
    /CONTEXTFORGE_AUTO_PROMOTE_ENABLED/,
  );
});

test('auditMemoryCandidates returns audited read-only recommendations', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_suggestions_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate, warnings, checkpoint }) => {
      auditInvocations.push({ candidate, warnings, checkpoint });
      return {
        approved: true,
        decision: 'approve',
        reason: 'Candidate is stable enough to offer as a closeout recommendation.',
        riskCodes: [],
        metadata: {
          provider: 'codex_exec',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
            prompt_tokens_details: {
              cached_tokens: 40,
            },
            completion_tokens_details: {
              reasoning_tokens: 7,
            },
          },
        },
      };
    },
    distillProviders: {
      audit_suggestions_provider: async () => ({
        summaryShort: 'Audit suggestions checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited without mutation.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audited-readonly-runbook',
            content: 'Agents should audit closeout memory candidates before suggesting promotion.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
    role: 'assistant',
    content: 'Read-only audited candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
  });

  const noSource = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    trigger: 'manual_closeout',
  });
  assert.equal(noSource.kind, 'memory_candidate_audit_suggestions');
  assert.deepEqual(noSource.proposals, []);
  assert.equal(noSource.source.mode, 'none');
  assert.ok(noSource.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    checkpointId: checkpoint.id,
    trigger: 'user_declared_work_done',
    limit: 50,
  });

  assert.equal(result.kind, 'memory_candidate_audit_suggestions');
  assert.equal(result.policy.mutates, false);
  assert.equal(result.policy.audit.executed, true);
  assert.equal(result.policy.audit.provider, 'none');
  assert.equal(result.source.mode, 'checkpoint');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].key, 'audited-readonly-runbook');
  assert.equal(result.proposals[0].recommendedAction, 'promote');
  assert.equal(result.proposals[0].audit.metadata.model, 'gpt-5.5');
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'limit_capped'));
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].checkpoint.id, checkpoint.id);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-suggestions-repo', key: 'audited-readonly-runbook' }), null);
  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 1);
  assert.equal(pendingCandidates[0].candidate.key, 'audited-readonly-runbook');

  const store = new ContextForgeStore({ dataDir });
  const events = store.listLlmUsageEvents({
    scopeType: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'candidate_audit');
  assert.equal(events[0].provider, 'codex_exec');
  assert.equal(events[0].model, 'gpt-5.5');
  assert.equal(events[0].checkpointId, checkpoint.id);
  assert.equal(events[0].candidateId, pendingCandidates[0].id);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].cachedInputTokens, 40);
  assert.equal(events[0].uncachedInputTokens, 60);
  assert.equal(events[0].outputTokens, 25);
  assert.equal(events[0].reasoningTokens, 7);
  assert.equal(events[0].totalTokens, 125);
  store.close();
});

test('auditMemoryCandidates records failed audit usage when error metadata includes usage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_failure_usage_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      const error = new Error('Synthetic audit transport failure.');
      error.metadata = {
        provider: 'codex_sdk_python',
        model: 'gpt-5.5',
        usage: {
          input_tokens: 30,
          output_tokens: 4,
          total_tokens: 34,
          input_tokens_details: {
            cached_tokens: 12,
          },
        },
      };
      throw error;
    },
    distillProviders: {
      audit_failure_usage_provider: async () => ({
        summaryShort: 'Audit failure usage checkpoint.',
        summaryText: 'Closeout produced a candidate whose audit fails after usage is known.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-failure-usage-runbook',
            content: 'Failed audit calls should preserve token usage when providers expose it.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
    role: 'assistant',
    content: 'Failed audit usage should be preserved.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].recommendedAction, 'review');

  const events = app.listLlmUsageEvents({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'candidate_audit');
  assert.equal(events[0].status, 'failed');
  assert.equal(events[0].provider, 'codex_sdk_python');
  assert.equal(events[0].inputTokens, 30);
  assert.equal(events[0].cachedInputTokens, 12);
  assert.equal(events[0].uncachedInputTokens, 18);
  assert.equal(events[0].totalTokens, 34);
});

test('auditMemoryCandidates audits review candidates and skips noisy events before runner', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_review_selection_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '99',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Reviewed ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      audit_review_selection_provider: async () => ({
        summaryShort: 'Audit review selection checkpoint.',
        summaryText: 'Closeout produced review and noisy candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'review-worthy-policy',
            content: 'Agents must verify mutable live state before using structured checkpoint liveState values.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.82,
            stability: 0.82,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-api-contract',
            content: 'GET /healthz must return 200 for the server health contract.',
            category: 'api_contract',
            candidateType: 'api_contract',
            confidence: 0.83,
            stability: 0.83,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-ci-policy',
            content: 'CI must run lint and tests on every PR before merge.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.84,
            stability: 0.84,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-draft-policy',
            content: 'Open work as a draft PR until checks are ready for review.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.81,
            stability: 0.81,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'pr-status-noise',
            content: 'PR #126 passed npm test 142/142 and CI was green.',
            category: 'project_status',
            candidateType: 'fact',
            confidence: 0.98,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'local-runtime-noise',
            content: 'Restart `/home/ubuntu/contextforge` with systemctl on this host.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.97,
            stability: 0.91,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    sessionId: 'audit-review-selection-session',
    role: 'assistant',
    content: 'Review candidates should be filtered before audit.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    sessionId: 'audit-review-selection-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    limit: 5,
  });

  assert.deepEqual(auditInvocations.sort(), [
    'review-worthy-api-contract',
    'review-worthy-ci-policy',
    'review-worthy-draft-policy',
    'review-worthy-policy',
  ]);
  assert.equal(result.policy.audit.executed, true);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key).sort(),
    [
      'review-worthy-api-contract',
      'review-worthy-ci-policy',
      'review-worthy-draft-policy',
      'review-worthy-policy',
    ],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_transient_category')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_one_off_event')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_environment_specific')));
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'audit-review-selection-repo', key: 'review-worthy-policy' }),
    null,
  );
});

test('auditMemoryCandidates honors narrowed allowedCategories', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_allowed_categories_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Reviewed ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      audit_allowed_categories_provider: async () => ({
        summaryShort: 'Audit allowed categories checkpoint.',
        summaryText: 'Closeout produced candidates in different durable categories.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'allowed-runbook',
            content: 'Use scoped bootstrap before editing ContextForge runtime code.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'blocked-policy',
            content: 'Agents must verify mutable live state before using checkpoint liveState.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    sessionId: 'audit-allowed-categories-session',
    role: 'assistant',
    content: 'Allowed categories should narrow audit candidate selection.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    sessionId: 'audit-allowed-categories-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    allowedCategories: ['runbook'],
    limit: 5,
  });

  assert.deepEqual(auditInvocations, ['allowed-runbook']);
  assert.deepEqual(result.policy.allowedCategories, ['runbook']);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key),
    ['allowed-runbook'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('audit_disallowed_category')));
});

test('distillCheckpoint automatically audits session candidate batches', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'batch_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.id);
      return {
        approved: true,
        decision: 'approve',
        reason: `Audited ${candidate.candidate.key} in a batch.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
          },
        },
      };
    },
    distillProviders: {
      batch_audit_provider: async () => ({
        summaryShort: 'Batch audit checkpoint.',
        summaryText: 'The checkpoint produced enough candidates for automatic batched audit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'batch-audit-runbook',
            content: 'Run automatic candidate audits in batches.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'batch-audit-contract',
            content: 'Automatic promotion writes require audit approval.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    role: 'assistant',
    content: 'Create enough candidates for batch audit.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
  });

  assert.equal(checkpoint.candidateAudit.executed, true);
  assert.equal(checkpoint.candidateAudit.reason, 'batch_threshold');
  assert.equal(checkpoint.candidateAudit.audited, 2);
  assert.equal(checkpoint.candidateAudit.promoted, 0);
  assert.equal(auditInvocations.length, 2);
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    status: 'pending',
  });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.audit?.metadata?.model === 'gpt-5.5'));
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.auditMetadata?.sourceMode === 'threshold_batch'));
  const usageEvents = app.listLlmUsageEvents({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    operation: 'candidate_audit',
    order: 'asc',
  });
  assert.equal(usageEvents.length, 2);
  assert.ok(usageEvents.every((event) => event.distillRunId === checkpoint.distillRunId));
  assert.deepEqual(
    usageEvents.map((event) => event.candidateId).sort(),
    candidates.map((candidate) => candidate.id).sort(),
  );
  assert.deepEqual(
    usageEvents.map((event) => event.totalTokens),
    [25, 25],
  );

  const storedAudit = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    trigger: 'manual_closeout',
    limit: 2,
  });
  assert.equal(storedAudit.proposals.length, 2);
  assert.equal(storedAudit.proposals[0].audit.metadata.model, 'gpt-5.5');
  assert.equal(auditInvocations.length, 2);
});

test('distillCheckpoint automatically audits review-worthy non-promote candidate batches', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'review_batch_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Audited review candidate ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      review_batch_audit_provider: async () => ({
        summaryShort: 'Review batch audit checkpoint.',
        summaryText: 'The checkpoint produced review-worthy candidates for batched audit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'review-batch-policy',
            content: 'Agents must verify mutable live state before relying on checkpoint liveState values.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.82,
            stability: 0.82,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-batch-architecture',
            content: 'Structured checkpoint handoff should be exposed separately from ordinary search results.',
            category: 'architecture',
            candidateType: 'decision',
            confidence: 0.81,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'review-batch-audit-repo',
    sessionId: 'review-batch-audit-session',
    role: 'assistant',
    content: 'Create enough review candidates for batch audit.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'review-batch-audit-repo',
    sessionId: 'review-batch-audit-session',
  });

  assert.equal(checkpoint.candidateAudit.executed, true);
  assert.equal(checkpoint.candidateAudit.reason, 'batch_threshold');
  assert.equal(checkpoint.candidateAudit.audited, 2);
  assert.deepEqual(auditInvocations.sort(), ['review-batch-architecture', 'review-batch-policy']);
});

test('distillCheckpoint audits new candidates even when audited pending candidates fill the first window', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  let distillCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'batch_window_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: true,
        decision: 'approve',
        reason: `Audited ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      batch_window_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: `Batch audit checkpoint ${distillCount}.`,
          summaryText: 'The checkpoint produced enough candidates for automatic batched audit.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `batch-window-${distillCount}-a`,
              content: `Batch audit candidate A ${distillCount}.`,
              category: 'runbook',
              candidateType: 'runbook',
              confidence: 0.96,
              stability: 0.96,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
            {
              key: `batch-window-${distillCount}-b`,
              content: `Batch audit candidate B ${distillCount}.`,
              category: 'api-contract',
              candidateType: 'api-contract',
              confidence: 0.95,
              stability: 0.95,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
          ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
    role: 'assistant',
    content: 'First audit batch.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
  });
  assert.equal(first.candidateAudit.audited, 2);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
    role: 'assistant',
    content: 'Second audit batch should not be blocked by the first audited pending batch.',
  });
  const second = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
  });

  assert.equal(second.candidateAudit.executed, true);
  assert.equal(second.candidateAudit.audited, 2);
  assert.deepEqual(auditInvocations, [
    'batch-window-1-a',
    'batch-window-1-b',
    'batch-window-2-a',
    'batch-window-2-b',
  ]);
});

test('distillCheckpoint waits below audit threshold but closeout trigger forces audit', async () => {
  const dataDir = await makeTempDir();
  let auditCount = 0;
  let distillCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'closeout_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '5',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditCount += 1;
      return {
        approved: false,
        decision: 'needs_review',
        reason: 'Closeout audit should run even below the batch threshold.',
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      closeout_audit_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: 'Closeout audit checkpoint.',
          summaryText: 'The checkpoint produced one candidate.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `closeout-audit-${distillCount}`,
              content: `Closeout audits force candidate review ${distillCount}.`,
              category: 'runbook',
              candidateType: 'runbook',
              confidence: 0.96,
              stability: 0.96,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
          ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    role: 'assistant',
    content: 'First candidate should wait below threshold.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
  });
  assert.equal(first.candidateAudit.executed, false);
  assert.equal(first.candidateAudit.reason, 'below_batch_threshold');
  assert.equal(auditCount, 0);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    role: 'assistant',
    content: 'Closeout should force audit.',
  });
  const second = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    auditTrigger: 'manual_closeout',
  });
  assert.equal(second.candidateAudit.executed, true);
  assert.equal(second.candidateAudit.reason, 'closeout_trigger');
  assert.equal(second.candidateAudit.audited, 2);
  assert.equal(auditCount, 2);
});

test('auditMemoryCandidates keeps recommendations conservative when audit is disabled', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_disabled_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
    },
    cwd: process.cwd(),
    distillProviders: {
      audit_disabled_provider: async () => ({
        summaryShort: 'Audit disabled checkpoint.',
        summaryText: 'Closeout produced a candidate while the audit provider is disabled.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-disabled-runbook',
            content: 'Read-only audit suggestions should not recommend promotion when audit is disabled.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    role: 'assistant',
    content: 'Audit disabled read-only candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    auditTrigger: 'manual_closeout',
  });
  assert.equal(checkpoint.candidateAudit.executed, false);
  assert.equal(checkpoint.candidateAudit.reason, 'audit_disabled');

  const pendingBeforeAudit = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    status: 'pending',
  });
  assert.equal(pendingBeforeAudit.length, 1);
  assert.equal(pendingBeforeAudit[0].reviewMetadata.audit, undefined);

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    trigger: 'manual_closeout',
  });

  assert.equal(result.policy.audit.enabled, false);
  assert.equal(result.policy.audit.executed, false);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'audit_disabled');
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'audit_disabled'));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-disabled-repo', key: 'audit-disabled-runbook' }), null);
  const pendingAfterAudit = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    status: 'pending',
  });
  assert.equal(pendingAfterAudit[0].reviewMetadata.audit, undefined);
});

test('autoPromoteMemoryCandidates returns stable empty arrays and preference input warnings', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_empty_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      auto_empty_provider: async () => ({
        summaryShort: 'No candidates.',
        summaryText: 'Closeout produced no memory candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
    role: 'assistant',
    content: 'No candidates here.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
    trigger: 'manual_closeout',
    allowedCategories: ['preference'],
  });
  assert.equal(result.kind, 'auto_memory_promotion_result');

  assert.deepEqual(result.wouldPromote, []);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.policy.allowedCategories, []);
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'preference_input_stripped'));
});

test('autoPromoteMemoryCandidates promotes only strict safe candidates when enabled', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('safe-api-contract') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_enabled_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    autoPromoteAuditor: async () => ({
      approved: true,
      decision: 'approve',
      reason: 'Test auditor approved strict safe candidate.',
      riskCodes: [],
      metadata: {
        provider: 'codex_exec',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
      },
    }),
    distillProviders: {
      auto_enabled_provider: async () => ({
        summaryShort: 'Auto enabled checkpoint.',
        summaryText: 'Closeout produced mixed automatic promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'safe-api-contract',
            content: 'The API contract requires idempotent delete retries.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'safe-runbook',
            content: 'The runbook requires processing embeddings after promoted memory writes.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.94,
            stability: 0.93,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'user-pref',
            content: 'The user prefers a particular closing phrase.',
            category: 'preference',
            candidateType: 'preference',
            confidence: 0.99,
            stability: 0.99,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'low-confidence-runbook',
            content: 'This runbook is not stable enough.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.7,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
    role: 'assistant',
    content: 'Mixed auto promotion candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
  });
  const processedDistillEmbeddings = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
  });
  assert.deepEqual(processedDistillEmbeddings.bySourceType, {
    checkpoint: 1,
    memory_candidate: 4,
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
    trigger: 'agent_merged_pr',
    dryRun: false,
  });

  assert.equal(result.kind, 'auto_memory_promotion_result');
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.wouldPromote, []);
  assert.deepEqual(
    result.promoted.map((item) => item.key),
    ['safe-api-contract', 'safe-runbook'],
  );
  assert.ok(result.promoted[0].evidence);
  assert.equal(result.promoted[0].promotionResult.status, 'promoted');
  const pendingEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    status: 'pending',
  });
  assert.deepEqual(
    pendingEmbeddingJobs.map((job) => job.sourceType),
    ['memory', 'memory'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('preference_auto_excluded')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_low_confidence')));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-enabled-repo', key: 'safe-api-contract' }).status, 'active');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-enabled-repo', key: 'user-pref' }), null);
  const promotedCandidates = app.listMemoryCandidates({ scope: 'repo', scopeKey: 'auto-enabled-repo', status: 'promoted' });
  assert.equal(promotedCandidates.length, 2);
  assert.ok(promotedCandidates.every((candidate) => candidate.reviewMetadata.autoPromoted === true));
  assert.ok(promotedCandidates.every((candidate) => candidate.reviewMetadata.autoPromotionAudit?.metadata?.model === 'gpt-5.5'));
  assert.deepEqual(
    promotedCandidates.map((candidate) => candidate.reviewMetadata.memoryId).sort(),
    result.promoted.map((item) => item.memoryId).sort(),
  );
  const promotedApiCandidate = promotedCandidates.find((candidate) => candidate.candidate.key === 'safe-api-contract');
  assert.ok(promotedApiCandidate, 'expected safe-api-contract promoted candidate');
  const autoEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    key: 'safe-api-contract',
  });
  assert.equal(autoEvents[0].metadata.sourceCandidateId, promotedApiCandidate.id);
  assert.equal(autoEvents[0].metadata.autoPromoted, true);
  const processedMemoryEmbedding = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
  });
  assert.deepEqual(processedMemoryEmbedding.bySourceType, {
    memory: 2,
  });
  const memoryResults = await app.search({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    query: 'safe-api-contract',
  });
  const safeApiMemoryResult = memoryResults.find(
    (result) => result.type === 'memory' && result.memory.key === 'safe-api-contract',
  );
  assert.ok(safeApiMemoryResult, 'expected safe-api-contract memory result');
  assert.equal(safeApiMemoryResult.retrieval.vectorModel, 'test-embedding');
});

test('autoPromoteMemoryCandidates rejects one-off and environment-specific candidates before audit', async () => {
  const dataDir = await makeTempDir();
  let auditCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_strict_durability_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditCount += 1;
      return {
        approved: true,
        decision: 'approve',
        reason: 'The test auditor would approve if local policy allowed it.',
        riskCodes: [],
        metadata: {
          provider: 'codex_exec',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      auto_strict_durability_provider: async () => ({
        summaryShort: 'Strict durability checkpoint.',
        summaryText: 'Closeout produced candidates with mixed durability.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'repo-common-api-contract',
            content: 'The API contract requires idempotent delete retries.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'pr-ci-snapshot',
            content: 'PR #126 passed npm test 142/142 and CI was green.',
            category: 'project_state',
            candidateType: 'fact',
            confidence: 0.98,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'local-service-restart',
            content: 'Restart `/home/ubuntu/contextforge` service with systemctl after this local deployment.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.97,
            stability: 0.91,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
    role: 'assistant',
    content: 'Mixed strict durability candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(
    result.promoted.map((item) => item.key),
    ['repo-common-api-contract'],
  );
  assert.equal(auditCount, 1);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-strict-durability-repo', key: 'pr-ci-snapshot' }), null);
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'auto-strict-durability-repo', key: 'local-service-restart' }),
    null,
  );
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_transient_category')));
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_one_off_event')));
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_environment_specific')));
});

test('autoPromoteMemoryCandidates skips candidates rejected by the audit runner', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_reject_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => ({
      approved: false,
      decision: 'needs_review',
      reason: 'Candidate is plausible but needs human review.',
      riskCodes: ['needs_human_review'],
      metadata: {
        provider: 'codex_exec',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
      },
    }),
    distillProviders: {
      audit_reject_provider: async () => ({
        summaryShort: 'Audit rejected checkpoint.',
        summaryText: 'Closeout produced a candidate that local checks would otherwise promote.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-gated-runbook',
            content: 'The runbook requires audit approval before automatic durable promotion.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
    role: 'assistant',
    content: 'Audit-gated candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(result.promoted, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'audit_needs_review: needs_human_review');
  assert.equal(result.skipped[0].audit.metadata.model, 'gpt-5.5');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-reject-repo', key: 'audit-gated-runbook' }), null);
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    status: 'pending',
  });
  assert.equal(candidates.length, 1);
});

test('autoPromoteMemoryCandidates keeps candidates pending when audit runner fails', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_fail_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      throw new Error('audit runner unavailable');
    },
    distillProviders: {
      audit_fail_provider: async () => ({
        summaryShort: 'Audit failed checkpoint.',
        summaryText: 'Closeout produced a candidate that local checks would otherwise promote.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-failed-runbook',
            content: 'The runbook requires audit success before automatic durable promotion.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
    role: 'assistant',
    content: 'Audit failure candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(result.promoted, []);
  assert.equal(result.skipped[0].reason, 'audit_needs_review: audit_failed');
  assert.match(result.skipped[0].audit.reason, /audit runner unavailable/);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-fail-repo', key: 'audit-failed-runbook' }), null);
});

test('autoPromoteMemoryCandidates can audit through the Codex Python SDK provider', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'python_sdk_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'codex_sdk_python',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN: '/home/ubuntu/.local/bin/codex',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND: 'python3',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH: '/tmp/contextforge-codex-sdk',
    },
    cwd: process.cwd(),
    autoPromoteAuditRunner: async (invocation) => {
      auditInvocations.push(invocation);
      return {
        stdout: JSON.stringify({
          final_response: JSON.stringify({
            approved: true,
            decision: 'approve',
            reason: 'The candidate is stable and supported by checkpoint evidence.',
            riskCodes: [],
          }),
          elapsed_ms: 12,
        }),
        stderr: '',
      };
    },
    distillProviders: {
      python_sdk_audit_provider: async () => ({
        summaryShort: 'Python SDK audit checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited through the Python SDK provider.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'python-sdk-audit-runbook',
            content: 'The runbook is stable and safe enough for automatic durable promotion after audit.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
    role: 'assistant',
    content: 'Python SDK audit candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.equal(result.policy.audit.provider, 'codex_sdk_python');
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].audit.metadata.provider, 'codex_sdk_python');
  assert.equal(result.promoted[0].audit.metadata.codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(result.promoted[0].audit.metadata.pythonPath, '/tmp/contextforge-codex-sdk');
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(auditInvocations[0].pythonCommand, 'python3');
  assert.equal(auditInvocations[0].pythonPath, '/tmp/contextforge-codex-sdk');
  assert.match(auditInvocations[0].prompt, /ContextForge automatic memory promotion auditor/);
  assert.match(auditInvocations[0].prompt, /human-readable reason in Korean/);
  assert.ok(
    app.getMemory({ scope: 'repo', scopeKey: 'python-sdk-audit-repo', key: 'python-sdk-audit-runbook' }),
  );
});

test('auditMemoryCandidates can use the Codex Python SDK provider without enabling auto-promotion', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'python_sdk_audit_suggestions_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'codex_sdk_python',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN: '/home/ubuntu/.local/bin/codex',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND: 'python3',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH: '/tmp/contextforge-codex-sdk',
    },
    cwd: process.cwd(),
    autoPromoteAuditRunner: async (invocation) => {
      auditInvocations.push(invocation);
      return {
        stdout: JSON.stringify({
          final_response: JSON.stringify({
            approved: false,
            decision: 'needs_review',
            reason: 'The agent should review this candidate before promotion.',
            riskCodes: ['needs_human_review'],
          }),
          elapsed_ms: 21,
        }),
        stderr: '',
      };
    },
    distillProviders: {
      python_sdk_audit_suggestions_provider: async () => ({
        summaryShort: 'Python SDK audit suggestions checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited without auto-promotion.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'python-sdk-readonly-audit',
            content: 'The Python SDK audit provider can produce read-only closeout recommendations.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
    role: 'assistant',
    content: 'Python SDK read-only audited candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
    trigger: 'manual_closeout',
  });

  assert.equal(result.policy.audit.provider, 'codex_sdk_python');
  assert.equal(result.policy.audit.executed, true);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].recommendedAction, 'review');
  assert.equal(result.proposals[0].audit.metadata.provider, 'codex_sdk_python');
  assert.equal(result.proposals[0].audit.metadata.codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].pythonCommand, 'python3');
  assert.equal(
    app.getMemory({
      scope: 'repo',
      scopeKey: 'python-sdk-audit-suggestions-repo',
      key: 'python-sdk-readonly-audit',
    }),
    null,
  );
  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 1);
});

test('Codex Python SDK auditor treats empty final_response as needs_review', async () => {
  const auditor = createCodexSdkPythonAutoPromoteAuditor({
    codexBin: '/home/ubuntu/.local/bin/codex',
    pythonCommand: 'python3',
    runner: async () => ({
      stdout: JSON.stringify({
        final_response: null,
        elapsed_ms: 7,
      }),
      stderr: '',
    }),
  });

  const result = await auditor({
    candidate: {
      candidate: {
        key: 'empty-final-response',
        content: 'The audit runner returned no final response.',
        category: 'runbook',
      },
    },
    warnings: [],
    checkpoint: null,
  });

  assert.equal(result.approved, false);
  assert.equal(result.decision, 'needs_review');
  assert.deepEqual(result.riskCodes, ['empty_final_response']);
  assert.equal(result.metadata.runnerElapsedMs, 7);
});

test('autoPromoteMemoryCandidates rejects unsupported audit providers', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'unsupported_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'unknown_audit',
    },
    cwd: process.cwd(),
    distillProviders: {
      unsupported_audit_provider: async () => ({
        summaryShort: 'Unsupported audit provider checkpoint.',
        summaryText: 'Closeout produced a candidate while audit is misconfigured.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'unsupported-audit-runbook',
            content: 'The runbook should not promote when audit provider is unsupported.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'unsupported-audit-repo',
    sessionId: 'unsupported-audit-session',
    role: 'assistant',
    content: 'Unsupported audit provider candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'unsupported-audit-repo',
    sessionId: 'unsupported-audit-session',
  });

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'unsupported-audit-repo',
        sessionId: 'unsupported-audit-session',
        trigger: 'manual_closeout',
        dryRun: false,
      }),
    /Unsupported auto-promotion audit provider/,
  );
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'unsupported-audit-repo', key: 'unsupported-audit-runbook' }), null);
});

test('preference candidates record merged occurrences across checkpoints', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'preference_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      preference_provider: async () => ({
        summaryShort: 'Preference checkpoint.',
        summaryText: 'A repeated user preference was observed.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'closing-style',
            content: 'The user prefers concise Korean closeout summaries with command evidence.',
            category: 'preference',
            candidateType: 'preference',
            confidence: 0.9,
            stability: 0.86,
            sensitivity: 'low',
            promotionRecommendation: 'review',
            sourceEventIds: ['event-a'],
          },
        ],
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-a',
    role: 'user',
    content: 'Keep closeout summaries concise and in Korean.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-a',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-b',
    role: 'user',
    content: 'Again, keep closeout summaries concise and in Korean.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-b',
  });

  const occurrences = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-repo',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].mergeKey, 'key:closing-style');
  assert.equal(occurrences[0].occurrenceCount, 2);
  assert.deepEqual(occurrences[0].sessionIds.sort(), ['preference-session-a', 'preference-session-b']);
  assert.equal(occurrences[0].checkpointIds.length, 2);
  assert.equal(occurrences[0].confidence, 0.9);
  assert.equal(occurrences[0].stability, 0.86);
});

test('preference occurrence backfill covers existing preference candidates', async () => {
  const dataDir = await makeTempDir();
  const env = {
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DISTILL_PROVIDER: 'preference_backfill_provider',
  };
  const distillProviders = {
    preference_backfill_provider: async () => ({
      summaryShort: 'Preference backfill checkpoint.',
      summaryText: 'A preference candidate existed before occurrence tracking.',
      decisions: [],
      todos: [],
      openQuestions: [],
      memoryCandidates: [
        {
          key: 'review-style',
          content: 'The user prefers review comments grouped by severity.',
          category: 'Preference',
          candidateType: 'preference',
          confidence: 0.88,
          stability: 0.82,
          sensitivity: 'low',
          promotionRecommendation: 'review',
        },
      ],
    }),
  };
  const app = createContextForge({ env, cwd: process.cwd(), distillProviders });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
    sessionId: 'preference-backfill-session',
    role: 'assistant',
    content: 'Preference candidate exists before backfill.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
    sessionId: 'preference-backfill-session',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('DELETE FROM preference_occurrences').run();
    db.prepare("DELETE FROM schema_meta WHERE key = 'preference_occurrences_backfill_completed_at'").run();
  } finally {
    db.close();
  }

  const reopened = createContextForge({ env, cwd: process.cwd(), distillProviders });
  const occurrences = reopened.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].mergeKey, 'key:review-style');
  assert.equal(occurrences[0].occurrenceCount, 1);
});

test('reconcileMemory apply_safe weakens preference occurrences when rejecting contradicted candidates', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'preference_reconcile_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      preference_reconcile_provider: async () => ({
        summaryShort: 'Preference correction checkpoint.',
        summaryText: 'A preference candidate should be rejected after correction.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'summary-style',
            content: 'The user always wants long exhaustive closeout summaries.',
            category: 'Preference',
            candidateType: 'preference',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
    role: 'assistant',
    content: 'Preference candidate: long exhaustive summaries.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
  });

  const before = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
  });
  assert.equal(before[0].status, 'active');
  assert.equal(before[0].negativeCount, 0);

  const result = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
    query: 'summary style preference',
    correction: 'That is wrong; prefer concise summaries unless I ask for exhaustive detail.',
    mode: 'apply_safe',
  });

  assert.ok(result.appliedActions.some((action) => action.action === 'reject_memory_candidate'));
  assert.ok(result.appliedActions.some((action) => action.action === 'weaken_preference_occurrence'));
  const after = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
  });
  assert.equal(after[0].status, 'weakened');
  assert.equal(after[0].negativeCount, 1);
  assert.match(after[0].lastCorrection, /prefer concise/);
});

test('reconcileMemory proposes by default and apply_safe only changes unambiguous non-live memory', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'reconcile_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      reconcile_provider: async () => ({
        summaryShort: 'Reconcile checkpoint.',
        summaryText: 'Prior note incorrectly said the API uses REST only.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'api-rest-only-candidate',
            content: 'The API uses REST only.',
            category: 'api-contract',
            confidence: 0.8,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    key: 'api-transport',
    content: 'The API uses REST only.',
    category: 'api-contract',
    tags: ['api', 'transport'],
    importance: 6,
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    role: 'assistant',
    content: 'The API uses REST only.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
  });

  const proposedWithoutQuery = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    correction: 'API REST only transport is wrong; the API supports REST and GraphQL.',
  });
  assert.equal(
    proposedWithoutQuery.query,
    'API REST only transport is wrong; the API supports REST and GraphQL.',
  );
  assert.ok(proposedWithoutQuery.basis.some((item) => item.type === 'memory'));

  const proposed = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
  });
  assert.equal(proposed.mode, 'propose');
  assert.ok(proposed.basis.some((item) => item.type === 'memory'));
  assert.ok(proposed.basis.some((item) => item.type === 'checkpoint'));
  assert.ok(proposed.basis.some((item) => item.type === 'memory_candidate'));
  assert.ok(proposed.proposedActions.some((item) => item.action === 'correct_memory'));
  assert.ok(proposed.proposedActions.some((item) => item.action === 'reject_memory_candidate'));
  assert.ok(proposed.updateCandidates.some((item) => item.action === 'correct_memory'));
  assert.ok(proposed.updateCandidates.some((item) => item.action === 'add_corrective_note'));
  assert.equal(
    app.listMemoryUpdateCandidates({
      scope: 'repo',
      scopeKey: 'reconcile-repo',
      status: 'pending',
    }).length,
    0,
  );
  const persisted = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    createUpdateCandidates: true,
  });
  assert.ok(persisted.updateCandidates.every((item) => item.status === 'pending'));
  await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    createUpdateCandidates: true,
  });
  const pendingUpdates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    status: 'pending',
  });
  assert.equal(pendingUpdates.length, 2);
  assert.ok(pendingUpdates.some((item) => item.targetMemoryKey === 'api-transport'));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content, 'The API uses REST only.');

  const updateCandidate = pendingUpdates.find((item) => item.action === 'correct_memory');
  const appliedUpdate = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    candidateId: updateCandidate.id,
    content: 'The API supports REST, GraphQL, and webhooks.',
    reason: 'Approved correction candidate in test.',
  });
  assert.equal(appliedUpdate.kind, 'memory_update_candidate_apply_result');
  assert.equal(appliedUpdate.candidate.status, 'applied');
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content,
    'The API supports REST, GraphQL, and webhooks.',
  );

  const applied = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    mode: 'apply_safe',
  });
  assert.ok(applied.appliedActions.some((item) => item.action === 'correct_memory'));
  assert.ok(applied.appliedActions.some((item) => item.action === 'reject_memory_candidate'));
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content,
    'The API supports REST and GraphQL.',
  );
  const corrected = app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' });
  assert.deepEqual(corrected.tags, ['api', 'transport']);
  assert.equal(corrected.importance, 6);

  const live = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'PR status on main',
    correction: 'PR #12 is not merged.',
    mode: 'apply_safe',
  });
  assert.ok(live.warnings.some((warning) => warning.code === 'live_state_verification_required'));
  assert.equal(live.appliedActions.length, 0);

  const koreanLive = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    correction: '그 PR 아직 안 머지됐잖아. 이슈 상태랑 원격 브랜치를 확인해야 해.',
    mode: 'apply_safe',
  });
  assert.ok(koreanLive.warnings.some((warning) => warning.code === 'live_state_verification_required'));
  assert.equal(koreanLive.appliedActions.length, 0);
});

test('memory update candidates can be rejected without mutating memory', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const original = app.remember({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    key: 'closeout-rule',
    content: 'Closeout requires local tests.',
    category: 'runbook',
  });
  const store = new ContextForgeStore({ dataDir });
  try {
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-reject-repo',
      action: 'deactivate_memory',
      targetMemoryId: original.id,
      targetMemoryKey: original.key,
      reason: 'Proposed stale rule deactivation.',
      confidence: 0.6,
    });
  } finally {
    store.close();
  }

  const candidates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    status: 'pending',
  });
  assert.equal(candidates.length, 1);
  const rejected = app.rejectMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    candidateId: candidates[0].id,
    reason: 'Keep the runbook active.',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'update-reject-repo', key: 'closeout-rule' }).status,
    'active',
  );

  const storeAgain = new ContextForgeStore({ dataDir });
  try {
    storeAgain.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-reject-repo',
      action: 'add_corrective_note',
      proposedKey: 'closeout-rule-note',
      proposedContent: 'Closeout requirements were reviewed but not changed.',
      reason: 'Optional note.',
    });
  } finally {
    storeAgain.close();
  }
  const skippedCandidate = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    status: 'pending',
  })[0];
  const skipped = app.skipMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    candidateId: skippedCandidate.id,
  });
  assert.equal(skipped.status, 'skipped');
});

test('memory update candidates apply deactivation and duplicate merge actions', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const stale = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'stale-runbook',
    content: 'This runbook is stale.',
    category: 'runbook',
  });
  const canonical = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'canonical-runbook',
    content: 'This runbook is canonical.',
    category: 'runbook',
  });
  const duplicate = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'duplicate-runbook',
    content: 'Duplicate runbook.',
    category: 'runbook',
  });
  const store = new ContextForgeStore({ dataDir });
  try {
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-apply-repo',
      action: 'deactivate_memory',
      targetMemoryId: stale.id,
      targetMemoryKey: stale.key,
      reason: 'Stale after product change.',
    });
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-apply-repo',
      action: 'merge_duplicate_memories',
      targetMemoryId: duplicate.id,
      targetMemoryKey: duplicate.key,
      proposedKey: canonical.key,
      reason: 'Duplicate durable memory.',
    });
  } finally {
    store.close();
  }

  const updates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    status: 'pending',
  });
  const deactivate = updates.find((item) => item.action === 'deactivate_memory');
  const merge = updates.find((item) => item.action === 'merge_duplicate_memories');

  const deactivated = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    candidateId: deactivate.id,
  });
  assert.equal(deactivated.candidate.status, 'applied');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: stale.key }).status, 'inactive');

  const merged = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    candidateId: merge.id,
  });
  assert.equal(merged.candidate.status, 'applied');
  assert.equal(merged.candidate.reviewMetadata.mergedIntoKey, canonical.key);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: duplicate.key }).status, 'inactive');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: canonical.key }).status, 'active');
});

test('reconcileMemory apply_safe rejects matching candidates when no durable memory matches', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_only_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_only_provider: async () => ({
        summaryShort: 'Candidate only checkpoint.',
        summaryText: 'Only a candidate exists for this correction.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'candidate-only',
            content: 'Candidate-only stale claim.',
            category: 'runbook',
            confidence: 0.8,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
    role: 'assistant',
    content: 'Candidate-only stale claim.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
  });

  const result = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
    query: 'candidate-only stale claim',
    correction: 'Candidate-only claim is wrong.',
    mode: 'apply_safe',
  });
  assert.deepEqual(
    result.appliedActions.map((action) => action.action),
    ['reject_memory_candidate'],
  );
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    status: 'rejected',
  });
  assert.equal(candidates.length, 1);
});

test('listScopeKeys returns real scopes from memories, candidates, and distill runs', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scope_keys_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      scope_keys_provider: async () => ({
        summaryShort: 'Scope key checkpoint.',
        summaryText: 'A checkpoint that creates a candidate for scope key discovery.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'scope-key-candidate',
            content: 'Candidate used for scope key discovery.',
            category: 'note',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });

  app.remember({
    scope: 'shared',
    scopeKey: 'team-shared',
    key: 'scope-key-memory',
    content: 'Durable memory used for scope key discovery.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-scope-keys',
    sessionId: 'scope-key-session',
    role: 'user',
    content: 'Create a checkpoint and candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-scope-keys',
    sessionId: 'scope-key-session',
  });

  const allKeys = app.listScopeKeys();
  const repoKey = allKeys.find((item) => item.scopeType === 'repo' && item.scopeKey === 'repo-scope-keys');
  assert.equal(repoKey.candidates, 1);
  assert.equal(repoKey.distillRuns, 1);
  assert.equal(repoKey.rawEvents, 1);
  assert.equal(repoKey.checkpoints, 1);
  const sharedKeys = app.listScopeKeys({ scope: 'shared' });
  assert.deepEqual(
    sharedKeys.map((item) => item.scopeKey),
    ['team-shared'],
  );
  assert.equal(sharedKeys[0].memories, 1);
});

test('REMOTE_METHODS exposes resume, suggestion, auto-promotion, and reconciliation wrappers', () => {
  assert.ok(REMOTE_METHODS.includes('migrateScope'));
  assert.ok(REMOTE_METHODS.includes('syncResumeContext'));
  assert.ok(REMOTE_METHODS.includes('getRuntimeSettings'));
  assert.ok(REMOTE_METHODS.includes('updateRuntimeSettings'));
  assert.ok(REMOTE_METHODS.includes('checkDistillProvider'));
  assert.ok(REMOTE_METHODS.includes('listScopeKeys'));
  assert.ok(REMOTE_METHODS.includes('listRecentDistillRuns'));
  assert.ok(REMOTE_METHODS.includes('listLlmUsageEvents'));
  assert.ok(REMOTE_METHODS.includes('llmUsageRollup'));
  assert.ok(REMOTE_METHODS.includes('listDueDistillSessions'));
  assert.ok(REMOTE_METHODS.includes('processDueDistills'));
  assert.ok(REMOTE_METHODS.includes('listMemories'));
  assert.ok(REMOTE_METHODS.includes('suggestMemoryPromotions'));
  assert.ok(REMOTE_METHODS.includes('auditMemoryCandidates'));
  assert.ok(REMOTE_METHODS.includes('autoPromoteMemoryCandidates'));
  assert.ok(REMOTE_METHODS.includes('reconcileMemory'));
  assert.ok(REMOTE_METHODS.includes('listPreferenceOccurrences'));
  assert.ok(REMOTE_METHODS.includes('listMemoryUpdateCandidates'));
  assert.ok(REMOTE_METHODS.includes('applyMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('rejectMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('skipMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('processEmbeddingJobs'));
  assert.ok(REMOTE_METHODS.includes('listEmbeddingJobs'));
  assert.ok(REMOTE_METHODS.includes('listCheckpoints'));
  assert.ok(REMOTE_METHODS.includes('getSessionWorkingContext'));
  assert.ok(REMOTE_METHODS.includes('upsertSessionWorkingContext'));
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

  const bootstrap = await execFileAsync(
    'node',
    ['src/cli.js', 'bootstrapContext', '--scope', 'repo', '--scopeKey', 'cli-repo', '--query', 'durable previous work'],
    { env },
  );
  assert.match(bootstrap.stdout, /"trust": "reviewed_durable"/);
  assert.match(bootstrap.stdout, /"nextActions":/);

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

  const usage = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'distillUsage',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(usage.stdout, /"estimatedInputTokens":/);
  assert.match(usage.stdout, /"runs": 1/);

  const usageRollup = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'llmUsageRollup',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(usageRollup.stdout, /"byOperation":/);
  assert.match(usageRollup.stdout, /"events":/);

  const usageEvents = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listLlmUsageEvents',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(usageEvents.stdout, /\[/);
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
      'apply_memory_update_candidate',
      'audit_memory_candidates',
      'auto_promote_memory_candidates',
      'begin_session',
      'bootstrap_context',
      'correct_memory',
      'db_info',
      'deactivate_memory',
      'distill_checkpoint',
      'distill_usage',
      'get_memory',
      'get_runtime_settings',
      'get_session_working_context',
      'get_working_summary',
      'list_checkpoints',
      'list_due_consolidations',
      'list_due_distill_sessions',
      'list_embedding_jobs',
      'list_llm_usage_events',
      'list_memory_candidates',
      'list_memory_events',
      'list_memory_update_candidates',
      'list_preference_occurrences',
      'llm_usage_rollup',
      'migrate_scope',
      'process_consolidations',
      'process_due_distills',
      'process_embedding_jobs',
      'promote_memory',
      'promote_memory_candidate',
      'prune_raw_events',
      'rebuild_embeddings',
      'reconcile_memory',
      'reject_memory_candidate',
      'reject_memory_update_candidate',
      'remember',
      'search',
      'session_status',
      'skip_memory_update_candidate',
      'suggest_memory_promotions',
      'sync_resume_context',
      'upsert_session_working_context',
    ]);
    const rememberTool = toolList.tools.find((tool) => tool.name === 'remember');
    assert.ok(rememberTool.inputSchema.properties.repoPath);
    assert.ok(rememberTool.inputSchema.properties.cwd);
    const sessionStatusTool = toolList.tools.find((tool) => tool.name === 'session_status');
    assert.ok(sessionStatusTool.inputSchema.properties.maxEvents);
    assert.ok(sessionStatusTool.inputSchema.properties.maxChars);
    assert.ok(sessionStatusTool.description.includes('latestCheckpointMemoryCandidateCount'));
    const listDueDistillsTool = toolList.tools.find((tool) => tool.name === 'list_due_distill_sessions');
    assert.ok(listDueDistillsTool.inputSchema.properties.scanLimit);
    assert.ok(listDueDistillsTool.inputSchema.properties.idleMs);
    assert.ok(listDueDistillsTool.description.includes('idleMs'));
    const processDueDistillsTool = toolList.tools.find((tool) => tool.name === 'process_due_distills');
    assert.ok(processDueDistillsTool.inputSchema.properties.dryRun);
    assert.ok(processDueDistillsTool.inputSchema.properties.limit);
    assert.ok(processDueDistillsTool.description.includes('catch-up batch'));
    const listDueConsolidationsTool = toolList.tools.find((tool) => tool.name === 'list_due_consolidations');
    assert.ok(listDueConsolidationsTool.inputSchema.properties.target);
    assert.ok(listDueConsolidationsTool.inputSchema.properties.windowKind);
    assert.deepEqual(listDueConsolidationsTool.inputSchema.properties.windowKind.enum, ['daily', 'custom']);
    assert.ok(listDueConsolidationsTool.description.includes('time window'));
    const processConsolidationsTool = toolList.tools.find((tool) => tool.name === 'process_consolidations');
    assert.ok(processConsolidationsTool.inputSchema.properties.dryRun);
    assert.ok(processConsolidationsTool.description.includes('handoff context'));
    const distillTool = toolList.tools.find((tool) => tool.name === 'distill_checkpoint');
    assert.ok(distillTool.inputSchema.properties.maxEvents);
    assert.ok(distillTool.inputSchema.properties.maxChars);
    assert.ok(distillTool.inputSchema.properties.level);
    assert.ok(distillTool.description.includes('memoryCandidateCount'));
    const listCheckpointsTool = toolList.tools.find((tool) => tool.name === 'list_checkpoints');
    assert.ok(listCheckpointsTool.inputSchema.properties.level);
    const distillUsageTool = toolList.tools.find((tool) => tool.name === 'distill_usage');
    assert.ok(distillUsageTool.inputSchema.properties.charsPerToken);
    const llmUsageRollupTool = toolList.tools.find((tool) => tool.name === 'llm_usage_rollup');
    assert.ok(llmUsageRollupTool.inputSchema.properties.operation);
    assert.ok(llmUsageRollupTool.inputSchema.properties.includeEvents);
    const listLlmUsageEventsTool = toolList.tools.find((tool) => tool.name === 'list_llm_usage_events');
    assert.ok(listLlmUsageEventsTool.inputSchema.properties.distillRunId);
    assert.ok(listLlmUsageEventsTool.inputSchema.properties.provider);
    const processEmbeddingJobsTool = toolList.tools.find((tool) => tool.name === 'process_embedding_jobs');
    assert.ok(processEmbeddingJobsTool.inputSchema.properties.retryFailed);
    const listEmbeddingJobsTool = toolList.tools.find((tool) => tool.name === 'list_embedding_jobs');
    assert.ok(listEmbeddingJobsTool.inputSchema.properties.status);
    const bootstrapTool = toolList.tools.find((tool) => tool.name === 'bootstrap_context');
    assert.ok(bootstrapTool.inputSchema.properties.sessionId);
    assert.ok(bootstrapTool.inputSchema.properties.rawTailLimit);
    assert.ok(bootstrapTool.inputSchema.properties.latestCheckpointLimit);
    assert.ok(bootstrapTool.inputSchema.properties.relatedScopeKeys);
    assert.ok(bootstrapTool.description.includes('Does not create a session'));
    assert.ok(bootstrapTool.description.includes('latest checkpoint handoff'));
    const syncResumeTool = toolList.tools.find((tool) => tool.name === 'sync_resume_context');
    assert.ok(syncResumeTool.inputSchema.properties.sessionId);
    const sessionWorkingContextTool = toolList.tools.find((tool) => tool.name === 'upsert_session_working_context');
    assert.ok(sessionWorkingContextTool.inputSchema.properties.currentTask);
    assert.ok(sessionWorkingContextTool.inputSchema.properties.avoidMisreadings);
    const suggestTool = toolList.tools.find((tool) => tool.name === 'suggest_memory_promotions');
    assert.ok(suggestTool.inputSchema.properties.allowScopeFallback);
    assert.ok(suggestTool.inputSchema.properties.trigger);
    assert.ok(suggestTool.description.includes('missing_closeout_source'));
    const preferenceOccurrencesTool = toolList.tools.find((tool) => tool.name === 'list_preference_occurrences');
    assert.ok(preferenceOccurrencesTool.inputSchema.properties.status);
    assert.ok(preferenceOccurrencesTool.inputSchema.properties.limit);
    const updateCandidatesTool = toolList.tools.find((tool) => tool.name === 'list_memory_update_candidates');
    assert.ok(updateCandidatesTool.inputSchema.properties.status);
    assert.ok(updateCandidatesTool.inputSchema.properties.action);
    const listCandidateTool = toolList.tools.find((tool) => tool.name === 'list_memory_candidates');
    assert.ok(listCandidateTool.description.includes('current closeout source'));
    const applyUpdateTool = toolList.tools.find((tool) => tool.name === 'apply_memory_update_candidate');
    assert.ok(applyUpdateTool.inputSchema.properties.candidateId);
    assert.ok(applyUpdateTool.inputSchema.properties.mergeTargetKey);
    const rejectUpdateTool = toolList.tools.find((tool) => tool.name === 'reject_memory_update_candidate');
    assert.ok(rejectUpdateTool.inputSchema.properties.reason);
    const skipUpdateTool = toolList.tools.find((tool) => tool.name === 'skip_memory_update_candidate');
    assert.ok(skipUpdateTool.inputSchema.properties.candidateId);
    const autoPromoteTool = toolList.tools.find((tool) => tool.name === 'auto_promote_memory_candidates');
    assert.ok(autoPromoteTool.inputSchema.properties.dryRun);
    assert.ok(autoPromoteTool.inputSchema.properties.minConfidence);
    assert.ok(autoPromoteTool.inputSchema.properties.allowedCategories);
    assert.ok(autoPromoteTool.description.includes('missing_closeout_source'));
    const auditCandidatesTool = toolList.tools.find((tool) => tool.name === 'audit_memory_candidates');
    assert.ok(auditCandidatesTool.inputSchema.properties.minConfidence);
    assert.ok(auditCandidatesTool.inputSchema.properties.promotionRecommendation);
    assert.ok(auditCandidatesTool.description.includes('never promotes'));
    const promoteTool = toolList.tools.find((tool) => tool.name === 'promote_memory');
    assert.ok(promoteTool.description.includes('sourceCheckpointId'));
    const promoteCandidateTool = toolList.tools.find((tool) => tool.name === 'promote_memory_candidate');
    assert.ok(promoteCandidateTool.description.includes('candidateId'));
    const reconcileTool = toolList.tools.find((tool) => tool.name === 'reconcile_memory');
    assert.ok(reconcileTool.inputSchema.properties.correction);
    assert.ok(!reconcileTool.inputSchema.required?.includes('query'));
    assert.ok(reconcileTool.inputSchema.properties.mode);
    assert.ok(reconcileTool.inputSchema.properties.createUpdateCandidates);
    const appendRawTool = toolList.tools.find((tool) => tool.name === 'append_raw');
    assert.deepEqual(appendRawTool.inputSchema.properties.role.enum, ['user', 'assistant']);

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

    const bootstrapResult = await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        query: 'retrieval demand previous work',
      },
    });
    assert.equal(bootstrapResult.structuredContent.result.scope.scopeKey, 'mcp-repo');
    assert.equal(bootstrapResult.structuredContent.result.results[0].trust, 'reviewed_durable');

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
    const invalidAppendResult = await client.callTool({
      name: 'append_raw',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        role: 'tool_result',
        content: 'tool output stays in the native transcript.',
      },
    });
    assert.equal(invalidAppendResult.isError, true);
    assert.match(invalidAppendResult.content[0].text, /Invalid arguments|tool_result/);

    const zeroRawTailBootstrap = await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        query: 'session status before distilling',
        rawTailLimit: 0,
      },
    });
    assert.equal(zeroRawTailBootstrap.structuredContent.result.rawTailLimit, 0);
    assert.deepEqual(zeroRawTailBootstrap.structuredContent.result.rawTail, []);

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

    const candidateTool = toolList.tools.find((tool) => tool.name === 'promote_memory_candidate');
    assert.ok(candidateTool.inputSchema.properties.candidateId);
    assert.ok(candidateTool.inputSchema.properties.checkpointId);
    assert.ok(candidateTool.inputSchema.properties.sourceCandidateIndex);
    assert.ok(toolList.tools.some((tool) => tool.name === 'reject_memory_candidate'));
  } finally {
    await client.close();
  }
});

test('MCP streamable HTTP endpoint exposes core tools with bearer auth', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'HTTP MCP candidate checkpoint.',
        summaryText: 'The checkpoint contains one reviewed memory candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'http-mcp-candidate',
            content: 'HTTP MCP can promote memory candidates by checkpoint id.',
            reason: 'Synthetic HTTP MCP candidate.',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });
  const remote = await startContextForgeServer({
    app,
    port: 0,
    env: {
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

    const infoResult = await client.callTool({ name: 'db_info', arguments: {} });
    assert.equal(infoResult.structuredContent.result.connection.mode, 'remote-client');
    assert.equal(infoResult.structuredContent.result.connection.accessMode, 'remote-client');
    assert.equal(infoResult.structuredContent.result.connection.accessPath, 'http-mcp');
    assert.equal(infoResult.structuredContent.result.connection.transport, 'http-mcp');
    assert.equal(infoResult.structuredContent.result.connection.serverRole, 'local-process');
    assert.equal(infoResult.structuredContent.result.connection.summary, 'remote-client over http-mcp to local-process');
    assert.equal(infoResult.structuredContent.result.connection.server.mode, 'direct-local');

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

    const bootstrap = await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        query: 'canonical remote',
      },
    });
    assert.equal(bootstrap.structuredContent.result.storage.connection.mode, 'remote-client');
    assert.equal(bootstrap.structuredContent.result.storage.connection.accessMode, 'remote-client');
    assert.equal(bootstrap.structuredContent.result.storage.connection.accessPath, 'http-mcp');
    assert.equal(bootstrap.structuredContent.result.storage.connection.transport, 'http-mcp');
    assert.equal(bootstrap.structuredContent.result.storage.connection.serverRole, 'local-process');
    assert.equal(bootstrap.structuredContent.result.storage.connection.server.mode, 'direct-local');

    const syncResume = await client.callTool({
      name: 'sync_resume_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        query: 'canonical remote previous work',
      },
    });
    assert.equal(syncResume.structuredContent.result.storage.connection.mode, 'remote-client');
    assert.equal(syncResume.structuredContent.result.storage.connection.accessMode, 'remote-client');
    assert.equal(syncResume.structuredContent.result.storage.connection.accessPath, 'http-mcp');
    assert.equal(syncResume.structuredContent.result.storage.connection.transport, 'http-mcp');
    assert.equal(syncResume.structuredContent.result.storage.connection.serverRole, 'local-process');
    assert.equal(syncResume.structuredContent.result.storage.connection.server.mode, 'direct-local');

    await client.callTool({
      name: 'append_raw',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        sessionId: 'http-mcp-session',
        role: 'assistant',
        content: 'Candidate: HTTP MCP can promote memory candidates by checkpoint id.',
      },
    });
    const checkpoint = await client.callTool({
      name: 'distill_checkpoint',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        sessionId: 'http-mcp-session',
      },
    });
    const promoted = await client.callTool({
      name: 'promote_memory_candidate',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        checkpointId: checkpoint.structuredContent.result.id,
        sourceCandidateIndex: 0,
        reason: 'Reviewed over HTTP MCP.',
      },
    });
    assert.equal(promoted.structuredContent.result.key, 'http-mcp-candidate');
  } finally {
    await client.close();
    await remote.close();
    app.close();
  }
});

test('MCP streamable HTTP db_info reports remote-client for HTTP callers', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const client = new Client({ name: 'contextforge-http-dbinfo-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: {
      headers: {
        authorization: 'Bearer test-token',
      },
    },
  });

  try {
    await client.connect(transport);
    const info = await client.callTool({ name: 'db_info', arguments: {} });
    assert.equal(info.structuredContent.result.connection.mode, 'remote-client');
    assert.equal(info.structuredContent.result.connection.accessMode, 'remote-client');
    assert.equal(info.structuredContent.result.connection.accessPath, 'http-mcp');
    assert.equal(info.structuredContent.result.connection.transport, 'http-mcp');
    assert.equal(info.structuredContent.result.connection.serverRole, 'http-server');
    assert.equal(info.structuredContent.result.connection.summary, 'remote-client over http-mcp to http-server');
    assert.equal(info.structuredContent.result.connection.server.mode, 'http-server');
    assert.equal(info.structuredContent.result.connection.server.accessMode, 'server-process');
    assert.equal(info.structuredContent.result.connection.server.accessPath, 'in-process');
    assert.equal(info.structuredContent.result.connection.server.serverRole, 'http-server');
    assert.equal(info.structuredContent.result.connection.server.summary, 'in-process http-server');
    assert.equal(info.structuredContent.result.connection.server.storageMode, 'project-local');
  } finally {
    await client.close();
    await remote.close();
  }
});

test('HTTP v0 callers see remote-client connection metadata', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const response = await fetch(`${remote.url}/v0/dbInfo`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.connection.mode, 'remote-client');
    assert.equal(body.result.connection.accessMode, 'remote-client');
    assert.equal(body.result.connection.accessPath, 'http-api');
    assert.equal(body.result.connection.transport, 'http-api');
    assert.equal(body.result.connection.serverRole, 'http-server');
    assert.equal(body.result.connection.summary, 'remote-client over http-api to http-server');
    assert.equal(body.result.connection.server.mode, 'http-server');
    assert.equal(body.result.connection.server.accessMode, 'server-process');
    assert.equal(body.result.connection.server.accessPath, 'in-process');
    assert.equal(body.result.connection.server.serverRole, 'http-server');
    assert.equal(body.result.connection.server.summary, 'in-process http-server');
    assert.equal(body.result.connection.server.storageMode, 'project-local');

    const resumeResponse = await fetch(`${remote.url}/v0/syncResumeContext`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: 'repo',
        scopeKey: 'http-api-repo',
        query: 'previous work',
      }),
    });
    assert.equal(resumeResponse.status, 200);
    const resumeBody = await resumeResponse.json();
    assert.equal(resumeBody.result.storage.connection.mode, 'remote-client');
    assert.equal(resumeBody.result.storage.connection.accessMode, 'remote-client');
    assert.equal(resumeBody.result.storage.connection.accessPath, 'http-api');
    assert.equal(resumeBody.result.storage.connection.transport, 'http-api');
    assert.equal(resumeBody.result.storage.connection.serverRole, 'http-server');
    assert.equal(resumeBody.result.storage.connection.server.mode, 'http-server');
  } finally {
    await remote.close();
  }
});

test('HTTP server serves admin UI assets', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const redirect = await fetch(`${remote.url}/ui`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/ui/');

    const redirectWithQuery = await fetch(`${remote.url}/ui?tab=memory`, { redirect: 'manual' });
    assert.equal(redirectWithQuery.status, 308);
    assert.equal(redirectWithQuery.headers.get('location'), '/ui/?tab=memory');

    const response = await fetch(`${remote.url}/ui/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /ContextForge 관리/);
    assert.match(html, /후보 검토/);
    assert.match(html, /candidateSession/);
    assert.match(html, /감사 후보 불러오기/);

    const script = await fetch(`${remote.url}/ui/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /text\/javascript/);
    const scriptText = await script.text();
    assert.match(scriptText, /auditMemoryCandidates/);
    assert.match(scriptText, /GPT 감사 후보/);
    assert.match(scriptText, /구조화 디스틸/);
    assert.match(scriptText, /structured 있음/);

    const stylesheet = await fetch(`${remote.url}/ui/styles.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);

    const favicon = await fetch(`${remote.url}/favicon.ico`);
    assert.equal(favicon.status, 204);
  } finally {
    await remote.close();
  }
});

test('HTTP server accepts admin UI login sessions', async () => {
  const dataDir = await makeTempDir();
  const password = 'hu23bc' + 'CONTEXT!';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /contextforge_admin=/);
    assert.doesNotMatch(cookie, /;\s*Secure\b/);
    const session = await fetch(`${remote.url}/ui/session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await session.json(), { ok: true, username: 'ginishuh' });
    const info = await fetch(`${remote.url}/v0/dbInfo`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(info.status, 200);
  } finally {
    await remote.close();
  }
});

test('HTTP server auto-secures admin UI cookies behind HTTPS reverse proxies', async () => {
  const dataDir = await makeTempDir();
  const password = 'proxy-cookie-CON' + 'TEXT';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /;\s*Secure\b/);
  } finally {
    await remote.close();
  }
});

test('HTTP server can force secure admin UI cookies for HTTPS deployments', async () => {
  const dataDir = await makeTempDir();
  const password = 'secure-cookie-CON' + 'TEXT';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
      CONTEXTFORGE_ADMIN_COOKIE_SECURE: 'true',
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /;\s*Secure\b/);
  } finally {
    await remote.close();
  }
});

test('HTTP server rejects invalid admin cookie secure mode', async () => {
  const dataDir = await makeTempDir();
  assert.throws(
    () =>
      startContextForgeServer({
        port: 0,
        env: {
          CONTEXTFORGE_DATA_DIR: dataDir,
          CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
          CONTEXTFORGE_ADMIN_COOKIE_SECURE: 'sometimes',
        },
      }),
    /CONTEXTFORGE_ADMIN_COOKIE_SECURE/,
  );
});

test('HTTP server keeps admin UI login disabled unless credentials are configured', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password: 'anything' }),
    });
    assert.equal(login.status, 403);
  } finally {
    await remote.close();
  }
});

test('HTTP server rate limits repeated admin UI login failures', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash('correct-password'),
      CONTEXTFORGE_ADMIN_COOKIE_SECURE: 'false',
      CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES: '2',
      CONTEXTFORGE_ADMIN_LOGIN_WINDOW_MS: '60000',
    },
  });

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const login = await fetch(`${remote.url}/ui/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
      });
      assert.equal(login.status, 401);
    }

    const limited = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
    });
    assert.equal(limited.status, 429);
  } finally {
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

    const bootstrap = await app.bootstrapContext({
      scope: 'repo',
      scopeKey: 'repo-remote',
      query: 'remote shared scope previous work',
      includeShared: true,
    });
    assert.equal(bootstrap.scope.scopeKey, 'repo-remote');
    assert.equal(bootstrap.connection.mode, 'remote-client');
    assert.equal(bootstrap.connection.accessMode, 'remote-client');
    assert.equal(bootstrap.connection.accessPath, 'http-api');
    assert.equal(bootstrap.connection.serverRole, 'http-server');
    assert.equal(bootstrap.storage.mode, 'remote');
    assert.equal(bootstrap.storage.authority, 'canonical');
    assert.equal(bootstrap.storage.serverMode, 'project-local');
    assert.ok(bootstrap.results.some((item) => item.group === 'primary' && item.key === 'storage-mode'));
    assert.ok(bootstrap.results.some((item) => item.group === 'shared' && item.key === 'storage-mode'));

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
    assert.equal(info.connection.mode, 'remote-client');
    assert.equal(info.connection.accessMode, 'remote-client');
    assert.equal(info.connection.accessPath, 'http-api');
    assert.equal(info.connection.serverRole, 'http-server');
    assert.equal(info.connection.clientStorageMode, 'remote');
    assert.equal(info.connection.summary, 'remote-client over http-api to http-server');
    assert.equal(info.connection.server.mode, 'http-server');
    assert.equal(info.connection.server.storageMode, 'project-local');
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
  const postedBodies = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
    cwd: appCwd,
    fetchImpl: async (url, request) => {
      const postedBody = JSON.parse(request.body);
      postedBodies.push({ method: new URL(url).pathname.split('/').at(-1), body: postedBody });
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
  assert.equal(postedBodies[0].body.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBodies[0].body.repoPath, undefined);
  assert.equal(postedBodies[0].body.cwd, undefined);

  await app.listDueDistillSessions({
    scope: 'repo',
    repoPath,
    cwd: appCwd,
    limit: 1,
  });
  assert.equal(postedBodies[1].method, 'listDueDistillSessions');
  assert.equal(postedBodies[1].body.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBodies[1].body.repoPath, undefined);
  assert.equal(postedBodies[1].body.cwd, undefined);

  await app.listDueDistillSessions({ limit: 2 });
  assert.equal(postedBodies[2].method, 'listDueDistillSessions');
  assert.equal(postedBodies[2].body.scopeKey, undefined);
  assert.equal(postedBodies[2].body.scope, undefined);
  assert.equal(postedBodies[2].body.limit, 2);
});

test('remote storage mode preserves structured error names and warnings', async () => {
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
    cwd: process.cwd(),
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({
          error: {
            name: 'MemoryCandidatePromotionWarningError',
            message: 'Memory candidate promotion has 1 warning(s).',
            warnings: [{ code: 'duplicate_key' }],
          },
        }),
    }),
  });

  await assert.rejects(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'remote-warning-repo',
        candidateId: 'candidate-id',
      }),
    (error) => {
      assert.equal(error.name, 'MemoryCandidatePromotionWarningError');
      assert.equal(error.warnings[0].code, 'duplicate_key');
      return true;
    },
  );
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
