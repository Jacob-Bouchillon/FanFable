/**
 * Entity lookup must see a stored alias as the same person.
 *
 * Regression for the defect that left chapters fourteen and sixteen with almost
 * no relations. `findEntityId` compared the incoming name against other
 * entities' NAMES only, never their aliases, so a window that wrote "Ron" for a
 * bank row called "Ronald Weasley" found no match and created a second
 * character called "Ron". The pair then made the short form ambiguous for every
 * later relation, and those relations were demoted to hints instead of banked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/core/db.ts';
import { findEntityId, resolveEntity } from '../../fanfable/src/lorebook/shared.ts';

function bank(): Db {
  const db = new Db(':memory:');
  db.run("INSERT INTO project(id, name, settings, created_at, updated_at) VALUES (1, 'p', '{}', 'x', 'x')");
  return db;
}

function add(db: Db, name: string, aliases: string[] = [], kind = 'character'): number {
  db.run(
    `INSERT INTO canon_entity(project_id, kind, name, aliases, review_status, created_at, updated_at)
     VALUES (1, ?, ?, ?, 'needs_review', 'x', 'x')`,
    kind,
    name,
    JSON.stringify(aliases),
  );
  return Number((db.get<{ id: number }>('SELECT max(id) AS id FROM canon_entity') ?? { id: 0 }).id);
}

test('an exact name resolves to itself', () => {
  const db = bank();
  const id = add(db, 'Ronald Weasley', ['Ron']);
  assert.equal(findEntityId(db, 1, 'character', 'Ronald Weasley'), id);
});

test('a short form that is a stored alias resolves to its entity', () => {
  const db = bank();
  const id = add(db, 'Ronald Weasley', ['Ron', 'Ronnie']);
  assert.equal(findEntityId(db, 1, 'character', 'Ron'), id, 'alias must not mint a duplicate');
  assert.equal(findEntityId(db, 1, 'character', 'Ronnie'), id);
  // The same lookup through the relation resolver must agree, or extraction
  // and relation banking disagree about who "Ron" is.
  assert.equal(resolveEntity(db, 1, 'Ron'), id);
});

test('an alias shared by two entities stays ambiguous', () => {
  const db = bank();
  add(db, 'Person A', ['the stranger']);
  add(db, 'Person B', ['the stranger']);
  // Guessing here would silently attach facts to the wrong person.
  assert.equal(findEntityId(db, 1, 'character', 'the stranger'), undefined);
});

test('an entity named the same as another entity\'s alias still finds the name', () => {
  const db = bank();
  // This is the duplicate state left behind by the old lookup. The exact-name
  // match must win; it is the only path that keeps the row stable until the
  // duplicate is merged.
  add(db, 'Albus Dumbledore', ['Dumbledore']);
  const twin = add(db, 'Dumbledore');
  assert.equal(findEntityId(db, 1, 'character', 'Dumbledore'), twin);
});

test('malformed alias JSON does not throw and does not resolve', () => {
  const db = bank();
  add(db, 'Broken', []);
  db.run("UPDATE canon_entity SET aliases = 'not json' WHERE name = 'Broken'");
  assert.equal(findEntityId(db, 1, 'character', 'not json'), undefined);
  assert.equal(findEntityId(db, 1, 'character', 'Broken'), 1);
});
