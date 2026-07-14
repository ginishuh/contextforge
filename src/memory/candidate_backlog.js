import { pagedList } from '../application/paged_list.js';

export function buildMemoryCandidateBacklog({ store, scope, options = {} }) {
  const filters = {
    ...scope,
    sessionId: options.sessionId || null,
    checkpointId: options.checkpointId || null,
    status: options.status || 'pending',
    candidateType: options.candidateType || null,
    promotionRecommendation: options.promotionRecommendation || null,
    auditState: options.auditState || null,
    auditDecision: options.auditDecision || null,
    category: options.category || null,
    sourceAgent: options.sourceAgent || null,
    sort: null,
  };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const page = pagedList({
    kind: 'memory_candidate_backlog',
    filters,
    options: { ...options, page: options.page == null ? true : options.page },
    load: ({ limit, after }) => store.listMemoryCandidates({ ...filters, limit, after }),
    positionForItem: (item) => [item.createdAt, item.id],
  });
  return {
    kind: 'memory_candidate_backlog',
    asOf: new Date().toISOString(),
    scope,
    filters,
    summary: store.memoryLifecycleSummary({ ...scope, sinceIso: since }),
    page,
  };
}
