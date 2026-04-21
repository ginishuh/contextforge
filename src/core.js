import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';
import { createDistillProvider } from './distill/index.js';
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
      const provider = createDistillProvider(options.provider || config.distillProvider);

      return withStore(config, async (store) => {
        const rawEvents = store.listRawEvents({ ...scope, sessionId: options.sessionId });
        const previousCheckpoint = store.getLatestCheckpoint({ ...scope, sessionId: options.sessionId });
        const conversationId =
          options.conversationId || rawEvents.find((event) => event.conversationId)?.conversationId || null;

        const output = await provider.distill({
          session: {
            ...scope,
            sessionId: options.sessionId,
            conversationId,
          },
          rawEvents,
          previousCheckpoint,
          requestedOutputSchema: {
            summaryShort: 'string',
            summaryText: 'string',
            decisions: 'string[]',
            todos: 'string[]',
            openQuestions: 'string[]',
            memoryCandidates: 'object[]',
          },
        });

        return store.insertCheckpoint({
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
        });
      });
    },
  };
}
