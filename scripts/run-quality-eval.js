#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { runQualityEval } from '../src/eval/quality.js';

const fixture = process.env.CONTEXTFORGE_QUALITY_FIXTURE ||
  'docs/examples/quality-eval/contextforge-quality.synthetic.json';
const baseline = process.env.CONTEXTFORGE_QUALITY_BASELINE || 'evals/quality-baseline.json';
const reportFile = path.resolve(process.env.CONTEXTFORGE_QUALITY_REPORT || 'artifacts/eval/quality-report.json');

const report = await runQualityEval({ fixture, baseline });
await fs.mkdir(path.dirname(reportFile), { recursive: true });
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    {
      kind: report.kind,
      passed: report.passed,
      fixture: report.fixture,
      baseline: report.baseline,
      retrieval: { queries: report.retrieval.queries, failed: report.retrieval.failed, ...report.retrieval.metrics },
      distillation: { cases: report.distillation.cases, failed: report.distillation.failed, ...report.distillation.metrics },
      candidate: { cases: report.candidate.cases, failed: report.candidate.failed, ...report.candidate.metrics },
      thresholds: report.thresholds,
      reportFile,
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
