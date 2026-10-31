/**
 * SINGLE-track prototype math: both-names sentence detection via variants,
 * nesting refusal, ranking/cap determinism, verbatim sourcing, leakage sweep,
 * CSV round-trip. Pure functions only — no DB, no model. Generic names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { splitSentences } from '../../fanfable/src/core/text.ts';
import {
  JUDGE_BLOCK,
  findLeakage,
} from '../trials/discovery/sample-followup.ts';
import { csvCell, parseCsv } from '../trials/discovery/allocate-followup.ts';
import {
  analyzeSentence,
  expandShortSegments,
  isTempPath,
  isVerbatim,
  mentions,
  nests,
  positions,
  rankCandidates,
  renderFidSection,
  selectTop,
  type RawCandidate,
} from '../trials/discovery/single-prototype.ts';

const VA = [['rook', 'hale']];
const VB = [['sable', 'vey']];

function cand(sentence: string, span: number, seq: number, chunk = 1, order = 0): RawCandidate {
  return { sentence, locator: 'p. 1', chunk, seq, span, order };
}

test('positions finds exact contiguous matches', () => {
  assert.deepEqual(positions(['rook', 'hale', 'met', 'sable'], ['sable']), [3]);
  assert.deepEqual(positions(['rook', 'hale', 'met', 'hale'], ['hale']), [1, 3]);
});

test('positions returns empty for an empty target', () => {
  assert.deepEqual(positions(['rook', 'hale'], []), []);
});

test('nests refuses a short name inside a longer one', () => {
  assert.equal(nests(['wren'], ['wren', 'hall']), true);
  assert.equal(nests(['wren', 'hall'], ['wren']), false);
  assert.equal(nests(['rook', 'hale'], ['sable', 'vey']), false);
  assert.equal(nests(['rook'], ['rook']), false);
});

test('mentions collects every variant span', () => {
  const got = mentions(['rook', 'hale', 'sighed'], [['rook', 'hale'], ['hale']]);
  assert.deepEqual(got, [
    { start: 0, end: 1 },
    { start: 1, end: 1 },
  ]);
});

test('analyzeSentence hits when both endpoints are named', () => {
  const hit = analyzeSentence('Rook Hale met Sable Vey today', VA, VB);
  assert.ok(hit !== null);
  assert.equal(hit.span, 4);
});

test('analyzeSentence returns null unless both are named', () => {
  assert.equal(analyzeSentence('Rook Hale walked alone', VA, VB), null);
  assert.equal(analyzeSentence('The rain fell hard', VA, VB), null);
  assert.equal(analyzeSentence('', VA, VB), null);
});

test('analyzeSentence takes the closest of repeated mentions', () => {
  const hit = analyzeSentence('Rook Hale saw Rook Hale with Sable Vey', VA, VB);
  assert.ok(hit !== null);
  assert.equal(hit.span, 4);
});

test('analyzeSentence matches alias variants', () => {
  const aliasA = [['rook', 'hale'], ['captain', 'rook']];
  const hit = analyzeSentence('Captain Rook warned Sable Vey', aliasA, VB);
  assert.ok(hit !== null);
  assert.equal(hit.span, 4);
});

test('analyzeSentence ignores case', () => {
  const hit = analyzeSentence('ROOK HALE met sable vey', VA, VB);
  assert.ok(hit !== null);
});

test('rankCandidates orders by span then seq', () => {
  const ranked = rankCandidates([cand('wide early', 5, 1), cand('near late', 2, 9), cand('near early', 2, 3)]);
  assert.deepEqual(
    ranked.map((c) => c.sentence),
    ['near early', 'near late', 'wide early'],
  );
});

test('rankCandidates is deterministic under reversed input', () => {
  const fwd = rankCandidates([cand('a', 4, 2), cand('b', 1, 5), cand('c', 1, 2, 2, 1)]);
  const rev = rankCandidates([cand('c', 1, 2, 2, 1), cand('b', 1, 5), cand('a', 4, 2)]);
  assert.deepEqual(rev, fwd);
});

test('selectTop caps and keeps rank order', () => {
  const cands = [cand('s5', 9, 1), cand('s1', 1, 1), cand('s4', 7, 1), cand('s2', 2, 1), cand('s3', 3, 1)];
  const top = selectTop(cands, 3);
  assert.deepEqual(
    top.map((c) => c.sentence),
    ['s1', 's2', 's3'],
  );
});

test('isVerbatim requires a word-for-word occurrence', () => {
  assert.equal(isVerbatim('Rook Hale met Sable Vey.', 'Rook Hale met Sable Vey.'), true);
  assert.equal(isVerbatim('Rook Hale met Sable Vey.', 'Rook Hale warned Sable Vey.'), false);
  assert.equal(isVerbatim('anything', ''), false);
});

test('isTempPath admits temp copies and refuses live paths', () => {
  assert.equal(isTempPath(join(tmpdir(), 'd4-probe.db')), true);
  assert.equal(isTempPath(join(realpathSyncSafe(tmpdir()), 'd4-probe.db')), true);
  assert.equal(isTempPath(':memory:'), false);
  assert.equal(isTempPath(resolve('testing/tests/x.db')), false);
});

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

test('expandShortSegments canonicalises one location to one spelling', () => {
  const a = expandShortSegments(resolve(join(tmpdir(), 'd4-probe.db')));
  const b = expandShortSegments(resolve(join(realpathSyncSafe(tmpdir()), 'd4-probe.db')));
  assert.equal(a, b);
});

test('candidate CSV round-trips sentences with commas and quotes', () => {
  const head = ['fid', 'pair', 'stratum', 'sentence', 'locator', 'chunk', 'seq', 'span_tokens'];
  const row = ['F001', 'Rook Hale / Sable Vey', '2-3/t1', 'Rook Hale met Sable Vey, "the gate", at dawn.', 'p. 1', '7', '2', '4'];
  const back = parseCsv([head.join(','), row.map(csvCell).join(',')].join('\n'));
  assert.deepEqual([back[0]!.fid, back[0]!.sentence, back[0]!.span_tokens], [row[0], row[3], row[7]]);
});

test('rendered fid sections carry sentences and locators without leakage', () => {
  const text = renderFidSection({
    fid: 'F001',
    pair: 'Rook Hale / Sable Vey',
    stratum: '2-3/t1',
    cands: [cand('Rook Hale met Sable Vey at the gate.', 4, 1)],
  });
  assert.ok(text.includes('F001'));
  assert.ok(text.includes('Rook Hale met Sable Vey at the gate.'));
  assert.ok(text.includes('p. 1'));
  assert.deepEqual(findLeakage(`${JUDGE_BLOCK}\n${text}`), []);
});

test('split sentences keep byte-verbatim both-names hits', () => {
  const source =
    'Rook Hale met Sable Vey at the gate. The rain fell hard. Sable Vey trusted Rook Hale with the cipher.';
  const hits = splitSentences(source).filter((s) => analyzeSentence(s, VA, VB) !== null);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((s) => isVerbatim(source, s)));
});
