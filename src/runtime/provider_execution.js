const providerStates = new Map();
const inFlightOperations = new Map();
const keyedLocks = new Map();

export class ProviderTimeoutError extends Error {
  constructor(provider, timeoutMs, message = null) {
    super(message || `${provider} timed out after ${timeoutMs}ms.`);
    this.name = 'ProviderTimeoutError';
    this.code = 'CONTEXTFORGE_PROVIDER_TIMEOUT';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    this.retryable = true;
  }
}

export class ProviderTimeoutExceedsClientTimeoutError extends Error {
  constructor({ operation, provider, providerTimeoutMs, clientTimeoutMs }) {
    super(
      `${operation} cannot start because provider "${provider}" timeout ${providerTimeoutMs}ms ` +
        `is not shorter than the client timeout ${clientTimeoutMs}ms. Increase the client timeout or lower the provider timeout.`,
    );
    this.name = 'ProviderTimeoutExceedsClientTimeoutError';
    this.code = 'CONTEXTFORGE_PROVIDER_TIMEOUT_EXCEEDS_CLIENT_TIMEOUT';
    this.operation = operation;
    this.provider = provider;
    this.providerTimeoutMs = providerTimeoutMs;
    this.clientTimeoutMs = clientTimeoutMs;
    this.retryable = false;
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function providerState(provider, limit) {
  const normalizedProvider = String(provider || 'unknown');
  const normalizedLimit = positiveInteger(limit, 'provider concurrency limit');
  let state = providerStates.get(normalizedProvider);
  if (!state) {
    state = {
      provider: normalizedProvider,
      limit: normalizedLimit,
      active: 0,
      queue: [],
    };
    providerStates.set(normalizedProvider, state);
  } else {
    // Concurrent callers may come from app instances with different configuration.
    // Keep the strictest observed limit until the shared bucket becomes idle.
    state.limit = Math.min(state.limit, normalizedLimit);
  }
  return state;
}

function drainProviderState(state) {
  while (state.active < state.limit && state.queue.length > 0) {
    const job = state.queue.shift();
    state.active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        state.active -= 1;
        drainProviderState(state);
        if (state.active === 0 && state.queue.length === 0 && providerStates.get(state.provider) === state) {
          providerStates.delete(state.provider);
        }
      });
  }
}

export function runWithProviderConcurrency({ provider, limit }, task) {
  if (typeof task !== 'function') {
    throw new Error('provider task must be a function.');
  }
  const state = providerState(provider, limit);
  return new Promise((resolve, reject) => {
    state.queue.push({ task, resolve, reject });
    drainProviderState(state);
  });
}

export function runInFlightOnce(key, task) {
  if (!key) throw new Error('in-flight operation key is required.');
  const existing = inFlightOperations.get(key);
  if (existing) return existing;

  const promise = Promise.resolve().then(task);
  inFlightOperations.set(key, promise);
  const cleanup = () => {
    if (inFlightOperations.get(key) === promise) {
      inFlightOperations.delete(key);
    }
  };
  promise.then(cleanup, cleanup);
  return promise;
}

export async function runWithKeyedLock(key, task) {
  if (!key) throw new Error('keyed lock key is required.');
  const previous = keyedLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  keyedLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (keyedLocks.get(key) === current) {
      keyedLocks.delete(key);
    }
  }
}

export function assertProviderTimeoutFitsClient({ operation, provider, providerTimeoutMs, clientTimeoutMs }) {
  if (clientTimeoutMs == null || providerTimeoutMs == null) return;
  const normalizedClientTimeout = positiveInteger(clientTimeoutMs, 'client timeout');
  const normalizedProviderTimeout = positiveInteger(providerTimeoutMs, 'provider timeout');
  if (normalizedProviderTimeout >= normalizedClientTimeout) {
    throw new ProviderTimeoutExceedsClientTimeoutError({
      operation,
      provider,
      providerTimeoutMs: normalizedProviderTimeout,
      clientTimeoutMs: normalizedClientTimeout,
    });
  }
}

export function providerFailureRetryable(error) {
  if (!error) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;
  if (error.code === 'CONTEXTFORGE_PROVIDER_TIMEOUT') return true;
  if (error.name === 'AbortError') return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT'].includes(error.code)) return true;
  const status = Number(error.status || error.statusCode);
  if (status === 408 || status === 429 || status >= 500) return true;
  return /\b(timeout|timed out|temporar(?:y|ily)|fetch failed|connection reset)\b/i.test(error.message || '');
}

export function providerExecutionSnapshot() {
  return Array.from(providerStates.values()).map((state) => ({
    provider: state.provider,
    limit: state.limit,
    active: state.active,
    queued: state.queue.length,
  }));
}
