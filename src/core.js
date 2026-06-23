import { createHash, randomUUID } from 'node:crypto';
import { createCodexExecAutoPromoteAuditor } from './audit/codex_exec.js';
import { createCodexSdkPythonAutoPromoteAuditor } from './audit/codex_sdk_python.js';
import { loadConfig } from './config/index.js';
import { createDistillProvider } from './distill/index.js';
import { checkCodexExecProvider } from './distill/providers/codex_exec.js';
import { checkOpenAiCompatibleProvider } from './distill/providers/openai_compatible.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION, validateDistillOutput } from './distill/validate.js';
import { createEmbeddingProvider } from './embeddings/index.js';
import { createRemoteContextForge } from './remote/client.js';
import { searchMemories } from './retrieval/search.js';
import { normalizeScopeOptions } from './scopes/index.js';
import { ContextForgeStore } from './storage/sqlite.js';

function requireOption(value, name) {
  if (value == null || value === '') {
    throw new Error(`${name} is required.`);
  }
}

function migrationScopeOptions(options, prefix, fallbackScope = 'repo') {
  const scopeType = options[`${prefix}ScopeType`] || options[`${prefix}Scope`] || fallbackScope;
  const scopeKey = options[`${prefix}ScopeKey`];
  if (!['shared', 'repo', 'local'].includes(scopeType)) {
    throw new Error(`${prefix}Scope must be shared, repo, or local.`);
  }
  requireOption(scopeKey, `${prefix}ScopeKey`);
  return { scopeType, scopeKey };
}

function ownValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function mergedContextValue(source, previous, outputKey, inputKeys, fallback) {
  const value = ownValue(source || {}, inputKeys);
  if (value !== undefined) {
    return value;
  }
  if (previous && previous[outputKey] !== undefined) {
    return previous[outputKey];
  }
  return fallback;
}

function sessionWorkingContextInput(source = {}, previous = null) {
  return {
    conversationId: mergedContextValue(source, previous, 'conversationId', ['conversationId', 'conversation_id'], null),
    mode: mergedContextValue(source, previous, 'mode', ['mode'], 'task_execution'),
    currentTask: mergedContextValue(source, previous, 'currentTask', ['currentTask', 'current_task'], ''),
    currentUserIntent: mergedContextValue(
      source,
      previous,
      'currentUserIntent',
      ['currentUserIntent', 'current_user_intent'],
      '',
    ),
    targetSubject: mergedContextValue(source, previous, 'targetSubject', ['targetSubject', 'target_subject'], null),
    sourceSubject: mergedContextValue(source, previous, 'sourceSubject', ['sourceSubject', 'source_subject'], null),
    lastUserCorrection: mergedContextValue(
      source,
      previous,
      'lastUserCorrection',
      ['lastUserCorrection', 'last_user_correction'],
      null,
    ),
    openQuestion: mergedContextValue(source, previous, 'openQuestion', ['openQuestion', 'open_question'], null),
    nonGoals: mergedContextValue(
      source,
      previous,
      'nonGoals',
      ['nonGoals', 'non_goals', 'nonGoalsJson', 'non_goals_json'],
      [],
    ),
    avoidMisreadings: mergedContextValue(
      source,
      previous,
      'avoidMisreadings',
      ['avoidMisreadings', 'avoid_misreadings', 'avoidMisreadingsJson', 'avoid_misreadings_json'],
      [],
    ),
    confidence: mergedContextValue(source, previous, 'confidence', ['confidence'], 0),
    sourceCheckpointId: mergedContextValue(
      source,
      previous,
      'sourceCheckpointId',
      ['sourceCheckpointId', 'source_checkpoint_id'],
      null,
    ),
    distillRunId: mergedContextValue(source, previous, 'distillRunId', ['distillRunId', 'distill_run_id'], null),
    metadata: mergedContextValue(source, previous, 'metadata', ['metadata'], {}),
  };
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function isPreferenceLike(candidate = {}) {
  return [candidate.category, candidate.candidateType].some((value) => normalizeToken(value) === 'preference');
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function nonnegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function boundedInteger(value, name, { min = 0, max = 3 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function withStore(config, fn) {
  const store = new ContextForgeStore({ dataDir: config.dataDir });
  try {
    const result = fn(store);
    if (result && typeof result.then === 'function') {
      return result.finally(() => store.close());
    }
    store.close();
    return result;
  } catch (error) {
    store.close();
    throw error;
  }
}

function rawCharCount(events) {
  return events.reduce((total, event) => total + String(event.content || '').length, 0);
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

function truncateForSummary(value, maxChars = 240) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function estimateTokensFromChars(charCount, charsPerToken) {
  const chars = finiteNumber(charCount);
  if (chars == null || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / charsPerToken);
}

function usageNumberFrom(metadata, keys) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  for (const key of keys) {
    const number = finiteNumber(metadata[key]);
    if (number != null) {
      return number;
    }
  }
  return null;
}

function usageNestedNumberFrom(metadata, path) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  let current = metadata;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[key];
  }
  return finiteNumber(current);
}

function normalizeUsageMetadata(candidate, { includeRaw = false } = {}) {
  const inputTokens = usageNumberFrom(candidate, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const outputTokens = usageNumberFrom(candidate, [
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
  ]);
  const reasoningTokens =
    usageNumberFrom(candidate, ['reasoningTokens', 'reasoning_tokens']) ??
    usageNestedNumberFrom(candidate, ['completion_tokens_details', 'reasoning_tokens']) ??
    usageNestedNumberFrom(candidate, ['output_tokens_details', 'reasoning_tokens']);
  const totalTokens = usageNumberFrom(candidate, ['totalTokens', 'total_tokens']);
  if (inputTokens == null && outputTokens == null && totalTokens == null && reasoningTokens == null) {
    return null;
  }

  const cachedInputTokens =
    usageNumberFrom(candidate, [
      'cachedInputTokens',
      'cached_input_tokens',
      'promptCacheHitTokens',
      'prompt_cache_hit_tokens',
      'cacheHitInputTokens',
      'input_cache_hit_tokens',
    ]) ??
    usageNestedNumberFrom(candidate, ['prompt_tokens_details', 'cached_tokens']) ??
    usageNestedNumberFrom(candidate, ['input_tokens_details', 'cached_tokens']);
  const explicitUncachedInputTokens = usageNumberFrom(candidate, [
    'uncachedInputTokens',
    'uncached_input_tokens',
    'promptCacheMissTokens',
    'prompt_cache_miss_tokens',
    'cacheMissInputTokens',
    'input_cache_miss_tokens',
  ]);
  const uncachedInputTokens =
    explicitUncachedInputTokens ??
    (inputTokens != null && cachedInputTokens != null ? Math.max(0, inputTokens - cachedInputTokens) : null);

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
    promptCacheHitTokens: cachedInputTokens,
    promptCacheMissTokens: uncachedInputTokens,
    ...(includeRaw ? { usage: candidate } : {}),
  };
}

function extractUsageFromCandidates(candidates, options = {}) {
  for (const candidate of candidates) {
    const usage = normalizeUsageMetadata(candidate, options);
    if (usage) return usage;
  }
  return null;
}

function providerUsageCandidates(metadata = {}) {
  const providerMetadata = metadata?.providerMetadata || metadata || {};
  return [
    metadata?.usage,
    providerMetadata.usage,
    providerMetadata.openAiCompatible?.usage,
    providerMetadata.openAiCompatible,
    providerMetadata.codexExec?.usage,
    providerMetadata.codexExec,
    providerMetadata.codexSdkPython?.usage,
    providerMetadata.codexSdkPython,
  ];
}

function extractUsageMetadata(run) {
  return extractUsageFromCandidates([run.outputMetadata?.usage, ...providerUsageCandidates(run.outputMetadata)], {
    includeRaw: false,
  });
}

function extractProviderUsage(metadata) {
  return extractUsageFromCandidates(providerUsageCandidates(metadata), { includeRaw: true });
}

function usageEventTimes({ startedAt = null, completedAt = null, elapsedMs = null } = {}) {
  const completed = completedAt || new Date().toISOString();
  const elapsed = finiteNumber(elapsedMs);
  if (startedAt) {
    return { startedAt, completedAt: completed, elapsedMs: elapsed };
  }
  if (elapsed != null) {
    return {
      startedAt: new Date(Date.parse(completed) - elapsed).toISOString(),
      completedAt: completed,
      elapsedMs: elapsed,
    };
  }
  return { startedAt: completed, completedAt: completed, elapsedMs: null };
}

function providerModelFromMetadata(metadata = {}, fallback = null) {
  return (
    metadata.model ||
    metadata.openAiCompatible?.model ||
    metadata.codexExec?.model ||
    metadata.codexSdkPython?.model ||
    fallback ||
    null
  );
}

function errorUsageMetadata(error) {
  const metadata = error?.metadata && typeof error.metadata === 'object' ? { ...error.metadata } : {};
  if (error?.usage && metadata.usage == null) {
    metadata.usage = error.usage;
  }
  return metadata;
}

function recordLlmUsageEvent(store, options) {
  const usage = extractProviderUsage(options.metadata || {});
  if (!usage) return null;
  const { usage: usageJson, promptCacheHitTokens, promptCacheMissTokens, ...columns } = usage;
  const times = usageEventTimes({
    startedAt: options.startedAt || null,
    completedAt: options.completedAt || null,
    elapsedMs: options.elapsedMs ?? options.metadata?.elapsedMs ?? null,
  });
  return store.insertLlmUsageEvent({
    ...options.scope,
    operation: options.operation,
    provider: options.provider,
    model: options.model || providerModelFromMetadata(options.metadata || {}),
    status: options.status || 'succeeded',
    sessionId: options.sessionId || null,
    distillRunId: options.distillRunId || null,
    checkpointId: options.checkpointId || null,
    candidateId: options.candidateId || null,
    ...columns,
    usage: usageJson || {},
    estimated: false,
    ...times,
  });
}

function summarizeLlmUsageEvents(events) {
  const totals = {
    events: events.length,
    inputTokens: events.reduce((total, event) => total + (event.inputTokens || 0), 0),
    cachedInputTokens: events.reduce((total, event) => total + (event.cachedInputTokens || 0), 0),
    uncachedInputTokens: events.reduce((total, event) => total + (event.uncachedInputTokens || 0), 0),
    outputTokens: events.reduce((total, event) => total + (event.outputTokens || 0), 0),
    reasoningTokens: events.reduce((total, event) => total + (event.reasoningTokens || 0), 0),
    totalTokens: events.reduce((total, event) => total + (event.totalTokens || 0), 0),
  };
  const byOperation = {};
  const byProviderModel = {};
  const byProviderModelOperation = {};
  for (const event of events) {
    const operationKey = event.operation;
    const providerKey = [event.provider, event.model].filter(Boolean).join('/') || event.provider;
    const providerOperationKey = `${providerKey}:${operationKey}`;
    for (const [key, target] of [
      [operationKey, byOperation],
      [providerKey, byProviderModel],
      [providerOperationKey, byProviderModelOperation],
    ]) {
      target[key] ||= {
        events: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      };
      target[key].events += 1;
      target[key].inputTokens += event.inputTokens || 0;
      target[key].cachedInputTokens += event.cachedInputTokens || 0;
      target[key].uncachedInputTokens += event.uncachedInputTokens || 0;
      target[key].outputTokens += event.outputTokens || 0;
      target[key].reasoningTokens += event.reasoningTokens || 0;
      target[key].totalTokens += event.totalTokens || 0;
    }
  }
  return { ...totals, byOperation, byProviderModel, byProviderModelOperation };
}

function summarizeDistillUsage({ scope, sessionId, runs, usageEvents = [], charsPerToken = 4 }) {
  const details = runs.map((run) => {
    const window = run.inputMetadata?.sourceEventWindow || {};
    const selectedCharCount = finiteNumber(window.selectedCharCount) ?? 0;
    const selectedEventCount = finiteNumber(window.selectedEventCount) ?? run.sourceEventCount;
    const elapsedMs = Date.parse(run.completedAt || '') - Date.parse(run.createdAt || '');
    const usage = extractUsageMetadata(run);
    return {
      id: run.id,
      status: run.status,
      provider: run.provider,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      sourceEventCount: run.sourceEventCount,
      selectedEventCount,
      selectedCharCount,
      estimatedInputTokens: estimateTokensFromChars(selectedCharCount, charsPerToken),
      usage,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      errorSummary: run.errorMessage ? truncateForSummary(run.errorMessage) : null,
    };
  });

  const totals = {
    runs: details.length,
    succeeded: details.filter((run) => run.status === 'succeeded').length,
    failed: details.filter((run) => run.status === 'failed').length,
    started: details.filter((run) => run.status === 'started').length,
    sourceEventCount: details.reduce((total, run) => total + (finiteNumber(run.sourceEventCount) ?? 0), 0),
    selectedEventCount: details.reduce((total, run) => total + (finiteNumber(run.selectedEventCount) ?? 0), 0),
    selectedCharCount: details.reduce((total, run) => total + run.selectedCharCount, 0),
    estimatedInputTokens: details.reduce((total, run) => total + run.estimatedInputTokens, 0),
    elapsedMs: details.reduce((total, run) => total + (run.elapsedMs || 0), 0),
  };
  const completedRuns = totals.succeeded + totals.failed;
  const actualUsageRuns = details.filter((run) => run.usage);
  const embeddedActualUsage = {
    runs: actualUsageRuns.length,
    inputTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.inputTokens || 0), 0),
    outputTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.outputTokens || 0), 0),
    totalTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.totalTokens || 0), 0),
    promptCacheRuns: actualUsageRuns.filter(
      (run) => run.usage.promptCacheHitTokens != null || run.usage.promptCacheMissTokens != null,
    ).length,
    promptCacheHitTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.promptCacheHitTokens || 0), 0),
    promptCacheMissTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.promptCacheMissTokens || 0), 0),
  };
  embeddedActualUsage.promptCacheHitRatio = embeddedActualUsage.inputTokens
    ? embeddedActualUsage.promptCacheHitTokens / embeddedActualUsage.inputTokens
    : null;
  const persistedUsage = summarizeLlmUsageEvents(usageEvents);
  const canonicalUsage =
    usageEvents.length > 0
      ? { source: 'persisted_usage_events', ...persistedUsage }
      : { source: 'embedded_provider_metadata', ...embeddedActualUsage };

  return {
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    sessionId,
    charsPerEstimatedToken: charsPerToken,
    note:
      usageEvents.length > 0
        ? 'Persisted LLM usage events are the canonical usage totals for this response. embeddedActualUsage is legacy run metadata and must not be added to persistedUsage.'
        : embeddedActualUsage.runs > 0
          ? 'Actual provider usage was found for some runs; runs without actual usage only have estimates.'
          : 'No actual provider token usage was recorded; estimatedInputTokens uses selectedCharCount divided by charsPerEstimatedToken. Older runs without sourceEventWindow metadata may estimate as 0.',
    totals: {
      ...totals,
      completedRuns,
      averageElapsedMs: completedRuns ? Math.round(totals.elapsedMs / completedRuns) : 0,
      actualUsage: embeddedActualUsage,
      embeddedActualUsage,
      persistedUsage,
      canonicalUsage,
    },
    runs: details,
  };
}

function truncateText(value, maxChars = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function contentHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function resultTextForVerification(result) {
  if (result.memory) {
    return [result.memory.key, result.memory.category, result.memory.content, ...(result.memory.tags || [])].join(' ');
  }
  if (result.checkpoint) {
    return [
      result.checkpoint.summaryShort,
      result.checkpoint.summaryText,
      ...(result.checkpoint.decisions || []),
      ...(result.checkpoint.todos || []),
      ...(result.checkpoint.openQuestions || []),
      structuredVerificationText(result.checkpoint.structured || result.checkpoint.metadata?.structured),
    ].join(' ');
  }
  if (result.candidate) {
    return [
      result.candidate.candidate.key,
      result.candidate.candidate.category,
      result.candidate.candidate.content,
      result.candidate.candidate.reason,
      ...(result.candidate.candidate.tags || []),
    ].join(' ');
  }
  return '';
}

function structuredVerificationText(structured) {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return '';
  }
  const liveState = structured.liveState && typeof structured.liveState === 'object' ? structured.liveState : {};
  const values = [
    liveState.repo,
    liveState.branch,
    liveState.baseBranch,
    liveState.headCommit,
    liveState.prNumber == null || liveState.prNumber === '' ? '' : `PR #${liveState.prNumber}`,
    liveState.prUrl,
    liveState.ciStatus,
    liveState.worktreeStatus,
    liveState.runtimeStatus,
    liveState.deploymentStatus,
    ...(Array.isArray(liveState.staleReasons) ? liveState.staleReasons : []),
    ...(Array.isArray(liveState.verifyHints) ? liveState.verifyHints : []),
  ];
  return values.filter(Boolean).join(' ');
}

function requiresLiveStateVerification(result) {
  return liveStateTermsMatch(resultTextForVerification(result));
}

function bootstrapTrustForType(type) {
  if (type === 'memory') {
    return 'reviewed_durable';
  }
  if (type === 'checkpoint') {
    return 'credible_recent_handoff';
  }
  if (type === 'memory_candidate') {
    return 'review_material';
  }
  return 'context_candidate';
}

function bootstrapUseHint(result) {
  if (result.type === 'memory') {
    return 'Reviewed durable state; use for decisions, but verify drift-prone facts against live sources.';
  }
  if (result.type === 'checkpoint') {
    return 'Credible recent handoff state; use actively for continuity and planning, but verify mutable live state before acting.';
  }
  if (result.type === 'memory_candidate') {
    return 'Unreviewed promotion candidate; useful context and review material, not canonical truth.';
  }
  return 'Context candidate; verify before acting.';
}

function errorSummary(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
  };
}

function bootstrapResultSummary(result) {
  if (result.memory) {
    return {
      key: result.memory.key,
      category: result.memory.category,
      content: truncateText(result.memory.content),
    };
  }
  if (result.checkpoint) {
    return {
      key: result.checkpoint.id,
      category: 'checkpoint',
      content: truncateText(result.checkpoint.summaryText || result.checkpoint.summaryShort),
      sessionId: result.checkpoint.sessionId,
      level: result.checkpoint.level,
      createdAt: result.checkpoint.createdAt,
    };
  }
  if (result.candidate) {
    const sourceProvenance = result.candidate.source?.sourceProvenance || null;
    return {
      key: result.candidate.candidate.key,
      category: result.candidate.candidate.category,
      content: truncateText(result.candidate.candidate.content),
      candidateId: result.candidate.id,
      status: result.candidate.status,
      checkpointId: result.candidate.checkpointId,
      sourceAgent: sourceProvenance?.sourceAgent || result.candidate.source?.sourceAgent || null,
      sourceProvenance,
    };
  }
  return {
    key: null,
    category: null,
    content: '',
  };
}

function bootstrapWorkingSummary(summary) {
  if (!summary) {
    return null;
  }
  const checkpointInsertFailed = Boolean(summary.metadata?.checkpointInsertFailed);
  // Keep bootstrap small and avoid leaking provider metadata; expose only handoff-safe state flags.
  return {
    type: 'working_summary',
    id: summary.id,
    sessionId: summary.sessionId,
    conversationId: summary.conversationId,
    content: truncateText(summary.summaryText, 1200),
    summaryShort: summary.summaryShort,
    sourceCheckpointId: summary.sourceCheckpointId,
    distillRunId: summary.distillRunId,
    sourceEventCount: summary.sourceEventCount,
    degraded: checkpointInsertFailed,
    checkpointInsertFailed,
    updatedAt: summary.updatedAt,
    trust: 'live_continuity',
    verificationRequired: true,
    whyUse:
      'Latest rolling session state for handoff; useful for live continuation, but not reviewed durable memory.',
  };
}

function bootstrapSessionWorkingContext(context) {
  if (!context) {
    return null;
  }
  return {
    type: 'session_working_context',
    id: context.id,
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    mode: context.mode,
    currentTask: context.currentTask,
    currentUserIntent: context.currentUserIntent,
    targetSubject: context.targetSubject,
    sourceSubject: context.sourceSubject,
    lastUserCorrection: context.lastUserCorrection,
    openQuestion: context.openQuestion,
    nonGoals: context.nonGoals,
    avoidMisreadings: context.avoidMisreadings,
    confidence: context.confidence,
    sourceCheckpointId: context.sourceCheckpointId,
    distillRunId: context.distillRunId,
    updatedAt: context.updatedAt,
    trust: 'mutable_session_state',
    verificationRequired: true,
    whyUse:
      'Structured live session state for resume handoff; useful for current task framing, but not reviewed durable memory.',
  };
}

function bootstrapRawTailEvent(event) {
  return {
    id: event.id,
    role: event.role,
    content: truncateText(event.content, 800),
    metadata: event.metadata,
    createdAt: event.createdAt,
  };
}

function structuredForCheckpoint(checkpoint) {
  return checkpoint?.structured || checkpoint?.metadata?.structured || null;
}

function structuredLiveStateWarnings(structured) {
  const liveState = structured?.liveState;
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) {
    return [];
  }
  const mutableFields = [
    'repo',
    'branch',
    'baseBranch',
    'headCommit',
    'prNumber',
    'prUrl',
    'ciStatus',
    'worktreeStatus',
    'runtimeStatus',
    'deploymentStatus',
  ].filter((field) => liveState[field] != null && liveState[field] !== '');
  if (!mutableFields.length && !liveState.verificationRequired) {
    return [];
  }
  if (!mutableFields.length) {
    return [
      {
        code: 'verification_required',
        fields: [],
        observedAt: liveState.observedAt || liveState.verifiedAt || null,
        staleReasons: Array.isArray(liveState.staleReasons) ? liveState.staleReasons : [],
        verifyHints: Array.isArray(liveState.verifyHints) ? liveState.verifyHints : [],
        message: 'Structured checkpoint liveState requires live verification before acting.',
      },
    ];
  }
  return [
    {
      code: 'live_state_may_be_stale',
      fields: mutableFields.map((field) => `liveState.${field}`),
      observedAt: liveState.observedAt || liveState.verifiedAt || null,
      staleReasons: Array.isArray(liveState.staleReasons) ? liveState.staleReasons : [],
      verifyHints: Array.isArray(liveState.verifyHints) ? liveState.verifyHints : [],
      message: 'Structured checkpoint liveState is observed mutable state; verify it against live sources before acting.',
    },
  ];
}

function checkpointHandoffCompact(checkpoint, scope) {
  const sourceEventWindow = checkpoint.metadata?.sourceEventWindow || null;
  const sourceProvenance = checkpoint.metadata?.sourceProvenance || null;
  const sourceAgent = sourceProvenance?.sourceAgent || null;
  const structured = structuredForCheckpoint(checkpoint);
  const structuredWarnings = structuredLiveStateWarnings(structured);
  return {
    type: 'checkpoint',
    trust: 'credible_recent_handoff',
    verificationRequired: true,
    whyUse:
      'Preferred source for recent work status, handoff, recent decisions, open todos, and next actions; verify mutable claims against live sources before final action.',
    useFor: ['recent_status', 'handoff', 'next_actions', 'recent_decisions'],
    scope: {
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
    },
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    conversationId: checkpoint.conversationId,
    level: checkpoint.level,
    createdAt: checkpoint.createdAt,
    summaryShort: checkpoint.summaryShort,
    summaryText: truncateText(checkpoint.summaryText, 1600),
    decisions: checkpoint.decisions || [],
    todos: checkpoint.todos || [],
    openQuestions: checkpoint.openQuestions || [],
    sourceEventCount: checkpoint.sourceEventCount,
    provider: checkpoint.provider,
    sourceAgent,
    sourceProvenance,
    structured,
    ...(structuredWarnings.length ? { structuredWarnings } : {}),
    ...(sourceEventWindow
      ? {
          sourceEventWindow: {
            mode: sourceEventWindow.mode || null,
            selectedEventCount: sourceEventWindow.selectedEventCount ?? null,
            selectedCharCount: sourceEventWindow.selectedCharCount ?? null,
            truncated: Boolean(sourceEventWindow.truncated),
          },
        }
      : {}),
  };
}

function latestHandoffByAgent(checkpoints) {
  const byAgent = {};
  for (const checkpoint of checkpoints) {
    // listRecentCheckpoints returns newest first; keep the first checkpoint
    // seen for each source agent.
    const agent = checkpoint.sourceAgent || checkpoint.sourceProvenance?.sourceAgent || null;
    if (!agent || byAgent[agent]) {
      continue;
    }
    byAgent[agent] = checkpoint;
  }
  return byAgent;
}

function normalizeRelatedScopeKeys(value) {
  if (value == null) {
    return [];
  }
  const items = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

function bootstrapResult(result, group) {
  const summary = bootstrapResultSummary(result);
  const verificationRequired =
    result.type !== 'memory'
      ? true
      : requiresLiveStateVerification(result);
  return {
    group,
    type: result.type,
    key: summary.key,
    category: summary.category,
    content: summary.content,
    trust: bootstrapTrustForType(result.type),
    verificationRequired,
    whyUse: bootstrapUseHint(result),
    why: result.why,
    source: result.source,
    retrieval: result.retrieval,
    ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
    ...(summary.level != null ? { level: summary.level } : {}),
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
    ...(summary.candidateId ? { candidateId: summary.candidateId } : {}),
    ...(summary.status ? { status: summary.status } : {}),
    ...(summary.checkpointId ? { checkpointId: summary.checkpointId } : {}),
    ...(summary.sourceAgent ? { sourceAgent: summary.sourceAgent } : {}),
    ...(summary.sourceProvenance ? { sourceProvenance: summary.sourceProvenance } : {}),
  };
}

function bootstrapSummary(results) {
  if (results.length === 0) {
    return 'No relevant ContextForge results found for this bootstrap query.';
  }
  const counts = results.reduce((acc, result) => {
    acc[result.type] = (acc[result.type] || 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  return `Found ${results.length} relevant ContextForge result(s): ${parts}. Treat them as context candidates and verify live state before acting.`;
}

function storageBootstrapInfo(config, info) {
  const vectorReady = Boolean(info.vector?.sqliteVecAvailable && info.embeddings?.enabled);
  const staleSources = Number(info.embeddings?.coverage?.staleSources || 0);
  const pendingJobs = Number(info.embeddings?.jobs?.pending || 0);
  const failedJobs = Number(info.embeddings?.jobs?.failed || 0);
  return {
    mode: config.storageMode,
    authority: config.storageMode === 'remote' ? 'canonical' : config.storageMode === 'local' ? 'local' : 'project-local',
    vectorReady,
    vectorState: vectorReady && staleSources === 0 && failedJobs === 0 ? 'ready' : 'degraded',
    vectorStaleSources: staleSources,
    vectorPendingJobs: pendingJobs,
    vectorFailedJobs: failedJobs,
    sqliteVecAvailable: Boolean(info.vector?.sqliteVecAvailable),
    sqliteVecVersion: info.vector?.sqliteVecVersion || null,
    embeddingProvider: info.embeddings?.provider || 'none',
    connection: info.connection || null,
  };
}

function normalizeContentForRisk(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function truthyOption(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function candidatePromotionWarnings(store, scope, { key, content, candidate }) {
  const warnings = [];
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

const CLOSEOUT_TRIGGERS = new Set([
  'agent_merged_pr',
  'user_merged_then_synced',
  'user_declared_work_done',
  'manual_closeout',
]);

function missingCloseoutSourceWarning(toolName) {
  return {
    code: 'missing_closeout_source',
    message: `${toolName} requires sessionId or checkpointId for current-session closeout review; no candidates were scanned.`,
  };
}

const AUTO_SKIP_WARNING_CODES = new Set([
  'duplicate_key',
  'existing_key_conflict',
  'duplicate_content',
  'high_sensitivity',
  'recommendation_not_promote',
  'low_confidence',
  'low_stability',
  'temporary_candidate',
]);

const AUTO_PROMOTE_SKIP_WARNING_CODES = new Set([
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

const AUDIT_CANDIDATE_CATEGORIES = new Set([
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
const SAFE_AUTO_PROMOTE_CATEGORIES = new Set(['runbook', 'failure-mode', 'api-contract', 'decision']);
const AUTO_TRANSIENT_CATEGORIES = new Set([
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
const CHECKPOINT_SOURCES = new Set(['distill', 'daily_consolidation', 'weekly_consolidation', 'topic_batch', 'manual']);
const CONSOLIDATION_TARGETS = new Set(['thread', 'repo']);
const CONSOLIDATION_WINDOWS = new Set(['daily', 'custom']);
const RECONCILE_UPDATE_CONFIDENCE = {
  durableMemory: 0.7,
  checkpointNote: 0.55,
};

function normalizeCheckpointSource(source) {
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

function compactConsolidationCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    ...checkpointHandoffCompact(checkpoint, {
      scopeType: checkpoint.scopeType,
      scopeKey: checkpoint.scopeKey,
    }),
    consolidation: checkpoint.metadata?.consolidation || null,
  };
}

function isSqliteConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function providerInputTruncated(metadata) {
  return Boolean(metadata?.codexExec?.inputTruncated || metadata?.openAiCompatible?.inputTruncated);
}

function compactBootstrapCandidate(result) {
  return {
    candidateId: result.candidateId || null,
    key: result.key || null,
    category: result.category || null,
    content: truncateText(result.content, 240),
    status: result.status || null,
    checkpointId: result.checkpointId || null,
    sourceAgent: result.sourceAgent || null,
    sourceProvenance: result.sourceProvenance || null,
    trust: 'review_material',
    useHint: 'Useful context and review material, not durable truth or a promotion proposal.',
  };
}

function compactIndexedCandidate(indexedCandidate) {
  const sourceProvenance = indexedCandidate.source?.sourceProvenance || null;
  return {
    candidateId: indexedCandidate.id,
    key: indexedCandidate.candidate?.key || null,
    category: indexedCandidate.candidate?.category || null,
    content: truncateText(indexedCandidate.candidate?.content, 240),
    status: indexedCandidate.status || null,
    checkpointId: indexedCandidate.checkpointId || null,
    sourceAgent: sourceProvenance?.sourceAgent || indexedCandidate.source?.sourceAgent || null,
    sourceProvenance,
    trust: 'review_material',
    useHint: 'Useful context and review material, not durable truth or a promotion proposal.',
  };
}

function resumeCheckpoint(result) {
  return {
    ...result,
    trust: 'credible_recent_handoff',
    useHint:
      'Use actively for continuity, planning, prior intent, recent decisions, and unfinished work. Verify only mutable live state such as git, GitHub, CI, runtime, and migrations before acting.',
    whyUse:
      'Credible recent handoff state for continuity and planning; verify mutable live state before acting.',
  };
}

function checkpointHandoffResult(checkpoint, group = 'session') {
  const structured = structuredForCheckpoint(checkpoint);
  return resumeCheckpoint({
    group,
    type: 'checkpoint',
    key: checkpoint.id,
    category: 'checkpoint',
    content: truncateText(checkpoint.summaryText || checkpoint.summaryShort),
    verificationRequired: true,
    why: [],
    source: {
      scopeType: checkpoint.scopeType,
      scopeKey: checkpoint.scopeKey,
      role: group,
    },
    retrieval: {
      method: 'latest_checkpoint',
      ftsRank: null,
      vectorDistance: null,
      vectorModel: null,
      vectorDimensions: null,
    },
    sessionId: checkpoint.sessionId,
    level: checkpoint.level,
    coversFrom: checkpoint.coversFrom,
    coversTo: checkpoint.coversTo,
    checkpointSource: checkpoint.source,
    sourceRef: checkpoint.sourceRef,
    structured,
    structuredWarnings: structuredLiveStateWarnings(structured),
    createdAt: checkpoint.createdAt,
  });
}

function checkpointBasisResult(checkpoint) {
  const structured = structuredForCheckpoint(checkpoint);
  return {
    type: 'checkpoint',
    key: checkpoint.id,
    category: 'checkpoint',
    content: truncateText(checkpoint.summaryText || checkpoint.summaryShort, 500),
    trust: 'credible_recent_handoff',
    whyUse: 'Checkpoint basis explains why prior agents may have believed this; do not edit checkpoints directly.',
    verificationRequired: true,
    source: {
      scopeType: checkpoint.scopeType,
      scopeKey: checkpoint.scopeKey,
      role: 'latest_checkpoint',
    },
    retrieval: {
      method: 'latest_checkpoint',
      ftsRank: null,
      vectorDistance: null,
      vectorModel: null,
      vectorDimensions: null,
    },
    checkpointId: checkpoint.id,
    sessionId: checkpoint.sessionId,
    level: checkpoint.level,
    coversFrom: checkpoint.coversFrom,
    coversTo: checkpoint.coversTo,
    checkpointSource: checkpoint.source,
    sourceRef: checkpoint.sourceRef,
    structured,
    structuredWarnings: structuredLiveStateWarnings(structured),
  };
}

function indexedCandidateBasisResult(indexedCandidate) {
  const sourceProvenance = indexedCandidate.source?.sourceProvenance || null;
  return {
    type: 'memory_candidate',
    key: indexedCandidate.candidate?.key || null,
    category: indexedCandidate.candidate?.category || null,
    content: truncateText(indexedCandidate.candidate?.content, 500),
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

function promotionCandidateWarnings(store, scope, indexedCandidate) {
  const candidate = indexedCandidate.candidate || {};
  return candidatePromotionWarnings(store, scope, {
    key: candidate.key,
    content: candidate.content,
    candidate,
  });
}

function candidateWarningReason(warnings) {
  if (!warnings.length) return null;
  return warnings.map((warning) => warning.code).join(', ');
}

function scorePromotionCandidate(indexedCandidate, warnings, skipWarningCodes = AUTO_SKIP_WARNING_CODES) {
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

function promotionProposal(indexedCandidate, warnings, rank) {
  const candidate = indexedCandidate.candidate || {};
  const sourceProvenance = indexedCandidate.source?.sourceProvenance || null;
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

function memoryUpdateCandidateProposal(candidate) {
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
  };
  if (candidate.correction) {
    proposal.correction = candidate.correction;
  }
  return proposal;
}

function memoryUpdateActionForReconcile(item, liveState) {
  // Checkpoints are immutable handoff evidence; corrective notes do not edit mutable live state.
  if (item.type === 'checkpoint') return 'add_corrective_note';
  if (liveState) return null;
  return 'correct_memory';
}

function slugForKey(value) {
  const text = String(value || '').trim();
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || contentHash(text).slice(0, 12);
}

function correctiveNoteKey(candidate) {
  if (candidate.proposedKey) return candidate.proposedKey;
  if (candidate.targetMemoryKey) return `${candidate.targetMemoryKey}-correction`;
  return `corrective-note-${slugForKey(candidate.proposedContent || candidate.correction || candidate.id)}`;
}

function normalizeAllowedCategories(value, defaultCategories = SAFE_AUTO_PROMOTE_CATEGORIES) {
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

function autoPromotionWarnings(store, scope, indexedCandidate, policy) {
  const candidate = indexedCandidate.candidate || {};
  const warnings = [...promotionCandidateWarnings(store, scope, indexedCandidate)];
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

function auditCandidateWarnings(store, scope, indexedCandidate, policy) {
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

const AUDIT_CANDIDATE_SKIP_WARNING_CODES = new Set([
  ...AUTO_SKIP_WARNING_CODES,
  'audit_disallowed_category',
  'audit_low_confidence',
  'audit_low_stability',
  'auto_environment_specific',
  'auto_one_off_event',
  'auto_transient_category',
]);

function autoPromotionWouldPromote(indexedCandidate, warnings, rank) {
  const proposal = promotionProposal(indexedCandidate, warnings, rank);
  return {
    ...proposal,
    recommendedAction: 'dry_run_only',
    auditReason:
      'Would auto-promote in a future enabled mode because this closeout-scoped pending candidate passed strict dry-run safety policy.',
  };
}

function auditedPromotionProposal(indexedCandidate, warnings, audit, rank, { auditEnabled = true } = {}) {
  const proposal = promotionProposal(indexedCandidate, warnings, rank);
  const approved = auditEnabled && audit?.approved === true;
  return {
    ...proposal,
    audit,
    auditReason: audit?.reason || null,
    recommendedAction: approved ? 'promote' : 'review',
  };
}

function hasRealAuditProvider(audit) {
  const provider = audit?.metadata?.provider;
  return Boolean(provider && provider !== 'none');
}

function storedAuditProposal(indexedCandidate, rank) {
  const audit = indexedCandidate.reviewMetadata?.audit || null;
  return auditedPromotionProposal(indexedCandidate, [], audit, rank, {
    auditEnabled: hasRealAuditProvider(audit),
  });
}

function promoteCandidateToMemory(
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
  },
) {
  return store.withTransaction(() => {
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
        },
      });
    }
    return memory;
  });
}

function autoPromoteIndexedCandidate(store, scope, indexedCandidate, warnings, reason, audit = null) {
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
  });
}

async function auditAutoPromotionCandidate({ auditor, store, scope, item }) {
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
  return auditor({
    candidate: item.candidate,
    warnings: item.warnings,
    checkpoint,
  });
}

function recordCandidateAuditUsageEvent(
  store,
  { scope, item, audit, sessionId = null, checkpointId = null, status = 'succeeded' },
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
    metadata,
  });
}

function auditSkipReason(audit) {
  const riskCodes = Array.isArray(audit?.riskCodes) && audit.riskCodes.length ? `: ${audit.riskCodes.join(', ')}` : '';
  return `audit_${audit?.decision || 'failed'}${riskCodes}`;
}

function summarizeBasisResult(result) {
  return {
    type: result.type,
    key: result.key,
    category: result.category || null,
    content: truncateText(result.content, 500),
    trust: result.trust || bootstrapTrustForType(result.type),
    whyUse: result.whyUse || bootstrapUseHint(result),
    verificationRequired: Boolean(result.verificationRequired),
    source: result.source || null,
    retrieval: result.retrieval || null,
    memoryId: result.memoryId || null,
    checkpointId: result.checkpointId || (result.type === 'checkpoint' ? result.key : null),
    candidateId: result.candidateId || null,
    sessionId: result.sessionId || null,
    level: result.level ?? null,
    coversFrom: result.coversFrom || null,
    coversTo: result.coversTo || null,
    checkpointSource: result.checkpointSource || null,
    sourceRef: result.sourceRef || null,
    status: result.status || null,
  };
}

function isLiveStateCorrection(text) {
  const value = String(text || '');
  return [
    /\bpr\s*#?\d+\b/i,
    /\bpull request\s*#?\d+\b/i,
    /\bissue\s*#?\d+\b/i,
    /\b(branch|commit|tag|release)\s+[\w./-]+\b/i,
    /\b(merged?|deployed|released|rolled back|rollback)\s+(to|into|from|on|in)\b/i,
    /\b(ci|check run|github action|workflow run|migration|runtime|deployment|server|service|queue)\s+(failed|passing|passed|running|stopped|down|up|merged|deployed|current|pending)\b/i,
    /\b(alembic|migration|migrations)\s+(current|heads?|upgraded?|downgraded?|applied|pending)\b/i,
  ].some((pattern) => pattern.test(value)) || liveStateTermsMatch(value);
}

function liveStateTermsMatch(text) {
  return /(\b(branch\w*|prs?|pull requests?|issues?|ci|checks?|runtimes?|deploy\w*|deployments?|migrations?|migrate\w*|servers?|services?|queues?|status|drafts?|merge\w*|merged|commits?|tags?|releases?|rollbacks?)\b|브랜치|원격|머지|이슈|배포|런타임|마이그레이션|마이그레이트|커밋|릴리즈|롤백|서버|서비스|큐|상태)/i.test(
    String(text || ''),
  );
}

function checkpointTimestamp(checkpoint) {
  return checkpoint?.createdAt ? Date.parse(checkpoint.createdAt) : null;
}

function isDistillableRawEvent(event) {
  return event?.role === 'user' || event?.role === 'assistant';
}

function eventsAfterCheckpoint(events, checkpoint) {
  const sourceRawEventIds = Array.isArray(checkpoint?.metadata?.sourceRawEventIds)
    ? checkpoint.metadata.sourceRawEventIds
    : [];
  const lastSourceRawEventId = sourceRawEventIds.at(-1);
  if (lastSourceRawEventId) {
    const lastSourceIndex = events.findIndex((event) => event.id === lastSourceRawEventId);
    if (lastSourceIndex !== -1) {
      return events.slice(lastSourceIndex + 1).filter(isDistillableRawEvent);
    }
  }

  const checkpointTime = checkpointTimestamp(checkpoint);
  if (!checkpointTime) return events.filter(isDistillableRawEvent);
  return events.filter((event) => isDistillableRawEvent(event) && Date.parse(event.createdAt) > checkpointTime);
}

function selectDistillWindow(rawEvents, latestCheckpoint, policy) {
  const candidateEvents = eventsAfterCheckpoint(rawEvents, latestCheckpoint);
  const selected = [];
  let selectedChars = 0;
  const maxEvents = policy.maxEvents;
  const maxChars = policy.maxChars;

  for (let index = 0; index < candidateEvents.length; index += 1) {
    if (selected.length >= maxEvents) break;
    const event = candidateEvents[index];
    const eventChars = String(event.content || '').length;
    if (selected.length > 0 && selectedChars + eventChars > maxChars) {
      break;
    }
    selected.push(event);
    selectedChars += eventChars;
    if (selectedChars >= maxChars) {
      break;
    }
  }

  return {
    events: selected,
    metadata: {
      mode: latestCheckpoint ? 'since_latest_checkpoint_recent_window' : 'initial_recent_window',
      totalRawEventCount: rawEvents.length,
      candidateEventCount: candidateEvents.length,
      candidateCharCount: rawCharCount(candidateEvents),
      selectedEventCount: selected.length,
      selectedCharCount: selectedChars,
      maxEvents,
      maxChars,
      truncated: selected.length < candidateEvents.length,
      firstRawEventId: selected[0]?.id || null,
      lastRawEventId: selected.at(-1)?.id || null,
    },
  };
}

function coverageFromEvents(events) {
  return {
    coversFrom: events[0]?.createdAt || null,
    coversTo: events.at(-1)?.createdAt || null,
  };
}

function buildSessionStatus({ scope, sessionId, rawEvents, latestCheckpoint, policy, now = new Date() }) {
  const eventsSinceLastCheckpoint = eventsAfterCheckpoint(rawEvents, latestCheckpoint);
  const distillWindow = selectDistillWindow(rawEvents, latestCheckpoint, policy);
  const rawEventCount = rawEvents.length;
  const rawCharTotal = rawCharCount(rawEvents);
  const charsSinceLastCheckpoint = rawCharCount(eventsSinceLastCheckpoint);
  const latestCheckpointTime = checkpointTimestamp(latestCheckpoint);
  const elapsedMs = latestCheckpointTime ? Math.max(0, now.getTime() - latestCheckpointTime) : null;
  const latestCheckpointMemoryCandidateCount = Array.isArray(latestCheckpoint?.metadata?.memoryCandidates)
    ? latestCheckpoint.metadata.memoryCandidates.length
    : 0;
  const reasons = [];

  if (rawEventCount === 0) {
    reasons.push('no_raw_events');
  }
  if (!latestCheckpoint && rawCharTotal >= policy.charThreshold) {
    reasons.push('initial_char_threshold');
  }
  if (!latestCheckpoint && rawEventCount >= policy.minEvents && rawCharTotal >= policy.charThreshold) {
    reasons.push('initial_event_and_char_threshold');
  }
  if (latestCheckpoint && eventsSinceLastCheckpoint.length >= policy.minEvents && elapsedMs >= policy.minIntervalMs) {
    reasons.push('events_and_interval_since_checkpoint');
  }
  if (
    latestCheckpoint &&
    charsSinceLastCheckpoint >= policy.charThreshold &&
    elapsedMs >= policy.charMinIntervalMs
  ) {
    reasons.push('char_threshold_since_checkpoint');
  }

  return {
    sessionId,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    rawEventCount,
    rawCharCount: rawCharTotal,
    latestCheckpointId: latestCheckpoint?.id || null,
    latestCheckpointAt: latestCheckpoint?.createdAt || null,
    latestCheckpointMemoryCandidateCount,
    memoryCandidateHint:
      latestCheckpointMemoryCandidateCount > 0
        ? 'Call list_memory_candidates with this sessionId or latestCheckpointId before promoting durable memory.'
        : null,
    eventsSinceLastCheckpoint: eventsSinceLastCheckpoint.length,
    charsSinceLastCheckpoint,
    elapsedSinceLastCheckpointMs: elapsedMs,
    thresholds: policy,
    distillWindow: distillWindow.metadata,
    shouldDistill: reasons.some((reason) => reason !== 'no_raw_events'),
    reasons,
  };
}

function dueDistillSessionSummary(candidate, status, idleElapsedMs) {
  return {
    scopeType: candidate.scopeType,
    scopeKey: candidate.scopeKey,
    sessionId: candidate.sessionId,
    latestCheckpointAt: candidate.latestCheckpointAt || null,
    firstRawAfterCheckpointAt: candidate.firstRawAfterCheckpointAt || null,
    latestRawAt: candidate.latestRawAt || null,
    idleElapsedMs,
    latestRunStatus: candidate.latestRunStatus || null,
    latestRunAt: candidate.latestRunAt || null,
    latestRunCompletedAt: candidate.latestRunCompletedAt || null,
    eventsSinceLastCheckpoint: status.eventsSinceLastCheckpoint,
    charsSinceLastCheckpoint: status.charsSinceLastCheckpoint,
    distillWindow: status.distillWindow,
    reasons: status.reasons,
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

function rawTtlCutoffIso(ttlDays, now = new Date()) {
  positiveNumber(Number(ttlDays), 'ttlDays');
  return new Date(now.getTime() - Number(ttlDays) * 24 * 60 * 60 * 1000).toISOString();
}

const RUNTIME_SETTING_KEYS = new Set([
  'distillProvider',
  'distillPolicy',
  'codexExec',
  'openAiCompatible',
  'autoPromoteAudit',
]);

const SECRET_KEYS = {
  openAiCompatibleApiKey: 'openAiCompatible.apiKey',
};

const DISTILL_MODEL_PRESETS = {
  openai_compatible: {
    deepseek: {
      label: 'DeepSeek V4 Flash',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      responseFormat: 'json_object',
    },
    deepseekPro: {
      label: 'DeepSeek V4 Pro',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      responseFormat: 'json_object',
    },
    deepseekChat: {
      label: 'DeepSeek Chat',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      responseFormat: 'json_object',
    },
    deepseekReasoner: {
      label: 'DeepSeek Reasoner',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      responseFormat: 'json_object',
    },
    custom: {
      label: 'Custom OpenAI-compatible',
      baseUrl: '',
      model: '',
      responseFormat: 'json_object',
    },
  },
  codex_exec: {
    configured: {
      label: 'Configured Codex model',
      model: null,
    },
    gpt55: {
      label: 'GPT-5.5',
      model: 'gpt-5.5',
      reasoningEffort: 'low',
    },
    gpt54: {
      label: 'GPT-5.4',
      model: 'gpt-5.4',
      reasoningEffort: 'low',
    },
    gpt54Mini: {
      label: 'GPT-5.4 Mini',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
    },
    codex: {
      label: 'GPT-5.3 Codex',
      model: 'gpt-5.3-codex',
      reasoningEffort: 'low',
    },
    manual: {
      label: 'Manual Codex model',
      model: '',
    },
  },
};

function plainSettings(runtimeSettings) {
  const result = {};
  for (const [key, entry] of Object.entries(runtimeSettings?.settings || {})) {
    result[key] = entry.value;
  }
  return result;
}

function effectiveRuntimeConfig(config, runtimeSettings = { settings: {}, secrets: {} }) {
  const settings = plainSettings(runtimeSettings);
  const distillPolicy = {
    ...config.distillPolicy,
    ...(settings.distillPolicy || {}),
  };
  const codexExec = {
    ...config.codexExec,
    ...(settings.codexExec || {}),
  };
  const openAiCompatible = {
    ...config.openAiCompatible,
    ...(settings.openAiCompatible || {}),
    apiKey: runtimeSettings.secrets?.[SECRET_KEYS.openAiCompatibleApiKey] || config.openAiCompatible.apiKey || null,
  };
  const autoPromoteAudit = {
    ...config.autoPromote.audit,
    ...(settings.autoPromoteAudit || {}),
  };
  return {
    distillProvider: settings.distillProvider || config.distillProvider,
    distillPolicy,
    codexExec,
    openAiCompatible,
    autoPromoteAudit,
  };
}

function sanitizedRuntimeSettings(config, runtimeSettings = { settings: {}, secrets: {} }) {
  const effective = effectiveRuntimeConfig(config, runtimeSettings);
  return {
    effective: {
      distillProvider: effective.distillProvider,
      distillPolicy: effective.distillPolicy,
      codexExec: {
        ...effective.codexExec,
        runner: undefined,
      },
      openAiCompatible: {
        ...effective.openAiCompatible,
        apiKey: undefined,
        secretPresent: Boolean(effective.openAiCompatible.apiKey),
      },
      autoPromoteAudit: effective.autoPromoteAudit,
      presets: DISTILL_MODEL_PRESETS,
    },
    stored: runtimeSettings.settings,
  };
}

function pickKnownSettings(values = {}) {
  const picked = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (RUNTIME_SETTING_KEYS.has(key)) {
      if (key === 'openAiCompatible' && value && typeof value === 'object' && !Array.isArray(value)) {
        const { apiKey, ...safeOpenAiCompatible } = value;
        if (apiKey != null) {
          throw new Error('openAiCompatible.apiKey must be provided through the write-only secrets channel.');
        }
        picked[key] = safeOpenAiCompatible;
      } else {
        picked[key] = value;
      }
    }
  }
  return picked;
}

export function createContextForge(options = {}) {
  const config = loadConfig(options);
  if (config.storageMode === 'remote') {
    return createRemoteContextForge(config, { fetchImpl: options.fetchImpl });
  }

  const sharedStore = options.store || (options.reuseStore ? new ContextForgeStore({ dataDir: config.dataDir }) : null);
  const distillProviders = options.distillProviders || {};
  const embeddingProvider = createEmbeddingProvider(config, options.embeddingProviders || {}, {
    fetchImpl: options.fetchImpl,
  });
  const codexExec = {
    ...config.codexExec,
    runner: options.codexExecRunner,
  };
  const runtimeFetchImpl = options.fetchImpl;
  const useStore = (fn) => {
    if (sharedStore) {
      return fn(sharedStore);
    }
    return withStore(config, fn);
  };
  let lastRawPruneAt = 0;

  function getEffectiveRuntime(store) {
    return effectiveRuntimeConfig(config, store.getRuntimeSettings({ includeSecrets: true }));
  }

  function getAutoPromoteAuditor(store) {
    if (Object.prototype.hasOwnProperty.call(options, 'autoPromoteAuditor')) {
      return options.autoPromoteAuditor;
    }
    const audit = getEffectiveRuntime(store).autoPromoteAudit;
    if (!audit.enabled) {
      return null;
    }
    if (audit.provider === 'codex_exec') {
      return createCodexExecAutoPromoteAuditor({
        ...audit,
        runner: options.autoPromoteAuditRunner,
      });
    }
    if (audit.provider === 'codex_sdk_python') {
      return createCodexSdkPythonAutoPromoteAuditor({
        ...audit,
        runner: options.autoPromoteAuditRunner,
      });
    }
    throw new Error(`Unsupported auto-promotion audit provider "${audit.provider}".`);
  }

  function buildDbInfo(store) {
    const storeInfo = store.dbInfo();
    const jobs = store.countEmbeddingJobs();
    const processConnectionMode = config.runtime.role === 'http-server' ? 'http-server' : 'direct-local';
    const accessMode = config.runtime.role === 'http-server' ? 'server-process' : 'direct-local';
    const accessPath = config.runtime.role === 'http-server' ? 'in-process' : 'direct-local';
    const serverRole = config.runtime.role === 'http-server' ? 'http-server' : null;
    const coverage =
      embeddingProvider && storeInfo.vector.sqliteVecAvailable
        ? store.embeddingCoverage({
            model: embeddingProvider.model,
            dimensions: embeddingProvider.dimensions,
          })
        : null;
    return {
      ...storeInfo,
      storageMode: config.storageMode,
      connection: {
        mode: processConnectionMode,
        accessMode,
        accessPath,
        processRole: config.runtime.role,
        serverRole,
        viewpoint: 'this ContextForge process',
        storageMode: config.storageMode,
        storageAuthority:
          config.storageMode === 'remote'
            ? 'remote-server'
            : config.storageMode === 'local'
              ? 'local'
              : 'project-local',
        note:
          config.runtime.role === 'http-server'
            ? 'This response is from the ContextForge HTTP server process. Its storageMode describes the server-owned store.'
            : 'This response is from a local ContextForge process. Its storageMode describes this process.',
        summary: `${accessPath} ${config.runtime.role}`,
      },
      embeddings: {
        provider: config.embeddings.provider,
        model: config.embeddings.model,
        dimensions: config.embeddings.dimensions,
        staleAfterMs: config.embeddings.staleAfterMs,
        enabled: Boolean(embeddingProvider),
        requiredForQuality: true,
        degraded: !embeddingProvider || !storeInfo.vector.sqliteVecAvailable || Boolean(coverage?.staleSources) || Boolean(jobs.failed),
        jobs,
        coverage,
      },
      rawRetention: {
        ttlDays: config.rawRetention.ttlDays,
        pruneIntervalMs: config.rawRetention.pruneIntervalMs,
      },
      scopeAliases: {
        count: config.scopeAliases.length,
        aliases: config.scopeAliases,
      },
    };
  }

  function pruneRawEventsIfDue(store, now = new Date()) {
    if (!config.rawRetention.ttlDays) {
      return null;
    }
    const nowMs = now.getTime();
    if (nowMs - lastRawPruneAt < config.rawRetention.pruneIntervalMs) {
      return null;
    }
    lastRawPruneAt = nowMs;
    return store.pruneRawEventsOlderThan(rawTtlCutoffIso(config.rawRetention.ttlDays, now));
  }

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

  function searchStoreWithScope(store, scope, options, queryEmbedding = null) {
    return searchMemories(store, {
      ...scope,
      query: options.query,
      limit: options.limit,
      searchScopes: options.searchScopes,
      sharedScopeKey: options.sharedScopeKey || config.defaultSharedScopeKey,
      queryEmbedding,
    });
  }

  function searchWithScope(scope, options) {
    if (!embeddingProvider) {
      return useStore((store) => searchStoreWithScope(store, scope, options));
    }
    return useStore(async (store) => {
      const [queryEmbedding] = await embeddingProvider.embed([options.query]);
      return searchStoreWithScope(store, scope, options, queryEmbedding);
    });
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

  function memoryLifecycleForScope(store, scope) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      ...store.memoryLifecycleSummary({ ...scope, sinceIso: since }),
      since,
      useHint:
        'Health signal for candidate/promotion flow only; inspect candidates explicitly before treating review material as durable truth.',
    };
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

  return {
    config,

    close() {
      if (sharedStore) {
        sharedStore.close();
      }
    },

    dbInfo() {
      return useStore((store) => buildDbInfo(store));
    },

    migrateScope(options = {}) {
      const from = migrationScopeOptions(options, 'from');
      const toInput = migrationScopeOptions(options, 'to', from.scopeType);
      const to = normalizeScopeOptions({ scope: toInput.scopeType, scopeKey: toInput.scopeKey }, config);
      return useStore((store) =>
        store.migrateScope({
          fromScopeType: from.scopeType,
          fromScopeKey: from.scopeKey,
          toScopeType: to.scopeType,
          toScopeKey: to.scopeKey,
          dryRun: options.dryRun == null ? true : truthyOption(options.dryRun),
        }),
      );
    },

    getRuntimeSettings() {
      return useStore((store) => {
        const redacted = store.getRuntimeSettings();
        const withSecrets = store.getRuntimeSettings({ includeSecrets: true });
        return {
          ...sanitizedRuntimeSettings(config, withSecrets),
          stored: redacted.settings,
        };
      });
    },

    updateRuntimeSettings(options = {}) {
      const values = pickKnownSettings(options.values || options.settings || {});
      const secrets = {};
      if (options.openAiCompatibleApiKey) {
        secrets[SECRET_KEYS.openAiCompatibleApiKey] = options.openAiCompatibleApiKey;
      }
      if (options.secrets?.openAiCompatibleApiKey) {
        secrets[SECRET_KEYS.openAiCompatibleApiKey] = options.secrets.openAiCompatibleApiKey;
      }
      const clearSecrets = [];
      if (truthyOption(options.clearOpenAiCompatibleApiKey) || options.clearSecrets?.includes('openAiCompatibleApiKey')) {
        clearSecrets.push(SECRET_KEYS.openAiCompatibleApiKey);
      }
      return useStore((store) => {
        store.setRuntimeSettings({ values, secrets, clearSecrets });
        const redacted = store.getRuntimeSettings();
        const withSecrets = store.getRuntimeSettings({ includeSecrets: true });
        return {
          ...sanitizedRuntimeSettings(config, withSecrets),
          stored: redacted.settings,
        };
      });
    },

    checkDistillProvider(options = {}) {
      return useStore(async (store) => {
        const effective = getEffectiveRuntime(store);
        const providerName = options.provider || effective.distillProvider;
        if (providerName === 'codex_exec') {
          return checkCodexExecProvider({
            ...effective.codexExec,
            runner: options.codexExecRunner || options.runner || options.codexRunner || codexExec.runner,
            live: Boolean(options.live),
          });
        }
        if (providerName === 'openai_compatible') {
          return checkOpenAiCompatibleProvider({
            ...effective.openAiCompatible,
            fetchImpl: runtimeFetchImpl,
            live: Boolean(options.live),
          });
        }
        if (providerName === 'mock') {
          return { ok: true, provider: 'mock', message: 'mock provider is always available.' };
        }
        throw new Error(`Unsupported distill provider "${providerName}".`);
      });
    },

    async bootstrapContext(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.query, 'query');
      const limit = positiveNumber(options.limit == null ? 8 : Number(options.limit), 'limit');
      const sharedLimit = Math.min(3, limit);
      const includeShared = truthyOption(options.includeShared);
      const sessionId = options.sessionId || null;
      const latestCheckpointLimit = boundedInteger(
        options.latestCheckpointLimit == null ? 1 : Number(options.latestCheckpointLimit),
        'latestCheckpointLimit',
        { min: 0, max: 3 },
      );
      const relatedScopeKeys = normalizeRelatedScopeKeys(options.relatedScopeKeys).filter(
        (scopeKey) => scopeKey !== scope.scopeKey,
      );
      const rawTailLimit = sessionId
        ? nonnegativeNumber(options.rawTailLimit == null ? 0 : Number(options.rawTailLimit), 'rawTailLimit')
        : null;
      return useStore(async (store) => {
        const info = buildDbInfo(store);
        const queryEmbedding = embeddingProvider
          ? (await embeddingProvider.embed([options.query]))[0]
          : null;
        const repoResults = searchStoreWithScope(
          store,
          scope,
          {
            query: options.query,
            limit,
            sharedScopeKey: options.sharedScopeKey,
          },
          queryEmbedding,
        );
        const sharedScopeKey = options.sharedScopeKey || config.defaultSharedScopeKey;
        const sharedSkippedReason =
          includeShared && scope.scopeType !== 'shared' && !sharedScopeKey
            ? 'missing_shared_scope_key'
            : null;
        const sharedResults =
          includeShared && scope.scopeType !== 'shared' && sharedScopeKey
            ? searchStoreWithScope(
                store,
                {
                  scopeType: 'shared',
                  scopeKey: sharedScopeKey,
                },
                {
                  query: options.query,
                  limit: sharedLimit,
                  sharedScopeKey,
                },
                queryEmbedding,
              )
            : [];
        const results = [
          ...repoResults.map((result) => bootstrapResult(result, 'primary')),
          ...sharedResults.map((result) => bootstrapResult(result, 'shared')),
        ];
        const handoffScopes = [
          scope,
          ...relatedScopeKeys.map((scopeKey) => ({
            scopeType: 'repo',
            scopeKey,
          })),
        ];
        // Fetch extra recent checkpoints so latestByAgent can surface multiple
        // active adapters even when one agent produced several recent handoffs.
        const handoffFetchLimit = latestCheckpointLimit > 0 ? Math.max(latestCheckpointLimit, 10) : 0;
        const fetchedLatestCheckpoints =
          handoffFetchLimit > 0
            ? handoffScopes.map((handoffScope) =>
                store
                  .listRecentCheckpoints({
                    ...handoffScope,
                    level: 0,
                    limit: handoffFetchLimit,
                  })
                  .map((checkpoint) => checkpointHandoffCompact(checkpoint, handoffScope)),
              )
            : [];
        const latestCheckpoints = fetchedLatestCheckpoints.flatMap((checkpoints) =>
          checkpoints.slice(0, latestCheckpointLimit),
        );
        const latestHandoff = latestCheckpoints[0] || null;
        const latestByAgent = latestHandoffByAgent(fetchedLatestCheckpoints.flat());
        const latestRepoConsolidation = compactConsolidationCheckpoint(
          store.getLatestConsolidationCheckpoint({
            ...scope,
            target: 'repo',
          }),
        );
        const latestThreadConsolidation = sessionId
          ? compactConsolidationCheckpoint(
              store.getLatestConsolidationCheckpoint({
                ...scope,
                target: 'thread',
                sessionId,
              }),
            )
          : null;
        const workingSummary = sessionId
          ? bootstrapWorkingSummary(store.getWorkingSummary({ ...scope, sessionId }))
          : null;
        const structuredWorkingContext = sessionId
          ? bootstrapSessionWorkingContext(store.getSessionWorkingContext({ ...scope, sessionId }))
          : null;
        const rawTail = sessionId && rawTailLimit > 0
          ? store
              .listRecentRawEvents({ ...scope, sessionId, limit: rawTailLimit })
              .map((event) => bootstrapRawTailEvent(event))
          : [];
        return {
          scope,
          storage: storageBootstrapInfo(config, info),
          query: options.query,
          includeShared,
          sharedLimit: includeShared ? sharedLimit : null,
          handoff: {
            latestHandoff,
            latestByAgent,
            latestCheckpoints,
            latestConsolidation: {
              thread: latestThreadConsolidation,
              repo: latestRepoConsolidation,
            },
            latestCheckpointLimit,
            relatedScopeKeys,
            trustOrder: ['live_source', 'recent_checkpoint', 'durable_memory', 'memory_candidate'],
            useHint:
              'Read latestCheckpoints for immediate state and latestConsolidation for period context before durable memory; verify mutable claims against GitHub/git/CI/runtime before acting.',
          },
          memoryLifecycle: memoryLifecycleForScope(store, scope),
          ...(sessionId ? { sessionId, workingSummary, structuredWorkingContext, rawTail, rawTailLimit } : {}),
          ...(sharedSkippedReason ? { sharedSkippedReason } : {}),
          summary: bootstrapSummary(results),
          results,
          nextActions: [
            'Verify current git/GitHub/CI/runtime/migration state before final claims or risky actions.',
            'Review memory_candidate results at task end if durable lessons remain.',
          ],
        };
      });
    },

    async syncResumeContext(options = {}) {
      requireOption(options.query, 'query');
      const bootstrap = await this.bootstrapContext({
        ...options,
        limit: options.limit == null ? 8 : options.limit,
      });
      const durableMemories = [];
      const recentCheckpoints = [];
      const memoryCandidateResults = [];
      const latestCheckpoint = bootstrap.sessionId
        ? useStore((store) => store.getLatestCheckpoint({ ...bootstrap.scope, sessionId: bootstrap.sessionId, level: 0 }))
        : null;

      for (const result of bootstrap.results || []) {
        if (result.type === 'memory') {
          durableMemories.push(result);
        } else if (result.type === 'checkpoint') {
          recentCheckpoints.push(resumeCheckpoint(result));
        } else if (result.type === 'memory_candidate') {
          memoryCandidateResults.push(result);
        }
      }
      if (latestCheckpoint && recentCheckpoints.length === 0) {
        recentCheckpoints.push(checkpointHandoffResult(latestCheckpoint));
      }
      if (latestCheckpoint && memoryCandidateResults.length === 0) {
        const latestCandidates = useStore((store) => {
          return store.listMemoryCandidates({
            ...bootstrap.scope,
            checkpointId: latestCheckpoint.id,
            status: 'pending',
            sort: 'recommendation',
            limit: 3,
          });
        });
        memoryCandidateResults.push(...latestCandidates);
      }

      return {
        kind: 'resume_context',
        scope: bootstrap.scope,
        storage: bootstrap.storage,
        query: bootstrap.query,
        includeShared: bootstrap.includeShared,
        ...(bootstrap.sessionId ? { sessionId: bootstrap.sessionId } : {}),
        handoff: {
          latestHandoff: bootstrap.handoff?.latestHandoff || null,
          workingSummary: bootstrap.workingSummary || null,
          structuredWorkingContext: bootstrap.structuredWorkingContext || null,
          rawTail: bootstrap.rawTail || [],
          durableMemories,
          recentCheckpoints,
          memoryCandidates: {
            count: memoryCandidateResults.length,
            items: memoryCandidateResults
              .slice(0, 3)
              .map((candidate) =>
                candidate.candidate ? compactIndexedCandidate(candidate) : compactBootstrapCandidate(candidate),
              ),
            trust: 'review_material',
            useHint: 'Review material only; do not turn these into promotion proposals during resume sync.',
          },
        },
        trustPolicy: {
          durableMemory: 'canonical long-term guidance when reviewed and active',
          checkpoint:
            'credible recent handoff state; use actively for continuity, planning, prior intent, recent decisions, and unfinished work',
          memoryCandidate: 'review material only, not durable truth and not a resume-time promotion proposal',
          liveState: 'final authority for mutable branch, PR, issue, CI, runtime, deployment, and migration state',
        },
        suggestedLiveChecks: [
          'git status --short --branch',
          'git remote -v',
          'git rev-list --left-right --count HEAD...@{u}',
          'gh pr view/list or gh issue view/list when ids are known',
          'run project-specific CI/runtime/migration checks when relevant',
        ],
        nextActions: [
          'Summarize the last known task state and safe next action.',
          'Use checkpoint handoff actively for continuity, planning, prior intent, recent decisions, and unfinished work.',
          'Verify only mutable live state such as git, GitHub, CI, runtime, and migrations before acting.',
          'Do not propose memory promotions during resume sync.',
        ],
      };
    },

    checkCodexExec(options = {}) {
      return useStore((store) => {
        const effective = getEffectiveRuntime(store);
        return checkCodexExecProvider({
          ...effective.codexExec,
          runner: codexExec.runner,
          live: Boolean(options.live),
        });
      });
    },

    beginSession(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return {
        sessionId: options.sessionId || `cf_${randomUUID()}`,
        conversationId: options.conversationId || null,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        createdAt: new Date().toISOString(),
      };
    },

    sessionStatus(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) => {
        const effective = getEffectiveRuntime(store);
        const policy = {
          minEvents: positiveNumber(
            options.minEvents == null ? effective.distillPolicy.minEvents : Number(options.minEvents),
            'minEvents',
          ),
          minIntervalMs: positiveNumber(
            options.minIntervalMs == null ? effective.distillPolicy.minIntervalMs : Number(options.minIntervalMs),
            'minIntervalMs',
          ),
          charThreshold: positiveNumber(
            options.charThreshold == null ? effective.distillPolicy.charThreshold : Number(options.charThreshold),
            'charThreshold',
          ),
          charMinIntervalMs: positiveNumber(
            options.charMinIntervalMs == null
              ? effective.distillPolicy.charMinIntervalMs
              : Number(options.charMinIntervalMs),
            'charMinIntervalMs',
          ),
          maxEvents: positiveNumber(
            options.maxEvents == null ? effective.distillPolicy.maxEvents : Number(options.maxEvents),
            'maxEvents',
          ),
          maxChars: positiveNumber(
            options.maxChars == null ? effective.distillPolicy.maxChars : Number(options.maxChars),
            'maxChars',
          ),
        };
        return buildSessionStatus({
          scope,
          sessionId: options.sessionId,
          rawEvents: store.listRawEvents({ ...scope, sessionId: options.sessionId }),
          latestCheckpoint: store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId, level: 0 }),
          policy,
        });
      });
    },

    listDueDistillSessions(options = {}) {
      const shouldNarrowScope = Boolean(options.scope || options.scopeType || options.scopeKey || options.cwd || options.repoPath);
      const scope = shouldNarrowScope ? normalizeScopeOptions(options, config) : null;
      const limit = positiveNumber(options.limit == null ? 20 : Number(options.limit), 'limit');
      const scanLimit = positiveNumber(
        options.scanLimit == null ? Math.max(50, limit * 5) : Number(options.scanLimit),
        'scanLimit',
      );
      const idleMs = nonnegativeNumber(options.idleMs == null ? 600000 : Number(options.idleMs), 'idleMs');
      const activeRunMaxAgeMs = nonnegativeNumber(
        options.activeRunMaxAgeMs == null ? 300000 : Number(options.activeRunMaxAgeMs),
        'activeRunMaxAgeMs',
      );
      const order = options.order === 'desc' ? 'desc' : 'asc';

      return useStore((store) => {
        const effective = getEffectiveRuntime(store);
        const policy = {
          minEvents: positiveNumber(
            options.minEvents == null ? effective.distillPolicy.minEvents : Number(options.minEvents),
            'minEvents',
          ),
          minIntervalMs: positiveNumber(
            options.minIntervalMs == null ? effective.distillPolicy.minIntervalMs : Number(options.minIntervalMs),
            'minIntervalMs',
          ),
          charThreshold: positiveNumber(
            options.charThreshold == null ? effective.distillPolicy.charThreshold : Number(options.charThreshold),
            'charThreshold',
          ),
          charMinIntervalMs: positiveNumber(
            options.charMinIntervalMs == null
              ? effective.distillPolicy.charMinIntervalMs
              : Number(options.charMinIntervalMs),
            'charMinIntervalMs',
          ),
          maxEvents: positiveNumber(
            options.maxEvents == null ? effective.distillPolicy.maxEvents : Number(options.maxEvents),
            'maxEvents',
          ),
          maxChars: positiveNumber(
            options.maxChars == null ? effective.distillPolicy.maxChars : Number(options.maxChars),
            'maxChars',
          ),
        };
        const now = new Date();
        const candidates = store.listSessionsWithRawAfterCheckpoint({
          scopeType: scope?.scopeType || null,
          scopeKey: scope?.scopeKey || null,
          limit: scanLimit,
          order,
          minEvents: policy.minEvents,
          charThreshold: policy.charThreshold,
        });
        const due = [];
        const skipped = [];
        for (const candidate of candidates) {
          const latestRawTime = Date.parse(candidate.latestRawAt || '');
          const idleElapsedMs = Number.isFinite(latestRawTime) ? Math.max(0, now.getTime() - latestRawTime) : null;
          if (idleElapsedMs != null && idleElapsedMs < idleMs) {
            skipped.push({ ...candidate, reason: 'idle_window' });
            continue;
          }
          const latestRunTime = Date.parse(candidate.latestRunAt || '');
          if (
            candidate.latestRunStatus === 'started' &&
            Number.isFinite(latestRunTime) &&
            now.getTime() - latestRunTime < activeRunMaxAgeMs
          ) {
            skipped.push({ ...candidate, reason: 'active_started_run' });
            continue;
          }
          const candidateScope = { scopeType: candidate.scopeType, scopeKey: candidate.scopeKey };
          const rawEvents = store.listRawEvents({ ...candidateScope, sessionId: candidate.sessionId });
          const latestCheckpoint = store.getLatestCheckpoint({
            ...candidateScope,
            sessionId: candidate.sessionId,
            level: 0,
          });
          const status = buildSessionStatus({
            scope: candidateScope,
            sessionId: candidate.sessionId,
            rawEvents,
            latestCheckpoint,
            policy,
            now,
          });
          if (!status.shouldDistill) {
            skipped.push({ ...candidate, reason: 'below_threshold' });
            continue;
          }
          due.push(dueDistillSessionSummary(candidate, status, idleElapsedMs));
          if (due.length >= limit) {
            break;
          }
        }
        return {
          scope: scope ? { scopeType: scope.scopeType, scopeKey: scope.scopeKey } : null,
          limit,
          scanLimit,
          idleMs,
          activeRunMaxAgeMs,
          order,
          scanned: candidates.length,
          dueCount: due.length,
          skippedCount: skipped.length,
          skipReasonCounts: skipped.reduce((counts, item) => {
            counts[item.reason] = (counts[item.reason] || 0) + 1;
            return counts;
          }, {}),
          sessions: due,
        };
      });
    },

    async processDueDistills(options = {}) {
      const limit = positiveNumber(options.limit == null ? 5 : Number(options.limit), 'limit');
      const dryRun = options.dryRun === true || options.dryRun === 'true';
      const due = await this.listDueDistillSessions({
        ...options,
        limit,
      });
      const result = {
        dryRun,
        limit,
        scanLimit: due.scanLimit,
        idleMs: due.idleMs,
        activeRunMaxAgeMs: due.activeRunMaxAgeMs,
        scanned: due.scanned,
        dueCount: due.dueCount,
        skippedCount: due.skippedCount,
        skipReasonCounts: due.skipReasonCounts,
        processed: 0,
        failed: 0,
        sessions: due.sessions,
        results: [],
      };
      if (dryRun) {
        return result;
      }
      for (const session of due.sessions) {
        try {
          const checkpoint = await this.distillCheckpoint({
            scope: session.scopeType,
            scopeKey: session.scopeKey,
            sessionId: session.sessionId,
            provider: options.provider,
            maxEvents: options.maxEvents,
            maxChars: options.maxChars,
          });
          result.processed += 1;
          result.results.push({
            scopeType: session.scopeType,
            scopeKey: session.scopeKey,
            sessionId: session.sessionId,
            status: 'succeeded',
            checkpointId: checkpoint.id,
            sourceEventCount: checkpoint.sourceEventCount,
            createdAt: checkpoint.createdAt,
          });
        } catch (error) {
          result.failed += 1;
          result.results.push({
            scopeType: session.scopeType,
            scopeKey: session.scopeKey,
            sessionId: session.sessionId,
            status: 'failed',
            error: errorSummary(error),
          });
        }
      }
      return result;
    },

    remember(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => {
        const memory = store.rememberMemory({
          ...scope,
          key: options.key,
          content: options.content,
          category: options.category,
          tags: options.tags,
          importance: options.importance,
        });
        enqueueEmbeddingSources(store, [store.embeddingSourceForMemory(memory)]);
        return memory;
      });
    },

    promoteMemory(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      requireOption(options.content, 'content');

      return useStore((store) => {
        const memory = store.rememberMemory({
          ...scope,
          key: options.key,
          content: options.content,
          category: options.category || 'note',
          tags: options.tags,
          importance: options.importance,
          eventType: 'promote',
          eventMetadata: {
            key: options.key,
            sourceCheckpointId: options.sourceCheckpointId || null,
            sourceSessionId: options.sourceSessionId || null,
            sourceRawEventIds: options.sourceRawEventIds || [],
            sourceCandidateIndex: options.sourceCandidateIndex ?? null,
            reason: options.reason || null,
          },
        });
        enqueueEmbeddingSources(store, [store.embeddingSourceForMemory(memory)]);
        return memory;
      });
    },

    correctMemory(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      requireOption(options.content, 'content');

      return useStore((store) => {
        const previous = store.getMemory({ ...scope, key: options.key });
        if (!previous) {
          throw new Error(`Memory not found: ${options.key}`);
        }

        const memory = store.rememberMemory({
          ...scope,
          key: options.key,
          content: options.content,
          category: options.category || previous.category,
          tags: options.tags?.length ? options.tags : previous.tags,
          importance: options.importance == null ? previous.importance : options.importance,
          supersedesMemoryId: previous.id,
          eventType: 'correct',
          eventMetadata: {
            key: options.key,
            previousMemoryId: previous.id,
            previousContent: previous.content,
            reason: options.reason || null,
          },
        });
        enqueueEmbeddingSources(store, [store.embeddingSourceForMemory(memory)]);
        return memory;
      });
    },

    deactivateMemory(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      return useStore((store) =>
        store.deactivateMemory({
          ...scope,
          key: options.key,
          reason: options.reason,
        }),
      );
    },

    listMemoryEvents(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      return useStore((store) =>
        store.listMemoryEvents({
          ...scope,
          key: options.key,
        }),
      );
    },

    listMemoryCandidates(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listMemoryCandidates({
          ...scope,
          sessionId: options.sessionId || null,
          checkpointId: options.checkpointId || null,
          status: options.status || null,
          candidateType: options.candidateType || null,
          promotionRecommendation: options.promotionRecommendation || null,
          sort: options.sort || null,
          limit: options.limit == null ? null : Number(options.limit),
        }),
      );
    },

    listPreferenceOccurrences(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listPreferenceOccurrences({
          ...scope,
          status: options.status || null,
          limit: options.limit == null ? null : Number(options.limit),
        }),
      );
    },

    listMemoryUpdateCandidates(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listMemoryUpdateCandidates({
          ...scope,
          status: options.status || null,
          action: options.action || null,
          limit: options.limit == null ? null : Number(options.limit),
        }),
      );
    },

    rejectMemoryUpdateCandidate(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.candidateId, 'candidateId');
      requireOption(options.reason, 'reason');
      return useStore((store) =>
        store.markMemoryUpdateCandidateReviewed({
          ...scope,
          candidateId: options.candidateId,
          status: 'rejected',
          reason: options.reason,
          allowStatusOverride: truthyOption(options.allowStatusOverride),
        }),
      );
    },

    skipMemoryUpdateCandidate(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.candidateId, 'candidateId');
      return useStore((store) =>
        store.markMemoryUpdateCandidateReviewed({
          ...scope,
          candidateId: options.candidateId,
          status: 'skipped',
          reason: options.reason || 'Skipped by reviewer.',
          allowStatusOverride: truthyOption(options.allowStatusOverride),
        }),
      );
    },

    applyMemoryUpdateCandidate(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.candidateId, 'candidateId');
      return useStore((store) =>
        store.withTransaction(() => {
          const candidate = store.getMemoryUpdateCandidate({
            ...scope,
            candidateId: options.candidateId,
          });
          if (!candidate) {
            throw new Error(`Memory update candidate not found: ${options.candidateId}`);
          }
          if (candidate.status !== 'pending' && !truthyOption(options.allowStatusOverride)) {
            throw new Error(
              `Memory update candidate ${candidate.id} is ${candidate.status}; expected pending. Pass allowStatusOverride to change it anyway.`,
            );
          }
          let memory = null;
          let reviewMetadata = {};
          const reason = options.reason || candidate.reason || 'Applied reviewed memory update candidate.';
          if (candidate.action === 'correct_memory') {
            const key = options.key || candidate.targetMemoryKey || candidate.proposedKey;
            requireOption(key, 'key');
            const previous = store.getMemory({ ...scope, key });
            if (!previous) {
              throw new Error(`Memory not found: ${key}`);
            }
            memory = store.rememberMemory({
              ...scope,
              key,
              content: options.content || candidate.proposedContent,
              category: options.category || candidate.proposedCategory || previous.category,
              tags: options.tags?.length
                ? options.tags
                : candidate.proposedTags?.length
                  ? candidate.proposedTags
                  : previous.tags,
              importance:
                options.importance == null
                  ? candidate.proposedImportance == null
                    ? previous.importance
                    : candidate.proposedImportance
                  : options.importance,
              supersedesMemoryId: previous.id,
              eventType: 'correct',
              eventMetadata: {
                sourceUpdateCandidateId: candidate.id,
                previousMemoryId: previous.id,
                previousContent: previous.content,
                correction: candidate.correction,
                reason,
              },
            });
          } else if (candidate.action === 'deactivate_memory') {
            const key = options.key || candidate.targetMemoryKey;
            requireOption(key, 'key');
            memory = store.deactivateMemory({
              ...scope,
              key,
              reason,
            });
          } else if (candidate.action === 'merge_duplicate_memories') {
            const key = options.key || candidate.targetMemoryKey;
            const mergedIntoKey = options.mergeTargetKey || candidate.proposedKey;
            requireOption(key, 'key');
            requireOption(mergedIntoKey, 'proposedKey');
            const survivor = store.getMemory({ ...scope, key: mergedIntoKey });
            if (!survivor) {
              throw new Error(`Merge target memory not found: ${mergedIntoKey}`);
            }
            memory = store.deactivateMemory({
              ...scope,
              key,
              reason: `${reason} Merged into ${mergedIntoKey}.`,
            });
            reviewMetadata = {
              mergedIntoMemoryId: survivor.id,
              mergedIntoKey,
            };
          } else if (candidate.action === 'add_corrective_note') {
            const key = options.key || correctiveNoteKey(candidate);
            memory = store.rememberMemory({
              ...scope,
              key,
              content: options.content || candidate.proposedContent,
              category: options.category || candidate.proposedCategory || 'note',
              tags: options.tags || candidate.proposedTags || [],
              importance: options.importance == null ? candidate.proposedImportance || 0 : options.importance,
              eventType: 'promote',
              eventMetadata: {
                sourceUpdateCandidateId: candidate.id,
                sourceCheckpointId: candidate.sourceCheckpointId,
                correction: candidate.correction,
                reason,
              },
            });
          } else {
            throw new Error(`Unsupported memory update candidate action: ${candidate.action}`);
          }
          const reviewed = store.markMemoryUpdateCandidateReviewed({
            ...scope,
            candidateId: candidate.id,
            status: 'applied',
            reason,
            appliedMemoryId: memory?.id || null,
            allowStatusOverride: truthyOption(options.allowStatusOverride),
            metadata: {
              memoryId: memory?.id || null,
              memoryKey: memory?.key || null,
              ...reviewMetadata,
            },
          });
          return {
            kind: 'memory_update_candidate_apply_result',
            candidate: reviewed,
            memory,
          };
        }),
      );
    },

    async suggestMemoryPromotions(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      const trigger = options.trigger;
      if (!CLOSEOUT_TRIGGERS.has(trigger)) {
        throw new Error('trigger must be a closeout trigger.');
      }
      const allowScopeFallback = truthyOption(options.allowScopeFallback);
      if (allowScopeFallback && trigger !== 'manual_closeout') {
        throw new Error('allowScopeFallback is only allowed with trigger=manual_closeout.');
      }
      const requestedLimit = positiveNumber(options.limit == null ? 3 : Number(options.limit), 'limit');
      const limit = Math.min(3, requestedLimit);
      const requestWarnings =
        requestedLimit > 3
          ? [
              {
                code: 'limit_capped',
                message: 'suggest_memory_promotions returns at most 3 proposals.',
                requestedLimit,
                effectiveLimit: limit,
              },
            ]
          : [];
      const scanLimit = positiveNumber(options.scanLimit == null ? 10 : Number(options.scanLimit), 'scanLimit');
      const promotionRecommendation = options.promotionRecommendation || 'promote';

      return useStore(async (store) => {
        let checkpointId = options.checkpointId || null;
        let sourceMode = null;
        if (checkpointId) {
          sourceMode = 'checkpoint';
        } else if (options.sessionId) {
          const latestCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId, level: 0 });
          checkpointId = latestCheckpoint?.id || null;
          sourceMode = 'latest_checkpoint';
        } else if (allowScopeFallback) {
          sourceMode = 'scope_fallback';
        } else {
          return {
            kind: 'memory_promotion_suggestions',
            trigger,
            source: {
              sessionId: null,
              checkpointId: null,
              mode: 'none',
              allowScopeFallback: false,
            },
            proposals: [],
            skipped: [],
            requestWarnings: [
              ...requestWarnings,
              {
                ...missingCloseoutSourceWarning('suggest_memory_promotions'),
                detail:
                  'Pass the checkpointId returned by distill_checkpoint, pass the current sessionId, or explicitly set allowScopeFallback=true only for trigger=manual_closeout backlog review.',
              },
            ],
            nextActions: [
              'No current-session closeout candidates were reviewed because sessionId/checkpointId was missing.',
              'Provide sessionId or checkpointId to review current closeout candidates.',
              'Use allowScopeFallback=true only with trigger=manual_closeout when intentionally reviewing the scope backlog.',
              'Do not promote automatically.',
            ],
          };
        }

        if (options.sessionId && sourceMode === 'latest_checkpoint' && !checkpointId) {
          return {
            kind: 'memory_promotion_suggestions',
            trigger,
            source: {
              sessionId: options.sessionId,
              checkpointId: null,
              mode: sourceMode,
              allowScopeFallback,
            },
            proposals: [],
            skipped: [],
            requestWarnings: requestWarnings,
            nextActions: [
              'No latest checkpoint was found for this session; distill a checkpoint before reviewing promotions.',
              'Do not promote automatically.',
            ],
          };
        }

        const candidates = store.listMemoryCandidates({
          ...scope,
          sessionId: sourceMode === 'scope_fallback' ? null : options.sessionId || null,
          checkpointId: sourceMode === 'scope_fallback' ? null : checkpointId,
          status: 'pending',
          promotionRecommendation,
          sort: 'recommendation',
          limit: scanLimit,
        });
        const assessed = candidates.map((candidate) => {
          const warnings = promotionCandidateWarnings(store, scope, candidate);
          const score = scorePromotionCandidate(candidate, warnings);
          return { candidate, warnings, score };
        });
        const selected = assessed
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        return {
          kind: 'memory_promotion_suggestions',
          trigger,
          source: {
            sessionId: options.sessionId || null,
            checkpointId: checkpointId || null,
            mode: sourceMode,
            allowScopeFallback,
          },
          proposals: selected.map((item, index) => promotionProposal(item.candidate, item.warnings, index + 1)),
          skipped: assessed
            .filter((item) => item.score <= 0)
            .map((item) => ({
              candidateId: item.candidate.id,
              reason: candidateWarningReason(item.warnings) || 'low_score',
            })),
          requestWarnings,
          nextActions: [
            'Ask the user to choose: promote, edit then promote, skip, or reject.',
            'Do not promote automatically.',
          ],
        };
      });
    },

    async auditMemoryCandidates(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      const trigger = options.trigger;
      if (!CLOSEOUT_TRIGGERS.has(trigger)) {
        throw new Error('trigger must be a closeout trigger.');
      }
      const requestedLimit = positiveNumber(options.limit == null ? 3 : Number(options.limit), 'limit');
      const limit = Math.min(10, requestedLimit);
      const requestWarnings =
        requestedLimit > 10
          ? [
              {
                code: 'limit_capped',
                message: 'audit_memory_candidates returns at most 10 proposals.',
                requestedLimit,
                effectiveLimit: limit,
              },
            ]
          : [];
      const minConfidence = Number(options.minConfidence ?? 0.7);
      const minStability = Number(options.minStability ?? 0.7);
      if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        throw new Error('minConfidence must be between 0 and 1.');
      }
      if (!Number.isFinite(minStability) || minStability < 0 || minStability > 1) {
        throw new Error('minStability must be between 0 and 1.');
      }
      const categoryPolicy = normalizeAllowedCategories(options.allowedCategories, AUDIT_CANDIDATE_CATEGORIES);
      const allowedCategories = categoryPolicy.allowedCategories;
      if (categoryPolicy.strippedPreference) {
        requestWarnings.push({
          code: 'preference_input_stripped',
          message: 'Preference candidates cannot be audited for automatic-style promotion until occurrence/merge tracking exists.',
        });
      }
      const scanLimit = positiveNumber(options.scanLimit == null ? 50 : Number(options.scanLimit), 'scanLimit');
      const promotionRecommendation = options.promotionRecommendation || null;
      if (!options.sessionId && !options.checkpointId) {
        return {
          kind: 'memory_candidate_audit_suggestions',
          trigger,
          source: {
            sessionId: null,
            checkpointId: null,
            mode: 'none',
          },
          policy: {
            minConfidence,
            minStability,
            allowedCategories: Array.from(allowedCategories),
            scopeFallback: false,
            mutates: false,
            audit: {
              enabled: false,
              executed: false,
              provider: 'none',
              model: null,
              reasoningEffort: null,
            },
          },
          proposals: [],
          skipped: [],
          requestWarnings: [
            ...requestWarnings,
            {
              ...missingCloseoutSourceWarning('audit_memory_candidates'),
              detail:
                'Audited suggestions never use scope fallback. Pass the checkpointId returned by distill_checkpoint or the current sessionId.',
            },
          ],
          nextActions: [
            'No current-session closeout candidates were reviewed because sessionId/checkpointId was missing.',
            'Provide sessionId or checkpointId; audited suggestions never scan the scope backlog.',
            'No memory candidates were promoted.',
          ],
        };
      }

      return useStore(async (store) => {
        let checkpointId = options.checkpointId || null;
        let sourceMode = null;
        if (checkpointId) {
          sourceMode = 'checkpoint';
        } else if (options.sessionId) {
          sourceMode = 'session_pending_batch';
        } else {
          const latestCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId, level: 0 });
          checkpointId = latestCheckpoint?.id || null;
          sourceMode = 'latest_checkpoint';
        }
        const auditor = checkpointId || options.sessionId ? getAutoPromoteAuditor(store) : null;
        const auditPolicy = {
          enabled: Boolean(auditor),
          executed: false,
          provider: auditor?.metadata?.provider || 'none',
          model: auditor?.metadata?.model || null,
          reasoningEffort: auditor?.metadata?.reasoningEffort || null,
        };
        if (options.sessionId && sourceMode === 'latest_checkpoint' && !checkpointId) {
          return {
            kind: 'memory_candidate_audit_suggestions',
            trigger,
            source: {
              sessionId: options.sessionId,
              checkpointId: null,
              mode: sourceMode,
            },
            policy: {
              minConfidence,
              minStability,
              allowedCategories: Array.from(allowedCategories),
              scopeFallback: false,
              mutates: false,
              audit: auditPolicy,
            },
            proposals: [],
            skipped: [],
            requestWarnings,
            nextActions: [
              'No latest checkpoint was found for this session; distill a checkpoint before auditing candidates.',
              'No memory candidates were promoted.',
            ],
          };
        }

        const allCandidates = store.listMemoryCandidates({
          ...scope,
          sessionId: options.sessionId || null,
          checkpointId,
          status: 'pending',
          promotionRecommendation,
          sort: 'recommendation',
          limit: scanLimit,
        });
        const storedAudited = truthyOption(options.force)
          ? []
          : allCandidates.filter((candidate) => candidate.reviewMetadata?.audit);
        const candidates = allCandidates.filter((candidate) => truthyOption(options.force) || !candidate.reviewMetadata?.audit);
        if (!auditor) {
          return {
            kind: 'memory_candidate_audit_suggestions',
            trigger,
            source: {
              sessionId: options.sessionId || null,
              checkpointId,
              mode: sourceMode,
            },
            policy: {
              minConfidence,
              minStability,
              allowedCategories: Array.from(allowedCategories),
              scopeFallback: false,
              mutates: false,
              audit: auditPolicy,
            },
            proposals: storedAudited.map((candidate, index) => storedAuditProposal(candidate, index + 1)).slice(0, limit),
            skipped: candidates.map((candidate) => ({
              candidateId: candidate.id,
              reason: 'audit_disabled',
            })),
            requestWarnings: [
              ...requestWarnings,
              {
                code: 'audit_disabled',
                message: 'Automatic candidate audit provider is disabled; no new GPT audit results were stored.',
              },
            ],
            nextActions: [
              'Enable the automatic candidate audit provider before requesting GPT-reviewed candidate suggestions.',
              'No memory candidates were promoted.',
            ],
          };
        }
        const candidateAuditPolicy = {
          minConfidence,
          minStability,
          allowedCategories,
        };
        const assessed = candidates.map((candidate) => {
          const warnings = auditCandidateWarnings(store, scope, candidate, candidateAuditPolicy);
          const score = scorePromotionCandidate(candidate, warnings, AUDIT_CANDIDATE_SKIP_WARNING_CODES);
          return { candidate, warnings, score };
        });
        const selected = assessed
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        const audited = [];
        const auditBatchId = randomUUID();
        for (const item of selected) {
          try {
            const audit = await auditAutoPromotionCandidate({ auditor, store, scope, item });
            recordCandidateAuditUsageEvent(store, {
              scope,
              item,
              audit,
              sessionId: options.sessionId || null,
              checkpointId,
            });
            const auditedCandidate = store.markMemoryCandidateAudited({
              ...scope,
              candidateId: item.candidate.id,
              audit,
              reason: audit.reason,
              metadata: {
                auditBatchId,
                trigger,
                sourceMode,
                checkpointId,
                sessionId: options.sessionId || null,
                mutates: false,
              },
            });
            audited.push({ ...item, candidate: auditedCandidate, audit });
          } catch (error) {
            const audit = {
              approved: false,
              decision: 'needs_review',
              reason: `Memory candidate audit failed: ${error.message}`,
              riskCodes: ['audit_failed'],
              metadata: { ...(auditor?.metadata || {}), ...errorUsageMetadata(error), errorName: error.name },
            };
            recordCandidateAuditUsageEvent(store, {
              scope,
              item,
              audit,
              sessionId: options.sessionId || null,
              checkpointId,
              status: 'failed',
            });
            const auditedCandidate = store.markMemoryCandidateAudited({
              ...scope,
              candidateId: item.candidate.id,
              audit,
              reason: audit.reason,
              metadata: {
                auditBatchId,
                trigger,
                sourceMode,
                checkpointId,
                sessionId: options.sessionId || null,
                mutates: false,
              },
            });
            audited.push({
              ...item,
              candidate: auditedCandidate,
              audit,
            });
          }
        }

        return {
          kind: 'memory_candidate_audit_suggestions',
          trigger,
          source: {
            sessionId: options.sessionId || null,
            checkpointId,
            mode: sourceMode,
          },
          policy: {
            minConfidence,
            minStability,
            allowedCategories: Array.from(allowedCategories),
            scopeFallback: false,
            mutates: false,
            audit: {
              ...auditPolicy,
              executed: Boolean(auditor) && audited.length > 0,
            },
          },
          proposals: [
            ...storedAudited.map((candidate, index) => storedAuditProposal(candidate, index + 1)),
            ...audited.map((item, index) =>
              auditedPromotionProposal(item.candidate, item.warnings, item.audit, storedAudited.length + index + 1, {
                auditEnabled: Boolean(auditor),
              }),
            ),
          ].slice(0, limit),
          skipped: assessed
            .filter((item) => item.score <= 0)
            .map((item) => ({
              candidateId: item.candidate.id,
              reason: candidateWarningReason(item.warnings) || 'low_score',
            })),
          requestWarnings,
          nextActions: [
            'Ask the user to choose: promote, edit then promote, skip, or reject.',
            'Use promote_memory_candidate only after reviewed approval; rejected audit candidates remain pending until explicitly rejected or skipped.',
            'No memory candidates were promoted.',
          ],
        };
      });
    },

    async autoPromoteMemoryCandidates(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      const trigger = options.trigger;
      if (!CLOSEOUT_TRIGGERS.has(trigger)) {
        throw new Error('trigger must be a closeout trigger.');
      }
      const dryRun = options.dryRun == null ? true : truthyOption(options.dryRun);
      if (!dryRun && !config.autoPromote.enabled) {
        throw new Error('Set CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true to use dryRun=false.');
      }
      const requestedLimit = positiveNumber(options.limit == null ? 2 : Number(options.limit), 'limit');
      const limit = Math.min(2, requestedLimit);
      const requestWarnings =
        requestedLimit > 2
          ? [
              {
                code: 'limit_capped',
                message: 'auto_promote_memory_candidates handles at most 2 candidates per call.',
                requestedLimit,
                effectiveLimit: limit,
              },
            ]
          : [];
      const minConfidence = Number(options.minConfidence ?? 0.85);
      const minStability = Number(options.minStability ?? 0.85);
      if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        throw new Error('minConfidence must be between 0 and 1.');
      }
      if (!Number.isFinite(minStability) || minStability < 0 || minStability > 1) {
        throw new Error('minStability must be between 0 and 1.');
      }
      const categoryPolicy = normalizeAllowedCategories(options.allowedCategories);
      const allowedCategories = categoryPolicy.allowedCategories;
      if (categoryPolicy.strippedPreference) {
        requestWarnings.push({
          code: 'preference_input_stripped',
          message: 'Preference candidates cannot be auto-promoted until occurrence/merge tracking exists.',
        });
      }
      const scanLimit = positiveNumber(options.scanLimit == null ? 10 : Number(options.scanLimit), 'scanLimit');
      if (!options.sessionId && !options.checkpointId) {
        return {
          kind: 'auto_memory_promotion_result',
          trigger,
          dryRun,
          source: {
            sessionId: null,
            checkpointId: null,
            mode: 'none',
          },
          policy: {
            minConfidence,
            minStability,
            allowedCategories: Array.from(allowedCategories),
            scopeFallback: false,
            realPromotionEnabled: config.autoPromote.enabled,
          },
          wouldPromote: [],
          promoted: [],
          skipped: [],
          requestWarnings: [
            ...requestWarnings,
            {
              ...missingCloseoutSourceWarning('auto_promote_memory_candidates'),
              detail:
                'Auto-promotion never uses scope fallback. Pass the checkpointId returned by distill_checkpoint or the current sessionId.',
            },
          ],
          nextActions: [
            'No current-session closeout candidates were reviewed because sessionId/checkpointId was missing.',
            'Provide sessionId or checkpointId; auto-promotion dry-run never scans the scope backlog.',
            'No memory candidates were promoted.',
          ],
        };
      }

      return useStore(async (store) => {
        let checkpointId = options.checkpointId || null;
        let sourceMode = null;
        if (checkpointId) {
          sourceMode = 'checkpoint';
        } else if (options.sessionId) {
          sourceMode = 'session_pending_batch';
        } else {
          const latestCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId, level: 0 });
          checkpointId = latestCheckpoint?.id || null;
          sourceMode = 'latest_checkpoint';
        }
        if (options.sessionId && sourceMode === 'latest_checkpoint' && !checkpointId) {
          return {
            kind: 'auto_memory_promotion_result',
            trigger,
            dryRun,
            source: {
              sessionId: options.sessionId,
              checkpointId: null,
              mode: sourceMode,
            },
            policy: {
              minConfidence,
              minStability,
              allowedCategories: Array.from(allowedCategories),
              scopeFallback: false,
              realPromotionEnabled: config.autoPromote.enabled,
            },
            wouldPromote: [],
            promoted: [],
            skipped: [],
            requestWarnings,
            nextActions: [
              'No latest checkpoint was found for this session; distill a checkpoint before auto-promotion dry-run.',
              'No memory candidates were promoted.',
            ],
          };
        }

        const policy = { minConfidence, minStability, allowedCategories };
        const candidates = store.listMemoryCandidates({
          ...scope,
          sessionId: options.sessionId || null,
          checkpointId,
          status: 'pending',
          promotionRecommendation: 'promote',
          sort: 'recommendation',
          limit: scanLimit,
        });
        const assessed = candidates.map((candidate) => {
          const warnings = autoPromotionWarnings(store, scope, candidate, policy);
          const score = scorePromotionCandidate(candidate, warnings, AUTO_PROMOTE_SKIP_WARNING_CODES);
          return { candidate, warnings, score };
        });
        const selected = assessed
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        const auditor = getAutoPromoteAuditor(store);
        const audited = [];
        if (!dryRun) {
          if (!auditor) {
            for (const item of selected) {
              audited.push({
                ...item,
                audit: {
                  approved: false,
                  decision: 'needs_review',
                  reason: 'Auto-promotion audit provider is disabled; automatic promotion requires audit approval.',
                  riskCodes: ['audit_disabled'],
                  metadata: { provider: 'none' },
                },
              });
            }
          } else {
            for (const item of selected) {
              try {
                const audit = await auditAutoPromotionCandidate({ auditor, store, scope, item });
                recordCandidateAuditUsageEvent(store, {
                  scope,
                  item,
                  audit,
                  sessionId: options.sessionId || null,
                  checkpointId,
                });
                audited.push({ ...item, audit });
              } catch (error) {
                const audit = {
                  approved: false,
                  decision: 'needs_review',
                  reason: `Auto-promotion audit failed: ${error.message}`,
                  riskCodes: ['audit_failed'],
                  metadata: { ...(auditor?.metadata || {}), ...errorUsageMetadata(error), errorName: error.name },
                };
                recordCandidateAuditUsageEvent(store, {
                  scope,
                  item,
                  audit,
                  sessionId: options.sessionId || null,
                  checkpointId,
                  status: 'failed',
                });
                audited.push({
                  ...item,
                  audit,
                });
              }
            }
          }
        }
        const auditApproved = dryRun ? [] : audited.filter((item) => item.audit?.approved === true);
        const auditSkipped = dryRun
          ? []
          : audited
              .filter((item) => item.audit?.approved !== true)
              .map((item) => ({
                candidateId: item.candidate.id,
                reason: auditSkipReason(item.audit),
                audit: item.audit,
              }));

        return {
          kind: 'auto_memory_promotion_result',
          trigger,
          dryRun,
          source: {
            sessionId: options.sessionId || null,
            checkpointId,
            mode: sourceMode,
          },
          policy: {
            minConfidence,
            minStability,
            allowedCategories: Array.from(allowedCategories),
            scopeFallback: false,
            realPromotionEnabled: config.autoPromote.enabled,
            audit: {
              enabled: Boolean(auditor),
              executed: !dryRun && Boolean(auditor),
              provider: auditor?.metadata?.provider || 'none',
              model: auditor?.metadata?.model || null,
              reasoningEffort: auditor?.metadata?.reasoningEffort || null,
            },
          },
          wouldPromote: dryRun
            ? selected.map((item, index) => autoPromotionWouldPromote(item.candidate, item.warnings, index + 1))
            : [],
          promoted: dryRun
            ? []
            : auditApproved.map((item, index) => {
                const reason =
                  'Auto-promoted by auto_promote_memory_candidates after strict closeout-scoped safety checks and audit approval.';
                const memory = autoPromoteIndexedCandidate(store, scope, item.candidate, item.warnings, reason, item.audit);
                enqueueEmbeddingSources(store, [store.embeddingSourceForMemory(memory)]);
                return {
                  ...promotionProposal(item.candidate, item.warnings, index + 1),
                  memoryId: memory.id,
                  promotionResult: {
                    memoryId: memory.id,
                    memoryKey: memory.key,
                    status: 'promoted',
                  },
                  auditReason: reason,
                  audit: item.audit,
                };
              }),
          skipped: [
            ...assessed
              .filter((item) => item.score <= 0)
              .map((item) => ({
                candidateId: item.candidate.id,
                reason: candidateWarningReason(item.warnings) || 'low_score',
              })),
            ...auditSkipped,
          ],
          requestWarnings,
          nextActions: [
            dryRun
              ? 'Inspect wouldPromote quality or set dryRun=false with CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true to promote.'
              : 'Review promoted entries and audit metadata.',
            dryRun ? 'Dry-run does not call the auto-promotion audit runner.' : 'Candidates rejected by audit remain pending for human review.',
            dryRun ? 'No memory candidates were promoted.' : 'Do not auto-promote preference candidates until occurrence/merge tracking exists.',
          ],
        };
      });
    },

    async reconcileMemory(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.correction, 'correction');
      const baseQuery = options.query || options.correction;
      const mode = options.mode || 'propose';
      if (!['propose', 'apply_safe'].includes(mode)) {
        throw new Error('mode must be propose or apply_safe.');
      }
      const limit = positiveNumber(options.limit == null ? 8 : Number(options.limit), 'limit');
      const candidateLimit = positiveNumber(
        options.candidateLimit == null ? 5 : Number(options.candidateLimit),
        'candidateLimit',
      );
      const includeShared = truthyOption(options.includeShared);
      const createUpdateCandidates = truthyOption(options.createUpdateCandidates);
      const reconciliationQuery = `${baseQuery}\n${options.correction}`;
      const bootstrap = await this.bootstrapContext({
        ...options,
        query: reconciliationQuery,
        includeShared,
        limit,
      });
      const liveState = isLiveStateCorrection(reconciliationQuery);
      return useStore((store) => {
        const basis = (bootstrap.results || []).slice(0, limit).map(summarizeBasisResult);
        const latestCheckpoint = options.sessionId
          ? store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId, level: 0 })
          : null;
        if (latestCheckpoint && !basis.some((item) => item.type === 'checkpoint')) {
          basis.push(checkpointBasisResult(latestCheckpoint));
        }
        if (latestCheckpoint && !basis.some((item) => item.type === 'memory_candidate')) {
          const latestCandidates = store.listMemoryCandidates({
            ...scope,
            checkpointId: latestCheckpoint.id,
            status: 'pending',
            sort: 'recommendation',
            limit: candidateLimit,
          });
          basis.push(...latestCandidates.map(indexedCandidateBasisResult));
        }
        const durableBasis = basis.filter((item) => item.type === 'memory');
        const checkpointBasis = basis.filter((item) => item.type === 'checkpoint');
        const candidateBasis = basis.filter((item) => item.type === 'memory_candidate').slice(0, candidateLimit);
        const updateCandidates = [];
        const conflicts = basis.map((item) => ({
          type: item.type,
          key: item.key,
          conflict: 'possible_conflict',
          reason:
            item.type === 'checkpoint'
              ? 'Checkpoint may explain prior belief, but it should not be edited directly.'
              : 'User correction may conflict with this stored context; review before applying.',
        }));
        const proposedActions = [
          ...durableBasis.map((item) => ({
            action: liveState ? 'verify_live_state_before_memory_change' : 'correct_memory',
            key: item.key,
            content: options.correction,
            reason: 'User correction conflicts with existing durable memory.',
          })),
          ...candidateBasis.map((item) => ({
            action:
              normalizeToken(item.category) === 'preference'
                ? 'reject_memory_candidate_and_weaken_preference_occurrence'
                : 'reject_memory_candidate',
            candidateId: item.candidateId,
            reason: 'User correction indicates this candidate should not become durable truth.',
          })),
          ...checkpointBasis.map((item) => ({
            action: 'propose_corrective_memory_note',
            checkpointId: item.checkpointId,
            content: options.correction,
            reason: 'Checkpoints are immutable handoff evidence; add corrective durable context instead.',
          })),
        ];
        const appliedActions = [];
        const warnings = [];

        if (liveState) {
          warnings.push({
            code: 'live_state_verification_required',
            message: 'Correction appears to involve mutable live state; verify git/GitHub/CI/runtime/migrations first.',
          });
        }

        if (mode === 'propose') {
          for (const item of [...durableBasis, ...checkpointBasis]) {
            const action = memoryUpdateActionForReconcile(item, liveState);
            if (!action) {
              continue;
            }
            const draft = {
              id: null,
              // Transient draft status is returned only when the proposal is not persisted to SQLite.
              status: createUpdateCandidates ? 'pending' : 'proposed',
              scopeType: scope.scopeType,
              scopeKey: scope.scopeKey,
              ...scope,
              action,
              targetMemoryId: item.memoryId || null,
              targetMemoryKey: item.type === 'memory' ? item.key : null,
              proposedKey:
                item.type === 'memory' ? item.key : `corrective-note-${slugForKey(options.correction)}`,
              proposedContent: options.correction,
              proposedCategory: item.category || 'note',
              reason:
                item.type === 'checkpoint'
                  ? 'Checkpoint is immutable; propose a corrective durable note instead.'
                  : 'User correction may require updating existing durable memory.',
              confidence:
                item.type === 'memory'
                  ? RECONCILE_UPDATE_CONFIDENCE.durableMemory
                  : RECONCILE_UPDATE_CONFIDENCE.checkpointNote,
              sourceSessionId: options.sessionId || item.sessionId || null,
              sourceCheckpointId: item.checkpointId || null,
              sourceCandidateId: item.candidateId || null,
              correction: options.correction,
              basis: [item],
            };
            const updateCandidate = createUpdateCandidates
              ? store.createMemoryUpdateCandidate(draft)
              : draft;
            updateCandidates.push(memoryUpdateCandidateProposal(updateCandidate));
          }
        }

        if (mode === 'apply_safe') {
          if (liveState) {
            warnings.push({
              code: 'apply_safe_skipped_live_state',
              message: 'No memory changes were applied because live state verification is required.',
            });
          } else if (durableBasis.length === 1) {
            const durable = durableBasis[0];
            const previous = store.getMemory({ ...scope, key: durable.key });
            if (!previous) {
              warnings.push({
                code: 'durable_memory_not_found',
                message: `Memory ${durable.key} was not found when applying correction; no correction was applied.`,
              });
            } else {
              const corrected = store.rememberMemory({
                ...scope,
                key: durable.key,
                content: options.correction,
                category: previous.category,
                tags: previous.tags,
                importance: previous.importance,
                supersedesMemoryId: previous.id,
                eventType: 'correct',
                eventMetadata: {
                  key: durable.key,
                  previousMemoryId: previous.id,
                  previousContent: previous.content,
                  reason: 'Applied via reconcile_memory apply_safe.',
                },
              });
              appliedActions.push({
                action: 'correct_memory',
                key: corrected.key,
                memoryId: corrected.id,
              });
            }
          } else if (durableBasis.length > 1) {
            warnings.push({
              code: 'ambiguous_durable_memory',
              message: 'Multiple durable memories matched; no automatic correction was applied.',
            });
          }

          if (!liveState) {
            for (const item of candidateBasis) {
              const candidate = store.getMemoryCandidate({
                ...scope,
                candidateId: item.candidateId,
              });
              if (candidate?.status === 'pending') {
                const rejected = store.markMemoryCandidateReviewed({
                  ...scope,
                  candidateId: item.candidateId,
                  status: 'rejected',
                  reason: 'Rejected via reconcile_memory apply_safe after user correction.',
                  metadata: {
                    correction: options.correction,
                    query: baseQuery,
                  },
                });
                appliedActions.push({
                  action: 'reject_memory_candidate',
                  candidateId: rejected.id,
                });
                if (isPreferenceLike(candidate.candidate)) {
                  const weakened = store.weakenPreferenceOccurrenceForCandidate({
                    ...scope,
                    candidateId: item.candidateId,
                    correction: options.correction,
                    reason: 'Weakened via reconcile_memory apply_safe after user correction.',
                  });
                  if (weakened) {
                    appliedActions.push({
                      action: 'weaken_preference_occurrence',
                      occurrenceId: weakened.id,
                      mergeKey: weakened.mergeKey,
                      negativeCount: weakened.negativeCount,
                      status: weakened.status,
                    });
                  }
                }
              }
            }
          }
        }

        return {
          kind: 'memory_reconciliation',
          mode,
          scope: bootstrap.scope,
          storage: bootstrap.storage,
          query: baseQuery,
          correction: options.correction,
          basis,
          conflicts,
          proposedActions,
          updateCandidates,
          appliedActions,
          warnings,
          trustPolicy: {
            userCorrection: 'strong evidence, but not automatically treated as universal truth',
            durableMemory: 'canonical until corrected or deactivated',
            checkpoint: 'basis and immutable handoff evidence; do not edit directly',
            memoryCandidate: 'review material that can be rejected when contradicted',
            liveState: 'verify mutable git/GitHub/CI/runtime/migration claims before changing memory',
          },
          nextActions:
            mode === 'apply_safe'
              ? ['Review appliedActions and warnings.', 'Verify mutable live state before making further memory changes.']
              : [
                  createUpdateCandidates
                    ? 'Review updateCandidates, then ask the user whether to apply, edit then apply, skip, or reject them.'
                    : 'Review updateCandidates. Pass createUpdateCandidates=true to persist them for later approval.',
                  'Ask the user whether to apply a correction, deactivate stale durable memory, reject candidates, or add a corrective note.',
                  'Verify mutable live state before changing memory for git/GitHub/CI/runtime/migration claims.',
                ],
        };
      });
    },

    promoteMemoryCandidate(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) => {
        let indexedCandidate = null;
        let checkpoint = null;
        let candidate = null;
        let candidateIndex = options.sourceCandidateIndex == null ? 0 : options.sourceCandidateIndex;

        if (options.candidateId) {
          indexedCandidate = store.getMemoryCandidate({
            ...scope,
            candidateId: options.candidateId,
          });
          if (!indexedCandidate) {
            throw new Error(`Memory candidate not found: ${options.candidateId}`);
          }
          candidate = indexedCandidate.candidate;
          candidateIndex = indexedCandidate.index;
          checkpoint = {
            id: indexedCandidate.checkpointId,
            sessionId: indexedCandidate.sessionId,
          };
        } else {
          requireOption(options.checkpointId, 'checkpointId');
          checkpoint = store
            .listCheckpoints({
              ...scope,
              sessionId: options.sessionId || null,
            })
            .find((item) => item.id === options.checkpointId);
          if (!checkpoint) {
            throw new Error(`Checkpoint not found: ${options.checkpointId}`);
          }
          const candidates = checkpoint.metadata?.memoryCandidates || [];
          candidate = candidates[candidateIndex];
          if (!candidate) {
            throw new Error(`Memory candidate not found at index ${candidateIndex}.`);
          }
          indexedCandidate = store.getMemoryCandidateByCheckpointIndex({
            ...scope,
            checkpointId: checkpoint.id,
            candidateIndex,
          });
        }

        if (indexedCandidate && indexedCandidate.status !== 'pending' && !truthyOption(options.allowStatusOverride)) {
          throw new Error(
            `Memory candidate ${indexedCandidate.id} is ${indexedCandidate.status}; expected pending. Pass allowStatusOverride to change it anyway.`,
          );
        }
        const key = options.key || candidate.key;
        requireOption(key, 'key');
        const content = options.content || candidate.content;
        requireOption(content, 'content');
        const warnings = candidatePromotionWarnings(store, scope, { key, content, candidate });
        if (warnings.length > 0 && !truthyOption(options.allowWarnings)) {
          const error = new Error(
            `Memory candidate promotion has ${warnings.length} warning(s). Pass allowWarnings to promote anyway.`,
          );
          error.name = 'MemoryCandidatePromotionWarningError';
          error.warnings = warnings;
          throw error;
        }
        const memory = promoteCandidateToMemory(store, scope, {
          candidate,
          checkpointId: checkpoint.id,
          sessionId: checkpoint.sessionId,
          candidateIndex,
          indexedCandidate,
          key,
          content,
          category: options.category || candidate.category || 'note',
          tags: options.tags?.length ? options.tags : candidate.tags || [],
          importance: options.importance == null ? candidate.importance || 0 : options.importance,
          reason: options.reason || null,
          warnings,
          sourceRawEventIds: options.sourceRawEventIds || [],
          allowStatusOverride: truthyOption(options.allowStatusOverride),
        });
        enqueueEmbeddingSources(store, [store.embeddingSourceForMemory(memory)]);
        return memory;
      });
    },

    rejectMemoryCandidate(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.candidateId, 'candidateId');
      requireOption(options.reason, 'reason');
      return useStore((store) => {
        const candidate = store.getMemoryCandidate({
          ...scope,
          candidateId: options.candidateId,
        });
        if (!candidate) {
          throw new Error(`Memory candidate not found: ${options.candidateId}`);
        }
        if (candidate.status !== 'pending' && !truthyOption(options.allowStatusOverride)) {
          throw new Error(
            `Memory candidate ${candidate.id} is ${candidate.status}; expected pending. Pass allowStatusOverride to change it anyway.`,
          );
        }
        return store.markMemoryCandidateReviewed({
          ...scope,
          candidateId: options.candidateId,
          status: 'rejected',
          reason: options.reason,
          allowStatusOverride: truthyOption(options.allowStatusOverride),
          metadata: {
            checkpointId: candidate.checkpointId,
            sessionId: candidate.sessionId,
            sourceCandidateIndex: candidate.index,
          },
        });
      });
    },

    getMemory(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      return useStore((store) =>
        store.getMemory({
          ...scope,
          key: options.key,
        }),
      );
    },

    listMemories(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listMemoriesForAdmin({
          ...scope,
          status: options.status || 'active',
          query: options.query || null,
          limit: options.limit == null ? 100 : Number(options.limit),
        }),
      );
    },

    listScopeKeys(options = {}) {
      return useStore((store) =>
        store.listScopeKeys({
          scopeType: options.scope || options.scopeType || null,
          limit: options.limit == null ? 200 : Number(options.limit),
        }),
      );
    },

    search(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.query, 'query');
      return searchWithScope(scope, options);
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
      return useStore((store) =>
        store.listEmbeddingJobs({
          scopeType: shouldNarrowScope ? scope.scopeType : null,
          scopeKey: shouldNarrowScope ? scope.scopeKey : null,
          status: options.status || null,
          limit: options.limit == null ? null : Number(options.limit),
        }),
      );
    },

    appendRaw(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      requireOption(options.role, 'role');
      requireOption(options.content, 'content');
      if (options.role !== 'user' && options.role !== 'assistant') {
        throw new Error('role must be one of: user, assistant');
      }
      return useStore((store) => {
        pruneRawEventsIfDue(store);
        return store.appendRawEvent({
          ...scope,
          sessionId: options.sessionId,
          conversationId: options.conversationId,
          role: options.role,
          content: options.content,
          metadata: options.metadata,
        });
      });
    },

    pruneRawEvents(options = {}) {
      const ttlDays = options.ttlDays == null ? config.rawRetention.ttlDays : Number(options.ttlDays);
      if (!ttlDays) {
        return {
          deletedRawEvents: 0,
          cutoffIso: null,
          ttlDays: null,
          skipped: true,
          reason: 'raw_ttl_disabled',
        };
      }
      const cutoffIso = rawTtlCutoffIso(ttlDays);
      return useStore((store) => ({
        ...store.pruneRawEventsOlderThan(cutoffIso),
        ttlDays,
        skipped: false,
      }));
    },

    listRawEvents(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) => store.listRawEvents({ ...scope, sessionId: options.sessionId }));
    },

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
          rawOutput = await provider.distill({
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
          });
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

    listCheckpoints(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listCheckpoints({
          ...scope,
          sessionId: options.sessionId || null,
          level: options.level == null ? null : Number(options.level),
        }),
      );
    },

    getWorkingSummary(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) => store.getWorkingSummary({ ...scope, sessionId: options.sessionId }));
    },

    getSessionWorkingContext(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) => store.getSessionWorkingContext({ ...scope, sessionId: options.sessionId }));
    },

    upsertSessionWorkingContext(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) => {
        const previous = store.getSessionWorkingContext({ ...scope, sessionId: options.sessionId });
        return store.upsertSessionWorkingContext({
          ...scope,
          sessionId: options.sessionId,
          ...sessionWorkingContextInput(options, previous),
        });
      });
    },

    async distillCheckpoint(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');

      return useStore(async (store) => {
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
          },
        });

        let rawOutput;
        try {
          rawOutput = await provider.distill({
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
          });
        } catch (error) {
          recordLlmUsageEvent(store, {
            scope,
            operation: 'checkpoint_distill',
            provider: provider.name,
            model: providerModelFromMetadata(errorUsageMetadata(error), providerMetadata.model),
            status: 'failed',
            sessionId: options.sessionId,
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
            metadata: rawOutput?.metadata || {},
            startedAt: distillRun.createdAt,
            completedAt: new Date().toISOString(),
          });
          store.failDistillRun({
            id: distillRun.id,
            error,
            outputMetadata: {
              validationFailed: true,
              receivedType: Array.isArray(rawOutput) ? 'array' : typeof rawOutput,
              providerMetadata,
            },
          });
          throw error;
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
          },
        };

        let checkpoint = null;
        let checkpointError = null;
        try {
          checkpoint = store.insertCheckpoint(checkpointInput);
        } catch (error) {
          checkpointError = error;
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
            metadata: output.metadata,
            startedAt: distillRun.createdAt,
            completedAt: new Date().toISOString(),
          });
          store.failDistillRun({
            id: distillRun.id,
            error: checkpointError,
            outputMetadata: {
              checkpointFailed: true,
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
          const auditTrigger = options.auditTrigger || options.trigger || null;
          const forceAudit = CLOSEOUT_TRIGGERS.has(auditTrigger);
          const effectiveForAudit = getEffectiveRuntime(store);
          const auditConfig = effectiveForAudit.autoPromoteAudit || {};
          const minBatchCandidates = Number(auditConfig.minBatchCandidates || 5);
          const batchLimit = Number(auditConfig.batchLimit || 5);
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
            .filter((candidate) => !candidate.reviewMetadata?.audit);
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
            const policy = {
              minConfidence: 0.7,
              minStability: 0.7,
              allowedCategories: AUDIT_CANDIDATE_CATEGORIES,
            };
            const assessed = unauditedPending.map((candidate) => {
              const warnings = auditCandidateWarnings(store, scope, candidate, policy);
              const score = scorePromotionCandidate(candidate, warnings, AUDIT_CANDIDATE_SKIP_WARNING_CODES);
              return { candidate, warnings, score };
            });
            const selected = assessed
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, batchLimit);
            const auditBatchId = randomUUID();
            let auditedCount = 0;
            let promotedCount = 0;
            for (const item of selected) {
              let audit;
              try {
                audit = await auditAutoPromotionCandidate({ auditor, store, scope, item });
              } catch (error) {
                audit = {
                  approved: false,
                  decision: 'needs_review',
                  reason: `Automatic candidate audit failed: ${error.message}`,
                  riskCodes: ['audit_failed'],
                  metadata: { ...(auditor?.metadata || {}), ...errorUsageMetadata(error), errorName: error.name },
                };
              }
              recordCandidateAuditUsageEvent(store, {
                scope,
                item,
                audit,
                sessionId: options.sessionId,
                checkpointId: checkpoint.id,
                status: audit.riskCodes?.includes('audit_failed') ? 'failed' : 'succeeded',
              });
              const auditedCandidate = store.markMemoryCandidateAudited({
                ...scope,
                candidateId: item.candidate.id,
                audit,
                reason: audit.reason,
                metadata: {
                  auditBatchId,
                  trigger: auditTrigger || 'batch_threshold',
                  sourceMode: forceAudit ? 'closeout_batch' : 'threshold_batch',
                  sessionId: options.sessionId,
                  checkpointId: checkpoint.id,
                  minBatchCandidates,
                  batchLimit,
                  autoPromoteEnabled: config.autoPromote.enabled,
                },
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
                    'Auto-promoted after automatic batched candidate audit approved this strict safe candidate.';
                  const memory = autoPromoteIndexedCandidate(store, scope, auditedCandidate, autoWarnings, reason, audit);
                  enqueueEmbeddingSources(store, [store.embeddingSourceForMemory(memory)]);
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
              minBatchCandidates,
              batchLimit,
              scanLimit,
              provider: auditor?.metadata?.provider || 'none',
              model: auditor?.metadata?.model || null,
              reasoningEffort: auditor?.metadata?.reasoningEffort || null,
              error: null,
            };
          }
        } catch (error) {
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
      });
    },

    listDistillRuns(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listDistillRuns({
          ...scope,
          sessionId: options.sessionId || null,
          status: options.status || null,
          provider: options.provider || null,
          limit: options.limit == null ? null : Number(options.limit),
          order: options.order || 'asc',
        }),
      );
    },

    listRecentDistillRuns(options = {}) {
      return useStore((store) =>
        store.listRecentDistillRuns({
          scopeType: options.scope || options.scopeType || null,
          scopeKey: options.scopeKey || null,
          sessionId: options.sessionId || null,
          status: options.status || null,
          provider: options.provider || null,
          limit: options.limit == null ? 25 : Number(options.limit),
        }),
      );
    },

    listLlmUsageEvents(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.listLlmUsageEvents({
          ...scope,
          sessionId: options.sessionId || null,
          distillRunId: options.distillRunId || null,
          checkpointId: options.checkpointId || null,
          candidateId: options.candidateId || null,
          operation: options.operation || null,
          provider: options.provider || null,
          limit: options.limit == null ? 100 : Number(options.limit),
          order: options.order || 'desc',
        }),
      );
    },

    llmUsageRollup(options) {
      const scope = normalizeScopeOptions(options, config);
      const limit = options.limit == null ? 1000 : Number(options.limit);
      return useStore((store) => {
        const events = store.listLlmUsageEvents({
          ...scope,
          sessionId: options.sessionId || null,
          distillRunId: options.distillRunId || null,
          checkpointId: options.checkpointId || null,
          candidateId: options.candidateId || null,
          operation: options.operation || null,
          provider: options.provider || null,
          limit,
          order: options.order || 'desc',
        });
        return {
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          filters: {
            sessionId: options.sessionId || null,
            distillRunId: options.distillRunId || null,
            checkpointId: options.checkpointId || null,
            candidateId: options.candidateId || null,
            operation: options.operation || null,
            provider: options.provider || null,
            limit,
            order: options.order || 'desc',
          },
          totals: summarizeLlmUsageEvents(events),
          events: truthyOption(options.includeEvents) ? events : undefined,
        };
      });
    },

    distillUsage(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      const charsPerToken = positiveNumber(
        options.charsPerToken == null ? 4 : Number(options.charsPerToken),
        'charsPerToken',
      );
      return useStore((store) => {
        const runs = store.listDistillRuns({
          ...scope,
          sessionId: options.sessionId,
        });
        const usageEvents = store.listLlmUsageEvents({
          ...scope,
          sessionId: options.sessionId,
        });
        return summarizeDistillUsage({
          scope,
          sessionId: options.sessionId,
          runs,
          usageEvents,
          charsPerToken,
        });
      });
    },
  };
}
