/**
 * Planner cast relationships and possessive focus terms. Generic names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as graph from '../../fanfable/src/support/graph.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const PREMISE = 'Mara returns to the valley with Tor and Corin.';
const DIVERGENCE = 'Mara arrives a season early.';

const OUTLINE = {
  premise: PREMISE,
  divergence: DIVERGENCE,
  canon_refs: [],
  structure: ['Arrival'],
  chapters: [
    {
      number: 1,
      title: 'Arrival',
      goal: 'Mara reaches the valley.',
      synopsis: 'Mara arrives and finds Tor waiting.',
      scenes: [
        {
          title: 'The gate',
          summary: 'Mara meets Tor at the gate.',
          pov: 'Mara',
          location: 'the gate',
          canon_event_ids: [],
          adaptations: '',
        },
      ],
      characters: ['Mara', 'Tor'],
      character_arcs: '',
      canon_event_ids: [],
      notes: '',
      target_words: 300,
    },
  ],
  preferences: {},
};

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

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  status: string,
  confirmedByUser = false,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, confirmed_by_user, created_at)
       VALUES (?, ?, ?, ?, '', '', '[]', 1.0, ?, ?, ?)`,
      projectId,
      from,
      to,
      kind,
      status,
      confirmedByUser ? 1 : 0,
      AT,
    ).lastInsertRowid,
  );
}

interface Cast {
  mara: number;
  tor: number;
  corin: number;
  pip: number;
  lark: number;
  vell: number;
}

async function plannedPrompt(build: (db: Db, projectId: number, cast: Cast) => void): Promise<string> {
  const { db } = tempDb();
  const project = seedProject(db, 'cast-block');
  const cast: Cast = {
    mara: addEntity(db, project.id, 'Mara'),
    tor: addEntity(db, project.id, 'Tor'),
    corin: addEntity(db, project.id, 'Corin'),
    pip: addEntity(db, project.id, 'Pip'),
    lark: addEntity(db, project.id, 'Lark'),
    vell: addEntity(db, project.id, 'Mara Vell'),
  };
  build(db, project.id, cast);
  let prompt = '';
  const llm = mockProvider((req) => {
    prompt = req.messages[0]?.content ?? '';
    return JSON.stringify(OUTLINE);
  });
  const result = await controller.draftPlan(db, llm, project.id, {
    premise: PREMISE,
    divergence: DIVERGENCE,
    chapterCount: 1,
  });
  assert.ok(result.outline);
  db.close();
  return prompt;
}

function castSection(prompt: string): string {
  const start = prompt.indexOf('CAST RELATIONSHIPS');
  assert.ok(start >= 0, 'cast section present');
  const rest = prompt.slice(start);
  const end = rest.search(/\n\n(?:EVIDENCE WEB|CANON EVENTS INDEX|CONNECTED CONTEXT|AUTHOR PREFERENCES|AUTHOR NOTES)/);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

/** Five ties with both endpoints in the premise cast. */
function fiveCastTies(db: Db, projectId: number, cast: Cast): void {
  addRelation(db, projectId, cast.mara, cast.tor, 'cousin of', 'user_confirmed', true);
  addRelation(db, projectId, cast.mara, cast.tor, 'friend of', 'accepted');
  addRelation(db, projectId, cast.tor, cast.mara, 'ally of', 'accepted');
  addRelation(db, projectId, cast.mara, cast.corin, 'mentor of', 'accepted');
  addRelation(db, projectId, cast.tor, cast.corin, 'friend of', 'accepted');
}

test("terms strips a possessive", () => {
  const words = graph.terms("Mara's first year");
  assert.ok(words.includes('mara'));
  assert.ok(!words.includes("mara's"));
});

test('the cast block lists confirmed and quoted ties', async () => {
  const section = castSection(await plannedPrompt(fiveCastTies));
  assert.match(section, /Mara — cousin of — Tor\s+\[user-confirmed\]/);
  assert.match(section, /Mara — friend of — Tor\s+\[quoted\]/);
  assert.match(section, /author's own rulings/);
});

test('ties outside the premise cast are excluded when enough cast ties exist', async () => {
  const section = castSection(
    await plannedPrompt((db, projectId, cast) => {
      fiveCastTies(db, projectId, cast);
      // One endpoint only, and neither endpoint: both must be absent.
      addRelation(db, projectId, cast.mara, cast.pip, 'friend of', 'accepted');
      addRelation(db, projectId, cast.pip, cast.lark, 'friend of', 'accepted');
    }),
  );
  assert.ok(!section.includes('Mara — friend of — Pip'), 'one-endpoint tie excluded');
  assert.ok(!section.includes('Pip — friend of — Lark'), 'tie outside the premise excluded');
});

test('a confirmation sorts above an accepted tie from the earlier selection stage', async () => {
  const section = castSection(
    await plannedPrompt((db, projectId, cast) => {
      // Only two both-endpoint ties, so the one-endpoint confirmed tie is added
      // by the wider stage; it must still render first.
      addRelation(db, projectId, cast.mara, cast.tor, 'friend of', 'accepted');
      addRelation(db, projectId, cast.tor, cast.corin, 'ally of', 'accepted');
      addRelation(db, projectId, cast.vell, cast.tor, 'cousin of', 'user_confirmed', true);
    }),
  );
  const lines = section.split('\n').filter((line) => line.startsWith('- '));
  assert.match(lines[0]!, /Mara Vell — cousin of — Tor\s+\[user-confirmed\]/);
  assert.ok(lines.slice(1).every((line) => line.includes('[quoted]')));
});
