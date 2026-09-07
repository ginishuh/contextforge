import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { ingestCodexRolloutFile, ingestCodexRoutedSessions, ingestCodexRoutedSessionsIncremental } from '../src/ingest/codex.js';
import { ingestAgentRoutedSessions, ingestAgentRoutedSessionsIncremental } from '../src/ingest/agents.js';
import { makeGitRepo } from './helpers/fixtures.js';
import { makeTempDir } from './helpers/temp.js';

function record(type, payload) {
  return JSON.stringify({ timestamp: '2026-09-07T00:00:00.000Z', type, payload });
}

function message(role, text) {
  return record('response_item', { type: 'message', role, content: [{ type: 'text', text }] });
}

async function setup() {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const repoA = await makeGitRepo('git@github.com:example/repo-a.git');
  const repoB = await makeGitRepo('git@github.com:example/repo-b.git');
  const registry = path.join(sessionsDir, 'repos.json');
  await fs.writeFile(registry, JSON.stringify({ repos: [
    { name: 'a', repoPath: repoA, scopeKey: 'github.com/example/repo-a' },
    { name: 'b', repoPath: repoB, scopeKey: 'github.com/example/repo-b' },
  ] }));
  return { dataDir, sessionsDir, repoA, repoB, registry };
}

test('routed Codex ingest assigns a user before turn_context to that turn cwd', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-turns.jsonl');
  await fs.writeFile(file, [
    record('session_meta', { id: 'turn-route', cwd: fixture.repoA }),
    message('user', 'A user'),
    record('turn_context', { turn_id: 'turn-a', cwd: fixture.repoA }),
    message('assistant', 'A assistant'),
    message('user', 'B user'),
    record('turn_context', { turn_id: 'turn-b', cwd: fixture.repoB }),
    message('assistant', 'B assistant'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  const result = await ingestCodexRoutedSessions(app, {
    file, sessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never',
  });

  const item = result.fileResults[0];
  assert.equal(item.matchedRepo, null);
  assert.equal(item.scopeResults.length, 2);
  assert.equal(item.appendedEvents, 4);
  assert.deepEqual(
    app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-a', sessionId: 'codex:turn-route' })
      .map((event) => event.content),
    ['A user', 'A assistant'],
  );
  const bEvents = app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'codex:turn-route' });
  assert.deepEqual(bEvents.map((event) => event.content), ['B user', 'B assistant']);
  assert.ok(bEvents.every((event) => event.metadata.cwd === fixture.repoB && event.metadata.turnId === 'turn-b'));
});

test('incremental routed Codex ingest defers a trailing user until its turn context arrives', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-incremental.jsonl');
  await fs.writeFile(file, [
    record('session_meta', { id: 'incremental-turn-route', cwd: fixture.repoA }),
    message('user', 'B user'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  const options = { file, sessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never', watchStateDir: await makeTempDir() };
  const first = await ingestCodexRoutedSessionsIncremental(app, options);
  assert.equal(first.appendedEvents, 0);
  await fs.appendFile(file, `${record('turn_context', { turn_id: 'turn-b', cwd: fixture.repoB })}\n${message('assistant', 'B assistant')}\n`);
  const second = await ingestCodexRoutedSessionsIncremental(app, options);
  assert.equal(second.appendedEvents, 2);
  assert.equal(app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-a', sessionId: 'codex:incremental-turn-route' }).length, 0);
  assert.deepEqual(
    app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'codex:incremental-turn-route' })
      .map((event) => event.content),
    ['B user', 'B assistant'],
  );
});

test('routed Codex ingest does not send an unknown turn cwd to the session-meta repo', async () => {
  const fixture = await setup();
  const outside = await makeGitRepo('git@github.com:example/outside.git');
  const file = path.join(fixture.sessionsDir, 'rollout-unknown-turn.jsonl');
  await fs.writeFile(file, [
    record('session_meta', { id: 'unknown-turn-route', cwd: fixture.repoA }),
    message('user', 'outside user'),
    record('turn_context', { turn_id: 'outside-turn', cwd: outside }),
    message('assistant', 'outside assistant'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  const result = await ingestCodexRoutedSessions(app, {
    file, sessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never',
  });

  assert.equal(result.fileResults[0].unroutedEvents, 2);
  assert.equal(result.fileResults[0].skipped, true);
  assert.equal(app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-a', sessionId: 'codex:unknown-turn-route' }).length, 0);
});

test('unified routed Codex ingest splits turn scopes in full and incremental modes', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-unified.jsonl');
  await fs.writeFile(file, [
    record('session_meta', { id: 'unified-turn-route', cwd: fixture.repoA }),
    message('user', 'A user'),
    record('turn_context', { turn_id: 'turn-a', cwd: fixture.repoA }),
    message('assistant', 'A assistant'),
    message('user', 'B user'),
    record('turn_context', { turn_id: 'turn-b', cwd: fixture.repoB }),
    message('assistant', 'B assistant'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  const options = { adapters: 'codex', file, codexSessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never', watchStateDir: await makeTempDir() };
  const full = await ingestAgentRoutedSessions(app, options);
  assert.equal(full.appendedEvents, 4);
  assert.equal(full.routedFiles, 1);
  assert.equal(full.adapterResults[0].fileResults[0].scopeResults.length, 2);

  const incrementalData = await makeTempDir();
  const incremental = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: incrementalData }, cwd: process.cwd() });
  const first = await ingestAgentRoutedSessionsIncremental(incremental, options);
  assert.equal(first.appendedEvents, 4);
  const second = await ingestAgentRoutedSessionsIncremental(incremental, options);
  assert.equal(second.appendedEvents, 0);
  assert.equal(second.routedFiles, 0);
});

test('direct Codex repoPath ingest excludes turns outside the bound repository', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-direct-bound.jsonl');
  await fs.writeFile(file, [
    record('session_meta', { id: 'direct-bound-route', cwd: fixture.repoA }),
    message('user', 'A user'),
    record('turn_context', { turn_id: 'turn-a', cwd: fixture.repoA }),
    message('assistant', 'A assistant'),
    message('user', 'B user'),
    record('turn_context', { turn_id: 'turn-b', cwd: fixture.repoB }),
    message('assistant', 'B assistant'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  const result = await ingestCodexRolloutFile(app, { file, repoPath: fixture.repoA, distill: 'never' });

  assert.equal(result.appendedEvents, 2);
  assert.equal(result.skippedEvents, 2);
  assert.deepEqual(
    app.listRawEvents({ scope: 'repo', repoPath: fixture.repoA, sessionId: 'codex:direct-bound-route' }).map((event) => event.content),
    ['A user', 'A assistant'],
  );
});

test('incremental Codex ingest clears prior identity when a rollout file is replaced', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-replaced.jsonl');
  const options = { file, sessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never', watchStateDir: await makeTempDir() };
  await fs.writeFile(file, [
    record('session_meta', { id: 'old-session-with-a-longer-id', cwd: fixture.repoA }),
    message('user', 'old user with more bytes'),
    record('turn_context', { turn_id: 'old-turn', cwd: fixture.repoA }),
    message('assistant', 'old assistant with more bytes'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  await ingestCodexRoutedSessionsIncremental(app, options);
  await fs.writeFile(file, [
    record('session_meta', { id: 'new', cwd: fixture.repoB }),
    message('user', 'new'),
    record('turn_context', { turn_id: 'new-turn', cwd: fixture.repoB }),
    message('assistant', 'new'),
  ].join('\n') + '\n');
  await ingestCodexRoutedSessionsIncremental(app, options);

  assert.equal(app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-a', sessionId: 'codex:old-session-with-a-longer-id' }).length, 2);
  assert.equal(app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'codex:new' }).length, 2);
  assert.equal(app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'codex:old-session-with-a-longer-id' }).length, 0);
});

test('incremental Codex user rewind preserves CRLF and multibyte byte offsets', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-crlf.jsonl');
  const options = { file, sessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never', watchStateDir: await makeTempDir() };
  await fs.writeFile(file, `${record('session_meta', { id: 'crlf', cwd: fixture.repoA })}\r\n${message('user', '한글 사용자') }\r\n`);
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  const first = await ingestCodexRoutedSessionsIncremental(app, options);
  assert.equal(first.appendedEvents, 0);
  await fs.appendFile(file, `${record('turn_context', { turn_id: 'crlf-b', cwd: fixture.repoB })}\r\n${message('assistant', '한글 응답')}\r\n`);
  const second = await ingestCodexRoutedSessionsIncremental(app, options);
  assert.equal(second.appendedEvents, 2);
  assert.deepEqual(
    app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'codex:crlf' }).map((event) => event.content),
    ['한글 사용자', '한글 응답'],
  );
});

test('a reset rollout replays its trailing pending user from the new file', async () => {
  const fixture = await setup();
  const file = path.join(fixture.sessionsDir, 'rollout-reset-pending.jsonl');
  const options = { file, sessionsDir: fixture.sessionsDir, repoRegistry: fixture.registry, distill: 'never', watchStateDir: await makeTempDir() };
  await fs.writeFile(file, [
    record('session_meta', { id: 'old-session-with-many-extra-bytes', cwd: fixture.repoA }),
    message('user', 'old user with many extra bytes'),
    record('turn_context', { turn_id: 'old-turn', cwd: fixture.repoA }),
    message('assistant', 'old assistant with many extra bytes'),
  ].join('\n') + '\n');
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: fixture.dataDir }, cwd: process.cwd() });
  await ingestCodexRoutedSessionsIncremental(app, options);
  await fs.writeFile(file, `${record('session_meta', { id: 'new-pending', cwd: fixture.repoB })}\n${message('user', 'new pending')}\n`);
  const reset = await ingestCodexRoutedSessionsIncremental(app, options);
  assert.equal(reset.appendedEvents, 0);
  await fs.appendFile(file, `${record('turn_context', { turn_id: 'new-turn', cwd: fixture.repoB })}\n${message('assistant', 'new reply')}\n`);
  const replay = await ingestCodexRoutedSessionsIncremental(app, options);
  assert.equal(replay.appendedEvents, 2);
  assert.deepEqual(
    app.listRawEvents({ scope: 'repo', scopeKey: 'github.com/example/repo-b', sessionId: 'codex:new-pending' }).map((event) => event.content),
    ['new pending', 'new reply'],
  );
});
