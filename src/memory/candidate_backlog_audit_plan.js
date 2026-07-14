import { memoryCandidateRevisionHash } from './candidate_revision.js';
import { buildAuditPrompt } from '../audit/codex_exec.js';
import { normalizeScopeOptions } from '../scopes/index.js';

const ELIGIBLE_AUDIT_STATES = new Set(['unaudited', 'failed_retryable', 'legacy_unknown']);

function positiveInteger(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

function nonNegativeNumber(value, name) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}

function asOfIso(value) {
  const parsed = value == null ? new Date() : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('asOf must be a valid date-time.');
  return parsed.toISOString();
}

function ageMs(createdAt, asOf) {
  return Math.max(0, new Date(asOf).getTime() - new Date(createdAt).getTime());
}

function hasSourceEvidence(candidate) {
  return Boolean(
    candidate.source?.sourceEventCount > 0 ||
      candidate.candidate?.sourceEventIds?.length > 0 ||
      candidate.candidate?.evidenceRefs?.length > 0,
  );
}

function providerMetadata(metadata = {}) {
  return {
    enabled: metadata.enabled !== false,
    provider: metadata.provider || 'none',
    model: metadata.model || null,
    reasoningEffort: metadata.reasoningEffort || null,
    promptVersion: metadata.promptVersion || null,
    outputSchemaVersion: metadata.outputSchemaVersion || null,
  };
}

function costFor({ inputTokens, outputTokens, inputRate, outputRate }) {
  if (inputRate == null || outputRate == null) return null;
  return Number((((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000).toFixed(8));
}

function summarizeCost(items, assumptions) {
  const inputChars = items.reduce((total, item) => total + item.estimatedPromptChars, 0);
  const inputTokens = items.reduce((total, item) => total + item.estimatedInputTokens, 0);
  const outputTokens = items.length * assumptions.estimatedOutputTokensPerCall;
  return {
    providerCalls: items.length,
    inputChars,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedUsd: costFor({
      inputTokens,
      outputTokens,
      inputRate: assumptions.inputUsdPerMillionTokens,
      outputRate: assumptions.outputUsdPerMillionTokens,
    }),
  };
}

function compactCandidate(item) {
  return {
    candidateId: item.candidate.id,
    key: item.candidate.candidate?.key || '',
    category: item.candidate.candidate?.category || null,
    auditState: item.candidate.auditState,
    promotionRecommendation: item.candidate.candidate?.promotionRecommendation || null,
    createdAt: item.candidate.createdAt,
    ageMs: item.ageMs,
    classification: item.classification,
    reasonCodes: item.reasonCodes,
    score: item.score,
    groupedWithCandidateId: item.groupedWithCandidateId || null,
    exactDurableMemoryId: item.exactDurableMemoryId || null,
    durableKeyCollision: item.durableKeyCollision,
    sourceEvidence: item.sourceEvidence,
    staleSuggested: item.staleSuggested,
    plannedProviderCall: item.plannedProviderCall,
    ...(item.estimatedPromptChars == null
      ? {}
      : {
          estimatedPromptChars: item.estimatedPromptChars,
          estimatedInputTokens: item.estimatedInputTokens,
        }),
  };
}

export function buildMemoryCandidateBacklogAuditPlan({
  store,
  scope,
  options = {},
  provider = {},
  assessCandidate,
  promptForCandidate,
  defaultStaleAfterMs,
  defaultMaxProviderCalls = 10,
}) {
  const asOf = asOfIso(options.asOf);
  const scanLimit = positiveInteger(options.limit ?? options.scanLimit, 'limit', 100, 500);
  const maxProviderCalls = positiveInteger(
    options.maxProviderCalls,
    'maxProviderCalls',
    Math.min(10, defaultMaxProviderCalls),
    10,
  );
  const charsPerToken = nonNegativeNumber(options.charsPerToken ?? 4, 'charsPerToken');
  if (charsPerToken === 0) throw new Error('charsPerToken must be greater than zero.');
  const estimatedOutputTokensPerCall = positiveInteger(
    options.estimatedOutputTokensPerCall,
    'estimatedOutputTokensPerCall',
    250,
    100000,
  );
  const inputUsdPerMillionTokens = nonNegativeNumber(
    options.inputUsdPerMillionTokens,
    'inputUsdPerMillionTokens',
  );
  const outputUsdPerMillionTokens = nonNegativeNumber(
    options.outputUsdPerMillionTokens,
    'outputUsdPerMillionTokens',
  );
  if ((inputUsdPerMillionTokens == null) !== (outputUsdPerMillionTokens == null)) {
    throw new Error('inputUsdPerMillionTokens and outputUsdPerMillionTokens must be supplied together.');
  }
  const staleAfterMs = positiveInteger(
    options.staleAfterMs,
    'staleAfterMs',
    defaultStaleAfterMs,
  );
  const candidateIds = Array.isArray(options.candidateIds)
    ? Array.from(new Set(options.candidateIds.map(String)))
    : [];
  if (candidateIds.length > 500) throw new Error('candidateIds supports at most 500 items.');
  const candidates = store.listMemoryCandidates({
    ...scope,
    status: 'pending',
    candidateIds: candidateIds.length ? candidateIds : null,
    candidateType: options.candidateType || null,
    promotionRecommendation: options.promotionRecommendation || null,
    auditState: options.auditState || null,
    category: options.category || null,
    sourceAgent: options.sourceAgent || null,
    sort: options.order === 'desc' ? null : 'oldest',
    limit: candidateIds.length || scanLimit,
  });
  const foundIds = new Set(candidates.map((candidate) => candidate.id));
  const missingCandidateIds = candidateIds.filter((candidateId) => !foundIds.has(candidateId));
  const assessed = candidates.map((candidate) => {
    const local = assessCandidate(candidate);
    const existing = store.getMemory({
      ...scope,
      key: candidate.candidate?.key || '',
    });
    const exactDurable = existing?.status === 'active' && existing.content === candidate.candidate?.content
      ? existing
      : null;
    const sourceEvidence = hasSourceEvidence(candidate) ? 'present' : 'weak';
    const item = {
      candidate,
      revisionHash: memoryCandidateRevisionHash(candidate.candidate),
      warnings: local.warnings,
      score: local.score,
      ageMs: ageMs(candidate.createdAt, asOf),
      sourceEvidence,
      exactDurableMemoryId: exactDurable?.id || null,
      durableKeyCollision: Boolean(existing?.status === 'active' && !exactDurable),
      classification: null,
      reasonCodes: [],
      groupedWithCandidateId: null,
      staleSuggested: false,
      plannedProviderCall: false,
    };
    if (!ELIGIBLE_AUDIT_STATES.has(candidate.auditState)) {
      item.classification = 'audit_state_ineligible';
      item.reasonCodes = [`audit_state_${candidate.auditState}`];
    } else if (exactDurable) {
      item.classification = 'exact_durable_duplicate';
      item.reasonCodes = ['exact_durable_duplicate'];
    } else if (local.score <= 0) {
      item.classification = candidate.candidate?.category === 'preference'
        ? 'preference_policy'
        : 'deterministic_triage';
      item.reasonCodes = local.warnings.map((warning) => warning.code);
    } else {
      item.classification = 'provider_audit';
      if (item.durableKeyCollision) item.reasonCodes.push('durable_key_collision');
    }
    item.staleSuggested = ELIGIBLE_AUDIT_STATES.has(candidate.auditState) && item.ageMs >= staleAfterMs && (
      item.classification === 'deterministic_triage' ||
      item.classification === 'preference_policy' ||
      item.sourceEvidence === 'weak'
    );
    return item;
  });

  const groups = new Map();
  for (const item of assessed.filter((entry) => entry.classification === 'provider_audit')) {
    const group = groups.get(item.revisionHash) || [];
    group.push(item);
    groups.set(item.revisionHash, group);
  }
  const duplicateGroups = [];
  for (const [revisionHash, items] of groups) {
    if (items.length < 2) continue;
    const ranked = items.slice().sort((a, b) =>
      b.score - a.score ||
      String(a.candidate.createdAt).localeCompare(String(b.candidate.createdAt)) ||
      a.candidate.id.localeCompare(b.candidate.id),
    );
    const [leader, ...duplicates] = ranked;
    for (const duplicate of duplicates) {
      duplicate.classification = 'exact_candidate_duplicate';
      duplicate.reasonCodes = ['exact_candidate_duplicate'];
      duplicate.groupedWithCandidateId = leader.candidate.id;
    }
    duplicateGroups.push({
      revisionHash,
      representativeCandidateId: leader.candidate.id,
      candidateIds: ranked.map((item) => item.candidate.id),
    });
  }

  const providerEligible = assessed
    .filter((item) => item.classification === 'provider_audit')
    .sort((a, b) =>
      b.score - a.score ||
      String(a.candidate.createdAt).localeCompare(String(b.candidate.createdAt)) ||
      a.candidate.id.localeCompare(b.candidate.id),
    );
  for (const item of providerEligible) {
    const prompt = promptForCandidate(item.candidate, item.warnings);
    item.estimatedPromptChars = prompt.length;
    item.estimatedInputTokens = Math.ceil(prompt.length / charsPerToken);
  }
  const planned = providerEligible.slice(0, maxProviderCalls);
  for (const item of planned) item.plannedProviderCall = true;
  const assumptions = {
    charsPerToken,
    estimatedOutputTokensPerCall,
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    pricingSource: inputUsdPerMillionTokens == null ? 'not_supplied' : 'caller_supplied',
  };
  const counts = {};
  for (const item of assessed) counts[item.classification] = (counts[item.classification] || 0) + 1;

  return {
    kind: 'memory_candidate_backlog_audit_plan',
    asOf,
    scope,
    readOnly: true,
    providerInvoked: false,
    policy: {
      scanLimit,
      order: options.order === 'desc' ? 'desc' : 'asc',
      maxProviderCalls,
      staleAfterMs,
      minConfidence: options.minConfidence ?? null,
      minStability: options.minStability ?? null,
      allowedCategories: options.allowedCategories || null,
    },
    provider: providerMetadata(provider),
    inventory: {
      scannedCount: assessed.length,
      requestedCandidateCount: candidateIds.length,
      missingCandidateIds,
      byClassification: counts,
      providerEligibleCount: providerEligible.length,
      plannedProviderCallCount: planned.length,
      deferredProviderCallCount: Math.max(0, providerEligible.length - planned.length),
      staleSuggestedCount: assessed.filter((item) => item.staleSuggested).length,
      exactCandidateDuplicateGroupCount: duplicateGroups.length,
    },
    duplicateGroups,
    costEstimate: {
      assumptions,
      plannedBatch: summarizeCost(planned, assumptions),
      fullEligibleInventory: summarizeCost(providerEligible, assumptions),
      note:
        'Input estimates use the actual audit prompt builder; model reasoning tokens and provider overhead are not predictable here.',
    },
    plannedCandidateIds: planned.map((item) => item.candidate.id),
    candidates: options.includeCandidates === false ? [] : assessed.map(compactCandidate),
  };
}

export function candidateBacklogAuditPlanMethods({
  config,
  useStore,
  getEffectiveRuntime,
  getAutoPromoteAuditor,
  normalizeAllowedCategories,
  auditCategories,
  auditCandidateWarnings,
  scorePromotionCandidate,
  auditSkipWarnings,
}) {
  return {
    planMemoryCandidateBacklogAudit(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      const minConfidence = Number(options.minConfidence == null ? 0.7 : options.minConfidence);
      const minStability = Number(options.minStability == null ? 0.7 : options.minStability);
      if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        throw new Error('minConfidence must be between 0 and 1.');
      }
      if (!Number.isFinite(minStability) || minStability < 0 || minStability > 1) {
        throw new Error('minStability must be between 0 and 1.');
      }
      const categoryPolicy = normalizeAllowedCategories(options.allowedCategories, auditCategories);
      return useStore((store) => {
        const runtimeAudit = getEffectiveRuntime(store).autoPromoteAudit || {};
        const auditor = runtimeAudit.enabled ? getAutoPromoteAuditor(store) : null;
        const metadata = auditor?.metadata || {
          enabled: runtimeAudit.enabled,
          provider: runtimeAudit.provider || 'none',
          model: runtimeAudit.model || null,
          reasoningEffort: runtimeAudit.reasoningEffort || null,
        };
        const checkpointCache = new Map();
        return buildMemoryCandidateBacklogAuditPlan({
          store,
          scope,
          options: {
            ...options,
            minConfidence,
            minStability,
            allowedCategories: Array.from(categoryPolicy.allowedCategories),
          },
          provider: metadata,
          defaultStaleAfterMs: config.candidateSla.unauditedMs,
          defaultMaxProviderCalls: runtimeAudit.batchLimit || 5,
          assessCandidate: (candidate) => {
            const warnings = auditCandidateWarnings(store, scope, candidate, {
              minConfidence,
              minStability,
              allowedCategories: categoryPolicy.allowedCategories,
            });
            return {
              warnings,
              score: scorePromotionCandidate(candidate, warnings, auditSkipWarnings),
            };
          },
          promptForCandidate: (candidate, warnings) => {
            if (!checkpointCache.has(candidate.checkpointId)) {
              checkpointCache.set(
                candidate.checkpointId,
                store.getCheckpointById({ ...scope, checkpointId: candidate.checkpointId }),
              );
            }
            return buildAuditPrompt({
              candidate,
              warnings,
              checkpoint: checkpointCache.get(candidate.checkpointId),
            }, metadata);
          },
        });
      });
    },
  };
}
