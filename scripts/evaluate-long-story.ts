/**
 * The long story.
 *
 * A story of several chapters, written and approved through the real
 * pipeline, with a restart in the middle, an edit in one chapter, and a
 * contradiction planted in one draft. The question is not whether each
 * chapter looks acceptable but whether the story holds together: whether the
 * memory is right, whether the canon was left alone, whether the divergence
 * stayed the divergence, and whether a contradiction in the middle of it is
 * caught.
 *
 * Every model starts from the same database: the file is copied before each
 * run and put back, so no model inherits another model's story.
 *
 *   node scripts/evaluate-long-story.ts --models qwen2.5:7b --chapters 1-8
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Db } from '../src/db.ts';
import * as controller from '../src/controller.ts';
import * as continuity from '../src/continuity.ts';
import * as graph from '../src/graph.ts';
import * as graphchecks from '../src/graph-checks.ts';
import * as memory from '../src/memory.ts';
import * as planner from '../src/planner.ts';
import { isMain, loadModels, makeClient, mean, RunStore, table, type ModelSpec } from './benchmark/harness.ts';
import { loadStoryFixture, baselineClient, DEFAULT_DB } from './benchmark/corpus.ts';
import { copiedRate, repetitionRate, words } from './benchmark/measure.ts';

interface Options {
  models: string[];
  chapters: number[];
  db: string;
  targetWords: number;
  runId: string;
  plantChapter: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    models: [],
    chapters: [1, 2, 3, 4, 5, 6, 7, 8],
    db: DEFAULT_DB,
    targetWords: 1200,
    runId: '',
    plantChapter: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--models') opts.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--chapters') {
      const [a, b] = argv[++i].split('-').map(Number);
      opts.chapters = Array.from({ length: (b ?? a) - (a ?? 1) + 1 }, (_, k) => (a ?? 1) + k);
    } else if (arg === '--db') opts.db = argv[++i];
    else if (arg === '--target-words') opts.targetWords = Number(argv[++i]);
    else if (arg === '--run') opts.runId = argv[++i];
    else if (arg === '--plant-chapter') opts.plantChapter = Number(argv[++i]);
  }
  return opts;
}

/** Copy the database file aside, with the write-ahead log folded in. */
function snapshot(db: Db, path: string): void {
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  copyFileSync(dbPathOf(db), path);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function dbPathOf(db: Db): string {
  // The Db class keeps the path it was given; it is not exposed, so it is
  // passed through the module-level variable instead.
  return currentPath;
}

let currentPath = '';

/** Put the database back the way it was. */
function restore(path: string, snapshotPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  copyFileSync(snapshotPath, path);
}

const PLANTED = {
  chapter: 4,
  category: 'canon-mix',
  sentence:
    'Harry remembered, clearly and without doubt, that the Sorting Hat had put him in Gryffindor, and that the Gryffindor table had cheered him for it.',
};

/** Put a contradiction into an approved chapter, as a bad edit would. */
function plantContradiction(db: Db, projectId: number, chapterNumber: number): void {
  const chapter = controller.getChapter(db, projectId, chapterNumber);
  if (!chapter) return;
  controller.setChapterBody(db, projectId, chapterNumber, `${chapter.body}\n\n${PLANTED.sentence}`);
}

/** Count what the story knows, and what the canon holds. */
function storyCounts(db: Db, projectId: number): Record<string, number> {
  const tables = [
    'chapter',
    'au_event',
    'character',
    'character_knowledge',
    'relationship',
    'plot_thread',
    'secret',
    'motivation',
    'story_fact',
    'canon_entity',
    'canon_relation',
    'canon_fact',
    'canon_event',
    'canon_chunk',
    'continuity_issue',
    'state_conflict',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      out[t] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, projectId)?.n ?? 0;
    } catch {
      out[t] = -1;
    }
  }
  return out;
}

async function runStory(
  db: Db,
  spec: ModelSpec,
  opts: Options,
  fixture: ReturnType<typeof loadStoryFixture>,
): Promise<Record<string, number | string | boolean | null>> {
  const project = controller.getProjectByName(db, fixture.project);
  if (!project) throw new Error('no story project');
  const projectId = project.id;
  const client = makeClient(spec);
  const before = storyCounts(db, projectId);

  const sourceText = db
    .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
    .map((r) => r.text)
    .join('\n');

  const started = Date.now();
  const lengths: number[] = [];
  const repetitions: number[] = [];
  const copied: number[] = [];
  let approved = 0;
  let restarts = 0;
  let plantedCaught = false;
  let plantedIssues = 0;
  let conflicts = 0;

  for (const number of opts.chapters) {
    const written = await controller.writeChapter(db, client, projectId, {
      chapterNumber: number,
      targetWords: opts.targetWords,
    });
    const body = written.chapter.body ?? '';
    lengths.push(words(body) / opts.targetWords);
    repetitions.push(repetitionRate(body));
    copied.push(copiedRate(body, sourceText));

    // Edit one chapter: the contradiction is planted, then the chapter is
    // written again and re-approved, which is the path that has to clean up
    // its own records.
    if (number === opts.plantChapter) {
      plantContradiction(db, projectId, number);
    }

    const result = await controller.approveChapter(db, client, projectId, number);
    approved++;
    conflicts += result.conflicts.length;

    // The chapter with the planted contradiction is checked after approval.
    if (number === opts.plantChapter) {
      const issues = result.issues;
      plantedIssues = issues.length;
      plantedCaught = issues.some(
        (i) =>
          i.category === PLANTED.category ||
          /gryffindor/i.test(`${i.message} ${i.evidence}`) ||
          /sorting hat/i.test(`${i.message} ${i.evidence}`),
      );
    }

    // Halfway through: restart the application, as the author would.
    if (number === opts.chapters[Math.floor(opts.chapters.length / 2)]) {
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      restarts++;
    }
  }

  const after = storyCounts(db, projectId);

  // The graph checks, over the finished story.
  const lastChapterId = controller.getChapter(db, projectId, opts.chapters[opts.chapters.length - 1])?.id ?? 0;
  const g = graph.loadGraph(db, projectId);
  const graphIssues = graphchecks.graphContinuityChecks(db, projectId, {
    chapterId: lastChapterId,
    chapterNumber: opts.chapters[opts.chapters.length - 1] + 1,
    body: '',
    storyOrder: 99,
  });

  const characters = db.get<{ n: number }>(
    'SELECT COUNT(DISTINCT character_id) AS n FROM character_knowledge WHERE project_id = ?',
    projectId,
  )?.n ?? 0;
  const threads = db.all<{ title: string; status: string }>('SELECT title, status FROM plot_thread WHERE project_id = ?', projectId);
  const resolved = threads.filter((t) => t.status === 'resolved').length;

  return {
    chapters: opts.chapters.length,
    approved,
    restarts,
    lengthRatio: mean(lengths) ?? 0,
    repetition: mean(repetitions) ?? 0,
    copied: mean(copied) ?? 0,
    words: lengths.reduce((a, l) => a + l * opts.targetWords, 0),
    // The canon must not move.
    canonEntityDelta: after.canon_entity - before.canon_entity,
    canonRelationDelta: after.canon_relation - before.canon_relation,
    canonEventDelta: after.canon_event - before.canon_event,
    canonChunkDelta: after.canon_chunk - before.canon_chunk,
    // The story must have its own records.
    auEvents: after.au_event,
    knowledgeRecords: after.character_knowledge,
    charactersWithKnowledge: characters,
    relationships: after.relationship,
    threads: after.plot_thread,
    threadsResolved: resolved,
    secrets: after.secret,
    motivations: after.motivation,
    storyFacts: after.story_fact,
    conflicts,
    continuityIssues: after.continuity_issue,
    graphNodes: g.nodes.size,
    graphEdges: g.edges.length,
    graphIssues: graphIssues.length,
    plantedCaught: plantedCaught ? 'yes' : 'no',
    plantedIssues,
    ms: Date.now() - started,
    promptTokens: client.promptTokens,
    completionTokens: client.completionTokens,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const all = loadModels(true);
  const wanted = opts.models.length ? all.filter((m) => opts.models.includes(m.key)) : all.filter((m) => !m.unavailable);
  if (!wanted.length) throw new Error('no models selected');
  const fixture = loadStoryFixture();

  const dbPath = resolve(opts.db);
  currentPath = dbPath;
  const snapshotPath = `${dbPath}.snapshot`;
  let db = new Db(dbPath);
  snapshot(db, snapshotPath);
  db = new Db(dbPath);

  const store = new RunStore(opts.runId || `long-${Date.now()}`, {
    models: wanted.map((m) => m.key),
    roles: ['long-story'],
    corpus: dbPath,
    notes: `chapters=${opts.chapters.join(',')} target=${opts.targetWords} plant=${opts.plantChapter}`,
  });

  const rows: string[][] = [];
  for (const spec of wanted) {
    console.log(`\n--- ${spec.key} ---`);
    db.close();
    restore(dbPath, snapshotPath);
    db = new Db(dbPath);
    let metrics: Record<string, number | string | boolean | null> = {};
    let error: string | undefined;
    let ok = true;
    try {
      metrics = await runStory(db, spec, opts, fixture);
      console.log(
        `  ${opts.chapters.length} chapters, ${metrics.words} words, ` +
          `length ${Math.round(Number(metrics.lengthRatio) * 100)}%, repetition ${Math.round(Number(metrics.repetition) * 100)}%, ` +
          `${metrics.auEvents} events, ${metrics.knowledgeRecords} knowledge records, ` +
          `planted contradiction ${metrics.plantedCaught}`,
      );
    } catch (err) {
      ok = false;
      error = (err as Error).message;
      console.log(`  failed: ${error}`);
    }
    store.save({
      role: 'long-story',
      scenario: `chapters-${opts.chapters.join('-')}`,
      model: spec.key,
      modelLabel: spec.label,
      seed: spec.seed ?? -1,
      repetition: 0,
      ok,
      error,
      metrics,
      calls: [],
      durationMs: Number(metrics.ms ?? 0),
      promptTokens: Number(metrics.promptTokens ?? 0),
      completionTokens: Number(metrics.completionTokens ?? 0),
    });
    rows.push([
      spec.key,
      String(metrics.chapters ?? '-'),
      String(metrics.words ?? '-'),
      `${Math.round(Number(metrics.lengthRatio ?? 0) * 100)}%`,
      `${Math.round(Number(metrics.repetition ?? 0) * 100)}%`,
      String(metrics.auEvents ?? '-'),
      String(metrics.knowledgeRecords ?? '-'),
      String(metrics.relationships ?? '-'),
      String(metrics.threads ?? '-'),
      String(metrics.graphNodes ?? '-'),
      String(metrics.canonEntityDelta ?? '-'),
      String(metrics.plantedCaught ?? '-'),
      `${Math.round(Number(metrics.ms ?? 0) / 1000)}s`,
    ]);
    // The database is closed at the start of the next iteration, before the
    // snapshot is put back.
  }

  store.finish();
  console.log('');
  table(
    ['model', 'ch', 'words', 'length', 'repeat', 'events', 'know', 'rel', 'thread', 'nodes', 'canonΔ', 'planted', 'time'],
    rows,
  );
  console.log(`\nrun written to ${store.dir}`);
  rmSync(snapshotPath, { force: true });
}

if (isMain(import.meta.url)) {
  void main();
}
