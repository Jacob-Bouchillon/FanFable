/**
 * Extraction-side evidence canonicalization.
 *
 * verifySpan may accept case/punctuation/line-break-normalized evidence, but
 * the stored quote must be the actual contiguous raw source span so later
 * raw-exact consumers agree. Ambiguous spans fail closed.
 *
 * Temp databases only. Invented names and sentences.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { isVerbatimInChunk } from '../../fanfable/src/web/note-ingest.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

interface Chunk {
  id: number;
  seq: number;
  heading: string;
  locator: string;
  text: string;
  source_title: string;
  path: string;
  source_id: number;
}

function chunk(id: number, text: string): Chunk {
  return {
    id,
    seq: id,
    heading: '',
    locator: `p. ${id}`,
    text,
    source_title: 'Probe',
    path: '/probe',
    source_id: 1,
  };
}

function setup(name: string, text: string) {
  const { db, path } = tempDb();
  const project = createProject(db, name);
  const source = Number(
    db.run(
      `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
       VALUES (?, ?, ?, ?, ?)`,
      project.id,
      '/probe',
      'Probe',
      'sha-canon',
      AT,
    ).lastInsertRowid,
  );
  const firstChunk = Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, 1, 'p. 1', '', ?, ?)`,
      source,
      project.id,
      text,
      text.split(/\s+/).filter(Boolean).length,
    ).lastInsertRowid,
  );
  return { db, path, projectId: project.id, firstChunk, text };
}

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  evidence: string,
  chunkId: number,
  reviewStatus = 'accepted',
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, summary, attributes, role, status, first_chunk,
          evidence, source_refs, mentions, confidence, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '{}', '', '', ?, ?, ?, 1, 1, ?, ?, ?)`,
      projectId,
      name,
      chunkId,
      evidence,
      JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]),
      reviewStatus,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  evidence: string,
  chunkId: number,
  status = 'accepted',
  confirmedByUser = 0,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, confirmed_by_user, supporting_evidence, created_at)
       VALUES (?, ?, ?, 'sibling of', '', ?, ?, 1, ?, ?, '[]', ?)`,
      projectId,
      from,
      to,
      evidence,
      JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]),
      status,
      confirmedByUser,
      AT,
    ).lastInsertRowid,
  );
}

interface SplitParts {
  entities?: Record<string, unknown>[];
  facts?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
}

function splitMock(parts: SplitParts) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: parts.relations ?? [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: parts.timeline ?? [] });
    return JSON.stringify({ entities: parts.entities ?? [], facts: parts.facts ?? [] });
  });
}

async function run(fixture: ReturnType<typeof setup>, parts: SplitParts) {
  return lorebook.extractLore(fixture.db, splitMock(parts), fixture.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  });
}

const SOURCE = [
  'Serena Marsh watched the bridge.',
  'Kade was the brother of Serena Marsh.',
  'The bridge at Ardenne still stood.',
  'Three lights meant the bridge was held.',
].join('\n');

const ENTITIES = [
  {
    kind: 'character', name: 'Serena Marsh', aliases: [], summary: 'A watcher.', attributes: {},
    role: '', status: '', chunk_index: 0, evidence: 'serena marsh watched the bridge',
  },
  {
    kind: 'character', name: 'Kade', aliases: [], summary: 'A brother.', attributes: {},
    role: '', status: '', chunk_index: 0, evidence: 'kade',
  },
];

const RELATION = {
  from: 'Serena Marsh', to: 'Kade', kind: 'sibling of',
  description: 'Kade is the brother of Serena Marsh.', chunk_index: 0,
  evidence: 'kade was the brother of serena marsh',
};

const FACT = {
  topic: 'bridge', statement: 'The bridge at Ardenne still stood.', kind: 'fact',
  certainty: 'confirmed', subject: 'Serena Marsh', chunk_index: 0,
  evidence: 'the bridge at ardenne still stood',
};

const TIMELINE = {
  title: 'Serena watches the bridge', summary: 'She counts the lights.',
  when: 'the third day', participants: ['Serena Marsh'], location: 'the bridge',
  chunk_index: 0, evidence: 'three lights meant the bridge was held',
};

test('canonicalizes evidence for entities, relations, facts and timeline', async () => {
  const fixture = setup('canonical-all', SOURCE);
  const stats = await run(fixture, {
    entities: ENTITIES,
    facts: [FACT],
    relations: [RELATION],
    timeline: [TIMELINE],
  });
  assert.equal(stats.verification.claimed, 5);
  assert.equal(stats.verification.verified, 5);
  assert.equal(stats.verification.repointed, 0);
  assert.equal(stats.verification.dropped, 0);
  assert.equal(stats.entities, 2);
  assert.equal(stats.facts, 1);
  assert.equal(stats.relations, 1);
  assert.equal(stats.timeline, 1);

  const entity = fixture.db.get<{ evidence: string }>(
    "SELECT evidence FROM canon_entity WHERE project_id = ? AND name = 'Serena Marsh'",
    fixture.projectId,
  );
  assert.equal(entity?.evidence, 'Serena Marsh watched the bridge.');
  assert.ok(isVerbatimInChunk(fixture.text, entity!.evidence));

  const kade = fixture.db.get<{ evidence: string }>(
    "SELECT evidence FROM canon_entity WHERE project_id = ? AND name = 'Kade'",
    fixture.projectId,
  );
  assert.equal(kade?.evidence, 'Kade');
  assert.ok(isVerbatimInChunk(fixture.text, kade!.evidence));

  const relation = fixture.db.get<{ evidence: string }>(
    'SELECT evidence FROM canon_relation WHERE project_id = ?',
    fixture.projectId,
  );
  assert.equal(relation?.evidence, 'Kade was the brother of Serena Marsh.');
  assert.ok(isVerbatimInChunk(fixture.text, relation!.evidence));

  const fact = fixture.db.get<{ evidence: string }>(
    'SELECT evidence FROM canon_fact WHERE project_id = ?',
    fixture.projectId,
  );
  assert.equal(fact?.evidence, 'The bridge at Ardenne still stood.');
  assert.ok(isVerbatimInChunk(fixture.text, fact!.evidence));

  const timeline = fixture.db.get<{ evidence: string }>(
    'SELECT evidence FROM canon_timeline WHERE project_id = ?',
    fixture.projectId,
  );
  assert.equal(timeline?.evidence, 'Three lights meant the bridge was held.');
  assert.ok(isVerbatimInChunk(fixture.text, timeline!.evidence));
  fixture.db.close();
});

test('maps punctuation, case and whitespace differences to raw source spans', () => {
  const quoted = lorebook.verifySpan('Hello', chunk(1, '"Hello," she said.'));
  assert.equal(quoted.status, 'verified');
  assert.equal(quoted.quote, '"Hello,"');
  assert.ok(isVerbatimInChunk('"Hello," she said.', quoted.quote));

  const cased = lorebook.verifySpan('hello world', chunk(1, 'Hello world.'));
  assert.equal(cased.status, 'verified');
  assert.equal(cased.quote, 'Hello world.');
  assert.ok(isVerbatimInChunk('Hello world.', cased.quote));

  const spaced = lorebook.verifySpan('Hello world', chunk(1, 'Hello\nworld.'));
  assert.equal(spaced.status, 'verified');
  assert.equal(spaced.quote, 'Hello\nworld.');
  assert.ok(isVerbatimInChunk('Hello\nworld.', spaced.quote));

  const exact = lorebook.verifySpan('Hello world.', chunk(1, 'Hello world.'));
  assert.equal(exact.status, 'verified');
  assert.equal(exact.quote, 'Hello world.');
  assert.ok(isVerbatimInChunk('Hello world.', exact.quote));
});

test('ambiguous repeated phrase is dropped', () => {
  const result = lorebook.verifySpan('echo', chunk(1, 'Echo. ECHO.'));
  assert.equal(result.status, 'dropped');
  assert.equal(result.quote, '');
});

test('ambiguous neighbours are dropped, unique neighbour is repointed and canonicalized', () => {
  const cited = chunk(1, 'Nothing here.');
  const unique = lorebook.verifySpan('hello there', cited, [chunk(2, 'Hello there.')]);
  assert.equal(unique.status, 'repointed');
  assert.equal(unique.chunkId, 2);
  assert.equal(unique.quote, 'Hello there.');
  assert.ok(isVerbatimInChunk('Hello there.', unique.quote));

  const ambiguous = lorebook.verifySpan('hello there', cited, [
    chunk(2, 'Hello there.'),
    chunk(3, 'hello there.'),
  ]);
  assert.equal(ambiguous.status, 'dropped');
  assert.equal(ambiguous.quote, '');
});

test('fabricated continuation and partial-prefix-only quotes are dropped', () => {
  const fabricated = lorebook.verifySpan('Hello there and a purple dragon', chunk(1, 'Hello there.'));
  assert.equal(fabricated.status, 'dropped');
  assert.equal(fabricated.quote, '');

  const partial = lorebook.verifySpan('Hello there and more', chunk(1, 'Hello there.'));
  assert.equal(partial.status, 'dropped');
  assert.equal(partial.quote, '');
});

test('invalid candidate spans write no rows and update counters', async () => {
  const fixture = setup('canonical-invalid', SOURCE);
  addEntity(fixture.db, fixture.projectId, 'Serena Marsh', 'Serena Marsh watched the bridge.', fixture.firstChunk);
  addEntity(fixture.db, fixture.projectId, 'Kade', 'Kade', fixture.firstChunk);
  const beforeEntities = fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', fixture.projectId)!.n;
  const beforeRelations = fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', fixture.projectId)!.n;

  const stats = await run(fixture, {
    entities: [{
      kind: 'character', name: 'Mara Voss', aliases: [], summary: '', attributes: {},
      role: '', status: '', chunk_index: 0,
      evidence: 'Serena Marsh watched the bridge and then flew away',
    }],
    relations: [{
      from: 'Serena Marsh', to: 'Kade', kind: 'sibling of', description: '',
      chunk_index: 0, evidence: 'Kade was the brother of Serena Marsh and then vanished',
    }],
    facts: [{
      topic: 'bridge', statement: 'The bridge vanished.', kind: 'fact', certainty: 'confirmed',
      subject: 'Serena Marsh', chunk_index: 0,
      evidence: 'The bridge at Ardenne still stood and then vanished',
    }],
    timeline: [{
      title: 'The bridge vanished', summary: '', when: '', participants: ['Serena Marsh'],
      location: 'the bridge', chunk_index: 0,
      evidence: 'Three lights meant the bridge was held and then vanished',
    }],
  });
  assert.equal(stats.verification.claimed, 4);
  assert.equal(stats.verification.verified, 0);
  assert.equal(stats.verification.dropped, 4);
  assert.equal(stats.verification.unsupported, 1);
  assert.equal(stats.entities, 0);
  assert.equal(stats.relations, 0);
  assert.equal(stats.facts, 0);
  assert.equal(stats.timeline, 0);
  assert.equal(fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', fixture.projectId)!.n, beforeEntities);
  assert.equal(fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', fixture.projectId)!.n, beforeRelations);
  assert.equal(fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', fixture.projectId)!.n, 0);
  assert.equal(fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_timeline WHERE project_id = ?', fixture.projectId)!.n, 0);
  fixture.db.close();
});

test('ambiguous extraction candidate writes no row and increments dropped', async () => {
  const fixture = setup('canonical-ambiguous', 'Echo. ECHO.');
  const stats = await run(fixture, {
    entities: [{
      kind: 'character', name: 'Echo', aliases: [], summary: '', attributes: {},
      role: '', status: '', chunk_index: 0, evidence: 'echo',
    }],
  });
  assert.equal(stats.verification.claimed, 1);
  assert.equal(stats.verification.dropped, 1);
  assert.equal(stats.entities, 0);
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', fixture.projectId)!.n,
    0,
  );
  fixture.db.close();
});

test('invalid anchor is rejected without a relation row', async () => {
  const fixture = setup('canonical-anchor', SOURCE);
  addEntity(fixture.db, fixture.projectId, 'Serena Marsh', 'Serena Marsh watched the bridge.', fixture.firstChunk);
  addEntity(fixture.db, fixture.projectId, 'Kade', 'Kade', fixture.firstChunk);
  const stats = await run(fixture, {
    relations: [{
      from: 'Serena Marsh', to: 'Kade', kind: 'sibling of', description: '',
      chunk_index: 0,
      evidence: 'Kade was the brother of Serena Marsh.',
      anchor: 'This anchor is not in the source at all.',
    }],
  });
  assert.equal(stats.verification.claimed, 1);
  assert.equal(stats.verification.verified, 1);
  assert.equal(stats.verification.unsupported, 1);
  assert.equal(stats.relations, 0);
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', fixture.projectId)!.n,
    0,
  );
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', fixture.projectId)!.n,
    1,
  );
  fixture.db.close();
});

test('a rejected candidate does not overwrite accepted or user-confirmed rows', async () => {
  const fixture = setup('canonical-preserve', SOURCE);
  const serena = addEntity(fixture.db, fixture.projectId, 'Serena Marsh', 'Serena Marsh watched the bridge.', fixture.firstChunk);
  const kade = addEntity(fixture.db, fixture.projectId, 'Kade', 'Kade', fixture.firstChunk);
  const relation = addRelation(
    fixture.db,
    fixture.projectId,
    serena,
    kade,
    'Kade was the brother of Serena Marsh.',
    fixture.firstChunk,
    'user_confirmed',
    1,
  );
  const beforeEntity = fixture.db.get<{ evidence: string; review_status: string }>(
    'SELECT evidence, review_status FROM canon_entity WHERE id = ?',
    serena,
  );
  const beforeRelation = fixture.db.get<{ evidence: string; review_status: string; confirmed_by_user: number }>(
    'SELECT evidence, review_status, confirmed_by_user FROM canon_relation WHERE id = ?',
    relation,
  );

  const stats = await run(fixture, {
    entities: [{
      kind: 'character', name: 'Serena Marsh', aliases: [], summary: '', attributes: {},
      role: '', status: '', chunk_index: 0,
      evidence: 'Serena Marsh watched the bridge and then flew away',
    }],
    relations: [{
      from: 'Serena Marsh', to: 'Kade', kind: 'sibling of', description: '',
      chunk_index: 0, evidence: 'Kade was the brother of Serena Marsh and then vanished',
    }],
  });
  assert.equal(stats.verification.dropped, 2);
  assert.deepEqual(
    fixture.db.get<{ evidence: string; review_status: string }>(
      'SELECT evidence, review_status FROM canon_entity WHERE id = ?',
      serena,
    ),
    beforeEntity,
  );
  assert.deepEqual(
    fixture.db.get<{ evidence: string; review_status: string; confirmed_by_user: number }>(
      'SELECT evidence, review_status, confirmed_by_user FROM canon_relation WHERE id = ?',
      relation,
    ),
    beforeRelation,
  );
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM claim_proof WHERE project_id = ?', fixture.projectId)!.n,
    0,
  );
  fixture.db.close();
});
