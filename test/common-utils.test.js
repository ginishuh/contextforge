import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampImportance,
  contentHash,
  liveStateTermsMatch,
  normalizeToken,
  summarySnippet,
} from '../src/common.js';
import {
  candidateQualityText,
  normalizeContentForRisk,
  qualityTokens,
  tokenOverlapScore,
} from '../src/memory/candidate_text.js';
import { truncate } from '../src/ingest/common.js';

// These helpers were module-private duplicates before they were shared, so
// nothing pinned their behaviour. The point of these tests is the contract each
// caller already depends on, not coverage.

test('summarySnippet collapses whitespace and marks the cut with an ellipsis', () => {
  assert.equal(summarySnippet('  a\n\n b  \tc '), 'a b c');
  assert.equal(summarySnippet('', 5), '');
  assert.equal(summarySnippet(null), '');
  assert.equal(summarySnippet('abcdef', 3), 'abc...');
  // Exactly at the limit is not truncated.
  assert.equal(summarySnippet('abc', 3), 'abc');
});

test('summarySnippet is a different contract from the ingest byte-budget truncate', () => {
  // Both exist on purpose: one produces a readable preview, the other enforces
  // a budget and reports whether it cut. Collapsing them would change output.
  assert.equal(summarySnippet('a  b', 10), 'a b');
  assert.deepEqual(truncate('a  b', 10), { text: 'a  b', truncated: false });
  assert.equal(summarySnippet('abcdef', 3), 'abc...');
  assert.deepEqual(truncate('abcdef', 3), { text: 'abc\n[truncated]', truncated: true });
});

test('contentHash hashes the empty string for nullish input', () => {
  const empty = contentHash('');
  assert.equal(contentHash(null), empty);
  assert.equal(contentHash(undefined), empty);
  // Persisted alongside memory rows, so the digest itself is the contract.
  assert.equal(
    empty,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.notEqual(contentHash('a'), empty);
});

test('clampImportance pins values into the stored 0-10 integer range', () => {
  assert.equal(clampImportance(5), 5);
  assert.equal(clampImportance(-3), 0);
  assert.equal(clampImportance(99), 10);
  assert.equal(clampImportance(4.6), 5);
  assert.equal(clampImportance('7'), 7);
  assert.equal(clampImportance('nope'), 0);
  assert.equal(clampImportance(null), 0);
});

test('normalizeToken lowercases and trims', () => {
  assert.equal(normalizeToken('  Preference '), 'preference');
  assert.equal(normalizeToken(null), '');
});

test('liveStateTermsMatch recognises mutable-state vocabulary in both languages', () => {
  assert.equal(liveStateTermsMatch('which branch is this on'), true);
  assert.equal(liveStateTermsMatch('CI is red'), true);
  assert.equal(liveStateTermsMatch('배포 상태 확인'), true);
  assert.equal(liveStateTermsMatch('the user prefers tabs'), false);
  assert.equal(liveStateTermsMatch(null), false);
});

test('qualityTokens drops short tokens and keeps path-like ones', () => {
  assert.deepEqual(qualityTokens('a bb ccc dddd'), ['ccc', 'dddd']);
  assert.deepEqual(qualityTokens('src/core.js'), ['src/core.js']);
  assert.deepEqual(qualityTokens(null), []);
});

test('tokenOverlapScore is Jaccard similarity and never divides by zero', () => {
  assert.equal(tokenOverlapScore('alpha beta', 'alpha beta'), 1);
  assert.equal(tokenOverlapScore('alpha beta', 'gamma delta'), 0);
  assert.equal(tokenOverlapScore('', 'alpha'), 0);
  assert.equal(tokenOverlapScore('alpha beta', 'alpha gamma'), 1 / 3);
});

test('normalizeContentForRisk lowercases and collapses whitespace', () => {
  assert.equal(normalizeContentForRisk('  The\n\tValue '), 'the value');
  assert.equal(normalizeContentForRisk(null), '');
});

test('candidateQualityText folds the judgeable fields into one blob', () => {
  const text = candidateQualityText({
    key: 'k',
    content: 'body',
    candidate: {
      reason: 'why',
      category: 'preference',
      tags: ['t1', 't2'],
      evidenceRefs: ['e1'],
    },
  });
  assert.deepEqual(text.split('\n'), ['k', 'body', 'why', 'preference', 't1', 't2', 'e1']);
  // Absent fields are dropped rather than becoming blank lines.
  assert.equal(candidateQualityText({ key: 'only' }), 'only');
});
