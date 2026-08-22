import { createHash } from 'node:crypto';

function normalizedTags(tags) {
  return Array.isArray(tags) ? tags.map((tag) => String(tag)).sort() : [];
}

export function memoryCandidateRevision(candidate = {}) {
  return {
    key: String(candidate.key || ''),
    content: String(candidate.content || ''),
    category: String(candidate.category || 'note'),
    tags: normalizedTags(candidate.tags),
  };
}

export function memoryCandidateRevisionHash(candidate = {}) {
  return createHash('sha256').update(JSON.stringify(memoryCandidateRevision(candidate))).digest('hex');
}

export function durableMemoryRevisionHash(memory) {
  const revision = {
    id: memory?.id || null,
    key: memory?.key || null,
    category: memory?.category || null,
    content: memory?.content || null,
    tags: Array.isArray(memory?.tags) ? memory.tags : [],
    importance: memory?.importance ?? null,
    updatedAt: memory?.updatedAt || null,
  };
  return createHash('sha256').update(JSON.stringify(revision)).digest('hex');
}
