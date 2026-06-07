import { normalizeScopeOptions } from '../scopes/index.js';

const REMOTE_METHODS = [
  'dbInfo',
  'migrateScope',
  'getRuntimeSettings',
  'updateRuntimeSettings',
  'checkDistillProvider',
  'listScopeKeys',
  'bootstrapContext',
  'syncResumeContext',
  'checkCodexExec',
  'beginSession',
  'sessionStatus',
  'listDueDistillSessions',
  'processDueDistills',
  'listDueConsolidations',
  'processConsolidations',
  'remember',
  'promoteMemory',
  'promoteMemoryCandidate',
  'rejectMemoryCandidate',
  'correctMemory',
  'deactivateMemory',
  'listMemoryEvents',
  'listMemoryCandidates',
  'listPreferenceOccurrences',
  'listMemoryUpdateCandidates',
  'applyMemoryUpdateCandidate',
  'rejectMemoryUpdateCandidate',
  'skipMemoryUpdateCandidate',
  'suggestMemoryPromotions',
  'auditMemoryCandidates',
  'autoPromoteMemoryCandidates',
  'reconcileMemory',
  'getMemory',
  'listMemories',
  'search',
  'rebuildEmbeddings',
  'processEmbeddingJobs',
  'listEmbeddingJobs',
  'appendRaw',
  'listRawEvents',
  'listCheckpoints',
  'getWorkingSummary',
  'getSessionWorkingContext',
  'upsertSessionWorkingContext',
  'pruneRawEvents',
  'distillCheckpoint',
  'listDistillRuns',
  'listRecentDistillRuns',
  'distillUsage',
];

const UNSCOPED_REMOTE_METHODS = new Set([
  'dbInfo',
  'migrateScope',
  'getRuntimeSettings',
  'updateRuntimeSettings',
  'checkDistillProvider',
  'checkCodexExec',
  'listScopeKeys',
  'listRecentDistillRuns',
  'pruneRawEvents',
]);

const OPTIONALLY_SCOPED_REMOTE_METHODS = new Set(['listDueDistillSessions', 'processDueDistills']);

function remoteUrl(baseUrl, method) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v0/${method}`;
  return url;
}

function hasScopeHints(options = {}) {
  return Boolean(options.scope || options.scopeType || options.scopeKey || options.cwd || options.repoPath);
}

function makeRemoteError(method, status, body) {
  const message = body?.error?.message || body?.message || `Remote ${method} failed with HTTP ${status}.`;
  const error = new Error(message);
  error.name = body?.error?.name || 'RemoteContextForgeError';
  error.status = status;
  error.remote = true;
  error.details = body?.error || body;
  error.warnings = body?.error?.warnings;
  return error;
}

export class RemoteContextForgeClient {
  constructor({ config, fetchImpl = globalThis.fetch }) {
    if (!config.remote.url) {
      throw new Error('CONTEXTFORGE_REMOTE_URL is required when CONTEXTFORGE_STORAGE_MODE=remote.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Remote storage mode requires a fetch implementation.');
    }

    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async call(method, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.remote.timeoutMs);
    const headers = {
      'content-type': 'application/json',
    };
    if (this.config.remote.token) {
      headers.authorization = `Bearer ${this.config.remote.token}`;
    }

    try {
      const response = await this.fetchImpl(remoteUrl(this.config.remote.url, method), {
        method: 'POST',
        headers,
        body: JSON.stringify(options || {}),
        signal: controller.signal,
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw makeRemoteError(method, response.status, body);
      }
      return body.result;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Remote ${method} timed out after ${this.config.remote.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRemoteContextForge(config, options = {}) {
  const client = new RemoteContextForgeClient({
    config,
    fetchImpl: options.fetchImpl,
  });
  const api = { config };

  function connectionServerRole(connection) {
    return connection?.serverRole || connection?.server?.processRole || connection?.processRole || connection?.mode || null;
  }

  function remoteClientConnection(serverConnection) {
    const serverRole = connectionServerRole(serverConnection);
    const accessPath = serverConnection?.accessPath || serverConnection?.transport || 'http-api';
    if (serverConnection?.mode === 'remote-client') {
      return {
        ...serverConnection,
        accessMode: serverConnection.accessMode || 'remote-client',
        accessPath,
        serverRole,
        viewpoint: 'this client delegates to a remote ContextForge server',
        remoteUrl: config.remote.url,
        clientStorageMode: config.storageMode,
        summary: serverConnection.summary || `remote-client over ${accessPath}${serverRole ? ` to ${serverRole}` : ''}`,
      };
    }
    return {
      mode: 'remote-client',
      accessMode: 'remote-client',
      accessPath: 'http-api',
      viewpoint: 'this client delegates to a remote ContextForge server',
      remoteUrl: config.remote.url,
      clientStorageMode: config.storageMode,
      storageMode: 'remote',
      storageAuthority: 'canonical',
      serverRole,
      server: serverConnection || null,
      note:
        'This client is configured with CONTEXTFORGE_STORAGE_MODE=remote. The server may report its own storageMode as local because it owns the canonical SQLite store.',
      summary: `remote-client over http-api${serverRole ? ` to ${serverRole}` : ''}`,
    };
  }

  for (const method of REMOTE_METHODS) {
    if (method === 'dbInfo') {
      api[method] = async (callOptions = {}) => {
        const serverInfo = await client.call(method, callOptions);
        return {
          ...serverInfo,
          connection: remoteClientConnection(
            serverInfo.connection || {
              mode: serverInfo.storageMode || 'unknown',
              storageMode: serverInfo.storageMode || null,
            },
          ),
        };
      };
      continue;
    }
    if (method === 'bootstrapContext') {
      api[method] = async (callOptions = {}) => {
        const { cwd, repoPath, ...remoteOptions } = callOptions;
        const scope = normalizeScopeOptions(callOptions, config);
        const result = await client.call(method, {
          ...remoteOptions,
          scope: scope.scopeType,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
        });
        return {
          ...result,
          connection: remoteClientConnection(result.connection || result.storage?.connection || null),
          storage: {
            ...result.storage,
            mode: 'remote',
            authority: 'canonical',
            serverMode: result.storage?.mode || null,
            serverAuthority: result.storage?.authority || null,
            note:
              'This bootstrap call used a remote ContextForge client. serverMode describes the server-owned store, not this checkout.',
          },
        };
      };
      continue;
    }
    api[method] = (callOptions = {}) => {
      if (OPTIONALLY_SCOPED_REMOTE_METHODS.has(method) && !hasScopeHints(callOptions)) {
        return client.call(method, callOptions);
      }
      if (UNSCOPED_REMOTE_METHODS.has(method)) {
        return client.call(method, callOptions);
      }
      const { cwd, repoPath, ...remoteOptions } = callOptions;
      const scope = normalizeScopeOptions(callOptions, config);
      return client.call(method, {
        ...remoteOptions,
        scope: scope.scopeType,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      });
    };
  }

  return api;
}

export { REMOTE_METHODS };
