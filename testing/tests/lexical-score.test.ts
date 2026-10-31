/**
 * Shared lexical score: FTS5 bm25 rank -> bounded score where stronger is
 * larger. Numeric fixtures only; no database, model, or source content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexicalScore } from '../../fanfable/src/core/text.ts';

test('lexical score is monotonic in FTS strength', () => {
  const strong = lexicalScore(-8);
  const medium = lexicalScore(-2);
  const weak = lexicalScore(-0.2);
  const none = lexicalScore(0);
  const positive = lexicalScore(1.5);

  assert.ok(strong > medium, 'more negative rank scores higher');
  assert.ok(medium > weak, 'medium rank scores above weak');
  assert.ok(weak > none, 'negative rank scores above no hit');
  assert.equal(none, 0);
  assert.equal(positive, 0);
  assert.ok(strong < 1, 'score stays below one');
  assert.ok(Number.isFinite(strong));
});
