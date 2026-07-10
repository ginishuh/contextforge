import { compatiblePageResponse, pageResult, resolvePageRequest } from '../pagination.js';

export function pagedList({ kind, filters, options, load, positionForItem }) {
  const request = resolvePageRequest({
    kind,
    filters,
    limit: options.limit,
    cursor: options.cursor,
    page: options.page,
  });
  const items = load({ limit: request.limit + 1, after: request.position });
  return compatiblePageResponse(pageResult(items, request, positionForItem), request);
}
