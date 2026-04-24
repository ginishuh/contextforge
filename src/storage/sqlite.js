import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function parseJson(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    key: row.memory_key,
    category: row.category,
    content: row.content,
    tags: parseJson(row.tags_json, []),
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateRawEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function hydrateCheckpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    summaryShort: row.summary_short,
    summaryText: row.summary_text,
    decisions: parseJson(row.decisions_json, []),
    todos: parseJson(row.todos_json, []),
    openQuestions: parseJson(row.open_questions_json, []),
    sourceEventCount: row.source_event_count,
    provider: row.provider,
    distillRunId: row.distill_run_id,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function hydrateDistillRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    provider: row.provider,
    status: row.status,
    sourceEventCount: row.source_event_count,
    inputMetadata: parseJson(row.input_metadata_json, {}),
    outputMetadata: parseJson(row.output_metadata_json, {}),
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class ContextForgeStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'contextforge.db');
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'repo', 'local')),
        scope_key TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'note',
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (scope_type, scope_key, memory_key)
      );

      CREATE TABLE IF NOT EXISTS raw_events (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'repo', 'local')),
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'repo', 'local')),
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        summary_short TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        decisions_json TEXT NOT NULL DEFAULT '[]',
        todos_json TEXT NOT NULL DEFAULT '[]',
        open_questions_json TEXT NOT NULL DEFAULT '[]',
        source_event_count INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL,
        distill_run_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS distill_runs (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'repo', 'local')),
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
        source_event_count INTEGER NOT NULL DEFAULT 0,
        input_metadata_json TEXT NOT NULL DEFAULT '{}',
        output_metadata_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        error_stack TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(scope_type, scope_key);
      CREATE INDEX IF NOT EXISTS idx_raw_events_session
        ON raw_events(scope_type, scope_key, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints(scope_type, scope_key, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_distill_runs_session
        ON distill_runs(scope_type, scope_key, session_id, created_at);
    `);

    this.ensureColumn('checkpoints', 'distill_run_id', 'TEXT');
    this.ensureColumn('checkpoints', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");

    this.db
      .prepare(`
        INSERT INTO schema_meta (key, value)
        VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(String(SCHEMA_VERSION));
  }

  dbInfo() {
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    return {
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      schemaVersion: Number(
        this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value,
      ),
      tables: {
        memories: count('memories'),
        rawEvents: count('raw_events'),
        checkpoints: count('checkpoints'),
        distillRuns: count('distill_runs'),
        memoryEvents: count('memory_events'),
      },
    };
  }

  rememberMemory({
    scopeType,
    scopeKey,
    key,
    content,
    category = 'note',
    tags = [],
    importance = 0,
    eventType = 'remember',
    eventMetadata,
  }) {
    if (!key) throw new Error('memory key is required.');
    if (!content) throw new Error('memory content is required.');

    const id = randomUUID();
    const timestamp = nowIso();
    const row = this.db
      .prepare(`
        INSERT INTO memories (
          id, scope_type, scope_key, memory_key, category, content,
          tags_json, importance, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_key, memory_key) DO UPDATE SET
          category = excluded.category,
          content = excluded.content,
          tags_json = excluded.tags_json,
          importance = excluded.importance,
          updated_at = excluded.updated_at
        RETURNING *
      `)
      .get(
        id,
        scopeType,
        scopeKey,
        key,
        category,
        content,
        json(tags, []),
        Number(importance),
        timestamp,
        timestamp,
      );

    this.db
      .prepare(`
        INSERT INTO memory_events (id, memory_id, event_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), row.id, eventType, json(eventMetadata || { key }, {}), nowIso());

    return hydrateMemory(row);
  }

  getMemory({ scopeType, scopeKey, key }) {
    const row = this.db
      .prepare(`
        SELECT * FROM memories
        WHERE scope_type = ? AND scope_key = ? AND memory_key = ?
      `)
      .get(scopeType, scopeKey, key);
    return hydrateMemory(row);
  }

  listMemories({ scopeType, scopeKey }) {
    return this.db
      .prepare(`
        SELECT * FROM memories
        WHERE scope_type = ? AND scope_key = ?
        ORDER BY importance DESC, updated_at DESC, memory_key ASC
      `)
      .all(scopeType, scopeKey)
      .map(hydrateMemory);
  }

  appendRawEvent({
    scopeType,
    scopeKey,
    sessionId,
    conversationId = null,
    role,
    content,
    metadata = {},
  }) {
    if (!sessionId) throw new Error('sessionId is required.');
    if (!role) throw new Error('role is required.');
    if (!content) throw new Error('content is required.');

    const row = this.db
      .prepare(`
        INSERT INTO raw_events (
          id, scope_type, scope_key, session_id, conversation_id,
          role, content, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      .get(
        randomUUID(),
        scopeType,
        scopeKey,
        sessionId,
        conversationId,
        role,
        content,
        json(metadata, {}),
        nowIso(),
      );
    return hydrateRawEvent(row);
  }

  listRawEvents({ scopeType, scopeKey, sessionId }) {
    return this.db
      .prepare(`
        SELECT * FROM raw_events
        WHERE scope_type = ? AND scope_key = ? AND session_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(scopeType, scopeKey, sessionId)
      .map(hydrateRawEvent);
  }

  getLatestCheckpoint({ scopeType, scopeKey, sessionId }) {
    const row = this.db
      .prepare(`
        SELECT * FROM checkpoints
        WHERE scope_type = ? AND scope_key = ? AND session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(scopeType, scopeKey, sessionId);
    return hydrateCheckpoint(row);
  }

  insertCheckpoint({
    scopeType,
    scopeKey,
    sessionId,
    conversationId = null,
    summaryShort,
    summaryText,
    decisions = [],
    todos = [],
    openQuestions = [],
    sourceEventCount = 0,
    provider,
    distillRunId = null,
    metadata = {},
  }) {
    const row = this.db
      .prepare(`
        INSERT INTO checkpoints (
          id, scope_type, scope_key, session_id, conversation_id,
          summary_short, summary_text, decisions_json, todos_json,
          open_questions_json, source_event_count, provider, distill_run_id,
          metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      .get(
        randomUUID(),
        scopeType,
        scopeKey,
        sessionId,
        conversationId,
        summaryShort,
        summaryText,
        json(decisions, []),
        json(todos, []),
        json(openQuestions, []),
        Number(sourceEventCount),
        provider,
        distillRunId,
        json(metadata, {}),
        nowIso(),
      );
    return hydrateCheckpoint(row);
  }

  startDistillRun({
    scopeType,
    scopeKey,
    sessionId,
    conversationId = null,
    provider,
    sourceEventCount = 0,
    inputMetadata = {},
  }) {
    const row = this.db
      .prepare(`
        INSERT INTO distill_runs (
          id, scope_type, scope_key, session_id, conversation_id, provider,
          status, source_event_count, input_metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)
        RETURNING *
      `)
      .get(
        randomUUID(),
        scopeType,
        scopeKey,
        sessionId,
        conversationId,
        provider,
        Number(sourceEventCount),
        json(inputMetadata, {}),
        nowIso(),
      );
    return hydrateDistillRun(row);
  }

  completeDistillRun({ id, outputMetadata = {} }) {
    const row = this.db
      .prepare(`
        UPDATE distill_runs
        SET status = 'succeeded',
            output_metadata_json = ?,
            completed_at = ?
        WHERE id = ?
        RETURNING *
      `)
      .get(json(outputMetadata, {}), nowIso(), id);
    return hydrateDistillRun(row);
  }

  failDistillRun({ id, error, outputMetadata = {} }) {
    const row = this.db
      .prepare(`
        UPDATE distill_runs
        SET status = 'failed',
            output_metadata_json = ?,
            error_message = ?,
            error_stack = ?,
            completed_at = ?
        WHERE id = ?
        RETURNING *
      `)
      .get(
        json(outputMetadata, {}),
        error?.message || String(error),
        error?.stack || null,
        nowIso(),
        id,
      );
    return hydrateDistillRun(row);
  }

  listDistillRuns({ scopeType, scopeKey, sessionId }) {
    return this.db
      .prepare(`
        SELECT * FROM distill_runs
        WHERE scope_type = ? AND scope_key = ? AND session_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(scopeType, scopeKey, sessionId)
      .map(hydrateDistillRun);
  }
}
