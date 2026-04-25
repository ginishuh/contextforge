import fs from 'node:fs/promises';

const DEFAULT_MAX_CONTENT_CHARS = 8000;

function truncate(value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n[truncated]`, truncated: true };
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      return item.text || item.input_text || item.output_text || '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function normalizeFunctionCall(payload) {
  const name = payload.name || payload.call?.name || 'tool_call';
  const args = payload.arguments || payload.call?.arguments || {};
  return {
    role: 'tool_call',
    content: JSON.stringify({ name, arguments: args }, null, 2),
  };
}

function normalizeFunctionOutput(payload) {
  return {
    role: 'tool_result',
    content: payload.output || payload.result || '',
  };
}

export function normalizeCodexRolloutRecord(record, context, options = {}) {
  if (record.type === 'session_meta') {
    context.sessionId = context.sessionId || record.payload?.id;
    context.conversationId = context.conversationId || record.payload?.id;
    context.cwd = context.cwd || record.payload?.cwd || null;
    return null;
  }

  if (record.type !== 'response_item') {
    return null;
  }

  const payload = record.payload || {};
  let normalized = null;
  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    normalized = {
      role: payload.role,
      content: textFromContent(payload.content),
    };
  } else if (payload.type === 'function_call') {
    normalized = normalizeFunctionCall(payload);
  } else if (payload.type === 'function_call_output') {
    normalized = normalizeFunctionOutput(payload);
  }

  if (!normalized?.content) {
    return null;
  }

  const content = truncate(normalized.content, options.maxContentChars);
  return {
    role: normalized.role,
    content: content.text,
    metadata: {
      source: 'codex_rollout_jsonl',
      ingestId: `codex-rollout:${context.sessionId || 'unknown'}:${context.lineNumber}`,
      recordType: record.type,
      payloadType: payload.type || null,
      codexRole: payload.role || null,
      rolloutTimestamp: record.timestamp || null,
      truncated: content.truncated,
      sourceFile: context.filePath || null,
    },
  };
}

export async function parseCodexRolloutFile(filePath, options = {}) {
  const text = await fs.readFile(filePath, 'utf8');
  const context = {
    filePath,
    sessionId: options.sessionId || null,
    conversationId: options.conversationId || null,
    cwd: null,
    lineNumber: 0,
  };
  const events = [];

  for (const line of text.split(/\r?\n/)) {
    context.lineNumber += 1;
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const event = normalizeCodexRolloutRecord(record, context, options);
    if (event) {
      events.push(event);
    }
  }

  return {
    sessionId: options.sessionId || context.sessionId,
    conversationId: options.conversationId || context.conversationId || context.sessionId,
    cwd: context.cwd,
    events,
  };
}

async function appendNewEvents(app, scopeOptions, parsed) {
  const existing = await app.listRawEvents({
    ...scopeOptions,
    sessionId: parsed.sessionId,
  });
  const existingIds = new Set(existing.map((event) => event.metadata?.ingestId).filter(Boolean));
  const appended = [];
  let skipped = 0;

  for (const event of parsed.events) {
    if (existingIds.has(event.metadata.ingestId)) {
      skipped += 1;
      continue;
    }
    appended.push(
      await app.appendRaw({
        ...scopeOptions,
        sessionId: parsed.sessionId,
        conversationId: parsed.conversationId,
        role: event.role,
        content: event.content,
        metadata: event.metadata,
      }),
    );
  }

  return { appended, skipped };
}

export async function ingestCodexRolloutFile(app, options = {}) {
  if (!options.file) {
    throw new Error('file is required.');
  }
  const parsed = await parseCodexRolloutFile(options.file, options);
  if (!parsed.sessionId) {
    throw new Error('Codex rollout session id could not be determined.');
  }
  const scopeOptions = {
    scope: options.scope,
    scopeKey: options.scopeKey,
    cwd: options.cwd || parsed.cwd,
    repoPath: options.repoPath,
  };
  const { appended, skipped } = await appendNewEvents(app, scopeOptions, parsed);
  const statusOptions = {
    ...scopeOptions,
    sessionId: parsed.sessionId,
    minEvents: options.minEvents,
    minIntervalMs: options.minIntervalMs,
    charThreshold: options.charThreshold,
  };
  const status = await app.sessionStatus(statusOptions);
  let checkpoint = null;
  const distill = options.distill || 'never';
  if (distill === 'always' || (distill === 'auto' && status.shouldDistill)) {
    checkpoint = await app.distillCheckpoint({
      ...scopeOptions,
      sessionId: parsed.sessionId,
      conversationId: parsed.conversationId,
      provider: options.provider,
    });
  }

  return {
    source: 'codex_rollout_jsonl',
    file: options.file,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    parsedEvents: parsed.events.length,
    appendedEvents: appended.length,
    skippedEvents: skipped,
    status,
    checkpoint,
  };
}
