import { durableMemoryRevisionHash, memoryCandidateRevisionHash } from './candidate_revision.js';

const MAX_RAW_EVENTS = 8;
const MAX_RAW_CHARS = 12000;
const MAX_EVENT_CHARS = 2400;

function clipped(value, limit) {
  const text = String(value || '');
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const suffix = '\n[truncated]';
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

// Only return evidence which the candidate itself cites, or the exact raw
// window that produced its checkpoint.  An audit must not silently absorb the
// rest of a session merely because it happens to share a scope.
export function candidateAuditEvidence(store, scope, indexedCandidate, checkpoint = null, assessment) {
  const candidate = indexedCandidate.candidate || {};
  const raw = indexedCandidate.sessionId
    ? store.listRawEvents({ ...scope, sessionId: indexedCandidate.sessionId })
    : [];
  const citedIds = new Set(
    (candidate.sourceEventIds?.length ? candidate.sourceEventIds : checkpoint?.metadata?.sourceRawEventIds || [])
      .map(String),
  );
  let remaining = MAX_RAW_CHARS;
  const rawEvents = [];
  for (const event of raw.filter((item) => citedIds.has(item.id)).slice(0, MAX_RAW_EVENTS)) {
    if (remaining <= 0) break;
    const content = clipped(event.content, Math.min(MAX_EVENT_CHARS, remaining));
    if (!content) continue;
    remaining -= content.length;
    rawEvents.push({ id: event.id, role: event.role, content, createdAt: event.createdAt });
  }
  const relatedMemories = (assessment?.similarMemories || []).slice(0, 8).map((match) => {
    const memory = store.getMemoryById({ ...scope, memoryId: match.memoryId });
    if (!memory || memory.status !== 'active') return null;
    return {
      id: memory.id,
      revisionHash: durableMemoryRevisionHash(memory),
      key: memory.key,
      category: memory.category,
      content: memory.content,
      tags: memory.tags || [],
      importance: memory.importance,
    };
  }).filter(Boolean);
  return {
    candidateRevisionHash: memoryCandidateRevisionHash(candidate),
    candidateContentTruncated: String(candidate.content || '').length > 3000,
    rawEvents,
    rawEvidenceMode: candidate.sourceEventIds?.length ? 'candidate_source_event_ids' : 'checkpoint_source_window',
    relatedMemories,
  };
}
