import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCodexExecJson, runCodexExecCommand } from '../distill/providers/codex_exec.js';

export const AUTO_PROMOTE_AUDIT_PROMPT_VERSION = 'auto_promote_audit.codex_exec.v3';
export const AUTO_PROMOTE_AUDIT_SCHEMA_VERSION = 'contextforge.auto_promote_audit.v1';

export const AUDIT_OUTPUT_SCHEMA = {
  $id: AUTO_PROMOTE_AUDIT_SCHEMA_VERSION,
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'decision', 'reason', 'riskCodes'],
  properties: {
    approved: { type: 'boolean' },
    decision: { type: 'string', enum: ['approve', 'reject', 'needs_review'] },
    reason: { type: 'string' },
    riskCodes: { type: 'array', items: { type: 'string' } },
  },
};

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

function appendReasoningEffortConfig(args, reasoningEffort) {
  if (!reasoningEffort) return;
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      `Invalid auto-promote audit reasoning effort "${reasoningEffort}". Expected one of: minimal, low, medium, high.`,
    );
  }
  args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
}

function truncate(value, maxChars = 2000) {
  const text = String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

export function buildAuditPrompt(input, metadata) {
  const candidate = input.candidate?.candidate || {};
  const payload = {
    task: 'Audit whether one ContextForge memory candidate is safe for automatic durable-memory promotion.',
    rules: [
      'Return exactly one JSON object and no surrounding text.',
      'Approve only if the candidate is a repository-wide development rule, API/architecture contract, recurring failure mode, or runbook step that future agents must remember to work correctly.',
      'Reject one-off project events such as PR status, CI/test pass snapshots, review comments posted, branch cleanup, version bumps, release notes, or temporary smoke-test details.',
      'Reject facts tied to one machine, one deployment environment, one local path, one port, one service restart, or other environment-specific runtime state.',
      'Reject if it contains secrets, personal data, credentials, broad guesses, temporary state, user preferences, or unsupported claims.',
      'Use needs_review when the candidate might be useful but needs a human edit, narrower wording, or live verification.',
      'Do not approve merely because promotionRecommendation is promote or confidence is high.',
      'Treat this as an audit gate before automatic promotion; be conservative.',
      'Write the human-readable reason in Korean by default.',
      'Keep riskCodes as short machine-readable English tokens, and preserve exact technical identifiers, commands, paths, API names, model names, and quoted error strings.',
    ],
    requestedOutputSchema: AUDIT_OUTPUT_SCHEMA,
    auditProvider: metadata,
    scope: {
      scopeType: input.candidate?.scopeType || null,
      scopeKey: input.candidate?.scopeKey || null,
    },
    source: {
      sessionId: input.candidate?.sessionId || null,
      checkpointId: input.candidate?.checkpointId || null,
      checkpointSummaryShort: truncate(input.checkpoint?.summaryShort, 800),
      checkpointSummaryText: truncate(input.checkpoint?.summaryText, 3000),
    },
    localWarnings: input.warnings || [],
    candidate: {
      key: candidate.key,
      content: truncate(candidate.content, 3000),
      reason: truncate(candidate.reason, 1200),
      category: candidate.category,
      tags: candidate.tags || [],
      importance: candidate.importance,
      candidateType: candidate.candidateType,
      confidence: candidate.confidence,
      stability: candidate.stability,
      sensitivity: candidate.sensitivity,
      promotionRecommendation: candidate.promotionRecommendation,
      sourceEventIds: candidate.sourceEventIds || [],
    },
  };

  return [
    'You are the ContextForge automatic memory promotion auditor.',
    'Audit the supplied candidate for automatic promotion.',
    'Return exactly one JSON object and no surrounding text.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

export function createCodexExecAutoPromoteAuditor(options = {}) {
  const runner = options.runner || runCodexExecCommand;
  const command = options.command || 'codex';
  const model = options.model || 'gpt-5.5';
  const reasoningEffort = options.reasoningEffort || 'low';
  const sandbox = options.sandbox || 'read-only';
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 120000;

  const metadata = {
    provider: 'codex_exec',
    promptVersion: AUTO_PROMOTE_AUDIT_PROMPT_VERSION,
    outputSchemaVersion: AUTO_PROMOTE_AUDIT_SCHEMA_VERSION,
    command,
    model,
    reasoningEffort,
    sandbox,
    timeoutMs,
  };

  async function audit(input) {
    const startedAt = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-auto-promote-audit-'));
    const schemaPath = path.join(tempDir, 'audit.schema.json');
    const outputPath = path.join(tempDir, 'audit.json');
    try {
      await fs.writeFile(schemaPath, `${JSON.stringify(AUDIT_OUTPUT_SCHEMA, null, 2)}\n`, 'utf8');
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

      const result = await runner({
        command,
        args,
        prompt: buildAuditPrompt(input, metadata),
        timeoutMs,
        cwd,
        env: process.env,
      });
      const outputText = (await fs.readFile(outputPath, 'utf8').catch(() => '')) || result.stdout || '';
      const output = parseCodexExecJson(outputText);
      const approved = output.approved === true && output.decision === 'approve';
      return {
        approved,
        decision: output.decision || (approved ? 'approve' : 'needs_review'),
        reason: output.reason || '',
        riskCodes: Array.isArray(output.riskCodes) ? output.riskCodes : [],
        metadata: {
          ...metadata,
          elapsedMs: Date.now() - startedAt,
        },
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  audit.metadata = metadata;
  return audit;
}
