import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedProject, mockProvider } from './helpers.ts';
import { isUnsupportedKind } from '../../fanfable/src/lorebook.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

test('silent-noun rule covers closed role nouns, not just kinship', () => {
  // The reported hole: "apprentice of" proved by a quote that never says it.
  assert.equal(isUnsupportedKind('apprentice of', 'Kade had watched her take it from the tower'), true);
  assert.equal(isUnsupportedKind('apprentice of', 'he took her as his apprentice'), false);
  assert.equal(isUnsupportedKind('aide of', 'his aide nodded'), false);
  assert.equal(isUnsupportedKind('aide of', 'he nodded once'), true);
  assert.equal(isUnsupportedKind('partner', 'they worked together for years'), true);
  // Exact and plural morphology counts; open vocabulary is not this rule's job.
  assert.equal(isUnsupportedKind('son of', 'his son nodded'), false);
  assert.equal(isUnsupportedKind('son of', 'he nodded once'), true);
  assert.equal(isUnsupportedKind('confidant of', 'whatever they said'), false);
  // Exact reported shape: both endpoints named, tie noun silent — the old
  // kin-only rule let "apprentice" through; the extended rule treats it
  // the same as the long-covered "master".
  assert.equal(isUnsupportedKind('apprentice of', 'Asha and Bram observed the gathering'), true);
  assert.equal(isUnsupportedKind('master of', 'Asha and Bram observed the gathering'), true);
  assert.equal(isUnsupportedKind('master of', 'his Master frequently told him'), false);
});

const ENTITIES = {
  entities: [
    {
      kind: 'character', name: 'Serena Marsh', aliases: [], summary: 'a watcher',
      attributes: {}, role: '', status: '', chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character', name: 'Kade', aliases: [], summary: 'a man',
      attributes: {}, role: '', status: '', chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
  ],
  facts: [],
};

function mockWithRelations(relations: unknown[]) {
  return mockProvider((req) => {
    const sys = (req.system ?? '') as string;
    if (sys.includes('KNOWN ENTITIES')) return JSON.stringify({ relations });
    if (sys.includes('"entities"')) return JSON.stringify(ENTITIES);
    return JSON.stringify({ entities: [], facts: [], timeline: [] });
  });
}

async function bankedStatus(relations: unknown[]): Promise<{ status: string | null; note: number }> {
  const { db } = tempDb();
  const project = seedProject(db, 'gate-check');
  const llm = mockWithRelations(relations);
  await lorebook.extractLore(db, llm, project.id);
  const row = db.get<{ review_status: string }>(
    'SELECT review_status FROM canon_relation WHERE project_id = ? ORDER BY id LIMIT 1', project.id);
  const note = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'", project.id)!.n;
  db.close();
  return { status: row?.review_status ?? null, note };
}

const COAT = 'Serena Marsh watched it from the ridge, wrapped in a coat that had belonged to her brother';

test('noun-silent tie is provisional, with a note', async () => {
  const { status, note } = await bankedStatus([{
    from: 'Serena Marsh', to: 'Kade', kind: 'apprentice of', description: 'x', chunk_index: 0,
    evidence: 'Two hundred yards, said Kade behind her',
  }]);
  assert.equal(status, 'provisional');
  assert.ok(note >= 1, 'unsupported claim leaves a relabel note');
});

test('quote naming neither endpoint parks instead of banking', async () => {
  const { status, note } = await bankedStatus([{
    from: 'Serena Marsh', to: 'Kade', kind: 'brother of', description: 'x', chunk_index: 0,
    evidence: 'wrapped in a coat that had belonged to her brother',
  }]);
  assert.equal(status, 'needs_review');
  assert.ok(note >= 1, 'endpoint silence leaves a case file so the tie can come back');
});

test('a stated tie naming one endpoint is provisional, not a keeper', async () => {
  const { status } = await bankedStatus([{
    from: 'Serena Marsh', to: 'Kade', kind: 'brother of', description: 'x', chunk_index: 0,
    evidence: COAT,
  }]);
  assert.equal(status, 'provisional');
});
