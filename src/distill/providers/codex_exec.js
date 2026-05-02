import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CODEX_EXEC_PROMPT_VERSION = 'codex_exec.prompt.v3';
export const CODEX_EXEC_OUTPUT_SCHEMA_VERSION = 'contextforge.checkpoint.v4';

const OUTPUT_SCHEMA = {
  $id: CODEX_EXEC_OUTPUT_SCHEMA_VERSION,
  type: 'object',
  additionalProperties: false,
  required: [
    'summaryShort',
    'summaryText',
    'workingSummary',
    'decisions',
    'todos',
    'openQuestions',
    'memoryCandidates',
    'sourceEventCount',
    'provider',
    'metadata',
  ],
  properties: {
    summaryShort: { type: 'string', minLength: 1 },
    summaryText: { type: 'string', minLength: 1 },
    workingSummary: { type: 'string', minLength: 1 },
    decisions: { type: 'array', items: { type: 'string' } },
    todos: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    memoryCandidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'content',
          'reason',
          'category',
          'tags',
          'importance',
          'candidateType',
          'confidence',
          'stability',
          'sensitivity',
          'promotionRecommendation',
          'sourceEventIds',
        ],
        properties: {
          key: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
          category: { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string' } },
          importance: { type: ['integer', 'null'] },
          candidateType: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          stability: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          sensitivity: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'restricted', null] },
          promotionRecommendation: { type: ['string', 'null'], enum: ['promote', 'review', 'ignore', 'reject', null] },
          sourceEventIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    sourceEventCount: { type: 'integer', minimum: 0 },
    provider: { type: 'string' },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['providerNotes', 'retrievalHooks'],
      properties: {
        providerNotes: { type: 'string' },
        retrievalHooks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Concrete future-search hooks preserved from the evidence: product names, APIs, commands, paths, error names, issue numbers, model names, time intervals, thresholds, and domain keywords.',
        },
      },
    },
  },
};

const DOCTOR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'provider', 'message'],
  properties: {
    ok: { type: 'boolean' },
    provider: { type: 'string' },
    message: { type: 'string' },
  },
};
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const KILL_GRACE_MS = 5000;

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, Math.max(0, maxChars))}\n[truncated]`,
    truncated: true,
  };
}

function compactCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    id: checkpoint.id,
    summaryShort: checkpoint.summaryShort,
    summaryText: checkpoint.summaryText,
    decisions: checkpoint.decisions,
    todos: checkpoint.todos,
    openQuestions: checkpoint.openQuestions,
    sourceEventCount: checkpoint.sourceEventCount,
    createdAt: checkpoint.createdAt,
  };
}

function compactWorkingSummary(summary) {
  if (!summary) return null;
  return {
    id: summary.id,
    summaryShort: summary.summaryShort,
    summaryText: summary.summaryText,
    sourceCheckpointId: summary.sourceCheckpointId,
    sourceEventCount: summary.sourceEventCount,
    updatedAt: summary.updatedAt,
  };
}

function buildRawEventPayload(rawEvents, maxInputChars) {
  const events = [];
  let remaining = maxInputChars;
  let truncated = false;

  for (const event of rawEvents) {
    const base = {
      id: event.id,
      role: event.role,
      createdAt: event.createdAt,
      metadata: event.metadata,
    };

    if (remaining <= 0) {
      truncated = true;
      events.push({ ...base, content: '[omitted: context budget exhausted]', truncated: true });
      continue;
    }

    const content = truncateText(event.content, remaining);
    remaining -= content.text.length;
    truncated = truncated || content.truncated;
    events.push({ ...base, content: content.text, truncated: content.truncated });
  }

  return { events, truncated };
}

export function buildCodexExecPrompt(input, options = {}) {
  const maxInputChars = options.maxInputChars || 12000;
  const rawPayload = buildRawEventPayload(input.rawEvents || [], maxInputChars);
  const payload = {
    task: 'Distill coding-agent raw events into one ContextForge checkpoint.',
    rules: [
      'Return only JSON that matches the requested schema.',
      'Do not include Markdown, code fences, commentary, or private assumptions.',
      'Preserve uncertainty in openQuestions instead of inventing facts.',
      'Use only the raw events and previous checkpoint supplied in this request.',
      'Write the checkpoint as recent continuity for handoff and search, not as canonical durable truth.',
      'Write workingSummary as the latest rolling session state for immediate continuation: current goal, completed work, active blockers, and next actions.',
      'If previousWorkingSummary is supplied, update it with the new raw events instead of replacing it with a delta-only summary.',
      'Do not make workingSummary a durable fact; it is live handoff state and may be overwritten by later distills.',
      'Optimize the checkpoint for future retrieval, not for a generic meeting-summary style. Preserve concrete hooks a future agent might search for.',
      'Preserve proper nouns, API names, command names, file paths, issue or PR numbers, model names, error strings, numeric thresholds, time intervals, and cadence details when they matter.',
      'Distinguish decision, rationale, risks, conditions, and next action. Do not say only that a topic was discussed.',
      'Include why a direction was chosen, not only what was chosen.',
      'If a failure, bug, or risk was identified, name it concretely and include the suspected cause and affected path when known.',
      'For conditional guidance, include the condition under which the decision applies.',
      'The checkpoint should let a future agent continue without rereading raw evidence for ordinary follow-up work.',
      'Do not copy secrets, tokens, private customer data, or large raw logs into summaries or memoryCandidates.',
      'Populate metadata.retrievalHooks with concise search keywords from the evidence, such as API names, commands, paths, issue numbers, model names, intervals, thresholds, and error names.',
      'For memoryCandidates, include v2 review fields when useful: candidateType, confidence, stability, sensitivity, promotionRecommendation, and sourceEventIds.',
      'For nullable memoryCandidate fields that are not applicable, return null; do not omit required schema fields.',
      'Create memoryCandidates only for facts, decisions, preferences, runbook steps, or failure modes that may remain useful beyond this checkpoint.',
      'For memoryCandidate content, include decision plus rationale when both exist; put future-search keywords in tags and reason instead of flattening them away.',
      'Set promotionRecommendation to promote only for stable, reviewed-looking durable facts; otherwise prefer review, ignore, or reject.',
      'Use low confidence or low stability for guesses, temporary state, implementation-in-progress details, and facts that require current runtime verification.',
      'Use sensitivity high or restricted for any candidate that might contain secrets, personal data, customer data, private runtime paths, or credentials, and do not recommend promotion for it.',
    ],
    session: input.session,
    requestedOutputSchema: input.requestedOutputSchema,
    previousCheckpoint: compactCheckpoint(input.previousCheckpoint),
    previousWorkingSummary: compactWorkingSummary(input.previousWorkingSummary),
    rawEvents: rawPayload.events,
  };

  return {
    prompt: [
      'You are the ContextForge codex_exec distillation provider.',
      'Distill the supplied evidence into a checkpoint for future coding-agent continuity.',
      'Return exactly one JSON object and no surrounding text.',
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n'),
    metadata: {
      provider: 'codex_exec',
      promptVersion: CODEX_EXEC_PROMPT_VERSION,
      outputSchemaVersion: CODEX_EXEC_OUTPUT_SCHEMA_VERSION,
      rawEventCount: rawPayload.events.length,
      inputTruncated: rawPayload.truncated,
      maxInputChars,
    },
  };
}

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseCodexExecJson(text) {
  return parseCodexExecJsonResult(text).output;
}

function parseCodexExecJsonResult(text) {
  const stripped = stripJsonFence(text);
  try {
    return { output: JSON.parse(stripped), jsonRecovery: null };
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return { output: JSON.parse(stripped.slice(start, end + 1)), jsonRecovery: 'brace-fallback' };
      } catch {
        throw new Error('Codex exec did not return valid JSON.');
      }
    }
    throw new Error('Codex exec did not return valid JSON.');
  }
}

function summarizeStderr(stderr) {
  const trimmed = stderr.trim();
  if (!trimmed) return '';

  const errorLines = trimmed
    .split(/\r?\n/)
    .filter((line) => /\b(error|failed|invalid|timeout)\b/i.test(line))
    .join('\n')
    .trim();
  const summary = errorLines || trimmed.slice(-1000);
  return summary.length > 2000 ? `${summary.slice(0, 2000)}\n[truncated]` : summary;
}

export function runCodexExecCommand({ command, args, prompt, timeoutMs, cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    function cleanup() {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    }
    function settle(fn) {
      if (settled) return false;
      settled = true;
      cleanup();
      fn();
      return true;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may already be gone.
        }
      }, KILL_GRACE_MS);
      reject(new Error(`codex_exec timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) {
        cleanup();
        return;
      }
      settle(() => reject(error));
    });
    child.on('close', (code, signal) => {
      if (settled) {
        cleanup();
        return;
      }
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr, code, signal });
        } else {
          const stderrSummary = summarizeStderr(stderr);
          const suffix = stderrSummary ? ` ${stderrSummary}` : '';
          reject(new Error(`codex_exec exited with code ${code}.${suffix}`));
        }
      });
    });

    child.stdin.end(prompt || '');
  });
}

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/).find(Boolean) || '';
}

async function checkCommandAvailable({ runner, command, cwd, timeoutMs }) {
  const result = await runner({
    command,
    args: ['--version'],
    prompt: '',
    timeoutMs,
    cwd,
    env: process.env,
  });

  return {
    ok: true,
    version: firstLine(result.stdout) || firstLine(result.stderr) || null,
  };
}

function appendReasoningEffortConfig(args, reasoningEffort) {
  if (reasoningEffort) {
    if (!REASONING_EFFORTS.has(reasoningEffort)) {
      throw new Error(
        `Invalid codex_exec reasoning effort "${reasoningEffort}". Expected one of: minimal, low, medium, high.`,
      );
    }
    args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  }
}

async function runLiveSmoke({ runner, command, model, reasoningEffort, sandbox, cwd, timeoutMs }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-codex-doctor-'));
  const schemaPath = path.join(tempDir, 'doctor.schema.json');
  const outputPath = path.join(tempDir, 'doctor.json');
  try {
    await fs.writeFile(schemaPath, `${JSON.stringify(DOCTOR_OUTPUT_SCHEMA, null, 2)}\n`, 'utf8');
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      sandbox,
      '--cd',
      cwd,
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
    ];
    if (model) {
      args.push('--model', model);
    }
    appendReasoningEffortConfig(args, reasoningEffort);
    args.push('-');

    const prompt = [
      'Return exactly one JSON object with these fields:',
      '{"ok": true, "provider": "codex_exec", "message": "codex_exec smoke ok"}',
      'No Markdown or surrounding text.',
    ].join('\n');

    const result = await runner({
      command,
      args,
      prompt,
      timeoutMs,
      cwd,
      env: process.env,
    });
    const outputText = (await readTextIfPresent(outputPath)) || result.stdout || '';
    const { output } = parseCodexExecJsonResult(outputText);
    if (output.ok !== true || output.provider !== 'codex_exec') {
      throw new Error('codex_exec smoke returned JSON but did not confirm provider readiness.');
    }

    return {
      ok: true,
      output,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function checkCodexExecProvider(options = {}) {
  const runner = options.runner || runCodexExecCommand;
  const command = options.command || 'codex';
  const model = options.model || null;
  const reasoningEffort = options.reasoningEffort || null;
  const sandbox = options.sandbox || 'read-only';
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 120000;
  const live = Boolean(options.live);
  const result = {
    ok: false,
    provider: 'codex_exec',
    command,
    model,
    reasoningEffort,
    sandbox,
    cwd,
    timeoutMs,
    live,
    promptVersion: CODEX_EXEC_PROMPT_VERSION,
    outputSchemaVersion: CODEX_EXEC_OUTPUT_SCHEMA_VERSION,
    commandAvailable: false,
    version: null,
  };

  try {
    const commandCheck = await checkCommandAvailable({ runner, command, cwd, timeoutMs });
    result.commandAvailable = commandCheck.ok;
    result.version = commandCheck.version;

    if (live) {
      result.smoke = await runLiveSmoke({ runner, command, model, reasoningEffort, sandbox, cwd, timeoutMs });
    }

    result.ok = true;
    return result;
  } catch (error) {
    return {
      ...result,
      ok: false,
      error: {
        message: error.message,
        name: error.name,
      },
    };
  }
}

export function createCodexExecProvider(options = {}) {
  const runner = options.runner || runCodexExecCommand;
  const command = options.command || 'codex';
  const model = options.model || null;
  const reasoningEffort = options.reasoningEffort || null;
  const sandbox = options.sandbox || 'read-only';
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 120000;
  const maxInputChars = options.maxInputChars || 12000;

  const providerMetadata = {
    provider: 'codex_exec',
    promptVersion: CODEX_EXEC_PROMPT_VERSION,
    outputSchemaVersion: CODEX_EXEC_OUTPUT_SCHEMA_VERSION,
  };

  async function distillWithCodexExecProvider(input) {
    const startedAt = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-codex-exec-'));
    const schemaPath = path.join(tempDir, 'checkpoint.schema.json');
    const outputPath = path.join(tempDir, 'checkpoint.json');
    const prompt = buildCodexExecPrompt(input, { maxInputChars });

    await fs.writeFile(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`, 'utf8');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      sandbox,
      '--cd',
      cwd,
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
    ];
    if (model) {
      args.push('--model', model);
    }
    appendReasoningEffortConfig(args, reasoningEffort);
    args.push('-');

    try {
      const result = await runner({
        command,
        args,
        prompt: prompt.prompt,
        timeoutMs,
        cwd,
        env: process.env,
      });
      const outputText = (await readTextIfPresent(outputPath)) || result.stdout || '';
      const { output, jsonRecovery } = parseCodexExecJsonResult(outputText);

      return {
        ...output,
        provider: output.provider || 'codex_exec',
        sourceEventCount: output.sourceEventCount ?? (input.rawEvents || []).length,
        metadata: {
          ...(output.metadata || {}),
          codexExec: {
            ...providerMetadata,
            command,
            model,
            reasoningEffort,
            sandbox,
            timeoutMs,
            elapsedMs: Date.now() - startedAt,
            ...prompt.metadata,
            ...(jsonRecovery ? { jsonRecovery } : {}),
          },
        },
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  distillWithCodexExecProvider.metadata = providerMetadata;
  return distillWithCodexExecProvider;
}
