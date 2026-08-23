import { positiveInteger, positiveNumber, requireOption, truthyOption } from '../common.js';
import { errorUsageMetadata, providerModelFromMetadata, recordLlmUsageEvent } from '../application/llm_usage.js';
import { createDistillProvider } from '../distill/index.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION, validateDistillOutput } from '../distill/validate.js';
import { providerFailureRetryable } from '../runtime/provider_execution.js';
import { normalizeScopeOptions } from '../scopes/index.js';

// Consolidation rolls a window of checkpoints into one higher-level
// checkpoint. The window/source normalizers and buildConsolidationPlan are
// pure, so they live at module scope here; core.js imports
// normalizeCheckpointSource back because distillCheckpoint shares it.
//
// The operations spread into the app object by core.js. Everything they
// capture from the createContextForge closure — the store accessor, the
// runtime resolver, the distill provider handles, the embedding enqueue —
// arrives through consolidationMethods() arguments.
//
// Nothing here may import core.js: core.js imports this module.

const CHECKPOINT_SOURCES = new Set(['distill', 'daily_consolidation', 'weekly_consolidation', 'topic_batch', 'manual']);
const CONSOLIDATION_TARGETS = new Set(['thread', 'repo']);
const CONSOLIDATION_WINDOWS = new Set(['daily', 'custom']);

export function normalizeCheckpointSource(source) {
  const value = source ?? 'distill';
  if (!CHECKPOINT_SOURCES.has(value)) {
    throw new Error(`source must be one of: ${Array.from(CHECKPOINT_SOURCES).join(', ')}.`);
  }
  return value;
}

function normalizeConsolidationTarget(target) {
  const value = target || 'repo';
  if (!CONSOLIDATION_TARGETS.has(value)) {
    throw new Error(`target must be one of: ${Array.from(CONSOLIDATION_TARGETS).join(', ')}.`);
  }
  return value;
}

function normalizeWindowKind(windowKind) {
  const value = windowKind || 'daily';
  if (!CONSOLIDATION_WINDOWS.has(value)) {
    throw new Error(`windowKind must be one of: ${Array.from(CONSOLIDATION_WINDOWS).join(', ')}.`);
  }
  return value;
}

function isoDatePart(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

function dailyWindow(day) {
  const datePart = isoDatePart(day);
  const start = new Date(`${datePart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    coversFrom: start.toISOString(),
    coversTo: end.toISOString(),
    sourceRefDate: datePart,
  };
}

function normalizeConsolidationWindow(options) {
  const windowKind = normalizeWindowKind(options.windowKind || options.window);
  if (windowKind === 'daily') {
    const day = options.day || options.sourceRef || options.coversFrom || new Date().toISOString();
    return {
      windowKind,
      ...dailyWindow(day),
    };
  }
  requireOption(options.coversFrom, 'coversFrom');
  requireOption(options.coversTo, 'coversTo');
  const start = new Date(options.coversFrom);
  const end = new Date(options.coversTo);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error('coversFrom and coversTo must define a valid forward time window.');
  }
  return {
    windowKind,
    coversFrom: start.toISOString(),
    coversTo: end.toISOString(),
    sourceRefDate: `${start.toISOString()}..${end.toISOString()}`,
  };
}

function consolidationSourceRef({ target, scope, sessionId, window }) {
  const subject = target === 'thread' ? sessionId : scope.scopeKey;
  return `${target}:${subject}:${window.sourceRefDate}`;
}

function consolidationSessionId({ target, scope, sessionId, sourceRef }) {
  if (target === 'thread') {
    return `consolidation:thread:${sessionId}:${sourceRef}`;
  }
  return `consolidation:repo:${scope.scopeKey}:${sourceRef}`;
}

function isConsolidationCheckpoint(checkpoint) {
  return Boolean(checkpoint?.metadata?.consolidation);
}

function compactSourceCheckpoint(checkpoint) {
  const sourceProvenance = checkpoint.metadata?.sourceProvenance || null;
  return {
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    conversationId: checkpoint.conversationId,
    summaryShort: checkpoint.summaryShort,
    summaryText: checkpoint.summaryText,
    decisions: checkpoint.decisions,
    todos: checkpoint.todos,
    openQuestions: checkpoint.openQuestions,
    provider: checkpoint.provider,
    source: checkpoint.source,
    sourceRef: checkpoint.sourceRef,
    coversFrom: checkpoint.coversFrom,
    coversTo: checkpoint.coversTo,
    createdAt: checkpoint.createdAt,
    sourceProvenance,
    structured: checkpoint.structured || checkpoint.metadata?.structured || null,
  };
}

function checkpointText(checkpoint) {
  return [
    checkpoint.summaryShort,
    checkpoint.summaryText,
    ...(checkpoint.decisions || []),
    ...(checkpoint.todos || []),
    ...(checkpoint.openQuestions || []),
    checkpoint.structured || checkpoint.metadata?.structured
      ? JSON.stringify(checkpoint.structured || checkpoint.metadata.structured)
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function isSqliteConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function providerInputTruncated(metadata) {
  return Boolean(metadata?.codexExec?.inputTruncated || metadata?.openAiCompatible?.inputTruncated);
}

function buildConsolidationPlan(store, scope, options = {}) {
  const target = normalizeConsolidationTarget(options.target);
  const window = normalizeConsolidationWindow(options);
  const sessionId = options.sessionId || null;
  if (target === 'thread') {
    requireOption(sessionId, 'sessionId');
  }
  const source = normalizeCheckpointSource(options.source || 'daily_consolidation');
  const sourceRef = options.sourceRef || consolidationSourceRef({ target, scope, sessionId, window });
  const existing = store.findConsolidationCheckpoint({
    ...scope,
    target,
    source,
    sourceRef,
  });
  const maxCheckpoints = positiveInteger(options.maxCheckpoints == null ? 100 : Number(options.maxCheckpoints), 'maxCheckpoints');
  const maxChars = positiveNumber(options.maxChars == null ? 20000 : Number(options.maxChars), 'maxChars');
  const minCheckpoints = positiveInteger(options.minCheckpoints == null ? 2 : Number(options.minCheckpoints), 'minCheckpoints');
  const sourceCheckpoints = existing
    ? []
    : store
        .listCheckpointsForConsolidation({
          ...scope,
          sessionId: target === 'thread' ? sessionId : null,
          coversFrom: window.coversFrom,
          coversTo: window.coversTo,
          limit: maxCheckpoints,
        })
        .filter((checkpoint) => !isConsolidationCheckpoint(checkpoint));
  let selectedCharCount = 0;
  let inputTruncated = false;
  const selected = [];
  for (const checkpoint of sourceCheckpoints) {
    const chars = checkpointText(checkpoint).length;
    if (selectedCharCount + chars > maxChars) {
      inputTruncated = true;
      break;
    }
    selected.push(checkpoint);
    selectedCharCount += chars;
  }
  const eligible = !existing && selected.length >= minCheckpoints;
  const syntheticSessionId = consolidationSessionId({ target, scope, sessionId, sourceRef });
  return {
    target,
    windowKind: window.windowKind,
    coversFrom: window.coversFrom,
    coversTo: window.coversTo,
    source,
    sourceRef,
    sessionId: syntheticSessionId,
    sourceSessionId: sessionId,
    eligible,
    noOp: !eligible,
    reason: existing ? 'already_exists' : selected.length < minCheckpoints ? 'below_min_checkpoints' : 'ready',
    existingCheckpointId: existing?.id || null,
    sourceCheckpointCount: selected.length,
    selectedCharCount,
    inputTruncated,
    sourceCheckpointIds: selected.map((checkpoint) => checkpoint.id),
    sourceSessionIds: [...new Set(selected.map((checkpoint) => checkpoint.sessionId).filter(Boolean))],
    sourceAgents: [
      ...new Set(
        selected
          .map((checkpoint) => checkpoint.metadata?.sourceProvenance?.sourceAgent)
          .filter(Boolean),
      ),
    ],
    sourceCheckpoints: selected,
  };
}

function consolidationRequestedOutputSchema() {
  return {
    summaryShort: 'string',
    summaryText: 'string',
    decisions: 'string[]',
    todos: 'string[]',
    openQuestions: 'string[]',
    workingSummary: 'string',
    structured: {
      schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
      optional: true,
    },
    memoryCandidates: 'object[]',
    sourceEventCount: 'number',
    provider: 'string',
    metadata: 'object',
  };
}

export function consolidationMethods({
  config,
  useStore,
  memoryLifecycleForScope,
  getEffectiveRuntime,
  distillProviders,
  codexExec,
  runtimeFetchImpl,
  runDistillProvider,
  embeddingProvider,
  enqueueEmbeddingSources,
}) {
  return {
    listDueConsolidations(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => {
        const plan = buildConsolidationPlan(store, scope, options);
        const { sourceCheckpoints, ...publicPlan } = plan;
        return {
          scope,
          dryRun: true,
          count: plan.eligible ? 1 : 0,
          items: [publicPlan],
          memoryLifecycle: memoryLifecycleForScope(store, scope),
        };
      });
    },

    async processConsolidations(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      const dryRun = options.dryRun == null ? false : truthyOption(options.dryRun);
      return useStore(async (store) => {
        const plan = buildConsolidationPlan(store, scope, options);
        const { sourceCheckpoints, ...publicPlan } = plan;
        const result = {
          scope,
          dryRun,
          processed: 0,
          created: 0,
          skipped: plan.eligible ? 0 : 1,
          items: [publicPlan],
          checkpoint: null,
          embedding: null,
          memoryLifecycle: memoryLifecycleForScope(store, scope),
        };
        if (dryRun || !plan.eligible) {
          return result;
        }

        const effective = getEffectiveRuntime(store);
        const provider = createDistillProvider(options.provider || effective.distillProvider, distillProviders, {
          codexExec: {
            ...effective.codexExec,
            runner: codexExec.runner,
          },
          openAiCompatible: {
            ...effective.openAiCompatible,
            fetchImpl: runtimeFetchImpl,
          },
        });
        const providerMetadata = provider.metadata || {};
        const distillRun = store.startDistillRun({
          ...scope,
          sessionId: plan.sessionId,
          conversationId: options.conversationId || null,
          provider: provider.name,
          sourceEventCount: plan.sourceCheckpointCount,
          inputMetadata: {
            sourceCheckpointIds: plan.sourceCheckpointIds,
            sourceSessionIds: plan.sourceSessionIds,
            sourceAgents: plan.sourceAgents,
            consolidation: publicPlan,
            providerMetadata,
          },
        });
        let rawOutput;
        try {
          rawOutput = await runDistillProvider(
            provider,
            {
              session: {
                ...scope,
                sessionId: plan.sessionId,
                conversationId: options.conversationId || null,
              },
              consolidation: {
                target: plan.target,
                windowKind: plan.windowKind,
                coversFrom: plan.coversFrom,
                coversTo: plan.coversTo,
                sourceRef: plan.sourceRef,
                sourceCheckpointCount: plan.sourceCheckpointCount,
                inputTruncated: plan.inputTruncated,
              },
              sourceCheckpoints: sourceCheckpoints.map(compactSourceCheckpoint),
              rawEvents: [],
              previousCheckpoint: null,
              previousWorkingSummary: null,
              previousSessionWorkingContext: null,
              requestedOutputSchema: consolidationRequestedOutputSchema(),
            },
            options._clientTimeoutMs,
          );
        } catch (error) {
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_consolidation',
            provider: provider.name,
            model: providerModelFromMetadata(errorUsageMetadata(error), providerMetadata.model),
            status: 'failed',
            sessionId: plan.sessionId,
            distillRunId: distillRun.id,
            metadata: errorUsageMetadata(error),
            startedAt: distillRun.createdAt,
            completedAt: new Date().toISOString(),
          });
          store.failDistillRun({
            id: distillRun.id,
            error,
            outputMetadata: {
              providerFailed: true,
              retryable: providerFailureRetryable(error),
              providerMetadata,
            },
          });
          throw error;
        }

        let output;
        try {
          output = validateDistillOutput(rawOutput);
        } catch (error) {
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_consolidation',
            provider: provider.name,
            model: providerModelFromMetadata(rawOutput?.metadata || {}, providerMetadata.model),
            status: 'failed',
            sessionId: plan.sessionId,
            distillRunId: distillRun.id,
            metadata: rawOutput?.metadata || {},
            startedAt: distillRun.createdAt,
            completedAt: new Date().toISOString(),
          });
          store.failDistillRun({
            id: distillRun.id,
            error,
            outputMetadata: {
              validationFailed: true,
              retryable: false,
              providerMetadata,
            },
          });
          throw error;
        }
        const memoryCandidates = output.memoryCandidates.slice(0, 3);
        const inputTruncated = plan.inputTruncated || providerInputTruncated(output.metadata);
        const lifecycle = result.memoryLifecycle;
        let checkpoint;
        try {
          checkpoint = store.insertCheckpoint({
            ...scope,
            sessionId: plan.sessionId,
            conversationId: options.conversationId || null,
            summaryShort: output.summaryShort,
            summaryText: output.summaryText,
            decisions: output.decisions,
            todos: output.todos,
            openQuestions: output.openQuestions,
            sourceEventCount: output.sourceEventCount ?? plan.sourceCheckpointCount,
            provider: output.provider || provider.name,
            distillRunId: distillRun.id,
            level: 1,
            coversFrom: plan.coversFrom,
            coversTo: plan.coversTo,
            source: plan.source,
            sourceRef: plan.sourceRef,
            metadata: {
              providerMetadata: output.metadata,
              memoryCandidates,
              structured: output.structured || null,
              consolidation: {
                target: plan.target,
                windowKind: plan.windowKind,
                sourceCheckpointIds: plan.sourceCheckpointIds,
                sourceSessionIds: plan.sourceSessionIds,
                sourceAgents: plan.sourceAgents,
                sourceCheckpointWindow: {
                  coversFrom: plan.coversFrom,
                  coversTo: plan.coversTo,
                },
                selectedCharCount: plan.selectedCharCount,
                inputTruncated,
              },
            },
          });
        } catch (error) {
          const existing = isSqliteConstraintError(error)
            ? store.findConsolidationCheckpoint({
                ...scope,
                target: plan.target,
                source: plan.source,
                sourceRef: plan.sourceRef,
              })
            : null;
          if (existing) {
            recordLlmUsageEvent(store, {
              scope,
              operation: 'checkpoint_consolidation',
              provider: output.provider || provider.name,
              model: providerModelFromMetadata(output.metadata, providerMetadata.model),
              status: 'succeeded',
              sessionId: plan.sessionId,
              distillRunId: distillRun.id,
              checkpointId: existing.id,
              metadata: output.metadata,
              startedAt: distillRun.createdAt,
              completedAt: new Date().toISOString(),
            });
            store.failDistillRun({
              id: distillRun.id,
              error,
              outputMetadata: {
                duplicateConsolidation: true,
                existingCheckpointId: existing.id,
                providerMetadata: output.metadata,
              },
            });
            return {
              ...result,
              processed: 1,
              created: 0,
              skipped: 1,
              items: [
                {
                  ...publicPlan,
                  eligible: false,
                  noOp: true,
                  reason: 'already_exists',
                  existingCheckpointId: existing.id,
                },
              ],
              checkpoint: existing,
              memoryCandidateCount: 0,
              embedding: null,
              memoryLifecycle: lifecycle,
            };
          }
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_consolidation',
            provider: output.provider || provider.name,
            model: providerModelFromMetadata(output.metadata, providerMetadata.model),
            status: 'succeeded',
            sessionId: plan.sessionId,
            distillRunId: distillRun.id,
            metadata: output.metadata,
            startedAt: distillRun.createdAt,
            completedAt: new Date().toISOString(),
          });
          store.failDistillRun({
            id: distillRun.id,
            error,
            outputMetadata: {
              checkpointInsertFailed: true,
              providerMetadata: output.metadata,
            },
          });
          throw error;
        }
        const completedAt = new Date().toISOString();
        recordLlmUsageEvent(store, {
          scope,
          operation: 'checkpoint_consolidation',
          provider: output.provider || provider.name,
          model: providerModelFromMetadata(output.metadata, providerMetadata.model),
          status: 'succeeded',
          sessionId: plan.sessionId,
          distillRunId: distillRun.id,
          checkpointId: checkpoint.id,
          metadata: output.metadata,
          startedAt: distillRun.createdAt,
          completedAt,
          elapsedMs: Date.parse(completedAt) - Date.parse(distillRun.createdAt),
        });
        store.completeDistillRun({
          id: distillRun.id,
          outputMetadata: {
            checkpointId: checkpoint.id,
            provider: checkpoint.provider,
            memoryCandidateCount: memoryCandidates.length,
            providerMetadata: output.metadata,
            consolidation: {
              target: plan.target,
              windowKind: plan.windowKind,
              sourceRef: plan.sourceRef,
              sourceCheckpointCount: plan.sourceCheckpointCount,
              inputTruncated,
            },
          },
        });
        let embedding = {
          provider: config.embeddings.provider,
          skipped: true,
          reason: 'embeddings_disabled',
          queued: 0,
          bySourceType: {},
        };
        if (embeddingProvider) {
          const candidates = store.listMemoryCandidates({
            ...scope,
            checkpointId: checkpoint.id,
          });
          embedding = enqueueEmbeddingSources(store, [
            store.embeddingSourceForCheckpoint(checkpoint),
            ...candidates.map((candidate) => store.embeddingSourceForMemoryCandidate(candidate)),
          ]);
          embedding.reason ||= embedding.queued > 0 ? 'queued' : 'up_to_date';
        }
        return {
          ...result,
          processed: 1,
          created: 1,
          skipped: 0,
          checkpoint,
          memoryCandidateCount: memoryCandidates.length,
          embedding,
          memoryLifecycle: lifecycle,
        };
      });
    },
  };
}
