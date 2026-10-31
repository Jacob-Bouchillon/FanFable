/**
 * Combination tally: weak clues adding up into proof. Invented data only;
 * no model, no bank, no book text. Pins the calibration cases from the
 * research record plus the independence rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCH_ALL_PAIRS,
  combineScore,
  meetsBar,
  quotePairCounts,
  type WeakNote,
} from '../../fanfable/src/core/combine.ts';
import { DEFAULT_MIN_CONFIDENCE } from '../../fanfable/src/gates/gates.ts';

function note(over: Partial<WeakNote> & { strength: number; chunkId: number | null }): WeakNote {
  return {
    assessed: true,
    dedupeKey: '',
    pairsCited: 1,
    isContext: false,
    ...over,
  };
}

const approx = (got: number, want: number): void => {
  assert.ok(Math.abs(got - want) < 1e-9, `expected ${want}, got ${got}`);
};

test('three damped 0.2s score 0.49 and do not bank', () => {
  const out = combineScore([
    note({ strength: 0.2, chunkId: 1, dedupeKey: 'a' }),
    note({ strength: 0.2, chunkId: 2, dedupeKey: 'b' }),
    note({ strength: 0.2, chunkId: 3, dedupeKey: 'c' }),
  ]);
  approx(out.score, 1 - 0.8 * 0.8 * 0.8);
  assert.ok(Math.abs(out.score - 0.49) < 0.01);
  assert.equal(out.independent, 3);
  assert.equal(meetsBar(out.score), false);
});

test('0.4 plus 0.8 scores 0.88 and banks', () => {
  const out = combineScore([
    note({ strength: 0.4, chunkId: 10, dedupeKey: 'a' }),
    note({ strength: 0.8, chunkId: 20, dedupeKey: 'b' }),
  ]);
  approx(out.score, 0.88);
  assert.equal(meetsBar(out.score), true);
});

test('one thin 0.4 mention scores 0.40 and does not bank', () => {
  const out = combineScore([note({ strength: 0.4, chunkId: 10, dedupeKey: 'a' })]);
  approx(out.score, 0.4);
  assert.equal(out.independent, 1);
  assert.equal(meetsBar(out.score), false);
});

test('one explicit 0.95 banks', () => {
  const out = combineScore([note({ strength: 0.95, chunkId: 10, dedupeKey: 'a' })]);
  approx(out.score, 0.95);
  assert.equal(meetsBar(out.score), true);
});

test('same-chunk repeats count once, strongest wins', () => {
  const out = combineScore([
    note({ strength: 0.4, chunkId: 10, dedupeKey: 'a' }),
    note({ strength: 0.9, chunkId: 10, dedupeKey: 'b' }),
  ]);
  approx(out.score, 0.9);
  assert.equal(out.independent, 1);
});

test('repeats of one clue never count twice, even across passages', () => {
  const out = combineScore([
    note({ strength: 0.6, chunkId: 10, dedupeKey: 'same' }),
    note({ strength: 0.7, chunkId: 20, dedupeKey: 'same' }),
  ]);
  approx(out.score, 0.7);
  assert.equal(out.independent, 1);
});

test('a sentence cited for more than three pairs halves every share', () => {
  assert.equal(CATCH_ALL_PAIRS, 3);
  const halved = combineScore([
    note({ strength: 0.8, chunkId: 10, dedupeKey: 'a', pairsCited: 4 }),
    note({ strength: 0.8, chunkId: 20, dedupeKey: 'b', pairsCited: 4 }),
  ]);
  approx(halved.score, 1 - 0.6 * 0.6);
  assert.ok(halved.contributions.every((c) => c.damped));
  const boundary = combineScore([note({ strength: 0.8, chunkId: 10, dedupeKey: 'a', pairsCited: 3 })]);
  approx(boundary.score, 0.8);
  assert.equal(boundary.contributions[0]!.damped, false);
});

test('unassessed notes count 0 until assessed', () => {
  const out = combineScore([
    note({ strength: 0.95, chunkId: 10, dedupeKey: 'a', assessed: false }),
    note({ strength: 0.9, chunkId: 20, dedupeKey: 'b', assessed: false }),
  ]);
  assert.equal(out.score, 0);
  assert.equal(out.independent, 0);
});

test('co-presence notes never count, whatever they carry', () => {
  const out = combineScore([note({ strength: 0.9, chunkId: 10, dedupeKey: 'a', isContext: true })]);
  assert.equal(out.score, 0);
  assert.equal(out.independent, 0);
});

test('empty in, zero out; the bar is the author\'s single bar', () => {
  assert.deepEqual(combineScore([]), { score: 0, independent: 0, contributions: [] });
  assert.equal(DEFAULT_MIN_CONFIDENCE, 0.7);
  assert.equal(meetsBar(0.7), true);
  assert.equal(meetsBar(0.699), false);
  assert.equal(meetsBar(0.4, 0.35), true);
});

test('quotePairCounts counts different pairs per sentence', () => {
  const counts = quotePairCounts([
    { sentence: 'x', aEntity: 1, bEntity: 2 },
    { sentence: 'x', aEntity: 2, bEntity: 1 },
    { sentence: 'x', aEntity: 1, bEntity: 3 },
    { sentence: 'y', aEntity: 1, bEntity: 2 },
  ]);
  assert.equal(counts.get('x'), 2);
  assert.equal(counts.get('y'), 1);
});
