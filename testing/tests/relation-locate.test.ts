/**
 * Locate-don't-reject: a paraphrased retry answer is cut back to the real
 * both-names sentence when one exists. Synthetic prose only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateSentence } from '../../fanfable/src/lorebook.ts';

const MARA = { id: 1, name: 'Mara', aliases: '' };
const TOR = { id: 2, name: 'Tor', aliases: '' };

test('a paraphrased proposal locates the byte-exact both-names sentence', () => {
  const passage = 'Mara was the aunt of Tor. The gate was cold.';
  assert.equal(
    locateSentence(passage, 'Mara was the aunt of Tor, basically.', MARA, TOR),
    'Mara was the aunt of Tor.',
  );
});

test('two equally similar candidates refuse', () => {
  const passage = 'Mara was the aunt of Tor. Mara was the aunt of Tor.';
  assert.equal(locateSentence(passage, 'Mara was the aunt of Tor, basically.', MARA, TOR), null);
});

test('a located sentence that does not name both endpoints refuses', () => {
  const passage = 'Mara was the aunt of Tor. The gate was cold.';
  assert.equal(locateSentence(passage, 'The gate was cold, honestly.', MARA, TOR), null);
});

test('a low-similarity proposal refuses', () => {
  const passage = 'Mara was the aunt of Tor. The gate was cold.';
  assert.equal(locateSentence(passage, 'Someone else arrived later.', MARA, TOR), null);
});
