/**
 * Mechanical proof + the chained veto.
 *
 * A row banks only when the sentence names both people, the arrow matches the
 * sentence's grammar, the kind is specific, and both endpoints are persons.
 * The veto then gets a last word, and only to remove.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../../fanfable/src/core/db.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { applyVeto, vetoDecision } from '../../fanfable/src/gates/veto.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function projectWith(sentence: string): { db: Db; projectId: number; ids: Map<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-mech-'));
  const book = join(dir, 'book.txt');
  writeFileSync(book, ['ONE', '', sentence, ''].join('\n'));
  const db = new Db(join(dir, 'test.db'));
  const project = controller.createProject(db, 'mech');
  lore.importSource(db, project.id, book);
  const chunkId = db.all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY id', project.id)[0]!.id;
  const ids = new Map<string, number>();
  for (const person of ['Harry Potter', 'Uncle Vernon']) {
    ids.set(person, Number(db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      project.id, 'character', person, '[]', sentence,
      JSON.stringify([{ source: 'book', locator: 'p. 1', chunk: chunkId }]), AT, AT,
    ).lastInsertRowid));
  }
  return { db, projectId: project.id, ids };
}

function decision(
  db: Db, projectId: number, ids: Map<string, number>, kind: string, evidence: string,
  from = 'Harry Potter', to = 'Uncle Vernon',
) {
  const chunk = db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY id', projectId)[0]!;
  return lorebook.canPromote(
    {
      fromId: ids.get(from)!, toId: ids.get(to)!,
      fromName: from, toName: to, kind, evidence,
    },
    { db, projectId, chunkText: chunk.text, minConfidence: 0.7 },
  );
}

test('a backwards arrow never banks: the child named as father is refused', () => {
  // The sentence makes Harry the child, so "Harry father of Vernon" is backwards.
  const { db, projectId, ids } = projectWith('Harry Potter was the son of Uncle Vernon.');
  const verdict = decision(db, projectId, ids, 'father of', 'Harry Potter was the son of Uncle Vernon.');
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, 'direction-mismatch');
  db.close();
});

test('the same sentence banks the arrow it states', () => {
  const { db, projectId, ids } = projectWith('Uncle Vernon was the father of Harry Potter.');
  const verdict = decision(db, projectId, ids, 'father of', 'Uncle Vernon was the father of Harry Potter.',
    'Uncle Vernon', 'Harry Potter');
  assert.equal(verdict.ok, true);
  db.close();
});

test('a generic kind never banks', () => {
  const { db, projectId, ids } = projectWith('Harry Potter was related to Uncle Vernon by marriage.');
  const verdict = decision(db, projectId, ids, 'related to', 'Harry Potter was related to Uncle Vernon');
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, 'generic-kind');
  db.close();
});

test('a non-person endpoint never banks', () => {
  const { db, projectId, ids } = projectWith('Harry Potter was the father of Uncle Vernon.');
  db.run("UPDATE canon_entity SET kind = 'location' WHERE id = ?", ids.get('Uncle Vernon')!);
  const verdict = decision(db, projectId, ids, 'father of', 'Harry Potter was the father of Uncle Vernon.');
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, 'non-person-endpoint');
  db.close();
});

test('the veto rejects an invented but plausible claim at 0.60', async () => {
  const row = {
    fromName: 'A', toName: 'B', kind: 'ally of',
    sentence: 'A and B were in the same room.', chunkText: 'A and B were in the same room.',
  };
  const invented = { score: async () => 0.41 };
  const real = { score: async () => 0.83 };
  const rejected = await applyVeto([row], invented);
  assert.equal(rejected.kept.length, 0);
  assert.equal(rejected.rejected.length, 1);
  const kept = await applyVeto([row], real);
  assert.equal(kept.kept.length, 1);
});

test('the veto threshold and its removable form', () => {
  assert.equal(vetoDecision(0.599).pass, false);
  assert.equal(vetoDecision(0.6).pass, true);
  assert.equal(vetoDecision(Number.NaN).pass, false);
});

test('removing the veto leaves the rows, never a broken pipe', async () => {
  const row = { fromName: 'A', toName: 'B', kind: 'ally of', sentence: 'x', chunkText: 'x' };
  const out = await applyVeto([row], undefined);
  assert.equal(out.kept.length, 1);
  assert.equal(out.rejected.length, 0);
});
