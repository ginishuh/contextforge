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

function checkpointTimestamp(checkpoint) {
  return checkpoint?.createdAt ? Date.parse(checkpoint.createdAt) : null;
}

function eventsAfterCheckpoint(events, checkpoint) {
  const checkpointTime = checkpointTimestamp(checkpoint);
  if (!checkpointTime) return events;
  return events.filter((event) => Date.parse(event.createdAt) > checkpointTime);
}

function buildSessionStatus({ scope, sessionId, rawEvents, latestCheckpoint, policy, now = new Date() }) {
  const eventsSinceLastCheckpoint = eventsAfterCheckpoint(rawEvents, latestCheckpoint);
  const rawEventCount = rawEvents.length;
  const rawCharTotal = rawCharCount(rawEvents);
  const charsSinceLastCheckpoint = rawCharCount(eventsSinceLastCheckpoint);
  const latestCheckpointTime = checkpointTimestamp(latestCheckpoint);
  const elapsedMs = latestCheckpointTime ? Math.max(0, now.getTime() - latestCheckpointTime) : null;
  const reasons = [];

  if (rawEventCount === 0) {
    reasons.push('no_raw_events');
  }
  if (!latestCheckpoint && rawEventCount >= policy.minEvents) {
    reasons.push('initial_event_threshold');
  }
  if (!latestCheckpoint && rawCharTotal >= policy.charThreshold) {
    reasons.push('initial_char_threshold');
  }
  if (latestCheckpoint && eventsSinceLastCheckpoint.length >= policy.minEvents && elapsedMs >= policy.minIntervalMs) {
    reasons.push('events_and_interval_since_checkpoint');
  }
  if (latestCheckpoint && charsSinceLastCheckpoint >= policy.charThreshold) {
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
    eventsSinceLastCheckpoint: eventsSinceLastCheckpoint.length,
    charsSinceLastCheckpoint,
    elapsedSinceLastCheckpointMs: elapsedMs,
    thresholds: policy,
    shouldDistill: reasons.some((reason) => reason !== 'no_raw_events'),
    reasons,
  };
}

export function createContextForge(options = {}) {
  const config = loadConfig(options);
  if (config.storageMode === 'remote') {
    return createRemoteContextForge(config, { fetchImpl: options.fetchImpl });
  }

  const distillProviders = options.distillProviders || {};
  const codexExec = {
    ...config.codexExec,
    runner: options.codexExecRunner,
  };

  return {
    config,

    dbInfo() {
      return withStore(config, (store) => store.dbInfo());
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
      };
      return withStore(config, (store) =>
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
      return withStore(config, (store) =>
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

      return withStore(config, (store) =>
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

      return withStore(config, (store) => {
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
      return withStore(config, (store) =>
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
      return withStore(config, (store) =>
        store.listMemoryEvents({
          ...scope,
          key: options.key,
        }),
      );
    },

    listMemoryCandidates(options) {
      const scope = normalizeScopeOptions(options, config);
      return withStore(config, (store) =>
        store
          .listCheckpoints({
            ...scope,
            sessionId: options.sessionId || null,
          })
          .filter((checkpoint) => !options.checkpointId || checkpoint.id === options.checkpointId)
          .flatMap((checkpoint) => {
            const candidates = checkpoint.metadata?.memoryCandidates || [];
            return candidates.map((candidate, index) => ({
              type: 'memory_candidate',
              checkpointId: checkpoint.id,
              sessionId: checkpoint.sessionId,
              conversationId: checkpoint.conversationId,
              scopeType: checkpoint.scopeType,
              scopeKey: checkpoint.scopeKey,
              index,
              candidate,
              source: {
                provider: checkpoint.provider,
                distillRunId: checkpoint.distillRunId,
                sourceEventCount: checkpoint.sourceEventCount,
                checkpointCreatedAt: checkpoint.createdAt,
              },
            }));
          }),
      );
    },

    getMemory(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.key, 'key');
      return withStore(config, (store) =>
        store.getMemory({
          ...scope,
          key: options.key,
        }),
      );
    },

    search(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.query, 'query');
      return withStore(config, (store) =>
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
      return withStore(config, (store) =>
        store.appendRawEvent({
          ...scope,
          sessionId: options.sessionId,
          conversationId: options.conversationId,
          role: options.role,
          content: options.content,
          metadata: options.metadata,
        }),
      );
    },

    async distillCheckpoint(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      const provider = createDistillProvider(options.provider || config.distillProvider, distillProviders, {
        codexExec,
      });
      const providerMetadata = provider.metadata || {};

      return withStore(config, async (store) => {
        const rawEvents = store.listRawEvents({ ...scope, sessionId: options.sessionId });
        const previousCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId });
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
          sourceEventCount: rawEvents.length,
          inputMetadata: {
            rawEventIds: rawEvents.map((event) => event.id),
            previousCheckpointId: previousCheckpoint?.id || null,
            requestedOutputSchema,
            providerMetadata,
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
            rawEvents,
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
          sourceEventCount: output.sourceEventCount ?? rawEvents.length,
          provider: output.provider || provider.name,
          distillRunId: distillRun.id,
          metadata: {
            providerMetadata: output.metadata,
            memoryCandidates: output.memoryCandidates,
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

        return checkpoint;
      });
    },

    listDistillRuns(options) {
      const scope = normalizeScopeOptions(options, config);
      requireOption(options.sessionId, 'sessionId');
      return withStore(config, (store) =>
        store.listDistillRuns({
          ...scope,
          sessionId: options.sessionId,
        }),
      );
    },
  };
}
