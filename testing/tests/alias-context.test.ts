/** Context alias candidates and verdict validation: pure functions only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeAliasCandidates,
  validateAliasVerdict,
  type AliasCandidateEntity,
} from '../../fanfable/src/identity/alias-context.ts';

function entity(id: number, name: string, aliases: string[] = []): AliasCandidateEntity {
  return { id, name, aliases };
}

test('candidate generation finds surname-only pairs and deduplicates them', () => {
  const candidates = proposeAliasCandidates([
    entity(1, 'Albus Dumbledore'),
    entity(2, 'Dumbledore'),
    entity(3, 'Fred Weasley'),
    entity(4, 'George Weasley'),
  ], new Map());

  assert.deepEqual(
    candidates.map((candidate) => [candidate.a.id, candidate.b.id, candidate.shared]),
    [[1, 2, 'dumbledore'], [3, 4, 'weasley']],
  );
});

test('only same-group pairs are skipped; ungrouped surname counterparts are proposed', () => {
  const groupOf = new Map<number, number>([[2, 2], [5, 2]]);
  const candidates = proposeAliasCandidates([
    entity(1, 'Albus Dumbledore'),
    entity(2, 'Dumbledore'),
    entity(5, 'Professor Dumbledore'),
  ], groupOf);

  assert.ok(
    candidates.some((candidate) => candidate.a.id === 1 && candidate.b.id === 2),
    'Albus Dumbledore / Dumbledore is proposed',
  );
  assert.ok(
    !candidates.some((candidate) =>
      (candidate.a.id === 2 && candidate.b.id === 5) || (candidate.a.id === 5 && candidate.b.id === 2)),
    'two entities in the same group stay skipped',
  );

  const hagrid = proposeAliasCandidates([
    entity(1, 'Rubeus Hagrid'),
    entity(2, 'Hagrid'),
  ], new Map());
  assert.deepEqual(hagrid.map((candidate) => [candidate.a.id, candidate.b.id, candidate.shared]), [[1, 2, 'hagrid']]);

  const aliased = proposeAliasCandidates([
    entity(1, 'Rubeus Hagrid', ['Hagrid']),
    entity(2, 'Hagrid'),
  ], new Map());
  assert.deepEqual(aliased, []);
});

test('a token in more than three character names is not distinctive', () => {
  const candidates = proposeAliasCandidates([
    entity(1, 'Fred Weasley'),
    entity(2, 'George Weasley'),
    entity(3, 'Ron Weasley'),
    entity(4, 'Ginny Weasley'),
  ], new Map());
  assert.deepEqual(candidates, []);
});

test('a quote absent from every chunk is rejected', () => {
  const verdict = validateAliasVerdict(
    { same: 'yes', quote: 'Dumbledore nodded.', reason: 'same person' },
    {
      chunkTexts: ['Albus Dumbledore spoke with Dumbledore.'],
      aName: 'Albus Dumbledore',
      bName: 'Dumbledore',
      aAliases: [],
      bAliases: [],
    },
  );
  assert.equal(verdict.same, false);
  assert.equal(verdict.rejection, 'quote-not-found');
});

test('a quote naming only one side is rejected', () => {
  const verdict = validateAliasVerdict(
    { same: 'yes', quote: 'Dumbledore nodded.', reason: 'same person' },
    {
      chunkTexts: ['Dumbledore nodded.'],
      aName: 'Albus Dumbledore',
      bName: 'Dumbledore',
      aAliases: [],
      bAliases: [],
    },
  );
  assert.equal(verdict.same, false);
  assert.equal(verdict.rejection, 'names-not-both');
});

test('the Weasley brothers quote names neither full name', () => {
  const verdict = validateAliasVerdict(
    { same: 'yes', quote: 'the Weasley brothers', reason: 'same family' },
    {
      chunkTexts: ['the Weasley brothers were laughing'],
      aName: 'Fred Weasley',
      bName: 'George Weasley',
      aAliases: [],
      bAliases: [],
    },
  );
  assert.equal(verdict.same, false);
  assert.equal(verdict.rejection, 'names-not-both');
});

test('a valid quote naming both sides is accepted', () => {
  const verdict = validateAliasVerdict(
    { same: 'yes', quote: 'Albus Dumbledore spoke with Dumbledore.', reason: 'same person' },
    {
      chunkTexts: ['At the gate, Albus Dumbledore spoke with Dumbledore.'],
      aName: 'Albus Dumbledore',
      bName: 'Dumbledore',
      aAliases: [],
      bAliases: [],
    },
  );
  assert.deepEqual(verdict, {
    same: true,
    quote: 'Albus Dumbledore spoke with Dumbledore.',
    reason: 'same person',
  });
});

test('multi-token aliases can satisfy a side', () => {
  const verdict = validateAliasVerdict(
    { same: 'yes', quote: 'Albus Dumbledore spoke with Professor Dumbledore.', reason: 'same person' },
    {
      chunkTexts: ['Albus Dumbledore spoke with Professor Dumbledore.'],
      aName: 'Albus Dumbledore',
      bName: 'Dumbledore',
      aAliases: [],
      bAliases: ['Professor Dumbledore'],
    },
  );
  assert.equal(verdict.same, true);
});

test('an existing alias assignment is an alias conflict', () => {
  const verdict = validateAliasVerdict(
    { same: 'yes', quote: 'Albus Dumbledore spoke with Dumbledore.', reason: 'same person' },
    {
      chunkTexts: ['Albus Dumbledore spoke with Dumbledore.'],
      aName: 'Albus Dumbledore',
      bName: 'Dumbledore',
      aAliases: [],
      bAliases: ['Albus Dumbledore'],
    },
  );
  assert.equal(verdict.same, false);
  assert.equal(verdict.rejection, 'alias-conflict');
});

test('malformed verdicts are bad shape', () => {
  const ctx = {
    chunkTexts: ['Albus Dumbledore spoke with Dumbledore.'],
    aName: 'Albus Dumbledore',
    bName: 'Dumbledore',
    aAliases: [],
    bAliases: [],
  };
  assert.equal(validateAliasVerdict({ same: 'maybe', quote: 'x' }, ctx).rejection, 'bad-shape');
  assert.equal(validateAliasVerdict({ same: true }, ctx).rejection, 'bad-shape');
  assert.equal(validateAliasVerdict({ same: 'yes', quote: 42 }, ctx).rejection, 'bad-shape');
});

test('a well-shaped no or unsure answer stays false without a rejection reason', () => {
  const ctx = {
    chunkTexts: ['Albus Dumbledore spoke with Dumbledore.'],
    aName: 'Albus Dumbledore',
    bName: 'Dumbledore',
    aAliases: [],
    bAliases: [],
  };
  assert.deepEqual(validateAliasVerdict({ same: 'no', quote: '', reason: 'different people' }, ctx), {
    same: false,
    quote: '',
    reason: 'different people',
  });
  assert.deepEqual(validateAliasVerdict({ same: 'unsure' }, ctx), {
    same: false,
    quote: '',
    reason: '',
  });
});
