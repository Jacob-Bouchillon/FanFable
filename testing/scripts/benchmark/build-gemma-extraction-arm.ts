/** Build the Gemma extraction arm by cloning the pinned Qwen corpus and
 * re-extracting its lore and canon events with the Gemma extractor.
 *
 *   node testing/scripts/benchmark/build-gemma-extraction-arm.ts \
 *     testing/benchmarks/data/bench-qwen7-rater-pilot.db \
 *     testing/benchmarks/data/bench-gemma-extraction-<id>.db [--progress-run <id>]
 *
 * Corpus.ts `ensureLore(rebuild=true)` cannot be used for this: it deletes the
 * entity, relation, fact and timeline rows but leaves canon_event in place, and
 * then keeps any event index whose count is above zero. Here the six extractor
 * tables are cleared for the story project explicitly, while the imported
 * source, the passages, the approved outline and the story state are kept.
 *
 * The source database and its manifest are only read. The new database and its
 * manifest must not exist yet; a failed build leaves its partial database in
 * place for inspection, so choose a new path to retry.
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Db } from '../../../fanfable/src/core/db.ts';
import type { LlmClient } from '../../../fanfable/src/core/llm.ts';
import * as planner from '../../../fanfable/src/plan/planner.ts';
import { assertFreshCorpusTarget } from './build-fresh-corpus.ts';
import {
  BASELINE_MODEL,
  ensureLore,
  loadStoryFixture,
  type LoreWindowProgress,
} from './corpus.ts';
import { findModel, isMain, makeClient, sha256File } from './harness.ts';
import { extractionStageFor, ProgressStore } from './progress.ts';

/** The extractor model for the Gemma arm. It is the only model this build calls. */
export const GEMMA_EXTRACTOR_MODEL = 'gemma4:12b-it-q4_K_M';

/** Matches the fresh builder's baseline client, so the two arms differ only in the model. */
export const GEMMA_EXTRACTOR_SETTINGS = {
  provider: 'ollama' as const,
  seed: 42,
  contextTokens: 8192,
  think: false,
};

/** Fixed extraction settings, identical to buildFreshCorpus. */
export const GEMMA_BUILD_CONFIG = {
  loreConcurrency: 3,
  eventChunkLimit: 500,
  maxEvents: 300,
};

const QWEN_BASELINE = 'qwen2.5:7b';

export interface BuildGemmaArmOptions {
  /** Optional lifecycle monitor; progress files live in its run directory. */
  progress?: ProgressStore;
  /** Test seam: replace the Gemma client. Production builds use a local Ollama client. */
  llm?: LlmClient;
}

interface SourceManifest {
  baselineModel?: string;
  [key: string]: unknown;
}

/**
 * The Gemma extractor client. The model registry supplies the chat framing
 * (`merged` system message, thinking off); the context and seed match the
 * baseline client so a corpus difference comes from the model, not the wiring.
 */
export function gemmaExtractorClient(): LlmClient {
  return makeClient(findModel(GEMMA_EXTRACTOR_MODEL), {
    contextTokens: GEMMA_EXTRACTOR_SETTINGS.contextTokens,
    seed: GEMMA_EXTRACTOR_SETTINGS.seed,
    think: GEMMA_EXTRACTOR_SETTINGS.think,
  });
}

function count(db: Db, table: string, projectId: number): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0;
}

/**
 * Copy the database and any non-empty WAL sidecars. Copying only the main file
 * would drop transactions that still sit in the source WAL; copying the
 * sidecars and then checkpointing the clone keeps the clone complete without
 * writing to the source.
 */
function copyWithWal(src: string, target: string): void {
  copyFileSync(src, target);
  const wal = `${src}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    copyFileSync(wal, `${target}-wal`);
    const shm = `${src}-shm`;
    if (existsSync(shm)) copyFileSync(shm, `${target}-shm`);
  }
}

function resolveStoryProject(db: Db, projectName: string): number {
  const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
  if (!project) throw new Error(`source corpus has no project named "${projectName}"`);
  return project.id;
}

/**
 * The clone must still be the same story: an approved outline and exactly one
 * approved chapter, the prologue. Check this before spending an hour on
 * extraction.
 */
function assertStoryStateIntact(db: Db, projectId: number): void {
  if (!planner.approvedOutline(db, projectId)) {
    throw new Error('source corpus has no approved outline; refusing to build the Gemma arm');
  }
  const chapters = db
    .all<{ number: number; status: string; word_count: number }>(
      'SELECT number, status, word_count FROM chapter WHERE project_id = ? ORDER BY number',
      projectId,
    );
  if (chapters.length !== 1 || chapters[0]?.number !== 0 || chapters[0]?.status !== 'approved') {
    throw new Error(
      `source story state must contain only one approved prologue; found ${JSON.stringify(chapters)}`,
    );
  }
}

export async function buildGemmaExtractionArm(
  srcQwenDbPath: string,
  newDbPath: string,
  options: BuildGemmaArmOptions = {},
): Promise<{ dbPath: string; manifestPath: string; manifest: object }> {
  if (!srcQwenDbPath) throw new Error('a source Qwen corpus path is required');
  const target = assertFreshCorpusTarget(newDbPath);
  const srcPath = resolve(srcQwenDbPath);
  if (!existsSync(srcPath)) throw new Error(`source corpus not found: ${srcPath}`);
  const srcManifestPath = `${srcPath}.manifest.json`;
  if (!existsSync(srcManifestPath)) {
    throw new Error(`source corpus manifest not found: ${srcManifestPath}; the Qwen arm must be pinned`);
  }

  const sourceManifest = JSON.parse(readFileSync(srcManifestPath, 'utf8')) as SourceManifest;
  if (sourceManifest.baselineModel !== BASELINE_MODEL) {
    throw new Error(
      `source corpus was built with baseline "${sourceManifest.baselineModel}", but the effective baseline is ` +
        `"${BASELINE_MODEL}"; the Gemma arm must clone the ${QWEN_BASELINE} arm`,
    );
  }

  const fixture = loadStoryFixture();
  const progress = options.progress;
  // Resolve the client before copying, so a missing registry entry fails before any wipe.
  const llm = options.llm ?? gemmaExtractorClient();
  copyWithWal(srcPath, target.dbPath);

  const db = new Db(target.dbPath);
  let manifest: Record<string, unknown>;
  try {
    const storyProjectId = resolveStoryProject(db, fixture.project);
    assertStoryStateIntact(db, storyProjectId);

    const source = db.get<{
      sha256: string;
      title: string;
    }>('SELECT sha256, title FROM canon_source WHERE project_id = ? ORDER BY id LIMIT 1', storyProjectId);
    if (!source) throw new Error('source corpus has no canon source for the story project');

    // Clear the extractor output for this project only. Order follows the
    // references: participants first, then the tables that point at entities or
    // events, then the entities, then the events themselves.
    db.transaction(() => {
      db.run(
        'DELETE FROM canon_event_participant WHERE canon_event_id IN ' +
          '(SELECT id FROM canon_event WHERE project_id = ?)',
        storyProjectId,
      );
      db.run('DELETE FROM canon_relation WHERE project_id = ?', storyProjectId);
      db.run('DELETE FROM canon_fact WHERE project_id = ?', storyProjectId);
      db.run('DELETE FROM canon_timeline WHERE project_id = ?', storyProjectId);
      db.run('DELETE FROM canon_entity WHERE project_id = ?', storyProjectId);
      db.run('DELETE FROM canon_event WHERE project_id = ?', storyProjectId);
      db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', storyProjectId);
    });

    const extractionKey = extractionStageFor(GEMMA_EXTRACTOR_MODEL);
    progress?.startStage(extractionKey, {
      unit: 'windows',
      detail: 'lore extraction with the Gemma extractor; the extractor reports its window counts',
    });
    let loreDone = 0;
    let loreTotal = 0;
    let eventDone = 0;
    let eventTotal = 0;
    const onWindow = (window: LoreWindowProgress): void => {
      if (window.phase === 'lore') {
        loreDone = window.done;
        loreTotal = window.total;
      } else {
        eventDone = window.done;
        eventTotal = window.total;
      }
      progress?.setCounts(extractionKey, {
        completed: loreDone + eventDone,
        total: loreTotal + eventTotal,
        unit: 'windows',
        detail:
          `lore ${loreDone}/${loreTotal || '?'} windows; ` +
          `canon events ${eventDone}/${eventTotal || '?'} windows`,
      });
    };

    let chunks = 0;
    let minedChunks = 0;
    try {
      await ensureLore(db, storyProjectId, llm, false, onWindow);
      chunks = count(db, 'canon_chunk', storyProjectId);
      minedChunks =
        db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
          storyProjectId,
        )?.n ?? 0;
      if (!chunks || minedChunks !== chunks) {
        throw new Error(`Gemma extraction incomplete: chunks=${chunks}, loreMined=${minedChunks}`);
      }
      progress?.completeStage(
        extractionKey,
        `lore ${loreDone}/${loreTotal || '?'} windows; canon events ${eventDone}/${eventTotal || '?'} windows`,
      );
    } catch (err) {
      progress?.failStage(extractionKey, (err as Error).message);
      throw err;
    }

    const chapterNumbers = db.all<{ number: number; status: string; word_count: number }>(
      'SELECT number, status, word_count FROM chapter WHERE project_id = ? ORDER BY number',
      storyProjectId,
    );

    const here = import.meta.dirname;
    const scriptHashes = Object.fromEntries(
      [
        ['gemmaArmBuilder', resolve(here, './build-gemma-extraction-arm.ts')],
        ['corpusBuilder', resolve(here, './corpus.ts')],
        ['runHarness', resolve(here, './harness.ts')],
        ['loreExtractor', resolve(here, '../../../fanfable/src/lorebook.ts')],
        ['loreStorage', resolve(here, '../../../fanfable/src/answer/lore.ts')],
        ['llmClient', resolve(here, '../../../fanfable/src/core/llm.ts')],
        ['databaseSchema', resolve(here, '../../../fanfable/src/core/schema.ts')],
        ['contextBuilder', resolve(here, '../../../fanfable/src/plan/controller.ts')],
      ].map(([key, path]) => [key!, sha256File(path!)]),
    );

    manifest = {
      manifestVersion: 1,
      builtAt: new Date().toISOString(),
      database: relative(process.cwd(), target.dbPath),
      extractorModel: GEMMA_EXTRACTOR_MODEL,
      extractorSettings: GEMMA_EXTRACTOR_SETTINGS,
      baselineModel: BASELINE_MODEL,
      clonedFrom: {
        database: relative(process.cwd(), srcPath),
        manifest: relative(process.cwd(), srcManifestPath),
        manifestSha256: sha256File(srcManifestPath),
      },
      sourceTextSha: source.sha256,
      source: { title: source.title, chunks, loreMinedChunks: minedChunks },
      storyState: {
        fixtureSha256: sha256File(resolve(here, '../../../testing/benchmarks/fixtures/story.json')),
        modelRegistrySha256: sha256File(resolve(here, '../../../testing/benchmarks/fixtures/models.json')),
        chapterNumbers,
      },
      lore: {
        entities: count(db, 'canon_entity', storyProjectId),
        relations: count(db, 'canon_relation', storyProjectId),
        facts: count(db, 'canon_fact', storyProjectId),
        timelineRows: count(db, 'canon_timeline', storyProjectId),
        events: count(db, 'canon_event', storyProjectId),
      },
      buildConfig: GEMMA_BUILD_CONFIG,
      codeSha256: scriptHashes,
    };
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  const completeManifest = { ...manifest!, databaseSha256: sha256File(target.dbPath) };
  writeFileSync(target.manifestPath, JSON.stringify(completeManifest, null, 2) + '\n', { flag: 'wx' });
  return { ...target, manifest: completeManifest };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let srcQwenDb = '';
  let newDb = '';
  let progressRun = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--progress-run') progressRun = args[++i] ?? '';
    else if (!arg.startsWith('--') && !srcQwenDb) srcQwenDb = arg;
    else if (!arg.startsWith('--') && !newDb) newDb = arg;
  }
  if (!srcQwenDb || !newDb) {
    throw new Error(
      'usage: node testing/scripts/benchmark/build-gemma-extraction-arm.ts <srcQwenDb> <newDb> [--progress-run <overall-id>]',
    );
  }
  const progress = progressRun ? ProgressStore.open(progressRun) : undefined;
  const built = await buildGemmaExtractionArm(srcQwenDb, newDb, { progress });
  console.log(`Gemma extraction arm ready: ${relative(process.cwd(), built.dbPath)}`);
  console.log(`manifest: ${relative(process.cwd(), built.manifestPath)}`);
  console.log(JSON.stringify(built.manifest, null, 2));
}

if (isMain(import.meta.url)) void main();
