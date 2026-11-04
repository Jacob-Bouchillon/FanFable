/**
 * One temporal rule across scopes.
 *
 * Canon is whole-book source material ordered by canon sequence; story is
 * ordered by story order. A story anchor must never hide canon, and a story
 * edge's event id must be resolved to that event's story order before it is
 * compared with the anchor. Synthetic databases only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedProject, tempDb } from './helpers.ts';
import * as graph from '../../fanfable/src/support/graph.ts';
import * as memory from '../../fanfable/src/product/memory.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addAuEvent(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  title: string,
  storyOrder: number,
): number {
  return Number(db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, ?, ?, '', '', ?, '[]', '', 'event', '', ?)`,
    projectId,
    storyOrder,
    title,
    storyOrder,
    AT,
  ).lastInsertRowid);
}

test('a story anchor does not hide a canon event with a higher canon sequence', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'temporal-canon');
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ? LIMIT 1', project.id)!;
  const canonEvent = Number(db.run(
    `INSERT INTO canon_event (project_id, source_id, seq, title, summary, created_at)
     VALUES (?, ?, 50, 'A canon event', '', ?)`,
    project.id,
    source.id,
    AT,
  ).lastInsertRowid);

  const g = graph.loadGraph(db, project.id);
  const ctx = graph.traverse(g, {
    roots: [graph.canonEventId(canonEvent)],
    hops: 0,
    temporal: true,
    beforeOrder: 1,
  });
  assert.ok(ctx.nodes.has(graph.canonEventId(canonEvent)), 'canon is whole-book and always visible');
  db.close();
});

test('a story event after the anchor is still hidden', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'temporal-story-node');
  const early = addAuEvent(db, project.id, 'Early', 1);
  const late = addAuEvent(db, project.id, 'Late', 2);
  const g = graph.loadGraph(db, project.id);

  const atOne = graph.traverse(g, {
    roots: [graph.auEventId(early), graph.auEventId(late)],
    hops: 0,
    temporal: true,
    beforeOrder: 1,
  });
  assert.ok(atOne.nodes.has(graph.auEventId(early)));
  assert.ok(!atOne.nodes.has(graph.auEventId(late)), 'a future story event stays hidden');
  db.close();
});

test('a story edge is compared by its event story order, not its event id', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'temporal-story-edge');
  const earlyEvent = addAuEvent(db, project.id, 'Early', 1);
  const farEvent = addAuEvent(db, project.id, 'Far future', 100);
  const a = memory.upsertCharacter(db, project.id, 'Asha');
  const b = memory.upsertCharacter(db, project.id, 'Bram');
  const c = memory.upsertCharacter(db, project.id, 'Cora');
  // Event ids 1 and 2: the second edge's event id is low, its story order far.
  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, valid_from_event_id, updated_at)
     VALUES (?, ?, ?, 'ally', ?, ?)`,
    project.id, a, b, earlyEvent, AT,
  );
  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, valid_from_event_id, updated_at)
     VALUES (?, ?, ?, 'rival', ?, ?)`,
    project.id, a, c, farEvent, AT,
  );

  const g = graph.loadGraph(db, project.id);
  const atFive = graph.traverse(g, {
    roots: [graph.characterId(a)],
    hops: 1,
    temporal: true,
    beforeOrder: 5,
  });
  assert.ok(atFive.nodes.has(graph.characterId(b)), 'the early edge is valid now');
  assert.ok(!atFive.nodes.has(graph.characterId(c)), 'the edge starting at story order 100 is future');

  const all = graph.traverse(g, { roots: [graph.characterId(a)], hops: 1 });
  assert.ok(all.nodes.has(graph.characterId(c)), 'without the filter both edges are visible');
  db.close();
});

test('an unresolvable story event id fails closed', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'temporal-missing-event');
  const a = memory.upsertCharacter(db, project.id, 'Asha');
  const b = memory.upsertCharacter(db, project.id, 'Bram');
  const event = addAuEvent(db, project.id, 'Gone', 1);
  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, valid_from_event_id, updated_at)
     VALUES (?, ?, ?, 'ally', ?, ?)`,
    project.id, a, b, event, AT,
  );
  db.exec('PRAGMA foreign_keys = OFF');
  db.run('DELETE FROM au_event WHERE id = ?', event);
  db.exec('PRAGMA foreign_keys = ON');

  const g = graph.loadGraph(db, project.id);
  const result = graph.traverse(g, {
    roots: [graph.characterId(a)],
    hops: 1,
    temporal: true,
    beforeOrder: 5,
  });
  assert.ok(!result.nodes.has(graph.characterId(b)), 'an edge with an unknown event id is excluded');
  db.close();
});

test('a canon-scope edge is never compared against story order', () => {
  const node = (id: string, scope: 'canon' | 'story', order: number): graph.GraphNode => ({
    id,
    numericId: 1,
    kind: scope === 'canon' ? 'canon-entity' : 'character',
    scope,
    name: id,
    summary: '',
    aliases: [],
    confidence: 1,
    reviewStatus: 'accepted',
    evidence: '',
    sourceRefs: [],
    order,
    extra: {},
  });
  const root = node('canon:entity:1', 'canon', 0);
  const other = node('canon:entity:2', 'canon', 0);
  const edge: graph.GraphEdge = {
    id: 'canon-edge',
    from: root.id,
    to: other.id,
    type: 'ally',
    scope: 'canon',
    description: '',
    evidence: '',
    confidence: 1,
    reviewStatus: 'accepted',
    validFrom: 50,
  };
  const g: graph.Graph = {
    nodes: new Map([[root.id, root], [other.id, other]]),
    edges: [edge],
    adjacency: new Map([[root.id, [edge.id]], [other.id, [edge.id]]]),
    byNumeric: new Map(),
  };
  const result = graph.traverse(g, { roots: [root.id], hops: 1, temporal: true, beforeOrder: 5 });
  assert.ok(result.nodes.has(other.id), 'canon sequence 50 is not story order 50');
});
