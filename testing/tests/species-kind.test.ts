/**
 * Species kind and entity funnels. Invented names only; prompt text and the
 * kind normaliser are checked without a model call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACT_ENTITIES_SYSTEM,
  EXTRACT_SYSTEM,
  normaliseKind,
  type EntityKind,
} from '../../fanfable/src/lorebook.ts';

const KINDS: EntityKind[] = [
  'character',
  'species',
  'location',
  'item',
  'rule',
  'faction',
  'creature',
];

test('every taxonomy kind maps to itself', () => {
  for (const kind of KINDS) assert.equal(normaliseKind(kind), kind);
});

test('species words map to species', () => {
  for (const word of ['species', 'race', 'people', 'folk', 'lineage', 'bloodline', 'Species']) {
    assert.equal(normaliseKind(word), 'species', word);
  }
});

test('species stays distinct from creature and faction', () => {
  assert.equal(normaliseKind('creature'), 'creature');
  assert.equal(normaliseKind('animal'), 'creature');
  assert.equal(normaliseKind('beast'), 'creature');
  assert.equal(normaliseKind('faction'), 'faction');
  assert.equal(normaliseKind('group'), 'faction');
  assert.equal(normaliseKind('mystery'), 'character', 'unknown words keep the old fallback');
});

test('unknown and empty kinds keep the documented character fallback', () => {
  assert.equal(normaliseKind('vague'), 'character');
  assert.equal(normaliseKind(''), 'character');
});

test('both entity prompts list the seven kinds and all seven funnels', () => {
  const funnels = [
    'Common nouns are not entities.',
    'One-scene props are not entities.',
    'People get one species row.',
    'Organisations are faction.',
    'Occupations are not entities.',
    'Named individuals are character.',
    'Resolve ambiguity by role.',
  ];
  for (const prompt of [EXTRACT_SYSTEM, EXTRACT_ENTITIES_SYSTEM]) {
    assert.ok(
      prompt.includes('"kind":"character|species|faction|location|item|rule|creature"'),
      'the schema names all seven kinds',
    );
    for (const kind of KINDS) {
      assert.match(prompt, new RegExp(`^- ${kind} —`, 'm'), `${kind} has a definition`);
    }
    for (const funnel of funnels) assert.ok(prompt.includes(funnel), funnel);
  }
});
