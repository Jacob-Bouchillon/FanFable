/**
 * Legacy singlePrompt extraction must enforce the same full-span evidence
 * standard as the split extractor. The old lenient six-word prefix path is
 * gone: a fabricated continuation never becomes a source-verified row.
 *
 * Temp databases only. Quotes are from the sample book fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { isVerbatimInChunk } from '../../fanfable/src/web/note-ingest.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const AT = '2024-01-01T00:00:00.000Z';
const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';
const FACT_QUOTE = 'the bridge at Ardenne still stood';
const CANON_SERENA = 'Serena Marsh watched it from the ridge,';
const LEDGER_QUOTE = 'Ilsa Marrow had been entered in it';
const FABRICATED_QUOTE =
  'The rain had not stopped for a purple dragon that never appears';
const PARTIAL_QUOTE = 'The rain had not stopped for three days and more';

type Db = ReturnType<typeof tempDb>['db'];

interface Parts {
  entities?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
  facts?: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
}

const SERENA = {
  kind: 'character',
  name: 'Serena Marsh',
  aliases: [],
  summary: 'A woman who watches the bridge.',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence: SERENA_QUOTE,
};

const KADE = {
  kind: 'character',
  name: 'Kade',
  aliases: [],
  summary: 'A frightened man.',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence: KADE_QUOTE,
};

function extractionMock(parts: Parts) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system === lorebook.EXTRACT_SYSTEM) return JSON.stringify(parts);
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: parts.relations ?? [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: parts.timeline ?? [] });
    return JSON.stringify({ entities: parts.entities ?? [], facts: parts.facts ?? [] });
  });
}

async function run(
  fixture: ReturnType<typeof seedProject>,
  db: Db,
  parts: Parts,
  singlePrompt: boolean,
) {
  return lorebook.extractLore(db, extractionMock(parts), fixture.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    singlePrompt,
  });
}

function count(db: Db, table: string, projectId: number): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0);
}

function namedEntity(db: Db, projectId: number, name: string) {
  return db.get<{
    id: number;
    evidence: string;
    source_refs: string;
    review_status: string;
    first_chunk: number | null;
  }>('SELECT id, evidence, source_refs, review_status, first_chunk FROM canon_entity WHERE project_id = ? AND name = ?', projectId, name);
}

function citedChunk(db: Db, refs: string): number | null {
  try {
    const first = JSON.parse(refs || '[]')[0] as { chunk?: unknown } | undefined;
    const id = Number(first?.chunk);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function chunkText(db: Db, id: number | null): string {
  return id === null ? '' : String(db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', id)?.text ?? '');
}

function fabricatedParts(): Parts {
  return {
    entities: [
      SERENA,
      KADE,
      {
        kind: 'character',
        name: 'Ghost Person',
        aliases: [],
        summary: 'Invented.',
        attributes: {},
        role: '',
        status: '',
        chunk_index: 0,
        evidence: FABRICATED_QUOTE,
      },
    ],
    relations: [
      {
        from: 'Serena Marsh',
        to: 'Kade',
        kind: 'accompanied by',
        description: 'Kade follows her.',
        chunk_index: 0,
        evidence: FABRICATED_QUOTE,
      },
    ],
    facts: [
      {
        topic: 'the rain',
        statement: 'The rain was magical.',
        kind: 'fact',
        certainty: 'confirmed',
        subject: 'Serena Marsh',
        chunk_index: 0,
        evidence: FABRICATED_QUOTE,
      },
    ],
    timeline: [
      {
        title: 'A fabricated event',
        summary: 'Nothing happened.',
        when: 'later',
        participants: ['Serena Marsh'],
        location: 'the ridge',
        chunk_index: 0,
        evidence: FABRICATED_QUOTE,
      },
    ],
  };
}

test('legacy singlePrompt rejects a six-word prefix with a fabricated tail for all four claim types', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-fabricated-all');
  const stats = await run(project, db, fabricatedParts(), true);

  assert.equal(stats.verification.claimed, 6);
  assert.equal(stats.verification.verified, 2);
  assert.equal(stats.verification.repointed, 0);
  assert.equal(stats.verification.dropped, 4);
  assert.equal(stats.verification.unsupported, 1);

  assert.equal(count(db, 'canon_entity', project.id), 2);
  assert.equal(count(db, 'canon_relation', project.id), 0);
  assert.equal(count(db, 'canon_fact', project.id), 0);
  assert.equal(count(db, 'canon_timeline', project.id), 0);
  assert.equal(count(db, 'canon_tie_hint', project.id), 0);
  assert.equal(count(db, 'claim_proof', project.id), 0);
  assert.equal(namedEntity(db, project.id, 'Ghost Person'), undefined);
  assert.equal(namedEntity(db, project.id, 'Serena Marsh')?.review_status, 'needs_review');

  const note = db.get<{ reason: string }>('SELECT reason FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.equal(note?.reason, 'unsupported-citation', 'the rejected relation remains an explicitly unverified note');
  db.close();
});

test('legacy singlePrompt stores and canonicalizes valid full quotes for all four claim types', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-valid-all');
  const parts: Parts = {
    entities: [SERENA, KADE],
    relations: [
      {
        from: 'Serena Marsh',
        to: 'Kade',
        kind: 'accompanied by',
        description: 'Kade follows her.',
        chunk_index: 0,
        evidence: SERENA_QUOTE.toLowerCase(),
      },
    ],
    facts: [
      {
        topic: 'the bridge',
        statement: 'The bridge still stood.',
        kind: 'fact',
        certainty: 'confirmed',
        subject: 'Serena Marsh',
        chunk_index: 0,
        evidence: FACT_QUOTE.toLowerCase(),
      },
    ],
    timeline: [
      {
        title: 'Serena watches the bridge',
        summary: 'She watches from the ridge.',
        when: 'during the rain',
        participants: ['Serena Marsh'],
        location: 'the ridge',
        chunk_index: 0,
        evidence: SERENA_QUOTE.toLowerCase(),
      },
    ],
  };
  const stats = await run(project, db, parts, true);

  assert.equal(stats.verification.claimed, 5);
  assert.equal(stats.verification.verified, 5);
  assert.equal(stats.verification.repointed, 0);
  assert.equal(stats.verification.dropped, 0);
  assert.equal(stats.entities, 2);
  assert.equal(stats.relations, 1);
  assert.equal(stats.facts, 1);
  assert.equal(stats.timeline, 1);

  const serena = namedEntity(db, project.id, 'Serena Marsh')!;
  assert.equal(serena.evidence, CANON_SERENA);
  assert.ok(isVerbatimInChunk(chunkText(db, citedChunk(db, serena.source_refs)), serena.evidence));

  const relation = db.get<{ evidence: string; source_refs: string }>(
    'SELECT evidence, source_refs FROM canon_relation WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(relation.evidence, CANON_SERENA);
  assert.ok(isVerbatimInChunk(chunkText(db, citedChunk(db, relation.source_refs)), relation.evidence));

  const fact = db.get<{ evidence: string; source_refs: string }>(
    'SELECT evidence, source_refs FROM canon_fact WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(fact.evidence, 'the bridge at Ardenne still stood.');
  assert.ok(isVerbatimInChunk(chunkText(db, citedChunk(db, fact.source_refs)), fact.evidence));

  const timeline = db.get<{ evidence: string; source_refs: string }>(
    'SELECT evidence, source_refs FROM canon_timeline WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(timeline.evidence, CANON_SERENA);
  assert.ok(isVerbatimInChunk(chunkText(db, citedChunk(db, timeline.source_refs)), timeline.evidence));
  assert.equal(count(db, 'claim_proof', project.id), 0);
  db.close();
});

test('legacy and split paths enforce the same standard on the same payload', async () => {
  const legacyFixture = tempDb();
  const splitFixture = tempDb();
  const legacyProject = seedProject(legacyFixture.db, 'legacy-compare');
  const splitProject = seedProject(splitFixture.db, 'split-compare');

  const legacy = await run(legacyProject, legacyFixture.db, fabricatedParts(), true);
  const split = await run(splitProject, splitFixture.db, fabricatedParts(), false);

  const pick = (s: typeof legacy) => ({
    claimed: s.verification.claimed,
    verified: s.verification.verified,
    repointed: s.verification.repointed,
    dropped: s.verification.dropped,
    unsupported: s.verification.unsupported,
    entities: s.entities,
    relations: s.relations,
    facts: s.facts,
    timeline: s.timeline,
  });
  assert.deepEqual(pick(legacy), pick(split));
  assert.deepEqual(
    ['canon_entity', 'canon_relation', 'canon_fact', 'canon_timeline', 'canon_tie_hint', 'claim_proof'].map((t) =>
      count(legacyFixture.db, t, legacyProject.id),
    ),
    ['canon_entity', 'canon_relation', 'canon_fact', 'canon_timeline', 'canon_tie_hint', 'claim_proof'].map((t) =>
      count(splitFixture.db, t, splitProject.id),
    ),
  );
  assert.equal(namedEntity(legacyFixture.db, legacyProject.id, 'Ghost Person'), undefined);
  assert.equal(namedEntity(splitFixture.db, splitProject.id, 'Ghost Person'), undefined);
  legacyFixture.db.close();
  splitFixture.db.close();
});

test('unresolved relation without a chunk cannot persist raw evidence as a hint', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-unresolved-no-chunk');
  const stats = await run(
    project,
    db,
    {
      entities: [SERENA, KADE],
      relations: [
        {
          from: 'Ghost Alpha',
          to: 'Ghost Beta',
          kind: 'ally of',
          description: '',
          chunk_index: 99,
          evidence: FABRICATED_QUOTE,
        },
      ],
    },
    true,
  );

  assert.equal(stats.verification.unresolved, 1);
  assert.equal(stats.verification.hinted, 0);
  assert.equal(count(db, 'canon_tie_hint', project.id), 0);
  assert.equal(count(db, 'canon_relation', project.id), 0);
  assert.equal(count(db, 'claim_proof', project.id), 0);
  db.close();
});

test('invalid relation anchor is rejected without a relation row', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-anchor-reject');
  const stats = await run(
    project,
    db,
    {
      entities: [SERENA, KADE],
      relations: [
        {
          from: 'Serena Marsh',
          to: 'Kade',
          kind: 'accompanied by',
          description: 'Kade follows her.',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
          anchor: 'A fabricated anchor that never appears',
        },
      ],
    },
    true,
  );

  assert.equal(stats.verification.unsupported, 1);
  assert.equal(count(db, 'canon_relation', project.id), 0);
  assert.equal(count(db, 'claim_proof', project.id), 0);
  const note = db.get<{ reason: string }>('SELECT reason FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.equal(note?.reason, 'unsupported-citation');
  db.close();
});

test('a full quote in a neighbouring chunk is repointed and canonicalized', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-repoint');
  const stats = await run(
    project,
    db,
    {
      entities: [
        {
          kind: 'character',
          name: 'Ilsa Marrow',
          aliases: [],
          summary: 'A woman in the ledger.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: LEDGER_QUOTE,
        },
      ],
    },
    true,
  );

  assert.equal(stats.verification.repointed, 1);
  const ilsa = namedEntity(db, project.id, 'Ilsa Marrow')!;
  const chunkId = citedChunk(db, ilsa.source_refs);
  const expected = db.get<{ id: number }>(
    'SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1 OFFSET 2',
    project.id,
  )!;
  assert.equal(chunkId, expected.id);
  assert.ok(isVerbatimInChunk(chunkText(db, chunkId), ilsa.evidence));
  db.close();
});

test('a partial-prefix-only quote is dropped', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-partial-prefix');
  const stats = await run(
    project,
    db,
    {
      entities: [
        {
          kind: 'character',
          name: 'Ghost Person',
          aliases: [],
          summary: 'Invented.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: PARTIAL_QUOTE,
        },
      ],
    },
    true,
  );

  assert.equal(stats.verification.claimed, 1);
  assert.equal(stats.verification.dropped, 1);
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(count(db, 'claim_proof', project.id), 0);
  db.close();
});

test('rejected candidates leave accepted and user-confirmed rows untouched', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'legacy-preserve-existing');
  const chunk = db.get<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1',
    project.id,
  )!;
  const source = db.get<{ title: string }>('SELECT title FROM canon_source WHERE project_id = ?', project.id)!;
  const refs = JSON.stringify([{ source: source.title, locator: chunk.locator, chunk: chunk.id }]);

  const serena = Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status, first_chunk,
          evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, 'ent-protected-serena', 'character', 'Serena Marsh', '[]', '', '{}', '', '', ?, ?, ?, 1, 'accepted', ?, ?)`,
      project.id,
      chunk.id,
      SERENA_QUOTE,
      refs,
      AT,
      AT,
    ).lastInsertRowid,
  );
  const kade = Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status, first_chunk,
          evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, 'ent-protected-kade', 'character', 'Kade', '[]', '', '{}', '', '', ?, ?, ?, 1, 'accepted', ?, ?)`,
      project.id,
      chunk.id,
      KADE_QUOTE,
      refs,
      AT,
      AT,
    ).lastInsertRowid,
  );
  const relation = Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, claim_uid, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, modality, review_status, kind_source, anchor_evidence, supporting_evidence,
          relation_status, confirmed_by_user, created_at)
       VALUES (?, 'rel-protected', ?, ?, 'accompanied by', '', ?, ?, 1, '', 'user_confirmed', '', '', '[]',
               'current', 1, ?)`,
      project.id,
      serena,
      kade,
      SERENA_QUOTE,
      refs,
      AT,
    ).lastInsertRowid,
  );

  const beforeEntity = db.get<{
    evidence: string; review_status: string; updated_at: string; claim_uid: string;
  }>('SELECT evidence, review_status, updated_at, claim_uid FROM canon_entity WHERE id = ?', serena);
  const beforeRelation = db.get<{
    evidence: string; review_status: string; confirmed_by_user: number; claim_uid: string; source_refs: string;
  }>('SELECT evidence, review_status, confirmed_by_user, claim_uid, source_refs FROM canon_relation WHERE id = ?', relation);

  const stats = await run(
    project,
    db,
    {
      entities: [{ ...SERENA, evidence: FABRICATED_QUOTE }],
      relations: [
        {
          from: 'Serena Marsh',
          to: 'Kade',
          kind: 'accompanied by',
          description: 'Fabricated.',
          chunk_index: 0,
          evidence: FABRICATED_QUOTE,
        },
      ],
    },
    true,
  );

  assert.equal(stats.verification.dropped, 2);
  assert.deepEqual(
    db.get('SELECT evidence, review_status, updated_at, claim_uid FROM canon_entity WHERE id = ?', serena),
    beforeEntity,
  );
  assert.deepEqual(
    db.get(
      'SELECT evidence, review_status, confirmed_by_user, claim_uid, source_refs FROM canon_relation WHERE id = ?',
      relation,
    ),
    beforeRelation,
  );
  assert.equal(count(db, 'claim_proof', project.id), 0);
  const note = db.get<{ reason: string }>('SELECT reason FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.equal(note?.reason, 'unsupported-citation');
  db.close();
});
