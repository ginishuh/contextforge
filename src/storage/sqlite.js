import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export const SCHEMA_VERSION = 8;

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
  const tags = parseJson(row.tags_json, []);
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    key: row.memory_key,
    category: row.category,
    content: row.content,
    tags: Array.isArray(tags) ? tags : [],
    importance: row.importance,
    status: row.status || 'active',
    supersedesMemoryId: row.supersedes_memory_id,
    deactivatedAt: row.deactivated_at,
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

function hydrateMemoryEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    memoryId: row.memory_id,
    eventType: row.event_type,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function hydrateMemoryCandidate(row) {
  if (!row) return null;
  const tags = parseJson(row.tags_json, []);
  return {
    type: 'memory_candidate',
    id: row.id,
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    index: row.candidate_index,
    status: row.status,
    candidate: {
      key: row.candidate_key,
      content: row.candidate_content,
      reason: row.candidate_reason,
      category: row.category,
      tags: Array.isArray(tags) ? tags : [],
      importance: row.importance,
      candidateType: row.candidate_type,
      confidence: row.confidence,
      stability: row.stability,
      sensitivity: row.sensitivity,
      promotionRecommendation: row.promotion_recommendation,
      sourceEventIds: parseJson(row.source_event_ids_json, []),
    },
    source: {
      provider: row.provider,
      distillRunId: row.distill_run_id,
      sourceEventCount: row.source_event_count,
      checkpointCreatedAt: row.checkpoint_created_at,
    },
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    reviewMetadata: parseJson(row.review_metadata_json, {}),
    promotedMemoryId: row.promoted_memory_id,
    createdAt: row.created_at,
  };
}

function ftsValue(value) {
  return String(value || '').replace(/\0/g, ' ');
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.map((tag) => String(tag)) : [];
}

function contentHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function validateDimensions(dimensions) {
  const parsed = Number(dimensions);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('embedding dimensions must be a positive integer.');
  }
  return parsed;
}

function normalizeCandidate(candidate) {
  const value = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  return {
    key: String(value.key || ''),
    content: String(value.content || ''),
    reason: String(value.reason || ''),
    category: value.category ? String(value.category) : 'note',
    tags: normalizeTags(value.tags),
    importance: Number.isFinite(Number(value.importance)) ? Number(value.importance) : 0,
    candidateType: value.candidateType ? String(value.candidateType) : null,
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : null,
    stability: Number.isFinite(Number(value.stability)) ? Number(value.stability) : null,
    sensitivity: value.sensitivity ? String(value.sensitivity) : null,
    promotionRecommendation: value.promotionRecommendation ? String(value.promotionRecommendation) : null,
    sourceEventIds: Array.isArray(value.sourceEventIds) ? value.sourceEventIds.map((item) => String(item)) : [],
  };
}

export class ContextForgeStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'contextforge.db');
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.vectorStatus = this.loadVectorExtension();
    this.migrate();
  }

  loadVectorExtension() {
    try {
      sqliteVec.load(this.db);
      return {
        available: true,
        version: this.db.prepare('SELECT vec_version() AS version').get().version,
        error: null,
      };
    } catch (error) {
      return {
        available: false,
        version: null,
        error: error.message,
      };
    }
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
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        supersedes_memory_id TEXT,
        deactivated_at TEXT,
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

      CREATE TABLE IF NOT EXISTS memory_candidate_index (
        id TEXT PRIMARY KEY,
        checkpoint_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'repo', 'local')),
        scope_key TEXT NOT NULL,
        candidate_index INTEGER NOT NULL,
        candidate_key TEXT NOT NULL,
        candidate_content TEXT NOT NULL,
        candidate_reason TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'note',
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 0,
        candidate_type TEXT,
        confidence REAL,
        stability REAL,
        sensitivity TEXT,
        promotion_recommendation TEXT,
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'promoted', 'rejected', 'stale', 'snoozed')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        review_reason TEXT,
        review_metadata_json TEXT NOT NULL DEFAULT '{}',
        promoted_memory_id TEXT,
        UNIQUE (checkpoint_id, candidate_index),
        FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
        FOREIGN KEY (promoted_memory_id) REFERENCES memories(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        scope_type UNINDEXED,
        scope_key UNINDEXED,
        memory_key,
        category,
        content,
        tags
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(scope_type, scope_key);
      CREATE INDEX IF NOT EXISTS idx_raw_events_session
        ON raw_events(scope_type, scope_key, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints(scope_type, scope_key, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_distill_runs_session
        ON distill_runs(scope_type, scope_key, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_scope_status
        ON memory_candidate_index(scope_type, scope_key, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_checkpoint
        ON memory_candidate_index(checkpoint_id, candidate_index);
    `);

    this.ensureColumn('checkpoints', 'distill_run_id', 'TEXT');
    this.ensureColumn('checkpoints', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('memories', 'status', "TEXT NOT NULL DEFAULT 'active'");
    this.ensureColumn('memories', 'supersedes_memory_id', 'TEXT');
    this.ensureColumn('memories', 'deactivated_at', 'TEXT');
    this.ensureColumn('memory_candidate_index', 'review_reason', 'TEXT');
    this.ensureColumn('memory_candidate_index', 'review_metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('memory_candidate_index', 'candidate_type', 'TEXT');
    this.ensureColumn('memory_candidate_index', 'confidence', 'REAL');
    this.ensureColumn('memory_candidate_index', 'stability', 'REAL');
    this.ensureColumn('memory_candidate_index', 'sensitivity', 'TEXT');
    this.ensureColumn('memory_candidate_index', 'promotion_recommendation', 'TEXT');
    this.ensureColumn('memory_candidate_index', 'source_event_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.backfillMemoryCandidateIndexOnce();
    this.ensureMemoryFts();

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
    const embeddingIndexExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index'")
      .get();
    const embeddingDimensions = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'embedding_dimensions'")
      .get()?.value;
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
        memoryCandidates: count('memory_candidate_index'),
        embeddings: embeddingIndexExists ? count('embedding_index') : 0,
      },
      vector: {
        sqliteVecAvailable: this.vectorStatus.available,
        sqliteVecVersion: this.vectorStatus.version,
        error: this.vectorStatus.error,
        dimensions: embeddingDimensions ? Number(embeddingDimensions) : null,
      },
    };
  }

  ensureEmbeddingIndex(dimensions) {
    const parsedDimensions = validateDimensions(dimensions);
    if (!this.vectorStatus.available) {
      throw new Error(`sqlite-vec is not available: ${this.vectorStatus.error}`);
    }

    const existing = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'embedding_dimensions'").get();
    const existingDimensions = existing?.value ? Number(existing.value) : null;
    if (existingDimensions && existingDimensions !== parsedDimensions) {
      this.db.exec(`
        DROP TABLE IF EXISTS embedding_vec;
        DROP TABLE IF EXISTS embedding_index;
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_index (
        source_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK (source_type IN ('memory', 'checkpoint', 'memory_candidate')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('shared', 'repo', 'local')),
        scope_key TEXT NOT NULL,
        record_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_index_scope
        ON embedding_index(source_type, scope_type, scope_key);
      CREATE INDEX IF NOT EXISTS idx_embedding_index_record
        ON embedding_index(source_type, record_id);
    `);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS embedding_vec USING vec0(source_id TEXT PRIMARY KEY, embedding FLOAT[${parsedDimensions}])`,
    );
    this.db
      .prepare(`
        INSERT INTO schema_meta (key, value)
        VALUES ('embedding_dimensions', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(String(parsedDimensions));
  }

  embeddingTextForMemory(memory) {
    return [
      `key: ${memory.key}`,
      `category: ${memory.category}`,
      memory.tags.length ? `tags: ${memory.tags.join(', ')}` : '',
      `content: ${memory.content}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  embeddingSourceForMemory(memory) {
    const text = this.embeddingTextForMemory(memory);
    return {
      sourceType: 'memory',
      recordId: memory.id,
      scopeType: memory.scopeType,
      scopeKey: memory.scopeKey,
      text,
      contentHash: contentHash(text),
      memory,
    };
  }

  embeddingTextForCheckpoint(checkpoint) {
    const retrievalHooks = Array.isArray(checkpoint.metadata?.providerMetadata?.retrievalHooks)
      ? checkpoint.metadata.providerMetadata.retrievalHooks
      : [];
    return [
      `summary: ${checkpoint.summaryShort}`,
      `details: ${checkpoint.summaryText}`,
      checkpoint.decisions.length ? `decisions: ${checkpoint.decisions.join('\n')}` : '',
      checkpoint.todos.length ? `todos: ${checkpoint.todos.join('\n')}` : '',
      checkpoint.openQuestions.length ? `open questions: ${checkpoint.openQuestions.join('\n')}` : '',
      retrievalHooks.length ? `retrieval hooks: ${retrievalHooks.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  embeddingSourceForCheckpoint(checkpoint) {
    const text = this.embeddingTextForCheckpoint(checkpoint);
    return {
      sourceType: 'checkpoint',
      recordId: checkpoint.id,
      scopeType: checkpoint.scopeType,
      scopeKey: checkpoint.scopeKey,
      text,
      contentHash: contentHash(text),
      checkpoint,
    };
  }

  embeddingTextForMemoryCandidate(candidate) {
    return [
      `key: ${candidate.candidate.key}`,
      `category: ${candidate.candidate.category}`,
      candidate.candidate.tags.length ? `tags: ${candidate.candidate.tags.join(', ')}` : '',
      candidate.candidate.reason ? `reason: ${candidate.candidate.reason}` : '',
      `content: ${candidate.candidate.content}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  embeddingSourceForMemoryCandidate(candidate) {
    const text = this.embeddingTextForMemoryCandidate(candidate);
    return {
      sourceType: 'memory_candidate',
      recordId: candidate.id,
      scopeType: candidate.scopeType,
      scopeKey: candidate.scopeKey,
      text,
      contentHash: contentHash(text),
      candidate,
    };
  }

  listMemoryEmbeddingSources({ scopeType = null, scopeKey = null, model, dimensions, force = false }) {
    const values = [model, dimensions];
    const scopeClause = [];
    if (scopeType) {
      scopeClause.push('memories.scope_type = ?');
      values.push(scopeType);
    }
    if (scopeKey) {
      scopeClause.push('memories.scope_key = ?');
      values.push(scopeKey);
    }
    const scopeSql = scopeClause.length ? `AND ${scopeClause.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`
        SELECT memories.*, embedding_index.content_hash AS embedding_content_hash
        FROM memories
        LEFT JOIN embedding_index
          ON embedding_index.source_type = 'memory'
          AND embedding_index.record_id = memories.id
          AND embedding_index.model = ?
          AND embedding_index.dimensions = ?
        WHERE memories.status = 'active'
          ${scopeSql}
        ORDER BY memories.updated_at ASC, memories.id ASC
      `)
      .all(...values);
    return rows
      .map((row) => {
        const memory = hydrateMemory(row);
        return {
          ...this.embeddingSourceForMemory(memory),
          indexedContentHash: row.embedding_content_hash,
        };
      })
      .filter((source) => force || source.indexedContentHash !== source.contentHash);
  }

  listCheckpointEmbeddingSources({ scopeType = null, scopeKey = null, model, dimensions, force = false }) {
    const values = [model, dimensions];
    const scopeClause = [];
    if (scopeType) {
      scopeClause.push('checkpoints.scope_type = ?');
      values.push(scopeType);
    }
    if (scopeKey) {
      scopeClause.push('checkpoints.scope_key = ?');
      values.push(scopeKey);
    }
    const scopeSql = scopeClause.length ? `AND ${scopeClause.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`
        SELECT checkpoints.*, embedding_index.content_hash AS embedding_content_hash
        FROM checkpoints
        LEFT JOIN embedding_index
          ON embedding_index.source_type = 'checkpoint'
          AND embedding_index.record_id = checkpoints.id
          AND embedding_index.model = ?
          AND embedding_index.dimensions = ?
        WHERE 1 = 1
          ${scopeSql}
        ORDER BY checkpoints.created_at ASC, checkpoints.id ASC
      `)
      .all(...values);
    return rows
      .map((row) => {
        const checkpoint = hydrateCheckpoint(row);
        return {
          ...this.embeddingSourceForCheckpoint(checkpoint),
          indexedContentHash: row.embedding_content_hash,
        };
      })
      .filter((source) => force || source.indexedContentHash !== source.contentHash);
  }

  listMemoryCandidateEmbeddingSources({ scopeType = null, scopeKey = null, model, dimensions, force = false }) {
    const values = [model, dimensions];
    const scopeClause = [];
    if (scopeType) {
      scopeClause.push('memory_candidate_index.scope_type = ?');
      values.push(scopeType);
    }
    if (scopeKey) {
      scopeClause.push('memory_candidate_index.scope_key = ?');
      values.push(scopeKey);
    }
    const scopeSql = scopeClause.length ? `AND ${scopeClause.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`
        SELECT
          memory_candidate_index.*,
          checkpoints.provider,
          checkpoints.distill_run_id,
          checkpoints.source_event_count,
          checkpoints.created_at AS checkpoint_created_at,
          embedding_index.content_hash AS embedding_content_hash
        FROM memory_candidate_index
        JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
        LEFT JOIN embedding_index
          ON embedding_index.source_type = 'memory_candidate'
          AND embedding_index.record_id = memory_candidate_index.id
          AND embedding_index.model = ?
          AND embedding_index.dimensions = ?
        WHERE memory_candidate_index.status IN ('pending', 'promoted')
          ${scopeSql}
        ORDER BY memory_candidate_index.created_at ASC, memory_candidate_index.id ASC
      `)
      .all(...values);
    return rows
      .map((row) => {
        const candidate = hydrateMemoryCandidate(row);
        return {
          ...this.embeddingSourceForMemoryCandidate(candidate),
          indexedContentHash: row.embedding_content_hash,
        };
      })
      .filter((source) => force || source.indexedContentHash !== source.contentHash);
  }

  upsertEmbedding({ sourceType, recordId, scopeType, scopeKey, model, dimensions, contentHash: hash, embedding }) {
    this.ensureEmbeddingIndex(dimensions);
    const sourceId = `${sourceType}:${recordId}`;
    const timestamp = nowIso();
    this.db.prepare('DELETE FROM embedding_vec WHERE source_id = ?').run(sourceId);
    this.db
      .prepare('INSERT INTO embedding_vec(source_id, embedding) VALUES (?, ?)')
      .run(sourceId, JSON.stringify(embedding));
    this.db
      .prepare(`
        INSERT INTO embedding_index (
          source_id, source_type, scope_type, scope_key, record_id,
          model, dimensions, content_hash, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          scope_type = excluded.scope_type,
          scope_key = excluded.scope_key,
          model = excluded.model,
          dimensions = excluded.dimensions,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `)
      .run(sourceId, sourceType, scopeType, scopeKey, recordId, model, Number(dimensions), hash, timestamp, timestamp);
  }

  searchMemoryVectorIndex({ scopeType, scopeKey, embedding, limit = 50 }) {
    const dimensions = embedding.length;
    this.ensureEmbeddingIndex(dimensions);
    return this.db
      .prepare(`
        SELECT
          memories.*,
          embedding_vec.distance AS vector_distance,
          embedding_index.model AS embedding_model,
          embedding_index.dimensions AS embedding_dimensions
        FROM embedding_vec
        JOIN embedding_index ON embedding_index.source_id = embedding_vec.source_id
        JOIN memories ON memories.id = embedding_index.record_id
        WHERE embedding_vec.embedding MATCH ?
          AND k = ?
          AND embedding_index.source_type = 'memory'
          AND embedding_index.scope_type = ?
          AND embedding_index.scope_key = ?
          AND memories.status = 'active'
        ORDER BY embedding_vec.distance ASC
      `)
      .all(JSON.stringify(embedding), limit, scopeType, scopeKey)
      .map((row) => ({
        memory: hydrateMemory(row),
        distance: row.vector_distance,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
      }));
  }

  searchCheckpointVectorIndex({ scopeType, scopeKey, embedding, limit = 50 }) {
    const dimensions = embedding.length;
    this.ensureEmbeddingIndex(dimensions);
    return this.db
      .prepare(`
        SELECT
          checkpoints.*,
          embedding_vec.distance AS vector_distance,
          embedding_index.model AS embedding_model,
          embedding_index.dimensions AS embedding_dimensions
        FROM embedding_vec
        JOIN embedding_index ON embedding_index.source_id = embedding_vec.source_id
        JOIN checkpoints ON checkpoints.id = embedding_index.record_id
        WHERE embedding_vec.embedding MATCH ?
          AND k = ?
          AND embedding_index.source_type = 'checkpoint'
          AND embedding_index.scope_type = ?
          AND embedding_index.scope_key = ?
        ORDER BY embedding_vec.distance ASC
      `)
      .all(JSON.stringify(embedding), limit, scopeType, scopeKey)
      .map((row) => ({
        checkpoint: hydrateCheckpoint(row),
        distance: row.vector_distance,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
      }));
  }

  searchMemoryCandidateVectorIndex({ scopeType, scopeKey, embedding, limit = 50 }) {
    const dimensions = embedding.length;
    this.ensureEmbeddingIndex(dimensions);
    return this.db
      .prepare(`
        SELECT
          memory_candidate_index.*,
          checkpoints.provider,
          checkpoints.distill_run_id,
          checkpoints.source_event_count,
          checkpoints.created_at AS checkpoint_created_at,
          embedding_vec.distance AS vector_distance,
          embedding_index.model AS embedding_model,
          embedding_index.dimensions AS embedding_dimensions
        FROM embedding_vec
        JOIN embedding_index ON embedding_index.source_id = embedding_vec.source_id
        JOIN memory_candidate_index ON memory_candidate_index.id = embedding_index.record_id
        JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
        WHERE embedding_vec.embedding MATCH ?
          AND k = ?
          AND embedding_index.source_type = 'memory_candidate'
          AND embedding_index.scope_type = ?
          AND embedding_index.scope_key = ?
          AND memory_candidate_index.status IN ('pending', 'promoted')
        ORDER BY embedding_vec.distance ASC
      `)
      .all(JSON.stringify(embedding), limit, scopeType, scopeKey)
      .map((row) => ({
        candidate: hydrateMemoryCandidate(row),
        distance: row.vector_distance,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
      }));
  }

  backfillMemoryCandidateIndex() {
    const checkpoints = this.db
      .prepare(`
        SELECT * FROM checkpoints
        WHERE json_array_length(json_extract(metadata_json, '$.memoryCandidates')) > 0
      `)
      .all();
    const transaction = this.db.transaction((rows) => {
      for (const row of rows) {
        this.indexMemoryCandidatesForCheckpoint(hydrateCheckpoint(row));
      }
    });
    transaction(checkpoints);
  }

  backfillMemoryCandidateIndexOnce() {
    const completed = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'memory_candidate_index_backfill_completed_at'")
      .get();
    if (completed?.value) {
      return;
    }
    this.backfillMemoryCandidateIndex();
    this.db
      .prepare(`
        INSERT INTO schema_meta (key, value)
        VALUES ('memory_candidate_index_backfill_completed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(nowIso());
  }

  indexMemoryCandidatesForCheckpoint(checkpoint) {
    const candidates = Array.isArray(checkpoint?.metadata?.memoryCandidates)
      ? checkpoint.metadata.memoryCandidates
      : [];
    if (candidates.length === 0) {
      return [];
    }

    const insert = this.db.prepare(`
      INSERT INTO memory_candidate_index (
        id, checkpoint_id, session_id, conversation_id, scope_type, scope_key,
        candidate_index, candidate_key, candidate_content, candidate_reason,
        category, tags_json, importance, candidate_type, confidence, stability,
        sensitivity, promotion_recommendation, source_event_ids_json, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(checkpoint_id, candidate_index) DO NOTHING
    `);

    for (const [index, rawCandidate] of candidates.entries()) {
      const candidate = normalizeCandidate(rawCandidate);
      insert.run(
        randomUUID(),
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.conversationId,
        checkpoint.scopeType,
        checkpoint.scopeKey,
        index,
        candidate.key,
        candidate.content,
        candidate.reason,
        candidate.category,
        json(candidate.tags, []),
        candidate.importance,
        candidate.candidateType,
        candidate.confidence,
        candidate.stability,
        candidate.sensitivity,
        candidate.promotionRecommendation,
        json(candidate.sourceEventIds, []),
        checkpoint.createdAt,
      );
    }
    return this.listMemoryCandidates({
      scopeType: checkpoint.scopeType,
      scopeKey: checkpoint.scopeKey,
      checkpointId: checkpoint.id,
    });
  }

  pruneRawEventsOlderThan(cutoffIso) {
    if (!cutoffIso) throw new Error('cutoffIso is required.');
    const result = this.db.prepare('DELETE FROM raw_events WHERE created_at < ?').run(cutoffIso);
    return {
      deletedRawEvents: result.changes,
      cutoffIso,
    };
  }

  rebuildMemoryFts() {
    this.db.prepare('DELETE FROM memory_fts').run();
    const rows = this.db
      .prepare(`
        SELECT * FROM memories
        WHERE status = 'active'
      `)
      .all();
    const insert = this.db.prepare(`
      INSERT INTO memory_fts (
        memory_id, scope_type, scope_key, memory_key, category, content, tags
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((memories) => {
      for (const row of memories) {
        insert.run(
          row.id,
          row.scope_type,
          row.scope_key,
          ftsValue(row.memory_key),
          ftsValue(row.category),
          ftsValue(row.content),
          ftsValue(normalizeTags(parseJson(row.tags_json, [])).join(' ')),
        );
      }
    });
    transaction(rows);
  }

  ensureMemoryFts() {
    const schemaRow = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    const activeCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'")
      .get().count;
    const ftsCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get().count;
    if (schemaRow?.value !== String(SCHEMA_VERSION) || (activeCount > 0 && ftsCount === 0)) {
      this.rebuildMemoryFts();
    }
  }

  upsertMemoryFts(memory) {
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memory.id);
    if (memory.status !== 'active') {
      return;
    }
    this.db
      .prepare(`
        INSERT INTO memory_fts (
          memory_id, scope_type, scope_key, memory_key, category, content, tags
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.scopeType,
        memory.scopeKey,
        ftsValue(memory.key),
        ftsValue(memory.category),
        ftsValue(memory.content),
        ftsValue(normalizeTags(memory.tags).join(' ')),
      );
  }

  rememberMemory({
    scopeType,
    scopeKey,
    key,
    content,
    category = 'note',
    tags = [],
    importance = 0,
    status = 'active',
    supersedesMemoryId = null,
    deactivatedAt = null,
    eventType = 'remember',
    eventMetadata,
  }) {
    if (!key) throw new Error('memory key is required.');
    if (!content) throw new Error('memory content is required.');
    const normalizedTags = normalizeTags(tags);

    const id = randomUUID();
    const timestamp = nowIso();
    const row = this.db
      .prepare(`
        INSERT INTO memories (
          id, scope_type, scope_key, memory_key, category, content,
          tags_json, importance, status, supersedes_memory_id, deactivated_at,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_key, memory_key) DO UPDATE SET
          category = excluded.category,
          content = excluded.content,
          tags_json = excluded.tags_json,
          importance = excluded.importance,
          status = excluded.status,
          supersedes_memory_id = excluded.supersedes_memory_id,
          deactivated_at = excluded.deactivated_at,
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
        json(normalizedTags, []),
        Number(importance),
        status,
        supersedesMemoryId,
        deactivatedAt,
        timestamp,
        timestamp,
      );

    this.db
      .prepare(`
        INSERT INTO memory_events (id, memory_id, event_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), row.id, eventType, json(eventMetadata || { key }, {}), nowIso());

    const memory = hydrateMemory(row);
    this.upsertMemoryFts(memory);
    return memory;
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

  searchMemoryIndex({ scopeType, scopeKey, ftsQuery, limit = 50 }) {
    if (!ftsQuery) {
      return [];
    }

    return this.db
      .prepare(`
        SELECT
          memories.*,
          bm25(memory_fts, 0.0, 0.0, 0.0, 8.0, 2.0, 5.0, 1.0) AS fts_rank
        FROM memory_fts
        JOIN memories ON memories.id = memory_fts.memory_id
        WHERE memory_fts MATCH ?
          AND memory_fts.scope_type = ?
          AND memory_fts.scope_key = ?
          AND memories.status = 'active'
        ORDER BY fts_rank ASC, memories.importance DESC, memories.updated_at DESC
        LIMIT ?
      `)
      .all(ftsQuery, scopeType, scopeKey, limit)
      .map((row) => ({
        memory: hydrateMemory(row),
        ftsRank: row.fts_rank,
      }));
  }

  listMemories({ scopeType, scopeKey }) {
    return this.db
      .prepare(`
        SELECT * FROM memories
        WHERE scope_type = ? AND scope_key = ? AND status = 'active'
        ORDER BY importance DESC, updated_at DESC, memory_key ASC
      `)
      .all(scopeType, scopeKey)
      .map(hydrateMemory);
  }

  deactivateMemory({ scopeType, scopeKey, key, reason = null }) {
    const existing = this.getMemory({ scopeType, scopeKey, key });
    if (!existing) {
      throw new Error(`Memory not found: ${key}`);
    }

    const timestamp = nowIso();
    const row = this.db
      .prepare(`
        UPDATE memories
        SET status = 'inactive',
            deactivated_at = ?,
            updated_at = ?
        WHERE scope_type = ? AND scope_key = ? AND memory_key = ?
        RETURNING *
      `)
      .get(timestamp, timestamp, scopeType, scopeKey, key);

    this.db
      .prepare(`
        INSERT INTO memory_events (id, memory_id, event_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        row.id,
        'deactivate',
        json(
          {
            key,
            reason,
            previousContent: existing.content,
            previousStatus: existing.status,
          },
          {},
        ),
        nowIso(),
      );

    const memory = hydrateMemory(row);
    this.upsertMemoryFts(memory);
    return memory;
  }

  listMemoryEvents({ scopeType, scopeKey, key }) {
    const memory = this.getMemory({ scopeType, scopeKey, key });
    if (!memory) {
      throw new Error(`Memory not found: ${key}`);
    }

    return this.db
      .prepare(`
        SELECT * FROM memory_events
        WHERE memory_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(memory.id)
      .map(hydrateMemoryEvent);
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

  listCheckpoints({ scopeType, scopeKey, sessionId = null }) {
    const rows = sessionId
      ? this.db
          .prepare(`
            SELECT * FROM checkpoints
            WHERE scope_type = ? AND scope_key = ? AND session_id = ?
            ORDER BY created_at DESC, id DESC
          `)
          .all(scopeType, scopeKey, sessionId)
      : this.db
          .prepare(`
            SELECT * FROM checkpoints
            WHERE scope_type = ? AND scope_key = ?
            ORDER BY created_at DESC, id DESC
          `)
          .all(scopeType, scopeKey);

    return rows.map(hydrateCheckpoint);
  }

  listMemoryCandidates({
    scopeType,
    scopeKey,
    sessionId = null,
    checkpointId = null,
    status = null,
    candidateType = null,
    promotionRecommendation = null,
    sort = null,
    limit = null,
  }) {
    const conditions = ['memory_candidate_index.scope_type = ?', 'memory_candidate_index.scope_key = ?'];
    const values = [scopeType, scopeKey];
    if (sessionId) {
      conditions.push('memory_candidate_index.session_id = ?');
      values.push(sessionId);
    }
    if (checkpointId) {
      conditions.push('memory_candidate_index.checkpoint_id = ?');
      values.push(checkpointId);
    }
    if (status) {
      conditions.push('memory_candidate_index.status = ?');
      values.push(status);
    }
    if (candidateType) {
      conditions.push('memory_candidate_index.candidate_type = ?');
      values.push(candidateType);
    }
    if (promotionRecommendation) {
      conditions.push('memory_candidate_index.promotion_recommendation = ?');
      values.push(promotionRecommendation);
    }
    const parsedLimit = limit == null ? null : Number(limit);
    const limitClause = Number.isInteger(parsedLimit) && parsedLimit > 0 ? 'LIMIT ?' : '';
    if (limitClause) {
      values.push(parsedLimit);
    }
    const orderBy =
      sort === 'recommendation'
        ? `CASE memory_candidate_index.promotion_recommendation
            WHEN 'promote' THEN 0
            WHEN 'review' THEN 1
            WHEN 'ignore' THEN 2
            WHEN 'reject' THEN 3
            ELSE 4
          END ASC,
          memory_candidate_index.importance DESC,
          memory_candidate_index.confidence DESC,
          memory_candidate_index.stability DESC,
          memory_candidate_index.created_at DESC,
          memory_candidate_index.id DESC`
        : 'memory_candidate_index.created_at DESC, memory_candidate_index.id DESC';

    return this.db
      .prepare(`
        SELECT
          memory_candidate_index.*,
          checkpoints.provider,
          checkpoints.distill_run_id,
          checkpoints.source_event_count,
          checkpoints.created_at AS checkpoint_created_at
        FROM memory_candidate_index
        JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy}
        ${limitClause}
      `)
      .all(...values)
      .map(hydrateMemoryCandidate);
  }

  getMemoryCandidate({ scopeType, scopeKey, candidateId }) {
    const row = this.db
      .prepare(`
        SELECT
          memory_candidate_index.*,
          checkpoints.provider,
          checkpoints.distill_run_id,
          checkpoints.source_event_count,
          checkpoints.created_at AS checkpoint_created_at
        FROM memory_candidate_index
        JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
        WHERE memory_candidate_index.scope_type = ?
          AND memory_candidate_index.scope_key = ?
          AND memory_candidate_index.id = ?
      `)
      .get(scopeType, scopeKey, candidateId);
    return hydrateMemoryCandidate(row);
  }

  getMemoryCandidateByCheckpointIndex({ scopeType, scopeKey, checkpointId, candidateIndex }) {
    const row = this.db
      .prepare(`
        SELECT
          memory_candidate_index.*,
          checkpoints.provider,
          checkpoints.distill_run_id,
          checkpoints.source_event_count,
          checkpoints.created_at AS checkpoint_created_at
        FROM memory_candidate_index
        JOIN checkpoints ON checkpoints.id = memory_candidate_index.checkpoint_id
        WHERE memory_candidate_index.scope_type = ?
          AND memory_candidate_index.scope_key = ?
          AND memory_candidate_index.checkpoint_id = ?
          AND memory_candidate_index.candidate_index = ?
      `)
      .get(scopeType, scopeKey, checkpointId, candidateIndex);
    return hydrateMemoryCandidate(row);
  }

  markMemoryCandidateReviewed({
    scopeType,
    scopeKey,
    candidateId,
    status,
    reason = null,
    promotedMemoryId = null,
    metadata = {},
    expectedStatus = 'pending',
    allowStatusOverride = false,
  }) {
    const existing = this.getMemoryCandidate({ scopeType, scopeKey, candidateId });
    if (!existing) {
      throw new Error(`Memory candidate not found: ${candidateId}`);
    }
    if (!allowStatusOverride && existing.status !== expectedStatus) {
      throw new Error(
        `Memory candidate ${candidateId} is ${existing.status}; expected ${expectedStatus}. Pass allowStatusOverride to change it anyway.`,
      );
    }
    const reviewedAt = nowIso();
    const result = this.db
      .prepare(`
        UPDATE memory_candidate_index
        SET status = ?,
            reviewed_at = ?,
            review_reason = ?,
            review_metadata_json = ?,
            promoted_memory_id = ?
        WHERE scope_type = ?
          AND scope_key = ?
          AND id = ?
      `)
      .run(status, reviewedAt, reason, json(metadata, {}), promotedMemoryId, scopeType, scopeKey, candidateId);
    if (result.changes === 0) {
      throw new Error(`Memory candidate not found: ${candidateId}`);
    }
    return this.getMemoryCandidate({ scopeType, scopeKey, candidateId });
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
    const checkpoint = hydrateCheckpoint(row);
    this.indexMemoryCandidatesForCheckpoint(checkpoint);
    return checkpoint;
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
