import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { makeTempDir } from './temp.js';

export async function makeGitRepo(remoteUrl = 'git@github.com:example/contextforge.git') {
  const cwd = await makeTempDir();
  await fs.mkdir(path.join(cwd, '.git', 'objects'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(cwd, '.git', 'config'),
    `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
[remote "origin"]
\turl = ${remoteUrl}
`,
  );
  return cwd;
}

export async function writeSyntheticCodexRollout(filePath, sessionId = 'codex-rollout-session', cwd = path.dirname(filePath)) {
  const records = [
    {
      timestamp: '2026-04-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd,
      },
    },
    {
      timestamp: '2026-04-25T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Developer instructions should not be captured.' }],
      },
    },
    {
      timestamp: '2026-04-25T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Please continue the ContextForge ingest work.' }],
      },
    },
    {
      timestamp: '2026-04-25T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"npm test"}',
      },
    },
    {
      timestamp: '2026-04-25T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'tests passed',
      },
    },
    {
      timestamp: '2026-04-25T00:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I added Codex rollout ingestion.' }],
      },
    },
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

export async function writeSyntheticClaudeCodeTranscript(filePath, sessionId = 'claude-code-session', cwd = path.dirname(filePath)) {
  const records = [
    {
      type: 'summary',
      sessionId,
      timestamp: '2026-04-25T00:00:00.000Z',
      content: 'Summaries should not be captured as raw dialogue.',
    },
    {
      type: 'user',
      sessionId,
      uuid: 'claude-user-1',
      cwd,
      timestamp: '2026-04-25T00:00:01.000Z',
      message: {
        role: 'user',
        content: 'Continue the ContextForge Claude Code ingest work.',
      },
    },
    {
      type: 'assistant',
      sessionId,
      uuid: 'claude-assistant-tool',
      cwd,
      timestamp: '2026-04-25T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }],
      },
    },
    {
      type: 'user',
      sessionId,
      uuid: 'claude-tool-result',
      cwd,
      timestamp: '2026-04-25T00:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README contents.' }],
      },
    },
    {
      type: 'assistant',
      sessionId,
      uuid: 'claude-assistant-1',
      cwd,
      timestamp: '2026-04-25T00:00:04.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I added Claude Code transcript ingestion.' },
          { type: 'tool_use', id: 'toolu_2', name: 'TodoWrite', input: { todos: [] } },
        ],
      },
    },
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

export async function writeSyntheticGrokChatHistory(
  sessionsDir,
  sessionId = 'grok-session',
  cwd = path.dirname(sessionsDir),
) {
  const sessionDir = path.join(sessionsDir, encodeURIComponent(cwd), sessionId);
  const file = path.join(sessionDir, 'chat_history.jsonl');
  const records = [
    {
      type: 'system',
      content: 'System prompts should not be captured as raw dialogue.',
    },
    {
      type: 'user',
      content: [{ type: 'text', text: 'Continue the ContextForge Grok ingest work.' }],
    },
    {
      type: 'reasoning',
      summary: ['Reasoning should not be captured as raw dialogue.'],
    },
    {
      type: 'assistant',
      content: 'I added Grok chat history ingestion.',
      model_id: 'grok-test',
    },
  ];
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

export async function writeSyntheticCursorTranscript(
  projectsDir,
  sessionId = 'cursor-session',
  projectName = 'home-ubuntu',
) {
  const sessionDir = path.join(projectsDir, projectName, 'agent-transcripts', sessionId);
  const file = path.join(sessionDir, `${sessionId}.jsonl`);
  const records = [
    {
      role: 'user',
      message: {
        content: [{ type: 'text', text: 'Continue the ContextForge Cursor CLI ingest work.' }],
      },
    },
    {
      role: 'assistant',
      message: {
        content: [{ type: 'text', text: 'I added Cursor CLI transcript ingestion.' }],
      },
    },
  ];
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

export async function writeSyntheticOpenCodeDb(dbPath, sessionId = 'opencode-session', cwd = path.dirname(dbPath)) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      create table session (
        id text primary key,
        directory text not null,
        title text not null,
        agent text,
        model text,
        time_created integer not null,
        time_updated integer not null
      );
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `);
    db.prepare(
      'insert into session (id, directory, title, agent, model, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sessionId,
      cwd,
      'Synthetic OpenCode ingest test',
      'build',
      JSON.stringify({ id: 'test-model', providerID: 'test-provider' }),
      1,
      4,
    );
    const messages = [
      {
        id: 'opencode-user-1',
        role: 'user',
        content: 'Continue the ContextForge OpenCode ingest work.',
        time: 2,
      },
      {
        id: 'opencode-assistant-1',
        role: 'assistant',
        content: 'I added OpenCode SQLite ingestion.',
        time: 3,
      },
    ];
    for (const message of messages) {
      db.prepare('insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)').run(
        message.id,
        sessionId,
        message.time,
        message.time,
        JSON.stringify({ role: message.role, path: { cwd, root: cwd }, agent: 'build', modelID: 'test-model' }),
      );
      db.prepare(
        'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)',
      ).run(
        `${message.id}-part`,
        message.id,
        sessionId,
        message.time,
        message.time,
        JSON.stringify({ type: 'text', text: message.content }),
      );
    }
  } finally {
    db.close();
  }
}

export async function appendSyntheticCodexAssistantMessage(filePath, text) {
  const record = {
    timestamp: '2026-04-25T00:00:06.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`);
}

export async function writeSyntheticSessionsTree(rootDir) {
  const first = path.join(rootDir, '2026', '04', '25', 'rollout-first.jsonl');
  const second = path.join(rootDir, '2026', '04', '25', 'rollout-second.jsonl');
  await fs.mkdir(path.dirname(first), { recursive: true });
  await writeSyntheticCodexRollout(first, 'codex-session-first');
  await writeSyntheticCodexRollout(second, 'codex-session-second');
  await fs.appendFile(second, '{"timestamp":"2026-04-25T00:00:06.000Z","type":"response_item"');
  return { first, second };
}
