import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ciDetectRunTests } from './helpers/schema.js';

test('runtime database artifacts are ignored by git rules', async () => {
  const gitignore = await fs.readFile('.gitignore', 'utf8');
  assert.match(gitignore, /^\.contextforge\/$/m);
  assert.match(gitignore, /^\*\.db$/m);
  assert.match(gitignore, /^\*\.db-wal$/m);
  assert.match(gitignore, /^\*\.db-shm$/m);
});

test('CI path filter runs tests for source, workflow, test, and eval fixture changes', () => {
  assert.equal(ciDetectRunTests(['README.md']), 'false');
  assert.equal(ciDetectRunTests(['README.ja.md']), 'false');
  assert.equal(ciDetectRunTests(['docs/architecture.md']), 'false');
  assert.equal(ciDetectRunTests(['docs/issues/001-design-note.md']), 'false');
  assert.equal(ciDetectRunTests(['docs/assets/contextforge-explainer-comic-en.jpg']), 'false');

  assert.equal(ciDetectRunTests(['__force_tests__']), 'true');
  assert.equal(ciDetectRunTests(['src/eval/retrieval.js']), 'true');
  assert.equal(ciDetectRunTests(['src/workspaces/resolve.js']), 'true');
  assert.equal(ciDetectRunTests(['src/core.js']), 'true');
  assert.equal(ciDetectRunTests(['test/core.test.js']), 'true');
  assert.equal(ciDetectRunTests(['.github/workflows/ci.yml']), 'true');
  assert.equal(ciDetectRunTests(['package-lock.json']), 'true');
  assert.equal(ciDetectRunTests(['scripts/install-agent-router-service.sh']), 'true');
  assert.equal(ciDetectRunTests(['docs/examples/workspace-eval/wastelite.synthetic.json']), 'true');
  assert.equal(ciDetectRunTests(['docs/skills/contextforge-memory/SKILL.md']), 'true');
  assert.equal(ciDetectRunTests(['README.md', 'src/cli.js']), 'true');
});

test('CI rejects moderate-or-higher production dependency advisories', async () => {
  const workflow = await fs.readFile('.github/workflows/ci.yml', 'utf8');

  assert.match(workflow, /^  dependency-audit:$/m);
  assert.match(workflow, /npm audit --omit=dev --audit-level=moderate/);
  assert.match(workflow, /^      - dependency-audit$/m);
  assert.match(workflow, /needs\.dependency-audit\.result/);
  assert.match(workflow, /Node test matrix and production dependency audit skipped/);
});

test('CI allows hosted Node runners a bounded total test budget', async () => {
  const workflow = await fs.readFile('.github/workflows/ci.yml', 'utf8');

  assert.match(workflow, /CONTEXTFORGE_TEST_BUDGET_MS: 180000/);
  assert.match(workflow, /individual slow-test detection still catches localized regressions/);
});
