/**
 * Phase 1 acceptance tests: gated extraction + routed retrieval.
 *
 * Each test maps to one acceptance bullet:
 *
 *   - split prompts issue three small calls per window (entities, relations, events)
 *   - the span gate drops unbacked claims and repoints neighbouring ones
 *   - alias merge refuses pairs that speak in the same passage (quarantine)
 *   - the timeline -> event join populates canon_timeline.canon_event
 *   - the router sends fact lookups to FTS5 alone (no LLM expansion call)
 *   - triple-seeding starts a relational walk from the relation, not the name
 *   - a window that yields zero rows always says why
 *
 * All fixtures are the Ardenne sample book, so every verifying quote is a
 * real substring of the fixture and every fabricated quote is absent from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as graph from '../../fanfable/src/graph.ts';
import { retrieve, routeQuery } from '../../fanfable/src/answer/retrieval.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';
const LIGHTS_QUOTE = 'Three lights meant the bridge was held';
const LEDGER_QUOTE = 'Ilsa Marrow had been entered in it';
const FABRICATED_QUOTE = 'a purple dragon that never appears anywhere';

interface SplitParts {
  entities?: Record<string, unknown>[];
  facts?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
}

/** A mock that answers each of the three split calls separately, recording the order. */
function splitMock(parts: SplitParts, calls: string[], systems: string[] = []) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    systems.push(system);
    if (system.includes('KNOWN ENTITIES')) {
      calls.push('relations');
      return JSON.stringify({ relations: parts.relations ?? [] });
    }
    if (system.includes('"timeline"')) {
      calls.push('events');
      return JSON.stringify({ timeline: parts.timeline ?? [] });
    }
    calls.push('entities');
    return JSON.stringify({ entities: parts.entities ?? [], facts: parts.facts ?? [] });
  });
}

const SERENA = {
  kind: 'character',
  name: 'Serena Marsh',
  aliases: [],
  summary: 'A woman who watches the bridge.',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence: SERENA_QUOTE,
};

const KADE = {
  kind: 'character',
  name: 'Kade',
  aliases: [],
  summary: 'A frightened man.',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence: KADE_QUOTE,
};

test('the split extractor issues three small calls per window', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-split');
  const calls: string[] = [];
  const systems: string[] = [];
  const llm = splitMock(
    {
      entities: [SERENA, KADE],
      facts: [
        {
          topic: 'the signal',
          statement: 'Three lights mean the bridge is held.',
          kind: 'rule',
          certainty: 'confirmed',
          subject: 'Serena Marsh',
          chunk_index: 0,
          evidence: LIGHTS_QUOTE,
        },
      ],
      relations: [
        {
          from: 'Serena Marsh',
          to: 'Kade',
          kind: 'accompanied by',
          description: 'Kade stands behind her on the ridge.',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
        },
      ],
      timeline: [
        {
          title: 'Serena watches the ridge',
          summary: 'She counts the lights.',
          when: 'three days of rain',
          participants: ['Serena Marsh'],
          location: 'the ridge',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
        },
      ],
    },
    calls,
    systems,
  );

  const stats = await lorebook.extractLore(db, llm, project.id);
  assert.deepEqual(calls, ['entities', 'relations', 'events'], 'one window takes three calls, in order');
  assert.equal(stats.entities, 2);
  assert.equal(stats.relations, 1);
  assert.equal(stats.facts, 1);
  assert.equal(stats.timeline, 1);
  const relationsSystem = systems.find((s) => s.includes('KNOWN ENTITIES'))!;
  assert.match(relationsSystem, /Serena Marsh/, 'the relations call is told the known names');
  assert.match(relationsSystem, /Kade/, 'the relations call is told the known names');
  db.close();
});

test('the span gate drops a claim whose quote appears nowhere', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-gate-drop');
  const calls: string[] = [];
  const llm = splitMock(
    {
      entities: [
        SERENA,
        {
          kind: 'character',
          name: 'Ghost Person',
          aliases: [],
          summary: 'Invented.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: FABRICATED_QUOTE,
        },
      ],
    },
    calls,
  );

  const stats = await lorebook.extractLore(db, llm, project.id);
  const names = lorebook.listEntities(db, project.id).map((e) => e.name);
  assert.ok(names.includes('Serena Marsh'), 'the backed claim is written');
  assert.ok(!names.includes('Ghost Person'), 'the unbacked claim is never written');
  assert.ok(stats.verification.claimed >= 2, 'both claims were counted');
  assert.ok(stats.verification.verified >= 1, 'the real quote verified');
  assert.ok(stats.verification.dropped >= 1, 'the fabricated quote was dropped');
  db.close();
});

test('the span gate repoints a quote to the neighbouring passage', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-gate-repoint');
  const calls: string[] = [];
  // The ledger quote lives in chunk 2, but the model cites chunk 0.
  const llm = splitMock(
    {
      entities: [
        {
          kind: 'character',
          name: 'Ilsa Marrow',
          aliases: [],
          summary: 'A woman in the ledger.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: LEDGER_QUOTE,
        },
      ],
    },
    calls,
  );

  const stats = await lorebook.extractLore(db, llm, project.id);
  const ilsa = lorebook.listEntities(db, project.id).find((e) => e.name === 'Ilsa Marrow');
  assert.ok(ilsa, 'the claim is kept, not dropped');
  assert.ok(stats.verification.repointed >= 1, 'the reference was corrected');
  const chunk2 = db.get<{ id: number }>(
    'SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1 OFFSET 2',
    project.id,
  )!;
  assert.equal(ilsa!.sourceRefs[0]?.chunk, chunk2.id, 'the reference points at the passage that holds the quote');
  db.close();
});

test('alias merge refuses two names that speak in the same passage', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-alias');
  const at = '2024-01-01T00:00:00.000Z';
  for (const name of ['Asha', 'Asha Corwin', 'Aunt Mira', 'Aunt Mira Corwin']) {
    db.run('INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', project.id, 'character', name, at, at);
  }
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, 99, ?, ?, ?, 0, 60, 10)',
    source.id,
    project.id,
    'test scene',
    '',
    'Asha said hello first. Then Asha Corwin asked why.',
  );

  const result = lorebook.mergeCanonEntities(db, project.id);
  const names = lorebook.listEntities(db, project.id).map((e) => e.name);
  assert.ok(names.includes('Asha') && names.includes('Asha Corwin'), 'co-speakers stay separate');
  assert.ok(
    result.quarantined.some(
      (q) =>
        [q.name, q.candidate].includes('Asha') &&
        [q.name, q.candidate].includes('Asha Corwin') &&
        q.reason.includes('same passage'),
    ),
    'the refused pair is quarantined with its reason',
  );
  assert.ok(
    result.merged.some((m) => m.includes('Aunt Mira')),
    'a quiet containment pair still merges',
  );
  assert.ok(!names.includes('Aunt Mira') || !names.includes('Aunt Mira Corwin'), 'one Mira row survives');
  db.close();
});

test('the timeline join populates the event link and the participants', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-timeline');
  const calls: string[] = [];
  const llm = splitMock(
    {
      entities: [SERENA, KADE],
      timeline: [
        {
          title: 'Serena watches the ridge',
          summary: 'She counts the lights from the ridge.',
          when: 'three days of rain',
          participants: ['Serena Marsh', 'Kade'],
          location: 'the ridge',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
        },
      ],
    },
    calls,
  );
  await lorebook.extractLore(db, llm, project.id);

  const eventsLlm = mockProvider(() =>
    JSON.stringify([
      {
        title: 'Watch on the ridge',
        summary: 'Serena and Kade watch the bridge.',
        participants: ['Serena', 'Kade'],
        location: 'the ridge',
        time_label: 'day three',
        kind: 'scene',
        chunk_index: 0,
      },
    ]),
  );
  await lore.extractCanonEvents(db, eventsLlm, project.id);

  const timeline = lorebook.listTimeline(db, project.id);
  assert.equal(timeline.length, 1);
  assert.ok(timeline[0].eventId, 'canon_timeline.canon_event is populated');
  const participants = db.all<{ entity_id: number }>(
    'SELECT entity_id FROM canon_event_participant WHERE canon_event_id = ?',
    timeline[0].eventId!,
  );
  assert.ok(participants.length >= 2, `participants are populated (${participants.length})`);
  db.close();
});

test('the router sends a fact lookup to FTS5 alone', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-router');
  const calls: string[] = [];
  await lorebook.extractLore(db, splitMock({ entities: [SERENA, KADE] }, calls), project.id);

  assert.equal(routeQuery('"Two hundred yards," said Kade', []), 'lookup');
  assert.equal(routeQuery('the bridge and the lantern light', []), 'vague');
  assert.equal(routeQuery("who is Serena Marsh's sister", ['Serena Marsh']), 'relational');
  assert.equal(routeQuery('', ['Serena Marsh', 'Kade']), 'relational');

  const seen: string[] = [];
  const llm = mockProvider((req) => {
    seen.push(req.system ?? '');
    return JSON.stringify({ terms: ['ridge'] });
  });
  const lookup = await retrieve(db, llm, project.id, { query: '"Two hundred yards," said Kade' });
  assert.equal(lookup.stats.route, 'lookup');
  assert.ok(!seen.some((s) => s.includes('search keywords')), 'a lookup pays for no LLM expansion');
  assert.equal(lookup.graph.nodes.length, 0, 'a lookup walks no graph');

  seen.length = 0;
  const vague = await retrieve(db, llm, project.id, { query: 'the bridge and the lantern light' });
  assert.equal(vague.stats.route, 'vague');
  assert.ok(seen.some((s) => s.includes('search keywords')), 'a vague query keeps expansion');
  db.close();
});

test('triple-seeding starts a relational walk from the relation', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-triple');
  const calls: string[] = [];
  await lorebook.extractLore(
    db,
    splitMock(
      {
        entities: [SERENA, KADE],
        relations: [
          {
            // Stating quote naming an endpoint: banks under the strict gate,
            // so the triple walk has something to start from.
            from: 'Serena Marsh',
            to: 'Kade',
            kind: 'sibling of',
            description: 'Kade is the brother of Serena Marsh.',
            chunk_index: 0,
            evidence: 'Serena Marsh watched it from the ridge, wrapped in a coat that had belonged to her brother',
          },
        ],
      },
      calls,
    ),
    project.id,
  );

  // Graph fixture: force the seeded row to the keeper tier so this test
  // exercises triple seeding, not tier classification.
  db.run("UPDATE canon_relation SET review_status = 'accepted' WHERE project_id = ? AND kind = 'sibling of'", project.id);
  const loaded = graph.loadGraph(db, project.id);
  const seed = graph.resolveQuerySeeds(loaded, "who is Serena Marsh's sibling", ['Serena Marsh']);
  assert.equal(seed.via, 'triple', 'the walk starts from the relation, not the name');

  const ctx = graph.buildGraphContext(db, project.id, {
    query: "who is Serena Marsh's sibling",
    focus: ['Serena Marsh'],
    seedMode: 'triple',
  });
  assert.equal(ctx.stats.seedVia, 'triple');
  assert.ok(
    ctx.nodes.some((n) => n.name === 'Kade'),
    'the far end of the relation is in context',
  );
  db.close();
});

test('a window that yields zero rows always says why', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-empty');
  const calls: string[] = [];
  const llm = splitMock({}, calls);
  const stats = await lorebook.extractLore(db, llm, project.id);
  assert.equal(stats.emptyWindows.length, 1, 'the silent window is reported');
  assert.equal(stats.emptyWindows[0].reason, 'empty-answer');

  const { db: db2 } = tempDb();
  const project2 = seedProject(db2, 'phase1-gated');
  const calls2: string[] = [];
  const gated = await lorebook.extractLore(
    db2,
    splitMock(
      {
        entities: [
          {
            kind: 'character',
            name: 'Nobody Here',
            aliases: [],
            summary: 'Invented.',
            attributes: {},
            role: '',
            status: '',
            chunk_index: 0,
            evidence: FABRICATED_QUOTE,
          },
        ],
      },
      calls2,
    ),
    project2.id,
  );
  assert.equal(gated.emptyWindows.length, 1, 'the gated window is reported');
  assert.equal(gated.emptyWindows[0].reason, 'gate-dropped');
  assert.match(gated.emptyWindows[0].detail ?? '', /parsed 1 claims/, 'the report counts what the gate took');
  db.close();
  db2.close();
});

test('a bare-list section answer is accepted, not silently dropped', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-bare-list');
  const calls: string[] = [];
  // Real models sometimes return the section as a bare list instead of the
  // asked-for labelled box. Same content — the rows must still be written.
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      calls.push('relations');
      return JSON.stringify([
        {
          from: 'Serena Marsh',
          to: 'Kade',
          kind: 'accompanied by',
          description: 'Kade stands behind her on the ridge.',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
        },
      ]);
    }
    if (system.includes('"timeline"')) {
      calls.push('events');
      return JSON.stringify([
        {
          title: 'Serena watches the ridge',
          summary: 'She counts the lights.',
          when: 'three days of rain',
          participants: ['Serena Marsh'],
          location: 'the ridge',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
        },
      ]);
    }
    calls.push('entities');
    return JSON.stringify({ entities: [SERENA, KADE], facts: [] });
  });
  await lorebook.extractLore(db, llm, project.id);
  const relations = lorebook.listRelations(db, project.id);
  assert.equal(relations.length, 1, 'the bare-list relation is written');
  assert.equal(relations[0].fromName, 'Serena Marsh');
  const timeline = lorebook.listTimeline(db, project.id);
  assert.equal(timeline.length, 1, 'the bare-list timeline entry is written');
  db.close();
});

test('short-form relation names resolve upward to the unique full name', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'phase1-shortname');
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify([
        { from: 'Serena', to: 'Kade', kind: 'accompanies', description: 'Kade stands with her.', chunk_index: 0, evidence: SERENA_QUOTE },
      ]);
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA, KADE], facts: [] });
  });
  await lorebook.extractLore(db, llm, project.id);
  const relations = lorebook.listRelations(db, project.id);
  assert.equal(relations.length, 1, 'the short-form relation resolves instead of dropping');
  assert.equal(relations[0].fromName, 'Serena Marsh');
  assert.equal(relations[0].toName, 'Kade');

  // Ambiguity stays unresolved: two Serenas means "Serena" matches nobody.
  const { db: db2 } = tempDb();
  const project2 = seedProject(db2, 'phase1-shortname-ambiguous');
  const OTHER = { ...KADE, name: 'Serena Vale', evidence: SERENA_QUOTE };
  const llm2 = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify([
        { from: 'Serena', to: 'Kade', kind: 'accompanies', description: 'Guessing.', chunk_index: 0, evidence: SERENA_QUOTE },
      ]);
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA, OTHER], facts: [] });
  });
  await lorebook.extractLore(db2, llm2, project2.id);
  assert.equal(lorebook.listRelations(db2, project2.id).length, 0, 'an ambiguous short form is dropped, never guessed');
  db.close();
  db2.close();
});
