/**
 * Roster Stage A: one shared title set, bare titles resolve to nobody, and
 * the resolver never resolves a form the merge rules refuse to merge.
 *
 * Synthetic databases only; no book text. Nothing here merges, renames or
 * re-kinds a row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { tempDb } from './helpers.ts';
import {
  TITLE_TOKENS,
  canonicalName,
  isTitleToken,
} from '../../fanfable/src/identity/names.ts';
import { resolveEntity } from '../../fanfable/src/identity/identity.ts';
import { flagIdentityCollisions } from '../../fanfable/src/identity/identity-check.ts';
import { mergeVerdict } from '../../fanfable/src/identity/roster-rules.ts';

const AT = '2026-01-01T00:00:00.000Z';

function setup(rows: { name: string; kind?: string; aliases?: string[] }[]) {
  const { db } = tempDb();
  const project = controller.createProject(db, `roster-a-${Math.random().toString(36).slice(2, 7)}`);
  const ids = new Map<string, number>();
  for (const row of rows) {
    const id = Number(db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      row.kind ?? 'character',
      row.name,
      JSON.stringify(row.aliases ?? []),
      AT,
      AT,
    ).lastInsertRowid);
    ids.set(row.name, id);
  }
  return { db, projectId: project.id, ids };
}

test('one shared title set is the union of the four former lists', () => {
  const required = [
    // names.ts
    'mr', 'mrs', 'miss', 'ms', 'dr', 'doctor', 'professor', 'captain',
    'sir', 'lady', 'lord', 'king', 'queen', 'prince', 'princess',
    'uncle', 'aunt', 'father', 'mother', 'brother', 'sister',
    'grandfather', 'grandmother',
    // identity.ts / identity-check.ts
    'master', 'mistress', 'commander', 'general', 'admiral', 'colonel',
    'major', 'sergeant', 'emperor', 'empress', 'count', 'countess',
    'duke', 'duchess', 'baron', 'boss', 'senator', 'chancellor', 'viceroy',
    'magister', 'great', 'son', 'daughter', 'clan',
    // roster-rules.ts
    'prof',
  ];
  for (const token of required) {
    assert.ok(TITLE_TOKENS.has(token), `title set contains ${token}`);
    assert.equal(isTitleToken(token.toUpperCase()), true, `case-insensitive ${token}`);
  }
  assert.equal(isTitleToken('who'), false);
  assert.equal(isTitleToken('havisham'), false);
});

test('a bare honorific resolves to nobody while the full name still resolves', () => {
  const { db, projectId, ids } = setup([
    { name: 'Doctor Who' },
    { name: 'Miss Havisham' },
    { name: 'Professor X' },
    { name: 'Captain Vela' },
  ]);
  for (const bare of ['Doctor', 'Miss', 'Professor', 'Captain']) {
    const resolution = resolveEntity(db, projectId, bare);
    assert.equal(resolution.status, 'absent', `${bare} is not a person`);
    assert.equal(resolution.id, null);
  }
  assert.equal(resolveEntity(db, projectId, 'Doctor Who').id, ids.get('Doctor Who'));
  assert.equal(resolveEntity(db, projectId, 'Miss Havisham').id, ids.get('Miss Havisham'));
  assert.equal(resolveEntity(db, projectId, 'Professor X').id, ids.get('Professor X'));
  db.close();
});

test('resolver and merge verdict agree on title-only containment', () => {
  const { db, projectId } = setup([{ name: 'Doctor Who' }, { name: 'Captain Vela' }]);
  for (const [short, long] of [['Doctor', 'Doctor Who'], ['Captain', 'Captain Vela']] as const) {
    assert.deepEqual(
      mergeVerdict({ name: short, kind: 'character' }, { name: long, kind: 'character' }),
      { action: 'separate', reason: 'title only' },
      `${short} / ${long}`,
    );
    assert.equal(resolveEntity(db, projectId, short).status, 'absent', `${short} never resolves`);
  }
  db.close();
});

test('shared surname stays two people and the surname alone is ambiguous', () => {
  const { db, projectId, ids } = setup([{ name: 'Larsh Hill' }, { name: 'San Hill' }]);
  assert.deepEqual(
    mergeVerdict({ name: 'Larsh Hill', kind: 'character' }, { name: 'San Hill', kind: 'character' }),
    { action: 'separate', reason: 'surname shared, given names differ' },
  );
  const bySurname = resolveEntity(db, projectId, 'Hill');
  assert.equal(bySurname.status, 'ambiguous');
  assert.deepEqual(
    bySurname.candidates.map((candidate) => candidate.id).sort((a, b) => a - b),
    [ids.get('Larsh Hill')!, ids.get('San Hill')!].sort((a, b) => a - b),
  );
  assert.equal(resolveEntity(db, projectId, 'Larsh Hill').status, 'resolved');
  assert.equal(resolveEntity(db, projectId, 'San Hill').status, 'resolved');
  db.close();
});

test('a person never merges with a non-person of the same name', () => {
  assert.deepEqual(
    mergeVerdict({ name: 'Asha', kind: 'character' }, { name: 'Asha', kind: 'location' }),
    { action: 'separate', reason: 'different kinds' },
  );
});

test('curly apostrophes canonicalise the same and stored rows stay untouched', () => {
  assert.equal(canonicalName("Shi’ido"), canonicalName("Shi'ido"));
  assert.equal(canonicalName("Shi’ido"), "shi'ido");
  const { db, projectId, ids } = setup([{ name: "Shi'ido" }]);
  const resolution = resolveEntity(db, projectId, 'Shi’ido');
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.id, ids.get("Shi'ido"));
  const stored = db.get<{ name: string }>('SELECT name FROM canon_entity WHERE id = ?', ids.get("Shi'ido"))!;
  assert.equal(stored.name, "Shi'ido", 'resolver writes nothing');
  db.close();
});

test('identity-check writes flags idempotently', () => {
  const { db, projectId } = setup([
    { name: 'Asha Ren', aliases: ['Asha'] },
    { name: 'Asha' },
    { name: 'Bram Ren' },
    { name: 'Bram Ren Kel' },
  ]);
  const first = flagIdentityCollisions(db, projectId, { write: true });
  assert.ok(first.collisions.length >= 2, 'both collision groups found');
  assert.ok(first.flagged >= 2, 'rows flagged on the first pass');

  const second = flagIdentityCollisions(db, projectId, { write: true });
  assert.equal(second.flagged, 0, 'second pass adds no flags');
  assert.ok(second.alreadyFlagged >= first.flagged, 'already-flagged rows are recognised');
  assert.deepEqual(second.collisions, first.collisions, 'the groups are stable');

  const flagged = db.all<{ review_status: string }>(
    "SELECT review_status FROM canon_entity WHERE project_id = ? AND review_status = 'needs_review'",
    projectId,
  );
  assert.ok(flagged.length >= first.flagged, 'flags are needs_review only');
  db.close();
});
