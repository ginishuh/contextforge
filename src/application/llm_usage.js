import { currentRequestContext } from '../runtime/request_context.js';

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

export function providerModelFromMetadata(metadata = {}, fallback = null) {
  return (
    metadata.model ||
    metadata.openAiCompatible?.model ||
    metadata.codexExec?.model ||
    metadata.codexSdkPython?.model ||
    fallback ||
    null
  );
}

export function errorUsageMetadata(error) {
  const metadata = error?.metadata && typeof error.metadata === 'object' ? { ...error.metadata } : {};
  if (error?.usage && metadata.usage == null) {
    metadata.usage = error.usage;
  }
  return metadata;
}

export function recordLlmUsageEvent(store, options) {
  const usage = extractProviderUsage(options.metadata || {});
  if (!usage) return null;
  const { usage: usageJson, promptCacheHitTokens, promptCacheMissTokens, ...columns } = usage;
  const times = usageEventTimes({
    startedAt: options.startedAt || null,
    completedAt: options.completedAt || null,
    elapsedMs: options.elapsedMs ?? options.metadata?.elapsedMs ?? null,
  });
  const context = currentRequestContext();
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
    jobId: options.jobId || null,
    ...columns,
    usage: {
      ...(usageJson || {}),
      ...(context?.authTokenId
        ? {
            _contextforge: {
              authTokenId: context.authTokenId,
              authKind: context.authKind || null,
              requestId: context.requestId || null,
              transport: context.transport || null,
            },
          }
        : {}),
    },
    estimated: false,
    ...times,
  });
}

export function summarizeLlmUsageEvents(events) {
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

export function summarizeDistillUsage({ scope, sessionId, runs, usageEvents = [], charsPerToken = 4 }) {
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
