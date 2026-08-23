import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { startContextForgeServer } from '../src/server.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

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

  const checkpointPage = app.listCheckpoints({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    limit: 1,
    page: true,
  });
  assert.equal(checkpointPage.kind, 'checkpoints_page');
  assert.equal(checkpointPage.items[0].id, checkpoint.id);
  assert.equal(checkpointPage.page.nextCursor, null);

  const distillRunPage = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-a',
    sessionId: session.sessionId,
    limit: 1,
    page: true,
  });
  assert.equal(distillRunPage.kind, 'distill_runs_page');
  assert.equal(distillRunPage.items[0].id, runs[0].id);

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

test('public list pagination is bounded, stable across timestamp ties, and filter-bound', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const scopeType = 'repo';
  const scopeKey = 'pagination-repo';
  const timestamp = '2026-07-10T00:00:00.000Z';
  try {
    store.withTransaction(() => {
      for (let index = 0; index < 505; index += 1) {
        const sessionId = index < 5 ? 'small-session' : 'large-session';
        const event = store.appendRawEvent({
          scopeType,
          scopeKey,
          sessionId,
          role: 'user',
          content: `Pagination event ${index}`,
        });
        store.db
          .prepare('UPDATE raw_events SET id = ?, created_at = ? WHERE id = ?')
          .run(`raw-${String(index).padStart(4, '0')}`, timestamp, event.id);
      }
      for (let index = 0; index < 3; index += 1) {
        const run = store.startDistillRun({
          scopeType,
          scopeKey,
          sessionId: 'pagination-runs',
          provider: 'mock',
        });
        store.db
          .prepare('UPDATE distill_runs SET id = ?, created_at = ? WHERE id = ?')
          .run(`run-${String(index).padStart(4, '0')}`, timestamp, run.id);
      }
    });
  } finally {
    store.close();
  }

  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  try {
    for (const key of ['memory-a', 'memory-b', 'memory-c']) {
      app.remember({ scope: 'repo', scopeKey, key, content: `Pagination ${key}`, importance: 1 });
    }
    const memoryStore = new ContextForgeStore({ dataDir });
    try {
      memoryStore.db
        .prepare('UPDATE memories SET updated_at = ? WHERE scope_type = ? AND scope_key = ?')
        .run(timestamp, scopeType, scopeKey);
    } finally {
      memoryStore.close();
    }
    const memoryFirst = app.listMemories({ scope: 'repo', scopeKey, limit: 2, page: true });
    assert.deepEqual(memoryFirst.items.map((item) => item.key), ['memory-a', 'memory-b']);
    const memorySecond = app.listMemories({
      scope: 'repo',
      scopeKey,
      limit: 2,
      cursor: memoryFirst.page.nextCursor,
    });
    assert.deepEqual(memorySecond.items.map((item) => item.key), ['memory-c']);

    const runFirst = app.listDistillRuns({
      scope: 'repo',
      scopeKey,
      sessionId: 'pagination-runs',
      order: 'desc',
      limit: 2,
      page: true,
    });
    assert.deepEqual(runFirst.items.map((item) => item.id), ['run-0002', 'run-0001']);
    const runSecond = app.listDistillRuns({
      scope: 'repo',
      scopeKey,
      sessionId: 'pagination-runs',
      order: 'desc',
      limit: 2,
      cursor: runFirst.page.nextCursor,
    });
    assert.deepEqual(runSecond.items.map((item) => item.id), ['run-0000']);
    assert.throws(
      () =>
        app.listDistillRuns({
          scope: 'repo',
          scopeKey,
          sessionId: 'pagination-runs',
          order: 'asc',
          cursor: runFirst.page.nextCursor,
        }),
      /cursor does not match this list operation or filter set/i,
    );

    const bounded = app.listRawEvents({ scope: 'repo', scopeKey, sessionId: 'large-session' });
    assert.equal(bounded.length, 100);
    const hardCapped = app.listRawEvents({ scope: 'repo', scopeKey, sessionId: 'large-session', limit: 1000 });
    assert.equal(hardCapped.length, 500);

    const first = app.listRawEvents({
      scope: 'repo',
      scopeKey,
      sessionId: 'small-session',
      limit: 2,
      page: true,
    });
    assert.deepEqual(first.items.map((item) => item.id), ['raw-0000', 'raw-0001']);
    assert.equal(first.page.hasMore, true);
    assert.ok(first.page.nextCursor);
    assert.ok(!first.page.nextCursor.includes('raw-0001'));

    const insertStore = new ContextForgeStore({ dataDir });
    try {
      insertStore.db
        .prepare(`
          INSERT INTO raw_events (
            id, scope_type, scope_key, session_id, role, content, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'user', 'Inserted before cursor', '{}', ?)
        `)
        .run('raw-0000-new', scopeType, scopeKey, 'small-session', timestamp);
    } finally {
      insertStore.close();
    }

    const second = app.listRawEvents({
      scope: 'repo',
      scopeKey,
      sessionId: 'small-session',
      limit: 2,
      cursor: first.page.nextCursor,
    });
    assert.deepEqual(second.items.map((item) => item.id), ['raw-0002', 'raw-0003']);
    const third = app.listRawEvents({
      scope: 'repo',
      scopeKey,
      sessionId: 'small-session',
      limit: 2,
      cursor: second.page.nextCursor,
    });
    assert.deepEqual(third.items.map((item) => item.id), ['raw-0004']);
    assert.equal(third.page.nextCursor, null);

    assert.throws(
      () =>
        app.listRawEvents({
          scope: 'repo',
          scopeKey,
          sessionId: 'other-session',
          cursor: first.page.nextCursor,
        }),
      /cursor does not match this list operation or filter set/i,
    );
    assert.throws(
      () => app.listRawEvents({ scope: 'repo', scopeKey, sessionId: 'small-session', cursor: 'not-a-cursor' }),
      /Invalid pagination cursor encoding/,
    );
    const malformedPosition = JSON.parse(Buffer.from(first.page.nextCursor, 'base64url').toString('utf8'));
    malformedPosition.position = [timestamp];
    assert.throws(
      () =>
        app.listRawEvents({
          scope: 'repo',
          scopeKey,
          sessionId: 'small-session',
          cursor: Buffer.from(JSON.stringify(malformedPosition)).toString('base64url'),
        }),
      /Pagination cursor position is invalid/,
    );

    const remote = await startContextForgeServer({
      app,
      port: 0,
      env: { CONTEXTFORGE_REMOTE_TOKEN: 'pagination-token' },
    });
    const remoteClient = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'pagination-token',
      },
      cwd: process.cwd(),
    });
    try {
      const remoteFirst = await remoteClient.listRawEvents({
        scope: 'repo',
        scopeKey,
        sessionId: 'small-session',
        limit: 2,
        page: true,
      });
      assert.deepEqual(remoteFirst.items.map((item) => item.id), ['raw-0000', 'raw-0000-new']);
      assert.equal(remoteFirst.page.limit, first.page.limit);
      assert.ok(remoteFirst.page.nextCursor);
    } finally {
      remoteClient.close?.();
      await remote.close();
    }

    for (let index = 0; index < 12; index += 1) {
      app.remember({
        scope: 'repo',
        scopeKey,
        key: `memory-extra-${String(index).padStart(2, '0')}`,
        content: 'Pageable CLI lists use the core default instead of the legacy global CLI limit.',
      });
      app.remember({
        scope: 'repo',
        scopeKey: `pagination-scope-${String(index).padStart(2, '0')}`,
        key: 'scope-marker',
        content: 'Non-pageable CLI commands retain the legacy default limit of ten.',
      });
    }
    const cliMemories = JSON.parse(
      (
        await execFileAsync(
          'node',
          ['src/cli.js', 'listMemories', '--scope', 'repo', '--scopeKey', scopeKey],
          { env: { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir } },
        )
      ).stdout,
    );
    assert.equal(cliMemories.length, 15);
    const cliScopeKeys = JSON.parse(
      (
        await execFileAsync('node', ['src/cli.js', 'listScopeKeys', '--scope', 'repo'], {
          env: { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir },
        })
      ).stdout,
    );
    assert.equal(cliScopeKeys.length, 10);

    const cliAllPages = JSON.parse(
      (
        await execFileAsync(
          'node',
          [
            'src/cli.js',
            'listRawEvents',
            '--scope',
            'repo',
            '--scopeKey',
            scopeKey,
            '--sessionId',
            'small-session',
            '--limit',
            '2',
            '--allPages',
            'true',
          ],
          { env: { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir } },
        )
      ).stdout,
    );
    assert.equal(cliAllPages.kind, 'listRawEvents_all_pages');
    assert.equal(cliAllPages.pages, 3);
    assert.deepEqual(
      cliAllPages.items.map((item) => item.id),
      ['raw-0000', 'raw-0000-new', 'raw-0001', 'raw-0002', 'raw-0003', 'raw-0004'],
    );
  } finally {
    app.close();
  }
});

test('checkpoint latest, recent, and paged lists share insertion-order tie-breaking', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const scopeType = 'repo';
  const scopeKey = 'checkpoint-order-repo';
  const sessionId = 'checkpoint-order-session';
  const timestamp = '2026-07-10T00:00:00.000Z';
  const ids = ['checkpoint-z', 'checkpoint-a', 'checkpoint-m'];
  try {
    ids.forEach((id, index) => {
      const checkpoint = store.insertCheckpoint({
        scopeType,
        scopeKey,
        sessionId,
        summaryShort: `Checkpoint ${index}`,
        summaryText: `Checkpoint insertion ${index}`,
        provider: 'mock',
      });
      store.db
        .prepare('UPDATE checkpoints SET id = ?, created_at = ? WHERE id = ?')
        .run(id, timestamp, checkpoint.id);
    });

    assert.equal(store.getLatestCheckpoint({ scopeType, scopeKey, sessionId }).id, 'checkpoint-m');
    assert.deepEqual(
      store.listRecentCheckpoints({ scopeType, scopeKey, limit: 3 }).map((item) => item.id),
      ['checkpoint-m', 'checkpoint-a', 'checkpoint-z'],
    );
  } finally {
    store.close();
  }

  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  try {
    const first = app.listCheckpoints({ scope: 'repo', scopeKey, sessionId, limit: 2, page: true });
    assert.deepEqual(first.items.map((item) => item.id), ['checkpoint-m', 'checkpoint-a']);
    assert.equal(JSON.stringify(first.items).includes('_storageSequence'), false);
    const second = app.listCheckpoints({
      scope: 'repo',
      scopeKey,
      sessionId,
      limit: 2,
      cursor: first.page.nextCursor,
    });
    assert.deepEqual(second.items.map((item) => item.id), ['checkpoint-z']);
    assert.equal(second.page.nextCursor, null);
  } finally {
    app.close?.();
  }
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
  store.db
    .prepare(`
      UPDATE checkpoints
      SET created_at = ?
      WHERE scope_type = ? AND scope_key = ? AND session_id = ?
    `)
    .run('2026-05-08T00:00:00.000Z', 'repo', 'repo-level', 'level-session');
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
