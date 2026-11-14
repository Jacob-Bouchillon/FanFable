/**
 * How much of a name a short form is.
 *
 * A one-word query is not equally good evidence for every row that carries the
 * word: "Harry" is the whole of a two-word name and a third of a four-word
 * phrase. When several rows match, the least diluted claimant is the better
 * reading, and a tie still fails closed.
 *
 * This is measured on the name alone, never on what kind of thing a row is. The
 * case that prompted it: the hp1 bank held an item called "Happy Birthday
 * Harry", taken from the icing on a cake, and bare "Harry" then had two
 * claimants, so every relation written as "Harry" was demoted to a hint.
 *
 * A rule that preferred characters would also "fix" that case, and it is the
 * wrong rule: a person and a place that both carry a name would resolve to the
 * person even when the passage means the place. Nothing in this file names a
 * book, a character or a kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/core/db.ts';
import { resolveEntityDetailed } from '../../fanfable/src/lorebook/shared.ts';

function bank(): Db {
  const db = new Db(':memory:');
  db.run("INSERT INTO project(id, name, settings, created_at, updated_at) VALUES (1, 'p', '{}', 'x', 'x')");
  return db;
}

function add(db: Db, name: string, kind = 'character', aliases: string[] = []): number {
  db.run(
    `INSERT INTO canon_entity(project_id, kind, name, aliases, review_status, created_at, updated_at)
     VALUES (1, ?, ?, ?, 'needs_review', 'x', 'x')`,
    kind,
    name,
    JSON.stringify(aliases),
  );
  return Number((db.get<{ id: number }>('SELECT max(id) AS id FROM canon_entity') ?? { id: 0 }).id);
}

test('a short form resolves to the row it dilutes least', () => {
  const db = bank();
  const subject = add(db, 'Harry Potter');
  add(db, 'Happy Birthday Harry', 'item');
  // "Harry" is 1 of 2 words there and 1 of 3 in the phrase.
  assert.equal(resolveEntityDetailed(db, 1, 'Harry').id, subject);
  assert.equal(resolveEntityDetailed(db, 1, 'Harry').method, 'short-name');
});

test('a tie on dilution still fails closed', () => {
  const db = bank();
  add(db, 'Tom Riddle');
  add(db, 'Tom the Barman');
  // Both lead with "Tom" and neither name is more diluted than the other; only
  // the passage can say which is meant, and guessing attaches one person's
  // facts to another.
  const resolution = resolveEntityDetailed(db, 1, 'Tom');
  assert.equal(resolution.id, undefined);
  assert.equal(resolution.method, 'short-collision');
});

test('a leading given name beats a phrase that merely contains it', () => {
  const db = bank();
  const given = add(db, 'Tom Riddle');
  add(db, 'Tom and Jerry Annual', 'item');
  // "Tom" opens the first name; in the second it is a phrase's first word with
  // three more after it. Leading position is the distinguishing evidence.
  assert.equal(resolveEntityDetailed(db, 1, 'Tom').id, given);
});

test('the rule is dilution, not kind: a place can beat a person by dilution', () => {
  const db = bank();
  add(db, 'Asha Bell');
  const place = add(db, 'Asha', 'location');
  // Equal dilution and no kind preference would have to guess, so the exact
  // name wins on tier 1. This pins that the kind plays no part.
  assert.equal(resolveEntityDetailed(db, 1, 'Asha').id, place);
});

test('a short form never prefers a person over an equally diluted place', () => {
  const db = bank();
  add(db, 'Asha Brook', 'character');
  add(db, 'Asha Mere', 'location');
  const resolution = resolveEntityDetailed(db, 1, 'Asha');
  assert.equal(resolution.id, undefined, 'a person is not a better claimant than a place');
  assert.equal(resolution.method, 'short-collision');
});

test('a query longer than the names it matches is never short-form matched', () => {
  const db = bank();
  add(db, 'Harry Potter');
  // "Harry P" is two tokens, so the short-form tier does not apply at all.
  assert.equal(resolveEntityDetailed(db, 1, 'Harry P').id, undefined);
});

test('dilution does not break an ordinary exact name or alias', () => {
  const db = bank();
  const id = add(db, 'Ronald Weasley', 'character', ['Ron']);
  assert.equal(resolveEntityDetailed(db, 1, 'Ronald Weasley').id, id);
  assert.equal(resolveEntityDetailed(db, 1, 'Ron').id, id);
});
