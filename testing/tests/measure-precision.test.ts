/**
 * Measurement lock for bank-level keeper precision.
 *
 * The sampler must pin the sheet format, keep the keeper predicate exact, put
 * the relation id on every sampled row, leak no claim metadata, and the score
 * must never invent a verdict. Synthetic databases only; no model calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { tempDb } from './helpers.ts';
import {
  KEEPER_PREDICATE,
  SHEET_COLUMNS,
  sampleKeepers,
  scorePrecision,
  wilson95,
} from '../trials/claim-confidence/measure-precision.ts';

const AT = '2026-01-01T00:00:00.000Z';

interface SeedRow {
  status: string;
  kind?: string;
  kindSource?: string;
  confidence?: number;
  from?: string;
  to?: string;
  evidence?: string;
}

/** A synthetic bank with one relation per row, distinct pairs to satisfy the
 * unique pair+kind index. */
function bank(rows: SeedRow[]): { path: string; dir: string } {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'precision-test');
  const text = rows.map((row) => row.evidence ?? 'A quiet sentence.').join(' ');
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/probe', 'Probe', 'sha-precision', AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, project.id, 1, 'p. 1', '', text, text.split(/\s+/).length,
  ).lastInsertRowid;
  const entities = Array.from({ length: rows.length + 1 }, (_, i) => Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', `Person ${String.fromCharCode(65 + i)}`, '[]', AT, AT,
  ).lastInsertRowid));
  rows.forEach((row, index) => {
    const evidence = row.evidence ?? 'A quiet sentence.';
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, evidence, source_refs, confidence, review_status, kind_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      entities[index]!,
      entities[index + 1]!,
      row.kind ?? 'ally of',
      evidence,
      JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]),
      row.confidence ?? 1,
      row.status,
      row.kindSource ?? '',
      AT,
    );
  });
  db.close();
  const dir = mkdtempSync(join(tmpdir(), 'precision-sheet-'));
  return { path, dir };
}

function sheetRows(dir: string): string[][] {
  return readFileSync(join(dir, 'sheet.csv'), 'utf8').trim().split('\n').map((line) => line.split(','));
}

const NOW = '2026-11-04T00:00:00.000Z';
const COMMIT = 'test-commit';

test('the sampler puts a relation id on every sampled row', () => {
  const { path, dir } = bank([
    { status: 'accepted' },
    { status: 'user_confirmed' },
    { status: 'accepted' },
    { status: 'provisional' },
  ]);
  const result = sampleKeepers(path, dir, { seed: 42, n: 10, now: NOW, commit: COMMIT });
  assert.equal(result.keepers, 3);
  assert.equal(result.sampled, 3);
  const rows = sheetRows(dir);
  assert.deepEqual(rows[0], [...SHEET_COLUMNS]);
  assert.equal(rows.length - 1, 3);
  for (const row of rows.slice(1)) {
    const relId = Number(row[1]);
    assert.ok(Number.isInteger(relId) && relId > 0, `row carries relId: ${row.join(',')}`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.keepers, 3);
  assert.equal(manifest.counts.sampled, 3);
  assert.equal(manifest.seed, 42);
  assert.equal(manifest.commit, COMMIT);
  assert.equal(manifest.model, null);
});

test('the sheet carries id, pair and sentence only, with no claim metadata', () => {
  const { path, dir } = bank([
    {
      status: 'accepted',
      kind: 'mentor of',
      kindSource: 'mentored',
      confidence: 0.91,
      from: 'Asha',
      to: 'Bram',
      evidence: "Asha was Bram's mentor.",
    },
  ]);
  sampleKeepers(path, dir, { seed: 42, n: 5, now: NOW, commit: COMMIT });
  const text = readFileSync(join(dir, 'sheet.csv'), 'utf8');
  assert.equal(text.split('\n')[0], SHEET_COLUMNS.join(','));
  const row = sheetRows(dir)[1]!;
  assert.equal(row.length, SHEET_COLUMNS.length, 'five columns only');
  assert.equal(row[1], '1', 'relId is present');
  assert.ok(!text.includes('mentor of'), 'claimed kind is not on the sheet');
  assert.ok(!text.includes('0.91'), 'confidence is not on the sheet');
  assert.ok(!text.includes('mentored'), 'kind source is not on the sheet');
  assert.ok(!text.includes('accepted'), 'review status is not on the sheet');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const forbidden of ['kind', 'review_status', 'confidence', 'kind_source']) {
    assert.equal(forbidden in manifest, false, `manifest has no ${forbidden}`);
  }
  assert.equal(manifest.keeperPredicate, KEEPER_PREDICATE);
});

test('the keeper predicate is exactly accepted plus user_confirmed', () => {
  const { path, dir } = bank([
    { status: 'accepted' },
    { status: 'user_confirmed' },
    { status: 'provisional' },
    { status: 'needs_review' },
    { status: 'attested' },
    { status: 'rejected' },
  ]);
  const result = sampleKeepers(path, dir, { seed: 7, n: 20, now: NOW, commit: COMMIT });
  assert.equal(KEEPER_PREDICATE, "review_status IN ('accepted','user_confirmed')");
  assert.equal(result.keepers, 2);
  assert.equal(sheetRows(dir).length - 1, 2);
});

test('sampling is deterministic for a seed and varies across samples', () => {
  const { path, dir } = bank(Array.from({ length: 12 }, () => ({ status: 'accepted' as const })));
  const first = sampleKeepers(path, dir, { seed: 42, n: 6, now: NOW, commit: COMMIT });
  const sheetA = readFileSync(first.sheetPath, 'utf8');
  const again = sampleKeepers(path, dir, { seed: 42, n: 6, now: NOW, commit: COMMIT });
  assert.equal(readFileSync(again.sheetPath, 'utf8'), sheetA);
  const other = sampleKeepers(path, dir, { seed: 43, n: 6, now: NOW, commit: COMMIT });
  assert.notEqual(readFileSync(other.sheetPath, 'utf8'), sheetA, 'a different seed samples a different order');
});

test('Wilson 95% matches pinned vectors', () => {
  const vectors: [number, number, number, number][] = [
    [7, 10, 0.396778, 0.892209],
    [0, 10, 0, 0.277533],
    [10, 10, 0.722467, 1],
    [2, 3, 0.20766, 0.938508],
    [15, 20, 0.531299, 0.888138],
  ];
  for (const [supported, keepers, low, high] of vectors) {
    const interval = wilson95(supported, keepers);
    assert.ok(interval, `${supported}/${keepers}`);
    assert.ok(Math.abs(interval.low - low) < 1e-5, `${supported}/${keepers} low ${interval.low}`);
    assert.ok(Math.abs(interval.high - high) < 1e-5, `${supported}/${keepers} high ${interval.high}`);
  }
  assert.equal(wilson95(0, 0), null);
  assert.equal(wilson95(2, 1), null);
});

test('scoring prints PENDING with no verdicts and never invents them', () => {
  const { path, dir } = bank([{ status: 'accepted' }, { status: 'accepted' }, { status: 'accepted' }]);
  sampleKeepers(path, dir, { seed: 42, n: 10, now: NOW, commit: COMMIT });
  const pending = scorePrecision(dir, { integrity: () => 0 });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.keepers, 3);
  assert.equal(pending.supported, 0);
  assert.equal(pending.pending, 3);
  assert.equal(pending.precision, 'PENDING');
  assert.equal(pending.wilsonLow, 'PENDING');
  assert.equal(pending.wilsonHigh, 'PENDING');

  // One verdict in: still PENDING, and the supported count is the real one.
  writeFileSync(join(dir, 'verdicts.csv'), 'id,verdict,reason\n1,supported,the passage names the tie\n');
  const partial = scorePrecision(dir, { integrity: () => 0 });
  assert.equal(partial.status, 'PENDING');
  assert.equal(partial.supported, 1);
  assert.equal(partial.pending, 2);
  assert.equal(partial.precision, 'PENDING');
});

test('complete verdicts produce precision and Wilson, and record the integrity exit', () => {
  const { path, dir } = bank([{ status: 'accepted' }, { status: 'accepted' }, { status: 'accepted' }]);
  sampleKeepers(path, dir, { seed: 42, n: 10, now: NOW, commit: COMMIT });
  writeFileSync(
    join(dir, 'verdicts.csv'),
    'id,verdict,reason\n' +
      '1,supported,the passage states the tie directly\n' +
      '2,supported,both names and the role are stated\n' +
      '3,not_supported,only a shared scene is described\n',
  );
  let passedDb = '';
  const scored = scorePrecision(dir, {
    integrity: (db) => {
      passedDb = db;
      return 0;
    },
  });
  assert.equal(passedDb, path);
  assert.equal(scored.status, 'OK');
  assert.equal(scored.keepers, 3);
  assert.equal(scored.supported, 2);
  assert.equal(scored.precision, Number((2 / 3).toFixed(6)));
  const interval = wilson95(2, 3)!;
  assert.equal(scored.wilsonLow, Number(interval.low.toFixed(6)));
  assert.equal(scored.wilsonHigh, Number(interval.high.toFixed(6)));
  assert.equal(scored.integrityExit, 0);
  assert.equal(scored.commit, COMMIT);
});

test('a malformed verdict fails closed', () => {
  const { path, dir } = bank([{ status: 'accepted' }]);
  sampleKeepers(path, dir, { seed: 42, n: 10, now: NOW, commit: COMMIT });
  const bad = [
    'id,verdict,reason\n1,maybe,an invented verdict\n',
    'id,verdict,reason\n1,supported,one two three four five six seven eight nine ten eleven twelve thirteen\n',
    'id,verdict\n1,supported\n',
  ];
  for (const text of bad) {
    writeFileSync(join(dir, 'verdicts.csv'), text);
    assert.throws(() => scorePrecision(dir, { integrity: () => 0 }));
  }
});
