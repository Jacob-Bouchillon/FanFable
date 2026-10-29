/**
 * Kind glossary: every bankable kind carries one line of meaning, and the
 * relations prompt shows all of them. Invented vocabulary only — the table is
 * general English, not any book's wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';

test('every closed kind has a gloss', () => {
  for (const kind of lorebook.CLOSED_ROLE_KINDS) {
    const gloss = lorebook.KIND_GLOSSES[kind];
    assert.ok(gloss, `missing gloss for ${kind}`);
    assert.ok(gloss.says.trim().length > 0, `empty definition for ${kind}`);
    assert.ok(gloss.reads.trim().length > 0, `empty examples for ${kind}`);
  }
});

test('the glossary has no kinds outside the closed list', () => {
  const closed = new Set(lorebook.CLOSED_ROLE_KINDS);
  for (const kind of Object.keys(lorebook.KIND_GLOSSES)) {
    assert.ok(closed.has(kind), `gloss for non-bankable kind ${kind}`);
  }
});

test('the prompt block names every closed kind with its meaning', () => {
  const block = lorebook.kindGlossaryBlock();
  for (const kind of lorebook.CLOSED_ROLE_KINDS) {
    assert.ok(block.includes(`- ${kind} —`), `block omits ${kind}`);
  }
  assert.ok(block.startsWith('Defined kinds.'));
});

test('the relations prompt carries the glossary', () => {
  const prompt = lorebook.relationsSystemPrompt();
  assert.ok(prompt.includes('Defined kinds.'));
  assert.ok(prompt.includes('- ally of —'));
});

test('a defining phrase proves the kind without its own word', () => {
  assert.equal(lorebook.isUnsupportedKind('ally of', 'Mara sided with Tor at the gate.'), false);
  assert.equal(lorebook.isUnsupportedKind('enemy of', 'The two turned on each other.'), false);
  assert.equal(lorebook.isUnsupportedKind('master of', 'Master, he said, and bowed.'), false);
});

test('an unrelated sentence still fails the kind', () => {
  assert.equal(lorebook.isUnsupportedKind('ally of', 'Mara met Tor at the gate.'), true);
  assert.equal(lorebook.isUnsupportedKind('friend of', 'Mara paid the toll.'), true);
});

test('a kin word nearby does not prove a generic relative', () => {
  assert.equal(lorebook.isUnsupportedKind('relative of', 'Aunt Mara took Tor to the market.'), true);
  assert.equal(lorebook.isUnsupportedKind('relative of', 'Tor was her only living relative.'), false);
  assert.equal(lorebook.isUnsupportedKind('relative of', 'They were kin, and everyone knew it.'), false);
});
