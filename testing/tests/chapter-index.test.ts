/** Chapter index: word-boundary character appearances and reverse lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { chapterCharacters, characterChapters } from '../../fanfable/src/web/chapter-index.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(
  db: Db,
  projectId: number,
  name: string,
  aliases: string[] = [],
  kind = 'character',
): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId, kind, name, JSON.stringify(aliases), AT, AT,
  ).lastInsertRowid);
}

function source(db: Db, projectId: number): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/chapter-index', 'Chapter index', 'sha', AT,
  ).lastInsertRowid);
}

function chunk(
  db: Db,
  projectId: number,
  sourceId: number,
  seq: number,
  locator: string,
  heading: string,
  text: string,
): number {
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, projectId, seq, locator, heading, text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

test('characterChapters finds Harry, never Harriet, and keeps seq order', () => {
  const { db } = tempDb();
  const project = createProject(db, 'chapter-index');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry');
  entity(db, project.id, 'Harriet');
  const first = chunk(
    db,
    project.id,
    sourceId,
    1,
    'CHAPTER ONE (p. 1)',
    'CHAPTER ONE',
    'The zoo was loud. Harry went to the zoo. Hermione stayed home.',
  );
  chunk(db, project.id, sourceId, 2, 'CHAPTER TWO (p. 2)', 'CHAPTER TWO', 'Harriet went to the zoo.');
  const third = chunk(
    db,
    project.id,
    sourceId,
    3,
    'CHAPTER THREE (p. 3)',
    'CHAPTER THREE',
    'At school, Harry met Ron.',
  );

  const appearances = characterChapters(db, project.id, harry);
  assert.deepEqual(appearances.map((appearance) => appearance.chunkId), [first, third]);
  assert.deepEqual(appearances.map((appearance) => appearance.seq), [1, 3]);
  assert.equal(appearances[0]!.locator, 'CHAPTER ONE (p. 1)');
  assert.equal(appearances[0]!.heading, 'CHAPTER ONE');
  assert.equal(appearances[0]!.quote, 'Harry went to the zoo.');
  assert.ok(!appearances.some((appearance) => appearance.quote.includes('Harriet')));
  db.close();
});

test('possessive forms still match', () => {
  const { db } = tempDb();
  const project = createProject(db, 'chapter-possessive');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry');
  chunk(db, project.id, sourceId, 1, 'CHAPTER ONE (p. 1)', '', "Harry's owl arrived.");
  const appearances = characterChapters(db, project.id, harry);
  assert.equal(appearances.length, 1);
  assert.equal(appearances[0]!.quote, "Harry's owl arrived.");
  db.close();
});

test('aliases are indexed, including multi-word aliases', () => {
  const { db } = tempDb();
  const project = createProject(db, 'chapter-alias');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry', ['The Boy Who Lived']);
  chunk(
    db,
    project.id,
    sourceId,
    1,
    'CHAPTER ONE (p. 1)',
    '',
    'The Boy Who Lived was famous throughout the wizarding world.',
  );
  const appearances = characterChapters(db, project.id, harry);
  assert.equal(appearances.length, 1);
  assert.match(appearances[0]!.quote, /^The Boy Who Lived/);
  db.close();
});

test('chapterCharacters returns only character entities, in name order', () => {
  const { db } = tempDb();
  const project = createProject(db, 'chapter-faces');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry');
  const hermione = entity(db, project.id, 'Hermione');
  entity(db, project.id, 'Hogwarts', [], 'location');
  entity(db, project.id, 'wand', [], 'item');
  const passage = chunk(
    db,
    project.id,
    sourceId,
    1,
    'CHAPTER ONE (p. 1)',
    '',
    'Hermione and Harry went to Hogwarts with a wand.',
  );

  const faces = chapterCharacters(db, project.id, passage);
  assert.deepEqual(faces, [
    { entityId: harry, name: 'Harry', kind: 'character' },
    { entityId: hermione, name: 'Hermione', kind: 'character' },
  ]);
  db.close();
});
