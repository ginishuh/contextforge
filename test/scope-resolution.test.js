import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { makeGitRepo } from './helpers/fixtures.js';
import { makeNonGitTempDir, makeTempDir } from './helpers/temp.js';
import { canonicalizeScope, parseScopeAliases } from '../src/config/index.js';
import { createContextForge } from '../src/core.js';
import { normalizeRepoIdentity } from '../src/ingest/common.js';

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
