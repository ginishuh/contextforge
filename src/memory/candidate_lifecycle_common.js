import { randomUUID } from 'node:crypto';

// Helpers shared by the candidate lifecycle surfaces (dispositions and the
// stale SLA sweep). Both modules had byte-identical private copies; the error
// strings and the `lifecycleEvents` shape are part of what those operations
// return and persist, so they are defined once here.

// The lifecycle list limit: an explicit value must be a positive integer within
// `max`, and a nullish value falls back. The message names `limit` rather than
// the caller's parameter because every caller passes the `limit` option.
export function boundedLimit(value, fallback = 50, max = 500) {
  const parsed = Number(value == null ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`limit must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

export function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Appends one lifecycle event to a candidate's review metadata. The result is
// written back to `review_metadata_json`, so the key names and the generated
// event id are storage contract.
export function lifecycleMetadata(candidate, event) {
  const existing = Array.isArray(candidate.reviewMetadata?.lifecycleEvents)
    ? candidate.reviewMetadata.lifecycleEvents
    : [];
  return {
    ...(candidate.reviewMetadata || {}),
    lifecycleEvents: [...existing, { id: randomUUID(), ...event }],
  };
}
