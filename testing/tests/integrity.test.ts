/** Standing keeper-evidence integrity audit and confirmed_by_user migration. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { runMigrations } from '../../fanfable/src/migrations.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const CHUNK = "Asha is Bram's sister. The gate was cold. They left.";

function setup(chunkText = CHUNK) {
  const { db } = tempDb();
  const project = controller.createProject(db, `integrity-${Math.random().toString(36).slice(2, 7)}`);
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/probe', 'Probe', 'sha', AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, project.id, 1, 'p. 1', '', chunkText, 10,
  ).lastInsertRowid;
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, '[]', AT, AT,
  ).lastInsertRowid;
  const asha = mk('Asha');
  const bram = mk('Bram');
  const add = (evidence: string, refs: string, status = 'accepted'): number => db.run(
    `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
     VALUES (?, ?, ?, 'sister of', ?, ?, ?, ?)`,
    project.id, asha, bram, evidence, refs, status, AT,
  ).lastInsertRowid;
  const refs = JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]);
  return { db, project, chunkId, add, refs };
}

test('a verbatim keeper passes', () => {
  const { db, project, add, refs } = setup();
  add("Asha is Bram's sister.", refs);
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);
  db.close();
});

test('an invented quote fails', () => {
  const { db, project, add, refs } = setup();
  add("Asha is Bram's cousin.", refs);
  const rows = lorebook.findUnverifiedKeepers(db, project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, 'quote-not-verbatim');
  db.close();
});

test('a spliced quote fails even when each sentence exists', () => {
  const { db, project, add, refs } = setup();
  add("Asha is Bram's sister. They left.", refs);
  const rows = lorebook.findUnverifiedKeepers(db, project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, 'quote-not-verbatim');
  db.close();
});

test('a keeper with no chunk ref fails', () => {
  const { db, project, add } = setup();
  add("Asha is Bram's sister.", JSON.stringify([{ source: 'Probe', locator: 'p. 1' }]));
  const rows = lorebook.findUnverifiedKeepers(db, project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, 'no-ref');
  db.close();
});

test('quotes, dashes, case and whitespace normalise without joining sentences', () => {
  const { db, project, add, refs } = setup('"Asha — Bram\'s sister." The gate was cold.');
  add('“Asha – Bram’s   SISTER.”', refs);
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);
  db.close();
});

test('provisional rows are not reported as keepers', () => {
  const { db, project, add, refs } = setup();
  add("Asha is Bram's cousin.", refs, 'provisional');
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);
  db.close();
});

test('migration v15 adds and backfills confirmed_by_user', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 24);
  assert.ok(db.all<{ name: string }>('PRAGMA table_info(canon_relation)').some((row) => row.name === 'confirmed_by_user'));

  const project = controller.createProject(db, 'provenance');
  const now = AT;
  const a = db.run('INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', project.id, 'character', 'Asha', '[]', now, now).lastInsertRowid;
  const b = db.run('INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', project.id, 'character', 'Bram', '[]', now, now).lastInsertRowid;
  const rel = db.run(
    "INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, confirmed_by_user, created_at) VALUES (?, ?, ?, 'sister of', 'q', '[]', 'user_confirmed', 0, ?)",
    project.id, a, b, now,
  ).lastInsertRowid;
  db.raw.exec('PRAGMA user_version = 14');
  assert.equal(runMigrations(db.raw), 24);
  assert.equal(db.get<{ confirmed_by_user: number }>('SELECT confirmed_by_user FROM canon_relation WHERE id = ?', rel)!.confirmed_by_user, 1);
  db.close();
});
