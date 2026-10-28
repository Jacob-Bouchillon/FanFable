/**
 * Phase 1 step 6 acceptance tests: budgeted prioritization + lazy extraction.
 *
 *   - scoring ranks a bridge/dialogue window above a generic one, with reasons
 *   - maxWindows caps the run and selection is seed-deterministic
 *   - randomFloor samples lonely windows across seeds (pure-function check)
 *   - the lazy path mines only the touched windows
 *   - a fully-mined rerun reports 'everything has already been read'
 *   - --full (and a lore_mined reset + full) restores mine-everything
 *   - retrieve() mines at most 2 windows on a query that hits unmined text,
 *     mines nothing on the lookup path, and finds everything mined after
 *
 * Mock provider only; no Ollama.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import type { ChunkRow } from '../../fanfable/src/lorebook.ts';
import { retrieve } from '../../fanfable/src/retrieval.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';

function row(partial: Partial<ChunkRow> & { id: number; seq: number; text: string }): ChunkRow {
  return {
    heading: '',
    locator: `locator ${partial.seq}`,
    source_title: 'test',
    path: 'test',
    source_id: 1,
    ...partial,
  };
}

/** A mock that answers the three split calls; evidence 'the' verifies in every passage. */
function budgetMock(entities?: Record<string, unknown>[]) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('search keywords')) return JSON.stringify({ terms: ['bridge'] });
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: entities ?? [
        {
          kind: 'character',
          name: 'Drifter',
          aliases: [],
          summary: 'A passing figure.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: 'the',
        },
      ],
      facts: [],
    });
  });
}

test('scoring ranks a bridge and dialogue window above a generic one', () => {
  const bridge = [
    row({
      id: 1,
      seq: 0,
      text: 'On the ridge, Serena Marsh watched. "Two hundred yards," said Kade behind her. He was her brother.',
    }),
  ];
  const generic = [
    row({
      id: 2,
      seq: 1,
      text: 'The rain fell on empty roads. Nothing moved in the grey afternoon.',
    }),
  ];
  const third = [row({ id: 3, seq: 2, text: 'At dawn Serena crossed the bridge.' })];

  const freq = lorebook.buildNameDocFreq([bridge, generic, third]);
  const a = lorebook.scoreWindow(bridge, freq);
  const b = lorebook.scoreWindow(generic, freq);

  assert.ok(a.score > b.score, `bridge ${a.score} beats generic ${b.score}`);
  assert.ok(a.reasons.some((r) => r.startsWith('bridge:')), `names recur: ${a.reasons}`);
  assert.ok(a.reasons.some((r) => r.startsWith('dialogue:')), `dialogue counts: ${a.reasons}`);
  assert.ok(a.reasons.some((r) => r.startsWith('relations:')), `kinship counts: ${a.reasons}`);
  assert.deepEqual(lorebook.scoreWindow(bridge, freq), a, 'scoring is deterministic');
});

test('maxWindows caps the run and selection is seed-deterministic', async () => {
  const run = async () => {
    const { db } = tempDb();
    const project = seedProject(db, 'step6-cap');
    const stats = await lorebook.extractLore(db, budgetMock(), project.id, {
      windowSize: 1,
      maxWindows: 2,
      seed: 7,
    });
    const mined = db
      .all<{ seq: number }>('SELECT seq FROM canon_chunk WHERE project_id = ? AND lore_mined = 1 ORDER BY seq', project.id)
      .map((r) => r.seq);
    db.close();
    return { stats, mined };
  };

  const first = await run();
  const second = await run();
  assert.equal(first.stats.windows, 2, 'only two windows run');
  assert.deepEqual(first.stats.selection, { selected: 2, total: 4, skipped: 2 });
  assert.deepEqual(first.mined, second.mined, 'the same seed mines the same windows');
  assert.equal(first.mined.length, 2, 'the rest stay unmined');
});

test('randomFloor samples a lonely window across seeds', () => {
  const scores = [10, 5, 3, 1].map((score) => ({ score, reasons: [] as string[] }));
  const union = new Set<number>();
  for (let seed = 0; seed < 16; seed++) {
    const picked = lorebook.selectWindows(scores, {
      maxWindows: 2,
      priorityFirst: 1,
      randomFloor: 1,
      seed,
    });
    assert.equal(picked.selected.length, 2, 'the cap holds on every seed');
    assert.ok(picked.selected.includes(0), 'the top window always goes first');
    for (const i of picked.selected) union.add(i);
  }
  assert.equal(union.size, 4, 'every window, lonely or not, is sampled under some seed');
});

test('the lazy path mines only the touched windows', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-lazy');
  const chunks = db.all<{ id: number; seq: number }>(
    'SELECT id, seq FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  const secondWindow = chunks.filter((c) => c.seq >= 2).map((c) => c.id);

  const mini = await lorebook.ensureWindowsForChunks(db, budgetMock(), project.id, secondWindow, {
    windowSize: 2,
  });
  assert.equal(mini.windows, 1, 'one touched window runs');
  const flags = db
    .all<{ seq: number; lore_mined: number }>(
      'SELECT seq, lore_mined FROM canon_chunk WHERE project_id = ? ORDER BY seq',
      project.id,
    )
    .map((r) => r.lore_mined);
  assert.deepEqual(flags, [0, 0, 1, 1], 'neighbours stay unmined');
  db.close();
});

test('a fully-mined rerun reports that everything has been read', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-rerun');
  await lorebook.extractLore(db, budgetMock(), project.id, { windowSize: 1 });

  const messages: string[] = [];
  const again = await lorebook.extractLore(db, budgetMock(), project.id, {
    windowSize: 1,
    onProgress: (m) => messages.push(m),
  });
  assert.equal(again.windows, 0, 'nothing runs twice');
  assert.ok(messages.includes('everything has already been read'));
  db.close();
});

test('--full restores mine-everything, including after a reset', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-full');
  const countMined = () =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', project.id)?.n ?? 0;

  const capped = await lorebook.extractLore(db, budgetMock(), project.id, {
    windowSize: 1,
    maxWindows: 1,
    seed: 7,
  });
  assert.equal(capped.windows, 1);
  assert.equal(countMined(), 1);

  const filled = await lorebook.extractLore(db, budgetMock(), project.id, {
    windowSize: 1,
    maxWindows: 1,
    full: true,
    seed: 7,
  });
  assert.equal(filled.windows, 3, 'the budget is ignored and the rest run');
  assert.equal(countMined(), 4);

  // Rollback path: resetting lore_mined and re-running with --full re-mines all.
  db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', project.id);
  const redone = await lorebook.extractLore(db, budgetMock(), project.id, {
    windowSize: 1,
    full: true,
  });
  assert.equal(redone.windows, 4);
  db.close();
});

test('a query touching unmined text mines at most two windows', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-query');
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('search keywords')) return JSON.stringify({ terms: ['bridge'] });
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: [
        {
          kind: 'character',
          name: 'Serena Marsh',
          aliases: [],
          summary: 'A woman on the ridge.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: SERENA_QUOTE,
        },
        {
          kind: 'character',
          name: 'Kade',
          aliases: [],
          summary: 'A frightened man.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: KADE_QUOTE,
        },
      ],
      facts: [],
    });
  });

  // The fast lookup path never mines.
  const lookup = await retrieve(db, llm, project.id, { query: '"Two hundred yards," said Kade' });
  assert.equal(lookup.stats.route, 'lookup');
  assert.equal(lookup.stats.lazyMined, undefined, 'a quote lookup pays no mining');

  // A vague query mines the windows behind its hits, capped at two.
  const first = await retrieve(db, llm, project.id, { query: 'the bridge and the lantern light' });
  assert.ok(first.stats.lazyMined, 'the lazy path fired');
  assert.ok(first.stats.lazyMined!.windows <= 2, `capped (${first.stats.lazyMined!.windows})`);

  // The follow-up finds everything mined and mines nothing more.
  const second = await retrieve(db, llm, project.id, { query: 'the bridge and the lantern light' });
  assert.equal(second.stats.lazyMined, undefined, 'mined once, mined for good');
  db.close();
});

test('a composed family path skips mining when evidence is fully mined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-compose-mined');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const serena = ent('Serena Marsh');
  const kade = ent('Kade');
  const mid = ent('Maren');
  const rel = (f: number, t: number, kind: string) =>
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      project.id, f, t, kind, now,
    );
  rel(serena, mid, 'son of');
  rel(mid, kade, 'aunt of');
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', project.id);
  let chats = 0;
  const llm = mockProvider(() => {
    chats++;
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  });
  const pkg = await retrieve(db, llm, project.id, {
    query: 'how are Serena Marsh and Kade related',
    focus: ['Serena Marsh', 'Kade'],
  });
  assert.deepEqual(pkg.stats.composedPath, { via: 'Maren', label: 'cousin of' }, 'the web answers without reading');
  assert.equal(pkg.stats.lazyMined, undefined, 'no windows mined when nothing unmined in scope');
  assert.equal(chats, 0, 'no model call paid');
  db.close();
});

test('a composed path mines first when unmined evidence is in scope', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-compose-unmined');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const serena = ent('Serena Marsh');
  const kade = ent('Kade');
  const mid = ent('Maren');
  const rel = (f: number, t: number, kind: string) =>
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      project.id, f, t, kind, now,
    );
  rel(serena, mid, 'son of');
  rel(mid, kade, 'aunt of');
  const llm = mockProvider(() => JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] }));
  const pkg = await retrieve(db, llm, project.id, {
    query: 'how are Serena Marsh and Kade related',
    focus: ['Serena Marsh', 'Kade'],
  });
  assert.deepEqual(pkg.stats.composedPath, { via: 'Maren', label: 'cousin of' }, 'verdict recomputed after mining');
  assert.ok(pkg.stats.lazyMined, 'unmined hits in scope are mined before the verdict');
  db.close();
});

test('two people with no tie and no path come back strangers', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'step6-strangers');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const serena = ent('Serena Marsh');
  const kade = ent('Kade');
  const llm = mockProvider(() => JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] }));
  const lonely = await retrieve(db, llm, project.id, {
    query: 'how are Serena Marsh and Kade related',
    focus: ['Serena Marsh', 'Kade'],
  });
  assert.deepEqual(lonely.stats.strangers, { a: 'Serena Marsh', b: 'Kade' }, 'strangers are an answer, never a banked row');
  assert.equal(lonely.stats.composedPath, undefined, 'nothing composed either');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n, 0,
    'the web stays exactly as it was',
  );
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    project.id, serena, kade, 'sibling of', now,
  );
  const tied = await retrieve(db, llm, project.id, {
    query: 'how are Serena Marsh and Kade related',
    focus: ['Serena Marsh', 'Kade'],
  });
  assert.equal(tied.stats.strangers, undefined, 'a direct tie clears the stranger verdict');
  db.close();
});
