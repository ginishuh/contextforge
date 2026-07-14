# Embeddings And Maintenance

Read this reference when retrieval quality diagnostics report pending, failed,
or stale vector sources; when rebuilding or pruning derived data; or when
applying raw-event retention.

Embeddings are the supported quality path for retrieval. If `db_info` or
`bootstrap_context` reports pending, failed, or stale vector sources:

1. Call `list_embedding_jobs`.
2. Call `process_embedding_jobs`, using `retryFailed: true` when appropriate.
3. Use `rebuild_embeddings` only for intentional backfill or dimension changes.

For derived-data cleanup:

1. Call `embedding_inventory` first and explain every eligible reason.
2. Keep `prune_embedding_artifacts` in its default dry-run mode until the
   canonical SQLite store is backed up and embedding workers are stopped.
3. Apply bounded batches with `dryRun: false`; do not use `force` merely for
   convenience when jobs are still processing.
4. Use global inventory/GC for vector-only rows. A scoped run deliberately
   skips them because their missing index means their scope cannot be proven.
5. Verify that current active memories and pending/promoted candidates remain
   indexed, then rebuild only sources that are legitimately stale.
6. Preserve current failed jobs for retry. Retired model/dimension deletion
   requires an active provider plus explicit `includeRetired: true`; review
   `reindexSuggestedSourceIds` after hash-mismatch cleanup. When
   `retiredRisk.code` is `mass_retired`, require a separately reviewed
   `confirmMassRetired: true` before applying.
7. Follow `nextCursor` until it is null. A bounded page with an empty plan is
   not proof that a later index/job/vector page has no eligible rows. For
   non-dry GC, repeat the same input cursor while `needsRescan` is true and only
   advance after the current page fits within the applied batch.
8. Treat `blockedRetry: true` the same way: resolve the worker or confirmation
   block, then retry the preserved input cursor before advancing.

Use `prune_raw_events` only according to retention policy; durable memory and
checkpoints are preserved separately.

After a scope migration, remember that `memory_fts` is rebuilt from `memories`
and embedding vectors remain keyed by immutable source ids. If retrieval looks
stale after a migration, inspect `db_info` and embedding job state before
rebuilding embeddings.
