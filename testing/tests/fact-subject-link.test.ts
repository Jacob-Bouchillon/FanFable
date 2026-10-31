/**
 * Fact subject linking: exact canonical name, alias, unique short form, and a
 * conservative backfill. Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  aliases: string[] = [],
): number {
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId,
    'character',
    name,
    JSON.stringify(aliases),
    AT,
    AT,
  ).lastInsertRowid;
}

function addFact(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  statement: string,
  subject: string,
  subjectEntityId: number | null = null,
): number {
  return db.run(
    'INSERT INTO canon_fact (project_id, topic, statement, subject, evidence, source_refs, subject_entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    projectId,
    'probe',
    statement,
    subject,
    'quote',
    '[]',
    subjectEntityId,
    AT,
  ).lastInsertRowid;
}

test('resolveSubjectEntity matches exact canonical names, aliases and unique short forms', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'subject-resolve');
  const mara = addEntity(db, project.id, 'Mara Vell');
  const tovan = addEntity(db, project.id, 'Tovan Rell', ['Tov']);
  const elin = addEntity(db, project.id, 'Elin Rook');
  addEntity(db, project.id, 'Bramwell');
  addEntity(db, project.id, 'Mara Holt');

  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'mara vell'), { id: mara });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'the Mara Vell'), { id: mara });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'Mara Vell’s'), { id: mara });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'TOV'), { id: tovan });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'Elin'), { id: elin });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'Bramwel'), { missing: true });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'Nobody Here'), { missing: true });
  db.close();
});

test('ambiguous names stay unlinked and report the candidate count', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'subject-ambiguous');
  addEntity(db, project.id, 'Mara Vell');
  addEntity(db, project.id, 'Mara Holt');
  addEntity(db, project.id, 'Corin Ashe', ['Corin']);
  addEntity(db, project.id, 'Corin Holt', ['Corin']);

  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'Mara'), { ambiguous: 2 });
  assert.deepEqual(lorebook.resolveSubjectEntity(db, project.id, 'Corin'), { ambiguous: 2 });
  db.close();
});

test('the backfill links dry-run, real rows, and is idempotent', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'subject-backfill');
  const mara = addEntity(db, project.id, 'Mara Vell');
  const tovan = addEntity(db, project.id, 'Tovan Rell', ['Tov']);
  addEntity(db, project.id, 'Mara Holt');
  const exact = addFact(db, project.id, 'exact fact', 'Mara Vell');
  const alias = addFact(db, project.id, 'alias fact', 'Tov');
  const ambiguous = addFact(db, project.id, 'ambiguous fact', 'Mara');
  const missing = addFact(db, project.id, 'missing fact', 'Nobody Here');
  const kept = addFact(db, project.id, 'already linked', 'Mara Vell', mara);

  const dry = lorebook.linkFactSubjects(db, project.id, { dryRun: true });
  assert.deepEqual(dry, { scanned: 4, linked: 2, ambiguous: 1, unmatched: 1 });
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ? AND subject_entity_id IS NOT NULL', project.id)!.n, 1);

  const real = lorebook.linkFactSubjects(db, project.id);
  assert.deepEqual(real, { scanned: 4, linked: 2, ambiguous: 1, unmatched: 1 });
  assert.equal(db.get<{ subject_entity_id: number }>('SELECT subject_entity_id FROM canon_fact WHERE id = ?', exact)!.subject_entity_id, mara);
  assert.equal(db.get<{ subject_entity_id: number }>('SELECT subject_entity_id FROM canon_fact WHERE id = ?', alias)!.subject_entity_id, tovan);
  assert.equal(db.get<{ subject_entity_id: number | null }>('SELECT subject_entity_id FROM canon_fact WHERE id = ?', ambiguous)!.subject_entity_id, null);
  assert.equal(db.get<{ subject_entity_id: number | null }>('SELECT subject_entity_id FROM canon_fact WHERE id = ?', missing)!.subject_entity_id, null);
  assert.equal(db.get<{ subject_entity_id: number }>('SELECT subject_entity_id FROM canon_fact WHERE id = ?', kept)!.subject_entity_id, mara);

  const second = lorebook.linkFactSubjects(db, project.id);
  assert.deepEqual(second, { scanned: 2, linked: 0, ambiguous: 1, unmatched: 1 });
  db.close();
});

test('a newly extracted fact links its subject entity', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'subject-write');
  const text = 'Asha called Tovan Rell her sister at the gate before noon.';
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    '/probe-fact',
    'Probe',
    'sha-fact',
    AT,
  ).lastInsertRowid;
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    text,
    11,
  );
  const entity = {
    kind: 'character', name: 'Asha', aliases: [], summary: 'a witness', attributes: {},
    role: '', status: '', chunk_index: 0, evidence: text,
  };
  const fact = {
    topic: 'gate', statement: 'Asha called Tovan Rell her sister.', kind: 'fact',
    certainty: 'confirmed', subject: 'Asha', chunk_index: 0, evidence: text,
  };
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"entities"')) return JSON.stringify({ entities: [entity], facts: [fact] });
    return JSON.stringify({ timeline: [] });
  });
  await lorebook.extractLore(db, llm as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);
  const asha = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Asha')!;
  const linked = db.get<{ subject: string; subject_entity_id: number | null }>(
    'SELECT subject, subject_entity_id FROM canon_fact WHERE project_id = ? AND statement = ?',
    project.id,
    fact.statement,
  )!;
  assert.equal(linked.subject, 'Asha');
  assert.equal(linked.subject_entity_id, asha.id);
  db.close();
});

test('lore link-facts reports and writes only on a non-dry run', () => {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'subject-cli');
  addEntity(db, project.id, 'Mara Vell');
  addFact(db, project.id, 'cli exact fact', 'mara vell');
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const run = (...extra: string[]) =>
    execFileSync(process.execPath, ['--no-warnings', cli, '--db', path, '--project', project.name, 'lore', 'link-facts', ...extra], {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
    });

  const dry = run('--dry-run');
  assert.match(dry, /scanned 1, linked 1, ambiguous 0, unmatched 0/);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ? AND subject_entity_id IS NOT NULL', project.id)!.n, 0);

  const real = run('--limit', '1');
  assert.match(real, /scanned 1, linked 1, ambiguous 0, unmatched 0/);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ? AND subject_entity_id IS NOT NULL', project.id)!.n, 1);

  const second = run();
  assert.match(second, /scanned 0, linked 0, ambiguous 0, unmatched 0/);
  db.close();
});
