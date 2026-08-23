import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { collectSchemaKeywordPaths, collectStrictObjectSchemaViolations } from './helpers/schema.js';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { OPENAI_COMPATIBLE_CHECKPOINT_OUTPUT_SCHEMA } from '../src/distill/providers/openai_compatible.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION } from '../src/distill/validate.js';
import Database from 'better-sqlite3';

test('codex_exec provider distills synthetic raw events through a runner', async () => {
  const dataDir = await makeTempDir();
  let invocation;
  let schema;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-fake',
      CONTEXTFORGE_CODEX_EXEC_MODEL: 'gpt-test',
      CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT: 'low',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1234',
      CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS: '5000',
    },
    cwd: process.cwd(),
    codexExecRunner: async (args) => {
      invocation = args;
      const schemaPath = args.args[args.args.indexOf('--output-schema') + 1];
      schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
      return {
        stdout: JSON.stringify({
          summaryShort: 'Codex checkpoint for synthetic events.',
          summaryText: 'The user decided to test the codex_exec provider path.',
          workingSummary: 'Current state: codex_exec provider path is under synthetic test.',
          decisions: ['Use codex_exec behind the provider contract.'],
          todos: ['Document setup expectations.'],
          openQuestions: [],
          memoryCandidates: [
            {
              schemaVersion: 'contextforge.memory_candidate.v2',
              key: 'provider',
              content: 'codex_exec is available.',
              reason: 'Synthetic provider output.',
              category: 'note',
              tags: [],
              importance: 1,
              candidateType: null,
              confidence: 0.9,
              stability: 0.9,
              sensitivity: null,
              promotionRecommendation: 'promote',
              sourceEventIds: [],
              durabilityReason: 'Provider contract details can guide future distill debugging.',
              riskReason: 'This is synthetic test evidence, not an operational incident.',
              evidenceRefs: ['test:codex_exec provider distills synthetic raw events through a runner'],
              suggestedAction: 'promote',
            },
          ],
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            work: {
              intent: 'Test the codex_exec provider path.',
              status: 'verified',
              outcome: 'Synthetic distill completed.',
            },
            liveState: {
              repo: 'github.com/ginishuh/contextforge',
              branch: 'feature/structured-checkpoints',
              headCommit: 'synthetic',
              observedAt: '2026-06-03T00:00:00Z',
              verificationRequired: true,
              staleReasons: ['branch and headCommit are mutable live state'],
              verifyHints: ['git status --short --branch', 'git rev-parse HEAD'],
            },
            changes: [
              {
                type: 'provider',
                name: 'codex_exec',
                description: 'Synthetic provider schema accepted structured output.',
              },
            ],
            verification: [
              {
                type: 'smoke',
                result: 'pass',
                details: 'Synthetic runner returned valid checkpoint JSON.',
              },
            ],
            risks: [],
            nextActions: [],
          },
          sourceEventCount: 1,
          metadata: {
            providerNotes: 'synthetic provider output',
            retrievalHooks: ['codex_exec', 'provider contract', 'synthetic raw events'],
          },
        }),
      };
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
    role: 'user',
    content: 'Decision: test codex_exec with synthetic raw events.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
  });

  assert.equal(checkpoint.provider, 'codex_exec');
  assert.equal(checkpoint.sourceEventCount, 1);
  assert.equal(checkpoint.metadata.providerMetadata.providerNotes, 'synthetic provider output');
  assert.deepEqual(checkpoint.metadata.providerMetadata.retrievalHooks, [
    'codex_exec',
    'provider contract',
    'synthetic raw events',
  ]);
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.command, 'codex-fake');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.model, 'gpt-test');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.reasoningEffort, 'low');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.timeoutMs, 1234);
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.promptVersion, 'codex_exec.prompt.v9');
  assert.equal(checkpoint.metadata.providerMetadata.codexExec.outputSchemaVersion, 'contextforge.checkpoint.v6');
  assert.equal(checkpoint.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(checkpoint.metadata.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(checkpoint.metadata.providerMetadata.structured, undefined);
  assert.match(invocation.prompt, /Return exactly one JSON object/);
  const promptPayload = JSON.parse(invocation.prompt.slice(invocation.prompt.indexOf('{')));
  assert.equal(promptPayload.requestedOutputSchema.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.match(invocation.prompt, /structured\.liveState/);
  assert.match(invocation.prompt, /human-readable memoryCandidate review fields in Korean/);
  assert.match(invocation.prompt, /content, reason, durabilityReason, and riskReason/);
  assert.match(invocation.prompt, /one-time PR status updates/);
  assert.match(invocation.prompt, /review comments posted/);
  assert.deepEqual(invocation.args.slice(0, 2), ['exec', '--skip-git-repo-check']);
  assert.ok(invocation.args.includes('--output-schema'));
  assert.ok(invocation.args.includes('--output-last-message'));
  assert.ok(invocation.args.includes('-c'));
  assert.ok(invocation.args.includes('model_reasoning_effort="low"'));
  assert.equal(invocation.timeoutMs, 1234);
  assert.equal(schema.required.includes('structured'), true);
  assert.ok(schema.properties.structured);
  assert.deepEqual(schema.properties.structured.type, ['object', 'null']);
  assert.equal(schema.properties.structured.additionalProperties, false);
  assert.deepEqual(schema.properties.structured.required, [
    'schemaVersion',
    'work',
    'liveState',
    'changes',
    'verification',
    'risks',
    'nextActions',
  ]);
  assert.deepEqual(schema.properties.structured.properties.schemaVersion.enum, [STRUCTURED_CHECKPOINT_SCHEMA_VERSION]);
  assert.equal(schema.properties.structured.properties.liveState.additionalProperties, false);
  assert.ok(schema.properties.structured.properties.liveState.required.includes('verifyHints'));
  const candidateSchema = schema.properties.memoryCandidates.items;
  assert.equal(candidateSchema.required.includes('schemaVersion'), true);
  assert.ok(candidateSchema.properties.durabilityReason);
  assert.ok(candidateSchema.properties.riskReason);
  assert.deepEqual(candidateSchema.properties.evidenceRefs.type, ['array', 'null']);
  assert.ok(candidateSchema.properties.suggestedAction);
  assert.ok(schema.properties.sessionWorkingContext);
  assert.deepEqual(
    schema.properties.sessionWorkingContext.required,
    Object.keys(schema.properties.sessionWorkingContext.properties),
  );
  assert.deepEqual(schema.properties.metadata.required, ['providerNotes', 'retrievalHooks']);
  const indexedCandidate = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-codex',
    checkpointId: checkpoint.id,
  })[0];
  assert.equal(indexedCandidate.candidate.schemaVersion, 'contextforge.memory_candidate.v2');
  assert.equal(indexedCandidate.candidate.durabilityReason, 'Provider contract details can guide future distill debugging.');
  assert.equal(indexedCandidate.candidate.riskReason, 'This is synthetic test evidence, not an operational incident.');
  assert.deepEqual(indexedCandidate.candidate.evidenceRefs, [
    'test:codex_exec provider distills synthetic raw events through a runner',
  ]);
  assert.equal(indexedCandidate.candidate.suggestedAction, 'promote');
  const suggestions = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'repo-codex',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(suggestions.proposals[0].whyDurable, 'Provider contract details can guide future distill debugging.');
  assert.equal(suggestions.proposals[0].riskReason, 'This is synthetic test evidence, not an operational incident.');
  assert.equal(suggestions.proposals[0].recommendedAction, 'ask_user');
  assert.equal(suggestions.proposals[0].providerSuggestedAction, 'promote');
  assert.deepEqual(suggestions.proposals[0].evidence.evidenceRefs, [
    'test:codex_exec provider distills synthetic raw events through a runner',
  ]);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-codex',
    sessionId: 'codex-session',
  });
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].inputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v9');
  assert.equal(runs[0].inputMetadata.providerMetadata.outputSchemaVersion, 'contextforge.checkpoint.v6');
  assert.equal(runs[0].outputMetadata.providerMetadata.codexExec.promptVersion, 'codex_exec.prompt.v9');
});

test('codex_exec records JSON brace fallback recovery metadata', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => ({
      stdout: `prefix ${JSON.stringify({
        summaryShort: 'Recovered checkpoint.',
        summaryText: 'The provider output needed brace fallback recovery.',
        workingSummary: 'Current state: brace fallback recovery succeeded.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        provider: 'codex_exec',
        metadata: { providerNotes: 'synthetic recovery', retrievalHooks: ['brace fallback', 'codex_exec JSON'] },
      })} suffix`,
    }),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-json-recovery',
    sessionId: 'json-recovery-session',
    role: 'assistant',
    content: 'Provider output may include recoverable surrounding text.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-json-recovery',
    sessionId: 'json-recovery-session',
  });

  assert.equal(checkpoint.metadata.providerMetadata.codexExec.jsonRecovery, 'brace-fallback');
});

test('codex_exec doctor reports dry and live smoke readiness through a runner', async () => {
  const dataDir = await makeTempDir();
  const invocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-fake',
      CONTEXTFORGE_CODEX_EXEC_MODEL: 'gpt-test',
      CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT: 'low',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1234',
    },
    cwd: process.cwd(),
    codexExecRunner: async (args) => {
      invocations.push(args);
      if (args.args.includes('--version')) {
        return { stdout: 'codex-fake 1.2.3\n' };
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          provider: 'codex_exec',
          message: 'codex_exec smoke ok',
        }),
      };
    },
  });

  const dry = await app.checkCodexExec();
  assert.equal(dry.ok, true);
  assert.equal(dry.commandAvailable, true);
  assert.equal(dry.version, 'codex-fake 1.2.3');
  assert.equal(dry.live, false);
  assert.equal(dry.command, 'codex-fake');
  assert.equal(dry.model, 'gpt-test');
  assert.equal(dry.reasoningEffort, 'low');
  assert.equal(invocations.length, 1);

  const live = await app.checkCodexExec({ live: true });
  assert.equal(live.ok, true);
  assert.equal(live.live, true);
  assert.equal(live.smoke.output.provider, 'codex_exec');
  assert.ok(invocations[1].args.includes('--version'));
  assert.ok(invocations[2].args.includes('--output-schema'));
  assert.ok(invocations[2].args.includes('model_reasoning_effort="low"'));
  assert.equal(invocations[2].timeoutMs, 1234);
});

test('runtime settings are DB-backed, redacted, and hot-apply to session status', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
      CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS: '600000',
      CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS: 'true',
    },
    cwd: process.cwd(),
  });

  const updated = app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_object',
      },
      distillPolicy: {
        minEvents: 1,
        minIntervalMs: 1,
        charMinIntervalMs: 1,
        charThreshold: 1,
        maxEvents: 10,
        maxChars: 2000,
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });

  assert.equal(updated.effective.distillProvider, 'openai_compatible');
  assert.equal(updated.effective.openAiCompatible.model, 'deepseek-v4-flash');
  assert.equal(updated.effective.openAiCompatible.secretPresent, true);
  assert.equal(updated.effective.openAiCompatible.apiKey, undefined);
  assert.equal(updated.stored['openAiCompatible.apiKey'].value, null);
  assert.equal(updated.stored['openAiCompatible.apiKey'].secretPresent, true);
  assert.ok(updated.warnings.some((warning) => warning.code === 'plaintext_runtime_secret_stored'));
  assert.throws(
    () =>
      app.updateRuntimeSettings({
        values: {
          openAiCompatible: {
            apiKey: 'not-through-values',
          },
        },
      }),
    /write-only secrets channel/,
  );
  const cleared = app.updateRuntimeSettings({
    clearSecrets: ['openAiCompatibleApiKey'],
  });
  assert.equal(cleared.effective.openAiCompatible.secretPresent, false);
  assert.equal(cleared.effective.openAiCompatible.apiKey, undefined);
  assert.equal(cleared.stored['openAiCompatible.apiKey'], undefined);
  assert.deepEqual(cleared.warnings, []);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'settings-repo',
    sessionId: 'settings-session',
    role: 'user',
    content: 'Enough content to cross the UI-managed char threshold.',
  });
  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'settings-repo',
    sessionId: 'settings-session',
  });
  assert.equal(status.thresholds.minIntervalMs, 1);
  assert.equal(status.thresholds.charThreshold, 1);
  assert.equal(status.shouldDistill, true);
});

test('runtime secrets require plaintext opt-in and prefer environment references', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY: 'env-only-secret',
    },
    cwd: process.cwd(),
  });

  const settings = app.getRuntimeSettings();
  assert.equal(settings.effective.openAiCompatible.secretPresent, true);
  assert.deepEqual(settings.stored, {});
  assert.deepEqual(settings.warnings, []);

  assert.throws(
    () =>
      app.updateRuntimeSettings({
        secrets: { openAiCompatibleApiKey: 'must-not-be-stored' },
      }),
    (error) => {
      assert.equal(error.code, 'CONTEXTFORGE_PLAINTEXT_RUNTIME_SECRET_OPT_IN_REQUIRED');
      assert.match(error.message, /CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY/);
      assert.match(error.message, /CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS=true/);
      return true;
    },
  );

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_settings WHERE secret = 1').get().count, 0);
  db.close();
  app.close();
});

test('codex_exec prompt preserves previous structured checkpoint handoff', async () => {
  const dataDir = await makeTempDir();
  const invocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-fake',
    },
    cwd: process.cwd(),
    codexExecRunner: async (args) => {
      invocations.push(args);
      const pass = invocations.length;
      return {
        stdout: JSON.stringify({
          summaryShort: `Structured checkpoint pass ${pass}.`,
          summaryText: `Structured checkpoint detail pass ${pass}.`,
          workingSummary: `Working summary pass ${pass}.`,
          sessionWorkingContext: {
            mode: 'task_execution',
            currentTask: 'Preserve previous structured checkpoint.',
            currentUserIntent: 'Verify structured handoff continuity.',
            targetSubject: null,
            sourceSubject: null,
            lastUserCorrection: null,
            openQuestion: null,
            nonGoals: [],
            avoidMisreadings: [],
            confidence: 0.9,
          },
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            work: {
              intent: `Structured handoff pass ${pass}.`,
              status: pass === 1 ? 'in_progress' : 'verified',
              outcome: `Pass ${pass} stored structured handoff.`,
            },
            liveState: {
              branch: `feature/pass-${pass}`,
              observedAt: '2026-06-03T00:00:00Z',
              verificationRequired: true,
              staleReasons: ['branch is mutable'],
              verifyHints: ['git status --short --branch'],
            },
            changes: [],
            verification: [],
            risks: [],
            nextActions: [],
          },
          sourceEventCount: 1,
          provider: 'codex_exec',
          metadata: {
            providerNotes: 'synthetic structured continuity',
            retrievalHooks: ['structured checkpoint continuity'],
          },
        }),
      };
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
    role: 'assistant',
    content: 'First structured checkpoint event.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
    role: 'assistant',
    content: 'Second structured checkpoint event.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-structured-previous',
    sessionId: 'structured-previous-session',
  });

  const secondPromptPayload = JSON.parse(invocations[1].prompt.slice(invocations[1].prompt.indexOf('{')));
  assert.equal(secondPromptPayload.previousCheckpoint.id, first.id);
  assert.equal(secondPromptPayload.previousCheckpoint.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(secondPromptPayload.previousCheckpoint.structured.work.status, 'in_progress');
});

test('openai_compatible provider distills through a fake DeepSeek-style chat completions endpoint', async () => {
  const dataDir = await makeTempDir();
  let requestBody;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
      CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS: 'true',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, request) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer deepseek-secret');
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summaryShort: 'OpenAI-compatible checkpoint.',
                    summaryText: 'The DeepSeek-style provider returned valid JSON.',
                    workingSummary: 'Current state: openai_compatible provider is under test.',
                    sessionWorkingContext: {
                      mode: 'task_execution',
                      currentTask: 'Test provider',
                      currentUserIntent: 'Verify DeepSeek-style distill',
                      targetSubject: null,
                      sourceSubject: null,
                      lastUserCorrection: null,
                      openQuestion: null,
                      nonGoals: [],
                      avoidMisreadings: [],
                      confidence: 0.9,
                    },
                    decisions: ['Use OpenAI-compatible Chat Completions for DeepSeek.'],
                    todos: [],
                    openQuestions: [],
                    memoryCandidates: [],
                    sourceEventCount: 1,
                    provider: 'openai_compatible',
                    metadata: {
                      providerNotes: 'synthetic openai-compatible output',
                      retrievalHooks: ['deepseek-v4-flash', 'openai_compatible'],
                    },
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20,
            },
          }),
      };
    },
  });

  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'manual-model',
        responseFormat: 'json_object',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'openai-compatible-repo',
    sessionId: 'openai-compatible-session',
    role: 'user',
    content: 'Decision: test DeepSeek-compatible distillation.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'openai-compatible-repo',
    sessionId: 'openai-compatible-session',
  });

  assert.equal(requestBody.model, 'manual-model');
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.equal(requestBody.thinking, undefined);
  assert.equal(checkpoint.provider, 'openai_compatible');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.baseUrlHost, 'api.deepseek.com');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.model, 'manual-model');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.usage.total_tokens, 20);
});

test('openai_compatible json_schema mode sends a strict-safe checkpoint schema', async () => {
  const dataDir = await makeTempDir();
  let requestBody;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS: 'true',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, request) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summaryShort: 'Strict schema checkpoint.',
                    summaryText: 'The json_schema response returned valid checkpoint JSON.',
                    workingSummary: 'Strict schema mode is under test.',
                    sessionWorkingContext: {
                      mode: 'task_execution',
                      currentTask: 'Test strict schema',
                      currentUserIntent: 'Verify OpenAI-compatible json_schema payload',
                      targetSubject: null,
                      sourceSubject: null,
                      lastUserCorrection: null,
                      openQuestion: null,
                      nonGoals: [],
                      avoidMisreadings: [],
                      confidence: 0.8,
                    },
                    decisions: [],
                    todos: [],
                    openQuestions: [],
                    memoryCandidates: [],
                    structured: null,
                    sourceEventCount: 1,
                    provider: 'openai_compatible',
                    metadata: {
                      providerNotes: 'strict schema synthetic output',
                      retrievalHooks: ['json_schema'],
                    },
                  }),
                },
              },
            ],
          }),
      };
    },
  });
  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_schema',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'strict-openai-compatible-repo',
    sessionId: 'strict-openai-compatible-session',
    role: 'user',
    content: 'Strict json_schema mode should use a compatible schema subset.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'strict-openai-compatible-repo',
    sessionId: 'strict-openai-compatible-session',
  });

  assert.equal(requestBody.response_format.type, 'json_schema');
  assert.equal(requestBody.response_format.json_schema.strict, true);
  assert.deepEqual(requestBody.response_format.json_schema.schema, OPENAI_COMPATIBLE_CHECKPOINT_OUTPUT_SCHEMA);
  assert.deepEqual(
    collectSchemaKeywordPaths(
      requestBody.response_format.json_schema.schema,
      new Set(['$id', 'minLength', 'minimum', 'maximum']),
    ),
    [],
  );
  assert.deepEqual(
    requestBody.response_format.json_schema.schema.properties.structured.properties.changes.items.properties
      .description.type,
    ['string', 'null'],
  );
  assert.deepEqual(collectStrictObjectSchemaViolations(requestBody.response_format.json_schema.schema), []);
  assert.equal(checkpoint.provider, 'openai_compatible');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.responseFormat, 'json_schema');
});

test('openai_compatible provider repairs invalid JSON output and records retry metadata', async () => {
  const dataDir = await makeTempDir();
  const requests = [];
  const validOutput = {
    summaryShort: 'Repaired OpenAI-compatible checkpoint.',
    summaryText: 'The repair retry returned the complete checkpoint schema.',
    workingSummary: 'Current state: repair retry is under test.',
    sessionWorkingContext: {
      mode: 'task_execution',
      currentTask: 'Test repair retry',
      currentUserIntent: 'Verify OpenAI-compatible repair validation',
      targetSubject: null,
      sourceSubject: null,
      lastUserCorrection: null,
      openQuestion: null,
      nonGoals: [],
      avoidMisreadings: [],
      confidence: 0.88,
    },
    decisions: ['Re-validate repaired provider output before accepting it.'],
    todos: [],
    openQuestions: [],
    memoryCandidates: [],
    sourceEventCount: 1,
    provider: 'openai_compatible',
    metadata: {
      retrievalHooks: ['repair-retry'],
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS: 'true',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, request) => {
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    requests.length === 1
                      ? '{"summaryShort":"missing required fields"}'
                      : JSON.stringify(validOutput),
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 10,
              total_tokens: 30,
            },
          }),
      };
    },
  });
  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_object',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repair-openai-compatible-repo',
    sessionId: 'repair-openai-compatible-session',
    role: 'user',
    content: 'Provider should repair an incomplete checkpoint.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repair-openai-compatible-repo',
    sessionId: 'repair-openai-compatible-session',
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].thinking.type, 'disabled');
  assert.match(requests[1].messages.at(-1).content, /failed validation/);
  assert.equal(checkpoint.summaryShort, 'Repaired OpenAI-compatible checkpoint.');
  assert.equal(checkpoint.metadata.providerMetadata.openAiCompatible.retryCount, 1);
  assert.match(checkpoint.metadata.providerMetadata.openAiCompatible.validationFailure, /Provider output field/);
});

test('openai_compatible provider preserves raw evidence when provider output is malformed', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS: 'true',
    },
    cwd: process.cwd(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"summaryShort":"missing required fields"}' } }],
        }),
    }),
  });
  app.updateRuntimeSettings({
    values: {
      distillProvider: 'openai_compatible',
      openAiCompatible: {
        preset: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        responseFormat: 'json_object',
      },
    },
    secrets: {
      openAiCompatibleApiKey: 'deepseek-secret',
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'bad-openai-compatible-repo',
    sessionId: 'bad-openai-compatible-session',
    role: 'user',
    content: 'Raw evidence should survive malformed provider output.',
  });

  await assert.rejects(
    app.distillCheckpoint({
      scope: 'repo',
      scopeKey: 'bad-openai-compatible-repo',
      sessionId: 'bad-openai-compatible-session',
    }),
    /Provider output field/,
  );

  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'bad-openai-compatible-repo',
      sessionId: 'bad-openai-compatible-session',
    }).length,
    1,
  );
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'bad-openai-compatible-repo',
    sessionId: 'bad-openai-compatible-session',
  });
  assert.equal(runs[0].status, 'failed');
});

test('codex_exec rejects unsupported reasoning effort values', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT: 'low\" other=\"x',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => ({ stdout: '{}' }),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-invalid-reasoning',
    sessionId: 'invalid-reasoning-session',
    role: 'user',
    content: 'This should fail before codex exec receives invalid config.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-invalid-reasoning',
        sessionId: 'invalid-reasoning-session',
      }),
    /Invalid codex_exec reasoning effort/,
  );
});

test('codex_exec doctor returns structured errors', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_CODEX_EXEC_COMMAND: 'codex-missing',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => {
      throw new Error('spawn codex-missing ENOENT');
    },
  });

  const result = await app.checkCodexExec({ live: true });
  assert.equal(result.ok, false);
  assert.equal(result.commandAvailable, false);
  assert.equal(result.command, 'codex-missing');
  assert.match(result.error.message, /ENOENT/);
});

test('codex_exec parse failures preserve raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => ({ stdout: 'not json' }),
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-codex-fail',
    sessionId: 'codex-fail-session',
    role: 'assistant',
    content: 'Raw evidence should survive codex_exec parse failures.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-codex-fail',
        sessionId: 'codex-fail-session',
      }),
    /valid JSON/,
  );

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 1);
  assert.equal(info.tables.checkpoints, 0);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-codex-fail',
    sessionId: 'codex-fail-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].outputMetadata.providerFailed, true);
  assert.equal(runs[0].inputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v9');
  assert.equal(runs[0].outputMetadata.providerMetadata.promptVersion, 'codex_exec.prompt.v9');
});
