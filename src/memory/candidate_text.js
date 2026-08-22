// Text primitives shared by candidate promotion scoring, the memory map's
// relation scoring, and duplicate auditing. They live outside the promotion
// module because those three callers must not depend on each other.

export function normalizeContentForRisk(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function qualityTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((token) => token.length > 2);
}

// Jaccard similarity over the token sets. Empty on either side scores 0 rather
// than dividing by zero.
export function tokenOverlapScore(left, right) {
  const leftTokens = new Set(qualityTokens(left));
  const rightTokens = new Set(qualityTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

// Flattens every field a reader would judge the candidate by into one blob, so
// overlap scoring sees the reason and tags rather than the content alone.
export function candidateQualityText({ key, content, candidate = {} }) {
  return [
    key,
    candidate.key,
    content,
    candidate.content,
    candidate.reason,
    candidate.durabilityReason,
    candidate.riskReason,
    candidate.candidateType,
    candidate.category,
    ...(Array.isArray(candidate.tags) ? candidate.tags : []),
    ...(Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : []),
  ]
    .filter(Boolean)
    .join('\n');
}
