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
import { buildWebGraph, buildWebMap, webPersonDossier, webThreadDetail } from '../../fanfable/src/product/web3d.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string, aliases = '[]', kind = 'character'): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId, kind, name, aliases, 'accepted', AT, AT,
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

function source(db: Db, projectId: number): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/dossier', 'Dossier', 'sha', AT,
  ).lastInsertRowid);
}

function chunk(db: Db, projectId: number, sourceId: number, seq: number, locator: string, text: string): number {
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, projectId, seq, locator, '', text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

function relation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  evidence: string,
  chunkId: number,
  reviewStatus: string,
  description = '',
): number {
  return Number(db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, review_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId, from, to, kind, description, evidence,
    JSON.stringify([{ source: 'Dossier', locator: 'ref', chunk: chunkId }]), reviewStatus, AT,
  ).lastInsertRowid);
}

function seedDossier(): {
  db: Db;
  projectId: number;
  personId: number;
  otherId: number;
  duplicateId: number;
  out: number;
  inbound: number;
  third: number;
} {
  const { db } = tempDb();
  const project = createProject(db, 'dossier');
  const sourceId = source(db, project.id);
  const early = chunk(db, project.id, sourceId, 2, 'CHAPTER TWO (p. 12)', 'Ron stood by Harry.');
  const middle = chunk(db, project.id, sourceId, 5, 'CHAPTER FIVE (p. 45)', 'Harry trusted Hermione.');
  const late = chunk(db, project.id, sourceId, 9, 'CHAPTER NINE (p. 99)', 'Harry trusted Ron.');
  const harry = entity(db, project.id, 'Harry Potter', '["The Boy Who Lived"]');
  const ron = entity(db, project.id, 'Ron Weasley');
  const hermione = entity(db, project.id, 'Hermione Granger');
  const duplicate = entity(db, project.id, 'Harry');
  const out = relation(db, project.id, harry, ron, 'friend of', 'Harry trusted Ron.', late, 'accepted', 'friends since the train');
  const inbound = relation(db, project.id, ron, harry, 'friend of', 'Ron stood by Harry.', early, 'needs_review');
  const third = relation(db, project.id, harry, hermione, 'friend of', 'Harry trusted Hermione.', middle, 'accepted');
  return { db, projectId: project.id, personId: harry, otherId: ron, duplicateId: duplicate, out, inbound, third };
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

test('person nodes are emitted only for character entities', () => {
  const { db } = tempDb();
  const project = createProject(db, 'person-kinds');
  const location = entity(db, project.id, 'Privet Drive', '[]', 'location');
  const character = entity(db, project.id, 'Harry Potter');
  const locationThread = thread(db, project.id, 'person', location, null);
  const characterThread = thread(db, project.id, 'person', character, null);
  thread(db, project.id, 'pair', location, character);

  const graph = buildWebGraph(db, project.id, { all: true });
  assert.ok(!graph.nodes.some((node) => node.threadId === locationThread), 'no person node for a location thread');
  assert.ok(graph.nodes.some((node) => node.threadId === characterThread), 'the character thread still has a node');
  assert.ok(!graph.links.some((link) => link.target === `t:${locationThread}`), 'no membership link to a skipped thread');
  assert.equal(graph.counts.personThreads, 1);
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

test('person dossier groups both directions, sorts by story order and flags duplicates', () => {
  const { db, projectId, personId, otherId, duplicateId, out, inbound, third } = seedDossier();
  const dossier = webPersonDossier(db, projectId, personId)!;
  assert.equal(dossier.person.name, 'Harry Potter');
  assert.deepEqual(dossier.person.aliases, ['The Boy Who Lived']);
  assert.deepEqual(dossier.counts, { total: 3, accepted: 2, needsReview: 1 });
  assert.equal(dossier.groups.length, 1);

  const group = dossier.groups[0]!;
  assert.equal(group.family, 'friend');
  assert.deepEqual(group.ties.map((tie) => tie.relationId), [inbound, third, out], 'seq ascending, then relation id');
  assert.deepEqual(group.ties.map((tie) => tie.seq), [2, 5, 9]);
  assert.equal(group.ties[0]!.direction, 'in');
  assert.equal(group.ties[0]!.counterpart.id, otherId);
  assert.equal(group.ties[0]!.counterpart.name, 'Ron Weasley');
  assert.equal(group.ties[0]!.locator, 'CHAPTER TWO (p. 12)');
  assert.equal(group.ties[0]!.quote, 'Ron stood by Harry.');
  assert.equal(group.ties[0]!.status, 'needs_review');
  assert.equal(group.ties[2]!.direction, 'out');
  assert.equal(group.ties[2]!.locator, 'CHAPTER NINE (p. 99)');
  assert.equal(group.ties[2]!.description, 'friends since the train');

  const duplicate = dossier.duplicates.find((entry) => entry.id === duplicateId);
  assert.ok(duplicate, 'the contained-name entity is reported');
  assert.equal(duplicate!.name, 'Harry');
  assert.match(duplicate!.reason, /name contained in "Harry Potter"/);

  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId)!.n, 4);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId)!.n, 3);
  assert.equal(webPersonDossier(db, projectId, 999999), null);
  db.close();
});

test('duplicate detection uses token-set containment, not a shared surname', () => {
  const { db } = tempDb();
  const project = createProject(db, 'duplicates');
  const harry = entity(db, project.id, 'Harry');
  const harryPotter = entity(db, project.id, 'Harry Potter');
  const ron = entity(db, project.id, 'Ron Weasley');
  const fred = entity(db, project.id, 'Fred Weasley');

  const harryDuplicates = webPersonDossier(db, project.id, harry)!.duplicates;
  assert.ok(harryDuplicates.some((entry) => entry.id === harryPotter), 'Harry is contained in Harry Potter');
  assert.match(harryDuplicates.find((entry) => entry.id === harryPotter)!.reason, /name contained in "Harry Potter"/);
  assert.ok(!harryDuplicates.some((entry) => entry.id === ron || entry.id === fred));

  const potterDuplicates = webPersonDossier(db, project.id, harryPotter)!.duplicates;
  assert.ok(potterDuplicates.some((entry) => entry.id === harry), 'the containment reports in both directions');
  assert.ok(!potterDuplicates.some((entry) => entry.id === ron || entry.id === fred));

  const ronDuplicates = webPersonDossier(db, project.id, ron)!.duplicates;
  assert.ok(!ronDuplicates.some((entry) => entry.id === fred), 'a shared surname is not containment');
  assert.ok(!ronDuplicates.some((entry) => entry.id === harry || entry.id === harryPotter));

  const fredDuplicates = webPersonDossier(db, project.id, fred)!.duplicates;
  assert.ok(!fredDuplicates.some((entry) => entry.id === ron));
  db.close();
});

test('single-token aliases do not make a surname a duplicate', () => {
  const { db } = tempDb();
  const project = createProject(db, 'single-token-alias');
  const ron = entity(db, project.id, 'Ron Weasley', '["Mr. Weasley", "Weasley"]');
  const fred = entity(db, project.id, 'Fred Weasley', '["Mister Fred"]');

  const ronDuplicates = webPersonDossier(db, project.id, ron)!.duplicates;
  const fredDuplicates = webPersonDossier(db, project.id, fred)!.duplicates;
  assert.deepEqual(ronDuplicates, [], 'a one-token alias must not match a full name');
  assert.deepEqual(fredDuplicates, []);
  db.close();
});

test('relationship map keeps only relation endpoints and styles statuses', () => {
  const { db } = tempDb();
  const project = createProject(db, 'map');
  const sourceId = source(db, project.id);
  const early = chunk(db, project.id, sourceId, 2, 'CHAPTER TWO (p. 12)', 'Asha trusted Bram.');
  const late = chunk(db, project.id, sourceId, 9, 'CHAPTER NINE (p. 99)', 'Bram turned on Asha.');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  const isolated = entity(db, project.id, 'Cora');
  const location = entity(db, project.id, 'Privet Drive', '[]', 'location');
  const accepted = relation(db, project.id, asha, bram, 'friend of', 'Asha trusted Bram.', early, 'accepted');
  const review = relation(db, project.id, bram, asha, 'enemy of', 'Bram turned on Asha.', late, 'needs_review');

  const map = buildWebMap(db, project.id);
  assert.equal(map.nodes.length, 2, 'only entities appearing in relations are nodes');
  assert.equal(map.edges.length, 2);
  assert.ok(!map.nodes.some((node) => node.id === isolated), 'an isolated entity is excluded');
  assert.deepEqual(
    map.nodes.map((node) => [node.id, node.degree]).sort((a, b) => a[0] - b[0]),
    [[asha, 2], [bram, 2]],
  );
  assert.deepEqual(
    map.edges.map((edge) => [edge.id, edge.from, edge.to, edge.family, edge.status]),
    [
      [accepted, asha, bram, 'friend', 'accepted'],
      [review, bram, asha, 'hostile', 'needs_review'],
    ],
  );
  assert.equal(map.edges[0]!.quote, 'Asha trusted Bram.');
  assert.equal(map.edges[0]!.locator, 'CHAPTER TWO (p. 12)');

  const withIsolated = buildWebMap(db, project.id, { includeIsolated: true });
  assert.ok(withIsolated.nodes.some((node) => node.id === isolated && node.degree === 0));
  assert.ok(!withIsolated.nodes.some((node) => node.id === location), 'a location is not an isolated person');
  db.close();
});

test('the person route returns a dossier and the usual errors', async () => {
  const { db, projectId, personId } = seedDossier();
  const server: Server = startServer({ db, projectId, port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/web/person?id=${personId}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { person: { id: number }; groups: unknown[] };
    assert.equal(body.person.id, personId);
    assert.ok(Array.isArray(body.groups));
    assert.equal((await fetch(`${base}/api/web/person?id=999999`)).status, 404);
    assert.equal((await fetch(`${base}/api/web/person?id=nope`)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  db.close();
});
