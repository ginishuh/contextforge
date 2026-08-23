import { randomUUID } from 'node:crypto';
import { errorSummary, positiveNumber, requireOption } from '../common.js';
import {
  errorUsageMetadata,
  providerModelFromMetadata,
  recordLlmUsageEvent,
} from '../application/llm_usage.js';
import { createDistillProvider } from './index.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION, validateDistillOutput } from './validate.js';
import { normalizeCheckpointSource } from '../memory/consolidation.js';
import {
  AUDIT_CANDIDATE_CATEGORIES,
  AUDIT_CANDIDATE_SKIP_WARNING_CODES,
  AUTO_PROMOTE_SKIP_WARNING_CODES,
  SAFE_AUTO_PROMOTE_CATEGORIES,
  auditAutoPromotionCandidate,
  auditCandidateWarnings,
  autoPromoteIndexedCandidate,
  autoPromotionWarnings,
  recordCandidateAuditUsageEvent,
  scorePromotionCandidate,
} from '../memory/candidate_promotion.js';
import {
  assertProviderTimeoutFitsClient,
  providerFailureRetryable,
  runInFlightOnce,
  runWithKeyedLock,
} from '../runtime/provider_execution.js';
import { normalizeScopeOptions } from '../scopes/index.js';

// distillCheckpoint turns a session's raw event window into a level-0
// checkpoint, then runs the candidate audit that the checkpoint unlocked.
// coverageFromEvents/sourceProvenanceFromEvents are pure and used only by this
// operation, so they live at module scope here.
//
// Everything the operation captures from the createContextForge closure -- the
// store accessor, the in-flight/lock key builders, the runtime resolvers, the
// provider handles, the embedding enqueue, and the core-scoped helpers shared
// with other operations (CLOSEOUT_TRIGGERS, retryableAuditJobError,
// selectDistillWindow, sessionWorkingContextInput,
// rethrowExternalProviderTestError) -- arrives through distillMethods()
// arguments.
//
// distillCheckpoint stays a shorthand method: it calls
// this.auditMemoryCandidates on the spread-into app object.
//
// Nothing here may import core.js: core.js imports this module.

function coverageFromEvents(events) {
  return {
    coversFrom: events[0]?.createdAt || null,
    coversTo: events.at(-1)?.createdAt || null,
  };
}

function commonMetadataValue(rawEvents, key) {
  const values = new Set(rawEvents.map((event) => event.metadata?.[key]).filter(Boolean));
  return values.size === 1 ? [...values][0] : null;
}

function sourceProvenanceFromEvents(rawEvents) {
  const provenance = {};
  for (const key of ['sourceAgent', 'sourceRuntime', 'sourceAdapter', 'nativeSessionId']) {
    const value = commonMetadataValue(rawEvents, key);
    if (value) {
      provenance[key] = value;
    }
  }
  return provenance;
}

export function distillMethods({
  config,
  useStore,
  operationKey,
  auditSourceKey,
  runDistillProvider,
  getEffectiveRuntime,
  getAutoPromoteAuditor,
  distillProviders,
  codexExec,
  runtimeFetchImpl,
  embeddingProvider,
  enqueueEmbeddingSources,
  embeddingFailureResult,
  providerConcurrencyLimit,
  CLOSEOUT_TRIGGERS,
  retryableAuditJobError,
  selectDistillWindow,
  sessionWorkingContextInput,
  rethrowExternalProviderTestError,
}) {
  return {
    async distillCheckpoint(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');

      const inFlightKey = operationKey('distill_checkpoint', scope, options.jobId || options.sessionId);
      return runInFlightOnce(inFlightKey, () => useStore(async (store) => {
        if (options.jobId) {
          const existingCheckpoint = store.findCheckpointByJobId({ ...scope, jobId: options.jobId });
          if (existingCheckpoint) {
            const auditTrigger = options.auditTrigger || options.trigger || null;
            if (!CLOSEOUT_TRIGGERS.has(auditTrigger)) return existingCheckpoint;
            const recoveryEffective = getEffectiveRuntime(store);
            const recoveryAuditConfig = recoveryEffective.autoPromoteAudit || {};
            const recoveryMinBatchCandidates = Number(recoveryAuditConfig.minBatchCandidates || 5);
            const recoveryBatchLimit = Math.min(10, Number(recoveryAuditConfig.batchLimit || 5));
            const recoveryScanLimit = Math.max(
              recoveryMinBatchCandidates,
              recoveryBatchLimit,
              1,
            ) * 10;
            const auditResult = await this.auditMemoryCandidates({
              ...scope,
              sessionId: options.sessionId,
              trigger: auditTrigger,
              limit: recoveryBatchLimit,
              scanLimit: recoveryScanLimit,
              jobId: options.jobId,
              _jobLeaseOwner: options._jobLeaseOwner,
              _jobLeaseAttempt: options._jobLeaseAttempt,
              _clientTimeoutMs: options._clientTimeoutMs,
            });
            const recoveredResult = {
              ...existingCheckpoint,
              memoryCandidateCount: Array.isArray(existingCheckpoint.metadata?.memoryCandidates)
                ? existingCheckpoint.metadata.memoryCandidates.length
                : null,
              candidateAudit: auditResult.policy?.audit || null,
              recoveredFromOperationJob: true,
            };
            if (auditResult.policy?.audit?.needsRetry === true) {
              throw retryableAuditJobError(recoveredResult, auditResult.policy.audit);
            }
            const incompleteRun = store.getLatestDistillRunByJobId(options.jobId);
            if (incompleteRun?.outputMetadata?.candidateAuditIncomplete === true) {
              store.completeDistillRun({
                id: incompleteRun.id,
                outputMetadata: {
                  ...incompleteRun.outputMetadata,
                  candidateAuditIncomplete: false,
                  candidateAuditRecovered: true,
                  candidateAudit: auditResult.policy?.audit || null,
                  recoveredAt: new Date().toISOString(),
                },
              });
            }
            return recoveredResult;
          }
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
        const rawEvents = store.listRawEvents({ ...scope, sessionId: options.sessionId });
        const previousCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId, level: 0 });
        const previousWorkingSummary = store.getWorkingSummary({ ...scope, sessionId: options.sessionId });
        const previousSessionWorkingContext = store.getSessionWorkingContext({ ...scope, sessionId: options.sessionId });
        const policy = {
          maxEvents: positiveNumber(
            options.maxEvents == null ? effective.distillPolicy.maxEvents : Number(options.maxEvents),
            'maxEvents',
          ),
          maxChars: positiveNumber(
            options.maxChars == null ? effective.distillPolicy.maxChars : Number(options.maxChars),
            'maxChars',
          ),
        };
        const distillWindow = selectDistillWindow(rawEvents, previousCheckpoint, policy);
        const selectedRawEvents = distillWindow.events;
        const coverage = coverageFromEvents(selectedRawEvents);
        const sourceProvenance = sourceProvenanceFromEvents(selectedRawEvents);
        const conversationId =
          options.conversationId || rawEvents.find((event) => event.conversationId)?.conversationId || null;
        const checkpointLevel = options.level == null ? 0 : Number(options.level);
        if (!Number.isInteger(checkpointLevel) || checkpointLevel < 0) {
          throw new Error('level must be a non-negative integer.');
        }
        const requestedOutputSchema = {
          summaryShort: 'string',
          summaryText: 'string',
          decisions: 'string[]',
          todos: 'string[]',
          openQuestions: 'string[]',
          workingSummary: 'string',
          sessionWorkingContext: 'object?',
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            optional: true,
          },
          memoryCandidates: 'object[]',
          sourceEventCount: 'number',
          provider: 'string',
          metadata: 'object',
        };
        const distillRun = store.startDistillRun({
          ...scope,
          sessionId: options.sessionId,
          conversationId,
          jobId: options.jobId || null,
          provider: provider.name,
          sourceEventCount: selectedRawEvents.length,
          inputMetadata: {
            rawEventIds: selectedRawEvents.map((event) => event.id),
            previousCheckpointId: previousCheckpoint?.id || null,
            previousWorkingSummaryId: previousWorkingSummary?.id || null,
            previousSessionWorkingContextId: previousSessionWorkingContext?.id || null,
            requestedOutputSchema,
            providerMetadata,
            sourceProvenance,
            sourceEventWindow: distillWindow.metadata,
            operationJobId: options.jobId || null,
          },
        });

        let rawOutput;
        try {
          rawOutput = await runDistillProvider(
            provider,
            {
              session: {
                ...scope,
                sessionId: options.sessionId,
                conversationId,
              },
              rawEvents: selectedRawEvents,
              previousCheckpoint,
              previousWorkingSummary,
              previousSessionWorkingContext,
              requestedOutputSchema,
            },
            options._clientTimeoutMs,
          );
        } catch (error) {
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_distill',
            provider: provider.name,
            model: providerModelFromMetadata(errorUsageMetadata(error), providerMetadata.model),
            status: 'failed',
            sessionId: options.sessionId,
            distillRunId: distillRun.id,
            jobId: options.jobId || null,
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
            operation: 'checkpoint_distill',
            provider: provider.name,
            model: providerModelFromMetadata(rawOutput?.metadata || {}, providerMetadata.model),
            status: 'failed',
            sessionId: options.sessionId,
            distillRunId: distillRun.id,
            jobId: options.jobId || null,
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
              receivedType: Array.isArray(rawOutput) ? 'array' : typeof rawOutput,
              providerMetadata,
            },
          });
          throw error;
        }

        const discardForLostJobLease = (error) => {
          const completedAt = new Date().toISOString();
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_distill',
            provider: output.provider || provider.name,
            model: providerModelFromMetadata(output.metadata, providerMetadata.model),
            status: 'failed',
            sessionId: options.sessionId,
            distillRunId: distillRun.id,
            jobId: options.jobId || null,
            metadata: { ...output.metadata, leaseLost: true, discarded: true },
            startedAt: distillRun.createdAt,
            completedAt,
            elapsedMs: Date.parse(completedAt) - Date.parse(distillRun.createdAt),
          });
          store.failDistillRun({
            id: distillRun.id,
            error,
            outputMetadata: {
              leaseLost: true,
              retryable: true,
              operationJobId: options.jobId || null,
              providerMetadata: output.metadata,
            },
          });
          throw error;
        };

        if (options.jobId && options._jobLeaseOwner && options._jobLeaseAttempt != null) {
          try {
            store.assertOperationJobLease({
              jobId: options.jobId,
              workerId: options._jobLeaseOwner,
              attempt: options._jobLeaseAttempt,
            });
          } catch (error) {
            discardForLostJobLease(error);
          }
        }

        const checkpointInput = {
          ...scope,
          sessionId: options.sessionId,
          conversationId,
          summaryShort: output.summaryShort,
          summaryText: output.summaryText,
          decisions: output.decisions,
          todos: output.todos,
          openQuestions: output.openQuestions,
          sourceEventCount: output.sourceEventCount ?? selectedRawEvents.length,
          provider: output.provider || provider.name,
          distillRunId: distillRun.id,
          level: checkpointLevel,
          coversFrom: options.coversFrom ?? coverage.coversFrom,
          coversTo: options.coversTo ?? coverage.coversTo,
          source: normalizeCheckpointSource(options.source),
          sourceRef: options.sourceRef ?? distillRun.id,
          metadata: {
            providerMetadata: output.metadata,
            memoryCandidates: output.memoryCandidates,
            structured: output.structured || null,
            sourceProvenance,
            sourceRawEventIds: selectedRawEvents.map((event) => event.id),
            sourceEventWindow: distillWindow.metadata,
            operationJobId: options.jobId || null,
          },
        };

        let checkpoint = null;
        let checkpointError = null;
        try {
          checkpoint =
            options.jobId && options._jobLeaseOwner && options._jobLeaseAttempt != null
              ? store.insertCheckpointForOperationJob(checkpointInput, {
                  jobId: options.jobId,
                  workerId: options._jobLeaseOwner,
                  attempt: options._jobLeaseAttempt,
                })
              : store.insertCheckpoint(checkpointInput);
        } catch (error) {
          checkpointError = error;
        }

        if (checkpointError?.code === 'CONTEXTFORGE_JOB_LEASE_LOST') {
          discardForLostJobLease(checkpointError);
        }

        let workingSummary = null;
        let workingSummaryError = null;
        try {
          workingSummary = store.upsertWorkingSummary({
            ...scope,
            sessionId: options.sessionId,
            conversationId,
            summaryShort: output.summaryShort,
            summaryText: output.workingSummary || output.summaryText,
            sourceCheckpointId: checkpoint?.id || null,
            distillRunId: distillRun.id,
            sourceEventCount: output.sourceEventCount ?? selectedRawEvents.length,
            metadata: {
              providerMetadata: output.metadata,
              sourceProvenance,
              sourceRawEventIds: selectedRawEvents.map((event) => event.id),
              sourceEventWindow: distillWindow.metadata,
              checkpointId: checkpoint?.id || null,
              checkpointInsertFailed: Boolean(checkpointError),
            },
          });
        } catch (error) {
          workingSummaryError = error;
        }

        let sessionWorkingContext = null;
        let sessionWorkingContextError = null;
        if (output.sessionWorkingContext) {
          try {
            const context = output.sessionWorkingContext;
            sessionWorkingContext = store.upsertSessionWorkingContext({
              ...scope,
              sessionId: options.sessionId,
              ...sessionWorkingContextInput(
                {
                  ...context,
                  conversationId,
                  sourceCheckpointId: checkpoint?.id || null,
                  distillRunId: distillRun.id,
                  metadata: {
                    providerMetadata: output.metadata,
                    sourceProvenance,
                    sourceRawEventIds: selectedRawEvents.map((event) => event.id),
                    sourceEventWindow: distillWindow.metadata,
                    checkpointId: checkpoint?.id || null,
                    checkpointInsertFailed: Boolean(checkpointError),
                  },
                },
                previousSessionWorkingContext,
              ),
            });
          } catch (error) {
            sessionWorkingContextError = error;
          }
        }

        if (checkpointError) {
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_distill',
            provider: output.provider || provider.name,
            model: providerModelFromMetadata(output.metadata, providerMetadata.model),
            status: 'succeeded',
            sessionId: options.sessionId,
            distillRunId: distillRun.id,
            jobId: options.jobId || null,
            metadata: output.metadata,
            startedAt: distillRun.createdAt,
            completedAt: new Date().toISOString(),
          });
          store.failDistillRun({
            id: distillRun.id,
            error: checkpointError,
            outputMetadata: {
              checkpointFailed: true,
              retryable: false,
              checkpointError: errorSummary(checkpointError),
              workingSummaryUpdated: Boolean(workingSummary),
              workingSummaryId: workingSummary?.id || null,
              workingSummaryError: errorSummary(workingSummaryError),
              sessionWorkingContextUpdated: Boolean(sessionWorkingContext),
              sessionWorkingContextId: sessionWorkingContext?.id || null,
              sessionWorkingContextError: errorSummary(sessionWorkingContextError),
              providerMetadata: output.metadata,
            },
          });
          throw checkpointError;
        }

        let candidateAudit = {
          enabled: false,
          executed: false,
          reason: 'no_candidates',
          audited: 0,
          promoted: 0,
          error: null,
        };
        try {
          await runWithKeyedLock(
            auditSourceKey(store, scope, { sessionId: options.sessionId, checkpointId: checkpoint.id }),
            async () => {
          const auditTrigger = options.auditTrigger || options.trigger || null;
          const forceAudit = CLOSEOUT_TRIGGERS.has(auditTrigger);
          const effectiveForAudit = getEffectiveRuntime(store);
          const auditConfig = effectiveForAudit.autoPromoteAudit || {};
          const minBatchCandidates = Number(auditConfig.minBatchCandidates || 5);
          const batchLimit = Math.min(10, Number(auditConfig.batchLimit || 5));
          const scanLimit = Math.max(minBatchCandidates, batchLimit, 1) * 10;
          const auditor = getAutoPromoteAuditor(store);
          const unauditedPending = store
            .listMemoryCandidates({
              ...scope,
              sessionId: options.sessionId,
              status: 'pending',
              sort: 'recommendation',
              limit: scanLimit,
            })
            .filter(
              (candidate) =>
                !candidate.reviewMetadata?.audit || candidate.reviewMetadata.audit.retryable === true,
            );
          const shouldAudit =
            checkpointLevel === 0 &&
            Boolean(auditor) &&
            unauditedPending.length > 0 &&
            (forceAudit || unauditedPending.length >= minBatchCandidates);
          if (!shouldAudit) {
            const wouldAuditIfEnabled =
              checkpointLevel === 0 &&
              !auditor &&
              unauditedPending.length > 0 &&
              (forceAudit || unauditedPending.length >= minBatchCandidates);
            candidateAudit = {
              ...candidateAudit,
              enabled: Boolean(auditor),
              reason:
                checkpointLevel !== 0
                  ? 'non_level_zero_checkpoint'
                  : wouldAuditIfEnabled
                    ? 'audit_disabled'
                  : unauditedPending.length === 0
                    ? 'no_unaudited_pending_candidates'
                    : 'below_batch_threshold',
              pendingUnaudited: unauditedPending.length,
              minBatchCandidates,
              batchLimit,
              scanLimit,
              provider: auditor?.metadata?.provider || 'none',
              model: auditor?.metadata?.model || null,
              reasoningEffort: auditor?.metadata?.reasoningEffort || null,
            };
          } else {
            const auditPolicy = {
              minConfidence: 0.7,
              minStability: 0.7,
              allowedCategories: AUDIT_CANDIDATE_CATEGORIES,
            };
            const assessed = unauditedPending.map((candidate) => {
              const warnings = auditCandidateWarnings(store, scope, candidate, auditPolicy);
              const score = scorePromotionCandidate(candidate, warnings, AUDIT_CANDIDATE_SKIP_WARNING_CODES);
              return { candidate, warnings, score };
            });
            const selected = assessed
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, batchLimit);
            if (options.jobId && selected.length > 0) {
              store.registerOperationJobCandidates({ jobId: options.jobId, candidateIds: selected.map((item) => item.candidate.id), leaseOwner: options._jobLeaseOwner, leaseAttempt: options._jobLeaseAttempt });
            }
            const auditBatchId = randomUUID();
            let auditedCount = 0, promotedCount = 0;
            let failedCount = 0;
            let retryableFailureCount = 0;
            if (selected.length > 0) {
              assertProviderTimeoutFitsClient({
                operation: 'candidate audit',
                provider: auditor.metadata?.provider || 'custom_auditor',
                providerTimeoutMs: auditor.metadata?.timeoutMs,
                clientTimeoutMs: options._clientTimeoutMs,
              });
            }
            const assertJobLease = () => {
              if (options.jobId && options._jobLeaseOwner && options._jobLeaseAttempt != null) {
                store.assertOperationJobLease({
                  jobId: options.jobId,
                  workerId: options._jobLeaseOwner,
                  attempt: options._jobLeaseAttempt,
                });
              }
            };
            for (const item of selected) {
              const auditStartedAt = new Date().toISOString();
              let audit;
              try {
                if (options.jobId) {
                  store.startOperationJobCandidate({ jobId: options.jobId, candidateId: item.candidate.id, attempt: options._jobLeaseAttempt, leaseOwner: options._jobLeaseOwner, leaseAttempt: options._jobLeaseAttempt });
                }
                audit = await auditAutoPromotionCandidate({
                  auditor,
                  store,
                  scope,
                  item,
                  providerConcurrencyLimit,
                  clientTimeoutMs: options._clientTimeoutMs,
                });
              } catch (error) {
                if (error?.code === 'CONTEXTFORGE_JOB_LEASE_LOST') throw error;
                rethrowExternalProviderTestError(error);
                audit = {
                  approved: false,
                  decision: 'needs_review',
                  reason: `Automatic candidate audit failed: ${error.message}`,
                  riskCodes: ['audit_failed'],
                  retryable: providerFailureRetryable(error),
                  metadata: { ...(auditor?.metadata || {}), ...errorUsageMetadata(error), errorName: error.name },
                };
              }
              if (audit.riskCodes?.includes('audit_failed')) {
                failedCount += 1;
                if (audit.retryable === true) retryableFailureCount += 1;
              }
              const auditedCandidate = store.withTransaction(() => {
                assertJobLease();
                recordCandidateAuditUsageEvent(store, {
                  scope,
                  item,
                  audit,
                  sessionId: options.sessionId,
                  checkpointId: checkpoint.id,
                  jobId: options.jobId || null,
                  status: audit.riskCodes?.includes('audit_failed') ? 'failed' : 'succeeded',
                });
                return store.markMemoryCandidateAudited({
                  ...scope,
                  candidateId: item.candidate.id,
                  audit,
                  reason: audit.reason,
                  metadata: {
                    auditBatchId,
                    trigger: auditTrigger || 'batch_threshold',
                    sourceMode: 'checkpoint',
                    sessionId: options.sessionId,
                    checkpointId: checkpoint.id,
                    operationJobId: options.jobId || null,
                    leaseAttempt: options._jobLeaseAttempt ?? null, startedAt: auditStartedAt,
                    minBatchCandidates,
                    batchLimit,
                    autoPromoteEnabled: config.autoPromote.enabled,
                  },
                });
              });
              auditedCount += 1;
              if (config.autoPromote.enabled && auditor && audit.approved === true) {
                const autoPolicy = {
                  minConfidence: 0.85,
                  minStability: 0.85,
                  allowedCategories: SAFE_AUTO_PROMOTE_CATEGORIES,
                };
                const autoWarnings = autoPromotionWarnings(store, scope, auditedCandidate, autoPolicy);
                const autoScore = scorePromotionCandidate(
                  auditedCandidate,
                  autoWarnings,
                  AUTO_PROMOTE_SKIP_WARNING_CODES,
                );
                if (autoScore > 0) {
                  const reason =
                    'Auto-promoted after automatic candidate audit approved this strict safe candidate.';
                  store.withTransaction(() => {
                    assertJobLease();
                    autoPromoteIndexedCandidate(
                      store,
                      scope,
                      auditedCandidate,
                      autoWarnings,
                      reason,
                      audit,
                      enqueueEmbeddingSources,
                    );
                  });
                  promotedCount += 1;
                }
              }
            }
            candidateAudit = {
              enabled: Boolean(auditor),
              executed: selected.length > 0,
              reason: forceAudit ? 'closeout_trigger' : 'batch_threshold',
              trigger: auditTrigger || null,
              pendingUnaudited: unauditedPending.length,
              selected: selected.length,
              audited: auditedCount,
              promoted: promotedCount,
              failedCount,
              retryableFailureCount,
              needsRetry: retryableFailureCount > 0,
              minBatchCandidates,
              batchLimit,
              scanLimit,
              provider: auditor?.metadata?.provider || 'none',
              model: auditor?.metadata?.model || null,
              reasoningEffort: auditor?.metadata?.reasoningEffort || null,
              error: null,
            };
          }
            },
          );
        } catch (error) {
          if (error?.code === 'CONTEXTFORGE_JOB_LEASE_LOST') {
            const failedAt = new Date().toISOString();
            recordLlmUsageEvent(store, {
              scope,
              operation: 'checkpoint_distill',
              provider: output.provider || provider.name,
              model: providerModelFromMetadata(output.metadata, providerMetadata.model),
              status: 'failed',
              sessionId: options.sessionId,
              distillRunId: distillRun.id,
              checkpointId: checkpoint.id,
              jobId: options.jobId || null,
              metadata: { ...output.metadata, leaseLost: true, candidateAuditIncomplete: true },
              startedAt: distillRun.createdAt,
              completedAt: failedAt,
              elapsedMs: Date.parse(failedAt) - Date.parse(distillRun.createdAt),
            });
            store.failDistillRun({
              id: distillRun.id,
              error,
              outputMetadata: {
                checkpointId: checkpoint.id,
                leaseLost: true,
                retryable: true,
                candidateAuditIncomplete: true,
                providerMetadata: output.metadata,
              },
            });
            throw error;
          }
          rethrowExternalProviderTestError(error);
          if (options.jobId && CLOSEOUT_TRIGGERS.has(options.auditTrigger || options.trigger)) {
            const failedAt = new Date().toISOString();
            recordLlmUsageEvent(store, {
              scope,
              operation: 'checkpoint_distill',
              provider: output.provider || provider.name,
              model: providerModelFromMetadata(output.metadata, providerMetadata.model),
              status: 'failed',
              sessionId: options.sessionId,
              distillRunId: distillRun.id,
              checkpointId: checkpoint.id,
              jobId: options.jobId,
              metadata: { ...output.metadata, candidateAuditIncomplete: true, auditError: errorSummary(error) },
              startedAt: distillRun.createdAt,
              completedAt: failedAt,
              elapsedMs: Date.parse(failedAt) - Date.parse(distillRun.createdAt),
            });
            store.failDistillRun({
              id: distillRun.id,
              error,
              outputMetadata: {
                checkpointId: checkpoint.id,
                retryable: providerFailureRetryable(error),
                candidateAuditIncomplete: true,
                providerMetadata: output.metadata,
              },
            });
            throw error;
          }
          candidateAudit = {
            enabled: true,
            executed: false,
            reason: 'audit_error',
            audited: 0,
            promoted: 0,
            error: errorSummary(error),
          };
        }

        const completedAt = new Date().toISOString();
        recordLlmUsageEvent(store, {
          scope,
          operation: 'checkpoint_distill',
          provider: output.provider || provider.name,
          model: providerModelFromMetadata(output.metadata, providerMetadata.model),
          status: 'succeeded',
          sessionId: options.sessionId,
          distillRunId: distillRun.id,
          checkpointId: checkpoint.id,
          jobId: options.jobId || null,
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
            memoryCandidateCount: output.memoryCandidates.length,
            candidateAudit,
            workingSummaryUpdated: Boolean(workingSummary),
            workingSummaryId: workingSummary?.id || null,
            workingSummaryError: errorSummary(workingSummaryError),
            sessionWorkingContextUpdated: Boolean(sessionWorkingContext),
            sessionWorkingContextId: sessionWorkingContext?.id || null,
            sessionWorkingContextError: errorSummary(sessionWorkingContextError),
            providerMetadata: output.metadata,
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
          try {
            const candidates = store.listMemoryCandidates({
              ...scope,
              checkpointId: checkpoint.id,
            });
            embedding = enqueueEmbeddingSources(
              store,
              [
                store.embeddingSourceForCheckpoint(checkpoint),
                ...candidates.map((candidate) => store.embeddingSourceForMemoryCandidate(candidate)),
              ],
            );
            embedding.reason = 'queued';
          } catch (error) {
            embedding = embeddingFailureResult(error);
          }
        }

        return {
          ...checkpoint,
          memoryCandidateCount: output.memoryCandidates.length,
          candidateAudit,
          workingSummary: {
            updated: Boolean(workingSummary),
            id: workingSummary?.id || null,
            error: errorSummary(workingSummaryError),
          },
          sessionWorkingContext: {
            updated: Boolean(sessionWorkingContext),
            id: sessionWorkingContext?.id || null,
            error: errorSummary(sessionWorkingContextError),
          },
          embedding,
        };
      }));
    },
  };
}
