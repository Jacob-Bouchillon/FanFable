/**
 * The attested tier (audit open decision #1): passage-proof rows land
 * attested — below keeper, above provisional — and answers cite them with
 * quote + passage scope shown. Offline: temp DBs, MockProvider, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { attestWriteGuard } from '../../fanfable/src/meetings.ts';
import * as lore from '../../fanfable/src/lore.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, status = 'accepted'): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      '[]',
      status,
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
      `/attested-${Math.random().toString(36).slice(2)}`,
      'Attested',
      'sha-attested',
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

function assessment(asserted: boolean, strength = 0.8, kindFit: 'yes' | 'partly' | 'no' = 'yes'): string {
  return lorebook.assessmentSupporting({
    names_both: false,
    other_person: 'pronoun',
    asserted,
    hedge: 'certain',
    kind_fit: kindFit,
    strength,
    why: 'test assessment',
  });
}

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  evidence: string,
  chunk: number,
  opts: { status?: string; asserted?: boolean | null; supporting?: string; strength?: number; kindFit?: 'yes' | 'partly' | 'no' } = {},
): number {
  const supporting =
    opts.supporting ??
    (opts.asserted === null
      ? '[]'
      : assessment(opts.asserted ?? true, opts.strength ?? 0.8, opts.kindFit ?? 'yes'));
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence, review_status, supporting_evidence, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?, 0.8, ?, ?, ?)`,
      projectId,
      from,
      to,
      kind,
      evidence,
      JSON.stringify([{ source: 'Attested', locator: 'p. 1', chunk }]),
      opts.status ?? 'provisional',
      supporting,
      AT,
    ).lastInsertRowid,
  );
}

function setup() {
  const { db } = tempDb();
  const project = createProject(db, `attested-${Math.random().toString(36).slice(2, 7)}`);
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  return { db, project, mara, tor };
}

test('sentence-proof rows stay keeper-track; passage-proof rows land attested', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara is the aunt of Tor. The gate was cold.');
  const sentence = addRelation(db, project.id, mara, tor, 'aunt of', 'Mara is the aunt of Tor.', chunk);
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.checked, 1);
  assert.equal(dry.attested, 0);
  assert.equal(dry.keeperTrack, 1);
  assert.equal(dry.changed, 0);
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(wrote.changed, 0);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', sentence)!.review_status,
    'provisional',
    'sentence-proof rows are left for the keeper promote path',
  );
  db.close();
});

test('a passage-proof quote with a stored asserted assessment becomes attested', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  const row = addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk);
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.attested, 1);
  assert.equal(dry.changed, 0, 'dry run writes nothing');
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!.review_status,
    'provisional',
  );
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(wrote.changed, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!.review_status,
    'attested',
  );
  const again = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(again.checked, 0, 'attested rows are not re-scanned');
  assert.equal(again.changed, 0);
  db.close();
});

test('single-name quotes without chunk support stay parked; invented quotes stay unsupported', () => {
  const { db, project, mara, tor } = setup();
  const thin = addChunk(db, project.id, 'Mara feared him. The gate was cold.');
  addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', thin);
  const invent = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  addRelation(db, project.id, mara, tor, 'friend of', 'Mara feared Tor dreadfully.', invent);
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.attested, 0);
  assert.deepEqual(dry.still, { 'endpoint-unnamed': 1, 'quote-not-verbatim': 1 });
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(wrote.changed, 0);
  db.close();
});

test('denied, weak, wrong-kind and unassessed rows never attest; identity and PARK still refuse', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk, { asserted: false });
  const unassessed = addRelation(db, project.id, mara, tor, 'friend of', 'Mara feared him.', chunk, { asserted: null });
  const weak = addRelation(db, project.id, mara, tor, 'ally of', 'Mara feared him.', chunk, { strength: 0.5 });
  const wrongKind = addRelation(db, project.id, mara, tor, 'rival of', 'Mara feared him.', chunk, { kindFit: 'no' });
  addRelation(db, project.id, mara, mara, 'ally of', 'Mara feared him.', chunk);
  const parked = addRelation(db, project.id, mara, tor, 'mentor of', 'Mara feared him.', chunk);
  db.run(
    `INSERT INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, ruling, created_at)
     VALUES (?, ?, ?, 'mentor of', 'unsupported', 'Mara feared him.', ?, 'pending', 'park: user ruling', ?)`,
    project.id,
    mara,
    tor,
    JSON.stringify([{ source: 'Attested', locator: 'p. 1', chunk }]),
    AT,
  );
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.attested, 0, 'nothing attests without a positive stored assessment clearing the bar');
  assert.deepEqual(dry.still, {
    'assertion-missing': 2,
    'below-threshold': 2,
    'same-identity': 1,
    'ruled-park': 1,
  });
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(wrote.changed, 0);
  for (const id of [unassessed, weak, wrongKind, parked]) {
    assert.equal(
      db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', id)!.review_status,
      'provisional',
    );
  }
  db.close();
});

test('an open-vocabulary label is proved by its passage, not refused by a word list', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  const row = addRelation(db, project.id, mara, tor, 'guide to parity with', 'Mara feared him.', chunk);
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.attested, 1);
  assert.equal(dry.still['open-vocab'], undefined, 'the concept vocabulary is no longer a gate');
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(wrote.changed, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!.review_status,
    'attested',
  );
  db.close();
});

test('co-presence and one-off actions never attest', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  addRelation(db, project.id, mara, tor, 'appears with', 'Mara feared him.', chunk, { asserted: null });
  addRelation(db, project.id, mara, tor, 'met with', 'Mara feared him.', chunk, { asserted: null });
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.attested, 0);
  assert.equal(dry.still['coverage-only'], 1);
  assert.equal(dry.still['moment'], 1);
  db.close();
});

test('a quote whose words are right but punctuation is not is repaired to the chunk', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him at once. Tor arrived with the guard at dawn.');
  const row = addRelation(db, project.id, mara, tor, 'guide to parity with', 'Mara feared him, at once', chunk);
  const off = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(off.attested, 0);
  assert.equal(off.still['quote-not-verbatim'], 1, 'presentation mismatch stays refused unless repair is asked for');
  const dry = lorebook.assignAttestedTiers(db, project.id, { repairQuotes: true });
  assert.equal(dry.attested, 1);
  assert.equal(dry.repaired, 1);
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true, repairQuotes: true });
  assert.equal(wrote.changed, 1);
  const saved = db.get<{ evidence: string; review_status: string }>(
    'SELECT evidence, review_status FROM canon_relation WHERE id = ?',
    row,
  )!;
  assert.equal(saved.evidence, 'Mara feared him at once');
  assert.equal(saved.review_status, 'attested');
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);
  db.close();
});

test('promoteKeeper moves sentence-proof rows to accepted; off by default', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara is the aunt of Tor. The gate was cold.');
  const row = addRelation(db, project.id, mara, tor, 'aunt of', 'Mara is the aunt of Tor.', chunk);
  const kept = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(kept.keeperTrack, 1);
  assert.equal(kept.keeperPromoted, 0);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!.review_status,
    'provisional',
  );
  const promoted = lorebook.assignAttestedTiers(db, project.id, { write: true, promoteKeeper: true });
  assert.equal(promoted.keeperPromoted, 1);
  assert.equal(promoted.changed, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!.review_status,
    'accepted',
  );
  db.close();
});

test('accepted and user_confirmed rows are never read or altered', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  const kept = addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk, { status: 'accepted' });
  const confirmed = addRelation(db, project.id, mara, tor, 'friend of', 'Mara feared him.', chunk, { status: 'user_confirmed' });
  const dry = lorebook.assignAttestedTiers(db, project.id);
  assert.equal(dry.checked, 0);
  const wrote = lorebook.assignAttestedTiers(db, project.id, { write: true });
  assert.equal(wrote.changed, 0);
  assert.equal(wrote.backupPath, undefined, 'no snapshot when nothing changes');
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', kept)!.review_status,
    'accepted',
  );
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', confirmed)!.review_status,
    'user_confirmed',
  );
  db.close();
});

test('integrity passes clean attested rows and flags chunk-endpoint gaps', () => {
  const { db, project, mara, tor } = setup();
  const good = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', good, { status: 'attested' });
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);
  const thin = addChunk(db, project.id, 'Mara feared him. The gate was cold.');
  addRelation(db, project.id, mara, tor, 'friend of', 'Mara feared him.', thin, { status: 'attested' });
  const rows = lorebook.findUnverifiedKeepers(db, project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, 'endpoint-unnamed');
  db.close();
});

test('bank answers cite attested rows distinctly from keepers', () => {
  const { db, project, mara, tor } = setup();
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk, { status: 'attested' });
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'status of Mara to Tor');
  assert.equal(answer.status, 'attested');
  assert.ok(answer.quote && answer.quote.length > 0, 'quote shown');
  assert.ok(answer.locator && answer.locator.length > 0, 'passage scope shown');
  db.close();
});

test('lore answers attest without any model call', async () => {
  const { db } = tempDb();
  const project = createProject(db, `attested-ask-${Math.random().toString(36).slice(2, 7)}`);
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const chunk = addChunk(db, project.id, 'Mara feared him. Tor arrived with the guard at dawn.');
  addRelation(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk, { status: 'attested' });
  const llm = mockProvider(() => {
    throw new Error('no model calls on the attested answer path');
  });
  const res = await lore.answerLoreQuestion(db, llm, project.id, 'status of Mara to Tor');
  assert.equal(res.grounded, true);
  assert.match(res.answer, /Attested/);
  assert.match(res.answer, /not keeper-grade/);
  assert.equal(res.passages.length, 1, 'cited passage rides along');
  db.close();
});

test('attestWriteGuard refuses non-temp writes without --on-copy, never the temp path', () => {
  const { db, path } = tempDb();
  assert.doesNotThrow(() => attestWriteGuard(path, false), 'temp copy writes as before');
  assert.doesNotThrow(() => attestWriteGuard(path, true), 'flag changes nothing on temp');
  assert.throws(
    () => attestWriteGuard('testing/trials/scratch.db', false),
    /must run on a copy/,
    'non-temp refuses without the flag',
  );
  assert.doesNotThrow(
    () => attestWriteGuard('testing/trials/scratch.db', true),
    'explicit --on-copy accepts (backup still written first downstream)',
  );
  db.close();
});
