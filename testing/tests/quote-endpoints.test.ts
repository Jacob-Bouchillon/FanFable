/**
 * Quote endpoints: a quote must name both sides at two different places. A
 * single surface string cannot stand for both — otherwise a row carrying
 * another row's name as an alias proves a relationship between a person and
 * themself. Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string, aliases: string[] = [], kind = 'character'): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      projectId,
      kind,
      name,
      JSON.stringify(aliases),
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function project(name: string) {
  const { db } = tempDb();
  const p = controller.createProject(db, name);
  return { db, project: p };
}

test('two separate mentions name both endpoints', () => {
  const ok = lorebook.namesBothDistinctly(
    'Mara was an ally of Captain Mara.',
    'Mara',
    [],
    'Captain Mara',
    [],
  );
  assert.equal(ok, true);
});

test('one shared surface string names one endpoint, not two', () => {
  const ok = lorebook.namesBothDistinctly(
    'Mara was an ally of the house.',
    'Mara',
    [],
    'Captain Mara',
    ['Mara'],
  );
  assert.equal(ok, false);
});

test('a name inside a longer name is the same mention', () => {
  const ok = lorebook.namesBothDistinctly(
    'The son of Hego Damask took the seat.',
    'Damask',
    [],
    'Hego Damask',
    [],
  );
  assert.equal(ok, false);
});

test('case and punctuation do not split a mention', () => {
  const ok = lorebook.namesBothDistinctly(
    'MARA, the captain, trusted Ola Vane.',
    'Mara',
    [],
    'Ola Vane',
    [],
  );
  assert.equal(ok, true);
});

test('promotion refuses a single shared mention', () => {
  const { db, project: p } = project('endpoint-shared');
  const a = entity(db, p.id, 'Mara', ['The Captain']);
  const b = entity(db, p.id, 'The Captain');
  const evidence = 'The Captain gave the order.';
  const decision = lorebook.canPromote(
    { fromId: a, toId: b, fromName: 'Mara', toName: 'The Captain', kind: 'ally of', evidence },
    { db, projectId: p.id, chunkText: evidence },
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'endpoint-unnamed');
  db.close();
});

test('promotion accepts two separate mentions', () => {
  const { db, project: p } = project('endpoint-two');
  const a = entity(db, p.id, 'Mara');
  const b = entity(db, p.id, 'Tor');
  const evidence = 'Mara was an ally of Tor.';
  const decision = lorebook.canPromote(
    { fromId: a, toId: b, fromName: 'Mara', toName: 'Tor', kind: 'ally of', evidence },
    { db, projectId: p.id, chunkText: evidence },
  );
  assert.equal(decision.ok, true);
  db.close();
});

test('nested character names are one person, not a tie', () => {
  const { db, project: p } = project('endpoint-nested');
  const a = entity(db, p.id, 'Mara');
  const b = entity(db, p.id, 'Captain Mara');
  const evidence = 'Mara was an ally of Captain Mara.';
  const decision = lorebook.canPromote(
    { fromId: a, toId: b, fromName: 'Mara', toName: 'Captain Mara', kind: 'ally of', evidence },
    { db, projectId: p.id, chunkText: evidence },
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'same-identity');
  db.close();
});

test('a faction and a person with nested names are not one identity', () => {
  const { db, project: p } = project('endpoint-faction');
  const a = entity(db, p.id, 'Mara');
  const b = entity(db, p.id, 'House Mara', [], 'faction');
  const evidence = 'Mara was an ally of House Mara.';
  const decision = lorebook.canPromote(
    { fromId: a, toId: b, fromName: 'Mara', toName: 'House Mara', kind: 'ally of', evidence },
    { db, projectId: p.id, chunkText: evidence },
  );
  assert.notEqual(decision.reason, 'same-identity');
  db.close();
});
