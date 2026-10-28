/**
 * Chaining-markers acceptance tests: modality + conflict flags + the
 * canonical marker map with triple-seed bucket priority.
 *
 * Mock/fixture only — no Ollama:
 *
 *   - migration v9 applies to a copied old DB without data loss
 *   - a denial stores modality denied with its verifying quote (default asserted)
 *   - opposing same-subject pairs flag contested on both sides, nothing deleted
 *   - markerFor covers every stored edge type incl. the three web kinds
 *   - bucket priority prefers the family seed over the spatial seed on ties
 *   - same-bucket ties keep database order
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import { hasColumn } from '../../fanfable/src/migrations.ts';
import * as graph from '../../fanfable/src/graph.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const DENIAL_QUOTE = 'Serena did not answer';
const RIDGE_QUOTE = 'Serena Marsh watched it from the ridge';

function splitMock(parts: {
  entities?: Record<string, unknown>[];
  facts?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
}) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify({ relations: parts.relations ?? [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: parts.entities ?? [], facts: parts.facts ?? [] });
  });
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
  evidence: RIDGE_QUOTE,
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
  evidence: RIDGE_QUOTE,
};

test('migration v9 adds modality columns to a copied old DB without data loss', () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'markers-migrate');
  db.run(
    "INSERT INTO canon_fact (project_id, topic, statement, created_at) VALUES (?, 'signal', 'Three lights mean held.', ?)",
    project.id,
    AT,
  );
  const chunksBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n;
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  // A copy as it looked before v9: columns dropped, version rewound.
  const copyPath = join(path, '..', 'old-copy.db');
  copyFileSync(path, copyPath);
  const old = new Db(copyPath);
  old.raw.exec('ALTER TABLE canon_fact DROP COLUMN modality');
  old.raw.exec('ALTER TABLE canon_fact DROP COLUMN conflict_status');
  old.raw.exec('ALTER TABLE canon_relation DROP COLUMN modality');
  old.raw.exec('ALTER TABLE canon_relation DROP COLUMN conflict_status');
  old.raw.exec('PRAGMA user_version = 8');
  old.close();

  const migrated = new Db(copyPath);
  try {
    for (const [table, column] of [
      ['canon_fact', 'modality'],
      ['canon_fact', 'conflict_status'],
      ['canon_relation', 'modality'],
      ['canon_relation', 'conflict_status'],
    ] as [string, string][]) {
      assert.ok(hasColumn(migrated.raw, table, column), `${table}.${column} migrated`);
    }
    assert.equal(
      migrated.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n,
      chunksBefore,
      'passages survive',
    );
    const fact = migrated.get<{ statement: string; modality: string; conflict_status: string }>(
      'SELECT statement, modality, conflict_status FROM canon_fact WHERE project_id = ?',
      project.id,
    )!;
    assert.equal(fact.statement, 'Three lights mean held.', 'rows survive');
    assert.equal(fact.modality, 'asserted', 'old rows read as asserted');
    assert.equal(fact.conflict_status, 'none', 'old rows read as none');
    const version = migrated.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.ok(version.user_version >= 9, 'version advances past the downgrade');
  } finally {
    migrated.close();
  }
});

test('a denial stores modality with its verifying quote', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-denial');
  await lorebook.extractLore(
    db,
    splitMock({
      entities: [SERENA, KADE],
      facts: [
        {
          topic: 'answers',
          statement: 'Serena answers Kade.',
          kind: 'fact',
          certainty: 'confirmed',
          subject: 'Warden',
          chunk_index: 0,
          evidence: DENIAL_QUOTE,
          modality: 'denied',
        },
        {
          topic: 'bridge',
          statement: 'The bridge stands.',
          kind: 'fact',
          certainty: 'confirmed',
          subject: 'Bridge',
          chunk_index: 0,
          evidence: RIDGE_QUOTE,
        },
      ],
      relations: [
        {
          from: 'Serena Marsh',
          to: 'Kade',
          kind: 'accompanied by',
          description: 'Kade may stand behind her.',
          chunk_index: 0,
          evidence: RIDGE_QUOTE,
          modality: 'possible',
        },
      ],
    }),
    project.id,
  );

  const facts = lorebook.listFacts(db, project.id);
  const denied = facts.find((f) => f.statement === 'Serena answers Kade.')!;
  assert.ok(denied, 'the denial is stored, not dropped');
  assert.equal(denied.modality, 'denied', 'modality persists');
  assert.ok(denied.evidence.includes(DENIAL_QUOTE), 'the denying quote is the evidence');
  const plain = facts.find((f) => f.statement === 'The bridge stands.')!;
  assert.equal(plain.modality, 'asserted', 'omitted modality defaults');

  const relations = lorebook.listRelations(db, project.id);
  assert.equal(relations[0]?.modality, 'possible', 'relation modality persists');

  const bogus = lorebook.normaliseModality('whatever the model invented');
  assert.equal(bogus, 'asserted', 'unknown words fall back, never through');
  db.close();
});

test('opposing same-subject pairs flag contested on both sides', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-contested');
  const aid = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'character',
    'Astra',
    AT,
    AT,
  ).lastInsertRowid;
  const bid = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'character',
    'Bram',
    AT,
    AT,
  ).lastInsertRowid;
  const fact = (subject: string, statement: string): number =>
    db.run(
      'INSERT INTO canon_fact (project_id, subject, statement, created_at) VALUES (?, ?, ?, ?)',
      project.id,
      subject,
      statement,
      AT,
    ).lastInsertRowid;
  const f1 = fact('Kade', 'Kade is alive.');
  const f2 = fact('Kade', 'Kade died at dawn.');
  const f3 = fact('Kade', 'Kade is brave.');
  const f4 = fact('Kade', 'Kade is tall.');
  const g1 = fact('Bridge', 'The bridge stands.');
  const g2 = fact('Bridge', 'The bridge is old.');
  // A superseded row is terminal: the marker must not touch it.
  const f5 = fact('Kade', 'Kade never left.');
  db.run("UPDATE canon_fact SET conflict_status = 'superseded' WHERE id = ?", f5);

  const rel = (kind: string, description: string): number =>
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      aid,
      bid,
      kind,
      description,
      AT,
    ).lastInsertRowid;
  const r1 = rel('sister of', 'Bram is the sister here.');
  const r2 = rel('enemy of', 'Bram is not the sister here.');
  void r1;
  void r2;

  const counts = lorebook.markContestedClaims(db, project.id);
  // f1+f2 (died/alive) plus f3/f4 caught by f5's never-vs-affirmative rule.
  assert.equal(counts.facts, 4, 'rival rows flag, terminal rows do not move');
  assert.equal(counts.relations, 2, 'one rival relation pair flags two rows');

  const status = (id: number): string =>
    db.get<{ conflict_status: string }>('SELECT conflict_status FROM canon_fact WHERE id = ?', id)?.conflict_status ?? '';
  assert.equal(status(f1), 'contested', 'died side flagged');
  assert.equal(status(f2), 'contested', 'alive side flagged');
  assert.equal(status(f3), 'contested', 'brave meets never-left');
  assert.equal(status(f4), 'contested', 'tall meets never-left');
  assert.equal(status(f5), 'superseded', 'terminal states are untouched');
  assert.equal(status(g1), 'none', 'unmarked pairs stay clean');
  assert.equal(status(g2), 'none', 'unmarked pairs stay clean');
  const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)?.n;
  assert.equal(total, 7, 'nothing deleted');
  const rstatus = (id: number): string =>
    db.get<{ conflict_status: string }>('SELECT conflict_status FROM canon_relation WHERE id = ?', id)?.conflict_status ?? '';
  const relIds = db
    .all<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ? ORDER BY id', project.id)
    .map((r) => r.id);
  assert.ok(relIds.every((id) => rstatus(id) === 'contested'), 'both rival relations flagged');

  const gaps = (await import('../../fanfable/src/lore-diagnostics.ts')).diagnose(db, project.id);
  assert.ok(gaps.some((g) => g.kind === 'contested-claim'), 'diagnostics report the rivals');
  db.close();
});

test('markerFor covers every stored edge type', () => {
  assert.equal(graph.markerFor('alias_of'), 'ALIAS');
  assert.equal(graph.markerFor('mentions_in'), 'MENTIONED_IN');
  assert.equal(graph.markerFor('resembles'), 'SEMANTICALLY_SIMILAR');
  assert.equal(graph.markerFor('appears_with'), 'REPEATED_CO_OCCURRENCE');
  assert.equal(graph.markerFor('sister of'), 'FAMILY');
  assert.equal(graph.markerFor('nephew of'), 'FAMILY');
  assert.equal(graph.markerFor('married to'), 'FAMILY');
  assert.equal(graph.markerFor('lord of'), 'ROLE');
  assert.equal(graph.markerFor('works for'), 'ROLE');
  assert.equal(graph.markerFor('member of'), 'ROLE');
  assert.equal(graph.markerFor('lives near'), 'SPATIAL');
  assert.equal(graph.markerFor('pointing at'), 'SPATIAL');
  assert.equal(graph.markerFor('causes'), 'ACTION');
  assert.equal(graph.markerFor('hunts'), 'ACTION');
  assert.equal(graph.markerFor('breaking and entering'), 'ACTION');
  assert.equal(graph.markerFor('related to'), 'OTHER');
  for (const kind of [
    'alias_of',
    'mentions_in',
    'resembles',
    'appears_with',
    'sister of',
    'participates_in',
    'related to',
    'knows',
  ]) {
    assert.match(graph.markerFor(kind), /^[A-Z_]+$/, `${kind} maps into the controlled vocabulary`);
  }
});

test('bucket priority prefers the family seed over the spatial seed', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-buckets');
  const aid = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'character',
    'Astra',
    AT,
    AT,
  ).lastInsertRowid;
  const others: number[] = [];
  for (let i = 1; i <= 12; i++) {
    others.push(
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        project.id,
        'character',
        `Extra${i}`,
        AT,
        AT,
      ).lastInsertRowid,
    );
  }
  // Spatial edges first: without priority they would fill the slice.
  for (let i = 0; i < 6; i++) {
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      aid,
      others[i]!,
      'lives near',
      `Extra${i + 1} lives near the ridge.`,
      AT,
    );
  }
  for (let i = 6; i < 12; i++) {
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      aid,
      others[i]!,
      'sister of',
      `Extra${i + 1} is the sister here.`,
      AT,
    );
  }
  const g = graph.loadGraph(db, project.id);
  const { roots, via } = graph.resolveQuerySeeds(g, 'Astra sister near', []);
  assert.equal(via, 'triple', 'the probe seeds from triples');
  // Slice of 10 over [Astra + 12 endpoints]: family endpoints must survive.
  for (const id of others.slice(9, 12)) {
    assert.ok(roots.includes(`canon:entity:${id}`), `family endpoint ${id} survives the slice`);
  }
  for (const id of others.slice(3, 6)) {
    assert.ok(!roots.includes(`canon:entity:${id}`), `spatial endpoint ${id} falls out of the slice`);
  }
  db.close();
});

test('same-bucket ties keep database order', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-ties');
  const aid = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'character',
    'Astra',
    AT,
    AT,
  ).lastInsertRowid;
  const f1 = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'character',
    'Faye',
    AT,
    AT,
  ).lastInsertRowid;
  const f2 = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'character',
    'Fern',
    AT,
    AT,
  ).lastInsertRowid;
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    aid,
    f1,
    'sister of',
    'Faye is the sister here.',
    AT,
  );
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    aid,
    f2,
    'brother of',
    'Fern is the brother here.',
    AT,
  );
  const g = graph.loadGraph(db, project.id);
  const { roots } = graph.resolveQuerySeeds(g, 'Astra sister brother', []);
  assert.deepEqual(
    roots.filter((r) => r !== 'canon:entity:1'),
    [`canon:entity:${f1}`, `canon:entity:${f2}`],
    'family ties resolve in insertion order',
  );
  db.close();
});


test('moment labels and third-person proofs are flagged and counted, not silently kept', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-relevance');
  const ILSA = {
    kind: 'character', name: 'Ilsa Marrow', aliases: [], summary: 'Ledger keeper.',
    attributes: {}, role: '', status: '', chunk_index: 0,
    evidence: 'Three lights meant the bridge was held',
  };
  const llm = splitMock({
    entities: [SERENA, KADE, ILSA],
    relations: [
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'watched with',
        description: 'Proven by the ridge quote naming Serena.',
        chunk_index: 0, evidence: RIDGE_QUOTE,
      },
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'signalled to',
        description: 'Scene color naming nobody.',
        chunk_index: 0, evidence: 'Three lights meant the bridge was held',
      },
      {
        from: 'Ilsa Marrow', to: 'Kade', kind: 'owes',
        description: 'Attached to a quote about Serena, a third person.',
        chunk_index: 0, evidence: RIDGE_QUOTE,
      },
    ],
  });
  const stats = await lorebook.extractLore(db, llm, project.id);
  const rows = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.equal(rows.length, 0, 'moments never bank as ties, flagged or otherwise; only third-person proof drops outright too');
  const statusOf = (kind: string) => rows.find((r) => r.kind === kind)?.review_status;
  assert.equal(statusOf('owes'), undefined, 'third-person proof is gone, not banked anywhere');
  assert.ok(stats.verification.moment >= 2, 'the moment flags are counted');
  assert.ok(stats.verification.unrelated >= 1, 'the third-person drop is counted');
  const moments = db.all<{ title: string }>('SELECT title FROM canon_event WHERE project_id = ?', project.id);
  assert.equal(moments.length, 2, 'both moments live on as events');
  db.close();
});

test('a generic kinship word drops beside the specific one', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-generic');
  const llm = splitMock({
    entities: [SERENA, KADE],
    relations: [
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'brother of',
        description: 'He is her brother.', chunk_index: 0, evidence: 'her brother',
      },
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'sibling of',
        description: 'They are siblings.', chunk_index: 0, evidence: RIDGE_QUOTE,
      },
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'observed by',
        description: 'She was observed.', chunk_index: 0, evidence: RIDGE_QUOTE,
      },
    ],
  });
  const stats = await lorebook.extractLore(db, llm, project.id);
  const rows = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.deepEqual(rows.map((r) => r.kind), ['brother of'], 'the specific stands; the generic drops beside it');
  assert.deepEqual(rows.map((r) => r.review_status), ['needs_review'], 'endpoint silence parks even the stated noun');
  assert.ok(stats.verification.unsupported >= 1, 'the silent-quote flag is counted');
  assert.ok(stats.verification.moment >= 1, 'the observed-by moment is counted');
  const events = db.all<{ title: string; quote: string }>(
    'SELECT title, quote FROM canon_event WHERE project_id = ?',
    project.id,
  );
  assert.ok(events.some((e) => e.title === 'Serena Marsh observed by Kade'), 'the moment lives on as an event with both people');
  db.close();
});

test('a noun tie needs its word in the quote', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-support');
  const llm = splitMock({
    entities: [SERENA, KADE],
    relations: [
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'brother of',
        description: 'Her brother owns the coat.', chunk_index: 0, evidence: 'her brother',
      },
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'cousin of',
        description: 'Said to be cousins.', chunk_index: 0, evidence: RIDGE_QUOTE,
      },
    ],
  });
  const stats = await lorebook.extractLore(db, llm, project.id);
  const rows = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.deepEqual(rows.map((r) => r.kind), ['brother of', 'cousin of'], 'both stay; nothing is deleted');
  assert.deepEqual(rows.map((r) => r.review_status), ['needs_review', 'provisional'], 'no endpoint parks; a silent noun with one endpoint is provisional');
  assert.ok(stats.verification.unsupported >= 1, 'the silent-quote flag is counted');
  db.close();
});

test('one pair, one quote, one head verb banks once', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-twin');
  const llm = splitMock({
    entities: [SERENA, KADE],
    relations: [
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'trusts with life',
        description: 'She trusts him with her life.', chunk_index: 0, evidence: RIDGE_QUOTE,
      },
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'trusts with important task',
        description: 'She trusts him with the crossing, which matters most.', chunk_index: 0, evidence: RIDGE_QUOTE,
      },
      {
        from: 'Serena Marsh', to: 'Kade', kind: 'seen by',
        description: 'Seen on the ridge.', chunk_index: 0, evidence: RIDGE_QUOTE,
      },
    ],
  });
  const stats = await lorebook.extractLore(db, llm, project.id);
  const rows = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.equal(rows.length, 1, 'the twin merges; the seen-moment never becomes a tie');
  assert.ok(rows[0].kind.startsWith('trusts'), 'the first wording is kept');
  assert.ok(stats.verification.moment >= 1, 'the seen moment is counted');
  db.close();
});

test('a parked moment is queued for review, never banked by a model', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-notes');
  const extractMock = splitMock({
    entities: [SERENA, KADE],
    relations: [{
      from: 'Serena Marsh', to: 'Kade', kind: 'met',
      description: 'They met.', chunk_index: 0, evidence: RIDGE_QUOTE,
    }],
  });
  await lorebook.extractLore(db, extractMock, project.id);
  const notes = db.all<{ status: string }>('SELECT status FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.equal(notes.length, 1, 'the moment parks instead of vanishing');
  assert.equal(notes[0].status, 'pending');

  const queue = lorebook.prioritiseTieNotes(db, project.id);
  assert.equal(queue.length, 1, 'the pending note enters the review queue');
  assert.equal(queue[0].decision.ok, false);
  assert.equal(queue[0].decision.reason, 'moment');
  const rows = db.all<{ kind: string }>('SELECT kind FROM canon_relation WHERE project_id = ?', project.id);
  assert.deepEqual(rows, [], 'a model queue position never writes a relation');
  const left = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'", project.id);
  assert.equal(left?.n, 1, 'the note stays pending for a human');
  db.close();
});

test('pending notes stay pending: prioritise never writes a status', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-notes-drop');
  const extractMock = splitMock({
    entities: [SERENA, KADE],
    relations: [
      { from: 'Serena Marsh', to: 'Kade', kind: 'met', description: 'They met.', chunk_index: 0, evidence: RIDGE_QUOTE },
      { from: 'Serena Marsh', to: 'Kade', kind: 'saw', description: 'She saw him.', chunk_index: 0, evidence: RIDGE_QUOTE },
    ],
  });
  await lorebook.extractLore(db, extractMock, project.id);
  let n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'", project.id)?.n;
  assert.equal(n, 2, 'both moments park');

  const queue = lorebook.prioritiseTieNotes(db, project.id);
  assert.equal(queue.length, 2, 'both notes are ranked for review');
  assert.ok(queue.every((row) => !row.decision.ok), 'the guard refuses both');
  const left = db.all<{ kind: string }>('SELECT kind FROM canon_relation WHERE project_id = ? ORDER BY id', project.id);
  assert.deepEqual(left.map((r) => r.kind), [], 'nothing is written');
  n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'", project.id)?.n;
  assert.equal(n, 2, 'both notes remain pending');
  db.close();
});

test('the evaluator keeps what the quote shows and parks the rest', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-evaluate');
  const extractMock = splitMock({
    entities: [SERENA, KADE],
    relations: [
      { from: 'Serena Marsh', to: 'Kade', kind: 'trusted with life', description: 'Trusts her.', chunk_index: 0, evidence: RIDGE_QUOTE },
      { from: 'Serena Marsh', to: 'Kade', kind: 'accompanies', description: 'Stands with her.', chunk_index: 0, evidence: RIDGE_QUOTE },
    ],
  });
  await lorebook.extractLore(db, extractMock, project.id);
  // Open vocabulary parks at extraction now: both rows bank flagged with
  // open-vocab notes instead of accepted. The judge still rules keep/drop.
  const banked = db.all<{ kind: string; review_status: string }>('SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id', project.id);
  assert.deepEqual(banked.map((r) => r.review_status), ['needs_review', 'needs_review'], 'verb phrases park, never bank accepted');
  let calls = 0;
  const judgeMock = mockProvider(() => {
    calls++;
    return JSON.stringify(calls === 1 ? { verdict: 'keep', reason: 'shown' } : { verdict: 'drop', reason: 'moment' });
  });
  const result = await lorebook.evaluateTies(db, judgeMock, project.id, { maxTies: 10 });
  assert.deepEqual([result.kept, result.parked, result.unproven], [1, 1, 0], 'one kept, one parked, none stranded');
  const left = db.all<{ kind: string; review_status: string }>('SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id', project.id);
  assert.deepEqual(left.map((r) => [r.kind, r.review_status]), [['trusted with life', 'needs_review'], ['accompanies', 'needs_review']], 'the kept tie stays pending; the dropped one waits flagged');
  const notes = db.all<{ attempted_kind: string; status: string }>(`SELECT attempted_kind, status FROM canon_tie_note WHERE project_id = ? AND attempted_kind = 'accompanies'`, project.id);
  assert.deepEqual(notes.map((n) => [n.attempted_kind, n.status]), [['accompanies', 'pending']], 'the dropped tie waits as a note');
  db.close();
});

test('the judge only sees ties newer than the given id', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'markers-judge-since');
  const extractMock = splitMock({
    entities: [SERENA, KADE],
    relations: [
      { from: 'Serena Marsh', to: 'Kade', kind: 'trusted with life', description: 'Trusts her.', chunk_index: 0, evidence: RIDGE_QUOTE },
      { from: 'Serena Marsh', to: 'Kade', kind: 'accompanies', description: 'Stands with her.', chunk_index: 0, evidence: RIDGE_QUOTE },
    ],
  });
  await lorebook.extractLore(db, extractMock, project.id);
  const first = db.get<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ? ORDER BY id LIMIT 1', project.id)!;
  let calls = 0;
  const judgeMock = mockProvider(() => {
    calls++;
    return JSON.stringify({ verdict: 'drop', reason: 'test' });
  });
  const result = await lorebook.evaluateTies(db, judgeMock, project.id, { afterId: first.id, maxTies: 50 });
  assert.deepEqual([result.checked, calls], [1, 1], 'only the newer tie is judged');
  db.close();
});
