import { createHash } from 'node:crypto';

import { positiveInteger, stableJsonValue } from '../common.js';
import { normalizeScopeOptions } from '../scopes/index.js';

// Embedding job plumbing extracted from core.js: enqueueing sources, resolving
// a job back to its source record, the paged maintenance inventory, and the
// batch worker. These are closures over { config, embeddingProvider }, so
// core.js calls the factory once and keeps the handles — enqueueEmbeddingSources
// and embeddingFailureResult are used well outside the embedding operations
// (remember, promotion, correction, consolidation, distill checkpoints).
//
// Nothing here may import core.js: core.js imports this module.
export function embeddingJobHelpers({ config, embeddingProvider }) {
  function enqueueEmbeddingSources(store, sources, { force = false } = {}) {
    if (!embeddingProvider) {
      return {
        provider: config.embeddings.provider,
        skipped: true,
        reason: 'embeddings_disabled',
        model: null,
        dimensions: null,
        queued: 0,
        bySourceType: {},
      };
    }
    const jobs = store.enqueueEmbeddingJobs(sources, {
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      force,
    });
    const bySourceType = {};
    for (const job of jobs) {
      bySourceType[job.sourceType] = (bySourceType[job.sourceType] || 0) + 1;
    }
    return {
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      skipped: false,
      queued: jobs.length,
      bySourceType,
    };
  }

  function embeddingSourceForJob(store, job) {
    if (job.sourceType === 'memory') {
      const memory = store.getMemoryById({
        scopeType: job.scopeType,
        scopeKey: job.scopeKey,
        memoryId: job.recordId,
      });
      return memory && store.embeddingSourceForMemory(memory);
    }
    if (job.sourceType === 'checkpoint') {
      const checkpoint = store.getCheckpointById({
        scopeType: job.scopeType,
        scopeKey: job.scopeKey,
        checkpointId: job.recordId,
      });
      return checkpoint && store.embeddingSourceForCheckpoint(checkpoint);
    }
    const candidate = store.getMemoryCandidate({
      scopeType: job.scopeType,
      scopeKey: job.scopeKey,
      candidateId: job.recordId,
    });
    return candidate && store.embeddingSourceForMemoryCandidate(candidate);
  }

  function embeddingMaintenanceCursorBinding({ scope, current, completedJobRetentionDays }) {
    return createHash('sha256')
      .update(JSON.stringify(stableJsonValue({ scope, current, completedJobRetentionDays })))
      .digest('hex')
      .slice(0, 24);
  }

  function embeddingMaintenanceCursorState(cursor, binding) {
    const initial = {
      index: { done: false, after: null },
      vector: { done: false, after: null },
      jobs: { done: false, after: null },
    };
    if (!cursor) return initial;
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid embedding maintenance cursor encoding.');
    }
    const validLane = (lane, positionSize) =>
      lane &&
      typeof lane.done === 'boolean' &&
      (lane.after == null ||
        (Array.isArray(lane.after) &&
          lane.after.length === positionSize &&
          lane.after.every((value) => typeof value === 'string' && value.length > 0)));
    if (
      decoded?.v !== 1 ||
      decoded.binding !== binding ||
      !validLane(decoded.index, 2) ||
      !validLane(decoded.vector, 1) ||
      !validLane(decoded.jobs, 2)
    ) {
      throw new Error('Embedding maintenance cursor does not match this inventory request.');
    }
    return {
      index: decoded.index,
      vector: decoded.vector,
      jobs: decoded.jobs,
    };
  }

  function embeddingMaintenancePage(rows, limit, positionForItem) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      hasMore,
      state: {
        done: !hasMore,
        after: hasMore && last ? positionForItem(last) : null,
      },
    };
  }

  function embeddingMaintenanceInventory(store, options = {}) {
    const narrowed = Boolean(options.scope || options.scopeKey || options.cwd || options.repoPath);
    const scope = narrowed ? normalizeScopeOptions(options, config) : { scopeType: null, scopeKey: null };
    const scanLimit = Math.min(50000, positiveInteger(options.scanLimit == null ? 5000 : options.scanLimit, 'scanLimit'));
    const completedJobRetentionDays = positiveInteger(
      options.completedJobRetentionDays == null ? 30 : options.completedJobRetentionDays,
      'completedJobRetentionDays',
    );
    const completedBefore = new Date(Date.now() - completedJobRetentionDays * 86400000).toISOString();
    const current = {
      model: embeddingProvider?.model || config.embeddings.model,
      dimensions: embeddingProvider?.dimensions || config.embeddings.dimensions,
      authoritative: Boolean(embeddingProvider),
    };
    const cursorBinding = embeddingMaintenanceCursorBinding({ scope, current, completedJobRetentionDays });
    const cursorState = embeddingMaintenanceCursorState(options.cursor, cursorBinding);
    const modelCounts = store.embeddingModelCounts(scope);
    const indexedRowCount = modelCounts.reduce((sum, item) => sum + item.count, 0);
    const retiredIndexedRowCount = current.authoritative
      ? modelCounts
          .filter((item) => item.model !== current.model || Number(item.dimensions) !== current.dimensions)
          .reduce((sum, item) => sum + item.count, 0)
      : 0;
    const retiredRisk =
      current.authoritative && indexedRowCount > 0 && retiredIndexedRowCount / indexedRowCount >= 0.5
        ? {
            code: 'mass_retired',
            indexedRows: indexedRowCount,
            retiredRows: retiredIndexedRowCount,
            retiredRatio: retiredIndexedRowCount / indexedRowCount,
          }
        : null;
    const artifacts = [];
    const byReason = {};
    const bySourceType = {};
    const indexPage = cursorState.index.done
      ? { items: [], hasMore: false, state: cursorState.index }
      : embeddingMaintenancePage(
          store.listEmbeddingIndexRecords({ ...scope, limit: scanLimit + 1, after: cursorState.index.after }),
          scanLimit,
          (item) => [item.updatedAt, item.sourceId],
        );
    const indexRecords = indexPage.items;
    for (const record of indexRecords) {
      const jobShape = {
        sourceType: record.sourceType,
        scopeType: record.scopeType,
        scopeKey: record.scopeKey,
        recordId: record.recordId,
      };
      const source = embeddingSourceForJob(store, jobShape);
      let reason = null;
      if (!source) reason = 'orphan_source';
      else if (record.sourceType === 'memory' && source.memory.status !== 'active') reason = 'inactive_memory';
      else if (
        record.sourceType === 'memory_candidate' &&
        !['pending', 'promoted'].includes(source.candidate.status)
      ) {
        reason = `candidate_${source.candidate.status}`;
      } else if (source.contentHash !== record.contentHash) reason = 'content_hash_mismatch';
      else if (
        current.authoritative &&
        (record.model !== current.model || Number(record.dimensions) !== current.dimensions)
      ) {
        reason = 'retired_model_or_dimensions';
      }
      if (!reason) continue;
      artifacts.push({ ...record, reason });
      byReason[reason] = (byReason[reason] || 0) + 1;
      bySourceType[record.sourceType] = (bySourceType[record.sourceType] || 0) + 1;
    }
    const vectorPage = narrowed || cursorState.vector.done
      ? { items: [], hasMore: false, state: narrowed ? { done: true, after: null } : cursorState.vector }
      : embeddingMaintenancePage(
          store.listOrphanEmbeddingVectorIds({ limit: scanLimit + 1, after: cursorState.vector.after?.[0] || null }),
          scanLimit,
          (sourceId) => [sourceId],
        );
    const discoveredVectorOnlySourceIds = vectorPage.items;
    const vectorOnlySourceIds = narrowed ? [] : discoveredVectorOnlySourceIds;
    if (vectorOnlySourceIds.length) byReason.vector_without_index = vectorOnlySourceIds.length;

    const jobs = [];
    const jobStatus = store.countEmbeddingJobs(scope);
    const jobPage = cursorState.jobs.done
      ? { items: [], hasMore: false, state: cursorState.jobs }
      : embeddingMaintenancePage(
          store.listTerminalEmbeddingJobs({ ...scope, limit: scanLimit + 1, after: cursorState.jobs.after }),
          scanLimit,
          (item) => [item.updatedAt, item.id],
        );
    const scannedJobs = jobPage.items;
    for (const job of scannedJobs) {
      if (!['completed', 'failed'].includes(job.status)) continue;
      const source = embeddingSourceForJob(store, job);
      let reason = null;
      if (!source) reason = 'orphan_job_source';
      else if (
        current.authoritative &&
        (job.model !== current.model || Number(job.dimensions) !== current.dimensions)
      ) {
        reason = 'retired_job_model_or_dimensions';
      }
      else if (job.status === 'completed' && job.completedAt && job.completedAt < completedBefore) reason = 'old_completed_job';
      if (reason) jobs.push({ id: job.id, sourceType: job.sourceType, recordId: job.recordId, status: job.status, reason });
    }
    for (const job of jobs) byReason[job.reason] = (byReason[job.reason] || 0) + 1;
    const nextState = { index: indexPage.state, vector: vectorPage.state, jobs: jobPage.state };
    const hasMore = Object.values(nextState).some((lane) => !lane.done);
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ v: 1, binding: cursorBinding, ...nextState })).toString('base64url')
      : null;
    return {
      kind: 'embedding_maintenance_inventory',
      scope,
      current,
      modelCounts,
      retiredRisk,
      scanLimit,
      completedJobRetentionDays,
      completedBefore,
      scanned: {
        indexRows: indexRecords.length,
        jobs: scannedJobs.length,
      },
      truncated: {
        indexRows: indexPage.hasMore,
        vectorOnly: vectorPage.hasMore,
        jobs: jobPage.hasMore,
      },
      nextCursor,
      eligible: {
        total: artifacts.length + vectorOnlySourceIds.length + jobs.length,
        artifacts: artifacts.length,
        vectorOnly: vectorOnlySourceIds.length,
        jobs: jobs.length,
      },
      byReason,
      bySourceType,
      jobStatus,
      processingJobs: jobStatus.processing || 0,
      skippedUnknownScopeVectorRows: narrowed ? null : 0,
      artifacts,
      vectorOnlySourceIds,
      jobs,
    };
  }

  async function processEmbeddingJobBatch(store, jobs) {
    const result = {
      processed: 0,
      embedded: 0,
      failed: 0,
      missingSources: 0,
      bySourceType: {},
      errors: [],
    };
    const active = [];
    for (const job of jobs) {
      const claimedJob = store.markEmbeddingJobProcessing(job.id);
      if (!claimedJob) {
        continue;
      }
      const source = embeddingSourceForJob(store, job);
      if (!source || source.contentHash !== job.contentHash) {
        store.markEmbeddingJobFailed(
          job.id,
          new Error(source ? 'Embedding job source content changed; enqueue a fresh job.' : 'Embedding job source not found.'),
        );
        result.failed += 1;
        result.missingSources += source ? 0 : 1;
        continue;
      }
      active.push({ job: claimedJob, source });
    }
    if (active.length === 0) {
      return result;
    }
    let embeddings;
    try {
      embeddings = await embeddingProvider.embed(active.map((item) => item.source.text));
    } catch (error) {
      for (const item of active) {
        store.markEmbeddingJobFailed(item.job.id, error);
        result.failed += 1;
      }
      result.errors.push({ message: error.message, count: active.length });
      return result;
    }
    for (const [index, item] of active.entries()) {
      try {
        store.upsertEmbedding({
          sourceType: item.source.sourceType,
          recordId: item.source.recordId,
          scopeType: item.source.scopeType,
          scopeKey: item.source.scopeKey,
          model: embeddingProvider.model,
          dimensions: embeddingProvider.dimensions,
          contentHash: item.source.contentHash,
          embedding: embeddings[index],
        });
        store.markEmbeddingJobCompleted(item.job.id);
        result.processed += 1;
        result.embedded += 1;
        result.bySourceType[item.source.sourceType] = (result.bySourceType[item.source.sourceType] || 0) + 1;
      } catch (error) {
        store.markEmbeddingJobFailed(item.job.id, error);
        result.failed += 1;
        result.errors.push({ message: error.message, sourceType: item.source.sourceType, recordId: item.source.recordId });
      }
    }
    return result;
  }

  function embeddingFailureResult(error) {
    const progress = error.embeddingProgress || {};
    return {
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      scanned: progress.scanned ?? null,
      embedded: progress.embedded || 0,
      bySourceType: progress.bySourceType || {},
      skipped: false,
      partialFailure: Boolean(progress.embedded),
      reason: 'embedding_failed',
      error: {
        name: error.name,
        message: error.message,
      },
    };
  }

  return {
    enqueueEmbeddingSources,
    embeddingMaintenanceInventory,
    processEmbeddingJobBatch,
    embeddingFailureResult,
  };
}
