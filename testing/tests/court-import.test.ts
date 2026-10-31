/**
 * The external verdict importer: one ruling per graded claim, idempotent,
 * and a C verdict never demotes a human-confirmed row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import { createProject } from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const SCRIPT = resolve(import.meta.dirname, '../trials/grade-claims/import-verdicts.ts');
const ROOT = resolve(import.meta.dirname, '../..');

function setup(status: string) {
  const { db, path } = tempDb();
  const project = createProject(db, `import-${Math.random().toString(36).slice(2, 7)}`);
  const addEntity = (name: string): number =>
    Number(
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project.id,
        'character',
        name,
        '[]',
        'accepted',
        AT,
        AT,
      ).lastInsertRowid,
    );
  const mara = addEntity('Mara');
  const tor = addEntity('Tor');
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/import',
      'Import',
      'sha-import',
      AT,
    ).lastInsertRowid,
  );
  const chunk = Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      project.id,
      1,
      'p. 1',
      '',
      'Mara is the aunt of Tor.',
      6,
    ).lastInsertRowid,
  );
  const row = lorebook.insertRelation(db, project.id, {
    fromEntity: mara,
    toEntity: tor,
    kind: 'aunt of',
    evidence: 'Mara is the aunt of Tor.',
    sourceRefs: JSON.stringify([{ source: 'Import', locator: 'p. 1', chunk }]),
    reviewStatus: status,
    confidence: 0.8,
  });
  return { db, path, project, row };
}

function writeInputs(row: number, verdict: string, reason = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  const key = join(dir, 'key.csv');
  const verdicts = join(dir, 'verdicts.csv');
  writeFileSync(key, `id,pair,claim_id,relation_ids,signal\nP001,"Mara / Tor",${row},${row},none\n`);
  writeFileSync(verdicts, `id,verdict,quote,locator,reason\nP001,${verdict},,,${reason}\n`);
  return { key, verdicts };
}

function run(s: ReturnType<typeof setup>, files: { key: string; verdicts: string }, ...flags: string[]): string {
  return execFileSync(
    process.execPath,
    ['--no-warnings', SCRIPT, s.path, s.project.name, files.key, files.verdicts, ...flags],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

test('import writes one external verdict, keeps the status, and is idempotent', () => {
  const s = setup('attested');
  const files = writeInputs(s.row, 'B');
  s.db.close();

  const first = run(s, files, '--write');
  assert.match(first, /imported 1/);
  const db = new Db(s.path);
  const rows = db.all<{ role: string; actor: string; standard: string; to_status: string; basis: string }>(
    "SELECT role, actor, standard, to_status, basis FROM canon_ruling WHERE relation_id = ? AND actor = 'external'",
    s.row,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.role, 'verdict');
  assert.equal(rows[0]!.standard, 'blind-passage');
  assert.equal(rows[0]!.to_status, 'attested');
  assert.match(rows[0]!.basis, /^B/);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', s.row)!.review_status,
    'attested',
  );
  db.close();

  const second = run(s, files, '--write');
  assert.match(second, /already recorded 1/);
  const again = new Db(s.path);
  assert.equal(
    again.all("SELECT id FROM canon_ruling WHERE relation_id = ? AND actor = 'external'", s.row).length,
    1,
    'a second import adds no duplicate',
  );
  again.close();
});

test('a C verdict demotes a machine row and records the new status', () => {
  const s = setup('attested');
  const files = writeInputs(s.row, 'C', 'cooccurrence');
  s.db.close();
  run(s, files, '--write', '--demote-c');
  const db = new Db(s.path);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', s.row)!.review_status,
    'needs_review',
  );
  const row = db.get<{ from_status: string; to_status: string; basis: string }>(
    "SELECT from_status, to_status, basis FROM canon_ruling WHERE relation_id = ? AND actor = 'external'",
    s.row,
  )!;
  assert.equal(row.from_status, 'attested');
  assert.equal(row.to_status, 'needs_review');
  assert.match(row.basis, /^C/);
  db.close();
});

test('a C verdict never demotes a human-confirmed row', () => {
  const s = setup('user_confirmed');
  const files = writeInputs(s.row, 'C', 'cooccurrence');
  s.db.close();
  run(s, files, '--write', '--demote-c');
  const db = new Db(s.path);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', s.row)!.review_status,
    'user_confirmed',
  );
  const row = db.get<{ to_status: string; basis: string }>(
    "SELECT to_status, basis FROM canon_ruling WHERE relation_id = ? AND actor = 'external'",
    s.row,
  )!;
  assert.equal(row.to_status, 'user_confirmed');
  assert.match(row.basis, /^C/);
  db.close();
});
