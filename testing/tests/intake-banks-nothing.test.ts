/**
 * Intake banks nothing.
 *
 * A mined window produces candidates only. Entities, relations and facts all
 * enter review; acceptance is earned at the gate and nowhere else. A verbatim
 * quote and a confident model are necessary, never sufficient.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const QUOTE = 'Serena Marsh watched it from the ridge.';

function extraction() {
  return {
    entities: [
      { kind: 'character', name: 'Serena Marsh', aliases: [], summary: '', attributes: {}, role: '', status: 'alive', chunk_index: 0, evidence: QUOTE },
      { kind: 'character', name: 'Kade', aliases: [], summary: '', attributes: {}, role: '', status: 'alive', chunk_index: 0, evidence: QUOTE },
    ],
    relations: [
      { from: 'Serena Marsh', to: 'Kade', kind: 'sister of', description: 'Kin.', chunk_index: 0, evidence: QUOTE, strength: 0.95, asserted: true, names_both: true, other_person: 'named', hedge: 'certain', kind_fit: 'yes' },
    ],
    facts: [
      { topic: 'the ridge', statement: 'Serena watches the bridge from the ridge.', chunk_index: 0, evidence: QUOTE },
    ],
    timeline: [],
  };
}

test('a mined window yields zero accepted rows; everything enters review', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'intake-banks-nothing');
  const llm = mockProvider(() => JSON.stringify(extraction()));
  const stats = await lorebook.extractLore(db, llm, project.id);

  assert.ok(stats.entities > 0, 'entities were proposed');
  assert.ok(stats.relations > 0, 'a relation was proposed');

  const accepted = db.all<{ t: string; n: number }>(
    `SELECT 'entity' t, count(*) n FROM canon_entity WHERE project_id = ? AND review_status = 'accepted'
     UNION ALL SELECT 'relation', count(*) FROM canon_relation WHERE project_id = ? AND review_status = 'accepted'
     UNION ALL SELECT 'fact', count(*) FROM canon_fact WHERE project_id = ? AND review_status = 'accepted'`,
    project.id,
    project.id,
    project.id,
  );
  assert.equal(accepted.reduce((n, row) => n + row.n, 0), 0, 'nothing is accepted at intake');

  const review = db.all<{ t: string; n: number }>(
    `SELECT 'entity' t, count(*) n FROM canon_entity WHERE project_id = ? AND review_status = 'needs_review'
     UNION ALL SELECT 'relation', count(*) FROM canon_relation WHERE project_id = ? AND review_status = 'needs_review'
     UNION ALL SELECT 'fact', count(*) FROM canon_fact WHERE project_id = ? AND review_status = 'needs_review'`,
    project.id,
    project.id,
    project.id,
  );
  assert.deepEqual(
    Object.fromEntries(review.map((row) => [row.t, row.n])),
    { entity: 2, relation: 1, fact: 1 },
    'everything the window proposed is queued',
  );
  db.close();
});
