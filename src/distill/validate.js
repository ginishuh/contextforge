const ARRAY_FIELDS = ['decisions', 'todos', 'openQuestions', 'memoryCandidates'];

function receivedType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Provider output field "${field}" must be a non-empty string; received ${receivedType(value)}.`);
  }
}

function assertArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`Provider output field "${field}" must be an array; received ${receivedType(value)}.`);
  }
}

export function validateDistillOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`Provider output must be an object; received ${receivedType(output)}.`);
  }

  assertString(output.summaryShort, 'summaryShort');
  assertString(output.summaryText, 'summaryText');

  for (const field of ARRAY_FIELDS) {
    assertArray(output[field], field);
  }

  if (
    output.sourceEventCount != null &&
    (!Number.isInteger(output.sourceEventCount) || output.sourceEventCount < 0)
  ) {
    throw new Error(
      `Provider output field "sourceEventCount" must be a non-negative integer; received ${receivedType(
        output.sourceEventCount,
      )}.`,
    );
  }

  if (output.provider != null && typeof output.provider !== 'string') {
    throw new Error(
      `Provider output field "provider" must be a string when present; received ${receivedType(output.provider)}.`,
    );
  }

  if (output.metadata != null && (typeof output.metadata !== 'object' || Array.isArray(output.metadata))) {
    throw new Error(
      `Provider output field "metadata" must be an object when present; received ${receivedType(output.metadata)}.`,
    );
  }

  return {
    summaryShort: output.summaryShort,
    summaryText: output.summaryText,
    decisions: output.decisions,
    todos: output.todos,
    openQuestions: output.openQuestions,
    workingSummary:
      typeof output.workingSummary === 'string' && output.workingSummary.trim()
        ? output.workingSummary
        : output.summaryText,
    memoryCandidates: output.memoryCandidates,
    sourceEventCount: output.sourceEventCount,
    provider: output.provider,
    metadata: output.metadata || {},
  };
}
