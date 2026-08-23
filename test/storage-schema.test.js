import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import {
  ContextForgeStore,
  SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_JOURNAL_MODE,
  SQLITE_SYNCHRONOUS,
} from '../src/storage/sqlite.js';
import {
  PRIVATE_DATA_DIRECTORY_MODE,
  PRIVATE_DATA_FILE_MODE,
  SQLITE_PRIVATE_FILE_SUFFIXES,
  secureDataDirectoryPermissions,
} from '../src/storage/permissions.js';

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
  assert.equal(info.permissions.enforced, process.platform !== 'win32');
  assert.equal(
    info.permissions.reason,
    process.platform === 'win32' ? 'windows_acl_inherited' : 'posix_mode_enforced',
  );
});

test('data directory and SQLite files use private POSIX modes despite a loose umask', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows uses inherited ACLs instead of POSIX mode enforcement.');
    return;
  }
  const dataDir = await makeTempDir();
  const dbPath = path.join(dataDir, 'contextforge.db');
  const previousUmask = process.umask(0);
  try {
    await fs.chmod(dataDir, 0o777);
    secureDataDirectoryPermissions(dataDir);
    await fs.chmod(dbPath, 0o666);
    await fs.writeFile(`${dbPath}-journal`, 'synthetic', { mode: 0o666 });
    await fs.writeFile(`${dbPath}-wal`, 'synthetic', { mode: 0o666 });
    await fs.writeFile(`${dbPath}-shm`, 'synthetic', { mode: 0o666 });
    secureDataDirectoryPermissions(dataDir);

    assert.equal((await fs.stat(dataDir)).mode & 0o777, PRIVATE_DATA_DIRECTORY_MODE);
    for (const suffix of SQLITE_PRIVATE_FILE_SUFFIXES) {
      const filePath = `${dbPath}${suffix}`;
      assert.equal((await fs.stat(filePath)).mode & 0o777, PRIVATE_DATA_FILE_MODE);
    }

    await fs.unlink(`${dbPath}-journal`);
    await fs.unlink(`${dbPath}-wal`);
    await fs.unlink(`${dbPath}-shm`);
    const store = new ContextForgeStore({ dataDir });
    assert.equal((await fs.stat(store.dbPath)).mode & 0o777, PRIVATE_DATA_FILE_MODE);
    store.close();
  } finally {
    process.umask(previousUmask);
  }
});

test('Windows storage permission status reports inherited ACL semantics', async () => {
  const dataDir = await makeTempDir();
  const result = secureDataDirectoryPermissions(dataDir, { platform: 'win32' });

  assert.equal(result.enforced, false);
  assert.equal(result.reason, 'windows_acl_inherited');
  assert.equal(result.dbPath, path.join(dataDir, 'contextforge.db'));
});

test('ContextForgeStore refuses a newer schema before modifying the database', async () => {
  const dataDir = await makeTempDir();
  const dbPath = path.join(dataDir, 'contextforge.db');
  const futureVersion = SCHEMA_VERSION + 1;
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE future_sentinel (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', String(futureVersion));
    db.prepare('INSERT INTO future_sentinel (value) VALUES (?)').run('preserve-me');
  } finally {
    db.close();
  }
  const before = await fs.readFile(dbPath);

  assert.throws(
    () => new ContextForgeStore({ dataDir }),
    (error) => {
      assert.equal(error.name, 'UnsupportedSchemaVersionError');
      assert.equal(error.code, 'CONTEXTFORGE_SCHEMA_TOO_NEW');
      assert.equal(error.existingSchemaVersion, futureVersion);
      assert.equal(error.supportedSchemaVersion, SCHEMA_VERSION);
      assert.match(error.message, new RegExp(`schema version ${futureVersion} is newer than supported version ${SCHEMA_VERSION}`));
      assert.match(error.message, /database was not modified/);
      return true;
    },
  );

  const after = await fs.readFile(dbPath);
  assert.deepEqual(after, before);

  const verificationDb = new Database(dbPath);
  try {
    assert.equal(
      verificationDb.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value,
      String(futureVersion),
    );
    assert.equal(verificationDb.prepare('SELECT value FROM future_sentinel').get().value, 'preserve-me');
    assert.deepEqual(
      verificationDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
        .all()
        .map((row) => row.name),
      ['future_sentinel', 'schema_meta'],
    );
  } finally {
    verificationDb.close();
  }
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

test('readiness reports SQLite policy, disk threshold, and queue backlog without exposing credentials', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_READINESS_MAX_QUEUED_JOBS: '1',
    },
    cwd: process.cwd(),
  });
  for (const sessionId of ['readiness-one', 'readiness-two']) {
    app.appendRaw({
      scope: 'repo',
      scopeKey: 'readiness-repo',
      sessionId,
      role: 'assistant',
      content: `Queued readiness fixture ${sessionId}.`,
    });
    app.submitDistillJob({ scope: 'repo', scopeKey: 'readiness-repo', sessionId });
  }

  const readiness = app.readiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.database.ok, true);
  assert.equal(readiness.checks.operationQueue.queued, 2);
  assert.equal(readiness.checks.operationQueue.maximumQueued, 1);
  assert.equal(readiness.sqlite.journalMode, SQLITE_JOURNAL_MODE);
  assert.equal(readiness.sqlite.synchronous, SQLITE_SYNCHRONOUS);
  assert.equal(readiness.sqlite.busyTimeoutMs, SQLITE_BUSY_TIMEOUT_MS);
  assert.ok(!JSON.stringify(readiness).includes('apiKey'));

  const metrics = app.operationalMetrics();
  assert.equal(metrics.queues.operationJobs.queued, 2);
  assert.ok(metrics.queues.oldestQueuedWaitMs >= 0);
  assert.equal(metrics.database.sqlite.foreignKeys, true);
});

test('readiness reports stale embedding coverage without evicting a recoverable instance', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
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
    embeddingProviders: { openai: provider },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'readiness-embedding-repo',
    key: 'pending-embedding',
    content: 'A queued embedding is recoverable backlog.',
  });

  const readiness = app.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.checks.embeddings.ok, true);
  assert.equal(readiness.checks.embeddings.degraded, true);
  assert.equal(readiness.checks.embeddings.pending, 1);
  assert.equal(readiness.checks.embeddings.staleSources, 1);
});

test('schema migration creates a private pre-migration backup before mutating the database', async () => {
  const dataDir = await makeTempDir();
  const initial = new ContextForgeStore({ dataDir });
  initial.close();
  const dbPath = path.join(dataDir, 'contextforge.db');
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
  } finally {
    db.close();
  }

  const migrated = new ContextForgeStore({ dataDir });
  try {
    assert.equal(migrated.migrationBackup.fromSchemaVersion, SCHEMA_VERSION - 1);
    assert.equal(migrated.migrationBackup.toSchemaVersion, SCHEMA_VERSION);
    assert.equal((await fs.stat(migrated.migrationBackup.file)).mode & 0o777, PRIVATE_DATA_FILE_MODE);
    const backup = new Database(migrated.migrationBackup.file, { readonly: true });
    try {
      assert.equal(
        backup.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value,
        String(SCHEMA_VERSION - 1),
      );
    } finally {
      backup.close();
    }
  } finally {
    migrated.close();
  }
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
