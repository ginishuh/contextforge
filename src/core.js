import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';
import { createDistillProvider } from './distill/index.js';
import { checkCodexExecProvider } from './distill/providers/codex_exec.js';
import { validateDistillOutput } from './distill/validate.js';
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

  return {
    config,

    close() {
      if (sharedStore) {
        sharedStore.close();
      }
    },

    dbInfo() {
      return useStore((store) => ({
        ...store.dbInfo(),
        rawRetention: {
          ttlDays: config.rawRetention.ttlDays,
          pruneIntervalMs: config.rawRetention.pruneIntervalMs,
        },
      }));
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
        return store.markMemoryCandidateReviewed({
          ...scope,
          candidateId: options.candidateId,
          status: 'rejected',
          reason: options.reason,
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
      return useStore((store) =>
        searchMemories(store, {
          ...scope,
          query: options.query,
          limit: options.limit,
          searchScopes: options.searchScopes,
          sharedScopeKey: options.sharedScopeKey || config.defaultSharedScopeKey,
        }),
      );
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

        const checkpoint = store.insertCheckpoint({
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
        });

        store.completeDistillRun({
          id: distillRun.id,
          outputMetadata: {
            checkpointId: checkpoint.id,
            provider: checkpoint.provider,
            memoryCandidateCount: output.memoryCandidates.length,
            providerMetadata: output.metadata,
          },
        });

        return {
          ...checkpoint,
          memoryCandidateCount: output.memoryCandidates.length,
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
  };
}
