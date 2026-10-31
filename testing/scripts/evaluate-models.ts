/**
 * Model comparison.
 *
 * Runs the same scenario against several local models and writes down what
 * happened: the prompts, the outputs, the token counts, the time, and the
 * measurements. The comparison is only meaningful if the inputs are the same,
 * so the context that the models write against is assembled once, by the
 * baseline model, and handed to every candidate.
 *
 *   node testing/scripts/evaluate-models.ts --role writing
 *   node testing/scripts/evaluate-models.ts --role lore --models qwen2.5:7b,gemma4:12b
 *   node testing/scripts/evaluate-models.ts --role all --reps 2 --run my-trial-name
 *
 * Pass --run <id> to name the run yourself; without it a unique id is made.
 * An id that already exists is refused, so runs cannot overwrite each other.
 *
 * Everything is local: the models are Ollama models on this machine, and the
 * story data never leaves it.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import { isMain, loadModels, makeClient, mean, pct, repetitionSeed, RunStore, sha256File, stdev, table, uniqueRunId, type ModelSpec, type ScenarioResult } from './benchmark/harness.ts';
import { ProgressStore } from './benchmark/progress.ts';
import { loadGold, runLoreWindow, verifyGold } from './benchmark/scenarios/lore.ts';
import { runPlanning } from './benchmark/scenarios/planning.ts';
import { removeChapter, runWriting } from './benchmark/scenarios/writing.ts';
import { buildContinuityProject, runContinuity } from './benchmark/scenarios/continuity.ts';
import { runStateExtraction } from './benchmark/scenarios/state.ts';
import { BASELINE_MODEL, loadStoryFixture, baselineClient, DEFAULT_DB } from './benchmark/corpus.ts';

type Role = 'lore' | 'planning' | 'writing' | 'continuity' | 'state';

const ROLES: Role[] = ['lore', 'planning', 'writing', 'continuity', 'state'];

interface Options {
  roles: Role[];
  models: string[];
  reps: number;
  db: string;
  runId: string;
  chapter: number;
  targetWords: number;
  extractTokens: number;
  progressRun: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    roles: [],
    models: [],
    reps: 1,
    db: process.env.FANFABLE_DB ?? DEFAULT_DB,
    runId: '',
    chapter: 1,
    targetWords: 1500,
    extractTokens: 3000,
    progressRun: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--role') opts.roles.push(argv[++i] as Role);
    else if (arg === '--models') opts.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--reps') opts.reps = Number(argv[++i]);
    else if (arg === '--db') opts.db = argv[++i];
    else if (arg === '--run') opts.runId = argv[++i];
    else if (arg === '--chapter') opts.chapter = Number(argv[++i]);
    else if (arg === '--target-words') opts.targetWords = Number(argv[++i]);
    else if (arg === '--extract-tokens') opts.extractTokens = Number(argv[++i]);
    else if (arg === '--progress-run') opts.progressRun = argv[++i];
  }
  if (!opts.roles.length) opts.roles = ['all' as Role];
  if (opts.roles.some((r) => (r as string) === 'all')) opts.roles = [...ROLES];
  return opts;
}

function label(spec: ModelSpec): string {
  return spec.label;
}

/* ------------------------------------------------------------------- roles */

async function runLoreRole(
  db: Db,
  models: ModelSpec[],
  store: RunStore,
  opts: Options,
): Promise<void> {
  const hp = controller.getProjectByName(db, 'bench-hp');
  if (!hp) throw new Error('no bench-hp project: run testing/scripts/benchmark/corpus.ts first');
  const gold = loadGold();

  const problems = verifyGold(db, hp.id, gold);
  if (problems.length) {
    console.error('the gold set does not verify against the corpus:');
    for (const p of problems) console.error(`  ${p}`);
    throw new Error('gold set is broken; refusing to score');
  }
  console.log(`gold set verified: ${gold.windows.length} windows, ${gold.windows.reduce((a, w) => a + w.relations.length, 0)} relations`);

  for (const spec of models) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const seed = repetitionSeed(spec.seed, rep);
      const client = seed === undefined ? makeClient(spec) : makeClient(spec, { seed });
      const windows: Awaited<ReturnType<typeof runLoreWindow>>['result'][] = [];
      const details: string[] = [];
      let ok = true;
      let error: string | undefined;
      const started = Date.now();
      try {
        for (const w of gold.windows) {
          const { result } = await runLoreWindow(db, client, hp.id, w, spec.key, opts.extractTokens);
          windows.push(result);
          details.push(
            `${w.id}: ${result.matched}/${result.gold} matched, ${result.extracted} extracted ` +
              `(${result.unmatched} unmatched), ${result.fabricatedQuotes} fabricated, ` +
              `${result.unbacked} unbacked, ${(result.ms / 1000).toFixed(1)}s`,
          );
        }
      } catch (err) {
        ok = false;
        error = (err as Error).message;
      }
      const durationMs = Date.now() - started;
      const avg = (f: (r: (typeof windows)[number]) => number) => mean(windows.map(f)) ?? 0;
      const sum = (f: (r: (typeof windows)[number]) => number) =>
        windows.reduce((a, r) => a + f(r), 0);
      const result: ScenarioResult = {
        role: 'lore',
        scenario: 'extraction',
        model: spec.key,
        modelLabel: spec.label,
        seed: seed ?? -1,
        repetition: rep,
        ok,
        error,
        metrics: {
          recall: avg((r) => r.recall),
          precision: avg((r) => r.precision),
          goldRelations: gold.windows.reduce((a, w) => a + w.relations.length, 0),
          matched: sum((r) => r.matched),
          extracted: sum((r) => r.extracted),
          unmatched: sum((r) => r.unmatched),
          fabricatedQuotes: sum((r) => r.fabricatedQuotes),
          unbacked: sum((r) => r.unbacked),
          quoted: sum((r) => r.quoted),
          duplicates: sum((r) => r.duplicates),
          nameAccuracy: avg((r) => r.nameAccuracy),
          canonicalNameRate: avg((r) => r.canonicalNameRate),
          windows: windows.length,
          msPerWindow: avg((r) => r.ms),
          // Calls that never completed. A window whose call failed produces no
          // relations, which is not the same as a window that produced none.
          failedCalls: client.calls.filter((c) => c.error).length,
          totalCalls: client.calls.length,
          reversed: sum((r) => r.reversed),
          directionalChecked: sum((r) => r.directionalChecked),
          directionalCorrect: sum((r) => r.directionalCorrect),
        },
        // The per-window detail is kept in the artefact so the aggregate can be
        // checked against the windows it came from.
        calls: client.calls,
        durationMs,
        promptTokens: client.promptTokens,
        completionTokens: client.completionTokens,
      };
      store.save({ ...result, artefact: details.join('\n') });
      console.log(`  ${spec.key}: ${ok ? 'ok' : `failed (${error})`}`);
      for (const d of details) console.log(`    ${d}`);
    }
  }
}

async function runPlanningRole(
  db: Db,
  models: ModelSpec[],
  store: RunStore,
  opts: Options,
): Promise<void> {
  const fixture = loadStoryFixture();
  const project = controller.getProjectByName(db, fixture.project);
  if (!project) throw new Error('no story project: run testing/scripts/benchmark/corpus.ts first');

  for (const spec of models) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const seed = repetitionSeed(spec.seed, rep);
      const client = seed === undefined ? makeClient(spec) : makeClient(spec, { seed });
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      let metrics: Record<string, number | string | boolean | null | string[]> = {};
      let artefact = '';
      try {
        const { result, outline, raw } = await runPlanning(db, client, project.id, {
          premise: fixture.premise,
          divergence: fixture.divergence,
          chapterCount: 6,
          preferences: fixture.preferences,
        });
        metrics = { ...result };
        artefact = raw;
        void outline;
      } catch (err) {
        ok = false;
        error = (err as Error).message;
      }
      const durationMs = Date.now() - started;
      store.save({
        role: 'planning',
        scenario: 'outline',
        model: spec.key,
        modelLabel: spec.label,
        seed: seed ?? -1,
        repetition: rep,
        ok,
        error,
        metrics,
        artefact,
        calls: client.calls,
        durationMs,
        promptTokens: client.promptTokens,
        completionTokens: client.completionTokens,
      });
      console.log(`  ${spec.key}: ${ok ? 'ok' : `failed (${error})`}`);
    }
  }
}

async function runWritingRole(
  db: Db,
  models: ModelSpec[],
  store: RunStore,
  opts: Options,
  progress?: ProgressStore,
): Promise<void> {
  const fixture = loadStoryFixture();
  const project = controller.getProjectByName(db, fixture.project);
  if (!project) throw new Error('no story project: run testing/scripts/benchmark/corpus.ts first');
  const outline = planner.approvedOutline(db, project.id);
  if (!outline) throw new Error('the story has no approved outline');
  const chapter = outline.chapters.find((c) => c.number === opts.chapter);
  if (!chapter) throw new Error(`no chapter ${opts.chapter} in the outline`);

  const samplesThisRun = models.length * opts.reps;
  let samplesDone = 0;
  let samplesFailed = 0;
  progress?.startStage('writing-paired', {
    total: samplesThisRun,
    addTotal: true,
    unit: 'samples',
    detail: `${samplesThisRun} paired writer samples in this run; assembling the shared context`,
  });

  // The context is assembled once, by the baseline model, and given to every
  // candidate unchanged.
  const contextLlm = baselineClient();
  console.log('  assembling the shared context with the baseline model');
  const bundle = await controller.assembleContext(db, contextLlm, project.id, {
    chapter,
    chapterNumber: opts.chapter,
  });
  const sourceText = db
    .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', project.id)
    .map((r) => r.text)
    .join('\n');

  for (const spec of models) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const seed = repetitionSeed(spec.seed, rep);
      const client = seed === undefined ? makeClient(spec) : makeClient(spec, { seed });
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      let metrics: Record<string, number | string | boolean | null | string[]> = {};
      let artefact = '';
      try {
        const { result, body } = await runWriting(db, client, contextLlm, project.id, {
          chapterNumber: opts.chapter,
          chapter,
          bundle,
          targetWords: opts.targetWords,
          sourceText,
        });
        metrics = { ...result };
        artefact = body;
      } catch (err) {
        ok = false;
        error = (err as Error).message;
      }
      const durationMs = Date.now() - started;
      // The chapter must not survive into the next model's run.
      removeChapter(db, project.id, opts.chapter);
      store.save({
        role: 'writing',
        scenario: `chapter-${opts.chapter}`,
        model: spec.key,
        modelLabel: spec.label,
        seed: seed ?? -1,
        repetition: rep,
        ok,
        error,
        metrics,
        artefact,
        calls: client.calls,
        durationMs,
        promptTokens: client.promptTokens,
        completionTokens: client.completionTokens,
      });
      console.log(
        `  ${spec.key}: ${ok ? 'ok' : `failed (${error})`} ` +
          `${ok ? `words ${metrics.words}/${metrics.target}, repetition ${pct(Number(metrics.repetition))}, outline ${pct(Number(metrics.sceneCoverage))}` : ''}`,
      );
      samplesDone++;
      if (!ok) {
        samplesFailed++;
        progress?.recordError('writing-paired', error ?? 'writer sample failed');
      }
      progress?.advance(
        'writing-paired',
        1,
        `${samplesDone}/${samplesThisRun} samples in this run; ${samplesFailed} failed`,
      );
    }
  }
  progress?.completeStage(
    'writing-paired',
    `${samplesDone}/${samplesThisRun} samples in this run; ${samplesFailed} failed`,
  );
}

async function runContinuityRole(
  db: Db,
  models: ModelSpec[],
  store: RunStore,
  opts: Options,
): Promise<void> {
  // The state is built once; the checker does not change it, so every model
  // is given exactly the same story to check.
  const state = buildContinuityProject(db);

  for (const spec of models) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const seed = repetitionSeed(spec.seed, rep);
      const client = seed === undefined ? makeClient(spec) : makeClient(spec, { seed });
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      let metrics: Record<string, number | string | boolean | null | string[]> = {};
      let artefact = '';
      try {
        const { result, issues } = await runContinuity(db, client, state);
        metrics = { ...result };
        artefact = issues.map((i) => `[${i.severity}/${i.category}] ${i.message}`).join('\n');
      } catch (err) {
        ok = false;
        error = (err as Error).message;
      }
      const durationMs = Date.now() - started;
      store.save({
        role: 'continuity',
        scenario: 'planted-contradictions',
        model: spec.key,
        modelLabel: spec.label,
        seed: seed ?? -1,
        repetition: rep,
        ok,
        error,
        metrics,
        artefact,
        calls: client.calls,
        durationMs,
        promptTokens: client.promptTokens,
        completionTokens: client.completionTokens,
      });
      console.log(
        `  ${spec.key}: ${ok ? 'ok' : `failed (${error})`} ` +
          `${ok ? `found ${metrics.detected}/${metrics.planted}, ${metrics.falsePositives} false positives` : ''}`,
      );
    }
  }
}

async function runStateRole(
  db: Db,
  models: ModelSpec[],
  store: RunStore,
  opts: Options,
): Promise<void> {
  const fixture = loadStoryFixture();
  const project = controller.getProjectByName(db, fixture.project);
  if (!project) throw new Error('no story project: run testing/scripts/benchmark/corpus.ts first');

  for (const spec of models) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const seed = repetitionSeed(spec.seed, rep);
      const client = seed === undefined ? makeClient(spec) : makeClient(spec, { seed });
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      let metrics: Record<string, number | string | boolean | null | string[]> = {};
      let artefact = '';
      try {
        const { result, extraction } = await runStateExtraction(db, client, project.id, 0);
        metrics = { ...result };
        artefact = JSON.stringify(extraction, null, 2);
      } catch (err) {
        ok = false;
        error = (err as Error).message;
      }
      const durationMs = Date.now() - started;
      store.save({
        role: 'state',
        scenario: 'state-extraction',
        model: spec.key,
        modelLabel: spec.label,
        seed: seed ?? -1,
        repetition: rep,
        ok,
        error,
        metrics,
        artefact,
        calls: client.calls,
        durationMs,
        promptTokens: client.promptTokens,
        completionTokens: client.completionTokens,
      });
      console.log(
        `  ${spec.key}: ${ok ? 'ok' : `failed (${error})`} ` +
          `${ok ? `events ${metrics.eventsFound}/${metrics.events}, knowledge ${metrics.knowledgeFound}/${metrics.knowledge}, threads ${metrics.threadsFound}/${metrics.threads}` : ''}`,
      );
    }
  }
}

/* ------------------------------------------------------------------- report */

function report(store: RunStore, roles: Role[]): void {
  const { results } = RunStore.load(store.meta.runId);
  for (const role of roles) {
    const rows = results.filter((r) => r.role === role);
    if (!rows.length) continue;
    console.log(`\n=== ${role} ===`);
    const models = [...new Set(rows.map((r) => r.model))];
    const metricNames = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))].filter(
      (k) => !['title', 'chapter', 'words', 'target', 'detectedIds', 'missedIds', 'falsePositiveList', 'inventedNameList'].includes(k),
    );
    const tableRows: string[][] = [];
    for (const model of models) {
      const mine = rows.filter((r) => r.model === model && r.ok);
      const cells: string[] = [model];
      for (const metric of metricNames) {
        const values = mine.map((r) => Number(r.metrics[metric])).filter((n) => Number.isFinite(n));
        const m = mean(values);
        const sd = stdev(values);
        cells.push(
          m === null
            ? '-'
            : values.length < 2
              ? `${m.toFixed(3)} (n=${values.length})`
              : `${m.toFixed(3)} ± ${sd!.toFixed(3)} (n=${values.length})`,
        );
      }
      cells.push(`${(mine.reduce((a, r) => a + r.durationMs, 0) / 1000).toFixed(1)}s`);
      tableRows.push(cells);
    }
    table(['model', ...metricNames, 'time'], tableRows);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const all = loadModels(true);
  const wanted = opts.models.length ? all.filter((m) => opts.models.includes(m.key)) : all.filter((m) => !m.unavailable);
  if (!wanted.length) throw new Error('no models selected');

  const db = new Db(opts.db);
  // Checkpoint before hashing so a WAL sidecar cannot be mistaken for part of
  // an undocumented input. This records the exact corpus state the run reads.
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const fixture = loadStoryFixture();
  const storyProject = controller.getProjectByName(db, fixture.project);
  const sourceTextSha256 = storyProject
    ? db
        .all<{ sha256: string }>(
          'SELECT DISTINCT sha256 FROM canon_source WHERE project_id = ? ORDER BY sha256',
          storyProject.id,
        )
        .map((row) => row.sha256)
    : [];
  const fixturePath = resolve(import.meta.dirname, '../../testing/benchmarks/fixtures/story.json');
  const modelsPath = resolve(import.meta.dirname, '../../testing/benchmarks/fixtures/models.json');
  const corpusManifestPath = `${resolve(opts.db)}.manifest.json`;
  const codeHashes = Object.fromEntries(
    [
      ['corpusBuilder', resolve(import.meta.dirname, './benchmark/corpus.ts')],
      ['modelRunner', resolve(import.meta.dirname, './evaluate-models.ts')],
      ['runHarness', resolve(import.meta.dirname, './benchmark/harness.ts')],
      ['loreExtractor', resolve(import.meta.dirname, '../../fanfable/src/lorebook.ts')],
      ['llmClient', resolve(import.meta.dirname, '../../fanfable/src/core/llm.ts')],
      ['databaseSchema', resolve(import.meta.dirname, '../../fanfable/src/core/schema.ts')],
      ['contextBuilder', resolve(import.meta.dirname, '../../fanfable/src/plan/controller.ts')],
      ['writerScenario', resolve(import.meta.dirname, './benchmark/scenarios/writing.ts')],
    ].map(([key, path]) => [key!, sha256File(path!)]),
  );
  const modelSettings = wanted.map((spec) => ({
    key: spec.key,
    provider: spec.provider,
    model: spec.model,
    seed: spec.seed ?? null,
    contextTokens: spec.contextTokens ?? null,
    maxTokens: spec.maxTokens ?? null,
    temperature: spec.temperature ?? null,
    system: spec.system ?? null,
    think: spec.think ?? null,
  }));
  const store = new RunStore(opts.runId || uniqueRunId('run'), {
    models: wanted.map((m) => m.key),
    roles: opts.roles,
    corpus: opts.db,
    notes: `reps=${opts.reps} chapter=${opts.chapter} target=${opts.targetWords} extractTokens=${opts.extractTokens}`,
    details: {
      baselineModel: BASELINE_MODEL,
      baselineContext: { provider: 'ollama', seed: 42, contextTokens: 8192 },
      corpusFileSha256: opts.db === ':memory:' ? null : sha256File(opts.db),
      sourceTextSha256,
      storyFixtureSha256: sha256File(fixturePath),
      modelRegistrySha256: sha256File(modelsPath),
      corpusManifestPath: existsSync(corpusManifestPath) ? corpusManifestPath : null,
      corpusManifestSha256: existsSync(corpusManifestPath) ? sha256File(corpusManifestPath) : null,
      codeSha256: codeHashes,
      modelSettings,
      options: {
        roles: opts.roles,
        models: wanted.map((m) => m.key),
        repetitions: opts.reps,
        chapter: opts.chapter,
        targetWords: opts.targetWords,
        extractTokens: opts.extractTokens,
        repetitionSeedStrategy: 'model base seed + zero-based repetition index',
      },
    },
  });

  const progress = ProgressStore.open(opts.progressRun || store.meta.runId);
  try {
    for (const role of opts.roles) {
      console.log(`\n--- ${role} ---`);
      if (role === 'lore') await runLoreRole(db, wanted, store, opts);
      if (role === 'planning') await runPlanningRole(db, wanted, store, opts);
      if (role === 'writing') await runWritingRole(db, wanted, store, opts, progress);
      if (role === 'continuity') await runContinuityRole(db, wanted, store, opts);
      if (role === 'state') await runStateRole(db, wanted, store, opts);
    }
  } catch (err) {
    progress.failActive((err as Error).message);
    throw err;
  }

  store.finish();
  report(store, opts.roles);
  console.log(`\nrun written to ${store.dir}`);
  db.close();
}

if (isMain(import.meta.url)) {
  void main();
}
