/**
 * Dev-visualizer guards without a browser: the blind template condition and
 * the reveal-fence predicate. Invented rows only; reads the local script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/ui/dev-viz.js'), 'utf8');

test('blind mode omits model, citation map, and bank answer from the template', () => {
  const start = source.indexOf('function askResultHtml');
  const end = source.indexOf('function bankAnswerHtml');
  assert.ok(start >= 0 && end > start, 'ask template exists');
  const ask = source.slice(start, end);
  assert.match(ask, /const bankHtml = !blind \? bankAnswerHtml\(ask\.bank\) : '';/);
  assert.match(ask, /!blind && model \? `[^`]*data-model/);
  assert.match(ask, /!blind \? citationMapHtml\(passages\) : ''/);
});

test('reveal fence hides post-fence and unplaced rows', () => {
  const start = source.indexOf('function canReveal');
  const end = source.indexOf('function hash32', start);
  assert.ok(start >= 0 && end > start, 'reveal helper exists');
  const body = source.slice(start, end).trim();
  const canReveal = new Function(`return (${body.replace(/^function canReveal/, 'function')})`)() as (
    row: { chunkSeq?: number | null; firstSeq?: number | null },
    limit: number | null,
  ) => boolean;

  assert.equal(canReveal({ chunkSeq: 5 }, 4), false, 'post-fence row hidden');
  assert.equal(canReveal({ chunkSeq: null }, 4), false, 'unplaced row hidden');
  assert.equal(canReveal({ firstSeq: 5 }, 4), false, 'post-fence first seq hidden');
  assert.equal(canReveal({ chunkSeq: 4 }, 4), true, 'at-fence row visible');
  assert.equal(canReveal({ chunkSeq: 5 }, null), true, 'fence off shows everything');
});
