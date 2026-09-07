import { bootstrapTrustForType } from './bootstrap_context.js';

const RESUME_REASONS = new Set(['resume', 'compaction_recovery', 'agent_switch']);

export function compactRetrievalRequested(options = {}) {
  const mode = options.responseMode ?? 'full';
  if (!['compact', 'full'].includes(mode)) throw new Error('responseMode must be compact or full.');
  if (options.maxChars != null && (!Number.isInteger(options.maxChars) || options.maxChars < 2000 || options.maxChars > 20000)) {
    throw new Error('maxChars must be an integer between 2000 and 20000.');
  }
  return mode === 'compact';
}

function excerpt(value, maxChars = 500) {
  const text = typeof value === 'string' ? value : '';
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function scopeArgs(source) {
  return { scope: source.scopeType || source.scope, scopeKey: source.scopeKey };
}

function shortList(value, field) {
  return (Array.isArray(value) ? value : []).slice(0, 3)
    .map((item) => excerpt(typeof item === 'string' ? item : item?.[field], 200)).filter(Boolean);
}

function checkpointContext(checkpoint) {
  const structured = checkpoint.structured || checkpoint.metadata?.structured || {};
  const work = structured.work || {};
  return {
    intent: excerpt(work.intent, 240),
    status: excerpt(work.status, 160),
    outcome: excerpt(work.outcome, 300),
    decisions: shortList(checkpoint.decisions),
    nextActions: shortList(structured.nextActions || checkpoint.todos, 'action'),
  };
}

export function compactRetrievalItem(result) {
  const source = result.source || result.scope;
  const args = scopeArgs(source);
  const row = result.memory || result.checkpoint || result.candidate || result;
  const candidate = result.candidate?.candidate;
  const id = row.id || result.candidateId || result.key;
  let detail;
  if (result.type === 'memory') {
    detail = { tool: 'get_memory', arguments: { ...args, key: row.key || result.key } };
  } else if (result.type === 'checkpoint') {
    detail = { tool: 'list_checkpoints', arguments: { ...args, checkpointId: id } };
  } else {
    detail = { tool: 'list_memory_candidates', arguments: { ...args, candidateId: id } };
  }
  const content = candidate?.content || row.content || row.summaryShort || row.summaryText || '';
  return {
    type: result.type,
    id,
    ...(row.key || candidate?.key ? { key: row.key || candidate.key } : {}),
    summary: excerpt(content),
    excerpted: content.length > 500,
    source: {
      scopeType: args.scope,
      scopeKey: args.scopeKey,
      ...(source.workspaceKey ? { workspaceKey: source.workspaceKey, memberName: source.memberName } : {}),
    },
    trust: bootstrapTrustForType(result.type),
    updatedAt: row.updatedAt || row.createdAt || null,
    ...(result.type === 'checkpoint' ? { sessionId: row.sessionId, context: checkpointContext(row) } : {}),
    detail,
  };
}

// Keep identifiers, scope, and detail pointers intact. Drop lower-ranked entries
// instead of cutting JSON or silently truncating an exact retrieval key.
export function fitCompactRetrieval(result) {
  if (result?.responseMode !== 'compact') return result;
  for (const owner of [result, result.storage]) {
    if (!owner?.connection) continue;
    const connection = owner.connection;
    owner.connection = {
      accessMode: connection.accessMode,
      accessPath: connection.accessPath,
      storageAuthority: connection.storageAuthority,
      summary: connection.summary,
    };
  }
  const maxChars = result.budget.maxChars;
  while (JSON.stringify(result).length > maxChars) {
    result.budget.truncated = true;
    if (result.workspace && !result.workspace.omittedByBudget) {
      result.workspace = { workspaceKey: result.workspace.workspaceKey, omittedByBudget: true };
    } else if (result.results.length) {
      result.results.pop();
      result.budget.omittedResults += 1;
    } else if (result.handoff?.context) {
      delete result.handoff.context;
      result.handoff.excerpted = true;
    } else if (result.handoff) {
      result.handoff = null;
      result.handoffStatus = 'omitted_by_budget';
    } else if (result.workspace) {
      delete result.workspace;
    } else {
      throw new Error('Scope and retrieval metadata exceed maxChars; increase the response budget.');
    }
  }
  return result;
}

export function compactRetrievalResponse({ scope, options, results, storage, handoff, handoffStatus, workspace, sharedSkippedReason }) {
  const seen = new Set();
  const identity = (item) => JSON.stringify([item.source.scopeType, item.source.scopeKey, item.type, item.id]);
  if (handoff) seen.add(identity(handoff));
  const items = [];
  for (const row of results) {
    const item = compactRetrievalItem(row);
    const key = identity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return fitCompactRetrieval({
    kind: storage ? 'bootstrap_context' : 'search_results',
    responseMode: 'compact',
    scope,
    ...(sharedSkippedReason ? { sharedSkippedReason } : {}),
    ...(storage ? { storage: { mode: storage.mode, authority: storage.authority, connection: storage.connection } } : {}),
    ...(handoffStatus ? { handoff: handoff || null, handoffStatus } : {}),
    results: items,
    ...(workspace ? { workspace: {
      workspaceKey: options.workspaceKey,
      warnings: workspace.warnings || [],
      excludedScopes: workspace.scopePlan?.excludedScopes || [],
    } } : {}),
    hint: 'Use each detail pointer for full evidence. Verify mutable state from live sources; candidates are unreviewed.',
    budget: { maxChars: options.maxChars ?? 6000, truncated: false, omittedResults: 0 },
  });
}

export function compactBootstrap({ store, scope, options, storage, results, workspace, sharedSkippedReason }) {
  const resume = RESUME_REASONS.has(options.consultReason);
  let handoff = null;
  let handoffStatus = resume ? 'session_required' : 'not_requested';
  if (resume && options.sessionId && options.latestCheckpointLimit !== 0) {
    const checkpoint = store.listCheckpoints({ ...scope, sessionId: options.sessionId, level: 0, limit: 1 })[0];
    handoffStatus = checkpoint ? 'matched_session' : 'no_session_checkpoint';
    if (checkpoint) handoff = compactRetrievalItem({ type: 'checkpoint', checkpoint, source: scope });
  } else if (options.latestCheckpointLimit === 0) {
    handoffStatus = 'disabled';
  }
  return compactRetrievalResponse({ scope, options, storage, results, handoff, handoffStatus, workspace, sharedSkippedReason });
}
