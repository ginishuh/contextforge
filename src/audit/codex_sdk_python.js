import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexExecJson } from '../distill/providers/codex_exec.js';
import { ProviderTimeoutError } from '../runtime/provider_execution.js';
import { registerRuntimeChild } from '../runtime/child_processes.js';
import {
  AUDIT_OUTPUT_SCHEMA,
  AUTO_PROMOTE_AUDIT_SCHEMA_VERSION,
  buildAuditPrompt,
} from './codex_exec.js';
import { assertExternalProviderAllowed } from '../testing/external_provider.js';

export const AUTO_PROMOTE_AUDIT_PYTHON_SDK_PROMPT_VERSION = 'auto_promote_audit.codex_sdk_python.v2';

const RUNNER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex_sdk_python_runner.py');
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const SANDBOX_PRESETS = new Set(['read-only', 'workspace-write', 'full-access']);
const KILL_GRACE_MS = 5000;

function validateReasoningEffort(reasoningEffort) {
  if (!reasoningEffort) return;
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      `Invalid auto-promote audit reasoning effort "${reasoningEffort}". Expected one of: minimal, low, medium, high.`,
    );
  }
}

function validateSandbox(sandbox) {
  if (!SANDBOX_PRESETS.has(sandbox)) {
    throw new Error(
      `Invalid Codex Python SDK audit sandbox "${sandbox}". Expected one of: read-only, workspace-write, full-access.`,
    );
  }
}

export function runCodexSdkPythonCommand({
  pythonCommand,
  pythonPath,
  scriptPath,
  codexBin,
  model,
  reasoningEffort,
  sandbox,
  prompt,
  timeoutMs,
  cwd,
  env = process.env,
  spawnImpl = spawn,
  killGraceMs = KILL_GRACE_MS,
}) {
  assertExternalProviderAllowed('codex_sdk_python_audit', { env, injected: spawnImpl !== spawn });
  return new Promise((resolve, reject) => {
    const args = [
      scriptPath || RUNNER_PATH,
      '--codex-bin',
      codexBin,
      '--model',
      model,
      '--sandbox',
      sandbox,
      '--cwd',
      cwd,
    ];
    if (reasoningEffort) {
      args.push('--reasoning-effort', reasoningEffort);
    }
    const childEnv = { ...env };
    if (pythonPath) {
      childEnv.PYTHONPATH = childEnv.PYTHONPATH ? `${pythonPath}${path.delimiter}${childEnv.PYTHONPATH}` : pythonPath;
    }

    const child = spawnImpl(pythonCommand, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const unregisterChild = registerRuntimeChild(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutError = null;
    let killTimer = null;
    function cleanup() {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      unregisterChild();
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timeoutError = new ProviderTimeoutError(
        'codex_sdk_python',
        timeoutMs,
        `Codex Python SDK audit timed out after ${timeoutMs}ms.`,
      );
      try {
        child.kill('SIGTERM');
      } catch {
        // The close/error event below remains the process lifecycle authority.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may already be gone.
        }
      }, killGraceMs);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      if (timedOut) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.stdin.on('error', (error) => {
      if (settled) return;
      if (timedOut) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(timeoutError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Codex Python SDK audit failed with exit code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(`${JSON.stringify({ prompt, requestedOutputSchema: AUDIT_OUTPUT_SCHEMA })}\n`);
  });
}

export function createCodexSdkPythonAutoPromoteAuditor(options = {}) {
  const runnerInjected = typeof options.runner === 'function';
  const runner = options.runner || runCodexSdkPythonCommand;
  const pythonCommand = options.pythonCommand || 'python3';
  const pythonPath = options.pythonPath || null;
  const scriptPath = options.scriptPath || RUNNER_PATH;
  const codexBin = options.codexBin || options.command || 'codex';
  const model = options.model || 'gpt-5.5';
  const reasoningEffort = options.reasoningEffort || 'low';
  const sandbox = options.sandbox || 'read-only';
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 120000;

  validateReasoningEffort(reasoningEffort);
  validateSandbox(sandbox);

  const metadata = {
    provider: 'codex_sdk_python',
    promptVersion: AUTO_PROMOTE_AUDIT_PYTHON_SDK_PROMPT_VERSION,
    outputSchemaVersion: AUTO_PROMOTE_AUDIT_SCHEMA_VERSION,
    pythonCommand,
    pythonPath,
    scriptPath,
    codexBin,
    model,
    reasoningEffort,
    sandbox,
    timeoutMs,
  };

  async function audit(input) {
    assertExternalProviderAllowed('codex_sdk_python_audit', { injected: runnerInjected });
    const startedAt = Date.now();
    const result = await runner({
      pythonCommand,
      pythonPath,
      scriptPath,
      codexBin,
      model,
      reasoningEffort,
      sandbox,
      prompt: buildAuditPrompt(input, metadata),
      timeoutMs,
      cwd,
      env: process.env,
    });
    const runnerOutput = parseCodexExecJson(result.stdout || '');
    if (typeof runnerOutput.final_response !== 'string' || runnerOutput.final_response.trim() === '') {
      return {
        approved: false,
        decision: 'needs_review',
        reason: 'Codex Python SDK audit returned an empty final_response.',
        riskCodes: ['empty_final_response'],
        metadata: {
          ...metadata,
          elapsedMs: Date.now() - startedAt,
          runnerElapsedMs: runnerOutput.elapsed_ms || null,
        },
      };
    }
    const output = parseCodexExecJson(runnerOutput.final_response);
    const approved = output.approved === true && output.decision === 'approve';
    return {
      approved,
      decision: output.decision || (approved ? 'approve' : 'needs_review'),
      reason: output.reason || '',
      riskCodes: Array.isArray(output.riskCodes) ? output.riskCodes : [],
      metadata: {
        ...metadata,
        elapsedMs: Date.now() - startedAt,
        runnerElapsedMs: runnerOutput.elapsed_ms || null,
      },
    };
  }

  audit.metadata = metadata;
  return audit;
}
