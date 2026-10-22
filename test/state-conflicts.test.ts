import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectConflicts, saveConflicts, listConflicts, resolveConflict } from '../src/state-conflicts.ts';
import * as memory from '../src/memory.ts';
import { seedProject, tempDb } from './helpers.ts';

const BASE_EXTRACTION: memory.StateExtraction = {
  summary: 's',
  events: [],
  characters: [],
  states: [],
  knowledge: [],
  relationships: [],
  threads: [],
  facts: [],
  canonChanges: [],
};

function established(db: ReturnType<typeof tempDb>['db'], projectId: number) {
  const serena = memory.upsertCharacter(db, projectId, 'Serena Marsh');
  const kade = memory.upsertCharacter(db, projectId, 'Kade');
  memory.addCharacterState(db, projectId, serena, {
    location: 'the ridge',
    condition: 'soaked',
    situation: 'waiting',
    source: 'au',
  });
  memory.upsertRelationship(db, projectId, serena, kade, {
    kind: 'companions',
    description: 'unspoken understanding',
    source: 'au',
  });
  memory.addFact(db, projectId, {
    kind: 'fact',
    subject: 'Serena Marsh',
    content: 'Serena is alive.',
    certainty: 'established',
  });
  return { serena, kade };
}

test('a character recorded alive cannot quietly become dead', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-status');
  established(db, project.id);

  const conflicts = detectConflicts(db, project.id, 1, {
    ...BASE_EXTRACTION,
    states: [{ character: 'Serena Marsh', condition: 'dead', situation: 'her body is cold' }],
  });
  const status = conflicts.find((c) => c.kind === 'character-status');
  assert.ok(status, 'the contradiction is reported');
  assert.match(status!.message, /Serena Marsh/);
  assert.ok(status!.existingRef.length > 0, 'the established record is cited');
  db.close();
});

test('a relationship that changes without a cause is reported', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-relationship');
  established(db, project.id);

  const conflicts = detectConflicts(db, project.id, 1, {
    ...BASE_EXTRACTION,
    relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'estranged', description: 'he resents her' }],
  });
  const rel = conflicts.find((c) => c.kind === 'relationship');
  assert.ok(rel, 'the unexplained change is reported');
  assert.match(rel!.message, /companions/);
  assert.match(rel!.message, /estranged/);
  db.close();
});

test('a fact that contradicts an established fact is reported', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-fact');
  established(db, project.id);

  const conflicts = detectConflicts(db, project.id, 1, {
    ...BASE_EXTRACTION,
    facts: [{ kind: 'fact', subject: 'Serena Marsh', content: 'Serena is dead.' }],
  });
  const fact = conflicts.find((c) => c.kind === 'fact');
  assert.ok(fact, 'the contradiction is reported');
  db.close();
});

test('a belief becoming knowledge is not a conflict', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-knowledge-ok');
  const { serena } = established(db, project.id);
  memory.addKnowledge(db, project.id, {
    characterId: serena,
    fact: 'the lantern was meant for her',
    certainty: 'believes',
    source: 'au',
  });

  const conflicts = detectConflicts(db, project.id, 1, {
    ...BASE_EXTRACTION,
    knowledge: [{ character: 'Serena Marsh', fact: 'the lantern was meant for her', certainty: 'knows' }],
  });
  assert.ok(!conflicts.some((c) => c.kind === 'knowledge'), 'a reveal is not a conflict');
  db.close();
});

test('knowledge going backwards is reported', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-knowledge-bad');
  const { serena } = established(db, project.id);
  memory.addKnowledge(db, project.id, {
    characterId: serena,
    fact: 'the lantern was meant for her',
    certainty: 'knows',
    source: 'au',
  });

  const conflicts = detectConflicts(db, project.id, 1, {
    ...BASE_EXTRACTION,
    knowledge: [{ character: 'Serena Marsh', fact: 'the lantern was meant for her', certainty: 'believes' }],
  });
  assert.ok(conflicts.some((c) => c.kind === 'knowledge'), 'losing knowledge is reported');
  db.close();
});

test('conflicts are recorded with their provenance and can be resolved', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-record');
  established(db, project.id);
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'approved', 'x', '2024', '2024')",
    project.id,
  );
  const chapterId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', project.id)!.id;
  const conflicts = detectConflicts(db, project.id, chapterId, {
    ...BASE_EXTRACTION,
    relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'estranged' }],
  });
  saveConflicts(db, project.id, chapterId, conflicts);

  const open = listConflicts(db, project.id, { openOnly: true });
  assert.equal(open.length, 1);
  assert.ok(open[0].message.length > 0);
  assert.ok(open[0].existingRef.length > 0, 'the established record is cited');
  assert.ok(open[0].incomingRef.length > 0, 'the new claim is cited');

  resolveConflict(db, project.id, open[0].id, 'accepted');
  assert.equal(listConflicts(db, project.id, { openOnly: true }).length, 0);
  db.close();
});

test('the established record is not overwritten by a conflicting chapter', async () => {
  const { db } = tempDb();
  const project = await seedProject(db, 'conflict-no-overwrite');
  established(db, project.id);
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'approved', 'x', '2024', '2024')",
    project.id,
  );
  const chapterId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', project.id)!.id;

  // A chapter that claims a different relationship is applied the way the
  // approval does it: the old state is closed, the new one opened, and the
  // conflict recorded — the earlier state is not deleted.
  const conflicts = detectConflicts(db, project.id, chapterId, {
    ...BASE_EXTRACTION,
    relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'estranged' }],
  });
  saveConflicts(db, project.id, chapterId, conflicts);
  const pair = db.all<{ id: number }>('SELECT id FROM character WHERE project_id = ? ORDER BY id', project.id);
  memory.upsertRelationship(db, project.id, pair[0].id, pair[1].id, { kind: 'estranged', source: 'au' });

  const rows = db.all<{ kind: string; closed: number }>(
    'SELECT kind, closed FROM relationship WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.equal(rows.length, 2, 'the earlier state survives');
  assert.equal(rows[0].kind, 'companions');
  assert.equal(rows[0].closed, 1);
  assert.equal(rows[1].kind, 'estranged');
  assert.equal(rows[1].closed, 0);
  db.close();
});
