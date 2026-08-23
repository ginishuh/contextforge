import { clampImportance, normalizeToken, summarySnippet } from '../common.js';
import { providerModelFromMetadata, recordLlmUsageEvent } from '../application/llm_usage.js';
import { searchMemories } from '../retrieval/search.js';
import {
  assertProviderTimeoutFitsClient,
  runWithProviderConcurrency,
} from '../runtime/provider_execution.js';
import { durableMemoryRevisionHash } from './candidate_revision.js';
import { candidateQualityText, normalizeContentForRisk, tokenOverlapScore } from './candidate_text.js';

// Promotion assessment, update-candidate drafting, and the auto/audit policy
// that gates a candidate becoming durable memory. Every function here takes the
// store and scope as arguments, so nothing in this module reaches back into
// core.js.

function normalizeSuggestedPromotionAction(candidate = {}) {
  return String(candidate.suggestedAction || candidate.duplicateAction || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

function promotionClassificationFromProvider(candidate = {}) {
  const action = normalizeSuggestedPromotionAction(candidate);
  if (['duplicate', 'refinement', 'supersedes', 'conflict', 'too_specific'].includes(action)) {
    return action;
  }
  if (['merge', 'merge_duplicate', 'merge_duplicate_memories'].includes(action)) return 'duplicate';
  if (['refine', 'update', 'correct_memory'].includes(action)) return 'refinement';
  if (['supersede', 'replace'].includes(action)) return 'supersedes';
  return null;
}

function memorySimilaritySummary(memory, { key, content, candidate = {} }, retrieval = null) {
  const candidateText = candidateQualityText({ key, content, candidate });
  const memoryText = [memory.key, memory.category, memory.content, ...(memory.tags || [])].join('\n');
  const overlap = tokenOverlapScore(candidateText, memoryText);
  return {
    memoryId: memory.id,
    revisionHash: durableMemoryRevisionHash(memory),
    key: memory.key,
    category: memory.category,
    content: summarySnippet(memory.content, 280),
    importance: memory.importance,
    overlap,
    exactContent: normalizeContentForRisk(memory.content) === normalizeContentForRisk(content),
    sameKey: memory.key === key,
    retrieval: retrieval || null,
  };
}

function similarDurableMemories(store, scope, { key, content, candidate = {}, queryEmbedding = null, limit = 8 }) {
  const query = candidateQualityText({ key, content, candidate });
  const lexicalMatches = store.listMemories(scope).map((memory) =>
    memorySimilaritySummary(memory, { key, content, candidate }),
  );
  const searchMatches = searchMemories(store, {
    ...scope,
    query,
    limit: Math.max(limit, 8),
    queryEmbedding,
  })
    .filter((result) => result.type === 'memory' && result.memory)
    .map((result) =>
      memorySimilaritySummary(result.memory, { key, content, candidate }, result.retrieval),
    );
  const byId = new Map();
  for (const item of [...lexicalMatches, ...searchMatches]) {
    const existing = byId.get(item.memoryId);
    if (
      !existing ||
      item.overlap > existing.overlap ||
      (item.retrieval?.vectorDistance != null && existing.retrieval?.vectorDistance == null)
    ) {
      byId.set(item.memoryId, item);
    }
  }
  return [...byId.values()]
    .filter((item) => item.sameKey || item.exactContent || item.overlap >= 0.2 || item.retrieval?.vectorDistance != null)
    .sort(
      (a, b) =>
        Number(b.exactContent) - Number(a.exactContent) ||
        Number(b.sameKey) - Number(a.sameKey) ||
        b.overlap - a.overlap ||
        (a.retrieval?.vectorDistance ?? Number.POSITIVE_INFINITY) -
          (b.retrieval?.vectorDistance ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, limit);
}

function classifyPromotionAssessment(candidate, similarMemories) {
  const providerClassification = promotionClassificationFromProvider(candidate);
  const candidateText = candidateQualityText({
    key: candidate.key,
    content: candidate.content,
    candidate,
  });
  if (providerClassification) return providerClassification;
  if (AUTO_ONE_OFF_EVENT_PATTERN.test(candidateText) || AUTO_TRANSIENT_CATEGORIES.has(normalizeToken(candidate.category))) {
    return 'too_specific';
  }
  const top = similarMemories[0];
  if (!top) return 'new';
  if (top.exactContent || (top.sameKey && top.overlap >= 0.85)) return 'duplicate';
  const strongOverlap =
    top.sameKey || top.overlap >= 0.6 || (top.retrieval?.vectorDistance != null && top.retrieval.vectorDistance <= 0.2);
  if (strongOverlap && /conflict|contradict|incompatible|different content/i.test(candidateText)) return 'conflict';
  if (strongOverlap && /supersede|replace|newer|more complete|deprecate/i.test(candidateText)) return 'supersedes';
  if (top.sameKey || top.overlap >= 0.45 || (top.retrieval?.vectorDistance != null && top.retrieval.vectorDistance <= 0.2)) {
    return 'refinement';
  }
  return 'new';
}

export function promotionAssessment(store, scope, { key, content, candidate = {}, queryEmbedding = null, embedding = null }) {
  const normalizedCandidate = {
    ...candidate,
    key: key || candidate.key,
    content: content || candidate.content,
  };
  const similarMemories = similarDurableMemories(store, scope, {
    key: normalizedCandidate.key,
    content: normalizedCandidate.content,
    candidate: normalizedCandidate,
    queryEmbedding,
  });
  const classification = classifyPromotionAssessment(normalizedCandidate, similarMemories);
  const recommendedAction =
    classification === 'new'
      ? 'promote_as_new_memory'
      : classification === 'duplicate'
        ? 'reject_or_merge_duplicate'
        : classification === 'too_specific'
          ? 'keep_as_checkpoint_context'
          : 'create_memory_update_candidate';
  return {
    classification,
    recommendedAction,
    similarMemories,
    embedding: embedding || {
      used: Boolean(queryEmbedding),
      degraded: !queryEmbedding,
      reason: queryEmbedding ? null : 'embedding_not_used_for_this_assessment',
    },
  };
}

export function warningForPromotionAssessment(assessment) {
  if (!assessment || assessment.classification === 'new') return null;
  const top = assessment.similarMemories[0] || null;
  const base = {
    classification: assessment.classification,
    recommendedAction: assessment.recommendedAction,
    similarMemories: assessment.similarMemories,
  };
  if (assessment.classification === 'duplicate') {
    return {
      code: 'duplicate_durable_memory',
      message: top
        ? `Candidate is already covered by active durable memory "${top.key}".`
        : 'Candidate appears to duplicate existing durable memory.',
      memoryKey: top?.key || null,
      memoryId: top?.memoryId || null,
      ...base,
    };
  }
  if (assessment.classification === 'too_specific') {
    return {
      code: 'candidate_too_specific',
      message: 'Candidate appears useful as checkpoint handoff context, but too specific for durable memory.',
      ...base,
    };
  }
  return {
    code: `candidate_${assessment.classification}_requires_update`,
    message: top
      ? `Candidate overlaps active durable memory "${top.key}" and should create a ${assessment.classification} update proposal instead of a new memory.`
      : `Candidate should create a ${assessment.classification} update proposal instead of a new memory.`,
    memoryKey: top?.key || null,
    memoryId: top?.memoryId || null,
    ...base,
  };
}

export function candidatePromotionWarnings(store, scope, { key, content, candidate, assessment = null }) {
  const warnings = [];
  const effectiveAssessment = assessment || promotionAssessment(store, scope, { key, content, candidate });
  const assessmentWarning = warningForPromotionAssessment(effectiveAssessment);
  if (assessmentWarning) {
    warnings.push(assessmentWarning);
  }
  const existingByKey = store.getMemory({ ...scope, key });
  if (existingByKey?.status === 'active') {
    warnings.push({
      code: existingByKey.content === content ? 'duplicate_key' : 'existing_key_conflict',
      message:
        existingByKey.content === content
          ? `An active durable memory already exists with key "${key}".`
          : `An active durable memory already exists with key "${key}" and different content.`,
      memoryKey: existingByKey.key,
      memoryId: existingByKey.id,
    });
  }

  const normalizedContent = normalizeContentForRisk(content);
  if (normalizedContent) {
    for (const memory of store.listMemories(scope)) {
      if (memory.key === key) continue;
      if (normalizeContentForRisk(memory.content) === normalizedContent) {
        warnings.push({
          code: 'duplicate_content',
          message: `An active durable memory already has identical content under key "${memory.key}".`,
          memoryKey: memory.key,
          memoryId: memory.id,
        });
      }
    }
  }

  if (['high', 'restricted'].includes(String(candidate.sensitivity || '').toLowerCase())) {
    warnings.push({
      code: 'high_sensitivity',
      message: `Candidate sensitivity is "${candidate.sensitivity}".`,
      sensitivity: candidate.sensitivity,
    });
  }
  if (['reject', 'ignore'].includes(String(candidate.promotionRecommendation || '').toLowerCase())) {
    warnings.push({
      code: 'recommendation_not_promote',
      message: `Candidate recommendation is "${candidate.promotionRecommendation}".`,
      promotionRecommendation: candidate.promotionRecommendation,
    });
  }
  if (candidate.confidence != null && Number(candidate.confidence) < 0.5) {
    warnings.push({
      code: 'low_confidence',
      message: `Candidate confidence is ${candidate.confidence}.`,
      confidence: candidate.confidence,
    });
  }
  if (candidate.stability != null && Number(candidate.stability) < 0.5) {
    warnings.push({
      code: 'low_stability',
      message: `Candidate stability is ${candidate.stability}.`,
      stability: candidate.stability,
    });
  }
  if (['temporary', 'transient', 'stale'].includes(String(candidate.candidateType || '').toLowerCase())) {
    warnings.push({
      code: 'temporary_candidate',
      message: `Candidate type is "${candidate.candidateType}".`,
      candidateType: candidate.candidateType,
    });
  }
  return warnings;
}

const AUTO_SKIP_WARNING_CODES = new Set([
  'duplicate_key',
  'existing_key_conflict',
  'duplicate_content',
  'duplicate_durable_memory',
  'candidate_refinement_requires_update',
  'candidate_supersedes_requires_update',
  'candidate_conflict_requires_update',
  'candidate_too_specific',
  'high_sensitivity',
  'recommendation_not_promote',
  'low_confidence',
  'low_stability',
  'temporary_candidate',
]);

export const AUTO_PROMOTE_SKIP_WARNING_CODES = new Set([
  ...AUTO_SKIP_WARNING_CODES,
  'auto_low_confidence',
  'auto_low_stability',
  'auto_disallowed_category',
  'auto_environment_specific',
  'auto_one_off_event',
  'auto_transient_category',
  'preference_auto_excluded',
]);

const DURABLE_PROPOSAL_CATEGORIES = new Set([
  'decision',
  'runbook',
  'api-contract',
  'failure-mode',
  'preference',
  'environment',
]);

export const AUDIT_CANDIDATE_CATEGORIES = new Set([
  'agent_guidance',
  'agent-guidance',
  'api-contract',
  'api_contract',
  'architecture',
  'decision',
  'failure-mode',
  'failure_mode',
  'policy',
  'runbook',
]);

export const SAFE_AUTO_PROMOTE_CATEGORIES = new Set(['runbook', 'failure-mode', 'api-contract', 'decision']);

export const AUTO_TRANSIENT_CATEGORIES = new Set([
  'bugfix',
  'documentation',
  'project-release',
  'project_release',
  'project-state',
  'project_state',
  'project-status',
  'project_status',
  'runtime-config',
  'runtime_config',
  'state',
  'task-note',
  'task_note',
  'test-contract',
  'test_contract',
]);

const AUTO_ENVIRONMENT_SPECIFIC_PATTERN =
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|systemctl|journalctl|port\s+\d{2,5}|pid\s+\d+)\b|\/home\/|\/tmp\/|\.service\b/i;

const AUTO_ONE_OFF_EVENT_PATTERN =
  /\b(?:pr\s*#\d+|pull request\s*#\d+|issue\s*#\d+|ci\s+(?:green|passed|success|failure|failed)|(?:green|passed|successful|failed)\s+ci|merge state|review comment|commented|npm test\s+\d+\/\d+|git diff --check|smoke test|smoke port|branch cleanup|release\s+\d|version bump)\b/i;

export function indexedCandidateBasisResult(indexedCandidate) {
  const sourceProvenance = indexedCandidate.source?.sourceProvenance || null;
  return {
    type: 'memory_candidate',
    key: indexedCandidate.candidate?.key || null,
    category: indexedCandidate.candidate?.category || null,
    content: summarySnippet(indexedCandidate.candidate?.content, 500),
    trust: 'review_material',
    whyUse: 'Unreviewed promotion material; useful context and review material, not durable truth.',
    verificationRequired: true,
    source: {
      scopeType: indexedCandidate.scopeType,
      scopeKey: indexedCandidate.scopeKey,
      role: 'latest_checkpoint',
    },
    retrieval: {
      method: 'latest_checkpoint_candidates',
      ftsRank: null,
      vectorDistance: null,
      vectorModel: null,
      vectorDimensions: null,
    },
    candidateId: indexedCandidate.id,
    checkpointId: indexedCandidate.checkpointId,
    status: indexedCandidate.status,
    sourceAgent: sourceProvenance?.sourceAgent || indexedCandidate.source?.sourceAgent || null,
    sourceProvenance,
  };
}

export function promotionCandidateWarnings(store, scope, indexedCandidate, assessment = null) {
  const candidate = indexedCandidate.candidate || {};
  const effectiveAssessment = assessment || promotionAssessmentForIndexedCandidate(store, scope, indexedCandidate);
  return candidatePromotionWarnings(store, scope, {
    key: candidate.key,
    content: candidate.content,
    candidate,
    assessment: effectiveAssessment,
  });
}

export function promotionAssessmentForIndexedCandidate(store, scope, indexedCandidate, queryEmbedding = null) {
  const candidate = indexedCandidate.candidate || {};
  return promotionAssessment(store, scope, {
    key: candidate.key,
    content: candidate.content,
    candidate,
    queryEmbedding,
    embedding: {
      used: Boolean(queryEmbedding),
      degraded: !queryEmbedding,
      reason: queryEmbedding ? null : 'embedding_not_available_or_not_requested',
    },
  });
}

export function updateCandidateDraftForPromotionAssessment(scope, indexedCandidate, assessment) {
  if (!assessment || ['new', 'duplicate', 'too_specific'].includes(assessment.classification)) {
    return null;
  }
  const candidate = indexedCandidate.candidate || {};
  const target = assessment.similarMemories[0] || null;
  if (!target) return null;
  return {
    id: null,
    // `proposed` is an in-memory draft status; persisted update candidates are stored as `pending`.
    status: 'proposed',
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    action: assessment.classification === 'duplicate' ? 'merge_duplicate_memories' : 'correct_memory',
    targetMemoryId: target.memoryId,
    targetMemoryKey: target.key,
    proposedKey: target.key,
    proposedContent: candidate.content,
    proposedCategory: candidate.category || target.category || 'note',
    proposedTags: candidate.tags || [],
    proposedImportance: clampImportance(candidate.importance ?? target.importance ?? 0),
    reason: `Promotion quality assessment classified candidate as ${assessment.classification}; update existing durable memory instead of writing a new one.`,
    confidence:
      assessment.classification === 'conflict'
        ? 0.55
        : assessment.classification === 'supersedes'
          ? 0.75
          : 0.7,
    sourceSessionId: indexedCandidate.sessionId || null,
    sourceCheckpointId: indexedCandidate.checkpointId || null,
    sourceCandidateId: indexedCandidate.id || null,
    correction: candidate.content,
    basis: [
      {
        type: 'memory',
        key: target.key,
        memoryId: target.memoryId,
        category: target.category,
        content: target.content,
        overlap: target.overlap,
        revisionHash: target.revisionHash,
        classification: assessment.classification,
      },
      indexedCandidateBasisResult(indexedCandidate),
    ],
  };
}

export function persistUpdateCandidateDraft(store, draft) {
  return draft ? store.createMemoryUpdateCandidate(draft) : null;
}

export function candidateWarningReason(warnings) {
  if (!warnings.length) return null;
  return warnings.map((warning) => warning.code).join(', ');
}

export function scorePromotionCandidate(indexedCandidate, warnings, skipWarningCodes = AUTO_SKIP_WARNING_CODES) {
  if (warnings.some((warning) => skipWarningCodes.has(warning.code))) {
    return 0;
  }
  const candidate = indexedCandidate.candidate || {};
  let score = 1;
  if (candidate.promotionRecommendation === 'promote') score += 4;
  if (Number(candidate.confidence) >= 0.7) score += 2;
  if (Number(candidate.stability) >= 0.7) score += 2;
  if (DURABLE_PROPOSAL_CATEGORIES.has(candidate.category)) score += 1;
  if (/\b(pr|issue|ci|api|migration|deploy|rollback|command|test|runtime)\b/i.test(candidate.reason || candidate.content || '')) {
    score += 1;
  }
  return score;
}

export function promotionProposal(indexedCandidate, warnings, rank) {
  const candidate = indexedCandidate.candidate || {};
  const sourceProvenance = indexedCandidate.source?.sourceProvenance || null;
  const assessmentWarning = warnings.find((warning) => warning.classification);
  const proposal = {
    rank,
    candidateId: indexedCandidate.id,
    scope: indexedCandidate.scopeType,
    scopeKey: indexedCandidate.scopeKey,
    key: candidate.key,
    category: candidate.category,
    content: candidate.content,
    tags: candidate.tags || [],
    importance: candidate.importance ?? 0,
    evidence: {
      reason: candidate.reason || null,
      sourceEventIds: candidate.sourceEventIds || [],
      checkpointId: indexedCandidate.checkpointId,
      sessionId: indexedCandidate.sessionId,
      sourceAgent: sourceProvenance?.sourceAgent || indexedCandidate.source?.sourceAgent || null,
      sourceProvenance,
      ...(Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.length
        ? { evidenceRefs: candidate.evidenceRefs }
        : {}),
    },
    whyDurable:
      candidate.durabilityReason ||
      candidate.reason ||
      'Candidate appears stable and useful beyond the current checkpoint.',
    warnings,
    recommendedAction: 'ask_user',
  };
  if (assessmentWarning) {
    proposal.promotionAssessment = {
      classification: assessmentWarning.classification,
      recommendedAction: assessmentWarning.recommendedAction,
      similarMemories: assessmentWarning.similarMemories || [],
    };
  }
  if (candidate.suggestedAction) {
    proposal.providerSuggestedAction = candidate.suggestedAction;
  }
  if (candidate.riskReason) {
    proposal.riskReason = candidate.riskReason;
  }
  if (candidate.schemaVersion) {
    proposal.candidateSchemaVersion = candidate.schemaVersion;
  }
  return proposal;
}

export function memoryUpdateCandidateProposal(candidate, assessment = null) {
  const proposal = {
    candidateId: candidate.id,
    action: candidate.action,
    status: candidate.status,
    targetMemoryKey: candidate.targetMemoryKey,
    proposedKey: candidate.proposedKey,
    proposedContent: candidate.proposedContent,
    proposedCategory: candidate.proposedCategory,
    proposedTags: candidate.proposedTags,
    proposedImportance: candidate.proposedImportance,
    reason: candidate.reason,
    source: {
      sessionId: candidate.sourceSessionId,
      checkpointId: candidate.sourceCheckpointId,
      candidateId: candidate.sourceCandidateId,
    },
    recommendedAction: 'ask_user',
    ...(assessment
      ? {
          promotionAssessment: {
            classification: assessment.classification,
            recommendedAction: assessment.recommendedAction,
          },
        }
      : {}),
  };
  if (candidate.correction) {
    proposal.correction = candidate.correction;
  }
  return proposal;
}

export function normalizeAllowedCategories(value, defaultCategories = SAFE_AUTO_PROMOTE_CATEGORIES) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : Array.from(defaultCategories);
  const normalized = raw.map((category) => normalizeToken(category)).filter(Boolean);
  return {
    allowedCategories: new Set(normalized.filter((category) => category !== 'preference')),
    strippedPreference: normalized.includes('preference'),
  };
}

export function autoPromotionWarnings(store, scope, indexedCandidate, policy, assessment = null) {
  const candidate = indexedCandidate.candidate || {};
  const warnings = [...promotionCandidateWarnings(store, scope, indexedCandidate, assessment)];
  const category = normalizeToken(candidate.category);
  const searchableText = [
    candidate.key,
    candidate.content,
    candidate.reason,
    candidate.durabilityReason,
    candidate.riskReason,
    ...(Array.isArray(candidate.tags) ? candidate.tags : []),
    ...(Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : []),
  ]
    .filter(Boolean)
    .join('\n');
  if (Number(candidate.confidence || 0) < policy.minConfidence) {
    warnings.push({
      code: 'auto_low_confidence',
      message: `Candidate confidence must be at least ${policy.minConfidence}.`,
      confidence: candidate.confidence ?? null,
      minConfidence: policy.minConfidence,
    });
  }
  if (Number(candidate.stability || 0) < policy.minStability) {
    warnings.push({
      code: 'auto_low_stability',
      message: `Candidate stability must be at least ${policy.minStability}.`,
      stability: candidate.stability ?? null,
      minStability: policy.minStability,
    });
  }
  if (AUTO_TRANSIENT_CATEGORIES.has(category)) {
    warnings.push({
      code: 'auto_transient_category',
      message: `Candidate category "${candidate.category}" describes a transient event or implementation note, not a repository-wide durable development rule.`,
      category: candidate.category || null,
    });
  }
  if (AUTO_ONE_OFF_EVENT_PATTERN.test(searchableText)) {
    warnings.push({
      code: 'auto_one_off_event',
      message:
        'Candidate appears to describe a one-off PR, CI, review, release, branch, or smoke-test event rather than a durable repository-wide development rule.',
    });
  }
  if (AUTO_ENVIRONMENT_SPECIFIC_PATTERN.test(searchableText)) {
    warnings.push({
      code: 'auto_environment_specific',
      message:
        'Candidate appears tied to a specific machine, local path, port, service, or deployment environment and is not safe for automatic durable promotion.',
    });
  }
  if (!policy.allowedCategories.has(category)) {
    warnings.push({
      code: category === 'preference' ? 'preference_auto_excluded' : 'auto_disallowed_category',
      message:
        category === 'preference'
          ? 'Preference candidates are excluded from auto-promotion until occurrence/merge tracking exists.'
          : `Candidate category "${candidate.category}" is not allowed for auto-promotion.`,
      category: candidate.category || null,
    });
  }
  return warnings;
}

export function auditCandidateWarnings(store, scope, indexedCandidate, policy) {
  const candidate = indexedCandidate.candidate || {};
  const warnings = autoPromotionWarnings(store, scope, indexedCandidate, {
    minConfidence: policy.minConfidence,
    minStability: policy.minStability,
    allowedCategories: policy.allowedCategories,
  }).filter(
    (warning) =>
      !['auto_disallowed_category', 'auto_low_confidence', 'auto_low_stability'].includes(warning.code),
  );
  const category = normalizeToken(candidate.category);
  if (!policy.allowedCategories.has(category)) {
    warnings.push({
      code: 'audit_disallowed_category',
      message: `Candidate category "${candidate.category}" is not a repository-wide development rule, contract, policy, architecture decision, failure mode, or runbook.`,
      category: candidate.category || null,
    });
  }
  if (Number(candidate.confidence || 0) < policy.minConfidence) {
    warnings.push({
      code: 'audit_low_confidence',
      message: `Candidate confidence must be at least ${policy.minConfidence} to spend audit budget.`,
      confidence: candidate.confidence ?? null,
      minConfidence: policy.minConfidence,
    });
  }
  if (Number(candidate.stability || 0) < policy.minStability) {
    warnings.push({
      code: 'audit_low_stability',
      message: `Candidate stability must be at least ${policy.minStability} to spend audit budget.`,
      stability: candidate.stability ?? null,
      minStability: policy.minStability,
    });
  }
  return warnings;
}

export const AUDIT_CANDIDATE_SKIP_WARNING_CODES = new Set([
  ...[...AUTO_SKIP_WARNING_CODES].filter((code) => !['existing_key_conflict', 'candidate_refinement_requires_update', 'candidate_supersedes_requires_update', 'candidate_conflict_requires_update'].includes(code)),
  'audit_disallowed_category',
  'audit_low_confidence',
  'audit_low_stability',
  'auto_environment_specific',
  'auto_one_off_event',
  'auto_transient_category',
]);

export function autoPromotionWouldPromote(indexedCandidate, warnings, rank) {
  const proposal = promotionProposal(indexedCandidate, warnings, rank);
  return {
    ...proposal,
    recommendedAction: 'dry_run_only',
    auditReason:
      'Would auto-promote in a future enabled mode because this closeout-scoped pending candidate passed strict dry-run safety policy.',
  };
}

export function auditedPromotionProposal(indexedCandidate, warnings, audit, rank, options = {}) {
  return buildAuditedPromotionProposal({
    indexedCandidate, warnings, audit, rank, ...options,
  });
}

function hasRealAuditProvider(audit) {
  const provider = audit?.metadata?.provider;
  return Boolean(provider && provider !== 'none');
}

export function storedAuditProposal(indexedCandidate, rank) {
  const audit = indexedCandidate.reviewMetadata?.audit || null;
  return auditedPromotionProposal(indexedCandidate, [], audit, rank, {
    auditEnabled: hasRealAuditProvider(audit),
  });
}

export function promoteCandidateToMemory(
  store,
  scope,
  {
    candidate,
    checkpointId,
    sessionId,
    candidateIndex,
    indexedCandidate = null,
    key,
    content,
    category,
    tags,
    importance,
    reason = null,
    warnings = [],
    sourceRawEventIds = [],
    allowStatusOverride = false,
    eventMetadata = {},
    reviewMetadata = {},
    beforeWrite = null,
  },
  enqueueEmbeddings = null,
) {
  return store.withTransaction(() => {
    const freshValidation = typeof beforeWrite === 'function' ? beforeWrite() || {} : {};
    const memory = store.rememberMemory({
      ...scope,
      key,
      content,
      category,
      tags,
      importance,
      eventType: 'promote',
      eventMetadata: {
        sourceCheckpointId: checkpointId,
        sourceSessionId: sessionId,
        sourceCandidateIndex: candidateIndex,
        sourceCandidateId: indexedCandidate?.id || null,
        sourceRawEventIds,
        candidateSourceEventIds: candidate.sourceEventIds || [],
        promotionWarnings: warnings,
        reason,
        ...eventMetadata,
        ...(freshValidation.eventMetadata || {}),
      },
    });
    if (indexedCandidate) {
      store.markMemoryCandidateReviewed({
        ...scope,
        candidateId: indexedCandidate.id,
        status: 'promoted',
        reason,
        promotedMemoryId: memory.id,
        allowStatusOverride,
        metadata: {
          memoryKey: memory.key,
          memoryId: memory.id,
          promotionWarnings: warnings,
          ...reviewMetadata,
          ...(freshValidation.reviewMetadata || {}),
        },
      });
    }
    if (enqueueEmbeddings) enqueueEmbeddings(store, [store.embeddingSourceForMemory(memory)]);
    return memory;
  });
}

export function autoPromoteIndexedCandidate(store, scope, indexedCandidate, warnings, reason, audit = null, enqueueEmbeddings = null) {
  const candidate = indexedCandidate.candidate || {};
  return promoteCandidateToMemory(store, scope, {
    candidate,
    checkpointId: indexedCandidate.checkpointId,
    sessionId: indexedCandidate.sessionId,
    candidateIndex: indexedCandidate.index,
    indexedCandidate,
    key: candidate.key,
    content: candidate.content,
    category: candidate.category || 'note',
    tags: candidate.tags || [],
    importance: candidate.importance ?? 0,
    reason,
    warnings,
    eventMetadata: { autoPromoted: true, autoPromotionAudit: audit },
    reviewMetadata: { autoPromoted: true, autoPromotionAudit: audit },
  }, enqueueEmbeddings);
}

export async function auditAutoPromotionCandidate({
  auditor,
  store,
  scope,
  item,
  providerConcurrencyLimit,
  clientTimeoutMs = null,
}) {
  if (!auditor) {
    return {
      approved: false,
      decision: 'needs_review',
      reason: 'Auto-promotion audit provider is disabled; GPT audit approval is required.',
      riskCodes: ['audit_disabled'],
      metadata: { provider: 'none' },
    };
  }
  const checkpoint = item.candidate.checkpointId
    ? store.getCheckpointById({ ...scope, checkpointId: item.candidate.checkpointId })
    : null;
  const provider = auditor.metadata?.provider || 'custom_auditor';
  assertProviderTimeoutFitsClient({
    operation: 'candidate audit',
    provider,
    providerTimeoutMs: auditor.metadata?.timeoutMs,
    clientTimeoutMs,
  });
  return runWithProviderConcurrency({ provider, limit: providerConcurrencyLimit }, () =>
    auditor({
      candidate: item.candidate,
      warnings: item.warnings,
      checkpoint,
    }),
  );
}

export function recordCandidateAuditUsageEvent(
  store,
  { scope, item, audit, sessionId = null, checkpointId = null, jobId = null, status = 'succeeded' },
) {
  const metadata = audit?.metadata || {};
  const provider = metadata.provider || 'none';
  if (provider === 'none') return null;
  return recordLlmUsageEvent(store, {
    scope,
    operation: 'candidate_audit',
    provider,
    model: providerModelFromMetadata(metadata),
    status,
    sessionId: sessionId || item.candidate.sessionId || null,
    distillRunId: item.candidate.source?.distillRunId || null,
    checkpointId: checkpointId || item.candidate.checkpointId || null,
    candidateId: item.candidate.id,
    jobId,
    metadata,
  });
}

export function auditSkipReason(audit) {
  const riskCodes = Array.isArray(audit?.riskCodes) && audit.riskCodes.length ? `: ${audit.riskCodes.join(', ')}` : '';
  return `audit_${audit?.decision || 'failed'}${riskCodes}`;
}

function buildAuditedPromotionProposal({
  indexedCandidate, warnings, audit, rank, auditEnabled = true, promotionRouting = null,
  promotionRoutingError = null,
}) {
  const proposal = promotionProposal(indexedCandidate, warnings, rank);
  const approved = auditEnabled && audit?.approved === true;
  const routing = promotionRouting || indexedCandidate.reviewMetadata?.promotionRouting || null;
  const routedAction = ['do_not_create_duplicate_memory', 'keep_as_checkpoint_context'].includes(routing?.action)
    ? 'do_not_promote'
    : routing?.action === 'review_memory_update_candidate' ? 'review_update_candidate' : null;
  return {
    ...proposal, audit, auditReason: audit?.reason || null,
    recommendedAction: routedAction || (routing?.action === 'promote_as_new_memory' ? 'promote' : approved ? 'route_before_promote' : 'review'),
    ...(routing ? { promotionRouting: routing } : {}),
    ...(promotionRoutingError ? { promotionRoutingError } : {}),
  };
}
