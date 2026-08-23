import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { OPERATION_REGISTRY } from '../src/operations/registry.js';

// The roadmap fell out of step with the code once already: two milestones sat
// at "initial implementation in progress" for four months after shipping, and
// two whole features had no entry at all. Claims that can be checked are
// checked, so the next drift shows up as a failing test rather than as a
// document nobody trusts.

const CANDIDATE_PATTERN = /candidate|audit|promot|snooze|stale|reconcile|backlog/i;

test('the roadmap states the operation counts the registry actually has', async () => {
  const roadmap = await fs.readFile('docs/roadmap.md', 'utf8');
  const operations = OPERATION_REGISTRY.map((entry) => entry.method || entry.name);
  const candidateOperations = operations.filter((name) => CANDIDATE_PATTERN.test(String(name)));

  const claim = roadmap.match(/(\d+) of (\d+) registered operations/);
  assert.ok(claim, 'the roadmap should state the candidate share of the operation surface');
  assert.equal(
    Number(claim[2]),
    operations.length,
    `roadmap says ${claim[2]} operations, registry has ${operations.length}`,
  );
  assert.equal(
    Number(claim[1]),
    candidateOperations.length,
    `roadmap says ${claim[1]} candidate operations, registry has ${candidateOperations.length}`,
  );
});

test('no milestone is left describing shipped work as in progress', async () => {
  const roadmap = await fs.readFile('docs/roadmap.md', 'utf8');
  // Not a style rule: this exact phrase is what went stale, and it stayed
  // because nothing objected to it.
  assert.doesNotMatch(
    roadmap,
    /^Status: initial implementation in progress\.$/m,
    'a milestone still claims initial implementation is in progress',
  );
});

test('every milestone carries a status line', async () => {
  const roadmap = await fs.readFile('docs/roadmap.md', 'utf8');
  const milestones = roadmap.split(/^## Milestone /m).slice(1);
  assert.ok(milestones.length >= 9, `expected at least 9 milestones, found ${milestones.length}`);
  for (const section of milestones) {
    const heading = section.split('\n')[0];
    assert.match(section, /^Status: /m, `Milestone ${heading} has no status line`);
  }
});
