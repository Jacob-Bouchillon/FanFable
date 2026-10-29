/**
 * The assertion matcher is gone. These are the old matcher fixtures, updated
 * deliberately: with a verbatim quote and a confident model, the mechanical
 * guard banks them. Grammar no longer defines truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';

const decide = (sentence: string, kind = 'aunt of', confidence = 0.9) =>
  lorebook.provenRelation(
    { fromId: 1, toId: 2, fromName: 'Mara', toName: 'Tor', kind, evidence: sentence, confidence },
    { chunkText: sentence, minConfidence: 0.7 },
  );

test('a title-shaped sentence is banked at the model score', () => {
  assert.deepEqual(decide('Aunt Mara took Tor to the market.'), { ok: true });
});

test('a co-occurrence sentence is not vetoed by grammar', () => {
  assert.deepEqual(decide('Mara and Tor came in together.'), { ok: true });
});

test('a sentence about a third person is not vetoed by grammar', () => {
  assert.deepEqual(decide("Bran's mentor was Tor.", 'mentor of'), { ok: true });
});

test('a bare action verb is not vetoed by grammar', () => {
  assert.deepEqual(decide('Mara joined Tor.', 'member of'), { ok: true });
});

test('a confident claim still needs a verbatim quote', () => {
  const decision = lorebook.provenRelation(
    { fromId: 1, toId: 2, fromName: 'Mara', toName: 'Tor', kind: 'aunt of', evidence: 'Not in the passage.', confidence: 1 },
    { chunkText: 'Aunt Mara took Tor to the market.', minConfidence: 0.7 },
  );
  assert.deepEqual(decision, { ok: false, reason: 'quote-not-verbatim' });
});
