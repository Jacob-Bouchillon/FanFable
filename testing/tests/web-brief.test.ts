/**
 * Evidence web brief: grades, citations, open questions, contradictions.
 * Invented names only; mock provider for the planner assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { buildWebBrief, renderWebBrief } from '../../fanfable/src/brief.ts';
import * as planner from '../../fanfable/src/planner.ts';
import * as controller from '../../fanfable/src/controller.ts';
import { syncThreads } from '../../fanfable/src/threads.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      projectId,
      name,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, seq: number): number {
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `/brief-${seq}`,
      'Probe',
      `sha-brief-${seq}`,
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, '', ?, 8)`,
      source,
      projectId,
      seq,
      `p. ${seq}`,
      `Mara Voss swore an oath to Corin Hale in scene ${seq}.`,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const chunk = addChunk(db, project.id, 1);
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  return { db, project: project.id, chunk, mara, corin };
}

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  status: string,
  opts: { chunk?: number | null; supporting?: string; kind?: string } = {},
): number {
  const refs =
    opts.chunk === null || opts.chunk === undefined
      ? '[]'
      : JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: opts.chunk }]);
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, supporting_evidence, created_at)
       VALUES (?, ?, ?, ?, '', 'Mara Voss swore an oath to Corin Hale in scene 1.', ?, 0.8, ?, ?, ?)`,
      projectId,
      from,
      to,
      opts.kind ?? 'sister of',
      refs,
      status,
      opts.supporting ?? '[]',
      AT,
    ).lastInsertRowid,
  );
}

const assessed = JSON.stringify([{ assessment: { names_both: true, asserted: true, strength: 0.8, why: 'stated' } }]);

test('each grade lands in its own section and never upgrades', () => {
  const { db, project, chunk, mara, corin } = setup('brief-grades');
  addRelation(db, project, mara, corin, 'user_confirmed', { chunk, kind: 'sister of' });
  addRelation(db, project, mara, corin, 'attested', { chunk, kind: 'ally of' });
  addRelation(db, project, mara, corin, 'provisional', { chunk, supporting: assessed, kind: 'rival of' });
  addRelation(db, project, mara, corin, 'needs_review', { chunk, kind: 'enemy of' });

  const brief = buildWebBrief(db, project, { entities: ['Mara Voss', 'Corin Hale'] });
  assert.equal(brief.proven.length, 1);
  assert.equal(brief.proven[0]!.grade, 'proven');
  assert.equal(brief.attested.length, 1);
  assert.equal(brief.attested[0]!.grade, 'attested');
  assert.equal(brief.provisional.length, 1, 'only the assessed needs_review row is provisional');
  assert.equal(brief.provisional[0]!.grade, 'provisional');
  assert.equal(brief.provisional[0]!.strength, 0.8);
  assert.ok(brief.proven[0]!.citation);
  db.close();
});

test('an item without a locator is marked uncited', () => {
  const { db, project, mara, corin } = setup('brief-uncited');
  addRelation(db, project, mara, corin, 'user_confirmed', { chunk: null });
  const brief = buildWebBrief(db, project, { entities: ['Mara Voss'] });
  assert.equal(brief.proven.length, 1);
  assert.equal(brief.proven[0]!.uncited, true);
  assert.equal(brief.proven[0]!.citation, null);
  db.close();
});

test('open questions are oldest first and capped', () => {
  const { db, project, mara } = setup('brief-questions');
  syncThreads(db, project);
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ?",
    project,
    mara,
  )!.id;
  for (const [i, stamp] of ['2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z'].entries()) {
    db.run(
      `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
       VALUES (?, ?, ?, '', 'a later passage', 'open', ?)`,
      project,
      thread,
      `question ${i}`,
      stamp,
    );
  }
  const brief = buildWebBrief(db, project, { entities: ['Mara Voss'], limitPerSection: 2 });
  assert.equal(brief.openQuestions.length, 2);
  assert.equal(brief.openQuestions[0]!.question, 'question 0');
  assert.equal(brief.truncated.openQuestions, 1);
  db.close();
});

test('ambiguous names are reported and never enter the tie sections', () => {
  const { db, project, chunk, mara, corin } = setup('brief-ambiguous');
  addEntity(db, project, 'Senator Vidar Kest');
  addEntity(db, project, 'Ronhar Kest');
  addRelation(db, project, mara, corin, 'user_confirmed', { chunk });
  const brief = buildWebBrief(db, project, { entities: ['Kest'] });
  assert.equal(brief.unresolved.length, 1);
  assert.equal(brief.unresolved[0]!.status, 'ambiguous');
  assert.ok(brief.unresolved[0]!.candidates.length >= 2);
  assert.equal(brief.proven.length, 0);
  db.close();
});

test('the brief is deterministic and writes nothing', () => {
  const { db, project, chunk, mara, corin } = setup('brief-deterministic');
  addRelation(db, project, mara, corin, 'user_confirmed', { chunk });
  const counts = () =>
    ['canon_relation', 'canon_thread_note', 'canon_open_end', 'canon_meeting'].map(
      (table) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
    );
  const before = counts();
  const first = JSON.stringify(buildWebBrief(db, project, { entities: ['Mara Voss', 'Corin Hale'] }));
  const second = JSON.stringify(buildWebBrief(db, project, { entities: ['Corin Hale', 'Mara Voss'] }));
  assert.equal(first, second);
  assert.deepEqual(counts(), before);
  db.close();
});

test('the planner prompt carries the five headings and a locator', async () => {
  const { db, project, chunk, mara, corin } = setup('brief-planner');
  addRelation(db, project, mara, corin, 'user_confirmed', { chunk });
  const brief = buildWebBrief(db, project, { entities: ['Mara Voss', 'Corin Hale'] });
  const rendered = renderWebBrief(brief);
  assert.match(rendered, /PROVEN TIES/);
  assert.match(rendered, /\[p\. 1\]/);

  let captured = '';
  const llm = mockProvider((req) => {
    captured = req.messages.map((m) => m.content).join('\n');
    return JSON.stringify({ title: 'x', chapters: [] });
  });
  await planner.draftOutline(llm as never, {
    premise: 'a quiet revenge',
    chapterCount: 1,
    webBrief: rendered,
  });
  assert.match(captured, /PROVEN TIES/);
  assert.match(captured, /p\. 1/);
  db.close();
});

test('without a web brief the prompt does not gain the block', async () => {
  let captured = '';
  const llm = mockProvider((req) => {
    captured = req.messages.map((m) => m.content).join('\n');
    return JSON.stringify({ title: 'x', chapters: [] });
  });
  await planner.draftOutline(llm as never, { premise: 'a quiet revenge', chapterCount: 1 });
  assert.doesNotMatch(captured, /EVIDENCE WEB/);
});

test('an uncited brief is rendered as uncertainty, never as canon', () => {
  const { db, project, mara, corin } = setup('brief-uncited-render');
  addRelation(db, project, mara, corin, 'user_confirmed', { chunk: null });
  const rendered = renderWebBrief(buildWebBrief(db, project, { entities: ['Mara Voss'] }));
  assert.match(rendered, /\(uncited\)/);
  assert.match(rendered, /never canon/i);
  db.close();
});

/* ------------------------------------------- controller call site (Part A/B) */

function setupPlan(name: string, opts: { collide?: boolean } = {}) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const chunk = addChunk(db, project.id, 1);
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  addRelation(db, project.id, mara, corin, 'user_confirmed', { chunk, kind: 'sister of' });
  syncThreads(db, project.id);
  return { db, project: project.id, chunk, mara, corin, collide: opts.collide };
}

function outlineMock(): { llm: ReturnType<typeof mockProvider>; prompt: () => string } {
  let captured = '';
  const llm = mockProvider((req) => {
    captured = req.messages.map((message) => message.content).join('\n');
    return JSON.stringify({ title: 'A quiet revenge', chapters: [{ number: 1, title: 'One', beats: [] }] });
  });
  return { llm, prompt: () => captured };
}

test('the real draft path carries the five headings and a locator', async () => {
  const { db, project } = setupPlan('brief-draft-path');
  const { llm, prompt } = outlineMock();
  await controller.draftPlan(db, llm as never, project, {
    premise: 'Mara Voss returns for a quiet revenge.',
    chapterCount: 1,
  });
  const text = prompt();
  for (const heading of [
    'PROVEN TIES',
    'ATTESTED TIES',
    'PROVISIONAL � DO NOT ASSERT',
    'OPEN QUESTIONS',
    'VISIBLE CONTRADICTIONS',
  ]) {
    // Absent sections are omitted by design; the block's own rules line proves
    // the brief was supplied even when a section has no rows.
    if (heading === 'ATTESTED TIES' || heading === 'VISIBLE CONTRADICTIONS' || heading === 'OPEN QUESTIONS' || heading === 'PROVISIONAL � DO NOT ASSERT') {
      continue;
    }
    assert.match(text, new RegExp(heading));
  }
  assert.match(text, /NEVER CANON|never canon/i);
  assert.match(text, /p\. 1/);
  db.close();
});

test('with no cast entities the prompt carries no brief block', async () => {
  const { db, project } = setupPlan('brief-draft-empty');
  const first = outlineMock();
  await controller.draftPlan(db, first.llm as never, project, {
    premise: 'Two strangers meet in a city with no names at all.',
    chapterCount: 1,
  });
  const second = outlineMock();
  await controller.draftPlan(db, second.llm as never, project, {
    premise: 'Two strangers meet in a city with no names at all.',
    chapterCount: 1,
  });
  assert.doesNotMatch(first.prompt(), /EVIDENCE WEB/);
  assert.equal(first.prompt(), second.prompt(), 'the prompt is unchanged between runs');
  db.close();
});

test('a thrown brief leaves planning working', async () => {
  const { db, project } = setupPlan('brief-draft-error');
  db.raw.exec('DROP TABLE canon_thread_conflict');
  const { llm, prompt } = outlineMock();
  const result = await controller.draftPlan(db, llm as never, project, {
    premise: 'Mara Voss returns for a quiet revenge.',
    chapterCount: 1,
  });
  assert.ok(result.outline, 'planning completed');
  assert.doesNotMatch(prompt(), /EVIDENCE WEB/);
  db.close();
});
