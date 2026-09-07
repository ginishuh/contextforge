// Adapter identity belongs to one client invocation, never to a shared server.
const SESSION_OPERATIONS = new Set([
  'agentStart', 'agentCloseout', 'bootstrapContext', 'syncResumeContext',
  'sessionStatus', 'appendRaw', 'getWorkingSummary', 'getSessionWorkingContext',
  'upsertSessionWorkingContext', 'distillCheckpoint', 'submitDistillJob', 'distillUsage',
]);

export function usesAdapterSession(operation) { return SESSION_OPERATIONS.has(operation); }

export function validateAdapterSessionId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 256 || /\s/.test(value)
    || !/^(?:[a-z][a-z0-9_]*:.+|cf_.+)$/.test(value)) {
    throw new Error('Adapter session identity must be a namespaced session ID, such as codex:<id>.');
  }
  return value;
}

export function adapterSessionFromEnv(env = {}) {
  if (env.CONTEXTFORGE_SESSION_ID) return validateAdapterSessionId(env.CONTEXTFORGE_SESSION_ID);
  const codexId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  const claudeId = env.CLAUDE_CODE_SESSION_ID;
  if (codexId && claudeId) {
    throw new Error('Multiple adapter identities are present; set CONTEXTFORGE_SESSION_ID explicitly.');
  }
  if (codexId) return validateAdapterSessionId(`codex:${codexId}`);
  if (claudeId) return validateAdapterSessionId(`claude_code:${claudeId}`);
  return null;
}

export function withAdapterSession(operation, options, sessionId) {
  if (!SESSION_OPERATIONS.has(operation) || options.sessionId != null || options.checkpointId != null || !sessionId) {
    return options;
  }
  return { ...options, sessionId: validateAdapterSessionId(sessionId) };
}

export function withCliAdapterSession(operation, options, env) {
  if (!SESSION_OPERATIONS.has(operation) || options.sessionId != null || options.checkpointId != null) return options;
  return withAdapterSession(operation, options, adapterSessionFromEnv(env));
}
