/** Character sweep: planning, validation, parsing and application. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import {
  applySweep,
  batchSweepPassages,
  parseSweepAnswer,
  planSweep,
  sweepRelationKey,
  validateSweepTie,
  validateSweepTies,
  SWEEP_KINDS,
  type SweepTie,
} from '../../fanfable/src/web/character-sweep.ts';
import { mockProvider, tempDb } from './helpers.ts';

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
    projectId, '/sweep', 'Sweep', 'sha', AT,
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

function seed(): {
  db: Db;
  projectId: number;
  harry: number;
  ron: number;
  hermione: number;
  neville: number;
  first: number;
  second: number;
  third: number;
} {
  const { db } = tempDb();
  const project = createProject(db, 'character-sweep');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry', ['The Boy Who Lived']);
  const ron = entity(db, project.id, 'Ron');
  const hermione = entity(db, project.id, 'Hermione');
  const neville = entity(db, project.id, 'Neville');
  entity(db, project.id, 'Hogwarts', [], 'location');

  const first = chunk(db, project.id, sourceId, 1, 'CHAPTER ONE (p. 1)', 'CHAPTER ONE', 'Harry and Ron went to the zoo.');
  const second = chunk(db, project.id, sourceId, 2, 'CHAPTER TWO (p. 2)', 'CHAPTER TWO', 'Harry slept all afternoon.');
  const third = chunk(db, project.id, sourceId, 3, 'CHAPTER THREE (p. 3)', 'CHAPTER THREE', 'Harry and Hermione studied together.');
  chunk(db, project.id, sourceId, 4, 'CHAPTER FOUR (p. 4)', 'CHAPTER FOUR', 'Neville lost his toad.');
  chunk(db, project.id, sourceId, 5, 'CHAPTER FIVE (p. 5)', 'CHAPTER FIVE', 'Neville found his toad.');

  return { db, projectId: project.id, harry, ron, hermione, neville, first, second, third };
}

function knownFor(fixture: ReturnType<typeof seed>): Map<string, number> {
  return new Map([
    ['harry', fixture.harry],
    ['the boy who lived', fixture.harry],
    ['ron', fixture.ron],
    ['hermione', fixture.hermione],
    ['neville', fixture.neville],
  ]);
}

test('planning selects an appearing character and skips one below the threshold', () => {
  const fixture = seed();
  const targets = planSweep(fixture.db, fixture.projectId, { minAppearances: 3, maxPassages: 2 });
  assert.deepEqual(targets.map((target) => target.entityId), [fixture.harry]);
  assert.equal(targets[0]!.name, 'Harry');
  assert.equal(targets[0]!.passages.length, 2);
  assert.deepEqual(targets[0]!.passages.map((passage) => passage.chunkId), [fixture.first, fixture.third]);
  assert.match(targets[0]!.passages[0]!.text, /Ron/);
  assert.match(targets[0]!.passages[1]!.text, /Hermione/);
  fixture.db.close();
});

test('cast resolves names and aliases and bypasses the appearance threshold', () => {
  const fixture = seed();
  const byAlias = planSweep(fixture.db, fixture.projectId, {
    cast: ['The Boy Who Lived'],
    minAppearances: 99,
    maxPassages: 5,
  });
  assert.deepEqual(byAlias.map((target) => target.entityId), [fixture.harry]);

  const neville = planSweep(fixture.db, fixture.projectId, {
    cast: ['Neville'],
    minAppearances: 99,
    maxPassages: 5,
  });
  assert.deepEqual(neville.map((target) => target.entityId), [fixture.neville]);
  assert.equal(neville[0]!.passages.length, 2);
  fixture.db.close();
});

test('a short cast name resolves a full name and retrieves short-form passages', () => {
  const { db } = tempDb();
  const project = createProject(db, 'sweep-cast-short');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry Potter');
  const onlyShort = chunk(db, project.id, sourceId, 1, 'CHAPTER ONE (p. 1)', '', 'Harry went home.');
  const fullName = chunk(db, project.id, sourceId, 2, 'CHAPTER TWO (p. 2)', '', 'Harry Potter went home.');

  const targets = planSweep(db, project.id, { cast: ['Harry'], maxPassages: 5 });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.entityId, harry);
  assert.deepEqual(
    targets[0]!.passages.map((passage) => passage.chunkId).sort((a, b) => a - b),
    [onlyShort, fullName].sort((a, b) => a - b),
  );
  db.close();
});

test('validation rejects unknown people, self, missing quotes, bad kinds and duplicates', () => {
  const fixture = seed();
  const target = planSweep(fixture.db, fixture.projectId, { cast: ['Harry'], maxPassages: 5 })[0]!;
  const known = knownFor(fixture);
  const quote = 'Harry and Ron went to the zoo.';

  assert.deepEqual(
    validateSweepTie({} as SweepTie, target, target.passages, known, SWEEP_KINDS, new Set()),
    { ok: false, reason: 'bad-shape' },
  );
  assert.deepEqual(
    validateSweepTie(
      { other: 'Draco', kind: 'friend of', direction: 'out', quote, chunkIndex: 0 },
      target, target.passages, known, SWEEP_KINDS, new Set(),
    ),
    { ok: false, reason: 'unknown-other' },
  );
  assert.deepEqual(
    validateSweepTie(
      { other: 'Harry', kind: 'friend of', direction: 'out', quote, chunkIndex: 0 },
      target, target.passages, known, SWEEP_KINDS, new Set(),
    ),
    { ok: false, reason: 'self' },
  );
  assert.deepEqual(
    validateSweepTie(
      { other: 'Ron', kind: 'friend of', direction: 'out', quote: 'Ron went home.', chunkIndex: 0 },
      target, target.passages, known, SWEEP_KINDS, new Set(),
    ),
    { ok: false, reason: 'quote-not-found' },
  );
  const quirrellPassage = {
    chunkId: 999,
    locator: 'TEST (p. 1)',
    seq: 999,
    text: '"You don\'t want me as your enemy, Quirrell,"',
  };
  const snapeTarget = {
    entityId: 10,
    name: 'Snape',
    aliases: [],
    passages: [quirrellPassage],
  };
  const snapeKnown = new Map([
    ['snape', 10],
    ['harry', 20],
    ['harry potter', 20],
    ['quirrell', 30],
  ]);
  assert.deepEqual(
    validateSweepTie(
      { other: 'Harry', kind: 'distrusted', direction: 'in', quote: '"You don\'t want me as your enemy, Quirrell,"', chunkIndex: 0 },
      snapeTarget, [quirrellPassage], snapeKnown, SWEEP_KINDS, new Set(),
    ),
    { ok: false, reason: 'names-not-both' },
  );

  const pronounPassage = {
    chunkId: 1000,
    locator: 'TEST (p. 2)',
    seq: 1000,
    text: 'Harry went to the zoo. Ron was there.',
  };
  assert.deepEqual(
    validateSweepTie(
      { other: 'Ron', kind: 'friend of', direction: 'out', quote: 'Harry went to the zoo.', chunkIndex: 0 },
      target, [pronounPassage], known, SWEEP_KINDS, new Set(),
    ),
    { ok: false, reason: 'names-not-both' },
  );

  assert.deepEqual(
    validateSweepTie(
      { other: 'Ron', kind: 'gossip', direction: 'out', quote, chunkIndex: 0 },
      target, target.passages, known, SWEEP_KINDS, new Set(),
    ),
    { ok: false, reason: 'kind-not-allowed' },
  );
  assert.deepEqual(
    validateSweepTie(
      { other: 'Ron', kind: 'friend of', direction: 'out', quote, chunkIndex: 0 },
      target,
      target.passages,
      known,
      SWEEP_KINDS,
      new Set([sweepRelationKey(fixture.harry, fixture.ron, 'friend of')]),
    ),
    { ok: false, reason: 'duplicate' },
  );
  assert.deepEqual(
    validateSweepTie(
      { other: 'Ron', kind: 'friend of', direction: 'out', quote, chunkIndex: 0 },
      target, target.passages, known, SWEEP_KINDS, new Set(),
    ),
    { ok: true, toId: fixture.ron },
  );
  fixture.db.close();
});

test('parseSweepAnswer reads wrapped and bare answers through a mock provider', async () => {
  const provider = mockProvider(() => JSON.stringify({
    ties: [
      { other: 'Ron', kind: 'friend of', direction: 'out', quote: 'q', chunk_index: 0, reason: 'ok' },
      { other: '', kind: 'friend of', direction: 'out', quote: 'q', chunk_index: 0 },
      { other: 'Ron', kind: 'friend of', direction: 'sideways', quote: 'q', chunk_index: 0 },
    ],
  }));
  const response = await provider.chat({ messages: [{ role: 'user', content: 'sweep' }] });
  const parsed = parseSweepAnswer(response.text);
  assert.deepEqual(parsed, [
    { other: 'Ron', kind: 'friend of', direction: 'out', quote: 'q', chunkIndex: 0, reason: 'ok' },
  ]);

  const bare = parseSweepAnswer(JSON.stringify([
    { other: 'Hermione', kind: 'mentor of', direction: 'in', quote: 'q', chunkIndex: 1 },
  ]));
  assert.deepEqual(bare, [
    { other: 'Hermione', kind: 'mentor of', direction: 'in', quote: 'q', chunkIndex: 1 },
  ]);
});

test('applySweep dry-runs without writing, then writes relations and rulings idempotently', () => {
  const fixture = seed();
  const target = planSweep(fixture.db, fixture.projectId, { cast: ['Harry'], maxPassages: 5 })[0]!;
  const ties: SweepTie[] = [
    {
      other: 'Ron',
      kind: 'friend of',
      direction: 'out',
      quote: 'Harry and Ron went to the zoo.',
      chunkIndex: target.passages.findIndex((passage) => passage.chunkId === fixture.first),
      reason: 'went together',
    },
    {
      other: 'Hermione',
      kind: 'mentor of',
      direction: 'in',
      quote: 'Harry and Hermione studied together.',
      chunkIndex: target.passages.findIndex((passage) => passage.chunkId === fixture.third),
      reason: 'studied together',
    },
  ];

  const dry = applySweep(fixture.db, fixture.projectId, target, ties, { dryRun: true });
  assert.deepEqual(dry, { added: 2, duplicates: 0, rejected: 0, byReason: {} });
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', fixture.projectId)!.n,
    0,
  );
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling WHERE project_id = ?', fixture.projectId)!.n,
    0,
  );

  const written = applySweep(fixture.db, fixture.projectId, target, ties, { dryRun: false });
  assert.deepEqual(written, { added: 2, duplicates: 0, rejected: 0, byReason: {} });

  const rows = fixture.db.all<{ from_entity: number; to_entity: number; kind: string; review_status: string }>(
    'SELECT from_entity, to_entity, kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    fixture.projectId,
  );
  assert.deepEqual(rows.map((row) => [row.from_entity, row.to_entity, row.kind, row.review_status]), [
    [fixture.harry, fixture.ron, 'friend of', 'needs_review'],
    [fixture.hermione, fixture.harry, 'mentor of', 'needs_review'],
  ]);
  const rulings = fixture.db.all<{ actor: string; basis: string }>(
    'SELECT actor, basis FROM canon_ruling WHERE project_id = ? ORDER BY id',
    fixture.projectId,
  );
  assert.deepEqual(rulings.map((ruling) => [ruling.actor, ruling.basis]), [
    ['bank', 'inserted friend of'],
    ['bank', 'inserted mentor of'],
  ]);

  const second = applySweep(fixture.db, fixture.projectId, target, ties, { dryRun: false });
  assert.deepEqual(second, { added: 0, duplicates: 2, rejected: 0, byReason: { duplicate: 2 } });
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', fixture.projectId)!.n,
    2,
  );
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling WHERE project_id = ?', fixture.projectId)!.n,
    2,
  );
  fixture.db.close();
});

test('within-batch duplicates are rejected after the first accepted tie', () => {
  const fixture = seed();
  const target = planSweep(fixture.db, fixture.projectId, { cast: ['Harry'], maxPassages: 5 })[0]!;
  const tie: SweepTie = {
    other: 'Ron',
    kind: 'friend of',
    direction: 'out',
    quote: 'Harry and Ron went to the zoo.',
    chunkIndex: target.passages.findIndex((passage) => passage.chunkId === fixture.first),
  };
  const counts = applySweep(fixture.db, fixture.projectId, target, [tie, tie], { dryRun: true });
  assert.deepEqual(counts, { added: 1, duplicates: 1, rejected: 0, byReason: { duplicate: 1 } });
  fixture.db.close();
});

test('batchSweepPassages splits in sixes and preserves order', () => {
  const passages = Array.from({ length: 13 }, (_, index) => ({
    chunkId: index + 1,
    locator: `p. ${index + 1}`,
    seq: index,
    text: `passage ${index + 1}`,
  }));
  const batches = batchSweepPassages(passages, 6);
  assert.deepEqual(batches.map((batch) => batch.length), [6, 6, 1]);
  assert.deepEqual(batches.flat().map((passage) => passage.chunkId), passages.map((passage) => passage.chunkId));
});

test('batched validation unions accepted ties and dedupes across batches', () => {
  const fixture = seed();
  const target = planSweep(fixture.db, fixture.projectId, { cast: ['Harry'], maxPassages: 5 })[0]!;
  const known = knownFor(fixture);
  const existing = new Set<string>();
  const ronTie: SweepTie = {
    other: 'Ron',
    kind: 'friend of',
    direction: 'out',
    quote: 'Harry and Ron went to the zoo.',
    chunkIndex: target.passages.findIndex((passage) => passage.chunkId === fixture.first),
  };
  const hermioneTie: SweepTie = {
    other: 'Hermione',
    kind: 'mentor of',
    direction: 'in',
    quote: 'Harry and Hermione studied together.',
    chunkIndex: target.passages.findIndex((passage) => passage.chunkId === fixture.third),
  };

  const first = validateSweepTies([ronTie], target, known, existing);
  const second = validateSweepTies([hermioneTie], target, known, existing);
  assert.deepEqual(
    [...first.proposals, ...second.proposals].map((proposal) => proposal.tie.other),
    ['Ron', 'Hermione'],
  );

  const repeated = validateSweepTies([ronTie], target, known, existing);
  assert.equal(repeated.proposals.length, 0);
  assert.equal(repeated.rejections.length, 1);
  assert.equal(repeated.rejections[0]!.reason, 'duplicate');
  fixture.db.close();
});
