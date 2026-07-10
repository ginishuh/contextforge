import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runQualityEval } from '../../src/eval/quality.js';
import { evaluateRetrievalFixture } from '../../src/eval/retrieval.js';

const execFileAsync = promisify(execFile);
const fixture = path.resolve('docs/examples/quality-eval/contextforge-quality.synthetic.json');
const baseline = path.resolve('evals/quality-baseline.json');

test('offline memory quality eval reports retrieval, distillation, and candidate baselines', async () => {
  const report = await runQualityEval({ fixture, baseline });
  assert.equal(report.kind, 'memory_quality_eval');
  assert.equal(report.offline, true);
  assert.equal(report.passed, true);
  assert.equal(report.retrieval.queries, 6);
  assert.equal(report.retrieval.metrics.judgedQueries, 3);
  assert.equal(report.retrieval.metrics.unjudgedQueries, 3);
  assert.equal(report.retrieval.failed, 0);
  assert.equal(report.retrieval.metrics.recallAtK, 1);
  assert.ok(report.retrieval.metrics.mrr >= 0.83);
  assert.ok(report.retrieval.metrics.ndcgAtK >= 0.87);
  assert.equal(report.retrieval.metrics.scopeLeakageCount, 0);
  assert.equal(report.retrieval.metrics.byLanguage.ko.recallAtK, 1);
  assert.equal(report.retrieval.metrics.byLanguage.en.recallAtK, 1);
  assert.equal(report.retrieval.metrics.byLanguage.mixed.recallAtK, 1);
  assert.equal(report.distillation.metrics.preservationRate, 1);
  assert.equal(report.distillation.metrics.hallucinationCount, 0);
  assert.equal(report.distillation.metrics.sensitivityDetectionRate, 1);
  assert.equal(report.distillation.sensitivity.detected, 1);
  assert.equal(report.distillation.details.find((item) => item.inputTruncated).missingHooks.length, 0);
  assert.notEqual(report.distillation.details[0].claims[0].sources[0], 'raw-1');
  assert.equal(report.candidate.metrics.durableCandidatePrecision, 1);
  assert.equal(report.candidate.metrics.preferenceEvidenceAccuracy, 1);
  assert.equal(report.candidate.metrics.trustOrderingAccuracy, 1);
  assert.equal(report.candidate.details.find((item) => item.id === 'stable-runbook').actualAction, 'promote');
  assert.equal(report.candidate.details.find((item) => item.id === 'one-off-local-detail').actualClassification, 'too_specific');
  assert.equal(report.candidate.details.find((item) => item.id === 'conflicting-memory').actualAction, 'update');
  assert.equal(report.thresholds.failed, 0);
});

test('retrieval relevance labels control ranking metrics and fail missing relevant keys', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-retrieval-quality-test-'));
  const fixturePath = path.resolve('docs/examples/quality-eval/multilingual-retrieval.synthetic.json');
  const retrievalFixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  retrievalFixture.queries[0].expected.relevantKeys = ['missing-relevant-memory'];
  retrievalFixture.queries[0].expected.relevance = { 'missing-relevant-memory': 3 };
  try {
    const report = await evaluateRetrievalFixture(retrievalFixture, { dataDir });
    assert.equal(report.failed, 1);
    assert.equal(report.metrics.judgedQueries, 3);
    assert.equal(report.details[0].passed, false);
    assert.equal(report.details[0].metrics.recallAtK, 0);
    assert.equal(report.details[0].metrics.reciprocalRank, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('quality eval failures expose exact fixture and threshold details through the CLI', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-quality-test-'));
  const strictBaselinePath = path.join(tempDir, 'strict-baseline.json');
  const strictBaseline = JSON.parse(await fs.readFile(baseline, 'utf8'));
  strictBaseline.name = 'intentionally-failing-baseline';
  strictBaseline.thresholds.minimum['retrieval.metrics.mrr'] = 1;
  await fs.writeFile(strictBaselinePath, JSON.stringify(strictBaseline, null, 2));
  try {
    await assert.rejects(
      execFileAsync('node', [
        'src/cli.js',
        'evalQuality',
        '--fixture',
        fixture,
        '--baseline',
        strictBaselinePath,
      ]),
      (error) => {
        const report = JSON.parse(error.stdout);
        assert.equal(report.kind, 'memory_quality_eval');
        assert.equal(report.passed, false);
        assert.equal(report.thresholds.failed, 1);
        const failed = report.thresholds.checks.find((check) => !check.passed);
        assert.equal(failed.metric, 'retrieval.metrics.mrr');
        assert.equal(failed.minimum, 1);
        assert.ok(failed.actual < 1);
        assert.equal(report.retrieval.details, undefined);
        assert.ok(report.retrieval.reports[1].details[2].resultKeys.includes('shared-safety-policy'));
        return true;
      },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
