/**
 * Exact endpoint proof: the answer guard keeps a CONFIRMED tie only when one
 * passage names both endpoints exactly or by a banked alias. The fuzzy match
 * stays for retrieval only. Invented names only; no model calls beyond a mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lore from '../../fanfable/src/lore.ts';
import { nameMentioned, nameMentionedExact } from '../../fanfable/src/identity/names.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function passage(text: string): lore.Passage {
  return {
    chunkId: 1,
    sourceId: 1,
    sourceTitle: 'Probe',
    path: '/probe',
    locator: 'p1',
    heading: '',
    text,
    score: 0,
  };
}

function addEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  aliases: string[] = [],
): number {
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId,
    'character',
    name,
    JSON.stringify(aliases),
    'accepted',
    AT,
    AT,
  ).lastInsertRowid;
}

test('exact proof rejects one-edit near names that the link policy accepts', () => {
  const belly = 'the belly of the wagon was warm';
  assert.equal(nameMentioned('Bella', belly), true, 'link policy still tolerates one edit');
  assert.equal(nameMentionedExact('Bella', belly), false, 'proof does not');

  const near = 'Ashalina spoke first';
  assert.equal(nameMentioned('Ashaline', near), true);
  assert.equal(nameMentionedExact('Ashaline', near), false);

  assert.equal(nameMentionedExact('Bram', 'a bramble grew by the wall'), false, 'no substring');
});

test('exact proof accepts whole tokens, banked aliases, and full names', () => {
  assert.equal(nameMentionedExact('Bella', 'Bella waited by the gate.'), true);
  assert.equal(nameMentionedExact('Mira Corwin', 'Mira Corwin left before dawn.'), true);
  assert.equal(nameMentionedExact('Mira Corwin', 'Corwin met Mira at the gate.'), true);
  assert.equal(nameMentionedExact('Mira Corwin', 'Mira waited alone.'), false, 'all tokens required');
  assert.equal(nameMentionedExact('the Grey', 'The Grey met Bram.'), true, 'article is noise');

  assert.equal(
    lore.passageNamesBoth([passage('The Grey met Bram.')], ['bella', 'the grey'], ['bram']),
    true,
    'a banked alias names the endpoint',
  );
});

test('the guard keeps a CONFIRMED tie only when a passage names both sides exactly', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'exact-guard');
  addEntity(db, project.id, 'Bella');
  addEntity(db, project.id, 'Bram');
  const llm = mockProvider((req) =>
    (req.system ?? '').includes('Lore Researcher')
      ? 'CONFIRMED: Bella is the apprentice of Bram.'
      : '{"terms":[]}',
  );

  const exact = await lore.answerLoreQuestion(db, llm, project.id, 'status of Bella to Bram', {
    search: [passage('Bella is the apprentice of Bram.')],
  });
  assert.match(exact.answer, /CONFIRMED/, 'an exact mention still proves the tie');

  const fuzzy = await lore.answerLoreQuestion(db, llm, project.id, 'status of Bella to Bram', {
    search: [passage('the belly of the wagon was Bram’s.')],
  });
  assert.match(fuzzy.answer, /Tie not established/, 'a near name never proves the tie');
  db.close();
});
