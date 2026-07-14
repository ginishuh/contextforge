import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('release hygiene validates docs, versions, and the npm package boundary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-release-test-'));
  const reportFile = path.join(tempDir, 'package-report.json');
  try {
    await execFileAsync('node', ['scripts/check-release.js'], {
      cwd: process.cwd(),
      env: { ...process.env, CONTEXTFORGE_RELEASE_REPORT: reportFile },
    });
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    assert.equal(report.kind, 'release_hygiene_report');
    assert.equal(report.passed, true);
    assert.equal(report.markdown.brokenLinks.length, 0);
    assert.equal(report.markdown.missingCommandFiles.length, 0);
    assert.equal(report.markdown.missingPackageScripts.length, 0);
    assert.deepEqual(report.markdown.releaseBudgetChecks, {
      packedBytes: true,
      unpackedBytes: true,
      entryCount: true,
    });
    assert.equal(report.markdown.publishedPackage.passed, true);
    assert.equal(report.markdown.publishedPackage.missingLocalTargets.length, 0);
    assert.equal(report.markdown.publishedPackage.missingCommandTargets.length, 0);
    assert.ok(report.markdown.publishedPackage.checkedLocalTargets > 0);
    assert.ok(report.markdown.publishedPackage.checkedCommandTargets > 0);
    assert.equal(report.versions.passed, true);
    assert.equal(report.package.missingRequired.length, 0);
    assert.equal(report.package.forbidden.length, 0);
    assert.equal(report.package.missingPublishedScripts.length, 0);
    assert.equal(report.package.unexpectedPublishedScripts.length, 0);
    assert.ok(!report.package.publishedScripts.includes('scripts/ci-detect-run-tests.sh'));
    assert.deepEqual(report.package.budgets, {
      packedBytes: 600_000,
      unpackedBytes: 2_500_000,
      entryCount: 150,
    });
    assert.equal(report.package.budgetChecks.packedBytes, true);
    assert.equal(report.package.budgetChecks.unpackedBytes, true);
    assert.equal(report.package.budgetChecks.entryCount, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('packaged memory skill uses bounded progressive disclosure without losing lifecycle contracts', async () => {
  const skill = await fs.readFile('docs/skills/contextforge-memory/SKILL.md', 'utf8');
  const candidateLifecycle = await fs.readFile(
    'docs/skills/contextforge-memory/references/candidate-lifecycle.md',
    'utf8',
  );
  const embeddings = await fs.readFile(
    'docs/skills/contextforge-memory/references/embeddings-and-maintenance.md',
    'utf8',
  );
  const workspaces = await fs.readFile(
    'docs/skills/contextforge-memory/references/workspaces-and-scope-migration.md',
    'utf8',
  );
  const references = [candidateLifecycle, embeddings, workspaces];
  const metadata = await fs.readFile('docs/skills/contextforge-memory/agents/openai.yaml', 'utf8');
  const shortDescription = 'Scoped memory, distillation, and candidate review';

  assert.ok(skill.split('\n').length <= 340, 'SKILL.md exceeds the 340-line prompt budget');
  assert.ok(Buffer.byteLength(skill) <= 18_000, 'SKILL.md exceeds the 18 KB prompt budget');
  for (const reference of references) {
    assert.ok(reference.split('\n').length <= 120, 'skill reference exceeds the 120-line budget');
    assert.ok(Buffer.byteLength(reference) <= 6_000, 'skill reference exceeds the 6 KB budget');
  }
  assert.ok(
    references.reduce((total, reference) => total + Buffer.byteLength(reference), 0) <= 14_000,
    'skill references exceed the combined 14 KB budget',
  );
  for (const reference of [
    'references/workspaces-and-scope-migration.md',
    'references/candidate-lifecycle.md',
    'references/embeddings-and-maintenance.md',
  ]) {
    assert.ok(skill.includes(reference), `missing progressive-disclosure link: ${reference}`);
  }
  for (const contract of [
    'If a linked file is\nunavailable, the runtime skill installation is incomplete',
    '`bootstrap_context` does not create a session.',
    '`connection.accessMode`',
    'Do not create a fresh `cf_...` session at closeout',
    'Never broaden an empty closeout',
    'It never scans the whole scope backlog.',
    'Distillation failure must not erase raw evidence.',
    'must not promote or mutate durable memory.',
  ]) {
    assert.ok(skill.includes(contract), `missing always-loaded safety contract: ${contract}`);
  }

  for (const contract of [
    'list_memory_candidates',
    'memoryCandidateBacklog',
    'plan_memory_candidate_backlog_audit',
    'submit_audit_job',
    'route_audited_memory_candidates',
    'snooze_memory_candidate',
    'wake_memory_candidate',
    'reopen_stale_memory_candidate',
    'list_due_candidate_audits',
    'list_due_candidate_wakeups',
    'list_due_candidate_stale_transitions',
    'candidateLifecycleWorker',
    '300-second remote timeout',
    '`0600` authority environment file',
  ]) {
    assert.ok(
      candidateLifecycle.includes(contract),
      `missing candidate lifecycle reference contract: ${contract}`,
    );
  }
  for (const contract of ['migrate_scope', 'CONTEXTFORGE_SCOPE_ALIASES', 'connection.accessMode']) {
    assert.ok(workspaces.includes(contract), `missing workspace reference contract: ${contract}`);
  }
  for (const contract of ['list_embedding_jobs', 'prune_embedding_artifacts', 'confirmMassRetired']) {
    assert.ok(embeddings.includes(contract), `missing embedding reference contract: ${contract}`);
  }
  assert.equal(metadata, [
    'interface:',
    '  display_name: "ContextForge Memory"',
    `  short_description: "${shortDescription}"`,
    '  default_prompt: "Use $contextforge-memory to inspect scoped memory, review candidate lifecycle state, and choose safe next actions."',
    '',
  ].join('\n'));
  assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
});
