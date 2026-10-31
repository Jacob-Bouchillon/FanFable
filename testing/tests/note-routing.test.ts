/**
 * Milestone 6: note routing, claim wording and strength provenance.
 * Invented names only; no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import * as ingest from '../../fanfable/src/web/note-ingest.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, kind = 'character'): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      projectId,
      kind,
      name,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addSource(db: Db, projectId: number): number {
  return Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/routing-source',
      'Probe',
      'sha-routing',
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, sourceId: number, seq: number, text: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sourceId,
      projectId,
      seq,
      `p. ${seq}`,
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const chunks = [
    addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale at the gate and swore an oath.'),
    addChunk(db, project.id, source, 2, 'Corin Hale kept the ledger under the bridge.'),
    addChunk(db, project.id, source, 3, 'The wall stood through the long winter.'),
  ];
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  const species = addEntity(db, project.id, 'Shi ido', 'species');
  const faction = addEntity(db, project.id, 'The Compact', 'faction');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  return { db, project: project.id, source, chunks, mara, corin, species, faction };
}

function addRelation(
  db: Db,
  projectId: number,
  rel: {
    from: number;
    to: number;
    kind: string;
    evidence: string;
    chunk: number;
    description?: string;
    status?: string;
    confidence?: number;
    supporting?: string;
    scope?: string;
  },
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, supporting_evidence, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      rel.from,
      rel.to,
      rel.kind,
      rel.description ?? '',
      rel.evidence,
      JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: rel.chunk }]),
      rel.confidence ?? 0.9,
      rel.status ?? 'accepted',
      rel.supporting ?? '[]',
      rel.scope ?? '',
      AT,
    ).lastInsertRowid,
  );
}

function storedClaims(db: Db, projectId: number): { claim: string; thread_kind: string }[] {
  return db.all<{ claim: string; thread_kind: string }>(
    `SELECT n.claim, t.kind AS thread_kind FROM canon_thread_note n
       JOIN canon_thread t ON t.id = n.thread_id
      WHERE n.project_id = ? ORDER BY n.id`,
    projectId,
  );
}

test('the claim is the stored reasoning when it reads as a sentence', () => {
  const { db, project, mara, corin, chunks } = setup('routing-why');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    description: 'the oath names her as his sister',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  ingest.backfillThreadNotes(db, project);
  const claims = storedClaims(db, project).filter((row) => row.thread_kind === 'pair');
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.claim, 'the oath names her as his sister');
  db.close();
});

test('without reasoning the claim is the sentence naming both people', () => {
  const { db, project, mara, corin, chunks } = setup('routing-sentence');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  ingest.backfillThreadNotes(db, project);
  const claims = storedClaims(db, project).filter((row) => row.thread_kind === 'pair');
  assert.equal(claims.length, 1);
  assert.match(claims[0]!.claim, /Mara Voss met Corin Hale/);
  db.close();
});

test('a kind phrase is used only for a closed concept, never a colon pattern', () => {
  const { db, project, mara, corin, source, chunks } = setup('routing-kindphrase');
  // A passage naming only one endpoint: the kind phrase is the fallback.
  const solo = addChunk(db, project, source, 9, 'Mara Voss kept the ledger alone that night.');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    evidence: 'Mara Voss kept the ledger alone that night.',
    chunk: solo,
  });
  ingest.backfillThreadNotes(db, project);
  const claims = storedClaims(db, project).filter((row) => row.thread_kind === 'pair');
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.claim, 'Mara Voss sister of Corin Hale');
  void chunks;
  db.close();
});

test('a non-concept kind with nothing assertable is skipped and counted', () => {
  const { db, project, mara, corin, chunks } = setup('routing-no-claim');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'friend',
    evidence: 'The wall stood through the long winter.',
    chunk: chunks[2]!,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.pairNotes, 0);
  assert.ok(counts.skipped['no-assertable-claim'] >= 1);
  db.close();
});

test('no stored claim ever carries the colon name-pair pattern', () => {
  const { db, project, mara, corin, species, chunks } = setup('routing-no-colon');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  addRelation(db, project, {
    from: mara,
    to: species,
    kind: 'was',
    description: 'she was born to the Shi ido',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  ingest.backfillThreadNotes(db, project);
  const claims = storedClaims(db, project);
  assert.ok(claims.length >= 2);
  const colonPattern = /\band\s+[^:]{1,80}:\s*\S+$/;
  for (const row of claims) {
    assert.ok(!colonPattern.test(row.claim), `claim carries the wrapper: ${row.claim}`);
  }
  db.close();
});

test('a person paired with a species files the fact on the person', () => {
  const { db, project, mara, species, chunks } = setup('routing-attribute');
  addRelation(db, project, {
    from: mara,
    to: species,
    kind: 'was',
    description: 'she was a member of the Shi ido',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.pairNotes, 0, 'a species is not a pair endpoint');
  assert.ok(counts.identityNotes >= 1);
  assert.ok(counts.skipped['non-person-endpoint'] >= 1);

  const personThread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND b_entity IS NULL",
    project,
    mara,
  )!.id;
  const onPerson = db.all<{ claim: string; missing: string }>(
    'SELECT claim, missing FROM canon_thread_note WHERE thread_id = ?',
    personThread,
  );
  assert.equal(onPerson.length, 1);
  assert.equal(onPerson[0]!.missing, 'non-person-endpoint');
  assert.match(onPerson[0]!.claim, /Shi ido/);
  assert.equal(
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM canon_thread_note n JOIN canon_thread t ON t.id = n.thread_id
        WHERE t.kind = 'pair' AND n.project_id = ?`,
      project,
    )!.n,
    0,
  );
  db.close();
});

test('two non-character endpoints produce nothing at all', () => {
  const { db, project, species, faction, chunks } = setup('routing-no-person');
  addRelation(db, project, {
    from: species,
    to: faction,
    kind: 'ally of',
    description: 'the species and the faction stood together',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.pairNotes, 0);
  assert.equal(counts.identityNotes, 0);
  assert.ok(counts.skipped['no-character-endpoint'] >= 1);
  db.close();
});

test('a verb kind is never a pair label', () => {
  const { db, project, mara, corin, chunks } = setup('routing-verb');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'had',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.pairNotes, 0, 'a verb is not a relationship');
  assert.ok(counts.skipped['verb-kind'] >= 1);
  assert.ok(counts.identityNotes >= 2, 'the property is kept on both people');
  const claims = storedClaims(db, project);
  assert.ok(claims.every((row) => row.thread_kind !== 'pair'));
  db.close();
});

test('strength_source records whether an assessment produced the number', () => {
  const { db, project, mara, corin, chunks } = setup('routing-strength');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    description: 'the oath names her as his sister',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
    confidence: 0.7,
  });
  addRelation(db, project, {
    from: corin,
    to: mara,
    kind: 'debtor to',
    description: 'the ledger records what he owes her',
    evidence: 'Corin Hale kept the ledger under the bridge.',
    chunk: chunks[1]!,
    confidence: 0.7,
    supporting: JSON.stringify([{ assessment: { strength: 0.7, why: 'the ledger is explicit' } }]),
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.strengthSource.assessed, 1);
  assert.ok(counts.strengthSource.derived >= 1, 'an unassessed row is derived, not defaulted');

  const rows = db.all<{ strength_source: string; strength: number }>(
    'SELECT strength_source, strength FROM canon_thread_note WHERE project_id = ? ORDER BY id',
    project,
  );
  assert.ok(rows.some((r) => r.strength_source === 'assessed'));
  assert.ok(rows.some((r) => r.strength_source === 'derived'));
  assert.ok(rows.every((r) => r.strength < 1.0), 'no note defaults to certainty');
  assert.equal(rows.find((r) => r.strength_source === 'assessed')!.strength, 0.7);
  db.close();
});

test('one open end per subject, and a rerun adds none', () => {
  const { db, project, mara, corin, chunks } = setup('routing-open-end');
  for (const [i, chunk] of [chunks[0]!, chunks[1]!].entries()) {
    addRelation(db, project, {
      from: mara,
      to: corin,
      kind: 'rival of',
      description: `the passage shows a rivalry in scene ${i}`,
      evidence: i === 0 ? 'Mara Voss met Corin Hale at the gate and swore an oath.' : 'Corin Hale kept the ledger under the bridge.',
      chunk,
      status: 'provisional',
      confidence: 0.4,
      scope: i === 0 ? '' : 'second scene',
    });
  }
  const first = ingest.backfillThreadNotes(db, project);
  const questions = db.all<{ question: string }>(
    "SELECT question FROM canon_open_end WHERE project_id = ? AND question LIKE 'does the text establish%'",
    project,
  );
  assert.equal(questions.length, 1, 'one question about the same pair and kind');
  assert.equal(first.openEnds >= 1, true);
  const second = ingest.backfillThreadNotes(db, project);
  assert.equal(second.openEnds, 0);
  assert.equal(second.notes, 0);
  db.close();
});

test('the verbatim gate is unchanged', () => {
  const { db, project, mara, corin, chunks } = setup('routing-verbatim');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    description: 'the oath names her as his sister',
    evidence: 'a sentence that is nowhere in the passage',
    chunk: chunks[0]!,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.notes, 0);
  assert.ok(counts.skipped['not-verbatim'] >= 1);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', project)!.n,
    0,
  );
  db.close();
});

test('routing leaves the bank and existing notes alone', () => {
  const { db, project, mara, corin, species, chunks } = setup('routing-safe');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'sister of',
    description: 'the oath names her as his sister',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  addRelation(db, project, {
    from: mara,
    to: species,
    kind: 'was',
    description: 'she was a member of the Shi ido',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath.',
    chunk: chunks[0]!,
  });
  const protectedBefore = ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
    (table) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
  );
  ingest.backfillThreadNotes(db, project);
  const snapshot = db.all<Record<string, unknown>>('SELECT * FROM canon_thread_note ORDER BY id');
  ingest.backfillThreadNotes(db, project);
  assert.deepEqual(db.all<Record<string, unknown>>('SELECT * FROM canon_thread_note ORDER BY id'), snapshot);
  assert.deepEqual(
    ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
      (table) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
    ),
    protectedBefore,
  );
  db.close();
});
