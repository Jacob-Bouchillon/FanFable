/**
 * Relation proof rules: twelve families, the arrow from the sentence, and the
 * status of the tie.
 *
 * Pure rule tests — no database, no model, no passage prose from any book.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELATION_FAMILIES,
  canonicalProofKind,
  directionOfSentence,
  familyOfKind,
  inverseFamilyOf,
  isProofKind,
  proofIntake,
  relationStatusOf,
} from '../../fanfable/src/identity/relation-proof.ts';

test('there are exactly twelve families, each with a label and a direction', () => {
  assert.equal(RELATION_FAMILIES.length, 12);
  for (const rule of RELATION_FAMILIES) {
    assert.ok(rule.canonical.endsWith('_of') || rule.canonical === 'located_in', rule.family);
    assert.ok(rule.keys.length > 0, rule.family);
    assert.ok(rule.heads.length > 0, rule.family);
  }
});

test('bank kinds inside a family are proof kinds', () => {
  const inside: [string, string][] = [
    ['father of', 'parent'],
    ['mother of', 'parent'],
    ['son of', 'child'],
    ['daughter of', 'child'],
    ['master of', 'master'],
    ['mentor of', 'master'],
    ['friend of', 'ally'],
    ['enemy of', 'enemy'],
    ['rival of', 'enemy'],
    ['member of', 'member'],
    ['servant of', 'servant'],
    ['married to', 'spouse'],
    ['brother of', 'sibling'],
    ['debtor of', 'debtor'],
    ['employer of', 'employer'],
    ['resident of', 'located'],
  ];
  for (const [kind, family] of inside) {
    assert.equal(familyOfKind(kind), family, kind);
    assert.equal(isProofKind(kind), true, kind);
    assert.deepEqual(proofIntake(kind), { action: 'bank', family }, kind);
  }
});

test('kinds outside the twelve families park and never bank', () => {
  // The kinds that fell through in the measured run, plus bare verbs.
  const outside = [
    'was', 'mentioned in', 'suspected of', 'influence over', 'advocate for',
    'related to', 'willing to show around', 'was followed by', 'suspected',
    'suggests', 'sought', 'resurrected', 'represented by', 'proposes to',
    'inquiring about', 'initiator of', 'had', 'envy of', 'consulted',
    'considering returning to', 'assumed', 'armed guards', 'agreed to',
    'unknown', '', '   ',
  ];
  for (const kind of outside) {
    assert.equal(familyOfKind(kind), 'other', kind);
    assert.equal(isProofKind(kind), false, kind);
    assert.deepEqual(proofIntake(kind), { action: 'park', reason: 'kind-unsupported' }, kind);
    assert.equal(canonicalProofKind(kind), null, kind);
  }
});

test('suspicion is a status, not a tie: "suspected of" is not "enemy of"', () => {
  assert.equal(familyOfKind('suspected of'), 'other');
  assert.equal(familyOfKind('suspected enemy'), 'enemy');
});

test('known inverses are declared for asymmetric families', () => {
  assert.equal(inverseFamilyOf('parent'), 'child');
  assert.equal(inverseFamilyOf('child'), 'parent');
  assert.equal(inverseFamilyOf('master'), 'servant');
  assert.equal(inverseFamilyOf('servant'), 'master');
  // Symmetric families are their own inverse.
  for (const family of ['ally', 'enemy', 'sibling', 'spouse', 'member'] as const) {
    assert.equal(inverseFamilyOf(family), family, family);
  }
});

test('the arrow is read from the sentence, not the candidate order', () => {
  const sentence = 'Larsh Hill was the father of San Hill.';
  assert.equal(directionOfSentence(sentence, 'Larsh Hill', 'San Hill', 'father of'), 'forward');
  // The same claim listed backwards must flip.
  assert.equal(directionOfSentence(sentence, 'San Hill', 'Larsh Hill', 'father of'), 'reverse');
});

test('a possessive sentence states the same arrow', () => {
  const sentence = "San Hill's father was Larsh Hill.";
  assert.equal(directionOfSentence(sentence, 'San Hill', 'Larsh Hill', 'father of'), 'reverse');
  assert.equal(directionOfSentence(sentence, 'Larsh Hill', 'San Hill', 'father of'), 'forward');
});

test('"the son of" flips a parent-of claim stated the other way round', () => {
  const sentence = 'San Hill was the son of Larsh Hill.';
  assert.equal(directionOfSentence(sentence, 'Larsh Hill', 'San Hill', 'father of'), 'forward');
  assert.equal(directionOfSentence(sentence, 'San Hill', 'Larsh Hill', 'father of'), 'reverse');
});

test('a symmetric family carries no arrow', () => {
  assert.equal(directionOfSentence('A and B were friends.', 'A', 'B', 'friend of'), 'none');
});

test('a sentence that places neither side leaves the order alone', () => {
  assert.equal(directionOfSentence('They spoke at length.', 'A', 'B', 'father of'), 'none');
  assert.equal(directionOfSentence('', 'A', 'B', 'father of'), 'none');
});

test('an unsupported kind has no arrow to flip', () => {
  assert.equal(directionOfSentence('A was B.', 'A', 'B', 'was'), 'none');
});

test('status is read from the winning sentence', () => {
  assert.equal(relationStatusOf('Mara is Tor\'s sister.'), 'current');
  assert.equal(relationStatusOf('Mara was Tor\'s sister.'), 'past');
  assert.equal(relationStatusOf('Mara was once Tor\'s sister.'), 'past');
  assert.equal(relationStatusOf('Mara may have been Tor\'s sister.'), 'suspected');
  assert.equal(relationStatusOf('It is rumoured that Mara is Tor\'s sister.'), 'suspected');
  assert.equal(relationStatusOf(''), 'unknown');
  assert.equal(relationStatusOf('   '), 'unknown');
});

test('suspected outranks past: an allegation about the past is still an allegation', () => {
  assert.equal(relationStatusOf('She was reportedly his sister.'), 'suspected');
});
