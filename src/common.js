import { createHash } from 'node:crypto';

// Leaf utilities shared across layers. Nothing here may import another
// ContextForge module: these exist so core.js and the modules extracted from it
// can share a definition without importing each other.

// Collapses whitespace and appends an ellipsis. The result is a human-readable
// preview for a summary field, not a byte-budget trim — see truncate() in
// src/ingest/common.js for the budget-enforcing variant that reports whether it
// cut anything.
export function summarySnippet(value, maxChars = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

// Importance is a 0-10 integer everywhere it is stored or compared.
export function clampImportance(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(10, Math.round(parsed)));
}

export function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

// Hashes the empty string for a nullish input. Callers persist this value —
// memory content hashes in particular — so the `|| ''` coercion is part of the
// stored contract and must not be relaxed to String(value).
export function contentHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

const CONSULT_REASONS = new Set([
  'startup',
  'resume',
  'compaction_recovery',
  'agent_switch',
  'targeted_search',
  'live_state_check',
  'active_session',
  'unknown',
]);

export function normalizeConsultReason(value) {
  const reason = String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (!CONSULT_REASONS.has(reason)) {
    throw new Error(`consultReason must be one of: ${Array.from(CONSULT_REASONS).join(', ')}.`);
  }
  return reason;
}

export function requireOption(value, name) {
  if (value == null || value === '') {
    throw new Error(`${name} is required.`);
  }
}

export function truthyOption(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

// Serializes an error for a stored/returned payload. Returns null for a falsy
// error, and only carries `code`/`retryable` when the error actually has them —
// callers persist this shape, so the fields and their omission are contract.
// The near-identical variants under src/memory/ are deliberately separate; do
// not fold them together.
export function errorSummary(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    ...(error.code ? { code: error.code } : {}),
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
  };
}

// Matches vocabulary that names mutable live state (branches, PRs, CI, deploys,
// migrations, queues) in English or Korean. Used both to flag a bootstrap
// result as needing live verification and to classify a correction query.
export function liveStateTermsMatch(text) {
  return /(\b(branch\w*|prs?|pull requests?|issues?|ci|checks?|runtimes?|deploy\w*|deployments?|migrations?|migrate\w*|servers?|services?|queues?|status|drafts?|merge\w*|merged|commits?|tags?|releases?|rollbacks?)\b|브랜치|원격|머지|이슈|배포|런타임|마이그레이션|마이그레이트|커밋|릴리즈|롤백|서버|서비스|큐|상태)/i.test(
    String(text || ''),
  );
}

// Deterministic key-sorted clone used to build stable hash inputs. core.js and
// src/embeddings/jobs.js both hash option bags with it, so it lives here rather
// than in either one.
export function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

// Arithmetic mean with an explicit 0 for the empty case. The retrieval and
// quality evals both report metrics with it.
export function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

// The canonical "scopeType:scopeKey" identity string. core.js, the retrieval
// eval, and workspace resolution all key maps by it, so the separator lives in
// one place.
export function scopeIdentity(scopeType, scopeKey) {
  return `${scopeType}:${scopeKey}`;
}

// Strict integer, no fallback, no upper bound. The three variants under
// src/memory/ take a fallback or a cap, so folding them in here would widen or
// narrow their accepted input ranges; they are deliberately separate.
export function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

// The core.js/embeddings variant: any finite positive number, already coerced by
// the caller. Distinct from positiveInteger above, which rejects fractions.
export function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}
