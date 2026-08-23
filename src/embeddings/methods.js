import { pagedList } from '../application/paged_list.js';
import { positiveInteger, positiveNumber, truthyOption } from '../common.js';
import { normalizeScopeOptions } from '../scopes/index.js';

// The embedding operations spread into the app object by core.js. They are
// written as object-literal shorthand methods because rebuildEmbeddings
// delegates through `this` to processEmbeddingJobs — arrow functions would
// break that, and src/mcp.js dispatches these as app[operation.name](args).
//
// The job-level helpers come in from embeddingJobHelpers() rather than being
// re-derived here, so both this module and core.js share one set of closures.
//
// Nothing here may import core.js: core.js imports this module.
export function embeddingMethods({
  config,
  embeddingProvider,
  useStore,
  embeddingMaintenanceInventory,
  enqueueEmbeddingSources,
  processEmbeddingJobBatch,
}) {
  return {
    embeddingInventory(options = {}) {
      return useStore((store) => embeddingMaintenanceInventory(store, options));
    },

    pruneEmbeddingArtifacts(options = {}) {
      const dryRun = options.dryRun !== false;
      const force = options.force === true;
      const includeRetired = options.includeRetired === true;
      const confirmMassRetired = options.confirmMassRetired === true;
      const includeInventory = options.includeInventory === true;
      const batchSize = Math.min(500, positiveInteger(options.batchSize == null ? 100 : options.batchSize, 'batchSize'));
      return useStore((store) => {
        const inventory = embeddingMaintenanceInventory(store, options);
        const eligibleArtifacts = inventory.artifacts.filter(
          (item) => includeRetired || item.reason !== 'retired_model_or_dimensions',
        );
        const eligibleJobs = inventory.jobs.filter(
          (item) => includeRetired || item.reason !== 'retired_job_model_or_dimensions',
        );
        let remaining = batchSize;
        const artifacts = eligibleArtifacts.slice(0, remaining);
        remaining -= artifacts.length;
        const vectorOnly = inventory.vectorOnlySourceIds.slice(0, remaining).map((sourceId) => ({
          sourceId,
          sourceType: sourceId.includes(':') ? sourceId.slice(0, sourceId.indexOf(':')) : 'unknown',
          reason: 'vector_without_index',
        }));
        remaining -= vectorOnly.length;
        const jobs = eligibleJobs.slice(0, remaining);
        const eligibleOnPage = eligibleArtifacts.length + inventory.vectorOnlySourceIds.length + eligibleJobs.length;
        const reindexSuggestedSourceIds = artifacts
          .filter((item) => item.reason === 'content_hash_mismatch')
          .map((item) => item.sourceId);
        const { artifacts: _artifacts, vectorOnlySourceIds: _vectorOnlySourceIds, jobs: _jobs, ...inventorySummary } =
          inventory;
        const plan = {
          artifacts,
          vectorOnly,
          jobs,
          total: artifacts.length + vectorOnly.length + jobs.length,
        };
        const batchCapped = plan.total < eligibleOnPage;
        const needsRescan = !dryRun && batchCapped;
        const nextCursor = needsRescan ? options.cursor || null : inventory.nextCursor;
        const base = {
          kind: 'embedding_maintenance_gc',
          dryRun,
          force,
          includeRetired,
          confirmMassRetired,
          includeInventory,
          batchSize,
          inventory: includeInventory ? inventory : inventorySummary,
          nextCursor,
          needsRescan,
          batchCapped,
          eligibleOnPage,
          plan,
          skippedRetiredArtifacts: inventory.artifacts.length - eligibleArtifacts.length,
          skippedRetiredJobs: inventory.jobs.length - eligibleJobs.length,
          reindexSuggestedSourceIds,
          blocked: false,
          deleted: { vectors: 0, indexRows: 0, jobs: 0 },
          warnings: [
            'Back up the canonical SQLite store and stop embedding workers before non-dry-run GC.',
            'Run incremental_vacuum separately when file-size reclamation is required.',
            ...(!inventory.current.authoritative
              ? ['Retired model/dimension classification is disabled because no embedding provider is active.']
              : []),
            ...(inventory.artifacts.length > eligibleArtifacts.length || inventory.jobs.length > eligibleJobs.length
              ? ['Retired model/dimension artifacts are excluded unless includeRetired=true is explicit.']
              : []),
            ...(inventory.retiredRisk
              ? ['Most indexed rows differ from the active provider; destructive retired cleanup requires confirmMassRetired=true.']
              : []),
            ...(reindexSuggestedSourceIds.length
              ? ['Content-hash mismatch removals require embedding job processing or an intentional rebuild.']
              : []),
            ...(needsRescan
              ? ['The current scan page exceeded batchSize; repeat with the same input cursor before advancing.']
              : []),
          ],
        };
        if (!dryRun && inventory.processingJobs > 0 && !force) {
          return {
            ...base,
            blocked: true,
            blockedReason: 'embedding_jobs_processing',
            blockedRetry: true,
            needsRescan: true,
            nextCursor: options.cursor || null,
          };
        }
        if (!dryRun && includeRetired && inventory.retiredRisk && !confirmMassRetired) {
          return {
            ...base,
            blocked: true,
            blockedReason: 'mass_retired_confirmation_required',
            blockedRetry: true,
            needsRescan: true,
            nextCursor: options.cursor || null,
          };
        }
        if (dryRun || plan.total === 0) {
          return {
            ...base,
            coverage: store.embeddingCoverage({
              scopeType: inventory.scope.scopeType,
              scopeKey: inventory.scope.scopeKey,
              model: inventory.current.model,
              dimensions: inventory.current.dimensions,
            }),
          };
        }
        const deleted = store.deleteEmbeddingMaintenanceBatch({
          sourceIds: artifacts.map((item) => item.sourceId),
          vectorOnlySourceIds: vectorOnly.map((item) => item.sourceId),
          jobIds: jobs.map((item) => item.id),
        });
        return {
          ...base,
          deleted,
          coverage: store.embeddingCoverage({
            scopeType: inventory.scope.scopeType,
            scopeKey: inventory.scope.scopeKey,
            model: inventory.current.model,
            dimensions: inventory.current.dimensions,
          }),
        };
      });
    },

    async rebuildEmbeddings(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      if ((options.scope == null || options.scope === '') !== (options.scopeKey == null || options.scopeKey === '')) {
        throw new Error('rebuildEmbeddings requires both scope and scopeKey when either option is provided.');
      }
      if (!embeddingProvider) {
        return {
          provider: config.embeddings.provider,
          skipped: true,
          reason: 'embeddings_disabled',
          embedded: 0,
        };
      }
      const batchSize = positiveNumber(options.batchSize == null ? 32 : Number(options.batchSize), 'batchSize');
      return useStore(async (store) => {
        store.ensureEmbeddingIndex(embeddingProvider.dimensions, { resetOnDimensionChange: truthyOption(options.force) });
        const shouldNarrowScope = Boolean(options.scope || options.scopeKey || options.cwd || options.repoPath);
        const sourceOptions = {
          scopeType: shouldNarrowScope ? scope.scopeType : null,
          scopeKey: shouldNarrowScope ? scope.scopeKey : null,
          model: embeddingProvider.model,
          dimensions: embeddingProvider.dimensions,
          force: truthyOption(options.force),
        };
        const sources = [
          ...store.listMemoryEmbeddingSources(sourceOptions),
          ...store.listCheckpointEmbeddingSources(sourceOptions),
          ...store.listMemoryCandidateEmbeddingSources(sourceOptions),
        ];
        const queued = enqueueEmbeddingSources(store, sources, { force: truthyOption(options.force) });
        const processed = await this.processEmbeddingJobs({
          ...(shouldNarrowScope ? { scope: scope.scopeType, scopeKey: scope.scopeKey } : {}),
          batchSize,
          limit: Math.max(sources.length, 1),
        });
        return {
          ...processed,
          provider: embeddingProvider.name,
          model: embeddingProvider.model,
          dimensions: embeddingProvider.dimensions,
          scanned: sources.length,
          queued: queued.queued,
          bySourceType: processed.bySourceType,
          skipped: false,
        };
      });
    },

    async processEmbeddingJobs(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      if (!embeddingProvider) {
        return {
          provider: config.embeddings.provider,
          skipped: true,
          reason: 'embeddings_disabled',
          processed: 0,
          embedded: 0,
          failed: 0,
        };
      }
      const batchSize = positiveNumber(options.batchSize == null ? 32 : Number(options.batchSize), 'batchSize');
      const limit = positiveNumber(options.limit == null ? 50 : Number(options.limit), 'limit');
      const staleAfterMs =
        options.staleAfterMs == null
          ? config.embeddings.staleAfterMs
          : positiveNumber(Number(options.staleAfterMs), 'staleAfterMs');
      return useStore(async (store) => {
        store.ensureEmbeddingIndex(embeddingProvider.dimensions, { resetOnDimensionChange: truthyOption(options.force) });
        const shouldNarrowScope = Boolean(options.scope || options.scopeKey || options.cwd || options.repoPath);
        const listOptions = {
          scopeType: shouldNarrowScope ? scope.scopeType : null,
          scopeKey: shouldNarrowScope ? scope.scopeKey : null,
          limit,
        };
        const staleReset = store.resetStaleEmbeddingJobs({
          scopeType: listOptions.scopeType,
          scopeKey: listOptions.scopeKey,
          staleBeforeIso: new Date(Date.now() - staleAfterMs).toISOString(),
        });
        const pending = store.listEmbeddingJobs({ ...listOptions, status: 'pending' });
        const failed = truthyOption(options.retryFailed)
          ? store.listEmbeddingJobs({ ...listOptions, status: 'failed', limit: Math.max(0, limit - pending.length) })
          : [];
        const jobs = [...pending, ...failed].slice(0, limit);
        const aggregate = {
          provider: embeddingProvider.name,
          model: embeddingProvider.model,
          dimensions: embeddingProvider.dimensions,
          skipped: false,
          // noOp means no embedding jobs were scanned or embedded; setup and stale-job reset may still run.
          noOp: jobs.length === 0,
          scanned: jobs.length,
          processed: 0,
          embedded: 0,
          failed: 0,
          missingSources: 0,
          bySourceType: {},
          errors: [],
          staleReset,
        };
        if (jobs.length === 0) {
          aggregate.jobs = store.countEmbeddingJobs({
            scopeType: listOptions.scopeType,
            scopeKey: listOptions.scopeKey,
          });
          return aggregate;
        }
        for (let index = 0; index < jobs.length; index += batchSize) {
          const batch = jobs.slice(index, index + batchSize);
          const result = await processEmbeddingJobBatch(store, batch);
          aggregate.processed += result.processed;
          aggregate.embedded += result.embedded;
          aggregate.failed += result.failed;
          aggregate.missingSources += result.missingSources;
          aggregate.errors.push(...result.errors);
          for (const [sourceType, count] of Object.entries(result.bySourceType)) {
            aggregate.bySourceType[sourceType] = (aggregate.bySourceType[sourceType] || 0) + count;
          }
        }
        aggregate.jobs = store.countEmbeddingJobs({
          scopeType: listOptions.scopeType,
          scopeKey: listOptions.scopeKey,
        });
        return aggregate;
      });
    },

    listEmbeddingJobs(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      const shouldNarrowScope = Boolean(options.scope || options.scopeKey || options.cwd || options.repoPath);
      const filters = {
        scopeType: shouldNarrowScope ? scope.scopeType : null,
        scopeKey: shouldNarrowScope ? scope.scopeKey : null,
        status: options.status || null,
      };
      return useStore((store) =>
        pagedList({
          kind: 'embedding_jobs',
          filters,
          options,
          load: ({ limit, after }) => store.listEmbeddingJobs({ ...filters, limit, after }),
          positionForItem: (item) => [item.updatedAt, item.id],
        }),
      );
    },
  };
}
