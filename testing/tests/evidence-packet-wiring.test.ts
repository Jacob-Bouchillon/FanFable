/**
 * Evidence-packet wiring: flag-off planning is unchanged; flag-on grounds
 * scenes from a validated packet. Synthetic canon events only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, summary, attributes, role, status,
       evidence, source_refs, mentions, review_status, created_at, updated_at)
     VALUES (?, 'character', ?, '[]', '', '{}', '', '', '', '[]', 1, 'accepted', ?, ?)`,
    projectId,
    name,
    AT,
    AT,
  ).lastInsertRowid);
}

function event(
  db: Db,
  projectId: number,
  title: string,
  summary: string,
  participants: string[],
  seq: number,
  locator: string,
): number {
  return Number(db.run(
    `INSERT INTO canon_event (project_id, source_id, seq, locator, title, summary, participants, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
    projectId,
    seq,
    locator,
    title,
    summary,
    JSON.stringify(participants),
    AT,
  ).lastInsertRowid);
}

function capture() {
  let prompt = '';
  const llm = mockProvider((req) => {
    prompt = req.messages.map((message) => message.content).join('\n');
    return JSON.stringify({ chapters: [] });
  });
  return { llm, prompt: () => prompt };
}

function section(prompt: string, from: string, to?: string): string {
  const start = prompt.indexOf(from);
  if (start < 0) return '';
  const end = to ? prompt.indexOf(to, start + from.length) : -1;
  return prompt.slice(start, end < 0 ? undefined : end);
}

test('flag-off planning sends the same prompt as before and no packet block', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'packet-off');
  entity(db, project.id, 'Asha');
  event(db, project.id, 'The Sorting', 'The Sorting places students.', ['Asha'], 10, 'p. 10');

  const first = capture();
  const result = await controller.draftPlan(db, first.llm as never, project.id, {
    premise: 'Asha attends the Sorting.',
    chapterCount: 1,
  });
  assert.equal(result.evidence, undefined);
  assert.ok(!first.prompt().includes('EVIDENCE PACKET'));

  const second = capture();
  await controller.draftPlan(db, second.llm as never, project.id, {
    premise: 'Asha attends the Sorting.',
    chapterCount: 1,
  });
  assert.equal(second.prompt(), first.prompt(), 'flag-off prompt is byte-identical across runs');
  db.close();
});

test('flag-on resolves a Sorting claim to the Sorting event, never the Platform catch-all', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'packet-sorting');
  entity(db, project.id, 'Asha');
  entity(db, project.id, 'Bram');
  const sorting = event(
    db,
    project.id,
    'The Sorting',
    'Asha is sorted by the Sorting. The Sorting places students into houses.',
    ['Asha'],
    10,
    'p. 10',
  );
  const platform = event(db, project.id, 'Platform Nine', 'Bram waits on the platform.', ['Asha', 'Bram'], 2, 'p. 2');

  const mock = capture();
  const result = await controller.draftPlan(db, mock.llm as never, project.id, {
    premise: 'Asha attends the Sorting.',
    chapterCount: 1,
    evidencePacket: true,
  });
  assert.equal(result.evidence?.fallback, false);
  assert.equal(result.evidence?.support, 1, 'one claim, one support');
  const prompt = mock.prompt();
  const support = section(prompt, 'SUPPORT (citable', 'GAPS (uncertainty');
  const background = section(prompt, 'BACKGROUND (never citable', 'SUSPICIOUS REUSE');
  assert.ok(support.includes(`[canon:${sorting}]`), 'the Sorting event is the citation');
  assert.ok(support.includes('p. 10'), 'the support carries its locator');
  assert.ok(!support.includes(`[canon:${platform}]`), 'the catch-all event is not a citation');
  assert.ok(background.includes(`[canon:${platform}]`), 'the catch-all is background only');
  assert.ok(!section(prompt, 'CANON EVENTS INDEX', 'CONNECTED CONTEXT').includes(`- ${platform}:`),
    'context ids are not in the citable canon index');
  db.close();
});

test('flag-on reports a divergence with no AU support as an explicit gap', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'packet-divergence-gap');
  entity(db, project.id, 'Asha');
  event(db, project.id, 'The Sorting', 'The Sorting places students into houses.', ['Asha'], 10, 'p. 10');

  const mock = capture();
  const result = await controller.draftPlan(db, mock.llm as never, project.id, {
    premise: 'Asha attends the Sorting.',
    divergence: 'Asha is placed in a different house.',
    chapterCount: 1,
    evidencePacket: true,
  });
  assert.ok((result.evidence?.gaps ?? 0) >= 1, 'the divergence is a gap');
  const gaps = section(mock.prompt(), 'GAPS (uncertainty', 'BACKGROUND (never citable');
  assert.ok(gaps.includes('au-dependent'), 'the gap is labelled');
  assert.ok(gaps.includes('Asha is placed in a different house.'), 'the gap names the claim as uncertainty');
  db.close();
});

test('character-only co-presence never becomes support', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'packet-character-only');
  entity(db, project.id, 'Asha');
  entity(db, project.id, 'Bram');
  event(db, project.id, 'Platform Nine', 'Bram waits on the platform.', ['Asha', 'Bram'], 2, 'p. 2');

  const mock = capture();
  const result = await controller.draftPlan(db, mock.llm as never, project.id, {
    premise: 'Asha and Bram wait.',
    chapterCount: 1,
    evidencePacket: true,
  });
  assert.equal(result.evidence?.support, 0, 'names alone are not support');
  const gaps = section(mock.prompt(), 'GAPS (uncertainty', 'BACKGROUND (never citable');
  assert.ok(gaps.includes('no-term-match'), 'the name-only match is reported as a gap');
  db.close();
});

test('one event offered for three unrelated claims is flagged as suspicious reuse', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'packet-reuse');
  entity(db, project.id, 'Asha');
  const gathering = event(
    db,
    project.id,
    'Gathering',
    'Asha begins sorting, starts training, follows feast.',
    ['Asha'],
    5,
    'p. 5',
  );

  const mock = capture();
  const result = await controller.draftPlan(db, mock.llm as never, project.id, {
    premise: 'Asha begins sorting. Asha starts training. Asha follows feast.',
    chapterCount: 1,
    evidencePacket: true,
  });
  assert.equal(result.evidence?.support, 3);
  assert.equal(result.evidence?.suspiciousReuse, 1);
  const reuse = section(mock.prompt(), 'SUSPICIOUS REUSE');
  assert.ok(reuse.includes(`[canon:${gathering}]`));
  assert.ok(reuse.includes('claims:'));
  db.close();
});
