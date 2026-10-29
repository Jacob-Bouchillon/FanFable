/**
 * Regression fixtures for the assertion test, distilled from the labelled
 * sample. Invented names only: the shapes matter, not the book.
 *
 * Two cases are pinned as known gaps — a variant noun ("partnership" for
 * partner) and a pronoun complement ("your enemy, X"). They are expected to
 * fail today so a later fix is visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';

const check = (sentence: string, kind: string, from = 'Mara', to = 'Tor'): boolean =>
  lorebook.assertsRelationship(sentence, from, [], to, [], kind);

test('a title is not an assertion', () => {
  assert.equal(check('Aunt Mara took Tor to the market.', 'aunt of'), false);
  assert.equal(check('Uncle Tor watched Mara unwrap the gift.', 'uncle of'), false);
});

test('an explicit possessive asserts', () => {
  assert.equal(check("Tor's aunt, Mara, took him in.", 'aunt of'), true);
  assert.equal(check("Tor's best friend, Mara, walked in.", 'friend of'), true);
  assert.equal(check("Tor's old mentor, Mara, said nothing.", 'mentor of'), true);
});

test('a copula or an of-phrase asserts', () => {
  assert.equal(check("Mara was Tor's aunt.", 'aunt of'), true);
  assert.equal(check('Mara was the aunt of Tor.', 'aunt of'), true);
});

test('co-occurrence is not an assertion', () => {
  assert.equal(check('Mara and Tor came in together.', 'aunt of'), false);
  assert.equal(check('Mara watched Tor unwrap the gift.', 'relative of'), false);
});

test('a relation to a third person does not bind the pair', () => {
  assert.equal(check("Mara's mentor was Tor, and everyone knew it.", 'mentor of', 'Mara', 'Tor'), true);
  assert.equal(check("Bran's mentor was Tor.", 'mentor of', 'Mara', 'Tor'), false);
});

test('a variant noun is recognised through the glossary', () => {
  assert.equal(check("Mara's partnership with Tor endured.", 'partner'), true);
});

test('known gap: a pronoun complement is not yet resolved', () => {
  assert.equal(check('You do not want me as your enemy, Tor.', 'enemy of', 'Mara', 'Tor'), false);
});
