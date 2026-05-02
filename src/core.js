import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';
import { createDistillProvider } from './distill/index.js';
import { checkCodexExecProvider } from './distill/providers/codex_exec.js';
import { validateDistillOutput } from './distill/validate.js';
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

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
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

function extractUsageMetadata(run) {
  const providerMetadata = run.outputMetadata?.providerMetadata || {};
  const candidates = [
    run.outputMetadata?.usage,
    providerMetadata.usage,
    providerMetadata.codexExec?.usage,
    providerMetadata.codexExec,
  ];

  for (const candidate of candidates) {
    const inputTokens = usageNumberFrom(candidate, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
    const outputTokens = usageNumberFrom(candidate, [
      'outputTokens',
      'output_tokens',
      'completionTokens',
      'completion_tokens',
    ]);
    const totalTokens = usageNumberFrom(candidate, ['totalTokens', 'total_tokens']);
    if (inputTokens != null || outputTokens != null || totalTokens != null) {
      return {
        inputTokens,
        outputTokens,
        totalTokens: totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      };
    }
  }

  return null;
}

function summarizeDistillUsage({ scope, sessionId, runs, charsPerToken = 4 }) {
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
  const actualUsage = {
    runs: actualUsageRuns.length,
    inputTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.inputTokens || 0), 0),
    outputTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.outputTokens || 0), 0),
    totalTokens: actualUsageRuns.reduce((total, run) => total + (run.usage.totalTokens || 0), 0),
  };

  return {
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    sessionId,
    charsPerEstimatedToken: charsPerToken,
    note:
      actualUsage.runs > 0
        ? 'Actual provider usage was found for some runs; runs without actual usage only have estimates.'
        : 'No actual provider token usage was recorded; estimatedInputTokens uses selectedCharCount divided by charsPerEstimatedToken. Older runs without sourceEventWindow metadata may estimate as 0.',
    totals: {
      ...totals,
      completedRuns,
      averageElapsedMs: completedRuns ? Math.round(totals.elapsedMs / completedRuns) : 0,
      actualUsage,
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

function requiresLiveStateVerification(result) {
  return /\b(branch\w*|prs?|pull requests?|issues?|ci|checks?|runtimes?|deploy\w*|deployments?|migrations?|migrate\w*|servers?|services?|queues?|status|drafts?|merge\w*|merged|commits?|tags?|releases?|rollbacks?)\b/i.test(
    resultTextForVerification(result),
  );
}

function bootstrapTrustForType(type) {
  if (type === 'memory') {
    return 'reviewed_durable';
  }
  if (type === 'checkpoint') {
    return 'recent_continuity';
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
    return 'Recent session continuity; useful for resuming work, but verify before acting.';
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
      createdAt: result.checkpoint.createdAt,
    };
  }
  if (result.candidate) {
    return {
      key: result.candidate.candidate.key,
      category: result.candidate.candidate.category,
      content: truncateText(result.candidate.candidate.content),
      candidateId: result.candidate.id,
      status: result.candidate.status,
      checkpointId: result.candidate.checkpointId,
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

function bootstrapRawTailEvent(event) {
  return {
    id: event.id,
    role: event.role,
    content: truncateText(event.content, 800),
    metadata: event.metadata,
    createdAt: event.createdAt,
  };
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
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
    ...(summary.candidateId ? { candidateId: summary.candidateId } : {}),
    ...(summary.status ? { status: summary.status } : {}),
    ...(summary.checkpointId ? { checkpointId: summary.checkpointId } : {}),
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
  return {
    mode: config.storageMode,
    authority: config.storageMode === 'remote' ? 'canonical' : config.storageMode === 'local' ? 'local' : 'project-local',
    vectorReady,
    sqliteVecAvailable: Boolean(info.vector?.sqliteVecAvailable),
    sqliteVecVersion: info.vector?.sqliteVecVersion || null,
    embeddingProvider: info.embeddings?.provider || 'none',
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

function checkpointTimestamp(checkpoint) {
  return checkpoint?.createdAt ? Date.parse(checkpoint.createdAt) : null;
}

function eventsAfterCheckpoint(events, checkpoint) {
  const sourceRawEventIds = Array.isArray(checkpoint?.metadata?.sourceRawEventIds)
    ? checkpoint.metadata.sourceRawEventIds
    : [];
  const lastSourceRawEventId = sourceRawEventIds.at(-1);
  if (lastSourceRawEventId) {
    const lastSourceIndex = events.findIndex((event) => event.id === lastSourceRawEventId);
    if (lastSourceIndex !== -1) {
      return events.slice(lastSourceIndex + 1);
    }
  }

  const checkpointTime = checkpointTimestamp(checkpoint);
  if (!checkpointTime) return events;
  return events.filter((event) => Date.parse(event.createdAt) > checkpointTime);
}

function selectDistillWindow(rawEvents, latestCheckpoint, policy) {
  const candidateEvents = eventsAfterCheckpoint(rawEvents, latestCheckpoint);
  const selected = [];
  let selectedChars = 0;
  const maxEvents = policy.maxEvents;
  const maxChars = policy.maxChars;

  for (let index = candidateEvents.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxEvents) break;
    const event = candidateEvents[index];
    const eventChars = String(event.content || '').length;
    if (selected.length > 0 && selectedChars + eventChars > maxChars) {
      break;
    }
    selected.unshift(event);
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
  const useStore = (fn) => {
    if (sharedStore) {
      return fn(sharedStore);
    }
    return withStore(config, fn);
  };
  let lastRawPruneAt = 0;

  function buildDbInfo(store) {
    return {
      ...store.dbInfo(),
      storageMode: config.storageMode,
      embeddings: {
        provider: config.embeddings.provider,
        model: config.embeddings.model,
        dimensions: config.embeddings.dimensions,
        enabled: Boolean(embeddingProvider),
      },
      rawRetention: {
        ttlDays: config.rawRetention.ttlDays,
        pruneIntervalMs: config.rawRetention.pruneIntervalMs,
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

  async function embedSources(store, sources, { batchSize = 32 } = {}) {
    if (!embeddingProvider) {
      return {
        provider: config.embeddings.provider,
        skipped: true,
        reason: 'embeddings_disabled',
        embedded: 0,
        bySourceType: {},
      };
    }
    store.ensureEmbeddingIndex(embeddingProvider.dimensions);
    let embedded = 0;
    const bySourceType = {};
    try {
      for (let index = 0; index < sources.length; index += batchSize) {
        const batch = sources.slice(index, index + batchSize);
        const embeddings = await embeddingProvider.embed(batch.map((source) => source.text));
        for (const [offset, source] of batch.entries()) {
          store.upsertEmbedding({
            sourceType: source.sourceType,
            recordId: source.recordId,
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            model: embeddingProvider.model,
            dimensions: embeddingProvider.dimensions,
            contentHash: source.contentHash,
            embedding: embeddings[offset],
          });
          embedded += 1;
          bySourceType[source.sourceType] = (bySourceType[source.sourceType] || 0) + 1;
        }
      }
    } catch (error) {
      error.embeddingProgress = {
        scanned: sources.length,
        embedded,
        bySourceType,
      };
      throw error;
    }
    return {
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      scanned: sources.length,
      embedded,
      bySourceType,
      skipped: false,
    };
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

    async bootstrapContext(options = {}) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.query, 'query');
      const limit = positiveNumber(options.limit == null ? 8 : Number(options.limit), 'limit');
      const sharedLimit = Math.min(3, limit);
      const includeShared = truthyOption(options.includeShared);
      const sessionId = options.sessionId || null;
      const rawTailLimit = sessionId
        ? options.rawTailLimit == null
          ? 5
          : positiveNumber(Number(options.rawTailLimit), 'rawTailLimit')
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
        const workingSummary = sessionId
          ? bootstrapWorkingSummary(store.getWorkingSummary({ ...scope, sessionId }))
          : null;
        const rawTail = sessionId
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
          ...(sessionId ? { sessionId, workingSummary, rawTail, rawTailLimit } : {}),
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

    checkCodexExec(options = {}) {
      return checkCodexExecProvider({
        ...codexExec,
        live: Boolean(options.live),
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
      const policy = {
        minEvents: positiveNumber(
          options.minEvents == null ? config.distillPolicy.minEvents : Number(options.minEvents),
          'minEvents',
        ),
        minIntervalMs: positiveNumber(
          options.minIntervalMs == null ? config.distillPolicy.minIntervalMs : Number(options.minIntervalMs),
          'minIntervalMs',
        ),
        charThreshold: positiveNumber(
          options.charThreshold == null ? config.distillPolicy.charThreshold : Number(options.charThreshold),
          'charThreshold',
        ),
        charMinIntervalMs: positiveNumber(
          options.charMinIntervalMs == null ? config.distillPolicy.charMinIntervalMs : Number(options.charMinIntervalMs),
          'charMinIntervalMs',
        ),
        maxEvents: positiveNumber(
          options.maxEvents == null ? config.distillPolicy.maxEvents : Number(options.maxEvents),
          'maxEvents',
        ),
        maxChars: positiveNumber(
          options.maxChars == null ? config.distillPolicy.maxChars : Number(options.maxChars),
          'maxChars',
        ),
      };
      return useStore((store) =>
        buildSessionStatus({
          scope,
          sessionId: options.sessionId,
          rawEvents: store.listRawEvents({ ...scope, sessionId: options.sessionId }),
          latestCheckpoint: store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId }),
          policy,
        }),
      );
    },

    remember(options) {
      const scope = normalizeScopeOptions(options, config);
      return useStore((store) =>
        store.rememberMemory({
          ...scope,
          key: options.key,
          content: options.content,
          category: options.category,
          tags: options.tags,
          importance: options.importance,
        }),
      );
    },

    promoteMemory(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      requireOption(options.content, 'content');

      return useStore((store) =>
        store.rememberMemory({
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
        }),
      );
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

        return store.rememberMemory({
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
        const memory = store.rememberMemory({
          ...scope,
          key,
          content,
          category: options.category || candidate.category || 'note',
          tags: options.tags?.length ? options.tags : candidate.tags || [],
          importance: options.importance == null ? candidate.importance || 0 : options.importance,
          eventType: 'promote',
          eventMetadata: {
            sourceCheckpointId: checkpoint.id,
            sourceSessionId: checkpoint.sessionId,
            sourceCandidateIndex: candidateIndex,
            sourceCandidateId: indexedCandidate?.id || null,
            sourceRawEventIds: options.sourceRawEventIds || [],
            candidateSourceEventIds: candidate.sourceEventIds || [],
            promotionWarnings: warnings,
            reason: options.reason || null,
          },
        });
        if (indexedCandidate) {
          store.markMemoryCandidateReviewed({
            ...scope,
            candidateId: indexedCandidate.id,
            status: 'promoted',
            reason: options.reason || null,
            promotedMemoryId: memory.id,
            allowStatusOverride: truthyOption(options.allowStatusOverride),
            metadata: {
              memoryKey: memory.key,
              memoryId: memory.id,
              promotionWarnings: warnings,
            },
          });
        }
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
        return embedSources(store, sources, { batchSize });
      });
    },

    appendRaw(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      requireOption(options.role, 'role');
      requireOption(options.content, 'content');
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

    getWorkingSummary(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) => store.getWorkingSummary({ ...scope, sessionId: options.sessionId }));
    },

    async distillCheckpoint(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      const provider = createDistillProvider(options.provider || config.distillProvider, distillProviders, {
        codexExec,
      });
      const providerMetadata = provider.metadata || {};

      return useStore(async (store) => {
        const rawEvents = store.listRawEvents({ ...scope, sessionId: options.sessionId });
        const previousCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId });
        const previousWorkingSummary = store.getWorkingSummary({ ...scope, sessionId: options.sessionId });
        const policy = {
          maxEvents: positiveNumber(
            options.maxEvents == null ? config.distillPolicy.maxEvents : Number(options.maxEvents),
            'maxEvents',
          ),
          maxChars: positiveNumber(
            options.maxChars == null ? config.distillPolicy.maxChars : Number(options.maxChars),
            'maxChars',
          ),
        };
        const distillWindow = selectDistillWindow(rawEvents, previousCheckpoint, policy);
        const selectedRawEvents = distillWindow.events;
        const sourceProvenance = sourceProvenanceFromEvents(selectedRawEvents);
        const conversationId =
          options.conversationId || rawEvents.find((event) => event.conversationId)?.conversationId || null;
        const requestedOutputSchema = {
          summaryShort: 'string',
          summaryText: 'string',
          decisions: 'string[]',
          todos: 'string[]',
          openQuestions: 'string[]',
          workingSummary: 'string',
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
            requestedOutputSchema,
          });
        } catch (error) {
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
          metadata: {
            providerMetadata: output.metadata,
            memoryCandidates: output.memoryCandidates,
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

        if (checkpointError) {
          store.failDistillRun({
            id: distillRun.id,
            error: checkpointError,
            outputMetadata: {
              checkpointFailed: true,
              checkpointError: errorSummary(checkpointError),
              workingSummaryUpdated: Boolean(workingSummary),
              workingSummaryId: workingSummary?.id || null,
              workingSummaryError: errorSummary(workingSummaryError),
              providerMetadata: output.metadata,
            },
          });
          throw checkpointError;
        }

        store.completeDistillRun({
          id: distillRun.id,
          outputMetadata: {
            checkpointId: checkpoint.id,
            provider: checkpoint.provider,
            memoryCandidateCount: output.memoryCandidates.length,
            workingSummaryUpdated: Boolean(workingSummary),
            workingSummaryId: workingSummary?.id || null,
            workingSummaryError: errorSummary(workingSummaryError),
            providerMetadata: output.metadata,
          },
        });

        let embedding = {
          provider: config.embeddings.provider,
          skipped: true,
          reason: 'embeddings_disabled',
          embedded: 0,
          bySourceType: {},
        };
        if (embeddingProvider) {
          try {
            const candidates = store.listMemoryCandidates({
              ...scope,
              checkpointId: checkpoint.id,
            });
            embedding = await embedSources(
              store,
              [
                store.embeddingSourceForCheckpoint(checkpoint),
                ...candidates.map((candidate) => store.embeddingSourceForMemoryCandidate(candidate)),
              ],
              { batchSize: 32 },
            );
          } catch (error) {
            embedding = embeddingFailureResult(error);
          }
        }

        return {
          ...checkpoint,
          memoryCandidateCount: output.memoryCandidates.length,
          workingSummary: {
            updated: Boolean(workingSummary),
            id: workingSummary?.id || null,
            error: errorSummary(workingSummaryError),
          },
          embedding,
        };
      });
    },

    listDistillRuns(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return useStore((store) =>
        store.listDistillRuns({
          ...scope,
          sessionId: options.sessionId,
        }),
      );
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
        return summarizeDistillUsage({
          scope,
          sessionId: options.sessionId,
          runs,
          charsPerToken,
        });
      });
    },
  };
}
