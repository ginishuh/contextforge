import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexExecPrompt } from '../src/distill/providers/codex_exec.js';

function promptPayload(input) {
  const { prompt } = buildCodexExecPrompt(input);
  return JSON.parse(prompt.slice(prompt.indexOf('{')));
}

test('scoped distill prompt serializes an explicit target scope and protects it from foreign detours', () => {
  const payload = promptPayload({
    scope: { scope: 'repo', scopeKey: 'github.com/example/repo-a', sessionId: 'native-session' },
    session: { scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'native-session' },
    rawEvents: [{ id: 'event-a', role: 'user', content: 'Resume work in repo A.' }],
  });

  assert.deepEqual(payload.targetScope, {
    scopeType: 'repo',
    scopeKey: 'github.com/example/repo-a',
    sessionId: 'native-session',
  });
  assert.ok(payload.rules.includes('The host process cwd is non-authoritative context and must not override targetScope. Do not infer the target repo, branch, runtime, or live state from it.'));
  assert.ok(payload.rules.includes('If evidence includes a detour into another repo or scope, preserve the paused target-scope work and do not make the detour the latest target-scope state.'));
  assert.ok(payload.rules.includes('Never copy foreign runtime or repository state into structured.liveState. Include target liveState only when target-scoped evidence supports it.'));
  assert.ok(payload.rules.includes('When scope attribution is uncertain, leave the content in raw evidence and, if needed, record only the uncertainty in openQuestions; do not turn it into a target-repo fact or memoryCandidate.'));
});

test('scoped distill prompt derives target scope from the actual session call path', () => {
  const payload = promptPayload({
    session: { scopeType: 'repo', scopeKey: 'github.com/example/repo-a', sessionId: 'native-session' },
    rawEvents: [{ id: 'event-a', role: 'assistant', content: 'Paused repo A work before an unrelated detour.' }],
  });

  assert.deepEqual(payload.targetScope, {
    scopeType: 'repo',
    scopeKey: 'github.com/example/repo-a',
    sessionId: 'native-session',
  });
});
