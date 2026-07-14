import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterruptibleSleep, normalizeRepoIdentity } from '../ingest/common.js';

function positiveInteger(value, name, fallback, max = 500) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

function errorSummary(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
  };
}

function compactWakeups(result) {
  return {
    dueCount: Number(result?.dueCount || 0),
    woken: Number(result?.woken || 0),
    deduplicated: Number(result?.deduplicated || 0),
    skipped: Number(result?.skipped || 0),
    failed: Number(result?.failed || 0),
  };
}

function compactAudits(result) {
  return {
    dueCount: Number(result?.dueCount || 0),
    enqueued: Number(result?.enqueued || 0),
    requeued: Number(result?.requeued || 0),
    deduplicated: Number(result?.deduplicated || 0),
    blocked: Number(result?.blocked || 0),
    drained: Number(result?.drained || 0),
    staleEpochs: Number(result?.staleEpochs || 0),
    failed: Number(result?.failed || 0),
  };
}

function compactStale(result) {
  return {
    dueCount: Number(result?.dueCount || 0),
    staled: Number(result?.staled || 0),
    skipped: Number(result?.skipped || 0),
    failed: Number(result?.failed || 0),
  };
}

function compactJobs(result) {
  return {
    claimed: Number(result?.claimed || 0),
    succeeded: Number(result?.succeeded || 0),
    failed: Number(result?.failed || 0),
    requeued: Number(result?.requeued || 0),
  };
}

async function registryScopes(file) {
  const registryPath = path.resolve(String(file));
  const parsed = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.repos;
  if (!Array.isArray(entries)) {
    throw new Error('Repo registry must be a JSON array or an object with a repos array.');
  }
  const scopes = [];
  const seen = new Set();
  for (const [index, repo] of entries.entries()) {
    if (!repo || repo.enabled === false) continue;
    if (!repo.scopeKey) throw new Error(`Repo registry entry ${index} is missing scopeKey.`);
    const scopeKey = String(repo.scopeKey);
    if (normalizeRepoIdentity(scopeKey) !== scopeKey) {
      throw new Error(`Repo registry scopeKey must be a canonical repository identity: ${scopeKey}`);
    }
    if (seen.has(scopeKey)) continue;
    seen.add(scopeKey);
    scopes.push({ scope: 'repo', scopeType: 'repo', scopeKey });
  }
  if (scopes.length === 0) throw new Error('Repo registry has no enabled canonical scopes.');
  return { source: 'repo_registry', registryPath, scopes };
}

export async function resolveCandidateLifecycleScopes(options = {}) {
  const hasScope = Boolean(options.scope || options.scopeType || options.scopeKey);
  if (hasScope) {
    const scopeType = options.scope || options.scopeType;
    if (!scopeType || !options.scopeKey) {
      throw new Error('Candidate lifecycle worker requires both scope and scopeKey.');
    }
    return {
      source: 'explicit',
      registryPath: null,
      scopes: [{ scope: String(scopeType), scopeType: String(scopeType), scopeKey: String(options.scopeKey) }],
    };
  }
  if (!options.repoRegistry) {
    throw new Error('Candidate lifecycle worker requires scope/scopeKey or repoRegistry.');
  }
  return registryScopes(options.repoRegistry);
}

export async function processCandidateLifecycle(app, options = {}) {
  const resolved = await resolveCandidateLifecycleScopes(options);
  const dryRun = options.dryRun !== false;
  const auditLimit = positiveInteger(options.auditLimit, 'auditLimit', 5, 50);
  const auditBatchLimit = positiveInteger(options.auditBatchLimit, 'auditBatchLimit', 5, 10);
  const wakeLimit = positiveInteger(options.wakeLimit, 'wakeLimit', 25);
  const staleLimit = positiveInteger(options.staleLimit, 'staleLimit', 25);
  const jobLimit = positiveInteger(options.jobLimit, 'jobLimit', 5, 25);
  const leaseMs = positiveInteger(options.leaseMs, 'leaseMs', 600000, 3600000);
  if (leaseMs < 1000) throw new Error('leaseMs must be at least 1000ms.');
  const workerId = options.workerId || `candidate-lifecycle-worker:${process.pid}`;
  const result = {
    kind: 'candidate_lifecycle_worker_iteration',
    observedAt: new Date().toISOString(),
    dryRun,
    source: resolved.source,
    registryPath: resolved.registryPath,
    scopeCount: resolved.scopes.length,
    failedScopes: 0,
    scopes: [],
    jobs: { claimed: 0, succeeded: 0, failed: 0, requeued: 0 },
  };
  for (const scope of resolved.scopes) {
    try {
      const wakeups = await app.processDueCandidateWakeups({ ...scope, dryRun, limit: wakeLimit });
      const audits = await app.processDueCandidateAudits({
        ...scope,
        dryRun,
        limit: auditLimit,
        batchLimit: auditBatchLimit,
        submittedBy: workerId,
      });
      const stale = await app.processDueCandidateStaleTransitions({ ...scope, dryRun, limit: staleLimit });
      const jobs = dryRun
        ? { claimed: 0, succeeded: 0, failed: 0, requeued: 0 }
        : compactJobs(await app.processJobs({
            ...scope,
            operations: ['audit_memory_candidates'],
            limit: jobLimit,
            leaseMs,
            workerId,
          }));
      result.jobs.claimed += jobs.claimed;
      result.jobs.succeeded += jobs.succeeded;
      result.jobs.failed += jobs.failed;
      result.jobs.requeued += jobs.requeued;
      result.scopes.push({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        status: 'ok',
        wakeups: compactWakeups(wakeups),
        audits: compactAudits(audits),
        stale: compactStale(stale),
        jobs,
      });
    } catch (error) {
      result.failedScopes += 1;
      result.scopes.push({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        status: 'failed',
        error: errorSummary(error),
      });
    }
  }
  return result;
}

export async function watchCandidateLifecycle(app, options = {}) {
  const intervalMs = options.intervalMs == null ? 60000 : Math.max(0, Number(options.intervalMs));
  if (!Number.isFinite(intervalMs)) throw new Error('intervalMs must be a non-negative number.');
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  if (maxIterations != null && !Number.isInteger(maxIterations)) {
    throw new Error('iterations must be a non-negative integer.');
  }
  const startedAt = new Date().toISOString();
  const results = [];
  const totals = { scopes: 0, failedScopes: 0, jobsClaimed: 0, jobsSucceeded: 0, jobsFailed: 0 };
  const sleeper = createInterruptibleSleep();
  let iterations = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    sleeper.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped && (maxIterations == null || iterations < maxIterations)) {
      iterations += 1;
      const iteration = await processCandidateLifecycle(app, options);
      totals.scopes += iteration.scopeCount;
      totals.failedScopes += iteration.failedScopes;
      totals.jobsClaimed += iteration.jobs.claimed;
      totals.jobsSucceeded += iteration.jobs.succeeded;
      totals.jobsFailed += iteration.jobs.failed;
      if (maxIterations != null) results.push(iteration);
      if (options.onResult) await options.onResult(iteration);
      if (!stopped && (maxIterations == null || iterations < maxIterations)) {
        await sleeper.sleep(intervalMs);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return {
    kind: 'candidate_lifecycle_worker_watch',
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals,
    results,
  };
}
