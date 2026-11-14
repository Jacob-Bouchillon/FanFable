/**
 * Regressions for the audit findings confirmed live on 2026-11-13 and then
 * fixed. See docs/VERIFICATION-2026-11-13.md for which findings were re-checked
 * and how. Each test fails against the code as it stood before the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
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

test('A7: a fact quote is resolved to its real passage, or the fact is dropped', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'a7');
  const sourceId = Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/a7', 'Probe', 'sha-a7', AT,
  ).lastInsertRowid);
  // Two passages in the same window, so "which one did the quote come from"
  // is answerable and the old hardcoded window[0] is wrong for the second.
  const first = Number(db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, 1, 'p. 1', '', 'Asha waited by the river.', 6)`,
    sourceId, project.id,
  ).lastInsertRowid);
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, 2, 'p. 2', '', 'Asha watched the mill burn on the third night.', 9)`,
    sourceId, project.id,
  );
  const asha = Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', 'Asha', '[]', AT, AT,
  ).lastInsertRowid);

  const loreDiag = await import('../../fanfable/src/answer/lore-diagnostics.ts');
  const llm = mockProvider(() => JSON.stringify({
    relations: [],
    facts: [
      { statement: 'the mill burned', topic: 'mill', quote: 'the mill burn on the third night' },
      { statement: 'a fabricated claim', topic: 'x', quote: 'Asha was crowned in the summer palace.' },
    ],
  }));

  const result = await loreDiag.enrichEntity(db, llm, project.id, 'Asha', { maxPassages: 8 });
  assert.equal(result.facts, 1, 'only the quotable fact is banked');

  const row = db.get<{ statement: string; source_refs: string }>(
    'SELECT statement, source_refs FROM canon_fact WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(row.statement, 'the mill burned');
  const refs = JSON.parse(row.source_refs) as { locator: string }[];
  assert.equal(refs[0]?.locator, 'p. 2', 'the reference points at the passage the quote came from, not the first one');
  void first; void asha;
  db.close();
});

test('C10: a sentence-initial common word is not reported as a character', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'c10');
  // Three known people, so the "index is meaningful" guard does not short-circuit.
  for (const name of ['Asha', 'Bram', 'Corin']) {
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id, 'character', name, '[]', AT, AT,
    );
  }
  const { checkPremise } = await import('../../fanfable/src/product/premise-check.ts');
  const warnings = checkPremise(
    db,
    project.id,
    'The mill burned. When Asha arrived, After Bram left, The river rose.',
    '',
  ) as { kind: string; message: string }[];

  const flagged = warnings.filter((w) => w.kind === 'unknown-character').map((w) => w.message);
  assert.deepEqual(flagged, [], 'no common word is reported as an unknown character');

  // A real unknown name is still reported.
  const real = checkPremise(db, project.id, 'Wilhelmina arrives at the bridge.', '') as {
    kind: string;
    message: string;
  }[];
  assert.ok(real.some((w) => w.kind === 'unknown-character' && /Wilhelmina/.test(w.message)));
  db.close();
});

test('C7: a symlink under temp does not make a production database writable', async () => {
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { isTempDatabasePath } = await import('../../fanfable/src/web/meetings.ts');

  // A target outside the temp directory. /var/tmp is on a different root than
  // /tmp on Linux; skip where it is not usable.
  const outside = '/var/tmp/fanfable-c7-probe';
  if (!existsSync('/var/tmp')) return;
  mkdirSync(outside, { recursive: true });
  const target = join(outside, 'prod.db');
  const { Db: DbClass } = await import('../../fanfable/src/core/db.ts');
  new DbClass(target).close();

  const linkDir = mkdtempSync(join(tmpdir(), 'ff-c7-link-'));
  const link = join(linkDir, 'link.db');
  try {
    symlinkSync(target, link);
  } catch {
    rmSync(outside, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
    return; // no symlink support here
  }

  assert.equal(isTempDatabasePath(target), false, 'the real file is outside temp');
  assert.equal(
    isTempDatabasePath(link),
    false,
    'a link whose name is under temp but whose target is not must be refused',
  );
  rmSync(outside, { recursive: true, force: true });
  rmSync(linkDir, { recursive: true, force: true });
});

test('A12: the graph path does not claim the trails command\'s final accounting', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  // `budget:trails` is the trails command's final accounting and the audit
  // requires a matching `trails:final` summary for it. The PPR graph path has
  // no such summary — its accounting is the `passages:graph` summary — so it
  // must use its own subject. Fixtures never have enough graph passages to
  // exercise the path, so the invariant is pinned here instead.
  const graph = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/support/graph.ts'), 'utf8');
  assert.equal(
    /subject:\s*'budget:trails'/.test(graph),
    false,
    'graph.ts emits budget:trails without a trails:final summary',
  );
  assert.match(graph, /subject:\s*'budget:graph-trails'/);

  // The trails command does emit both, and must keep doing so.
  const cli = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/cli.ts'), 'utf8');
  assert.match(cli, /subject:\s*'budget:trails'/);
  assert.match(cli, /subject:\s*'trails:final'/);
});

test('C11: /api/issues respects the author\'s severity floor', async () => {
  const { startServer } = await import('../../fanfable/src/product/server.ts');
  const continuity = await import('../../fanfable/src/product/continuity.ts');
  const controller = await import('../../fanfable/src/plan/controller.ts');

  const { db } = tempDb();
  const project = createProject(db, 'c11');
  continuity.saveIssues(db, project.id, null, [
    { severity: 'error', category: 'timeline', message: 'bad order', evidence: '', suggestion: '', resolution: 'open' },
    { severity: 'warning', category: 'knowledge', message: 'maybe', evidence: '', suggestion: '', resolution: 'open' },
    { severity: 'note', category: 'canon', message: 'fyi', evidence: '', suggestion: '', resolution: 'open' },
  ] as never);
  controller.updateProjectSettings(db, project.id, {
    continuity: { enabled: true, modelChecks: true, minSeverity: 'error', onDraft: true },
  });

  const server = startServer({ db, projectId: project.id, port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const filtered = (await (await fetch(`${base}/api/issues`)).json()) as { issues: { severity: string }[] };
    assert.deepEqual(filtered.issues.map((i) => i.severity), ['error'], 'only errors pass the floor');

    const all = (await (await fetch(`${base}/api/issues?all=1`)).json()) as { issues: { severity: string }[] };
    assert.equal(all.issues.length, 3, 'all=1 still shows everything');
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    db.close();
  }
});

test('B9: notes that cite no passage do not each count as independent support', async () => {
  const { combineScore } = await import('../../fanfable/src/core/combine.ts');
  const note = (strength: number, dedupeKey: string) => ({
    strength, chunkId: null, dedupeKey, assessed: true, isContext: false, pairsCited: 1,
  }) as never;

  // Three unproven 0.4 notes used to score 1 - 0.6^3 = 0.784 and clear a 0.7
  // bar. None can show it sits in a different passage, so they are one share.
  const out = combineScore([note(0.4, 'a'), note(0.4, 'b'), note(0.4, 'c')]);
  assert.ok(out.score < 0.7, `unproven notes must not clear the bar (got ${out.score})`);
  assert.equal(out.independent, 1, 'they count as one share');
});
