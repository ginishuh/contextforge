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

test('the roadmap compares review against the capability counts that exist', async () => {
  const roadmap = await fs.readFile('docs/roadmap.md', 'utf8');
  const counts = {};
  for (const entry of OPERATION_REGISTRY) {
    counts[entry.capability] = (counts[entry.capability] || 0) + 1;
  }
  // The earlier wording called review the largest surface after reads, which
  // stopped being true the moment the count was corrected downward. Comparisons
  // drift as quietly as counts do, so the numbers behind them are pinned too.
  const writeClaim = roadmap.match(/entire `write` surface \((\d+)\)/);
  const operatorClaim = roadmap.match(/level with `operator` \((\d+)\)/);
  assert.ok(writeClaim && operatorClaim, 'the roadmap should cite the write and operator counts it compares against');
  assert.equal(Number(writeClaim[1]), counts.write, `roadmap says write is ${writeClaim[1]}, registry has ${counts.write}`);
  assert.equal(
    Number(operatorClaim[1]),
    counts.operator,
    `roadmap says operator is ${operatorClaim[1]}, registry has ${counts.operator}`,
  );
  // "level with" has to stay honest: review must not overtake operator without
  // the sentence being rewritten.
  assert.ok(
    Math.abs(counts.review - counts.operator) <= 2,
    `review ${counts.review} and operator ${counts.operator} are no longer level; reword the comparison`,
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

test('the follow-up split does not claim every milestone has a tracking issue', async () => {
  const roadmap = await fs.readFile('docs/roadmap.md', 'utf8');
  const untracked = roadmap.match(/^Tracking issue: none yet\.$/gm) || [];
  if (untracked.length > 0) {
    // Adding a milestone without an issue quietly falsified the sentence above
    // the list, which is exactly the drift this file exists to catch.
    assert.doesNotMatch(
      roadmap,
      /^Each milestone after v0 has a focused tracking issue/m,
      `${untracked.length} milestone(s) have no tracking issue, so the follow-up split cannot say every one does`,
    );
  }
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
