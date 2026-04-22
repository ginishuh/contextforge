import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';
import { createDistillProvider } from './distill/index.js';
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
