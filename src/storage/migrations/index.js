export const SQLITE_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 19,
    id: 'v19-compatibility-columns',
    columns: Object.freeze([
      ['checkpoints', 'distill_run_id', 'TEXT'],
      ['checkpoints', 'level', 'INTEGER NOT NULL DEFAULT 0'],
      ['checkpoints', 'covers_from', 'TEXT'],
      ['checkpoints', 'covers_to', 'TEXT'],
      ['checkpoints', 'source', "TEXT NOT NULL DEFAULT 'distill'"],
      ['checkpoints', 'source_ref', 'TEXT'],
      ['checkpoints', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['distill_runs', 'job_id', 'TEXT'],
      ['llm_usage_events', 'job_id', 'TEXT'],
      ['memories', 'status', "TEXT NOT NULL DEFAULT 'active'"],
      ['memories', 'supersedes_memory_id', 'TEXT'],
      ['memories', 'deactivated_at', 'TEXT'],
      ['memory_candidate_index', 'review_reason', 'TEXT'],
      ['memory_candidate_index', 'review_metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['memory_candidate_index', 'candidate_type', 'TEXT'],
      ['memory_candidate_index', 'confidence', 'REAL'],
      ['memory_candidate_index', 'stability', 'REAL'],
      ['memory_candidate_index', 'sensitivity', 'TEXT'],
      ['memory_candidate_index', 'promotion_recommendation', 'TEXT'],
      ['memory_candidate_index', 'source_event_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['memory_candidate_index', 'candidate_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['preference_occurrences', 'negative_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['preference_occurrences', 'last_correction', 'TEXT'],
      ['preference_occurrences', 'review_reason', 'TEXT'],
      ['preference_occurrences', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['memory_update_candidates', 'review_reason', 'TEXT'],
      ['memory_update_candidates', 'review_metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['memory_update_candidates', 'applied_memory_id', 'TEXT'],
      ['embedding_jobs', 'last_error', 'TEXT'],
      ['embedding_jobs', 'completed_at', 'TEXT'],
    ].map(Object.freeze)),
  }),
  Object.freeze({
    version: 20,
    id: 'v20-memory-candidate-lifecycle',
    columns: Object.freeze([
      ['memory_candidate_index', 'audit_state', "TEXT NOT NULL DEFAULT 'unaudited'"],
      ['memory_candidate_index', 'audit_decision', 'TEXT'],
      ['memory_candidate_index', 'audit_content_hash', 'TEXT'],
      ['memory_candidate_index', 'latest_audit_attempt_id', 'TEXT'],
      ['memory_candidate_index', 'snoozed_until', 'TEXT'],
      ['memory_candidate_index', 'snooze_reason', 'TEXT'],
      ['memory_candidate_index', 'snoozed_by', 'TEXT'],
      ['memory_candidate_index', 'wake_up_status', 'TEXT'],
    ].map(Object.freeze)),
  }),
]);

export function applySqliteMigrations({ supportedVersion, ensureColumn }) {
  for (const migration of SQLITE_MIGRATIONS) {
    if (migration.version > supportedVersion) continue;
    for (const [table, column, definition] of migration.columns) {
      ensureColumn(table, column, definition);
    }
  }
}
