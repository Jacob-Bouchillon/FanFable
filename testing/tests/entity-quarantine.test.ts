/**
 * Suspect-character quarantine: a character admitted from one mention whose
 * name is also an ordinary word is held back from tie generation, not deleted.
 * Release needs real character evidence. Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string, opts: { mentions?: number; aliases?: string[] } = {}): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, mentions, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      JSON.stringify(opts.aliases ?? []),
      opts.mentions ?? 1,
      'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function chunk(db: Db, projectId: number, text: string): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `s-${Math.random().toString(36).slice(2)}.txt`,
      'source',
      'sha',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, text, locator) VALUES (?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      0,
      text,
      'p. 1',
    ).lastInsertRowid,
  );
}

function setup(name: string, text: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  chunk(db, project.id, text);
  return { db, project };
}

test('a one-mention character that is also an ordinary word is quarantined', () => {
  const { db, project } = setup('quarantine-bill', 'Mara paid the bill and left the shop.');
  const bill = entity(db, project.id, 'Bill');
  const result = lorebook.quarantineSuspectCharacters(db, project.id);
  assert.equal(result.quarantined, 1);
  const row = db.get<{ review_status: string; quarantine_reason: string }>(
    'SELECT review_status, quarantine_reason FROM canon_entity WHERE id = ?',
    bill,
  );
  assert.equal(row?.review_status, 'quarantined');
  assert.ok((row?.quarantine_reason ?? '').length > 0);
  db.close();
});

test('a one-mention character with a unique name is left alone', () => {
  const { db, project } = setup('quarantine-unique', 'Mara paid the bill and left the shop.');
  const zara = entity(db, project.id, 'Zara');
  const result = lorebook.quarantineSuspectCharacters(db, project.id);
  assert.equal(result.quarantined, 0);
  const row = db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', zara);
  assert.equal(row?.review_status, 'accepted');
  db.close();
});

test('a second mention releases the character', () => {
  const { db, project } = setup('quarantine-release', 'Mara paid the bill and left the shop.');
  const bill = entity(db, project.id, 'Bill');
  lorebook.quarantineSuspectCharacters(db, project.id);
  db.run('UPDATE canon_entity SET mentions = 2 WHERE id = ?', bill);
  const result = lorebook.quarantineSuspectCharacters(db, project.id);
  assert.equal(result.released, 1);
  const row = db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', bill);
  assert.equal(row?.review_status, 'accepted');
  db.close();
});

test('one more occurrence of the common word does not release it', () => {
  const { db, project } = setup('quarantine-norelease', 'Mara paid the bill and left the shop.');
  const bill = entity(db, project.id, 'Bill');
  lorebook.quarantineSuspectCharacters(db, project.id);
  chunk(db, project.id, 'She paid another bill the next day.');
  const result = lorebook.quarantineSuspectCharacters(db, project.id);
  assert.equal(result.released, 0);
  db.close();
});

test('a tie with a quarantined character is refused', () => {
  const { db, project } = setup('quarantine-guard', 'Mara paid the bill and left the shop.');
  const mara = entity(db, project.id, 'Mara');
  const bill = entity(db, project.id, 'Bill');
  lorebook.quarantineSuspectCharacters(db, project.id);
  const evidence = 'Mara was an ally of Bill.';
  const decision = lorebook.canPromote(
    { fromId: mara, toId: bill, fromName: 'Mara', toName: 'Bill', kind: 'ally of', evidence },
    { db, projectId: project.id, chunkText: evidence },
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'quarantined-entity');
  db.close();
});

test('the scan ignores quarantined characters', () => {
  const { db, project } = setup('quarantine-scan', 'Mara and Bill were allies for years, and every bill was paid.');
  entity(db, project.id, 'Mara');
  entity(db, project.id, 'Bill');
  lorebook.quarantineSuspectCharacters(db, project.id);
  const candidates = lorebook.scanSentenceCandidates(db, project.id);
  assert.equal(candidates.length, 0);
  db.close();
});
