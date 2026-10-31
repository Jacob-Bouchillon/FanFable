/**
 * Shared name linking: typo tolerance, whole-token boundaries, and the
 * IDENTITY exception. Invented names only; no source content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { nameMentioned } from '../../fanfable/src/identity/names.ts';
import type { Passage } from '../../fanfable/src/answer/lore.ts';
import { passageNamesBoth } from '../../fanfable/src/answer/lore.ts';
import { findEntity, searchLore, windowEntityNames } from '../../fanfable/src/lorebook.ts';
import { matchScore } from '../../fanfable/src/graph.ts';
import type { GraphNode } from '../../fanfable/src/graph.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

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

test('LINK policy keeps whole-token boundaries and accepts one long-token typo', () => {
  assert.equal(nameMentioned('Ash', 'A flash of light.'), false, 'fragment is not a name');
  assert.equal(nameMentioned('Ash', 'Ashaline arrived.'), false, 'fragment inside a longer token');
  assert.equal(nameMentioned('Asha', 'Asha arrived.'), true);
  assert.equal(nameMentioned('Ashaline', 'Ashalina arrived.'), true, 'one long-token typo');
  assert.equal(nameMentioned('Ashaline', 'Asha arrived.'), false, 'full name needs all tokens');
  assert.equal(nameMentioned('Asha Bram', 'Asha arrived.', { partial: true }), true);
});

test('searchLore links a typo but not a fragment', () => {
  const { db } = tempDb();
  const project = createProject(db, 'name-linking-search');
  addEntity(db, project.id, 'Ashaline');

  assert.equal(searchLore(db, project.id, 'Ashalina').entities.length, 1);
  assert.equal(searchLore(db, project.id, 'Ash').entities.length, 0);
  db.close();
});

test('window names and the answer guard reject substrings', () => {
  const { db } = tempDb();
  const project = createProject(db, 'name-linking-window');
  addEntity(db, project.id, 'Ashaline', ['Ash']);

  const flash = windowEntityNames(db, project.id, [
    { id: 1, seq: 1, heading: '', locator: 'p1', text: 'A flash of light.', source_title: 'X', path: '/x', source_id: 1 },
  ] as never);
  assert.deepEqual(flash, [], 'Ash inside flash is not a mention');

  const ash = windowEntityNames(db, project.id, [
    { id: 2, seq: 2, heading: '', locator: 'p2', text: 'Ash waited.', source_title: 'X', path: '/x', source_id: 1 },
  ] as never);
  assert.deepEqual(ash, ['Ashaline'], 'whole token Ash is a mention');

  const passage = (text: string): Passage => ({
    chunkId: 1,
    sourceId: 1,
    sourceTitle: 'X',
    path: '/x',
    locator: 'p',
    heading: '',
    text,
    score: 0,
  });
  assert.equal(passageNamesBoth([passage('A flash of brambles.')], ['Ash'], ['Bram']), false);
  assert.equal(passageNamesBoth([passage('Ash met Bram.')], ['Ash'], ['Bram']), true);
  db.close();
});

test('graph scoring links typos and rejects fragments; findEntity stays IDENTITY', () => {
  const node: GraphNode = {
    id: 'canon:entity:1',
    numericId: 1,
    kind: 'canon-entity',
    scope: 'canon',
    name: 'Ashaline',
    summary: '',
    aliases: [],
    confidence: 1,
    reviewStatus: 'accepted',
    evidence: '',
    sourceRefs: [],
    order: 0,
    extra: {},
  };
  assert.equal(matchScore(node, ['ash']), 0, 'fragment does not score');
  assert.equal(matchScore(node, ['ashalina']), 1, 'one typo scores');

  const { db } = tempDb();
  const project = createProject(db, 'name-linking-identity');
  addEntity(db, project.id, 'Ashaline');
  assert.equal(findEntity(db, project.id, 'Ashaline')?.name, 'Ashaline');
  assert.equal(findEntity(db, project.id, 'Ashalina'), undefined, 'IDENTITY does not fuzzy match');
  db.close();
});
