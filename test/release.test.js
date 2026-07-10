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
    assert.equal(report.package.budgetChecks.packedBytes, true);
    assert.equal(report.package.budgetChecks.unpackedBytes, true);
    assert.equal(report.package.budgetChecks.entryCount, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
