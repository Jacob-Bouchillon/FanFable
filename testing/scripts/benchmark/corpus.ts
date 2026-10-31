/**
 * Build the benchmark corpus.
 *
 * The corpus is the fixed input every model is measured against:
 *
 *   bench-hp     the imported book, and nothing else. Used by the lore
 *                scenario, which must not see a story on top of the canon.
 *   bench-story  the same book, plus one extraction of its lore, one index of
 *                canon events, an approved outline, an approved prologue and
 *                the story state that prologue produced.
 *
 * The lore and the canon-event index are extracted once, by the baseline
 * model, and are then frozen. Every model under test writes against the same
 * graph, the same passages and the same story state; otherwise a difference
 * in the result would be a difference in the input.
 *
 *   node testing/scripts/benchmark/corpus.ts [--db testing/benchmarks/data/bench.db] [--skip-lore]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Db } from '../../../fanfable/src/core/db.ts';
import * as controller from '../../../fanfable/src/plan/controller.ts';
import * as lore from '../../../fanfable/src/answer/lore.ts';
import * as lorebook from '../../../fanfable/src/lorebook.ts';
import * as planner from '../../../fanfable/src/plan/planner.ts';
import { createClient, type LlmClient } from '../../../fanfable/src/core/llm.ts';
import { isMain } from './harness.ts';

export interface StoryFixture {
  project: string;
  title: string;
  premise: string;
  divergence: string;
  preferences: Record<string, string>;
  prologue: {
    number: number;
    title: string;
    goal: string;
    synopsis: string;
    characters: string[];
    notes: string;
  };
  chapters: planner.ChapterOutline[];
}

export function loadStoryFixture(): StoryFixture {
  const path = resolve(import.meta.dirname, '../../../testing/benchmarks/fixtures/story.json');
  return JSON.parse(readFileSync(path, 'utf8')) as StoryFixture;
}

export const DEFAULT_DB = 'testing/benchmarks/data/bench.db';
export const BOOK_PATH = process.env.FANFABLE_BOOK ?? `${process.env.HOME}/Downloads/85jkr_harrypotter_1.pdf`;

/** The model that builds the fixed corpus. Everything else is measured against it. */
export const BASELINE_MODEL = process.env.FANFABLE_BASELINE_MODEL ?? 'qwen2.5:7b';

export function baselineClient(overrides: Record<string, unknown> = {}): LlmClient {
  return createClient({
    provider: 'ollama',
    model: BASELINE_MODEL,
    seed: 42,
    contextTokens: 8192,
    ...overrides,
  } as never);
}

/**
 * Import the book into a project. Idempotent: an existing import is reused.
 */
export async function ensureBook(
  db: Db,
  projectName: string,
  bookPath = BOOK_PATH,
): Promise<number> {
  let project = controller.getProjectByName(db, projectName);
  if (!project) project = controller.createProject(db, projectName);
  const sources = lore.listSources(db, project.id);
  if (!sources.length) {
    if (!existsSync(bookPath)) throw new Error(`source book not found: ${bookPath}`);
    const res = await lore.importSourceAsync(db, project.id, bookPath);
    console.log(`  imported ${res.chunks} passages from ${bookPath}`);
  } else {
    console.log(`  source already imported (${sources.length} source(s))`);
  }
  return project.id;
}

/**
 * Extract the lore and the canon-event index once, with the baseline model.
 * The passages that are already mined are skipped, so this is safe to re-run.
 */
export interface LoreWindowProgress {
  phase: 'lore' | 'events';
  done: number;
  total: number;
  passagesDone: number;
  passagesTotal: number;
}

export async function ensureLore(
  db: Db,
  projectId: number,
  llm: LlmClient,
  rebuild = false,
  onWindow?: (progress: LoreWindowProgress) => void,
): Promise<void> {
  if (rebuild) {
    console.log('  clearing the extracted lore and re-reading the book');
    db.run('DELETE FROM canon_relation WHERE project_id = ?', projectId);
    db.run('DELETE FROM canon_fact WHERE project_id = ?', projectId);
    db.run('DELETE FROM canon_timeline WHERE project_id = ?', projectId);
    db.run('DELETE FROM canon_entity WHERE project_id = ?', projectId);
    db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', projectId);
  }
  const unmined = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 0',
    projectId,
  )?.n ?? 0;
  const chunks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', projectId)?.n ?? 0;
  if (chunks && unmined === 0) {
    const entities = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId);
    console.log(`  lore already extracted (${entities?.n ?? 0} entities)`);
  } else {
    console.log(`  extracting lore with the baseline model (${unmined} of ${chunks} passages left)`);
    const stats = await lorebook.extractLore(db, llm, projectId, {
      concurrency: 3,
      onProgress: (m) => {
        if (m.includes('windows')) process.stdout.write(`\r  ${m}          `);
      },
      onWindow,
    });
    process.stdout.write('\n');
    console.log(`  lore: ${stats.entities} entities, ${stats.relations} relations, ${stats.facts} facts`);
  }

  const events = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_event WHERE project_id = ?', projectId);
  if ((events?.n ?? 0) === 0) {
    console.log('  indexing canon events with the baseline model');
    const created = await lore.extractCanonEvents(db, llm, projectId, {
      chunkLimit: 500,
      maxEvents: 300,
      onProgress: (m) => process.stdout.write(`\r  ${m}          `),
      onWindow,
    });
    process.stdout.write('\n');
    console.log(`  canon events: ${created.length}`);
  } else {
    console.log(`  canon events already indexed (${events!.n})`);
  }
}

/**
 * The approved outline. It comes from the fixture, not from a model: the plan
 * has to be the same for every model, or the test measures planning skill
 * inside a writing test.
 */
export function ensureOutline(db: Db, projectId: number, fixture: StoryFixture): planner.Outline {
  const existing = planner.approvedOutline(db, projectId);
  if (existing) return existing;
  const prologue: planner.ChapterOutline = {
    number: fixture.prologue.number,
    title: fixture.prologue.title,
    goal: fixture.prologue.goal,
    synopsis: fixture.prologue.synopsis,
    scenes: [],
    characters: fixture.prologue.characters,
    characterArcs: '',
    canonEventIds: [],
    notes: fixture.prologue.notes,
    targetWords: 1200,
  };
  const outline = planner.saveOutline(db, projectId, {
    premise: fixture.premise,
    divergence: fixture.divergence,
    divergenceRef: '',
    canonRefs: [],
    structure: [
      'act 1: the Sorting, and the house that claims him',
      'act 2: the house, the staff, and the rumour of the Sorting',
      'act 3: the chamber, and what the house wants with him',
    ],
    chapters: [prologue, ...fixture.chapters],
    preferences: fixture.preferences,
    status: 'approved',
  });
  planner.approveOutline(db, projectId, outline.id);
  return planner.approvedOutline(db, projectId)!;
}

/**
 * The prologue chapter: written once by the baseline model and approved, so
 * that the story state every candidate starts from is the same.
 */
export async function ensurePrologue(
  db: Db,
  llm: LlmClient,
  projectId: number,
  fixture: StoryFixture,
): Promise<void> {
  const existing = controller.getChapter(db, projectId, fixture.prologue.number);
  if (existing?.body) {
    console.log('  prologue already written and approved');
    return;
  }
  console.log('  writing the prologue with the baseline model');
  const written = await controller.writeChapter(db, llm, projectId, {
    chapterNumber: fixture.prologue.number,
    targetWords: 1200,
  });
  await controller.approveChapter(db, llm, projectId, fixture.prologue.number);
  const words = written.chapter.body.split(/\s+/).filter(Boolean).length;
  console.log(`  prologue: ${words} words, approved`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbArg = args.indexOf('--db');
  const dbPath = dbArg >= 0 ? args[dbArg + 1] : DEFAULT_DB;
  const skipLore = args.includes('--skip-lore');
  const rebuildLore = args.includes('--rebuild-lore');

  const db = new Db(dbPath);
  const llm = baselineClient();
  const fixture = loadStoryFixture();

  console.log('bench-hp: the book on its own');
  const hpId = await ensureBook(db, 'bench-hp');

  console.log(`bench-story: the book, the lore and the story (${fixture.title})`);
  const storyId = await ensureBook(db, fixture.project);

  if (!skipLore) {
    await ensureLore(db, storyId, llm, rebuildLore);
  }

  ensureOutline(db, storyId, fixture);
  console.log('  outline approved (from the fixture, identical for every model)');

  if (!skipLore) {
    await ensurePrologue(db, llm, storyId, fixture);
  }

  const counts = db.get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM canon_chunk WHERE project_id = ?) AS n`,
    storyId,
  );
  console.log(`\ncorpus ready: ${counts?.n ?? 0} passages in ${dbPath}`);
  db.close();
}

if (isMain(import.meta.url)) {
  void main();
}
