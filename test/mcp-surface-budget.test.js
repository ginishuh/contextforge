import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  measureSurfaces,
  readSurfaceBudgets,
  surfaceBudgetViolations,
  writeSurfaceBudgets,
} from '../scripts/check-mcp-surface.js';

const budgets = () => ({
  slackRatio: 0.05,
  note: 'test fixture',
  profiles: {
    'agent-core': {
      toolCount: 24,
      instructionsBytes: 1423,
      toolSchemaBytes: 25358,
      estimatedInitialTokens: 6696,
    },
  },
});

const measured = (overrides = {}) => ({
  'agent-core': {
    toolCount: 24,
    instructionsBytes: 1423,
    toolSchemaBytes: 25358,
    estimatedInitialTokens: 6696,
    ...overrides,
  },
});

test('the recorded budgets match the surface the server actually builds', async () => {
  // The manifest is only worth anything if it tracks reality, so this measures
  // every profile for real rather than trusting the recorded numbers.
  const recorded = readSurfaceBudgets();
  const measurements = await measureSurfaces();
  assert.deepEqual(
    Object.keys(measurements).sort(),
    Object.keys(recorded.profiles).sort(),
    'every profile must carry a budget',
  );
  assert.deepEqual(surfaceBudgetViolations(recorded, measurements), []);
});

test('a surface that grows past its budget is rejected', () => {
  const violations = surfaceBudgetViolations(budgets(), measured({ estimatedInitialTokens: 6701 }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /agent-core\.estimatedInitialTokens: 6701 exceeds the recorded budget 6696/);
  assert.match(violations[0], /--update/);
});

test('a profile silently gaining a tool is rejected', () => {
  const violations = surfaceBudgetViolations(budgets(), measured({ toolCount: 25 }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /agent-core\.toolCount: 25 exceeds the recorded budget 24/);
});

test('reclaimed room must be tightened rather than left to be respent', () => {
  // 5% of 6696 is 334, so a 400-token reduction has to be recorded.
  const violations = surfaceBudgetViolations(budgets(), measured({ estimatedInitialTokens: 6296 }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /is 400 under the budget 6696/);
  assert.match(violations[0], /tighten it/);
});

test('drift inside the slack is tolerated so the manifest does not churn', () => {
  assert.deepEqual(surfaceBudgetViolations(budgets(), measured({ estimatedInitialTokens: 6400 })), []);
  // Byte counts never demand tightening, however far they fall: they move with
  // SDK releases rather than with anything the repository decided.
  assert.deepEqual(surfaceBudgetViolations(budgets(), measured({ toolSchemaBytes: 20000 })), []);
});

test('a profile with no budget entry, and a budget with no profile, both fail', () => {
  const extra = surfaceBudgetViolations(budgets(), {
    ...measured(),
    review: { toolCount: 45, instructionsBytes: 1423, toolSchemaBytes: 45379, estimatedInitialTokens: 11701 },
  });
  assert.equal(extra.length, 1);
  assert.match(extra[0], /review: measured but has no budget entry/);

  const missing = surfaceBudgetViolations(budgets(), {});
  assert.equal(missing.length, 1);
  assert.match(missing[0], /agent-core: budgeted but not measured/);
});

test('a non-integer budget is rejected at load time', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-surface-'));
  const file = path.join(directory, 'budgets.json');
  try {
    // A string still compares against a number through implicit conversion, so
    // the type is rejected rather than trusted.
    await fs.writeFile(
      file,
      JSON.stringify({ profiles: { 'agent-core': { ...budgets().profiles['agent-core'], estimatedInitialTokens: '6696' } } }),
    );
    assert.throws(() => readSurfaceBudgets(file), /estimatedInitialTokens must be a non-negative integer/);

    await fs.writeFile(file, JSON.stringify({ nope: true }));
    assert.throws(() => readSurfaceBudgets(file), /expected an object with a "profiles" map/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an update rewrites the manifest with sorted profiles and keeps the note', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-surface-'));
  const file = path.join(directory, 'budgets.json');
  try {
    const source = budgets();
    writeSurfaceBudgets(
      { review: { toolCount: 1, instructionsBytes: 2, toolSchemaBytes: 3, estimatedInitialTokens: 4 }, ...measured() },
      source,
      file,
    );
    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(written.profiles), ['agent-core', 'review']);
    assert.equal(written.note, source.note);
    assert.equal(written.slackRatio, source.slackRatio);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
