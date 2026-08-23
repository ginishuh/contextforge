import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { OPERATION_REGISTRY } from '../src/operations/registry.js';

// The roadmap fell out of step with the code once already: two milestones sat
// at "initial implementation in progress" for four months after shipping, and
// two whole features had no entry at all. Claims that can be checked are
// checked, so the next drift shows up as a failing test rather than as a
// document nobody trusts.

test('the roadmap states the operation counts the registry actually has', async () => {
  const roadmap = await fs.readFile('docs/roadmap.md', 'utf8');
  // The registry classifies operations itself. Counting by name pattern instead
  // drifts both ways: worker operations read as review because they mention
  // candidates, while correctMemory and deactivateMemory are review and mention
  // neither. A test built on the heuristic would pin whatever it happened to
  // count, wrong or not.
  const reviewOperations = OPERATION_REGISTRY.filter((entry) => entry.capability === 'review');

  const claim = roadmap.match(/(\d+)\s+of\s+(?:the\s+)?(\d+)\s+registered operations/);
  assert.ok(
    claim,
    'the roadmap should state the review share as "<n> of <total> registered operations";'
      + ' update this test alongside the wording if that sentence changes',
  );
  assert.equal(
    Number(claim[2]),
    OPERATION_REGISTRY.length,
    `roadmap says ${claim[2]} operations, registry has ${OPERATION_REGISTRY.length}`,
  );
  assert.equal(
    Number(claim[1]),
    reviewOperations.length,
    `roadmap says ${claim[1]} review operations, registry classifies ${reviewOperations.length}`,
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
