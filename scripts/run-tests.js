#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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
}

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

let junit = '';
try {
  junit = await fs.readFile(junitPath, 'utf8');
} catch (error) {
  console.error(`JUnit artifact was not produced: ${error.message}`);
  process.exit(exitCode || 1);
}

const totalDurationMs = Number(junit.match(/<!-- duration_ms ([0-9.]+) -->/)?.[1] || 0);
const testCases = [...junit.matchAll(/<testcase\s+name="([^"]*)"\s+time="([0-9.]+)"/g)].map((match) => ({
  name: match[1],
  durationMs: Number(match[2]) * 1000,
}));
const slowTests = testCases.filter((entry) => entry.durationMs > slowThresholdMs);
const summary = {
  live,
  testMode: true,
  exitCode,
  totalDurationMs,
  totalBudgetMs,
  slowThresholdMs,
  testCount: testCases.length,
  slowTests,
  passedBudget: totalDurationMs <= totalBudgetMs && slowTests.length === 0,
};
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

if (slowTests.length > 0) {
  console.error(`Slow-test budget exceeded (${slowThresholdMs}ms):`);
  for (const entry of slowTests) {
    console.error(`- ${entry.name}: ${entry.durationMs.toFixed(3)}ms`);
  }
}
if (totalDurationMs > totalBudgetMs) {
  console.error(`Total test budget exceeded: ${totalDurationMs.toFixed(3)}ms > ${totalBudgetMs}ms.`);
}
if (exitCode === 0 && !summary.passedBudget) {
  process.exit(1);
}
process.exit(exitCode);
