import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  processCandidateLifecycle,
  resolveCandidateLifecycleScopes,
  watchCandidateLifecycle,
} from '../src/memory/candidate_lifecycle_worker.js';
import { createContextForge } from '../src/core.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-lifecycle-worker-test-'));
}

async function assertPrivateAuthorityFile({ home, unitName, authorityName, remoteUrl, remoteTimeoutMs = 180000 }) {
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  const authorityPath = path.join(unitDir, authorityName);
  const unit = await fs.readFile(path.join(unitDir, unitName), 'utf8');
  const authority = await fs.readFile(authorityPath, 'utf8');
  const authorityUnitPath = `%h/.config/systemd/user/${authorityName}`;
  assert.ok(unit.indexOf('EnvironmentFile=-') < unit.indexOf(`EnvironmentFile=${authorityUnitPath}`));
  assert.doesNotMatch(unit, /CONTEXTFORGE_REMOTE_URL=/);
  assert.doesNotMatch(unit, new RegExp(remoteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(
    authority,
    `CONTEXTFORGE_STORAGE_MODE=remote\nCONTEXTFORGE_REMOTE_URL='${remoteUrl}'\n` +
      `CONTEXTFORGE_REMOTE_TIMEOUT_MS=${remoteTimeoutMs}\n`,
  );
  assert.equal((await fs.stat(authorityPath)).mode & 0o777, 0o600);
  return unit;
}

function fakeLifecycleApp(calls, { failScope = null } = {}) {
  return {
    async processDueCandidateWakeups(options) {
      calls.push(['wake', options]);
      if (options.scopeKey === failScope) throw new Error('synthetic scope failure');
      return { dueCount: 2, woken: options.dryRun ? 0 : 1, deduplicated: 0, skipped: 1, failed: 0 };
    },
    async processDueCandidateAudits(options) {
      calls.push(['audit', options]);
      return { dueCount: 1, enqueued: options.dryRun ? 0 : 1, failed: 0 };
    },
    async processDueCandidateStaleTransitions(options) {
      calls.push(['stale', options]);
      return { dueCount: 3, staled: options.dryRun ? 0 : 2, skipped: 1, failed: 0 };
    },
    async processJobs(options) {
      calls.push(['jobs', options]);
      return { claimed: 1, succeeded: 1, failed: 0, requeued: 0 };
    },
  };
}

test('candidate lifecycle iteration defaults to provider-free dry-run with one explicit scope', async () => {
  const calls = [];
  const result = await processCandidateLifecycle(fakeLifecycleApp(calls), {
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.scopeCount, 1);
  assert.equal(result.failedScopes, 0);
  assert.deepEqual(calls.map(([method]) => method), ['wake', 'audit', 'stale']);
  assert.equal(calls.every(([, options]) => options.dryRun === true), true);
  assert.equal(result.scopes[0].wakeups.dueCount, 2);
  assert.equal(result.scopes[0].audits.dueCount, 1);
  assert.equal(result.scopes[0].stale.dueCount, 3);
  assert.equal(result.jobs.claimed, 0);
});

test('registry lifecycle iteration deduplicates scopes, isolates failures, and processes jobs per scope', async () => {
  const dataDir = await makeTempDir();
  const registry = path.join(dataDir, 'repos.json');
  await fs.writeFile(registry, JSON.stringify({
    repos: [
      { scopeKey: 'github.com/example/repo-a' },
      { scopeKey: 'github.com/example/repo-a' },
      { scopeKey: 'github.com/example/repo-b' },
      { scopeKey: 'github.com/example/disabled', enabled: false },
    ],
  }));
  const calls = [];
  const result = await processCandidateLifecycle(fakeLifecycleApp(calls, {
    failScope: 'github.com/example/repo-b',
  }), {
    repoRegistry: registry,
    dryRun: false,
    workerId: 'synthetic-lifecycle-worker',
    jobLimit: 2,
  });

  assert.equal(result.source, 'repo_registry');
  assert.equal(result.scopeCount, 2);
  assert.equal(result.failedScopes, 1);
  assert.equal(result.jobs.claimed, 1);
  const jobCall = calls.find(([method]) => method === 'jobs');
  assert.equal(jobCall[1].scopeKey, 'github.com/example/repo-a');
  assert.deepEqual(jobCall[1].operations, ['audit_memory_candidates']);
  assert.equal(calls.some(([method, options]) => method === 'jobs' && options.scopeKey === 'github.com/example/repo-b'), false);
});

test('candidate lifecycle watch runs bounded iterations and reports compact totals', async () => {
  const calls = [];
  const emitted = [];
  const result = await watchCandidateLifecycle(fakeLifecycleApp(calls), {
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    iterations: 2,
    intervalMs: 0,
    onResult: (iteration) => emitted.push(iteration),
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.results.length, 2);
  assert.equal(emitted.length, 2);
  assert.equal(result.totals.scopes, 2);
  assert.equal(calls.length, 6);
});

test('unbounded candidate lifecycle watch rejects a busy-loop interval', async () => {
  await assert.rejects(
    watchCandidateLifecycle(fakeLifecycleApp([]), {
      scope: 'repo', scopeKey: 'github.com/example/contextforge', intervalMs: 0,
    }),
    /at least 1000ms/,
  );
});

test('candidate lifecycle stop request prevents later stages and scopes from starting', async () => {
  let stopped = false;
  const calls = [];
  const app = fakeLifecycleApp(calls);
  const wake = app.processDueCandidateWakeups;
  app.processDueCandidateWakeups = async (options) => {
    const result = await wake(options);
    stopped = true;
    return result;
  };
  const result = await processCandidateLifecycle(app, {
    scope: 'repo', scopeKey: 'github.com/example/contextforge',
    shouldStop: () => stopped,
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(calls.map(([method]) => method), ['wake']);
  assert.equal(result.scopes[0].status, 'stopped');
  assert.equal(result.scopes[0].wakeups.dueCount, 2);
});

test('operation job claims can be fenced to one canonical scope', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  store.enqueueOperationJob({
    operation: 'audit_memory_candidates', scopeType: 'repo', scopeKey: 'github.com/example/repo-a',
    idempotencyKey: 'scope-a',
  });
  store.enqueueOperationJob({
    operation: 'audit_memory_candidates', scopeType: 'repo', scopeKey: 'github.com/example/repo-b',
    idempotencyKey: 'scope-b',
  });
  store.db.prepare(`
    UPDATE operation_jobs SET status = 'running', attempts = 1,
      lease_owner = 'expired-other-scope', lease_expires_at = datetime('now', '-1 minute')
    WHERE scope_key = 'github.com/example/repo-a'
  `).run();
  const claimed = store.claimOperationJobs({
    workerId: 'scope-worker', operations: ['audit_memory_candidates'],
    scopeType: 'repo', scopeKey: 'github.com/example/repo-b',
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].scopeKey, 'github.com/example/repo-b');
  const otherScope = store.listOperationJobs({ scopeType: 'repo', scopeKey: 'github.com/example/repo-a' })[0];
  assert.equal(otherScope.status, 'running', 'scoped claim must not recover another scope lease');
  store.close();
});

test('durable audit workers propagate the remote client timeout before provider execution', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  const auditor = async () => {
    auditInvocations += 1;
    throw new Error('auditor must not execute when the client timeout contract is invalid');
  };
  auditor.metadata = {
    provider: 'timeout_contract_auditor',
    model: 'synthetic-model',
    timeoutMs: 1000,
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'timeout_contract_source',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      timeout_contract_source: async () => ({
        summaryShort: 'Timeout contract source.',
        summaryText: 'A durable audit job must inherit the remote client timeout.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [{
          key: 'durable-audit-timeout-contract',
          content: 'Propagate the remote client timeout through durable audit job execution.',
          category: 'runbook',
          candidateType: 'runbook',
          confidence: 0.96,
          stability: 0.96,
          sensitivity: 'low',
          promotionRecommendation: 'promote',
        }],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'timeout-contract-repo', sessionId: 'timeout-contract-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Create a candidate for the timeout contract test.' });
  await app.distillCheckpoint(source);
  const submitted = app.submitAuditJob({ ...source, trigger: 'manual_closeout' });

  const processed = await app.processJobs({
    workerId: 'timeout-contract-worker',
    operation: 'audit_memory_candidates',
    _clientTimeoutMs: 1000,
  });

  assert.equal(processed.claimed, 1);
  assert.equal(processed.succeeded, 0);
  assert.equal(processed.failed, 1);
  assert.equal(auditInvocations, 0);
  const failed = app.getJob({ jobId: submitted.jobId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'CONTEXTFORGE_PROVIDER_TIMEOUT_EXCEEDS_CLIENT_TIMEOUT');
  assert.equal(failed.error.retryable, false);
  assert.equal(failed.candidates[0].status, 'failed_terminal');
});

test('durable distill workers propagate the remote client timeout before provider execution', async () => {
  const dataDir = await makeTempDir();
  let providerInvocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1000',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => {
      providerInvocations += 1;
      throw new Error('provider must not execute when the client timeout contract is invalid');
    },
  });
  const source = { scope: 'repo', scopeKey: 'distill-timeout-contract-repo', sessionId: 'distill-timeout-contract-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Keep this raw evidence when the timeout contract fails.' });
  const submitted = app.submitDistillJob(source);

  const processed = await app.processJobs({
    workerId: 'distill-timeout-contract-worker',
    operation: 'distill_checkpoint',
    _clientTimeoutMs: 1000,
  });

  assert.equal(processed.claimed, 1);
  assert.equal(processed.succeeded, 0);
  assert.equal(processed.failed, 1);
  assert.equal(providerInvocations, 0);
  const failed = app.getJob({ jobId: submitted.jobId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'CONTEXTFORGE_PROVIDER_TIMEOUT_EXCEEDS_CLIENT_TIMEOUT');
  assert.equal(failed.error.retryable, false);
  assert.equal(app.listRawEvents(source).length, 1);
  assert.equal(app.listCheckpoints(source).length, 0);
});

test('candidate lifecycle service installer writes a remote bounded worker unit', async () => {
  const home = await makeTempDir();
  const binDir = path.join(home, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const systemctl = path.join(binDir, 'systemctl');
  await fs.writeFile(systemctl, '#!/usr/bin/env bash\nexit 0\n');
  await fs.chmod(systemctl, 0o755);
  const registry = path.join(home, 'repos.json');
  await fs.writeFile(registry, JSON.stringify({ repos: [{ scopeKey: 'github.com/example/contextforge' }] }));

  await execFileAsync('bash', [
    'scripts/install-candidate-lifecycle-worker-service.sh',
    '--name', 'test',
    '--repo-registry', registry,
    '--remote-url', 'http://127.0.0.1:8766',
    '--interval-ms', '30000',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });

  const unit = await assertPrivateAuthorityFile({
    home,
    unitName: 'contextforge-candidate-lifecycle-test.service',
    authorityName: 'contextforge-candidate-lifecycle-test.authority.env',
    remoteUrl: 'http://127.0.0.1:8766',
    remoteTimeoutMs: 300000,
  });
  assert.match(unit, /candidateLifecycleWorker/);
  assert.match(unit, /--watch --dryRun "false"/);
  assert.match(unit, /--auditLimit "1"/);
  assert.match(unit, /--auditBatchLimit "2"/);
  assert.match(unit, /--jobLimit "1"/);
  assert.match(unit, /Restart=always/);

  await execFileAsync('bash', [
    'scripts/install-candidate-lifecycle-worker-service.sh',
    '--name', 'override-test',
    '--repo-registry', registry,
    '--remote-url', 'http://127.0.0.1:8766',
    '--remote-timeout-ms', '420000',
    '--audit-limit', '3',
    '--audit-batch-limit', '4',
    '--job-limit', '2',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });
  const overrideUnit = await assertPrivateAuthorityFile({
    home,
    unitName: 'contextforge-candidate-lifecycle-override-test.service',
    authorityName: 'contextforge-candidate-lifecycle-override-test.authority.env',
    remoteUrl: 'http://127.0.0.1:8766',
    remoteTimeoutMs: 420000,
  });
  assert.match(overrideUnit, /--auditLimit "3"/);
  assert.match(overrideUnit, /--auditBatchLimit "4"/);
  assert.match(overrideUnit, /--jobLimit "2"/);

  await execFileAsync('bash', [
    'scripts/install-agent-router-service.sh',
    '--name', 'router-test',
    '--repo-registry', registry,
    '--remote-url', 'http://127.0.0.1:8766',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });
  await assertPrivateAuthorityFile({
    home,
    unitName: 'contextforge-agent-router-router-test.service',
    authorityName: 'contextforge-agent-router-router-test.authority.env',
    remoteUrl: 'http://127.0.0.1:8766',
  });
});

test('lifecycle scope resolver rejects non-canonical and empty registries', async () => {
  const dataDir = await makeTempDir();
  const noncanonical = path.join(dataDir, 'noncanonical.json');
  await fs.writeFile(noncanonical, JSON.stringify({ repos: [{ scopeKey: 'https://github.com/Example/Repo.git' }] }));
  await assert.rejects(resolveCandidateLifecycleScopes({ repoRegistry: noncanonical }), /canonical repository identity/);
  const empty = path.join(dataDir, 'empty.json');
  await fs.writeFile(empty, JSON.stringify({ repos: [] }));
  await assert.rejects(resolveCandidateLifecycleScopes({ repoRegistry: empty }), /no enabled canonical scopes/);
});

test('legacy watcher installers render private last-wins authority files', async () => {
  const home = await makeTempDir();
  const binDir = path.join(home, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const registry = path.join(home, 'repos.json');
  await fs.writeFile(registry, JSON.stringify({ repos: [{ scopeKey: 'github.com/example/contextforge' }] }));
  const remoteUrl = 'https://memory.example.com/api?token=abc$def%20x';
  const specs = [
    {
      script: 'scripts/install-claude-code-router-service.sh',
      args: ['--name', 'claude-test', '--repo-registry', registry],
      unitName: 'contextforge-claude-code-router-claude-test.service',
      authorityName: 'contextforge-claude-code-router-claude-test.authority.env',
    },
    {
      script: 'scripts/install-codex-router-service.sh',
      args: ['--name', 'codex-test', '--repo-registry', registry],
      unitName: 'contextforge-codex-router-codex-test.service',
      authorityName: 'contextforge-codex-router-codex-test.authority.env',
    },
    {
      script: 'scripts/install-codex-watch-service.sh',
      args: [
        '--name', 'watch-test', '--repo-path', process.cwd(),
        '--scope-key', 'github.com/example/contextforge',
      ],
      unitName: 'contextforge-codex-watch-watch-test.service',
      authorityName: 'contextforge-codex-watch-watch-test.authority.env',
    },
  ];
  for (const spec of specs) {
    await execFileAsync('bash', [spec.script, ...spec.args, '--remote-url', remoteUrl], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
    });
    await assertPrivateAuthorityFile({ home, ...spec, remoteUrl });
  }
});

test('watcher installer rejects authority environment file injection', async () => {
  const home = await makeTempDir();
  const registry = path.join(home, 'repos.json');
  await fs.writeFile(registry, JSON.stringify({ repos: [{ scopeKey: 'github.com/example/contextforge' }] }));
  for (const remoteUrl of ["https://memory.example.com/'bad", 'https://memory.example.com/\nbad']) {
    await assert.rejects(
      execFileAsync('bash', [
        'scripts/install-candidate-lifecycle-worker-service.sh',
        '--repo-registry', registry, '--remote-url', remoteUrl,
      ], { cwd: process.cwd(), env: { ...process.env, HOME: home } }),
      (error) => error.code === 2 && /line break or single quote/.test(error.stderr),
    );
  }
});

test('all packaged watcher installers reject an invalid remote timeout', async () => {
  const home = await makeTempDir();
  const registry = path.join(home, 'repos.json');
  await fs.writeFile(registry, JSON.stringify({ repos: [{ scopeKey: 'github.com/example/contextforge' }] }));
  const specs = [
    ['scripts/install-agent-router-service.sh', '--repo-registry', registry],
    ['scripts/install-candidate-lifecycle-worker-service.sh', '--repo-registry', registry],
    ['scripts/install-claude-code-router-service.sh', '--repo-registry', registry],
    ['scripts/install-codex-router-service.sh', '--repo-registry', registry],
    [
      'scripts/install-codex-watch-service.sh', '--repo-path', process.cwd(),
      '--scope-key', 'github.com/example/contextforge',
    ],
  ];
  for (const [script, ...args] of specs) {
    await assert.rejects(
      execFileAsync('bash', [
        script, ...args, '--remote-url', 'https://memory.example.com', '--remote-timeout-ms', '0',
      ], { cwd: process.cwd(), env: { ...process.env, HOME: home } }),
      (error) => error.code === 2 && /positive integer/.test(error.stderr),
    );
  }
});
