#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJunitReport } from './junit-report.js';

const args = process.argv.slice(2);
const liveIndex = args.indexOf('--live');
const live = liveIndex !== -1;
if (live) args.splice(liveIndex, 1);

if (live && process.env.CONTEXTFORGE_LIVE_TESTS !== 'true') {
  console.error('Live tests require CONTEXTFORGE_LIVE_TESTS=true.');
  process.exit(2);
}

const artifactDir = path.resolve(process.env.CONTEXTFORGE_TEST_ARTIFACT_DIR || 'artifacts/test');
const junitPath = path.join(artifactDir, 'junit.xml');
const summaryPath = path.join(artifactDir, 'summary.json');
const slowThresholdMs = Number(process.env.CONTEXTFORGE_TEST_SLOW_MS || 10000);
const totalBudgetMs = Number(process.env.CONTEXTFORGE_TEST_BUDGET_MS || 120000);

await fs.mkdir(artifactDir, { recursive: true });
await fs.rm(junitPath, { force: true });
await fs.rm(summaryPath, { force: true });

const testArgs = [
  '--test',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=junit',
  `--test-reporter-destination=${junitPath}`,
  ...args,
];
const hasExplicitTestPath = args.some((arg) => arg.endsWith('.js') || arg.startsWith('test/'));
if (live && !hasExplicitTestPath) {
  const liveDir = path.resolve('test/live');
  const liveTests = (await fs.readdir(liveDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join(liveDir, entry.name))
    .sort();
  if (liveTests.length === 0) {
    console.error(`No live tests found in ${liveDir}.`);
    process.exit(2);
  }
  testArgs.push(...liveTests);
} else if (!hasExplicitTestPath) {
  // Node's default glob treats every `.js` file under `test/` as a test file, so
  // shared helper modules would be reported as empty test files. Name the suite
  // explicitly instead; this matches the same 19 files the default glob found.
  testArgs.push('test/**/*.test.js');
}

const startedAt = Date.now();
const child = spawn(process.execPath, testArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CONTEXTFORGE_TEST_MODE: 'true',
    CONTEXTFORGE_LIVE_TESTS: live ? 'true' : 'false',
  },
  stdio: 'inherit',
});

const exitCode = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`Test process exited from signal ${signal}.`);
      resolve(1);
      return;
    }
    resolve(code ?? 1);
  });
});
const wallClockDurationMs = Date.now() - startedAt;

let junit = '';
try {
  junit = await fs.readFile(junitPath, 'utf8');
} catch (error) {
  console.error(`JUnit artifact was not produced: ${error.message}`);
  process.exit(exitCode || 1);
}

const { testCases, reportedDurationMs } = parseJunitReport(junit);
const slowTests = testCases.filter((entry) => entry.durationMs > slowThresholdMs);
const summary = {
  live,
  testMode: true,
  exitCode,
  totalDurationMs: wallClockDurationMs,
  reportedDurationMs,
  totalBudgetMs,
  slowThresholdMs,
  testCount: testCases.length,
  slowTests,
  passedBudget: wallClockDurationMs <= totalBudgetMs && slowTests.length === 0 && testCases.length > 0,
};
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

if (slowTests.length > 0) {
  console.error(`Slow-test budget exceeded (${slowThresholdMs}ms):`);
  for (const entry of slowTests) {
    console.error(`- ${entry.name}: ${entry.durationMs.toFixed(3)}ms`);
  }
}
if (wallClockDurationMs > totalBudgetMs) {
  console.error(`Total test budget exceeded: ${wallClockDurationMs.toFixed(3)}ms > ${totalBudgetMs}ms.`);
}
if (testCases.length === 0) {
  console.error('JUnit report contained no testcase entries; refusing a vacuous duration-budget pass.');
}
if (exitCode === 0 && !summary.passedBudget) {
  process.exit(1);
}
process.exit(exitCode);
