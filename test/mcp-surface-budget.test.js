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

test('a tool count that no longer matches is rejected in either direction', () => {
  const gained = surfaceBudgetViolations(budgets(), measured({ toolCount: 25 }));
  assert.equal(gained.length, 1);
  assert.match(gained[0], /agent-core\.toolCount: 25 does not match the recorded 24/);

  // Losing a tool has to be recorded too, or a profile could drop one and pick
  // up a different one with the manifest none the wiser.
  const lost = surfaceBudgetViolations(budgets(), measured({ toolCount: 23 }));
  assert.equal(lost.length, 1);
  assert.match(lost[0], /agent-core\.toolCount: 23 does not match the recorded 24/);
});

test('the surface selection env vars cannot skew a measurement', async () => {
  // With CONTEXTFORGE_MCP_TOOLS set, every profile used to measure as that
  // allowlist — and an --update run would have written those numbers into the
  // manifest, recording the developer's shell instead of the repository.
  const previous = process.env.CONTEXTFORGE_MCP_TOOLS;
  process.env.CONTEXTFORGE_MCP_TOOLS = 'db_info,search';
  try {
    const measurements = await measureSurfaces();
    assert.equal(measurements['agent-core'].toolCount, 24);
    assert.notEqual(measurements['all'].toolCount, measurements['agent-core'].toolCount);
    assert.deepEqual(surfaceBudgetViolations(readSurfaceBudgets(), measurements), []);
  } finally {
    if (previous === undefined) delete process.env.CONTEXTFORGE_MCP_TOOLS;
    else process.env.CONTEXTFORGE_MCP_TOOLS = previous;
  }
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
