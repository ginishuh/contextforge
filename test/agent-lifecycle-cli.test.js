import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { listAgentAdapters } from '../src/ingest/agents.js';
import { SCHEMA_VERSION } from '../src/storage/sqlite.js';
import { PRIVATE_DATA_FILE_MODE } from '../src/storage/permissions.js';
import { backupSqliteDatabase } from '../src/storage/backup.js';

const execFileAsync = promisify(execFile);

test('agentStart is adapter-neutral and forwards workspaceKey to bootstrapContext', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.upsertWorkspaceProfile({
    workspaceKey: 'agent-start-workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/backend',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'agent-start-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
  });

  for (const adapter of listAgentAdapters()) {
    const result = await app.agentStart({
      agent: adapter.id,
      scope: 'repo',
      scopeKey: 'github.com/example/backend',
      workspaceKey: 'agent-start-workspace',
      query: 'OpenAPI startup context',
      consultReason: 'startup',
    });
    assert.equal(result.kind, 'agent_start_context');
    assert.equal(result.agent, adapter.id);
    assert.equal(result.context.workspace.enabled, true);
    assert.equal(result.summary.workspace.workspaceKey, 'agent-start-workspace');
  }
});

test('agentCloseout rejects broad backlog review without sessionId or checkpointId', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  await assert.rejects(
    () =>
      app.agentCloseout({
        agent: 'codex',
        scope: 'repo',
        scopeKey: 'github.com/example/backend',
      }),
    /requires sessionId or checkpointId/,
  );
});

test('agent lifecycle rejects a missing agent adapter value clearly', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  await assert.rejects(
    () =>
      app.agentStart({
        agent: true,
        scope: 'repo',
        scopeKey: 'github.com/example/backend',
        query: 'startup',
      }),
    /require an agent adapter id value/,
  );
});

test('agentCloseout distills, audits, suggests, and preserves adapter session id without promotion', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'agent_closeout_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditInvocations += 1;
      return {
        approved: true,
        decision: 'approve',
        reason: 'Synthetic closeout auditor approved the runbook candidate.',
        riskCodes: [],
        metadata: { provider: 'test' },
      };
    },
    distillProviders: {
      agent_closeout_provider: async () => ({
        summaryShort: 'Agent closeout checkpoint.',
        summaryText: 'Agent closeout should keep promotion review read-only by default.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'agent-closeout-runbook',
            content: 'Agent closeout should review candidates without promoting them by default.',
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
    scopeKey: 'github.com/example/backend',
    sessionId: 'codex:agent-closeout-session',
    role: 'assistant',
    content: 'Close out this agent session with one durable candidate.',
  });

  const result = await app.agentCloseout({
    agent: 'codex',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'codex:agent-closeout-session',
    distill: 'always',
    trigger: 'manual_closeout',
    audit: true,
    suggest: true,
  });

  assert.equal(result.kind, 'agent_closeout_review');
  assert.equal(result.agent, 'codex');
  assert.equal(result.dryRun, true);
  assert.equal(result.source.sessionId, 'codex:agent-closeout-session');
  assert.equal(result.checkpoint.sessionId, 'codex:agent-closeout-session');
  assert.equal(result.checkpoint.memoryCandidateCount, 1);
  assert.equal(result.audit.kind, 'memory_candidate_audit_suggestions');
  assert.equal(auditInvocations, 1);
  assert.equal(result.suggestions.kind, 'memory_promotion_suggestions');
  assert.equal(result.summary.suggestions.proposalCount, 1);
  assert.equal(
    app.listMemories({
      scope: 'repo',
      scopeKey: 'github.com/example/backend',
    }).length,
    0,
  );
});

test('agentCloseout supports checkpointId-only closeout review without distilling', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'agent_checkpoint_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      agent_checkpoint_provider: async () => ({
        summaryShort: 'Checkpoint-only closeout.',
        summaryText: 'Checkpoint-only closeout should review existing candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'checkpoint-only-runbook',
            content: 'Checkpoint-only closeout should not require the original session id.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'claude_code:checkpoint-only-session',
    role: 'assistant',
    content: 'Create a checkpoint candidate for checkpoint-only closeout.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'claude_code:checkpoint-only-session',
  });

  const result = await app.agentCloseout({
    agent: 'claude_code',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    audit: false,
    suggest: false,
  });

  assert.equal(result.source.sessionId, null);
  assert.equal(result.source.checkpointId, checkpoint.id);
  assert.equal(result.source.mode, 'provided_checkpoint');
  assert.equal(result.distill.executed, false);
  assert.equal(result.distill.skippedReason, 'checkpoint_only_source');
  assert.equal(result.audit, null);
  assert.equal(result.suggestions, null);
});

test('CLI supports agentStart and dry-run agentCloseout commands', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const start = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'agentStart',
      '--agent',
      'claude_code',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--query',
      'startup handoff',
    ],
    { env },
  );
  const startResult = JSON.parse(start.stdout);
  assert.equal(startResult.kind, 'agent_start_context');
  assert.equal(startResult.agent, 'claude_code');

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'appendRaw',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--sessionId',
      'codex:cli-agent-closeout',
      '--role',
      'assistant',
      '--content',
      'CLI closeout should preserve adapter-prefixed session id.',
    ],
    { env },
  );

  const closeout = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'agentCloseout',
      '--agent',
      'codex',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--sessionId',
      'codex:cli-agent-closeout',
      '--distill',
      'never',
      '--audit',
      '0',
      '--suggest',
      'no',
      '--dryRun',
      '1',
    ],
    { env },
  );
  const closeoutResult = JSON.parse(closeout.stdout);
  assert.equal(closeoutResult.kind, 'agent_closeout_review');
  assert.equal(closeoutResult.dryRun, true);
  assert.equal(closeoutResult.audit, null);
  assert.equal(closeoutResult.suggestions, null);
  assert.equal(closeoutResult.source.sessionId, 'codex:cli-agent-closeout');
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
  assert.match(bootstrap.stdout, /"memoryMap":/);
  const bootstrapJson = JSON.parse(bootstrap.stdout);
  const expand = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'expandMemoryCluster',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--clusterId',
      bootstrapJson.memoryMap.clusters[0].clusterId,
    ],
    { env },
  );
  assert.match(expand.stdout, /"kind": "memory_cluster_expansion"/);
  assert.match(expand.stdout, /"key": "retrieval"/);

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

  const embeddingInventory = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'embeddingInventory',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-repo',
          '--completedJobRetentionDays',
          '7',
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(embeddingInventory.kind, 'embedding_maintenance_inventory');
  assert.equal(embeddingInventory.completedJobRetentionDays, 7);

  const embeddingGc = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'pruneEmbeddingArtifacts',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-repo',
          '--batchSize',
          '5',
          '--includeRetired',
          'false',
          '--confirmMassRetired',
          'false',
          '--includeInventory',
          'false',
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(embeddingGc.kind, 'embedding_maintenance_gc');
  assert.equal(embeddingGc.dryRun, true);
  assert.equal(embeddingGc.batchSize, 5);
  assert.equal(embeddingGc.includeRetired, false);
  assert.equal(embeddingGc.confirmMassRetired, false);
  assert.equal(embeddingGc.includeInventory, false);
});

test('CLI backup, verify, and offline-confirmed restore preserve a verified SQLite snapshot', async () => {
  const dataDir = await makeTempDir();
  const backupDir = await makeTempDir();
  const backupFile = path.join(backupDir, 'contextforge-backup.db');
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };
  const remember = (key) =>
    execFileAsync(
      'node',
      [
        'src/cli.js',
        'remember',
        '--scope',
        'repo',
        '--scopeKey',
        'backup-repo',
        '--key',
        key,
        '--content',
        `Backup fixture ${key}.`,
      ],
      { env },
    );
  await remember('before-backup');

  const backup = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'backupDatabase', '--file', backupFile], { env })).stdout,
  );
  assert.equal(backup.kind, 'contextforge_backup');
  assert.equal(backup.verification.ok, true);
  assert.equal(backup.verification.quickCheck[0], 'ok');
  assert.deepEqual(backup.verification.foreignKeyViolations, []);
  assert.equal((await fs.stat(backupFile)).mode & 0o777, PRIVATE_DATA_FILE_MODE);
  assert.equal((await fs.stat(`${backupFile}.metadata.json`)).mode & 0o777, PRIVATE_DATA_FILE_MODE);

  const verified = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'verifyBackup', '--file', backupFile], { env })).stdout,
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.metadataHashMatches, true);

  const previousBackup = await fs.readFile(backupFile);
  const previousMetadata = await fs.readFile(`${backupFile}.metadata.json`);
  await assert.rejects(
    backupSqliteDatabase({
      dataDir,
      file: backupFile,
      force: true,
      backupRunner: async () => {
        throw new Error('Synthetic backup failure before install.');
      },
    }),
    /Synthetic backup failure/,
  );
  assert.deepEqual(await fs.readFile(backupFile), previousBackup);
  assert.deepEqual(await fs.readFile(`${backupFile}.metadata.json`), previousMetadata);

  const forcedBackup = await backupSqliteDatabase({ dataDir, file: backupFile, force: true });
  assert.equal(forcedBackup.verification.ok, true);
  const forcedVerification = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'verifyBackup', '--file', backupFile], { env })).stdout,
  );
  assert.equal(forcedVerification.ok, true);
  assert.equal(forcedVerification.metadataHashMatches, true);

  const tamperedFile = path.join(backupDir, 'tampered.db');
  await fs.copyFile(backupFile, tamperedFile);
  await fs.writeFile(
    `${tamperedFile}.metadata.json`,
    JSON.stringify({ ...verified.metadata, sha256: '0'.repeat(64) }),
    { mode: 0o600 },
  );
  await assert.rejects(
    execFileAsync('node', ['src/cli.js', 'verifyBackup', '--file', tamperedFile], { env }),
    (error) => {
      const tampered = JSON.parse(error.stdout);
      assert.equal(tampered.ok, false);
      assert.equal(tampered.metadataHashMatches, false);
      return true;
    },
  );

  await remember('after-backup');
  const dryRun = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'restoreDatabase', '--file', backupFile], { env })).stdout,
  );
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.requiresOfflineConfirmation, true);
  await assert.rejects(
    execFileAsync('node', ['src/cli.js', 'restoreDatabase', '--file', backupFile, '--dryRun', 'false'], { env }),
    /confirmOffline=true/,
  );

  const restored = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'restoreDatabase',
          '--file',
          backupFile,
          '--dryRun',
          'false',
          '--confirmOffline',
          'true',
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(restored.restored, true);
  assert.equal(restored.verification.ok, true);
  assert.ok(restored.preRestoreBackup);
  assert.equal((await fs.stat(restored.preRestoreBackup)).mode & 0o777, PRIVATE_DATA_FILE_MODE);

  const memories = JSON.parse(
    (
      await execFileAsync(
        'node',
        ['src/cli.js', 'listMemories', '--scope', 'repo', '--scopeKey', 'backup-repo'],
        { env },
      )
    ).stdout,
  );
  assert.deepEqual(memories.map((memory) => memory.key), ['before-backup']);

  await assert.rejects(
    execFileAsync('node', ['src/cli.js', 'backupDatabase', '--file', path.join(backupDir, 'wrong.db')], {
      env: {
        ...env,
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: 'http://127.0.0.1:9',
      },
    }),
    /must run on the process that owns the canonical SQLite store/,
  );
});

test('CLI submits, inspects, processes, and cancels durable operation jobs', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };
  const sourceArgs = ['--scope', 'repo', '--scopeKey', 'cli-job-repo', '--sessionId', 'cli-job-session'];
  await execFileAsync(
    'node',
    ['src/cli.js', 'appendRaw', ...sourceArgs, '--role', 'assistant', '--content', 'CLI durable job evidence.'],
    { env },
  );
  const submitted = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'submitDistillJob', ...sourceArgs], { env })).stdout,
  );
  assert.equal(submitted.status, 'queued');
  const listed = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'listJobs', '--status', 'queued'], { env })).stdout,
  );
  assert.equal(listed[0].id, submitted.jobId);
  const processed = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'processJobs', '--workerId', 'cli-worker'], { env })).stdout,
  );
  assert.equal(processed.succeeded, 1);
  const completed = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'getJob', '--jobId', submitted.jobId], { env })).stdout,
  );
  assert.equal(completed.status, 'succeeded');

  const cancellable = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'submitDistillJob',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-job-repo',
          '--sessionId',
          'cli-cancel-session',
          '--idempotencyKey',
          'cli-cancel-job',
        ],
        { env },
      )
    ).stdout,
  );
  const cancelled = JSON.parse(
    (
      await execFileAsync(
        'node',
        ['src/cli.js', 'cancelJob', '--jobId', cancellable.jobId, '--reason', 'CLI cancellation test.'],
        { env },
      )
    ).stdout,
  );
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.job.status, 'cancelled');
});
