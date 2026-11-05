/**
 * Evidence web 3D projection: read-only graph and thread detail.
 * Synthetic thread/note/meeting/birth rows only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { startServer } from '../../fanfable/src/product/server.ts';
import { buildWebGraph, webThreadDetail } from '../../fanfable/src/product/web3d.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, '[]', 'accepted', AT, AT,
  ).lastInsertRowid);
}

function thread(
  db: Db,
  projectId: number,
  kind: 'person' | 'pair',
  a: number,
  b: number | null,
  period = '',
): number {
  return Number(db.run(
    `INSERT INTO canon_thread (project_id, kind, a_entity, b_entity, status, period_label, temporal_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, 'current', ?, ?)`,
    projectId, kind, a, b, period, AT, AT,
  ).lastInsertRowid);
}

function note(db: Db, projectId: number, threadId: number, quote: string): number {
  return Number(db.run(
    `INSERT INTO canon_thread_note
       (project_id, thread_id, locator, quote, claim, claim_kind, strength, strength_source, missing, is_context, created_at)
     VALUES (?, ?, 'p. 1', ?, 'claim', 'relation', 0.8, 'assessed', '', 0, ?)`,
    projectId, threadId, quote, AT,
  ).lastInsertRowid);
}

function seed(): {
  db: Db;
  projectId: number;
  pair1: number;
  child: number;
  person1: number;
  person2: number;
} {
  const { db } = tempDb();
  const project = createProject(db, 'web3d');
  const a = entity(db, project.id, 'Asha');
  const b = entity(db, project.id, 'Bram');
  const c = entity(db, project.id, 'Cora');
  const person1 = thread(db, project.id, 'person', a, null);
  const person2 = thread(db, project.id, 'person', b, null);
  thread(db, project.id, 'person', c, null);
  const pair1 = thread(db, project.id, 'pair', a, b);
  thread(db, project.id, 'pair', b, c, '', );
  const child = thread(db, project.id, 'pair', a, b, 'born');
  note(db, project.id, pair1, 'a note on the pair');
  note(db, project.id, child, 'a note on the child');
  const meeting = Number(db.run(
    `INSERT INTO canon_meeting (project_id, thread_a, thread_b, match_key, match_kind, notes_exchanged, created_at, updated_at)
     VALUES (?, ?, ?, 'pair1', 'shared_pair', 4, ?, ?)`,
    project.id, person1, person2, AT, AT,
  ).lastInsertRowid);
  db.run(
    `INSERT INTO canon_birth (project_id, meeting_id, parent_a_thread, parent_b_thread, child_thread, trigger, combined_score, created_at)
     VALUES (?, ?, ?, ?, ?, 'test', 0.9, ?)`,
    project.id, meeting, person1, person2, child, AT,
  );
  db.run(
    `INSERT INTO canon_open_end (project_id, thread_id, question, status, created_at)
     VALUES (?, ?, 'who knows?', 'open', ?)`,
    project.id, pair1, AT,
  );
  return { db, projectId: project.id, pair1, child, person1, person2 };
}

test('graph shape, counts and folded vs all node selection', () => {
  const { db, projectId, pair1, child, person1 } = seed();
  const folded = buildWebGraph(db, projectId);
  assert.deepEqual(folded.counts, {
    personThreads: 3,
    pairThreads: 3,
    notes: 2,
    meetings: 1,
    births: 1,
    openEnds: 1,
  });
  assert.equal(folded.nodes.filter((node) => node.kind === 'person').length, 3);
  assert.equal(folded.nodes.filter((node) => node.kind === 'born').length, 1);
  assert.equal(folded.nodes.filter((node) => node.kind === 'pair').length, 1, 'empty pair is folded');
  assert.equal(folded.openEnds.length, 1);
  assert.ok(folded.revision.includes(':'));
  assert.ok(folded.nodes.find((node) => node.threadId === pair1)?.notes === 1);
  assert.ok(folded.nodes.find((node) => node.threadId === child)?.kind === 'born');
  assert.ok(folded.links.some((link) => link.kind === 'birth'));
  assert.ok(folded.links.some((link) => link.kind === 'meeting' && link.weight === 4));
  assert.ok(folded.links.some((link) => link.kind === 'membership' && link.target === `t:${person1}`));

  const all = buildWebGraph(db, projectId, { all: true });
  assert.equal(all.nodes.filter((node) => node.kind === 'pair').length, 2, 'all includes empty pairs; the born thread is a born node');
  assert.ok(all.nodes.length > folded.nodes.length);
  db.close();
});

test('notes=1 returns a first note only for nodes that have one', () => {
  const { db, projectId, pair1, child } = seed();
  note(db, projectId, pair1, 'a second note on the pair');
  const graph = buildWebGraph(db, projectId, { notes: true });
  const pairNode = graph.nodes.find((node) => node.threadId === pair1)!;
  assert.equal(pairNode.notes, 2);
  assert.equal(pairNode.firstNote?.quote, 'a note on the pair', 'the first note by id');
  const bornNode = graph.nodes.find((node) => node.threadId === child)!;
  assert.equal(bornNode.firstNote?.quote, 'a note on the child');
  const empty = graph.nodes.find((node) => node.notes === 0)!;
  assert.equal(empty.firstNote, null, 'no-note nodes carry an explicit null');

  const ordered = graph.nodes
    .filter((node) => node.notes > 0)
    .sort((a, b) => b.notes - a.notes || a.threadId - b.threadId);
  assert.deepEqual(ordered.map((node) => node.threadId), [pair1, child], 'note count desc, then id');
  db.close();
});

test('revision changes when a note arrives', () => {
  const { db, projectId, pair1 } = seed();
  const before = buildWebGraph(db, projectId);
  note(db, projectId, pair1, 'another note');
  const after = buildWebGraph(db, projectId);
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.counts.notes, before.counts.notes + 1);
  db.close();
});

test('thread detail returns notes, open ends and meetings', () => {
  const { db, projectId, pair1, person1, person2 } = seed();
  const detail = webThreadDetail(db, projectId, pair1)!;
  assert.equal(detail.thread.kind, 'pair');
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.openEnds.length, 1);
  assert.equal(detail.meetings.length, 0);
  const personDetail = webThreadDetail(db, projectId, person2)!;
  assert.equal(personDetail.meetings.length, 1);
  assert.equal(personDetail.meetings[0]!.notesExchanged, 4);
  assert.equal(personDetail.meetings[0]!.otherThreadId, person1);
  assert.equal(webThreadDetail(db, projectId, 999999), null);
  db.close();
});

test('the HTTP routes are read-only and unknown threads are 404', async () => {
  const { db, projectId, pair1 } = seed();
  const tables = ['canon_thread', 'canon_thread_note', 'canon_meeting', 'canon_birth', 'canon_open_end'];
  const counts = (): Record<string, number> => Object.fromEntries(tables.map((table) => [
    table,
    Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0),
  ]));
  const before = counts();
  const server: Server = startServer({ db, projectId, port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const graph = (await (await fetch(`${base}/api/web/graph`)).json()) as {
      counts: { notes: number };
      nodes: unknown[];
      revision: string;
    };
    assert.equal(graph.counts.notes, 2);
    assert.ok(graph.nodes.length > 0);
    const withNotes = (await (await fetch(`${base}/api/web/graph?notes=1`)).json()) as {
      nodes: { threadId: number; notes: number; firstNote: { quote: string } | null }[];
    };
    const withNote = withNotes.nodes.find((node) => node.notes > 0)!;
    assert.ok(withNote.firstNote?.quote);
    assert.ok(withNotes.nodes.some((node) => node.notes === 0 && node.firstNote === null));
    const same = (await (await fetch(`${base}/api/web/graph?rev=${encodeURIComponent(graph.revision)}`)).json()) as {
      unchanged?: boolean;
    };
    assert.equal(same.unchanged, true);
    const detail = (await (await fetch(`${base}/api/web/thread?id=${pair1}`)).json()) as { thread: { id: number } };
    assert.equal(detail.thread.id, pair1);
    assert.equal((await fetch(`${base}/api/web/thread?id=999999`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.deepEqual(counts(), before, 'read-only routes leave every row count unchanged');
  db.close();
});
