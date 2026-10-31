/** Build an isolated, provenance-recorded corpus for a new benchmark.
 *
 *   FANFABLE_BASELINE_MODEL=qwen2.5:7b node testing/scripts/benchmark/build-fresh-corpus.ts <new-db-path>
 *
 * Existing databases are never reused or overwritten. A failed build leaves
 * its partial database in place for inspection; choose a new path to retry.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../../../fanfable/src/db.ts';
import { isMain, sha256File } from './harness.ts';
import { extractionStageFor, ProgressStore } from './progress.ts';
import {
  BASELINE_MODEL,
  BOOK_PATH,
  baselineClient,
  ensureBook,
  ensureLore,
  ensureOutline,
  ensurePrologue,
  loadStoryFixture,
  type LoreWindowProgress,
} from './corpus.ts';

export function assertFreshCorpusTarget(dbPath: string): { dbPath: string; manifestPath: string } {
  if (!dbPath || dbPath === ':memory:') throw new Error('a persistent new database path is required');
  const target = resolve(dbPath);
  const manifestPath = `${target}.manifest.json`;
  const existing = [target, `${target}-wal`, `${target}-shm`, manifestPath].filter((path) => existsSync(path));
  if (existing.length) {
    throw new Error(`refusing to reuse existing corpus files: ${existing.join(', ')}; choose a new database path`);
  }
  return { dbPath: target, manifestPath };
}

function count(db: Db, table: string, projectId: number): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0;
}

export interface BuildFreshCorpusOptions {
  /** Optional lifecycle monitor; progress files live in its run directory. */
  progress?: ProgressStore;
}

export async function buildFreshCorpus(
  dbPath: string,
  options: BuildFreshCorpusOptions = {},
): Promise<{ dbPath: string; manifestPath: string; manifest: object }> {
  if (BASELINE_MODEL !== 'qwen2.5:7b') {
    throw new Error(`the clean baseline build requires qwen2.5:7b; effective FANFABLE_BASELINE_MODEL is "${BASELINE_MODEL}"`);
  }
  const target = assertFreshCorpusTarget(dbPath);
  const fixture = loadStoryFixture();
  const db = new Db(target.dbPath);
  const progress = options.progress;
  const extractionKey = extractionStageFor(BASELINE_MODEL);
  let manifest: Record<string, unknown>;
  try {
    progress?.startStage('corpus-source', {
      total: 2,
      unit: 'projects',
      detail: 'importing the source into the source-only and story projects',
    });
    const llm = baselineClient();
    const sourceOnlyProjectId = await ensureBook(db, 'bench-hp');
    progress?.advance('corpus-source', 1, 'source-only project imported');
    const storyProjectId = await ensureBook(db, fixture.project);
    progress?.advance('corpus-source', 1, 'story project imported');
    progress?.completeStage('corpus-source', 'source imported into two projects');

    progress?.startStage(extractionKey, {
      unit: 'windows',
      detail: 'lore extraction; the extractor reports its window counts',
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
    await ensureLore(db, storyProjectId, llm, false, onWindow);
    ensureOutline(db, storyProjectId, fixture);
    progress?.setCounts(extractionKey, {
      completed: loreDone + eventDone,
      total: loreTotal + eventTotal,
      unit: 'windows',
      detail:
        `lore ${loreDone}/${loreTotal || '?'} windows; canon events ${eventDone}/${eventTotal || '?'} windows; ` +
        'outline approved; writing the prologue',
    });
    await ensurePrologue(db, llm, storyProjectId, fixture);
    progress?.completeStage(
      extractionKey,
      `lore ${loreDone}/${loreTotal || '?'} windows; canon events ${eventDone}/${eventTotal || '?'} windows; ` +
        'prologue approved',
    );

    const source = db.get<{
      sha256: string;
      byte_size: number;
      page_count: number;
      title: string;
    }>(
      'SELECT sha256, byte_size, page_count, title FROM canon_source WHERE project_id = ? ORDER BY id LIMIT 1',
      storyProjectId,
    );
    const chunks = count(db, 'canon_chunk', storyProjectId);
    const minedChunks = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
      storyProjectId,
    )?.n ?? 0;
    const chapterNumbers = db
      .all<{ number: number; status: string; word_count: number }>(
        'SELECT number, status, word_count FROM chapter WHERE project_id = ? ORDER BY number',
        storyProjectId,
      );

    if (!source || !chunks || minedChunks !== chunks) {
      throw new Error(`fresh corpus incomplete: source=${Boolean(source)}, chunks=${chunks}, loreMined=${minedChunks}`);
    }
    if (chapterNumbers.length !== 1 || chapterNumbers[0]?.number !== 0 || chapterNumbers[0]?.status !== 'approved') {
      throw new Error(`fresh story state must contain only one approved prologue; found ${JSON.stringify(chapterNumbers)}`);
    }

    const now = new Date().toISOString();
    const here = import.meta.dirname;
    const scriptHashes = Object.fromEntries(
      [
        ['freshCorpusBuilder', resolve(here, './build-fresh-corpus.ts')],
        ['corpusBuilder', resolve(here, './corpus.ts')],
        ['runHarness', resolve(here, './harness.ts')],
        ['loreExtractor', resolve(here, '../../../fanfable/src/lorebook.ts')],
        ['loreStorage', resolve(here, '../../../fanfable/src/lore.ts')],
        ['fileImporter', resolve(here, '../../../fanfable/src/importer.ts')],
        ['llmClient', resolve(here, '../../../fanfable/src/llm.ts')],
        ['databaseSchema', resolve(here, '../../../fanfable/src/schema.ts')],
        ['contextBuilder', resolve(here, '../../../fanfable/src/plan/controller.ts')],
        ['writerScenario', resolve(here, './scenarios/writing.ts')],
      ].map(([key, path]) => [key!, sha256File(path!)]),
    );
    manifest = {
      manifestVersion: 1,
      builtAt: now,
      database: relative(process.cwd(), target.dbPath),
      baselineModel: BASELINE_MODEL,
      baselineSettings: { provider: 'ollama', seed: 42, contextTokens: 8192 },
      source: {
        title: source.title,
        importedTextSha256: source.sha256,
        byteSize: source.byte_size,
        pages: source.page_count,
        chunks,
        loreMinedChunks: minedChunks,
      },
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
      bookOnlyProjectId: sourceOnlyProjectId,
      buildConfig: { loreConcurrency: 3, eventChunkLimit: 500, maxEvents: 300 },
      codeSha256: scriptHashes,
    };
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    progress?.failActive((err as Error).message);
    throw err;
  } finally {
    db.close();
  }

  const completeManifest = { ...manifest!, databaseSha256: sha256File(target.dbPath) };
  writeFileSync(target.manifestPath, JSON.stringify(completeManifest, null, 2) + '\n', { flag: 'wx' });
  return { ...target, manifest: completeManifest };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dbPath = '';
  let progressRun = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--progress-run') progressRun = args[++i] ?? '';
    else if (!arg.startsWith('--') && !dbPath) dbPath = arg;
  }
  if (!dbPath) {
    throw new Error(
      'usage: FANFABLE_BASELINE_MODEL=qwen2.5:7b node testing/scripts/benchmark/build-fresh-corpus.ts <new-db-path> [--progress-run <id>]',
    );
  }
  const progress = progressRun ? ProgressStore.open(progressRun) : undefined;
  const built = await buildFreshCorpus(dbPath, { progress });
  console.log(`fresh Qwen2.5 7B corpus ready: ${relative(process.cwd(), built.dbPath)}`);
  console.log(`manifest: ${relative(process.cwd(), built.manifestPath)}`);
  console.log(JSON.stringify(built.manifest, null, 2));
}

if (isMain(import.meta.url)) void main();
