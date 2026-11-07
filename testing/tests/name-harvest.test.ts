/** Name harvest: candidate filtering, classification validation and owner write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import {
  parseHarvestAnswer,
  planNameHarvest,
  validateHarvestClassification,
} from '../../fanfable/src/identity/name-harvest.ts';
import { insertEntityCandidate, insertOwnedCreatureRelation } from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string, aliases: string[] = []): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, JSON.stringify(aliases), AT, AT,
  ).lastInsertRowid);
}

function source(db: Db, projectId: number): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/harvest', 'Harvest', 'sha', AT,
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

test('candidate filtering drops possessives, contractions, dates, headings and banked names', () => {
  const { db } = tempDb();
  const project = createProject(db, 'harvest-filter');
  const sourceId = source(db, project.id);
  entity(db, project.id, 'Harry Potter');
  chunk(db, project.id, sourceId, 1, 'p. 1', '', "At the zoo, Marge's dog barked. Don't run, Harry.");
  chunk(db, project.id, sourceId, 2, 'p. 2', '', 'Monday morning was cold.');
  chunk(db, project.id, sourceId, 3, 'p. 3', '', 'At the table, Potter sat.');
  chunk(db, project.id, sourceId, 4, 'p. 4', 'The Boy Who Lived', 'The Boy Who Lived was famous.');
  chunk(db, project.id, sourceId, 5, 'p. 5', '', 'At the gate, Griphook waited.');
  chunk(db, project.id, sourceId, 6, 'p. 6', '', "Malfoy's eagle owl was always bringing him packages of sweets.");
  chunk(db, project.id, sourceId, 7, 'p. 7', '', "He's a centaur, not a pet.");

  const candidates = planNameHarvest(db, project.id, { limit: 50 });
  const surfaces = candidates.map((candidate) => candidate.surface);
  assert.ok(surfaces.includes('Marge'), 'possessive base is a candidate');
  assert.ok(surfaces.includes('Griphook'));
  assert.ok(surfaces.includes("Malfoy's eagle owl"), 'a possessive animal keeps the whole surface');
  assert.ok(!surfaces.includes("He's a centaur"), 'a pronoun contraction is not an owner');
  assert.ok(!surfaces.includes("Marge's"), 'the possessive surface is dropped');
  assert.ok(!surfaces.includes("Don't"), 'contractions are dropped');
  assert.ok(!surfaces.includes('Monday'), 'weekdays are dropped');
  assert.ok(!surfaces.includes('Potter'), 'a banked surname is dropped');
  assert.ok(!surfaces.includes('The Boy Who Lived'), 'chapter titles are dropped');
  db.close();
});

test('parseHarvestAnswer accepts the entities box and bare arrays, and none is a rejection', () => {
  const parsed = parseHarvestAnswer(JSON.stringify({
    entities: [
      { surface: 'Griphook', kind: 'character', name: 'Griphook', quote: 'At the gate, Griphook waited.', chunk_index: 0 },
      { surface: 'Gringotts', kind: 'none', name: '', quote: '', chunk_index: -1 },
      { surface: 'Bad', kind: 'character', name: 'Bad' },
    ],
  }));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]!.chunkIndex, 0);
  assert.equal(parsed[1]!.kind, 'none');

  const bare = parseHarvestAnswer(JSON.stringify([
    { surface: 'Marge', kind: 'character', name: 'Marge', quote: 'Aunt Marge arrived.', chunk_index: 1 },
  ]));
  assert.deepEqual(bare.map((entry) => entry.surface), ['Marge']);

  const candidate = {
    surface: 'Griphook',
    count: 1,
    firstChunkId: 1,
    firstLocator: 'p. 1',
    sentences: [],
  };
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Griphook', kind: 'none', name: '', quote: '', chunkIndex: -1 },
      candidate,
      { chunkId: 1, locator: 'p. 1', text: '', chunkText: '' },
      () => false,
    ),
    { ok: false, reason: 'none' },
  );
});

test('a quote must be verbatim and must contain the candidate surface', () => {
  const candidate = {
    surface: 'Griphook',
    count: 1,
    firstChunkId: 1,
    firstLocator: 'p. 1',
    sentences: [],
  };
  const sentence = {
    chunkId: 1,
    locator: 'p. 1',
    text: 'At the gate, Griphook waited. Someone else waited.',
    chunkText: 'At the gate, Griphook waited. Someone else waited.',
  };
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Griphook', kind: 'character', name: 'Griphook', quote: 'Griphook left.', chunkIndex: 0 },
      candidate, sentence, () => false,
    ),
    { ok: false, reason: 'quote-not-found' },
  );
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Griphook', kind: 'character', name: 'Griphook', quote: 'Someone else waited.', chunkIndex: 0 },
      candidate, sentence, () => false,
    ),
    { ok: false, reason: 'surface-not-in-quote' },
  );
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Griphook', kind: 'character', name: 'Griphook', quote: 'At the gate, Griphook waited.', chunkIndex: 0 },
      candidate, sentence, () => false,
    ),
    { ok: true, kind: 'character', name: 'Griphook', attributes: { sentient: null, speaks: null } },
  );
});

test('a reversed sorting-list surface is accepted under the proper name', () => {
  const candidate = {
    surface: 'Brown, Lavender',
    count: 1,
    firstChunkId: 1,
    firstLocator: 'p. 96',
    sentences: [],
  };
  const sentence = {
    chunkId: 1,
    locator: 'p. 96',
    text: '"Brown, Lavender" became the first new Gryffindor.',
    chunkText: '"Brown, Lavender" became the first new Gryffindor.',
  };
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Brown, Lavender', kind: 'character', name: 'Brown, Lavender', quote: '"Brown, Lavender" became the first new Gryffindor.', chunkIndex: 0 },
      candidate, sentence, () => false,
    ),
    { ok: true, kind: 'character', name: 'Lavender Brown', attributes: { sentient: null, speaks: null } },
  );
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Brown, Lavender!', kind: 'character', name: 'Brown, Lavender', quote: '"Brown, Lavender" became the first new Gryffindor.', chunkIndex: 0 },
      candidate, sentence, () => false,
    ),
    { ok: true, kind: 'character', name: 'Lavender Brown', attributes: { sentient: null, speaks: null } },
  );
});

test('a possessive animal is a creature named by the whole possessive surface', () => {
  const candidate = {
    surface: "Malfoy's eagle owl",
    count: 1,
    firstChunkId: 1,
    firstLocator: 'p. 115',
    sentences: [],
  };
  const text = "Malfoy's eagle owl was always bringing him packages of sweets from home.";
  assert.deepEqual(
    validateHarvestClassification(
      { surface: "Malfoy's eagle owl", kind: 'character', name: 'owl', quote: text, chunkIndex: 0 },
      candidate,
      { chunkId: 1, locator: 'p. 115', text, chunkText: text },
      () => false,
    ),
    { ok: true, kind: 'creature', name: "Malfoy's eagle owl", attributes: { sentient: null, speaks: null } },
  );
});

test('funnels refuse generic creatures, family groups, roles and subject items', () => {
  const candidate = (surface: string) => ({
    surface,
    count: 1,
    firstChunkId: 1,
    firstLocator: 'p. 1',
    sentences: [],
  });
  const sentence = (text: string) => ({ chunkId: 1, locator: 'p. 1', text, chunkText: text });

  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'owl', kind: 'creature', name: 'owl', quote: 'A large owl flew past.', chunkIndex: 0 },
      candidate('owl'), sentence('A large owl flew past.'), () => false, () => false, () => true,
    ),
    { ok: false, reason: 'generic-noun' },
  );
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'owls', kind: 'species', name: 'owls', quote: 'The owls flew past.', chunkIndex: 0 },
      candidate('owls'), sentence('The owls flew past.'), () => false,
    ),
    {
      ok: true,
      kind: 'species',
      name: 'owls',
      attributes: { sentient: null, speaks: null },
    },
  );
  const role = validateHarvestClassification(
    { surface: 'Chasers', kind: 'none', category: 'role', name: 'Chasers', quote: 'Three of them are called Chasers.', chunkIndex: 0 },
    candidate('Chasers'), sentence('Three of them are called Chasers.'), () => false,
  );
  assert.equal(role.ok, false);
  assert.equal(role.ok ? '' : role.reason, 'category');
  assert.equal(role.ok ? '' : role.category, 'role');
  const discipline = validateHarvestClassification(
    { surface: 'Potions', kind: 'item', category: 'discipline', name: 'Potions', quote: 'Magical Drafts and Potions by Arsenius Jigger', chunkIndex: 0 },
    candidate('Potions'), sentence('Magical Drafts and Potions by Arsenius Jigger'), () => false,
  );
  assert.equal(discipline.ok, false);
  assert.equal(discipline.ok ? '' : discipline.reason, 'category');
  assert.equal(discipline.ok ? '' : discipline.category, 'discipline');
  const animal = validateHarvestClassification(
    { surface: 'owl', kind: 'none', category: 'animal', name: 'owl', quote: 'A large owl flew past.', chunkIndex: 0 },
    candidate('owl'), sentence('A large owl flew past.'), () => false, () => false, () => true,
  );
  assert.deepEqual(animal, {
    ok: true,
    kind: 'species',
    name: 'owl',
    category: 'animal',
    attributes: { sentient: null, speaks: null },
  });
  const namedAnimal = validateHarvestClassification(
    { surface: 'Hedwig', kind: 'creature', category: 'animal', name: 'Hedwig', quote: 'He called her Hedwig.', chunkIndex: 0 },
    candidate('Hedwig'), sentence('He called her Hedwig.'), () => false, () => false, () => false,
  );
  assert.deepEqual(namedAnimal, {
    ok: true,
    kind: 'creature',
    name: 'Hedwig',
    category: 'animal',
    attributes: { sentient: null, speaks: null },
  });
  assert.deepEqual(
    validateHarvestClassification(
      { surface: 'Potters', kind: 'character', name: 'Potters', quote: 'They found out about the Potters.', chunkIndex: 0 },
      candidate('Potters'), sentence('They found out about the Potters.'), () => false, () => true,
    ),
    { ok: false, reason: 'group-not-person' },
  );
});

test('an owned creature gets one needs_review owner-of relation', () => {
  const { db } = tempDb();
  const project = createProject(db, 'harvest-owner');
  const sourceId = source(db, project.id);
  const chunkId = chunk(db, project.id, sourceId, 1, 'p. 115', '', "Malfoy's eagle owl was always bringing him packages of sweets.");
  const ownerId = entity(db, project.id, 'Draco Malfoy');
  const creatureId = insertEntityCandidate(db, project.id, {
    kind: 'creature',
    name: "Malfoy's eagle owl",
    evidence: "Malfoy's eagle owl was always bringing him packages of sweets.",
    firstChunk: chunkId,
    sourceRefs: JSON.stringify([{ locator: 'p. 115', chunk: chunkId }]),
  })!;
  assert.ok(creatureId);

  const refs = JSON.stringify([{ locator: 'p. 115', chunk: chunkId }]);
  const first = insertOwnedCreatureRelation(
    db, project.id, ownerId, creatureId,
    "Malfoy's eagle owl was always bringing him packages of sweets.", refs,
  );
  const second = insertOwnedCreatureRelation(
    db, project.id, ownerId, creatureId,
    "Malfoy's eagle owl was always bringing him packages of sweets.", refs,
  );
  assert.equal(first, second);
  const relations = db.all<{ from_entity: number; to_entity: number; kind: string; review_status: string }>(
    'SELECT from_entity, to_entity, kind, review_status FROM canon_relation WHERE project_id = ?',
    project.id,
  );
  assert.equal(relations.length, 1);
  assert.equal(relations[0]!.from_entity, ownerId);
  assert.equal(relations[0]!.to_entity, creatureId);
  assert.equal(relations[0]!.kind, 'owner of');
  assert.equal(relations[0]!.review_status, 'needs_review');
  db.close();
});

test('insertEntityCandidate writes needs_review and a name-harvest ruling idempotently', () => {
  const { db } = tempDb();
  const project = createProject(db, 'harvest-write');
  const sourceId = source(db, project.id);
  const chunkId = chunk(db, project.id, sourceId, 1, 'p. 1', '', 'At the gate, Griphook waited.');

  const insert = (): number | null => insertEntityCandidate(db, project.id, {
    kind: 'character',
    name: 'Griphook',
    evidence: 'At the gate, Griphook waited.',
    firstChunk: chunkId,
    sourceRefs: JSON.stringify([{ locator: 'p. 1', chunk: chunkId }]),
  });

  const first = insert();
  assert.ok(first);
  const row = db.get<{
    kind: string;
    name: string;
    aliases: string;
    review_status: string;
    evidence: string;
    first_chunk: number;
    source_refs: string;
  }>('SELECT kind, name, aliases, review_status, evidence, first_chunk, source_refs FROM canon_entity WHERE id = ?', first)!;
  assert.equal(row.kind, 'character');
  assert.equal(row.name, 'Griphook');
  assert.equal(row.aliases, '[]');
  assert.equal(row.review_status, 'needs_review');
  assert.equal(row.evidence, 'At the gate, Griphook waited.');
  assert.equal(row.first_chunk, chunkId);
  assert.match(row.source_refs, /p\. 1/);

  const ruling = db.get<{ actor: string; basis: string; subject: string }>(
    'SELECT actor, basis, subject FROM canon_ruling WHERE project_id = ? ORDER BY id LIMIT 1',
    project.id,
  )!;
  assert.equal(ruling.actor, 'name-harvest');
  assert.equal(ruling.basis, 'harvested character');
  assert.equal(ruling.subject, `entity:${first}`);

  assert.equal(insert(), null);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)!.n,
    1,
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling WHERE project_id = ?', project.id)!.n,
    1,
  );
  db.close();
});
