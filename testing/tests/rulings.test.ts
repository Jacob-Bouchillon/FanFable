/**
 * Rulings export/replay: decisions travel by name, never by row id.
 * Invented names only; no model calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  aliases: string[] = [],
): number {
  return db.run(
    `INSERT INTO canon_entity
       (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
     VALUES (?, 'character', ?, ?, '', '', 1, '', '[]', 'accepted', ?, ?)`,
    projectId,
    name,
    JSON.stringify(aliases),
    AT,
    AT,
  ).lastInsertRowid;
}

function addChunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  text: string,
): number {
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    '/probe-source',
    'Probe',
    'sha-probe',
    AT,
  ).lastInsertRowid;
  return db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    projectId,
    1,
    'p. 1',
    '',
    text,
    text.split(/\s+/).length,
  ).lastInsertRowid;
}

function addRelation(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  status: string,
  evidence = '',
): number {
  return db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence, review_status, created_at)
     VALUES (?, ?, ?, ?, '', ?, '[]', 1.0, ?, ?)`,
    projectId,
    from,
    to,
    kind,
    evidence,
    status,
    AT,
  ).lastInsertRowid;
}

function addNote(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  attemptedKind: string,
  status: string,
  ruling: string,
  evidence = '',
): number {
  return db.run(
    `INSERT INTO canon_tie_note
       (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, ruling, ruled_at, created_at)
     VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?, '', ?)`,
    projectId,
    from,
    to,
    attemptedKind,
    evidence,
    status,
    ruling,
    AT,
  ).lastInsertRowid;
}

function keeper(
  fromName: string,
  toName: string,
  kind: string,
  reviewStatus = 'user_confirmed',
  evidence = '',
  fromAliases: string[] = [],
  toAliases: string[] = [],
): lorebook.RulingsExportKeeper {
  return {
    from_name: fromName,
    from_aliases: fromAliases,
    to_name: toName,
    to_aliases: toAliases,
    kind,
    review_status: reviewStatus,
    evidence,
    locator: 'p. 1',
    exported_at: AT,
  };
}

function note(
  fromName: string,
  toName: string,
  attemptedKind: string,
  status: string,
  ruling: string,
  evidence = '',
): lorebook.RulingsExportNote {
  return { from_name: fromName, to_name: toName, attempted_kind: attemptedKind, status, ruling, evidence };
}

function payload(
  keepers: lorebook.RulingsExportKeeper[],
  notes: lorebook.RulingsExportNote[] = [],
  identities: lorebook.RulingsExportIdentity[] = [],
): lorebook.RulingsExport {
  return {
    version: 1,
    counters: {
      project: 'probe',
      keepers: keepers.length,
      note_rulings: notes.length,
      identities: identities.length,
    },
    keepers,
    note_rulings: notes,
    identities,
  };
}

test('export is deterministic, sorted and name-keyed', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-export');
  const asha = addEntity(db, project.id, 'Asha', ['the Asha', 'Ash']);
  const corin = addEntity(db, project.id, 'Corin');
  addEntity(db, project.id, 'Plain');
  addRelation(db, project.id, asha, corin, 'rival of', 'accepted', 'They argued.');
  addRelation(db, project.id, asha, corin, 'ally of', 'user_confirmed', 'They stood together.');
  addRelation(db, project.id, corin, asha, 'ally of', 'needs_review', 'Doubtful.');
  addNote(db, project.id, corin, asha, 'master of', 'resolved', 'KEEP');
  addNote(db, project.id, asha, corin, 'friend of', 'pending', '');

  const first = lorebook.exportRulings(db, project.id, { now: AT });
  const second = lorebook.exportRulings(db, project.id, { now: AT });
  assert.deepEqual(first, second);
  assert.equal(first.counters.project, 'rulings-export');
  assert.equal(first.counters.keepers, 2);
  assert.equal(first.counters.note_rulings, 1);
  assert.equal(first.counters.identities, 1);
  assert.deepEqual(first.identities, [{ name: 'Asha', aliases: ['Ash', 'the Asha'] }]);
  assert.deepEqual(
    first.keepers.map((row) => `${row.from_name}|${row.to_name}|${row.kind}`),
    ['Asha|Corin|ally of', 'Asha|Corin|rival of'],
  );
  assert.equal(first.note_rulings[0]!.ruling, 'KEEP');
  assert.ok(!('from_id' in first.keepers[0]!));
  assert.ok(!('to_id' in first.keepers[0]!));
  db.close();
});

test('a missing keeper is inserted when its quote still verifies', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-insert');
  const chunk = addChunk(db, project.id, 'Asha counted the lantern before dawn.');
  const asha = addEntity(db, project.id, 'Asha');
  const corin = addEntity(db, project.id, 'Corin');
  const result = lorebook.replayRulings(
    db,
    project.id,
    payload([keeper('Asha', 'Corin', 'ally of', 'user_confirmed', 'Asha counted the lantern before dawn.')]),
    { write: true },
  );
  assert.equal(result.keepers.resolved, 1);
  assert.equal(result.keepers.applied, 1);
  assert.equal(result.keepers.unresolved, 0);
  const row = db.get<{ from_entity: number; to_entity: number; review_status: string; evidence: string; source_refs: string }>(
    'SELECT from_entity, to_entity, review_status, evidence, source_refs FROM canon_relation WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(row.from_entity, asha);
  assert.equal(row.to_entity, corin);
  assert.equal(row.review_status, 'user_confirmed');
  assert.equal(row.evidence, 'Asha counted the lantern before dawn.');
  assert.deepEqual(JSON.parse(row.source_refs), [{ source: 'Probe', locator: 'p. 1', chunk }]);
  db.close();
});

test('a stored relation is upgraded to user_confirmed and never downgraded', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-upgrade');
  const asha = addEntity(db, project.id, 'Asha');
  const corin = addEntity(db, project.id, 'Corin');
  const relation = addRelation(db, project.id, asha, corin, 'ally of', 'needs_review');
  const upgraded = lorebook.replayRulings(
    db,
    project.id,
    payload([keeper('Asha', 'Corin', 'ally of', 'user_confirmed', 'quote absent')]),
    { write: true },
  );
  assert.equal(upgraded.keepers.applied, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', relation)!.review_status,
    'user_confirmed',
  );

  const downgrade = lorebook.replayRulings(
    db,
    project.id,
    payload([keeper('Asha', 'Corin', 'ally of', 'accepted', 'quote absent')]),
    { write: true },
  );
  assert.equal(downgrade.keepers.applied, 0);
  assert.equal(downgrade.keepers.already_present, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', relation)!.review_status,
    'user_confirmed',
  );
  db.close();
});

test('an alias resolves to its survivor and an exported identity survives a rename', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-alias');
  const chunk = addChunk(db, project.id, 'The keeper met the envoy at dusk.');
  addEntity(db, project.id, 'Asha', ['Ashen']);
  addEntity(db, project.id, 'Corin');
  const direct = lorebook.replayRulings(
    db,
    project.id,
    payload([keeper('Ashen', 'Corin', 'ally of', 'user_confirmed', 'The keeper met the envoy at dusk.')]),
    { write: true },
  );
  assert.equal(direct.keepers.applied, 1);

  // A second bank extracted the survivor under its old alias only. The
  // exported identity is what still links the survivor name to that row.
  const { db: other } = tempDb();
  const otherProject = controller.createProject(other, 'rulings-alias-renamed');
  addChunk(other, otherProject.id, 'The keeper met the envoy at dusk.');
  addEntity(other, otherProject.id, 'Ashen');
  addEntity(other, otherProject.id, 'Corin');
  const renamed = lorebook.replayRulings(
    other,
    otherProject.id,
    payload(
      [keeper('Asha', 'Corin', 'rival of', 'user_confirmed', 'The keeper met the envoy at dusk.')],
      [],
      [{ name: 'Asha', aliases: ['Ashen'] }],
    ),
    { write: true },
  );
  assert.equal(renamed.keepers.resolved, 1);
  assert.equal(renamed.keepers.applied, 1);
  assert.equal(renamed.identities.resolved, 1);
  other.close();
  db.close();
});

test('missing names and unverified quotes are reported with reasons', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-unresolved');
  addChunk(db, project.id, 'Asha counted the lantern before dawn.');
  addEntity(db, project.id, 'Asha');
  addEntity(db, project.id, 'Corin');
  const result = lorebook.replayRulings(
    db,
    project.id,
    payload([
      keeper('Nobody', 'Corin', 'ally of', 'user_confirmed', 'Asha counted the lantern before dawn.'),
      keeper('Asha', 'Corin', 'ally of', 'user_confirmed', 'This sentence is not in the book.'),
    ]),
    { write: true },
  );
  assert.equal(result.keepers.total, 2);
  assert.equal(result.keepers.resolved, 1);
  assert.equal(result.keepers.unresolved, 2);
  assert.deepEqual(
    result.issues.map((issue) => issue.reason),
    ['name not found', 'quote not found'],
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('a note ruling is inserted, then idempotent, and dry run writes nothing', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-notes');
  addChunk(db, project.id, 'Asha counted the lantern before dawn.');
  addEntity(db, project.id, 'Asha');
  addEntity(db, project.id, 'Corin');
  const exported = payload([], [note('Asha', 'Corin', 'master of', 'resolved', 'KEEP', 'Asha counted the lantern before dawn.')]);

  const dry = lorebook.replayRulings(db, project.id, exported, { write: false });
  assert.equal(dry.note_rulings.applied, 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', project.id)!.n, 0);

  const first = lorebook.replayRulings(db, project.id, exported, { write: true });
  assert.equal(first.note_rulings.applied, 1);
  const row = db.get<{ from_entity: number; to_entity: number; status: string; ruling: string }>(
    'SELECT from_entity, to_entity, status, ruling FROM canon_tie_note WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(row.status, 'resolved');
  assert.equal(row.ruling, 'KEEP');

  const second = lorebook.replayRulings(db, project.id, exported, { write: true });
  assert.equal(second.note_rulings.applied, 0);
  assert.equal(second.note_rulings.already_present, 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', project.id)!.n, 1);
  db.close();
});

test('a real replay is idempotent across two runs', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-idempotent');
  addChunk(db, project.id, 'Asha counted the lantern before dawn.');
  addEntity(db, project.id, 'Asha');
  addEntity(db, project.id, 'Corin');
  const exported = payload([
    keeper('Asha', 'Corin', 'ally of', 'user_confirmed', 'Asha counted the lantern before dawn.'),
  ]);
  lorebook.replayRulings(db, project.id, exported, { write: true });
  const snapshot = () =>
    JSON.stringify({
      relations: db.all('SELECT from_entity, to_entity, kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id', project.id),
      notes: db.all('SELECT from_entity, to_entity, attempted_kind, status, ruling FROM canon_tie_note WHERE project_id = ? ORDER BY id', project.id),
    });
  const before = snapshot();
  const second = lorebook.replayRulings(db, project.id, exported, { write: true });
  assert.equal(second.keepers.applied, 0);
  assert.equal(second.keepers.already_present, 1);
  assert.equal(snapshot(), before);
  db.close();
});

test('malformed exports are rejected with a clear message', () => {
  assert.throws(() => lorebook.parseRulingsExport({ hello: 'world' }), /not a rulings export/);
  assert.throws(
    () => lorebook.parseRulingsExport(payload([{ from_name: 'Asha' } as never])),
    /keepers\[0\]\.to_name must be a string/,
  );
  const { db } = tempDb();
  const project = controller.createProject(db, 'rulings-malformed');
  assert.throws(
    () => lorebook.replayRulings(db, project.id, { version: 1 }, { write: false }),
    /not a rulings export: missing counters/,
  );
  db.close();
});

test('the CLI exports a file and replays it in dry-run without writing', () => {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'rulings-cli');
  addChunk(db, project.id, 'Asha counted the lantern before dawn.');
  const asha = addEntity(db, project.id, 'Asha');
  const corin = addEntity(db, project.id, 'Corin');
  addRelation(db, project.id, asha, corin, 'ally of', 'user_confirmed', 'Asha counted the lantern before dawn.');
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-rulings-'));
  const out = join(dir, 'export.json');
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const run = (...extra: string[]) =>
    execFileSync(process.execPath, ['--no-warnings', cli, '--db', path, '--project', project.name, 'lore', 'rulings', ...extra], {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
    });

  const exported = run('export', '--out', out);
  assert.match(exported, /keepers 1, note_rulings 0, identities 0/);
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as lorebook.RulingsExport;
  assert.equal(parsed.counters.keepers, 1);

  const replay = run('replay', '--in', out, '--dry-run');
  assert.match(replay, /keepers\s+total 1, resolved 1, applied 0, already_present 1, unresolved 0/);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n, 1);
  db.close();
});
