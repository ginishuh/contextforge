import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createContextForge } from '../src/core.js';

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-test-'));
}

test('dbInfo initializes a fresh SQLite store', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const info = app.dbInfo();

  assert.equal(info.schemaVersion, 1);
  assert.equal(info.tables.memories, 0);
  assert.match(info.dbPath, /contextforge\.db$/);
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

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
  });

  assert.equal(checkpoint.provider, 'mock');
  assert.equal(checkpoint.sourceEventCount, 2);
  assert.equal(checkpoint.decisions.length, 1);
  assert.equal(checkpoint.todos.length, 1);

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 2);
  assert.equal(info.tables.checkpoints, 1);
});

test('CLI supports the v0 workflow with synthetic data', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const dbInfo = await execFileAsync('node', ['src/cli.js', 'dbInfo'], { env });
  assert.match(dbInfo.stdout, /"schemaVersion": 1/);

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
});

test('runtime database artifacts are ignored by git rules', async () => {
  const gitignore = await fs.readFile('.gitignore', 'utf8');
  assert.match(gitignore, /^\.contextforge\/$/m);
  assert.match(gitignore, /^\*\.db$/m);
  assert.match(gitignore, /^\*\.db-wal$/m);
  assert.match(gitignore, /^\*\.db-shm$/m);
});
