const ARRAY_FIELDS = ['decisions', 'todos', 'openQuestions', 'memoryCandidates'];

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Provider output field "${field}" must be a non-empty string.`);
  }
}

function assertArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`Provider output field "${field}" must be an array.`);
  }
}

export function validateDistillOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Provider output must be an object.');
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
    throw new Error('Provider output field "sourceEventCount" must be a non-negative integer.');
  }

  if (output.provider != null && typeof output.provider !== 'string') {
    throw new Error('Provider output field "provider" must be a string when present.');
  }

  if (output.metadata != null && (typeof output.metadata !== 'object' || Array.isArray(output.metadata))) {
    throw new Error('Provider output field "metadata" must be an object when present.');
  }

  return {
    summaryShort: output.summaryShort,
    summaryText: output.summaryText,
    decisions: output.decisions,
    todos: output.todos,
    openQuestions: output.openQuestions,
    memoryCandidates: output.memoryCandidates,
    sourceEventCount: output.sourceEventCount,
    provider: output.provider,
    metadata: output.metadata || {},
  };
}
