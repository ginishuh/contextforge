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

test('packaged memory skill covers the candidate backlog lifecycle', async () => {
  const skill = await fs.readFile('docs/skills/contextforge-memory/SKILL.md', 'utf8');
  const metadata = await fs.readFile('docs/skills/contextforge-memory/agents/openai.yaml', 'utf8');
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
    assert.ok(skill.includes(contract), `missing candidate lifecycle skill contract: ${contract}`);
  }
  assert.match(metadata, /short_description: "Scoped memory, distillation, and candidate review"/);
  assert.match(metadata, /default_prompt: "Use \$contextforge-memory /);
});
