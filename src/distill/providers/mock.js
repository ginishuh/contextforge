function firstUsefulLine(events) {
  const event = events.find((item) => item.content && item.content.trim());
  if (!event) return 'No raw events were available for this checkpoint.';
  return `${event.role}: ${event.content.trim().slice(0, 120)}`;
}

function collectLines(events, pattern) {
  return events
    .filter((event) => pattern.test(event.content))
    .map((event) => `${event.role}: ${event.content.trim()}`);
}

export async function distillWithMockProvider(input) {
  const events = input.rawEvents || [];
  const roles = [...new Set(events.map((event) => event.role))].join(', ') || 'none';
  const sourceEventCount = events.length;

  return {
    provider: 'mock',
    summaryShort: `Mock checkpoint for ${sourceEventCount} event(s).`,
    summaryText: [
      `Scope: ${input.session.scopeType}:${input.session.scopeKey}`,
      `Session: ${input.session.sessionId}`,
      `Roles: ${roles}`,
      `First event: ${firstUsefulLine(events)}`,
    ].join('\n'),
    workingSummary: [
      `Current session state for ${input.session.sessionId}: ${sourceEventCount} raw event(s) distilled.`,
      `Latest useful event: ${firstUsefulLine(events)}`,
    ].join('\n'),
    decisions: collectLines(events, /\b(decision|decide|decided)\b/i),
    todos: collectLines(events, /\b(todo|next|follow up|fix|implement)\b/i),
    openQuestions: collectLines(events, /\?/),
    memoryCandidates: [],
    sourceEventCount,
    metadata: {
      roles,
    },
  };
}
