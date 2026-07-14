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
import { ContextForgeStore } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-lifecycle-worker-test-'));
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
    '--audit-limit', '3',
    '--job-limit', '2',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-candidate-lifecycle-test.service'),
    'utf8',
  );
  assert.match(unit, /ExecStart="[^"]*env" "CONTEXTFORGE_STORAGE_MODE=remote" "CONTEXTFORGE_REMOTE_URL=http:\/\/127\.0\.0\.1:8766"/);
  assert.match(unit, /candidateLifecycleWorker/);
  assert.match(unit, /--watch --dryRun "false"/);
  assert.match(unit, /--auditLimit "3"/);
  assert.match(unit, /--jobLimit "2"/);
  assert.match(unit, /Restart=always/);

  await execFileAsync('bash', [
    'scripts/install-agent-router-service.sh',
    '--name', 'router-test',
    '--repo-registry', registry,
    '--remote-url', 'http://127.0.0.1:8766',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });
  const routerUnit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-agent-router-router-test.service'),
    'utf8',
  );
  assert.match(routerUnit, /ExecStart="[^"]*env" "CONTEXTFORGE_STORAGE_MODE=remote" "CONTEXTFORGE_REMOTE_URL=http:\/\/127\.0\.0\.1:8766"/);
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

test('all packaged remote watcher installers force remote mode in ExecStart', async () => {
  for (const file of [
    'scripts/install-agent-router-service.sh',
    'scripts/install-candidate-lifecycle-worker-service.sh',
    'scripts/install-claude-code-router-service.sh',
    'scripts/install-codex-router-service.sh',
    'scripts/install-codex-watch-service.sh',
  ]) {
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /ExecStart=.*CONTEXTFORGE_STORAGE_MODE=remote.*CONTEXTFORGE_REMOTE_URL=/);
  }
});
