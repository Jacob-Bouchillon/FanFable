/**
 * `lore assess`: score rows already in the bank against their own quotes.
 * Generic names and one scripted model reply per call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

interface Setup {
  db: Db;
  projectId: number;
  chunkId: number;
  mara: number;
  tor: number;
}

function setup(name: string, text = 'Mara was a friend of Tor. Tor trusted Mara.'): Setup {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/assess',
      'Probe',
      'sha-assess',
      AT,
    ).lastInsertRowid,
  );
  const chunkId = Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sourceId,
      project.id,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
  const entity = (entityName: string): number =>
    Number(
      db.run(
        `INSERT INTO canon_entity
           (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
         VALUES (?, 'character', ?, '[]', '', '', 2, '', '[]', 'accepted', ?, ?)`,
        project.id,
        entityName,
        AT,
        AT,
      ).lastInsertRowid,
    );
  return { db, projectId: project.id, chunkId, mara: entity('Mara'), tor: entity('Tor') };
}

function addRelation(
  s: Setup,
  kind: string,
  evidence: string,
  opts: { status?: string; confidence?: number } = {},
): number {
  return lorebook.insertRelation(s.db, s.projectId, {
    fromEntity: s.mara,
    toEntity: s.tor,
    kind,
    evidence,
    sourceRefs: JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: s.chunkId }]),
    reviewStatus: opts.status ?? 'accepted',
    confidence: opts.confidence ?? 1,
  });
}

function reply(strength: number, why = 'scripted') {
  return JSON.stringify({
    names_both: true,
    asserted: true,
    other_person: 'named',
    hedge: 'certain', kind_fit: 'yes',
    strength,
    why,
  });
}

test('an existing row is stored with its assessment and review_status is untouched', async () => {
  const s = setup('assess-write');
  const id = addRelation(s, 'friend of', 'Mara was a friend of Tor.', { status: 'accepted' });
  const result = await lorebook.assessRelations(s.db, mockProvider(() => reply(0.8, 'explicit friend')), s.projectId, {
    write: true,
  });
  assert.equal(result.assessed, 1);
  assert.equal(result.wrote, 1);
  const row = s.db.get<{ confidence: number; review_status: string; supporting_evidence: string }>(
    'SELECT confidence, review_status, supporting_evidence FROM canon_relation WHERE id = ?',
    id,
  )!;
  assert.equal(row.confidence, 0.8);
  assert.equal(row.review_status, 'accepted');
  const items = JSON.parse(row.supporting_evidence) as { assessment: Record<string, unknown> }[];
  assert.equal(items[0]!.assessment.strength, 0.8);
  assert.equal(items[0]!.assessment.why, 'explicit friend');
  s.db.close();
});

test('rows without evidence are skipped and reported', async () => {
  const s = setup('assess-no-quote');
  addRelation(s, 'friend of', '');
  const result = await lorebook.assessRelations(s.db, mockProvider(() => reply(0.9)), s.projectId);
  assert.equal(result.assessed, 0);
  assert.equal(result.skipped['no-quote'], 1);
  s.db.close();
});

test('--refresh re-assesses; the default skips an assessed row', async () => {
  const s = setup('assess-refresh');
  addRelation(s, 'friend of', 'Mara was a friend of Tor.');
  let calls = 0;
  const llm = mockProvider(() => {
    calls++;
    return reply(calls === 1 ? 0.8 : 0.6);
  });
  const first = await lorebook.assessRelations(s.db, llm, s.projectId, { write: true });
  assert.equal(first.assessed, 1);

  const second = await lorebook.assessRelations(s.db, llm, s.projectId, { write: true });
  assert.equal(second.assessed, 0);
  assert.equal(second.skipped['already-assessed'], 1);
  assert.equal(calls, 1, 'no model call without --refresh');

  const third = await lorebook.assessRelations(s.db, llm, s.projectId, { write: true, refresh: true });
  assert.equal(third.assessed, 1);
  assert.equal(calls, 2);
  const row = s.db.get<{ confidence: number }>('SELECT confidence FROM canon_relation WHERE project_id = ?', s.projectId)!;
  assert.equal(row.confidence, 0.6);
  s.db.close();
});

test('a quote that is not verbatim in its source is skipped', async () => {
  const s = setup('assess-unverbatim');
  addRelation(s, 'friend of', 'This sentence is not in the passage.');
  const result = await lorebook.assessRelations(s.db, mockProvider(() => reply(0.9)), s.projectId, { write: true });
  assert.equal(result.assessed, 0);
  assert.equal(result.skipped['quote-not-verbatim'], 1);
  assert.equal(result.wrote, 0);
  s.db.close();
});

test('dry run writes nothing', async () => {
  const s = setup('assess-dry');
  const id = addRelation(s, 'friend of', 'Mara was a friend of Tor.');
  const before = s.db.get<{ confidence: number; supporting_evidence: string }>(
    'SELECT confidence, supporting_evidence FROM canon_relation WHERE id = ?',
    id,
  )!;
  const result = await lorebook.assessRelations(s.db, mockProvider(() => reply(0.35)), s.projectId);
  assert.equal(result.assessed, 1);
  assert.equal(result.wrote, 0);
  const after = s.db.get<{ confidence: number; supporting_evidence: string }>(
    'SELECT confidence, supporting_evidence FROM canon_relation WHERE id = ?',
    id,
  )!;
  assert.deepEqual(after, before);
  s.db.close();
});

test('bands, the threshold split and the user_confirmed average are reported', async () => {
  const s = setup('assess-report');
  addRelation(s, 'friend of', 'Mara was a friend of Tor.', { status: 'accepted' });
  addRelation(s, 'trusted', 'Tor trusted Mara.', { status: 'provisional' });
  addRelation(s, 'enemy of', 'Mara was a friend of Tor.', { status: 'user_confirmed' });
  const strengths = [0.72, 0.4, 0.9];
  let calls = 0;
  const result = await lorebook.assessRelations(
    s.db,
    mockProvider(() => reply(strengths[calls++] ?? 0.5)),
    s.projectId,
  );
  assert.equal(result.assessed, 3);
  assert.equal(result.bands['0.0-0.5'], 1);
  assert.equal(result.bands['0.7-0.8'], 1);
  assert.equal(result.bands['0.9-1.0'], 1);
  assert.equal(result.aboveThreshold, 2);
  assert.equal(result.aboveByStatus.accepted, 1);
  assert.equal(result.aboveByStatus.user_confirmed, 1);
  assert.equal(result.userConfirmedAverage, 0.9);
  s.db.close();
});
