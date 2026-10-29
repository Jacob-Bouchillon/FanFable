/**
 * Kind labels: every concept carries a description and a direction, the prompt
 * shows them, and the guard checks a citation rather than a synonym list.
 * Invented vocabulary only — the table is general English, not any book's wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';

test('every closed kind has a description and a direction', () => {
  for (const kind of lorebook.CLOSED_ROLE_KINDS) {
    const gloss = lorebook.KIND_GLOSSES[kind];
    assert.ok(gloss, `missing gloss for ${kind}`);
    assert.ok(gloss.says.trim().length > 0, `empty definition for ${kind}`);
    assert.match(gloss.says, /differs from/i, `${kind} does not name its nearest neighbour`);
    assert.ok(
      gloss.direction === 'directional' || gloss.direction === 'symmetric',
      `bad direction for ${kind}`,
    );
  }
});

test('the glossary has no kinds outside the closed list and no word lists', () => {
  const closed = new Set(lorebook.CLOSED_ROLE_KINDS);
  for (const [kind, gloss] of Object.entries(lorebook.KIND_GLOSSES)) {
    assert.ok(closed.has(kind), `gloss for non-bankable kind ${kind}`);
    assert.equal(Object.prototype.hasOwnProperty.call(gloss, 'reads'), false, `${kind} still lists synonyms`);
  }
});

test('removed duplicates are gone; the added concepts are present', () => {
  for (const removed of ['married to', 'partner with', 'assistant of']) {
    assert.equal(lorebook.CLOSED_ROLE_KINDS.includes(removed), false, `${removed} should be removed`);
    assert.equal(lorebook.KIND_GLOSSES[removed], undefined, `${removed} still has a gloss`);
  }
  for (const added of [
    'rival of', 'acquaintance', 'guardian of', 'employer of', 'customer of', 'owner of',
    'disliked', 'resented', 'feared', 'admired', 'trusted', 'distrusted',
    'bullied', 'protective of', 'jealous of', 'loyal to', 'obeyed',
  ]) {
    assert.ok(lorebook.CLOSED_ROLE_KINDS.includes(added), `missing concept ${added}`);
    assert.ok(lorebook.KIND_GLOSSES[added], `missing gloss for ${added}`);
  }
  assert.ok(lorebook.CLOSED_ROLE_KINDS.includes('child of'), 'the generic inverse of parent of stays');
});

test('direction flags match the concept', () => {
  const directional = [
    'mother of', 'father of', 'sister of', 'brother of', 'enemy of', 'teacher of',
    'mentor of', 'bullied', 'protective of', 'obeyed', 'loyal to', 'guardian of',
  ];
  const symmetric = [
    'friend of', 'sibling of', 'cousin of', 'colleague of', 'partner', 'rival of',
    'disliked', 'admired', 'trusted', 'distrusted', 'feared', 'ally of', 'peer of',
  ];
  for (const kind of directional) assert.equal(lorebook.isDirectionalKind(kind), true, kind);
  for (const kind of symmetric) assert.equal(lorebook.isDirectionalKind(kind), false, kind);
});

test('the prompt block names every concept with its meaning and direction', () => {
  const block = lorebook.kindGlossaryBlock();
  for (const kind of lorebook.CLOSED_ROLE_KINDS) {
    const direction = lorebook.KIND_GLOSSES[kind]!.direction;
    assert.ok(block.includes(`- ${kind} (${direction}) —`), `block omits ${kind}`);
  }
  assert.match(block, /kind must be exactly one of these labels/i);
  assert.match(block, /kind_source must be the passage's own words/i);
  assert.equal(/reads as:/i.test(block), false, 'the block must not reintroduce a word list');
});

test('the relations prompt carries the glossary', () => {
  const prompt = lorebook.relationsSystemPrompt();
  assert.match(prompt, /Defined relationship concepts\./);
  assert.ok(prompt.includes('- ally of (symmetric) —'));
  assert.ok(prompt.includes('- disliked (symmetric) —'));
});

test('an unrelated sentence still fails the label-word diagnostic', () => {
  // The concept set remains for labelling and queryability. This diagnostic
  // is not the promotion guard: the model's citation and confidence decide.
  assert.equal(lorebook.isUnsupportedKind('ally of', 'Mara met Tor at the gate.'), true);
  assert.equal(lorebook.isUnsupportedKind('friend of', 'Mara paid the toll.'), true);
});

test('a nearby kin word does not satisfy the generic relative label', () => {
  assert.equal(lorebook.isUnsupportedKind('relative of', 'Aunt Mara took Tor to the market.'), true);
});

