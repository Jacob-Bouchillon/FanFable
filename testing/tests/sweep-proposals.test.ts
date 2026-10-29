/**
 * Name sweep: derived ties become pending proposals, never relations.
 * Generic names only; one scripted mock provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { runNameSweep } from '../../fanfable/src/sweep.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

const QUOTE = "Mara's brother, Corin, waited inside.";

function addEntity(db: Db, projectId: number, name: string, mentions = 1, kind = 'character'): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '', '', ?, '', '[]', 'accepted', ?, ?)`,
      projectId,
      kind,
      name,
      mentions,
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
      '/sweep-source',
      'Probe',
      'sha-sweep',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  status: string,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, created_at)
       VALUES (?, ?, ?, ?, '', '', '[]', 1.0, ?, ?)`,
      projectId,
      from,
      to,
      kind,
      status,
      AT,
    ).lastInsertRowid,
  );
}

/** The model answers with line numbers; the quote is fetched by index. */
function sweepProvider() {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.startsWith('You track one character')) {
      return JSON.stringify({ ties: [], notes: [{ name: 'Corin', says: "is Mara's brother", line: 1 }] });
    }
    if (system.includes('"ties":[{"to":"name"')) {
      return JSON.stringify({ ties: [{ to: 'Corin', kind: 'brother of', line: 1 }] });
    }
    return '{}';
  });
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const mara = addEntity(db, project.id, 'Mara', 5);
  const corin = addEntity(db, project.id, 'Corin', 2);
  addEntity(db, project.id, 'Tor', 1);
  const chunk = addChunk(db, project.id, "Mara met Tor at the gate. Mara's brother, Corin, waited inside.");
  return { db, project: project.id, mara, corin, chunk };
}

test('a derived tie becomes a pending proposal with a verbatim quote', async () => {
  const { db, project, mara, corin, chunk } = setup('sweep-proposal');
  const result = await runNameSweep(db, sweepProvider(), project, { batchSize: 60 });

  assert.equal(result.proposals, 1);
  assert.equal(result.queueBefore, 0);
  assert.equal(result.queueAfter, 1);
  assert.equal(result.characters.length, 3, 'every non-quarantined character is swept');

  const note = db.get<{
    from_entity: number;
    to_entity: number;
    attempted_kind: string;
    reason: string;
    evidence: string;
    source_refs: string;
    status: string;
    ruling: string;
  }>('SELECT * FROM canon_tie_note WHERE project_id = ?', project)!;
  assert.equal(note.from_entity, mara);
  assert.equal(note.to_entity, corin);
  assert.equal(note.attempted_kind, 'brother of');
  assert.equal(note.reason, 'sweep-proposal');
  assert.equal(note.status, 'pending');
  assert.equal(note.ruling, '');
  assert.equal(note.evidence, QUOTE);
  assert.deepEqual(JSON.parse(note.source_refs), [{ source: 'Probe', locator: 'p. 1', chunk }]);
  db.close();
});

test('a pair holding a keeper is skipped', async () => {
  const { db, project, mara, corin } = setup('sweep-keeper');
  addRelation(db, project, mara, corin, 'friend of', 'accepted');
  const result = await runNameSweep(db, sweepProvider(), project, { batchSize: 60 });
  assert.equal(result.proposals, 0);
  assert.equal(result.skippedKeeper, 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', project)!.n, 0);
  db.close();
});

test('a second sweep adds no duplicates', async () => {
  const { db, project } = setup('sweep-idempotent');
  const first = await runNameSweep(db, sweepProvider(), project, { batchSize: 60 });
  assert.equal(first.proposals, 1);

  const second = await runNameSweep(db, sweepProvider(), project, { batchSize: 60 });
  assert.equal(second.proposals, 0);
  assert.equal(second.skippedPending, 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', project)!.n, 1);
  db.close();
});

test('the sweep never writes a relation', async () => {
  const { db, project } = setup('sweep-no-relation');
  await runNameSweep(db, sweepProvider(), project, { batchSize: 60 });
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n, 0);
  db.close();
});
