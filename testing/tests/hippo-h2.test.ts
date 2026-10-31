/**
 * Hippo H2 acceptance tests: local embedding seeds + DPR fallback.
 *
 * Fake EmbedFn only — no Ollama, no network (except one closed-port call
 * proving embedTexts degrades to undefined instead of throwing):
 *
 *   - cosine correctness (identical=1, orthogonal~0, scale-invariant)
 *   - seed merge (lexical weight wins ties, dense adds uncovered nodes)
 *   - dense seeds hit where lexical misses (synonym: "sibling" vs "brother")
 *   - fallback (empty PPR + dense passages -> passages with flag)
 *   - degradation (dead embedder -> byte-identical to lexical behavior)
 *   - backfill embeds once, skips after, isolates models
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as graph from '../../fanfable/src/support/graph.ts';
import * as embeddings from '../../fanfable/src/support/embeddings.ts';
import type { EmbedFn } from '../../fanfable/src/support/embeddings.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

/**
 * Toy vectors by keyword: synonyms share a vector, so "sibling" matches text
 * that only ever says "brother" — the case FTS5 and triple-seeding miss.
 */
function keywordEmbed(): EmbedFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      const lower = t.toLowerCase();
      if (lower.includes('sibling') || lower.includes('brother')) return [1, 0, 0];
      if (lower.includes('bridge')) return [0, 1, 0];
      return [0, 0, 1];
    });
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

test('cosine scores identical vectors 1 and orthogonal vectors 0', () => {
  assert.ok(approx(embeddings.cosine([1, 0], [1, 0]), 1), 'identical');
  assert.ok(approx(embeddings.cosine([0, 1, 0], [0, 1, 0]), 1), 'identical 3d');
  assert.ok(approx(embeddings.cosine([1, 0], [0, 1]), 0), 'orthogonal');
  assert.ok(approx(embeddings.cosine([1, 2], [2, 4]), 1), 'scale-invariant');
  assert.equal(embeddings.cosine([1, 0], [1, 0, 0]), 0, 'length mismatch');
  assert.equal(embeddings.cosine([], []), 0, 'empty');
  assert.equal(embeddings.cosine([0, 0], [1, 0]), 0, 'zero vector');
});

/** A brother-chain project: chunks, two entities, one triple. */
function brotherProject(dbName: string) {
  const { db } = tempDb();
  const project = seedProject(db, dbName);
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  const [c0, c1] = chunks;
  const aids = new Map<string, number>();
  for (const [name, chunk] of [
    ['Astra', c0],
    ['Bram', c0],
  ] as [string, { id: number; locator: string }][]) {
    aids.set(
      name,
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project.id,
        'character',
        name,
        `${name} appears here.`,
        JSON.stringify([{ source: 'sample', locator: chunk!.locator, chunk: chunk!.id }]),
        AT,
        AT,
      ).lastInsertRowid,
    );
  }
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    aids.get('Astra')!,
    aids.get('Bram')!,
    'sister of',
    'Bram is the brother here.',
    AT,
  );
  return { db, project, chunks: [c0!, c1!] };
}

test('lexical weight wins ties and dense adds uncovered nodes', () => {
  const { merged, added } = graph.mergeSeedWeights(new Map([['a', 1]]), [
    { id: 'a', w: 0.8 },
    { id: 'b', w: 0.8 },
  ]);
  assert.equal(merged.get('a'), 1, 'the lexical 1.0 survives the dense 0.8');
  assert.equal(merged.get('b'), 0.8, 'the uncovered node is added');
  assert.equal(added, 1, 'only genuinely new ids count');
});

test('dense seeds hit a synonym the lexical path misses', async () => {
  const { db, project } = brotherProject('h2-synonym');
  const backfill = await embeddings.embedBackfill(db, project.id, {
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    embedFn: keywordEmbed(),
  });
  assert.ok(backfill.embedded > 0, 'the fake backfills rows');

  const g = graph.loadGraph(db, project.id);
  // The query says "sibling"; nothing stored says "sibling" — only "brother".
  const lexical = graph.resolveQuerySeeds(g, "who is Astra's sibling", ['Astra']);
  assert.equal(lexical.via, 'entity', 'no triple matches without the word');

  const dense = await graph.resolveDenseSeeds(db, project.id, g, "who is Astra's sibling", {
    embedFn: keywordEmbed(),
    model: 'fake',
  });
  const seedIds = dense.seeds.map((s) => s.id);
  assert.ok(seedIds.includes('canon:entity:1') || seedIds.includes('canon:entity:2'), 'a triple endpoint seeds dense');
  assert.ok(
    dense.seeds.every((s) => s.w === 0.8),
    'triple/entity seeds weigh 0.8',
  );
  assert.ok(dense.passages.length > 0, 'the brother passage seeds dense');
  db.close();
});

test('empty PPR falls back to dense passages with the flag', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'h2-fallback');
  // Chunks only: no entities, no relations, so lexical seeding finds nothing.
  await embeddings.embedBackfill(db, project.id, {
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    embedFn: keywordEmbed(),
  });

  const query = 'sibling';
  const plain = await graph.buildPprGraphContext(db, project.id, { query, focus: ['Nobody'] });
  assert.equal(plain.passages.length, 0, 'lexical-only finds nothing to rank');
  assert.equal(plain.stats.pprFallback, undefined, 'no fallback without dense');

  const dense = await graph.buildPprGraphContext(db, project.id, {
    query,
    focus: ['Nobody'],
    embed: { embedFn: keywordEmbed(), model: 'fake' },
  });
  assert.ok(dense.passages.length > 0, 'dense top-K fills the empty package');
  assert.equal(dense.stats.pprFallback, true, 'the fallback is flagged');
  db.close();
});

test('a dead embedder leaves retrieval byte-identical to lexical', async () => {
  const { db, project } = brotherProject('h2-degrade');
  await embeddings.embedBackfill(db, project.id, {
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    embedFn: keywordEmbed(),
  });

  const query = "who is Astra's sibling";
  const lexical = await graph.buildPprGraphContext(db, project.id, { query, focus: ['Astra'], hops: 1 });
  const degraded = await graph.buildPprGraphContext(db, project.id, {
    query,
    focus: ['Astra'],
    hops: 1,
    embed: { embedFn: async () => undefined, model: 'fake' },
  });
  assert.deepEqual(
    degraded.passages.map((p) => p.locator),
    lexical.passages.map((p) => p.locator),
    'dead embedder changes nothing',
  );
  assert.equal(degraded.stats.pprFallback, undefined, 'no fallback without dense');

  // The live client degrades the same way: closed port, short timeout.
  const live = await embeddings.embedTexts(['hello'], { baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 });
  assert.equal(live, undefined, 'unreachable server returns undefined, never throws');
  db.close();
});

test('backfill embeds once, skips after, and isolates models', async () => {
  const { db, project } = brotherProject('h2-backfill');
  const cfg = { baseUrl: 'http://127.0.0.1:9', model: 'fake', embedFn: keywordEmbed() };

  const first = await embeddings.embedBackfill(db, project.id, cfg);
  // 4 passages + 2 entities + 1 triple.
  assert.equal(first.embedded, 7, `everything embeds once (${first.embedded})`);
  assert.equal(first.skipped, 0, 'nothing to skip on a fresh project');
  assert.ok(first.dims > 0, 'dims reported');

  const second = await embeddings.embedBackfill(db, project.id, cfg);
  assert.equal(second.embedded, 0, 're-running embeds nothing');
  assert.equal(second.skipped, 7, 'every row is skipped');

  const other = await embeddings.embedBackfill(db, project.id, { ...cfg, model: 'other' });
  assert.equal(other.embedded, 7, 'a new model string backfills fresh rows');
  assert.equal(embeddings.readVectors(db, project.id, 'fake').length, 7, 'model rows never mix');
  assert.equal(embeddings.readVectors(db, project.id, 'other').length, 7, 'model rows never mix');
  db.close();
});

test('extract-time embedding is best-effort and never fails a run', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'h2-extract-hook');
  // Unreachable embedder: extraction succeeds, rows stay NULL.
  const stats = await lorebook.extractLore(db, mockProvider(), project.id, {
    windowSize: 8,
    embed: { baseUrl: 'http://127.0.0.1:9', model: 'fake', timeoutMs: 2000 },
  });
  assert.ok(stats.windows >= 0, 'the run completes');
  const rows = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding WHERE project_id = ?', project.id)?.n ?? 0;
  assert.equal(rows, 0, 'nothing stored when the embedder is down');
  db.close();
});
