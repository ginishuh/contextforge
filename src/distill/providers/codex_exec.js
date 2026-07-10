import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertExternalProviderAllowed } from '../../testing/external_provider.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION } from '../validate.js';

export const CODEX_EXEC_PROMPT_VERSION = 'codex_exec.prompt.v9';
export const CODEX_EXEC_OUTPUT_SCHEMA_VERSION = 'contextforge.checkpoint.v6';

function nullableStringSchema() {
  return { type: ['string', 'null'] };
}

function nullableBooleanSchema() {
  return { type: ['boolean', 'null'] };
}

function stringArraySchema() {
  return { type: 'array', items: { type: 'string' } };
}

function strictObjectSchema(properties, { nullable = false } = {}) {
  return {
    type: nullable ? ['object', 'null'] : 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function strictObjectArraySchema(properties) {
  return {
    type: 'array',
    items: strictObjectSchema(properties),
  };
}

const STRUCTURED_OUTPUT_SCHEMA = strictObjectSchema(
  {
    schemaVersion: { type: 'string', enum: [STRUCTURED_CHECKPOINT_SCHEMA_VERSION] },
    work: strictObjectSchema(
      {
        intent: nullableStringSchema(),
        status: nullableStringSchema(),
        outcome: nullableStringSchema(),
      },
      { nullable: true },
    ),
    liveState: strictObjectSchema(
      {
        repo: nullableStringSchema(),
        branch: nullableStringSchema(),
        baseBranch: nullableStringSchema(),
        headCommit: nullableStringSchema(),
        prNumber: { type: ['integer', 'null'] },
        prUrl: nullableStringSchema(),
        ciStatus: nullableStringSchema(),
        worktreeStatus: nullableStringSchema(),
        runtimeStatus: nullableStringSchema(),
        deploymentStatus: nullableStringSchema(),
        observedAt: nullableStringSchema(),
        verifiedAt: nullableStringSchema(),
        verificationRequired: nullableBooleanSchema(),
        staleReasons: stringArraySchema(),
        verifyHints: stringArraySchema(),
      },
      { nullable: true },
    ),
    changes: strictObjectArraySchema({
      type: nullableStringSchema(),
      name: nullableStringSchema(),
      path: nullableStringSchema(),
      description: nullableStringSchema(),
    }),
    verification: strictObjectArraySchema({
      type: nullableStringSchema(),
      command: nullableStringSchema(),
      result: nullableStringSchema(),
      details: nullableStringSchema(),
      requiresLiveRecheck: nullableBooleanSchema(),
    }),
    risks: strictObjectArraySchema({
      risk: nullableStringSchema(),
      status: nullableStringSchema(),
      mitigation: nullableStringSchema(),
    }),
    nextActions: strictObjectArraySchema({
      action: nullableStringSchema(),
      priority: nullableStringSchema(),
      reason: nullableStringSchema(),
    }),
  },
  { nullable: true },
);

export const CHECKPOINT_OUTPUT_SCHEMA = {
  $id: CODEX_EXEC_OUTPUT_SCHEMA_VERSION,
  type: 'object',
  additionalProperties: false,
  required: [
    'summaryShort',
    'summaryText',
    'workingSummary',
    'sessionWorkingContext',
    'decisions',
    'todos',
    'openQuestions',
    'memoryCandidates',
    'structured',
    'sourceEventCount',
    'provider',
    'metadata',
  ],
  properties: {
    summaryShort: { type: 'string', minLength: 1 },
    summaryText: { type: 'string', minLength: 1 },
    workingSummary: { type: 'string', minLength: 1 },
    sessionWorkingContext: {
      type: 'object',
      additionalProperties: false,
      required: [
        'mode',
        'currentTask',
        'currentUserIntent',
        'targetSubject',
        'sourceSubject',
        'lastUserCorrection',
        'openQuestion',
        'nonGoals',
        'avoidMisreadings',
        'confidence',
      ],
      properties: {
        mode: { type: 'string' },
        currentTask: { type: 'string' },
        currentUserIntent: { type: 'string' },
        targetSubject: { type: ['string', 'null'] },
        sourceSubject: { type: ['string', 'null'] },
        lastUserCorrection: { type: ['string', 'null'] },
        openQuestion: { type: ['string', 'null'] },
        nonGoals: { type: 'array', items: { type: 'string' } },
        avoidMisreadings: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
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
          'schemaVersion',
          'durabilityReason',
          'riskReason',
          'evidenceRefs',
          'suggestedAction',
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
          schemaVersion: { type: ['string', 'null'] },
          durabilityReason: { type: ['string', 'null'] },
          riskReason: { type: ['string', 'null'] },
          evidenceRefs: { type: ['array', 'null'], items: { type: 'string' } },
          suggestedAction: { type: ['string', 'null'], enum: ['promote', 'review', 'reject', 'skip', null] },
        },
      },
    },
    structured: STRUCTURED_OUTPUT_SCHEMA,
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
    structured: checkpoint.structured || checkpoint.metadata?.structured || null,
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

function compactSessionWorkingContext(context) {
  if (!context) return null;
  return {
    id: context.id,
    mode: context.mode,
    currentTask: context.currentTask,
    currentUserIntent: context.currentUserIntent,
    targetSubject: context.targetSubject,
    sourceSubject: context.sourceSubject,
    lastUserCorrection: context.lastUserCorrection,
    openQuestion: context.openQuestion,
    nonGoals: context.nonGoals,
    avoidMisreadings: context.avoidMisreadings,
    confidence: context.confidence,
    sourceCheckpointId: context.sourceCheckpointId,
    updatedAt: context.updatedAt,
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

function buildSourceCheckpointPayload(sourceCheckpoints, maxInputChars) {
  const checkpoints = [];
  let remaining = maxInputChars;
  let truncated = false;

  for (const checkpoint of sourceCheckpoints || []) {
    const base = {
      id: checkpoint.id,
      sessionId: checkpoint.sessionId,
      conversationId: checkpoint.conversationId,
      createdAt: checkpoint.createdAt,
      coversFrom: checkpoint.coversFrom,
      coversTo: checkpoint.coversTo,
      source: checkpoint.source,
      sourceRef: checkpoint.sourceRef,
      sourceProvenance: checkpoint.sourceProvenance || null,
    };
    const text = [
      checkpoint.summaryShort ? `summary: ${checkpoint.summaryShort}` : '',
      checkpoint.summaryText ? `details: ${checkpoint.summaryText}` : '',
      checkpoint.decisions?.length ? `decisions:\n${checkpoint.decisions.join('\n')}` : '',
      checkpoint.todos?.length ? `todos:\n${checkpoint.todos.join('\n')}` : '',
      checkpoint.openQuestions?.length ? `open questions:\n${checkpoint.openQuestions.join('\n')}` : '',
      checkpoint.structured ? `structured:\n${JSON.stringify(checkpoint.structured)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (remaining <= 0) {
      truncated = true;
      checkpoints.push({ ...base, content: '[omitted: context budget exhausted]', truncated: true });
      continue;
    }
    const content = truncateText(text, remaining);
    remaining -= content.text.length;
    truncated = truncated || content.truncated;
    checkpoints.push({ ...base, content: content.text, truncated: content.truncated });
  }

  return { checkpoints, truncated };
}

export function buildCodexExecPrompt(input, options = {}) {
  const maxInputChars = options.maxInputChars || 12000;
  const isConsolidation = Boolean(input.consolidation);
  const rawPayload = buildRawEventPayload(isConsolidation ? [] : input.rawEvents || [], maxInputChars);
  const sourceCheckpointPayload = buildSourceCheckpointPayload(
    isConsolidation ? input.sourceCheckpoints || [] : [],
    maxInputChars,
  );
  const payload = {
    task: isConsolidation
      ? 'Consolidate ContextForge checkpoints into one period checkpoint.'
      : 'Distill coding-agent raw events into one ContextForge checkpoint.',
    rules: [
      'Return only JSON that matches the requested schema.',
      'Do not include Markdown, code fences, commentary, or private assumptions.',
      'Preserve uncertainty in openQuestions instead of inventing facts.',
      isConsolidation
        ? 'Use only the sourceCheckpoints and consolidation window supplied in this request.'
        : 'Use only the conversation events and previous checkpoint supplied in this request.',
      'rawEvents contains distillation-ready user/assistant conversation evidence only; it is not a native transcript clone.',
      'sourceCheckpoints contains already-distilled ContextForge checkpoints; it is compressed handoff evidence, not durable truth.',
      'Tool call and tool result payloads are not included by default. Tool output is evidence, not conversation memory.',
      'When tool verification matters, summarize the assistant-interpreted conclusion instead of copying raw command output.',
      'Write the checkpoint as recent continuity for handoff and search, not as canonical durable truth.',
      'For consolidation, preserve period context across the source checkpoints so future agents do not see only a thin latest slice.',
      'For consolidation, keep live/runtime state explicitly verification-required and do not present it as current without verify hints.',
      `When evidence supports it, populate structured with schemaVersion="${STRUCTURED_CHECKPOINT_SCHEMA_VERSION}" as a structured handoff object for the next agent.`,
      'Return structured=null when the supplied evidence does not support a useful structured handoff.',
      'Use structured.work for user intent, current status, and actual outcome.',
      'Use structured.liveState only for observed mutable live state such as repo, branch, baseBranch, headCommit, PR, CI, worktree, runtime, or deployment state. Do not invent liveState values absent from evidence.',
      'For structured.liveState, include observedAt when known, verificationRequired=true for mutable fields, staleReasons explaining why it may drift, and verifyHints with concrete commands or API calls a future agent should run.',
      'Use structured.changes, structured.verification, structured.risks, and structured.nextActions to preserve actionable handoff state. Mark mutable verification with requiresLiveRecheck when appropriate.',
      'Write workingSummary as the latest rolling session state for immediate continuation: current goal, completed work, active blockers, and next actions.',
      'If previousWorkingSummary is supplied, update it with the new raw events instead of replacing it with a delta-only summary.',
      'Always write sessionWorkingContext as structured mutable resume state. Use mode="task_execution", empty strings, nulls, empty arrays, and confidence=0 when there is no useful current framing.',
      'Do not make workingSummary a durable fact; it is live handoff state and may be overwritten by later distills.',
      'Do not make sessionWorkingContext a durable fact; it is mutable task framing for resume handoff.',
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
      'For memoryCandidates, include optional v2 fields when useful: schemaVersion="contextforge.memory_candidate.v2", durabilityReason, riskReason, evidenceRefs, and suggestedAction.',
      'For nullable memoryCandidate fields that are not applicable, return null; do not omit required schema fields.',
      'Create memoryCandidates only for facts, decisions, preferences, runbook steps, or failure modes that may remain useful beyond this checkpoint.',
      'For consolidation, create at most 3 memoryCandidates, and only when the same durable decision, runbook, or recurring failure mode is reinforced across source checkpoints.',
      'Do not create memoryCandidates for one-time PR status updates, ordinary test pass records, review comments posted, temporary smoke-test ports, draft CI state, branch cleanup, or other transient work logs unless they reveal a reusable repo runbook, stable preference, architecture decision, API contract, or recurring failure mode.',
      'Do not set promotionRecommendation="promote" for PR-specific findings, review comments, or verification snapshots until they have been resolved or generalized into durable guidance.',
      'Write human-readable memoryCandidate review fields in Korean by default: content, reason, durabilityReason, and riskReason.',
      'Do not mix English prose into those Korean memoryCandidate review fields unless preserving exact technical identifiers, code symbols, file paths, commands, model names, API names, product names, or quoted error strings.',
      'Keep memoryCandidate keys, categories, tags, enum values, sourceEventIds, evidenceRefs, and schemaVersion machine-readable and in their original technical form.',
      'For memoryCandidate content, include decision plus rationale when both exist; put future-search keywords in tags and reason instead of flattening them away.',
      'Set promotionRecommendation to promote only for stable, reviewed-looking durable facts; otherwise prefer review, ignore, or reject.',
      'Use low confidence or low stability for guesses, temporary state, implementation-in-progress details, and facts that require current runtime verification.',
      'Use sensitivity high or restricted for any candidate that might contain secrets, personal data, customer data, private runtime paths, or credentials, and do not recommend promotion for it.',
    ],
    session: input.session,
    consolidation: input.consolidation || null,
    requestedOutputSchema: input.requestedOutputSchema,
    previousCheckpoint: compactCheckpoint(input.previousCheckpoint),
    previousWorkingSummary: compactWorkingSummary(input.previousWorkingSummary),
    previousSessionWorkingContext: compactSessionWorkingContext(input.previousSessionWorkingContext),
    rawEvents: rawPayload.events,
    sourceCheckpoints: sourceCheckpointPayload.checkpoints,
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
      sourceCheckpointCount: sourceCheckpointPayload.checkpoints.length,
      inputTruncated: rawPayload.truncated || sourceCheckpointPayload.truncated,
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
  assertExternalProviderAllowed('codex_exec', { env });
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
  const runnerInjected = typeof options.runner === 'function';
  assertExternalProviderAllowed('codex_exec', { injected: runnerInjected });
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
    assertExternalProviderAllowed('codex_exec', { injected: runnerInjected });
    const startedAt = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-codex-exec-'));
    const schemaPath = path.join(tempDir, 'checkpoint.schema.json');
    const outputPath = path.join(tempDir, 'checkpoint.json');
    const prompt = buildCodexExecPrompt(input, { maxInputChars });

    await fs.writeFile(schemaPath, `${JSON.stringify(CHECKPOINT_OUTPUT_SCHEMA, null, 2)}\n`, 'utf8');

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
        sourceEventCount: output.sourceEventCount ?? (input.sourceCheckpoints || input.rawEvents || []).length,
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
