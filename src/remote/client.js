import { normalizeScopeOptions } from '../scopes/index.js';

const REMOTE_METHODS = [
  'dbInfo',
  'checkCodexExec',
  'beginSession',
  'sessionStatus',
  'remember',
  'promoteMemory',
  'promoteMemoryCandidate',
  'rejectMemoryCandidate',
  'correctMemory',
  'deactivateMemory',
  'listMemoryEvents',
  'listMemoryCandidates',
  'getMemory',
  'search',
  'rebuildEmbeddings',
  'appendRaw',
  'listRawEvents',
  'pruneRawEvents',
  'distillCheckpoint',
  'listDistillRuns',
  'distillUsage',
];

const UNSCOPED_REMOTE_METHODS = new Set(['dbInfo', 'checkCodexExec', 'pruneRawEvents']);

function remoteUrl(baseUrl, method) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v0/${method}`;
  return url;
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

  for (const method of REMOTE_METHODS) {
    api[method] = (callOptions = {}) => {
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
