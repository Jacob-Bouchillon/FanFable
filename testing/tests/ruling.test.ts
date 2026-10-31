/**
 * The court record: every status change leaves one ruling, and the docket
 * shows the latest verdict with who made it and on what standard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as loreDiag from '../../fanfable/src/lore-diagnostics.ts';
import * as ruling from '../../fanfable/src/ruling.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      '[]',
      'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, text: string): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/court',
      'Court',
      'sha-court',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function setup() {
  const { db } = tempDb();
  const project = createProject(db, `court-${Math.random().toString(36).slice(2, 7)}`);
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const chunk = addChunk(db, project.id, 'Mara is the aunt of Tor. Mara feared him. Tor arrived with the guard.');
  return { db, project, mara, tor, chunk };
}

function addRelation(
  s: ReturnType<typeof setup>,
  kind: string,
  evidence: string,
  status: string,
): number {
  return lorebook.insertRelation(s.db, s.project.id, {
    fromEntity: s.mara,
    toEntity: s.tor,
    kind,
    evidence,
    sourceRefs: JSON.stringify([{ source: 'Court', locator: 'p. 1', chunk: s.chunk }]),
    reviewStatus: status,
    confidence: 0.8,
  });
}

test('insertion opens a case with a charge ruling', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  const history = ruling.listRulings(s.db, s.project.id, { relationId: row });
  assert.equal(history.length, 1);
  assert.equal(history[0]!.role, 'charge');
  assert.equal(history[0]!.actor, 'bank');
  assert.equal(history[0]!.to_status, 'provisional');
  assert.equal(history[0]!.quote_hash, ruling.quoteHash('Mara is the aunt of Tor.'));
  const docket = ruling.docket(s.db, s.project.id);
  assert.equal(docket.length, 1);
  assert.equal(docket[0]!.status, 'provisional');
  s.db.close();
});

test('promotion writes an appeal ruling with the standard and the prior status', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  const dry = lorebook.promoteProvisional(s.db, s.project.id, { dryRun: true });
  assert.equal(dry.promoted, 1);
  assert.equal(ruling.listRulings(s.db, s.project.id, { relationId: row }).length, 1, 'dry run writes no ruling');
  const wrote = lorebook.promoteProvisional(s.db, s.project.id, { dryRun: false });
  assert.equal(wrote.promoted, 1);
  const history = ruling.listRulings(s.db, s.project.id, { relationId: row });
  assert.equal(history.length, 2);
  assert.equal(history[0]!.role, 'appeal');
  assert.equal(history[0]!.actor, 'guard');
  assert.equal(history[0]!.standard, 'sentence-proof');
  assert.equal(history[0]!.from_status, 'provisional');
  assert.equal(history[0]!.to_status, 'accepted');
  s.db.close();
});

test('attestation writes a passage-proof appeal', () => {
  const s = setup();
  const row = addRelation(s, 'guide to parity with', 'Mara feared him.', 'needs_review');
  const result = lorebook.assignAttestedTiers(s.db, s.project.id, { write: true });
  assert.equal(result.attested, 1);
  const history = ruling.listRulings(s.db, s.project.id, { relationId: row });
  const last = history[0]!;
  assert.equal(last.role, 'appeal');
  assert.equal(last.standard, 'passage-proof');
  assert.equal(last.from_status, 'needs_review');
  assert.equal(last.to_status, 'attested');
  s.db.close();
});

test('a human correction and a removal each leave a ruling', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  assert.equal(loreDiag.correctRelation(s.db, s.project.id, row, { kind: 'guardian of', confirm: true }), true);
  let history = ruling.listRulings(s.db, s.project.id, { relationId: row });
  assert.equal(history[0]!.actor, 'human');
  assert.equal(history[0]!.to_status, 'user_confirmed');
  assert.equal(loreDiag.removeRelation(s.db, s.project.id, row), true);
  const removal = ruling
    .listRulings(s.db, s.project.id, { subject: ruling.relationSubject(row) })
    .filter((r) => r.role === 'removal');
  assert.equal(removal.length, 1);
  assert.equal(removal[0]!.to_status, 'removed');
  const docket = ruling.docket(s.db, s.project.id);
  assert.equal(docket[0]!.status, 'removed');
  s.db.close();
});

test('an assessment writes a verdict ruling without changing the status', async () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  const reply = JSON.stringify({
    names_both: true,
    other_person: 'named',
    asserted: true,
    hedge: 'certain',
    kind_fit: 'yes',
    strength: 0.82,
    why: 'explicit',
  });
  const result = await lorebook.assessRelations(s.db, mockProvider(() => reply), s.project.id, { write: true });
  assert.equal(result.assessed, 1);
  const history = ruling.listRulings(s.db, s.project.id, { relationId: row });
  const verdict = history.find((r) => r.role === 'verdict')!;
  assert.equal(verdict.actor, 'assessor');
  assert.equal(verdict.standard, 'assessment');
  assert.equal(verdict.to_status, 'provisional');
  assert.match(verdict.basis, /0\.82/);
  s.db.close();
});

test('backfill opens one charge per unrecorded relation, once', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  // Simulate a row that predates the court: drop its opening charge.
  s.db.run("DELETE FROM canon_ruling WHERE relation_id = ? AND role = 'charge'", row);
  assert.equal(ruling.listRulings(s.db, s.project.id, { relationId: row }).length, 0);
  assert.equal(ruling.backfillCharges(s.db, s.project.id), 1);
  const history = ruling.listRulings(s.db, s.project.id, { relationId: row });
  assert.equal(history.length, 1);
  assert.equal(history[0]!.standard, 'imported');
  assert.equal(history[0]!.to_status, 'provisional');
  assert.equal(ruling.backfillCharges(s.db, s.project.id), 0, 'second run writes nothing');
  s.db.close();
});

test('the docket shows pending objections on the same claim', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  s.db.run(
    `INSERT INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, ruling, created_at)
     VALUES (?, ?, ?, 'aunt of', 'unsupported', 'Mara is the aunt of Tor.', '[]', 'pending', '', ?)`,
    s.project.id,
    s.mara,
    s.tor,
    AT,
  );
  const docket = ruling.docket(s.db, s.project.id);
  assert.equal(docket.length, 1);
  assert.equal(docket[0]!.objections, 1);
  s.db.close();
});

test('dedupe leaves a merge ruling for the row it drops', () => {  const s = setup();
  const first = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  // A legacy duplicate: the unique key includes scope, so a second row with a
  // different scope can exist. Dedupe folds it into the first.
  const second = Number(
    s.db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, modality, review_status, kind_source, anchor_evidence, supporting_evidence, scope, created_at)
       VALUES (?, ?, ?, 'aunt of', '', 'Mara is the aunt of Tor.', ?, 0.8, 'asserted', 'provisional', '', '', '[]', 'alt', ?)`,
      s.project.id,
      s.mara,
      s.tor,
      JSON.stringify([{ source: 'Court', locator: 'p. 1', chunk: s.chunk }]),
      AT,
    ).lastInsertRowid,
  );
  assert.notEqual(first, second);
  lorebook.dedupeRelations(s.db, s.project.id);
  const left = s.db.all<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ?', s.project.id);
  assert.equal(left.length, 1, 'one row survives');
  const merge = ruling
    .listRulings(s.db, s.project.id, { subject: ruling.relationSubject(second) })
    .find((r) => r.standard === 'merge');
  assert.ok(merge, 'the dropped row has a merge ruling');
  assert.equal(merge!.to_status, 'merged');
  s.db.close();
});

const statusOf = (db: Db, id: number): string =>
  db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', id)!.review_status;

const FAIL_TRIGGER = "CREATE TRIGGER fail_ruling BEFORE INSERT ON canon_ruling BEGIN SELECT RAISE(ABORT, 'boom'); END";
const DROP_TRIGGER = 'DROP TRIGGER fail_ruling';

test('a failed ruling rolls the status change back', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  s.db.exec(FAIL_TRIGGER);
  assert.throws(() => lorebook.promoteProvisional(s.db, s.project.id, { dryRun: false }));
  assert.equal(statusOf(s.db, row), 'provisional', 'the promotion did not survive without its ruling');
  s.db.exec(DROP_TRIGGER);
  assert.equal(lorebook.promoteProvisional(s.db, s.project.id, { dryRun: false }).promoted, 1);
  assert.equal(statusOf(s.db, row), 'accepted');
  s.db.close();
});

test('a failed charge leaves no relation row', () => {
  const s = setup();
  s.db.exec(FAIL_TRIGGER);
  assert.throws(() => addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional'));
  assert.equal(
    s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', s.project.id)!.n,
    0,
    'the insert rolled back with its charge',
  );
  s.db.exec(DROP_TRIGGER);
  assert.ok(addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional') > 0);
  s.db.close();
});

test('a failed removal keeps the relation and its status', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  s.db.exec(FAIL_TRIGGER);
  assert.throws(() => loreDiag.removeRelation(s.db, s.project.id, row));
  assert.equal(statusOf(s.db, row), 'provisional');
  s.db.exec(DROP_TRIGGER);
  assert.equal(loreDiag.removeRelation(s.db, s.project.id, row), true);
  assert.equal(
    s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE id = ?', row)!.n,
    0,
  );
  s.db.close();
});

const keeperPayload = (reviewStatus: string) => ({
  version: 1,
  counters: { project: 'court', keepers: 1, note_rulings: 0, identities: 0 },
  keepers: [
    {
      from_name: 'Mara',
      from_aliases: [],
      to_name: 'Tor',
      to_aliases: [],
      kind: 'aunt of',
      review_status: reviewStatus,
      evidence: 'Mara is the aunt of Tor.',
      locator: 'p. 1',
      exported_at: AT,
    },
  ],
  note_rulings: [],
  identities: [],
});

test('replay records the keeper it applies', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  const result = lorebook.replayRulings(s.db, s.project.id, keeperPayload('user_confirmed'), { write: true });
  assert.equal(result.keepers.applied, 1);
  const replay = ruling
    .listRulings(s.db, s.project.id, { relationId: row })
    .find((r) => r.standard === 'replay');
  assert.ok(replay, 'replay writes a ruling');
  assert.equal(replay!.actor, 'human');
  assert.equal(replay!.from_status, 'provisional');
  assert.equal(replay!.to_status, 'user_confirmed');
  assert.equal(statusOf(s.db, row), 'user_confirmed');
  s.db.close();
});

test('replay records the relation it creates', () => {
  const s = setup();
  const result = lorebook.replayRulings(s.db, s.project.id, keeperPayload('accepted'), { write: true });
  assert.equal(result.keepers.applied, 1);
  const created = s.db.get<{ id: number; review_status: string }>(
    'SELECT id, review_status FROM canon_relation WHERE project_id = ?',
    s.project.id,
  )!;
  assert.equal(created.review_status, 'accepted');
  const replay = ruling.listRulings(s.db, s.project.id, { subject: ruling.relationSubject(created.id) });
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.standard, 'replay');
  assert.equal(replay[0]!.to_status, 'accepted');
  s.db.close();
});

test('an objection is a ruling, not only a note', () => {
  const s = setup();
  lorebook.persistTieNote(
    s.db,
    s.project.id,
    s.mara,
    s.tor,
    'aunt of',
    'unsupported',
    'Mara is the aunt of Tor.',
    JSON.stringify([{ source: 'Court', locator: 'p. 1', chunk: s.chunk }]),
    '',
  );
  const objections = ruling.listRulings(s.db, s.project.id, { role: 'objection' });
  assert.equal(objections.length, 1);
  assert.equal(objections[0]!.actor, 'guard');
  assert.equal(objections[0]!.standard, 'tie-note');
  assert.equal(objections[0]!.to_status, 'pending');
  assert.ok(objections[0]!.subject.startsWith('pair:'));
  s.db.close();
});

test('replay records the note ruling it applies', () => {
  const s = setup();
  const payload = {
    version: 1,
    counters: { project: 'court', keepers: 0, note_rulings: 1, identities: 0 },
    keepers: [],
    note_rulings: [
      {
        from_name: 'Mara',
        to_name: 'Tor',
        attempted_kind: 'aunt of',
        status: 'resolved',
        ruling: 'keep',
        evidence: 'Mara is the aunt of Tor.',
      },
    ],
    identities: [],
  };
  const result = lorebook.replayRulings(s.db, s.project.id, payload, { write: true });
  assert.equal(result.note_rulings.applied, 1);
  const objection = ruling
    .listRulings(s.db, s.project.id, { role: 'objection' })
    .find((r) => r.standard === 'replay');
  assert.ok(objection, 'the note ruling is on the record');
  assert.equal(objection!.actor, 'human');
  assert.equal(objection!.to_status, 'resolved');
  s.db.close();
});

test('anchors fill the sentence naming the other person', () => {
  const s = setup();
  const row = addRelation(s, 'aunt of', 'Tor arrived with the guard.', 'provisional');
  const dry = lorebook.populateAnchors(s.db, s.project.id);
  assert.equal(dry.checked, 1);
  assert.equal(dry.filled, 1);
  assert.equal(dry.changed, 0);
  const wrote = lorebook.populateAnchors(s.db, s.project.id, { write: true });
  assert.equal(wrote.changed, 1);
  const saved = s.db.get<{ anchor_evidence: string }>(
    'SELECT anchor_evidence FROM canon_relation WHERE id = ?',
    row,
  )!;
  assert.equal(saved.anchor_evidence, 'Mara feared him.');
  const clue = ruling
    .listRulings(s.db, s.project.id, { relationId: row })
    .find((r) => r.standard === 'anchor');
  assert.ok(clue);
  assert.equal(clue!.actor, 'chain');
  s.db.close();
});

test('a relabel replaces a wrong kind and records the appeal', async () => {
  const s = setup();
  const row = addRelation(s, 'ally of', 'Mara is the aunt of Tor.', 'attested');
  const llm = mockProvider(() => JSON.stringify({ kind: 'enemy of', why: 'the passage says so' }));
  const dry = await lorebook.relabelRelations(s.db, llm, s.project.id, { ids: [row] });
  assert.equal(dry.changed, 1);
  const wrote = await lorebook.relabelRelations(s.db, llm, s.project.id, { ids: [row], write: true });
  assert.equal(wrote.changed, 1);
  const saved = s.db.get<{ kind: string }>('SELECT kind FROM canon_relation WHERE id = ?', row)!;
  assert.equal(saved.kind, 'enemy of');
  const appeal = ruling
    .listRulings(s.db, s.project.id, { relationId: row })
    .find((r) => r.standard === 'relabel');
  assert.ok(appeal);
  assert.equal(appeal!.actor, 'assessor');
  assert.match(appeal!.basis, /ally of -> enemy of/);
  s.db.close();
});

test('the docket counts open wants on the relation pair', () => {
  const s = setup();
  addRelation(s, 'aunt of', 'Mara is the aunt of Tor.', 'provisional');
  const thread = Number(
    s.db.run(
      "INSERT INTO canon_thread (project_id, kind, a_entity, b_entity, status, created_at, updated_at) VALUES (?, 'pair', ?, ?, 'open', ?, ?)",
      s.project.id,
      s.mara,
      s.tor,
      AT,
      AT,
    ).lastInsertRowid,
  );
  s.db.run(
    "INSERT INTO canon_open_end (project_id, thread_id, question, status, created_at) VALUES (?, ?, 'what connects them?', 'open', ?)",
    s.project.id,
    thread,
    AT,
  );
  const row = ruling.docket(s.db, s.project.id)[0]!;
  assert.equal(row.openEnds, 1);
  s.db.close();
});
