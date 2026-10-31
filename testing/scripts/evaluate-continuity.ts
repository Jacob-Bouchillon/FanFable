/**
 * Continuity evaluation.
 *
 * Plants contradictions in a story and measures how many the checker finds,
 * with the graph checks on and off. The point is not the absolute number but
 * the difference: which contradictions only a graph can see, because they are
 * about connections rather than about text.
 *
 *   node testing/scripts/evaluate-continuity.ts
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as graph from '../../fanfable/src/graph.ts';
import * as memory from '../../fanfable/src/product/memory.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import { graphContinuityChecks } from '../../fanfable/src/graph-checks.ts';
import { checkChapter, deterministicChecks } from '../../fanfable/src/product/continuity.ts';

interface Planted {
  name: string;
  /** Only a graph can see this one. */
  graphOnly: boolean;
}

/** The contradictions the fixture plants. */
const PLANTED: Planted[] = [
  { name: 'a character uses a fact before learning it', graphOnly: true },
  { name: 'an event happens before the event that caused it', graphOnly: true },
  { name: 'a relationship changes with no cause recorded', graphOnly: true },
  { name: 'a character is recorded in one place and the event is elsewhere', graphOnly: true },
  { name: 'a divergence the story contradicts itself about', graphOnly: true },
  { name: 'a plot thread marked resolved with no resolving event', graphOnly: true },
];

function buildProject(): { db: Db; projectId: number; chapterId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-cont-'));
  const db = new Db(join(dir, 'eval.db'));
  const project = { id: 1 };
  db.run('INSERT INTO project (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'cont', '2024', '2024');

  const fixture = resolve(import.meta.dirname, '../tests/fixtures/sample-book.txt');
  lore.importSource(db, 1, fixture);

  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (1, 1, 'One', 'approved', 'Serena crossed the bridge. The Sorting Hat had been poisoned by Snape.', '2024-01-01', '2024-01-01')",
  );
  const chapterId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = 1')!.id;

  // The canon event the story diverges from.
  const canonEvent = db.run(
    `INSERT INTO canon_event (project_id, title, summary, locator, participants, location, time_label, kind, quote, created_at)
     VALUES (1, 'The fall of Voldemort', '', '', '[]', '', '', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;

  const serena = memory.upsertCharacter(db, 1, 'Serena Marsh');
  const kade = memory.upsertCharacter(db, 1, 'Kade');

  // 1. knowledge before learning
  const learnLater = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (1, 1, 'Serena learns the truth', '', '', 5, '[]', '', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;
  memory.addKnowledge(db, 1, {
    characterId: serena,
    fact: 'the Sorting Hat had been poisoned by Snape',
    certainty: 'knows',
    source: 'au',
    auEventId: learnLater,
    chapterId,
  });

  // 2. an impossible order
  const cause = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (1, 2, 'The potion is drunk', '', '', 3, '[]', '', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;
  const effect = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (1, 3, 'The potion takes effect', '', '', 1, '[]', '', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO au_event_link (project_id, from_event_id, to_event_id, kind, description, confidence, created_at)
     VALUES (1, ?, ?, 'cause', 'drinking causes the effect', 1.0, '2024-01-01')`,
    cause,
    effect,
  );

  // 3. a relationship that changes with no cause
  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, description, sentiment, source, chapter_id, closed, updated_at)
     VALUES (1, ?, ?, 'friend', '', '', 'au', NULL, 1, '2024-01-01')`,
    serena,
    kade,
  );
  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, description, sentiment, source, chapter_id, closed, updated_at)
     VALUES (1, ?, ?, 'estranged', '', '', 'au', NULL, 0, '2024-01-02')`,
    serena,
    kade,
  );

  // 4. a location conflict
  const atEvent = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (1, 4, 'The crossing', '', '', 2, '[]', 'the far bank', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;
  memory.addCharacterState(db, 1, serena, {
    location: 'the ridge',
    asOfEventId: atEvent,
    source: 'au',
    chapterId,
  });

  // 5. a divergence the story contradicts
  const au = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (1, 5, 'Voldemort is stopped', '', '', 4, '[]', '', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO canon_change (project_id, au_event_id, canon_event_id, change_type, description, confirmed, created_at)
     VALUES (1, ?, ?, 'prevented', 'the fall of Voldemort is prevented', 0, '2024-01-01')`,
    au,
    canonEvent,
  );
  const later = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (1, 6, 'Voldemort falls anyway', '', '', 6, '[]', '', 'event', '', '2024-01-01')`,
  ).lastInsertRowid;
  db.run('UPDATE au_event SET adapts_canon_event_id = ? WHERE id = ?', canonEvent, later);

  // 6. a thread marked resolved with no event
  memory.upsertThread(db, 1, 'The third lantern', 'why she took it', 'resolved');

  return { db, projectId: 1, chapterId };
}

function main(): void {
  const { db, projectId, chapterId } = buildProject();
  const chapter = db.get<{ id: number; number: number; title: string; body: string; status: string; summary: string }>(
    'SELECT id, number, title, body, status, summary FROM chapter WHERE id = ?',
    chapterId,
  )!;

  const deterministic = deterministicChecks({
    chapter,
    previousChapters: [],
    events: [],
    threads: [],
    knowledge: [],
    canonChanges: [],
  });
  const graphIssues = graphContinuityChecks(db, projectId, {
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    body: chapter.body,
    storyOrder: 2,
  });

  const g = graph.loadGraph(db, projectId);
  console.log(`graph: ${g.nodes.size} nodes, ${g.edges.length} connections`);
  console.log(`planted contradictions: ${PLANTED.length}\n`);

  console.log('checker                       found');
  console.log('-------------------------------------');
  console.log(`text checks only              ${deterministic.length}`);
  console.log(`graph checks                  ${graphIssues.length}`);
  const combined = new Set([...deterministic, ...graphIssues].map((i) => `${i.category}:${i.message}`));
  console.log(`both together (unique)        ${combined.size}`);
  console.log(`\ngraph checks by category:`);
  const byCategory = new Map<string, number>();
  for (const i of graphIssues) byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + 1);
  for (const [cat, n] of byCategory) console.log(`  ${cat.padEnd(14)} ${n}`);
  console.log('\nevery graph finding:');
  for (const i of graphIssues) console.log(`  [${i.severity}] ${i.category}: ${i.message}`);
  db.close();
}

main();
