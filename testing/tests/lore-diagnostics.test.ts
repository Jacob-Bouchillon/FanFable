import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as loreDiag from '../../fanfable/src/lore-diagnostics.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const CANON = {
  entities: [
    {
      kind: 'character',
      name: 'Serena Marsh',
      aliases: ['Serena'],
      summary: 'A woman who watches the bridge from the ridge.',
      attributes: {},
      role: 'protagonist',
      status: 'alive',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character',
      name: 'Kade',
      aliases: [],
      summary: 'A frightened man who counts the lights.',
      attributes: {},
      role: 'companion',
      status: 'alive',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character',
      name: 'Fluffy',
      aliases: [],
      summary: 'A three-headed dog.',
      attributes: {},
      role: 'guardian',
      status: 'alive',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
  ],
  relations: [
    {
      from: 'Serena Marsh',
      to: 'Kade',
      kind: 'accompanied by',
      description: 'Kade stands behind her on the ridge.',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
  ],
  facts: [],
  timeline: [],
};

async function seeded(name = 'diagnostics') {
  const { db } = tempDb();
  const project = await seedProject(db, name);
  const llm = mockProvider(() => JSON.stringify(CANON));
  await lorebook.extractLore(db, llm, project.id);
  return { db, projectId: project.id, llm };
}

test('an entity with no relations is flagged', async () => {
  const { db, projectId } = await seeded();
  const gaps = loreDiag.diagnose(db, projectId);
  const isolated = gaps.find((g) => g.kind === 'isolated-entity' && g.subject === 'Fluffy');
  assert.ok(isolated, 'Fluffy has no relations and is flagged');
  assert.match(isolated!.suggestion, /enrich/);
  db.close();
});

test('a character the source links plainly but the graph does not is flagged', async () => {
  const { db, projectId } = await seeded();
  // The fixture says "Serena Marsh watched it from the ridge" — add a passage
  // that plainly states a relationship the graph does not have.
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words)
     VALUES ((SELECT id FROM canon_source WHERE project_id = ? LIMIT 1), ?, 99, 'CHAPTER TWO (p. 5)', '',
             'Kade was the brother of Serena Marsh, and they had grown up at the bridge together.', 0, 0, 14)`,
    projectId,
    projectId,
  );
  const gaps = loreDiag.diagnose(db, projectId);
  const missing = gaps.find((g) => g.kind === 'missing-relation');
  assert.ok(missing, 'the missing relationship is flagged');
  assert.ok(missing!.evidence.length > 0, 'the flag carries the passage that hints at it');
  assert.ok(missing!.chunkId, 'the flag points at the passage');
  db.close();
});

test('diagnostics never change the graph', async () => {
  const { db, projectId } = await seeded();
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId);
  loreDiag.diagnose(db, projectId);
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId);
  assert.equal(after?.n, before?.n, 'diagnosing is read-only');
  db.close();
});

test('enrichment adds only what is missing', async () => {
  const { db, projectId } = await seeded();
  const llm = mockProvider(() =>
    JSON.stringify({
      relations: [
        {
          other: 'Kade',
          kind: 'accompanied by',
          description: 'already known',
          quote: 'Serena Marsh watched it from the ridge',
        },
        {
          other: 'Fluffy',
          kind: 'guards',
          description: 'Fluffy guards the door.',
          quote: 'Serena Marsh watched it from the ridge',
        },
      ],
      facts: [
        {
          topic: 'the dog',
          statement: 'Fluffy is a three-headed dog.',
          quote: 'Serena Marsh watched it from the ridge',
        },
      ],
    }),
  );
  const result = await loreDiag.enrichEntity(db, llm, projectId, 'Serena Marsh');
  assert.equal(result.relations, 1, 'only the new relation is added');
  assert.equal(result.facts, 1);

  const rows = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ?',
    projectId,
  );
  assert.equal(rows.length, 2);
  const added = rows.find((r) => r.kind === 'guards');
  assert.equal(added?.review_status, 'needs_review', 'a new claim is marked as needing review');

  // Running it again must not duplicate anything.
  const again = await loreDiag.enrichEntity(db, llm, projectId, 'Serena Marsh');
  assert.equal(again.relations, 0, 'a second pass adds nothing');
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId);
  assert.equal(after?.n, 2);
  db.close();
});

test('a hand-made correction is marked as the author’s', async () => {
  const { db, projectId } = await seeded();
  const relation = db.get<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ?', projectId)!;
  loreDiag.correctRelation(db, projectId, relation.id, { kind: 'protects' });
  const row = db.get<{ kind: string; review_status: string; confidence: number }>(
    'SELECT kind, review_status, confidence FROM canon_relation WHERE id = ?',
    relation.id,
  );
  assert.equal(row?.kind, 'protects');
  assert.equal(row?.review_status, 'user_confirmed');
  assert.equal(row?.confidence, 1);
  db.close();
});

test('a relation can be removed', async () => {
  const { db, projectId } = await seeded();
  const relation = db.get<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ?', projectId)!;
  assert.equal(loreDiag.removeRelation(db, projectId, relation.id), true);
  const left = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId);
  assert.equal(left?.n, 0);
  db.close();
});
