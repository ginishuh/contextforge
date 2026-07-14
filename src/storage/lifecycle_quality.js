const DAY_MS = 24 * 60 * 60 * 1000;

const PROMOTION_QUALITY_CTE = `
  WITH promotions AS (
    SELECT candidate.id AS candidate_id, candidate.category,
           candidate.promoted_memory_id AS memory_id, MIN(event.created_at) AS promoted_at
    FROM memory_candidate_index candidate
    JOIN memory_events event
      ON event.memory_id = candidate.promoted_memory_id
     AND event.event_type = 'promote'
     AND json_extract(event.metadata_json, '$.sourceCandidateId') = candidate.id
    WHERE candidate.status = 'promoted'
    GROUP BY candidate.id, candidate.category, candidate.promoted_memory_id
  ), promotion_quality AS (
    SELECT promotions.*,
      MAX(CASE WHEN follow.event_type = 'correct'
                AND julianday(follow.created_at) - julianday(promotions.promoted_at) <= 7 THEN 1 ELSE 0 END)
        AS corrected_7d,
      MAX(CASE WHEN follow.event_type = 'correct'
                AND julianday(follow.created_at) - julianday(promotions.promoted_at) <= 30 THEN 1 ELSE 0 END)
        AS corrected_30d,
      MAX(CASE WHEN follow.event_type = 'deactivate'
                AND julianday(follow.created_at) - julianday(promotions.promoted_at) <= 7 THEN 1 ELSE 0 END)
        AS deactivated_7d,
      MAX(CASE WHEN follow.event_type = 'deactivate'
                AND julianday(follow.created_at) - julianday(promotions.promoted_at) <= 30 THEN 1 ELSE 0 END)
        AS deactivated_30d,
      MAX(CASE WHEN follow.event_type IN ('correct', 'deactivate')
                AND julianday(follow.created_at) - julianday(promotions.promoted_at) <= 7 THEN 1 ELSE 0 END)
        AS corrected_or_deactivated_7d,
      MAX(CASE WHEN follow.event_type IN ('correct', 'deactivate')
                AND julianday(follow.created_at) - julianday(promotions.promoted_at) <= 30 THEN 1 ELSE 0 END)
        AS corrected_or_deactivated_30d
    FROM promotions
    LEFT JOIN memory_events follow
      ON follow.memory_id = promotions.memory_id AND follow.created_at > promotions.promoted_at
    GROUP BY promotions.candidate_id, promotions.category, promotions.memory_id, promotions.promoted_at
  )
`;

function ratio(numerator, denominator) {
  const total = Number(denominator || 0);
  return total > 0 ? Number((Number(numerator || 0) / total).toFixed(6)) : null;
}

function countMap(rows, key) {
  return Object.fromEntries(rows.map((row) => [row[key], Number(row.count || 0)]));
}

function promotionQuality(store, transientCategories, { cutoff7d, cutoff30d }) {
  const categories = [...new Set(transientCategories.map(String).filter(Boolean))];
  const transientCondition = categories.length
    ? `category IN (${categories.map(() => '?').join(', ')})`
    : '0';
  return store.db.prepare(`${PROMOTION_QUALITY_CTE}
    SELECT COUNT(*) AS linked_promotions,
           COALESCE(SUM(CASE WHEN julianday(promoted_at) <= julianday(?) THEN 1 ELSE 0 END), 0)
             AS eligible_promotions_7d,
           COALESCE(SUM(CASE WHEN julianday(promoted_at) <= julianday(?) THEN 1 ELSE 0 END), 0)
             AS eligible_promotions_30d,
           COALESCE(SUM(corrected_7d), 0) AS corrected_7d,
           COALESCE(SUM(corrected_30d), 0) AS corrected_30d,
           COALESCE(SUM(deactivated_7d), 0) AS deactivated_7d,
           COALESCE(SUM(deactivated_30d), 0) AS deactivated_30d,
           COALESCE(SUM(corrected_or_deactivated_7d), 0) AS corrected_or_deactivated_7d,
           COALESCE(SUM(corrected_or_deactivated_30d), 0) AS corrected_or_deactivated_30d,
           COALESCE(SUM(CASE WHEN julianday(promoted_at) <= julianday(?)
                              THEN corrected_or_deactivated_7d ELSE 0 END), 0)
             AS eligible_corrected_or_deactivated_7d,
           COALESCE(SUM(CASE WHEN julianday(promoted_at) <= julianday(?)
                              THEN corrected_or_deactivated_30d ELSE 0 END), 0)
             AS eligible_corrected_or_deactivated_30d,
           COALESCE(SUM(CASE WHEN ${transientCondition} THEN 1 ELSE 0 END), 0) AS transient_promotions
    FROM promotion_quality
  `).get(cutoff7d, cutoff30d, cutoff7d, cutoff30d, ...categories);
}

function auditVariants(store, cutoff30d) {
  return store.db.prepare(`${PROMOTION_QUALITY_CTE}, latest_audits AS (
    SELECT candidate.id AS candidate_id, attempt.*
    FROM memory_candidate_index candidate
    JOIN memory_candidate_audit_attempts attempt ON attempt.id = candidate.latest_audit_attempt_id
  )
    SELECT latest_audits.provider, latest_audits.model, latest_audits.prompt_version,
           COUNT(*) AS attempts,
           SUM(CASE WHEN latest_audits.decision = 'approve' THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN latest_audits.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
           SUM(CASE WHEN latest_audits.decision = 'reject' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN promotion_quality.candidate_id IS NOT NULL THEN 1 ELSE 0 END) AS promoted,
           SUM(CASE WHEN julianday(promotion_quality.promoted_at) <= julianday(?) THEN 1 ELSE 0 END)
             AS eligible_promotions_30d,
           SUM(CASE WHEN julianday(promotion_quality.promoted_at) <= julianday(?)
                     AND (promotion_quality.corrected_30d = 1 OR promotion_quality.deactivated_30d = 1)
                    THEN 1 ELSE 0 END) AS corrected_or_deactivated_30d
    FROM latest_audits
    LEFT JOIN promotion_quality ON promotion_quality.candidate_id = latest_audits.candidate_id
    GROUP BY latest_audits.provider, latest_audits.model, latest_audits.prompt_version
    ORDER BY attempts DESC, latest_audits.provider ASC, latest_audits.model ASC, latest_audits.prompt_version ASC
    LIMIT 101
  `).all(cutoff30d, cutoff30d);
}

export function buildMemoryLifecycleQualitySnapshot(
  store,
  { now = new Date(), transientCategories = [] } = {},
) {
  const recentCutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const cutoff7d = new Date(now.getTime() - (7 * DAY_MS)).toISOString();
  const cutoff30d = new Date(now.getTime() - (30 * DAY_MS)).toISOString();
  const byStatus = countMap(
    store.db.prepare('SELECT status, COUNT(*) AS count FROM memory_candidate_index GROUP BY status').all(),
    'status',
  );
  const byAuditDecision = countMap(store.db.prepare(`
    SELECT COALESCE(audit_decision, 'none') AS decision, COUNT(*) AS count
    FROM memory_candidate_index GROUP BY COALESCE(audit_decision, 'none')
  `).all(), 'decision');
  const routingClassifications = countMap(store.db.prepare(`
    SELECT json_extract(review_metadata_json, '$.promotionRouting.classification') AS classification,
           COUNT(*) AS count
    FROM memory_candidate_index
    WHERE json_extract(review_metadata_json, '$.promotionRouting.classification') IS NOT NULL
    GROUP BY classification
  `).all(), 'classification');
  const latest = store.db.prepare(`
    SELECT
      (SELECT MAX(created_at) FROM memory_candidate_index) AS latest_candidate_at,
      (SELECT MAX(completed_at) FROM memory_candidate_audit_attempts) AS latest_audited_at,
      (SELECT MAX(created_at) FROM memory_events WHERE event_type = 'promote') AS latest_promoted_at,
      (SELECT MIN(created_at) FROM memory_candidate_index WHERE status = 'pending') AS oldest_pending_at
  `).get();
  const last24h = store.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM memory_candidate_index WHERE created_at >= ?) AS candidates_created,
      (SELECT COUNT(*) FROM memory_candidate_audit_attempts WHERE completed_at >= ? AND state = 'audited') AS candidates_audited,
      (SELECT COUNT(*) FROM memory_candidate_index WHERE reviewed_at >= ? AND status = 'promoted') AS candidates_promoted,
      (SELECT COUNT(*) FROM memory_candidate_index WHERE reviewed_at >= ? AND status = 'rejected') AS candidates_rejected,
      (SELECT COUNT(*) FROM memory_candidate_index WHERE reviewed_at >= ? AND status = 'stale') AS candidates_staled
  `).get(recentCutoff, recentCutoff, recentCutoff, recentCutoff, recentCutoff);
  const latency = store.db.prepare(`
    SELECT
      AVG(CASE WHEN attempt.completed_at IS NOT NULL
        THEN (julianday(attempt.completed_at) - julianday(candidate.created_at)) * 86400000 END)
        AS closeout_to_audit_ms,
      AVG(CASE WHEN promotion.created_at IS NOT NULL AND attempt.completed_at IS NOT NULL
                    AND julianday(promotion.created_at) >= julianday(attempt.completed_at)
        THEN (julianday(promotion.created_at) - julianday(attempt.completed_at)) * 86400000 END)
        AS audit_to_promotion_ms,
      SUM(CASE WHEN promotion.created_at IS NOT NULL AND attempt.completed_at IS NOT NULL
                    AND julianday(promotion.created_at) < julianday(attempt.completed_at)
        THEN 1 ELSE 0 END) AS audit_to_promotion_clock_skew
    FROM memory_candidate_index candidate
    LEFT JOIN memory_candidate_audit_attempts attempt ON attempt.id = candidate.latest_audit_attempt_id
    LEFT JOIN memory_events promotion
      ON promotion.memory_id = candidate.promoted_memory_id
     AND promotion.event_type = 'promote'
     AND json_extract(promotion.metadata_json, '$.sourceCandidateId') = candidate.id
  `).get();
  const promotion = promotionQuality(store, transientCategories, { cutoff7d, cutoff30d });
  const linkedPromotions = Number(promotion.linked_promotions || 0);
  const activeMemoryCount = Number(
    store.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get().count || 0,
  );
  const duplicateActiveMemoryCount = Number(store.db.prepare(`
    SELECT COALESCE(SUM(item_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS item_count FROM memories
      WHERE status = 'active'
      GROUP BY scope_type, scope_key, content
      HAVING COUNT(*) > 1
    )
  `).get().count || 0);
  const retrievedActiveMemoryCount = Number(store.db.prepare(`
    SELECT COUNT(*) AS count FROM memories
    JOIN memory_retrieval_stats ON memory_retrieval_stats.memory_id = memories.id
    WHERE memories.status = 'active' AND memory_retrieval_stats.retrieval_count > 0
  `).get().count || 0);
  const variants = auditVariants(store, cutoff30d);
  const totalCandidates = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  return {
    kind: 'memory_lifecycle_quality',
    observedAt: now.toISOString(),
    latest: {
      candidateAt: latest.latest_candidate_at || null,
      auditedAt: latest.latest_audited_at || null,
      promotedAt: latest.latest_promoted_at || null,
      oldestPendingAt: latest.oldest_pending_at || null,
      oldestPendingAgeMs: latest.oldest_pending_at
        ? Math.max(0, now.getTime() - Date.parse(latest.oldest_pending_at))
        : 0,
    },
    candidates: {
      total: totalCandidates,
      byStatus,
      byAuditDecision,
      last24h: {
        created: Number(last24h.candidates_created || 0),
        audited: Number(last24h.candidates_audited || 0),
        promoted: Number(last24h.candidates_promoted || 0),
        rejected: Number(last24h.candidates_rejected || 0),
        staled: Number(last24h.candidates_staled || 0),
        conversionRate: ratio(last24h.candidates_promoted, last24h.candidates_created),
      },
      conversionRate: ratio(byStatus.promoted, totalCandidates),
    },
    latency: {
      closeoutToAuditAverageMs: latency.closeout_to_audit_ms == null ? null : Number(latency.closeout_to_audit_ms),
      auditToPromotionAverageMs: latency.audit_to_promotion_ms == null ? null : Number(latency.audit_to_promotion_ms),
      auditToPromotionClockSkewCount: Number(latency.audit_to_promotion_clock_skew || 0),
    },
    routingClassifications,
    promotionQuality: {
      linkedPromotions,
      eligiblePromotions7d: Number(promotion.eligible_promotions_7d || 0),
      eligiblePromotions30d: Number(promotion.eligible_promotions_30d || 0),
      correctedWithin7d: Number(promotion.corrected_7d || 0),
      correctedWithin30d: Number(promotion.corrected_30d || 0),
      deactivatedWithin7d: Number(promotion.deactivated_7d || 0),
      deactivatedWithin30d: Number(promotion.deactivated_30d || 0),
      transientPromotions: Number(promotion.transient_promotions || 0),
      correctedOrDeactivatedWithin7dRate: ratio(
        promotion.eligible_corrected_or_deactivated_7d, promotion.eligible_promotions_7d,
      ),
      correctedOrDeactivatedWithin30dRate: ratio(
        promotion.eligible_corrected_or_deactivated_30d, promotion.eligible_promotions_30d,
      ),
      transientPromotionRate: ratio(promotion.transient_promotions, linkedPromotions),
      activeMemoryCount,
      duplicateActiveMemoryCount,
      duplicateActiveMemoryRate: ratio(duplicateActiveMemoryCount, activeMemoryCount),
    },
    retrievalUsage: {
      activeMemoryCount,
      retrievedActiveMemoryCount,
      retrievedActiveMemoryRate: ratio(retrievedActiveMemoryCount, activeMemoryCount),
    },
    auditVariants: variants.slice(0, 100).map((row) => ({
      provider: row.provider,
      model: row.model || null,
      promptVersion: row.prompt_version || null,
      attempts: Number(row.attempts || 0),
      approved: Number(row.approved || 0),
      needsReview: Number(row.needs_review || 0),
      rejected: Number(row.rejected || 0),
      promoted: Number(row.promoted || 0),
      eligiblePromotions30d: Number(row.eligible_promotions_30d || 0),
      correctedOrDeactivatedWithin30d: Number(row.corrected_or_deactivated_30d || 0),
      approvalRate: ratio(row.approved, row.attempts),
      rejectionRate: ratio(row.rejected, row.attempts),
      correctionRate: ratio(row.corrected_or_deactivated_30d, row.eligible_promotions_30d),
    })),
    auditVariantsTruncated: variants.length > 100,
  };
}
