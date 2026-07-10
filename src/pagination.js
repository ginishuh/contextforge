import { createHash } from 'node:crypto';

export const LIST_PAGE_LIMITS = Object.freeze({ default: 100, max: 500 });
const CURSOR_POSITION_TYPES = Object.freeze({
  memories: ['number', 'string', 'string'],
  raw_events: ['string', 'string'],
  checkpoints: ['string', 'string'],
  embedding_jobs: ['string', 'string'],
  memory_candidates: ['string', 'string'],
  memory_events: ['string', 'string'],
  preference_occurrences: ['number', 'string', 'string'],
  memory_update_candidates: ['string', 'string'],
  distill_runs: ['string', 'string'],
  llm_usage_events: ['string', 'string'],
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value ?? null;
}

function binding(kind, filters) {
  return createHash('sha256')
    .update(JSON.stringify({ kind, filters: canonical(filters) }))
    .digest('hex')
    .slice(0, 24);
}

export function resolvePageRequest({ kind, filters = {}, limit, cursor = null, page = false } = {}) {
  const requestedLimit = Number(limit == null ? LIST_PAGE_LIMITS.default : limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('list limit must be a positive integer.');
  }
  const effectiveLimit = Math.min(requestedLimit, LIST_PAGE_LIMITS.max);
  let position = null;
  if (cursor) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid pagination cursor encoding.');
    }
    if (decoded?.v !== 1 || decoded.kind !== kind || decoded.binding !== binding(kind, filters)) {
      throw new Error('Pagination cursor does not match this list operation or filter set.');
    }
    const expectedTypes = CURSOR_POSITION_TYPES[kind];
    if (
      !expectedTypes ||
      !Array.isArray(decoded.position) ||
      decoded.position.length !== expectedTypes.length ||
      decoded.position.some(
        (value, index) =>
          typeof value !== expectedTypes[index] ||
          (expectedTypes[index] === 'number' && !Number.isFinite(value)) ||
          (expectedTypes[index] === 'string' && value.length === 0),
      )
    ) {
      throw new Error('Pagination cursor position is invalid.');
    }
    position = decoded.position;
  }
  return {
    kind,
    filters,
    requestedLimit,
    limit: effectiveLimit,
    page: Boolean(page || cursor),
    position,
  };
}

export function pageResult(items, request, positionForItem) {
  const hasMore = items.length > request.limit;
  const selected = hasMore ? items.slice(0, request.limit) : items;
  const last = selected.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            kind: request.kind,
            binding: binding(request.kind, request.filters),
            position: positionForItem(last),
          }),
        ).toString('base64url')
      : null;
  return {
    kind: `${request.kind}_page`,
    items: selected,
    page: {
      requestedLimit: request.requestedLimit,
      limit: request.limit,
      returned: selected.length,
      hasMore,
      nextCursor,
    },
  };
}

export function compatiblePageResponse(result, request) {
  return request.page ? result : result.items;
}
