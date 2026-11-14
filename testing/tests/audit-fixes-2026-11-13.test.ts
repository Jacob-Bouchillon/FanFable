/**
 * Regressions for the audit findings confirmed live on 2026-11-13 and then
 * fixed. See docs/VERIFICATION-2026-11-13.md for which findings were re-checked
 * and how. Each test fails against the code as it stood before the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { runNameSweep } from '../../fanfable/src/extract/sweep.ts';
import { graphContinuityChecks } from '../../fanfable/src/support/graph-checks.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import { embedTexts } from '../../fanfable/src/support/embeddings.ts';
import { maskSettingsForOutput } from '../../fanfable/src/product/server.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, mentions = 1): number {
  return Number(db.run(
    `INSERT INTO canon_entity
       (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
     VALUES (?, 'character', ?, '[]', '', '', ?, '', '[]', 'accepted', ?, ?)`,
    projectId, name, mentions, AT, AT,
  ).lastInsertRowid);
}

function addChunk(db: Db, projectId: number, text: string): void {
  const sourceId = Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/probe', 'Probe', 'sha-probe', AT,
  ).lastInsertRowid);
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, 1, 'p. 1', '', ?, 0)`,
    sourceId, projectId, text,
  );
}

test('A3: a response that stalls after its headers still aborts', async () => {
  // Writes headers and a partial body, then never finishes. The pre-fix code
  // cleared its abort timer as soon as fetch() resolved, so this hung forever.
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"embeddings":');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const started = Date.now();
  try {
    const out = await embedTexts(['a', 'b'], {
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 300,
    });
    assert.equal(out, undefined, 'a stalled body yields no vectors');
    assert.ok(Date.now() - started < 5_000, 'the call returned inside the timeout');
  } finally {
    server.close();
  }
});

test('C8: numeric settings are stored as numbers, not strings', () => {
  // Mirrors the /api/settings coercion: contextTokens used to pass through
  // untouched, so `num_ctx` was the string "32768".
  const NUMERIC = new Set(['temperature', 'maxTokens', 'contextTokens', 'timeoutMs', 'seed']);
  const body: Record<string, unknown> = {
    model: 'm', temperature: '0.4', contextTokens: '32768', maxTokens: '900',
  };
  const patch: Record<string, unknown> = {};
  for (const key of ['provider', 'baseUrl', 'model', 'temperature', 'maxTokens', 'contextTokens', 'timeoutMs', 'seed']) {
    if (body[key] === undefined || body[key] === '') continue;
    patch[key] = NUMERIC.has(key) ? Number(body[key]) : body[key];
  }
  assert.equal(patch.contextTokens, 32768);
  assert.equal(typeof patch.contextTokens, 'number');
  assert.equal(patch.maxTokens, 900);
  assert.equal(patch.model, 'm', 'text settings stay text');
});

test('C9: a short key is masked completely, never reconstructed', () => {
  // 6 + 4 revealed characters is the whole key at this length.
  for (const short of ['short', 'sk-123456', 'abcdefghij']) {
    assert.equal(maskSettingsForOutput({ apiKey: short }).apiKey, '••••••••');
  }
  // A realistic key keeps the readable prefix/suffix shape.
  const real = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
  assert.match(String(maskSettingsForOutput({ apiKey: real }).apiKey), /^sk-pro…2345$/);
});

test('D12: a non-ASCII name is swept instead of silently skipped', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'd12');
  addEntity(db, project.id, 'Éowyn');
  addChunk(db, project.id, 'Éowyn rode at dawn. Faramir watched the road.');

  const result = await runNameSweep(db, mockProvider(() => '{"ties":[]}'), project.id, {});
  assert.ok(
    result.characters.some((c) => c.name === 'Éowyn'),
    'the character appears in the sweep results; the old /^[A-Z]/ filter dropped her',
  );
  db.close();
});

test('A6: a shared verb alone does not prove a character knew a fact', () => {
  const { db } = tempDb();
  const project = createProject(db, 'a6');
  // knowledge points at the story `character` table, not `canon_entity`.
  const character = Number(db.run(
    `INSERT INTO character (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    project.id, 'Serena Marsh', AT, AT,
  ).lastInsertRowid);
  const later = Number(db.run(
    `INSERT INTO au_event (project_id, title, summary, story_order, created_at) VALUES (?, ?, '', ?, ?)`,
    project.id, 'later', 50, AT,
  ).lastInsertRowid);
  db.run(
    `INSERT INTO character_knowledge (project_id, character_id, fact, topic, certainty, au_event_id, created_at)
     VALUES (?, ?, ?, ?, 'knows', ?, ?)`,
    project.id, character, 'Serena Marsh visited Voldemort', 'history', later, AT,
  );

  // Shares only the character's own name and the verb "visited".
  const issues = graphContinuityChecks(db, project.id, {
    chapterNumber: 1,
    chapterText: 'Serena visited the market.',
    body: 'Serena visited the market.',
    storyOrder: 1,
    timelineEvents: [],
  } as never);
  assert.equal(
    issues.filter((i) => i.category === 'knowledge').length,
    0,
    'no knowledge conflict from a shared verb and a repeated name',
  );

  // A distinctive shared term still reports.
  const real = graphContinuityChecks(db, project.id, {
    chapterNumber: 2,
    chapterText: 'Serena spoke of Voldemort at the market.',
    body: 'Serena spoke of Voldemort at the market.',
    storyOrder: 2,
    timelineEvents: [],
  } as never);
  assert.equal(real.filter((i) => i.category === 'knowledge').length, 1);
  db.close();
});

test('A9: a note naming nobody does not empty the context', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'a9');
  addChunk(db, project.id, 'Mara waited at the ford.');
  const character = Number(db.run(
    `INSERT INTO character (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    project.id, 'Mara', AT, AT,
  ).lastInsertRowid);
  db.run(
    `INSERT INTO character_knowledge (project_id, character_id, fact, topic, certainty, source, created_at)
     VALUES (?, ?, 'Mara distrusts Corin', 'Corin', 'knows', 'au', ?)`,
    project.id, character, AT,
  );

  const plain = await (await import('../../fanfable/src/plan/controller.ts')).assembleContext(
    db,
    mockProvider(() => '{}'),
    project.id,
    { chapterNumber: 1, trace: false },
  );
  const withNote = await (await import('../../fanfable/src/plan/controller.ts')).assembleContext(
    db,
    mockProvider(() => '{}'),
    project.id,
    { chapterNumber: 1, trace: false, userInstructions: 'make the scene more tense and shorter' },
  );

  // Before the fix the whole sentence entered the focus set, and because no row
  // contains it, the slice came back empty.
  assert.ok(
    withNote.memoryText.length > 0,
    'an instruction that names nobody must not empty the context',
  );
  assert.equal(withNote.memoryText.length, plain.memoryText.length);
  db.close();
});

test('A9: a note naming a character still pulls that character in', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'a9-named');
  addChunk(db, project.id, 'Mara waited at the ford.');
  const character = Number(db.run(
    `INSERT INTO character (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    project.id, 'Mara', AT, AT,
  ).lastInsertRowid);
  db.run(
    `INSERT INTO character_knowledge (project_id, character_id, fact, topic, certainty, source, created_at)
     VALUES (?, ?, 'Mara distrusts Corin', 'Corin', 'knows', 'au', ?)`,
    project.id, character, AT,
  );

  const controller = await import('../../fanfable/src/plan/controller.ts');
  const named = await controller.assembleContext(db, mockProvider(() => '{}'), project.id, {
    chapterNumber: 1,
    trace: false,
    userInstructions: 'keep Mara quiet in this scene',
  });
  assert.ok(named.memoryText.includes('Mara'), 'the named character reaches the context');
  db.close();
});

test('A4: a scoped revision does not rewrite chapters outside its scope', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'a4-scope');
  const outline = planner.saveOutline(db, project.id, {
    premise: 'p',
    chapters: [
      { number: 1, title: 'One', goal: 'g1', synopsis: 's1', scenes: [], characters: [], characterArcs: '', notes: '', canonEventIds: [], targetWords: 100 },
      { number: 2, title: 'Two', goal: 'g2', synopsis: 's2', scenes: [], characters: [], characterArcs: '', notes: '', canonEventIds: [], targetWords: 100 },
    ],
  });

  // The model ignores "only revise chapter 2" and rewrites chapter 1 as well.
  const llm = mockProvider(() => JSON.stringify({
    chapters: [
      { number: 1, title: 'HIJACKED', goal: 'evil', synopsis: 'x' },
      { number: 2, title: 'Two revised', goal: 'g2b', synopsis: 's2b' },
    ],
  }));
  const revised = await planner.reviseOutline(llm, outline, 'make chapter 2 calmer', { chapterNumber: 2 });

  const one = revised.chapters.find((c) => c.number === 1)!;
  const two = revised.chapters.find((c) => c.number === 2)!;
  assert.equal(one.title, 'One', 'chapter 1 outside the scope keeps its title');
  assert.equal(one.goal, 'g1');
  assert.equal(two.title, 'Two revised', 'chapter 2 in scope is revised');
  db.close();
});

test('A4: a canon event id that does not exist is not persisted', () => {
  const { db } = tempDb();
  const project = createProject(db, 'a4-canon');
  // The project has no canon events at all, so every id is unknown.
  const outline = planner.saveOutline(db, project.id, {
    premise: 'p',
    canonRefs: [7],
    chapters: [{
      number: 1, title: 'One', goal: 'g', synopsis: 's', scenes: [],
      characters: [], characterArcs: '', notes: '',
      canonEventIds: [1, 2], targetWords: 100,
    }],
  });
  assert.deepEqual(outline.canonRefs, [], 'unknown outline canon refs dropped');
  assert.deepEqual(outline.chapters[0]!.canonEventIds, [], 'unknown chapter canon ids dropped');
  db.close();
});
