import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import Database from 'better-sqlite3';
import { createContextForge } from '../src/core.js';
import {
  STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
  validateDistillOutput,
} from '../src/distill/validate.js';
import { ProviderTimeoutError } from '../src/runtime/provider_execution.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

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

test('raw event TTL pruning deletes only checkpoint-covered evidence and preserves the latest tail', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
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
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
    role: 'assistant',
    content: 'old raw tail after checkpoint',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare("UPDATE raw_events SET created_at = ? WHERE content IN (?, ?)").run(
      '2026-01-01T00:00:00.000Z',
      'old raw evidence',
      'old raw tail after checkpoint',
    );
  } finally {
    db.close();
  }

  const dryRun = app.pruneRawEvents({ dryRun: true });
  assert.equal(dryRun.deletedRawEvents, 0);
  assert.equal(dryRun.candidateRawEvents, 2);
  assert.equal(dryRun.eligibleRawEvents, 1);
  assert.equal(dryRun.blockedRawEvents, 1);
  assert.equal(dryRun.sessions[0].status, 'eligible');
  assert.equal(dryRun.sessions[0].reason, 'covered_by_successful_level_zero_checkpoint');
  assert.equal(dryRun.sessions[0].latestCheckpointId, checkpoint.id);

  const result = app.pruneRawEvents();
  assert.equal(result.ttlDays, 7);
  assert.equal(result.deletedRawEvents, 1);
  assert.equal(result.eligibleRawEvents, 1);
  assert.equal(result.blockedRawEvents, 1);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
  });
  assert.deepEqual(
    events.map((event) => event.content).sort(),
    ['fresh raw evidence', 'old raw tail after checkpoint'].sort(),
  );
  app.close();
});

test('raw event TTL pruning blocks sessions without a checkpoint unless force is explicit', async () => {
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
    scopeKey: 'repo-ttl-uncovered',
    sessionId: 'session-ttl-uncovered',
    role: 'user',
    content: 'undistilled old evidence',
  });
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'undistilled old evidence',
    );
  } finally {
    db.close();
  }

  const blocked = app.pruneRawEvents({ dryRun: true });
  assert.equal(blocked.eligibleRawEvents, 0);
  assert.equal(blocked.blockedRawEvents, 1);
  assert.equal(blocked.sessions[0].status, 'blocked');
  assert.equal(blocked.sessions[0].reason, 'no_level_zero_checkpoint');
  assert.equal(app.pruneRawEvents().deletedRawEvents, 0);

  const forced = app.pruneRawEvents({ dryRun: true, force: true });
  assert.equal(forced.eligibleRawEvents, 1);
  assert.equal(forced.sessions[0].reason, 'force_age_only');
  assert.equal(app.pruneRawEvents({ force: true }).deletedRawEvents, 1);
  app.close();
});

test('raw event TTL pruning blocks previously covered evidence after the latest distill fails', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
    distillProviders: {
      failing_prune_provider: async () => {
        throw new Error('synthetic prune provider failure');
      },
    },
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-failed',
    sessionId: 'session-ttl-failed',
  };
  app.appendRaw({ ...scope, role: 'user', content: 'covered evidence before failure' });
  await app.distillCheckpoint(scope);
  app.appendRaw({ ...scope, role: 'assistant', content: 'evidence selected by failed distill' });
  await assert.rejects(
    () => app.distillCheckpoint({ ...scope, provider: 'failing_prune_provider' }),
    /synthetic prune provider failure/,
  );

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'covered evidence before failure',
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents({ dryRun: true });
  assert.equal(result.eligibleRawEvents, 0);
  assert.equal(result.blockedRawEvents, 1);
  assert.equal(result.sessions[0].status, 'blocked');
  assert.equal(result.sessions[0].reason, 'latest_distill_failed');
  assert.equal(result.sessions[0].latestDistillRunStatus, 'failed');
  assert.equal(app.pruneRawEvents().deletedRawEvents, 0);
  app.close();
});

test('raw event TTL pruning blocks covered evidence while the latest distill is incomplete', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-incomplete',
    sessionId: 'session-ttl-incomplete',
  };
  app.appendRaw({ ...scope, role: 'user', content: 'covered evidence before incomplete run' });
  await app.distillCheckpoint(scope);

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'covered evidence before incomplete run',
    );
    db.prepare(`
      INSERT INTO distill_runs (
        id, scope_type, scope_key, session_id, provider, status,
        source_event_count, input_metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, 'started', 0, '{}', ?)
    `).run(
      'incomplete-prune-run',
      'repo',
      'repo-ttl-incomplete',
      'session-ttl-incomplete',
      'mock',
      new Date(Date.now() + 1000).toISOString(),
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents({ dryRun: true });
  assert.equal(result.eligibleRawEvents, 0);
  assert.equal(result.blockedRawEvents, 1);
  assert.equal(result.sessions[0].reason, 'latest_distill_incomplete');
  assert.equal(result.sessions[0].latestDistillRunStatus, 'started');
  app.close();
});

test('raw event TTL pruning rejects checkpoint coverage without a succeeded distill run', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
    },
    cwd: process.cwd(),
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-unverified-checkpoint',
    sessionId: 'session-ttl-unverified-checkpoint',
  };
  app.appendRaw({ ...scope, role: 'user', content: 'evidence with unverified checkpoint' });
  const rawEvent = app.listRawEvents(scope)[0];

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      rawEvent.id,
    );
    db.prepare(`
      INSERT INTO checkpoints (
        id, scope_type, scope_key, session_id, summary_short, summary_text,
        source_event_count, provider, level, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `).run(
      'unverified-prune-checkpoint',
      'repo',
      'repo-ttl-unverified-checkpoint',
      'session-ttl-unverified-checkpoint',
      'Unverified checkpoint.',
      'This checkpoint is not linked to a succeeded distill run.',
      'synthetic',
      JSON.stringify({ sourceRawEventIds: [rawEvent.id] }),
      '2026-07-10T04:00:00.000Z',
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents({ dryRun: true });
  assert.equal(result.eligibleRawEvents, 0);
  assert.equal(result.blockedRawEvents, 1);
  assert.equal(result.sessions[0].latestCheckpointId, 'unverified-prune-checkpoint');
  assert.equal(result.sessions[0].reason, 'no_successful_level_zero_checkpoint');
  app.close();
});

test('append-time TTL pruning uses the same checkpoint coverage guard', async () => {
  const dataDir = await makeTempDir();
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-append',
    sessionId: 'session-ttl-append',
  };
  const initial = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  initial.appendRaw({ ...scope, role: 'user', content: 'old undistilled append evidence' });
  initial.close();

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'old undistilled append evidence',
    );
  } finally {
    db.close();
  }

  const reopened = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
    },
    cwd: process.cwd(),
  });
  reopened.appendRaw({ ...scope, role: 'assistant', content: 'new append evidence' });
  assert.deepEqual(
    reopened.listRawEvents(scope).map((event) => event.content),
    ['old undistilled append evidence', 'new append evidence'],
  );
  reopened.close();
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

test('provider timeout mismatch fails before execution and records non-retryable run state', async () => {
  const dataDir = await makeTempDir();
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1000',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => {
      invocations += 1;
      throw new Error('runner must not execute');
    },
  });
  const options = { scope: 'repo', scopeKey: 'timeout-repo', sessionId: 'timeout-session' };
  app.appendRaw({ ...options, role: 'assistant', content: 'Timeout mismatch evidence.' });

  await assert.rejects(
    () => app.distillCheckpoint({ ...options, _clientTimeoutMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'CONTEXTFORGE_PROVIDER_TIMEOUT_EXCEEDS_CLIENT_TIMEOUT');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(invocations, 0);
  const [run] = app.listDistillRuns(options);
  assert.equal(run.status, 'failed');
  assert.equal(run.outputMetadata.providerFailed, true);
  assert.equal(run.outputMetadata.retryable, false);
});

test('distillCheckpoint records retryable provider timeout failures without deleting raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'timeout_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      timeout_provider: async () => {
        throw new ProviderTimeoutError('timeout_provider', 25);
      },
    },
  });
  const options = { scope: 'repo', scopeKey: 'timeout-run-repo', sessionId: 'timeout-run-session' };
  app.appendRaw({ ...options, role: 'assistant', content: 'Retryable timeout evidence.' });

  await assert.rejects(() => app.distillCheckpoint(options), /timed out after 25ms/);
  const [run] = app.listDistillRuns(options);
  assert.equal(run.status, 'failed');
  assert.equal(run.outputMetadata.retryable, true);
  assert.equal(app.listRawEvents(options).length, 1);
  assert.equal(app.listCheckpoints(options).length, 0);
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
