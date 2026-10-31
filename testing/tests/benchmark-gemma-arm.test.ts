import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, nowIso } from '../../fanfable/src/core/db.ts';
import { MockProvider } from '../../fanfable/src/core/llm.ts';
import {
  GEMMA_EXTRACTOR_MODEL,
  buildGemmaExtractionArm,
} from '../scripts/benchmark/build-gemma-extraction-arm.ts';
import { loadStoryFixture } from '../scripts/benchmark/corpus.ts';
import { sha256File } from '../scripts/benchmark/harness.ts';
import { ProgressStore, readProgress } from '../scripts/benchmark/progress.ts';

const SOURCE_SHA = 'a'.repeat(64);
const QWEN_MANIFEST = { manifestVersion: 1, baselineModel: 'qwen2.5:7b' };

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `fanfable-gemma-arm-${name}-`));
}

/** A small stand-in for the pinned Qwen corpus: source, story state and old extractor rows. */
function makeSourceCorpus(path: string, options: { outline?: boolean } = {}): void {
  const fixture = loadStoryFixture();
  const ts = nowIso();
  const db = new Db(path);
  try {
    db.run(
      "INSERT INTO project (id, name, created_at, updated_at, settings) VALUES (1, 'bench-hp', ?, ?, '{}')",
      ts,
      ts,
    );
    db.run(
      'INSERT INTO project (id, name, created_at, updated_at, settings) VALUES (2, ?, ?, ?, ?)',
      fixture.project,
      ts,
      ts,
      '{}',
    );
    db.run(
      `INSERT INTO canon_source (id, project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
       VALUES (10, 2, '/tmp/mock-book.pdf', 'Mock Book', '', 'pdf', ?, 128, 1, ?)`,
      SOURCE_SHA,
      ts,
    );
    db.run(
      `INSERT INTO canon_chunk (id, source_id, project_id, seq, locator, heading, text, char_start, char_end, words,
                                page_start, page_end, lore_mined)
       VALUES (100, 10, 2, 0, 'p1', '', 'Alice met Bob at the castle. She gave him a map.', 0, 47, 11, 1, 1, 1)`,
    );
    db.run(
      `INSERT INTO canon_chunk (id, source_id, project_id, seq, locator, heading, text, char_start, char_end, words,
                                page_start, page_end, lore_mined)
       VALUES (101, 10, 2, 1, 'p1', '', 'The castle stood above the lake.', 48, 80, 7, 1, 1, 1)`,
    );

    // Old extractor output for the story project.
    db.run(
      `INSERT INTO canon_entity (id, project_id, kind, name, summary, created_at, updated_at)
       VALUES (200, 2, 'character', 'Old Entity', '', ?, ?)`,
      ts,
      ts,
    );
    db.run(
      `INSERT INTO canon_entity (id, project_id, kind, name, summary, created_at, updated_at)
       VALUES (201, 2, 'location', 'Old Place', '', ?, ?)`,
      ts,
      ts,
    );
    db.run(
      `INSERT INTO canon_relation (id, project_id, from_entity, to_entity, kind, description, created_at)
       VALUES (300, 2, 200, 201, 'lives in', 'old relation', ?)`,
      ts,
    );
    db.run(
      `INSERT INTO canon_fact (id, project_id, topic, statement, created_at)
       VALUES (400, 2, 'old topic', 'old fact', ?)`,
      ts,
    );
    db.run(
      `INSERT INTO canon_timeline (id, project_id, seq, title, created_at) VALUES (500, 2, 0, 'Old Timeline', ?)`,
      ts,
    );
    db.run(
      `INSERT INTO canon_event (id, project_id, source_id, chunk_id, title, created_at)
       VALUES (600, 2, 10, 100, 'Old Event', ?)`,
      ts,
    );
    db.run("INSERT INTO canon_event_participant (canon_event_id, entity_id, role) VALUES (600, 200, 'participant')");

    // Another project's extractor rows must not be touched.
    db.run(
      `INSERT INTO canon_entity (id, project_id, kind, name, summary, created_at, updated_at)
       VALUES (210, 1, 'character', 'Other Project Entity', '', ?, ?)`,
      ts,
      ts,
    );
    db.run(
      `INSERT INTO canon_event (id, project_id, source_id, chunk_id, title, created_at)
       VALUES (610, 1, 10, 100, 'Other Project Event', ?)`,
      ts,
    );
    db.run("INSERT INTO canon_event_participant (canon_event_id, entity_id, role) VALUES (610, 210, 'participant')");

    if (options.outline !== false) {
      db.run(
        `INSERT INTO outline (id, project_id, version, status, premise, divergence, chapters, preferences,
                              created_at, updated_at, approved_at)
         VALUES (700, 2, 1, 'approved', 'premise', 'divergence', '[]', '{}', ?, ?, ?)`,
        ts,
        ts,
        ts,
      );
    }
    db.run(
      `INSERT INTO chapter (id, project_id, number, title, status, outline_id, body, summary, word_count,
                            created_at, updated_at, approved_at)
       VALUES (701, 2, 0, 'Prologue', 'approved', ${options.outline === false ? 'NULL' : '700'},
               'Once upon a time.', 'summary', 4, ?, ?, ?)`,
      ts,
      ts,
      ts,
    );

    // Story state that must survive the wipe.
    db.run(
      `INSERT INTO character (id, project_id, name, canon_entity_id, created_at, updated_at)
       VALUES (800, 2, 'Alice', 200, ?, ?)`,
      ts,
      ts,
    );
    db.run(
      `INSERT INTO story_fact (id, project_id, kind, subject, content, canon_event_id, created_at)
       VALUES (900, 2, 'decision', 'Alice', 'Alice keeps the map.', 600, ?)`,
      ts,
    );
  } finally {
    db.close();
  }
  writeFileSync(`${path}.manifest.json`, JSON.stringify(QWEN_MANIFEST, null, 2) + '\n');
}

/** Offline extractor: one entity from lore, one event from the canon-event pass. */
function mockExtractor(): MockProvider {
  const provider = new MockProvider();
  provider.handler = (req) => {
    if ((req.system ?? '').includes('narrative events')) {
      return JSON.stringify([
        {
          title: 'Mock Event',
          summary: 'Alice reads the map.',
          participants: ['Mock Entity'],
          location: 'Castle',
          time_label: 'Day 1',
          kind: 'scene',
          chunk_index: 0,
        },
      ]);
    }
    return JSON.stringify({
      entities: [
        {
          name: 'Mock Entity',
          kind: 'character',
          summary: 'A mock person.',
          chunk_index: 0,
          evidence: 'Alice met Bob at the castle',
        },
      ],
      relations: [],
      facts: [],
      timeline: [],
    });
  };
  return provider;
}

test('the Gemma arm refuses an existing target database or manifest', async () => {
  const root = tempDir('refuse');
  try {
    const src = join(root, 'src.db');
    makeSourceCorpus(src);
    const target = join(root, 'clone.db');
    writeFileSync(target, 'occupied');

    await assert.rejects(
      () => buildGemmaExtractionArm(src, target, { llm: mockExtractor() }),
      /refusing to reuse existing corpus files/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'occupied');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Gemma arm preserves story state and replaces the six extractor tables', async () => {
  const root = tempDir('clone');
  try {
    const src = join(root, 'src.db');
    makeSourceCorpus(src);
    const target = join(root, 'clone.db');
    const progressRoot = join(root, 'runs');
    const progress = ProgressStore.open('gemma-arm-progress', { root: progressRoot });

    const built = await buildGemmaExtractionArm(src, target, { llm: mockExtractor(), progress });
    assert.equal(built.dbPath, target);
    assert.equal(built.manifestPath, `${target}.manifest.json`);
    // Hash before reopening: constructing a Db writes schema_meta/journal state.
    const databaseSha256 = sha256File(target);

    const db = new Db(target);
    try {
      const chapter = db.get<{ body: string; status: string }>(
        'SELECT body, status FROM chapter WHERE project_id = 2 AND number = 0',
      )!;
      assert.equal(chapter.body, 'Once upon a time.');
      assert.equal(chapter.status, 'approved');
      assert.equal(
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outline WHERE project_id = 2 AND status = 'approved'")?.n,
        1,
      );
      assert.equal(db.get<{ sha256: string }>('SELECT sha256 FROM canon_source WHERE project_id = 2')?.sha256, SOURCE_SHA);

      const chunks = db.all<{ text: string; lore_mined: number }>(
        'SELECT text, lore_mined FROM canon_chunk WHERE project_id = 2 ORDER BY seq',
      );
      assert.deepEqual(
        chunks.map((c) => c.text),
        ['Alice met Bob at the castle. She gave him a map.', 'The castle stood above the lake.'],
      );
      assert.deepEqual(chunks.map((c) => c.lore_mined), [1, 1]);

      const entities = db.all<{ name: string }>('SELECT name FROM canon_entity WHERE project_id = 2 ORDER BY name');
      assert.deepEqual(entities.map((e) => e.name), ['Mock Entity']);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = 2')?.n, 0);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = 2')?.n, 0);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_timeline WHERE project_id = 2')?.n, 0);
      const events = db.all<{ title: string }>('SELECT title FROM canon_event WHERE project_id = 2');
      assert.deepEqual(events.map((e) => e.title), ['Mock Event']);
      assert.equal(
        db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM canon_event_participant WHERE canon_event_id IN ' +
            '(SELECT id FROM canon_event WHERE project_id = 2)',
        )?.n,
        0,
      );

      // Story rows and the other project's extractor rows survive.
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM character WHERE name = 'Alice'")?.n, 1);
      assert.equal(
        db.get<{ content: string }>('SELECT content FROM story_fact WHERE id = 900')?.content,
        'Alice keeps the map.',
      );
      assert.equal(
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_entity WHERE name = 'Other Project Entity'")?.n,
        1,
      );
      assert.equal(
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_event WHERE title = 'Other Project Event'")?.n,
        1,
      );
      assert.equal(
        db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_event_participant WHERE canon_event_id = 610')?.n,
        1,
      );
    } finally {
      db.close();
    }

    const manifest = JSON.parse(readFileSync(built.manifestPath, 'utf8')) as Record<string, any>;
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.extractorModel, GEMMA_EXTRACTOR_MODEL);
    assert.equal(manifest.clonedFrom.manifestSha256, sha256File(`${src}.manifest.json`));
    assert.equal(manifest.sourceTextSha, SOURCE_SHA);
    assert.deepEqual(manifest.storyState.chapterNumbers, [{ number: 0, status: 'approved', word_count: 4 }]);
    assert.deepEqual(manifest.lore, { entities: 1, relations: 0, facts: 0, timelineRows: 0, events: 1 });
    assert.deepEqual(manifest.buildConfig, { loreConcurrency: 3, eventChunkLimit: 500, maxEvents: 300 });
    assert.match(manifest.codeSha256.gemmaArmBuilder, /^[0-9a-f]{64}$/);
    assert.equal(manifest.databaseSha256, databaseSha256);

    const state = readProgress('gemma-arm-progress', progressRoot)!;
    const stage = state.stages.find((row) => row.key === 'extract-gemma')!;
    assert.equal(stage.status, 'done');
    assert.equal(stage.completed, stage.total);
    assert.equal(stage.total, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Gemma arm fails before extraction when the clone has no approved outline', async () => {
  const root = tempDir('no-outline');
  try {
    const src = join(root, 'src.db');
    makeSourceCorpus(src, { outline: false });
    const target = join(root, 'clone.db');

    await assert.rejects(
      () => buildGemmaExtractionArm(src, target, { llm: mockExtractor() }),
      /no approved outline/,
    );

    const db = new Db(target);
    try {
      // The failure happened before the wipe, so the copied extractor rows are still there.
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_entity WHERE name = 'Old Entity'")?.n, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
