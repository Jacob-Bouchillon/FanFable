import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, dedupeParagraphs, findHeadings, similarity, splitSentences, wordCount } from '../src/text.ts';
import { extractJson, extractJsonList, toStringArray } from '../src/json.ts';

const SAMPLE = `CHAPTER ONE: THE BRIDGE

The rain had not stopped for three days, and the bridge at Ardenne still stood.

Serena watched it from the ridge, wrapped in a coat that had belonged to her
brother. Below her the river ran brown and fast.

CHAPTER TWO: THE LEDGER

The warden kept a ledger of debts, and Ilsa Marrow had been entered in it
three times: once for a horse, once for a knife, and once for a promise.
`;

test('chunking keeps paragraphs intact and breaks on headings', () => {
  const chunks = chunkText(SAMPLE, { maxWords: 40 });
  assert.ok(chunks.length >= 2, 'expected at least two chunks');
  assert.equal(chunks[0].heading, 'CHAPTER ONE: THE BRIDGE');
  for (const c of chunks) {
    const headingsInChunk = (c.text.match(/CHAPTER/g) ?? []).length;
    assert.ok(headingsInChunk <= 1, 'a chunk must not straddle a heading');
  }
  const second = chunks.findIndex((c) => c.text.includes('CHAPTER TWO'));
  assert.ok(second > 0, 'the second chapter starts a new chunk');
  assert.equal(chunks[second].heading, 'CHAPTER TWO: THE LEDGER');
});

test('chunking does not split sentences', () => {
  const prose = `The rain had not stopped for three days, and the bridge at Ardenne still stood. Serena watched it from the ridge, wrapped in a coat that had belonged to her brother. Below her the river ran brown and fast, and the far bank was a smear of wet stone and black water. The warden kept a ledger of debts, and Ilsa Marrow had been entered in it three times.`;
  const chunks = chunkText(prose, { maxWords: 20 });
  for (const c of chunks) {
    const last = c.text.slice(-1);
    assert.ok(['.', '!', '?'].includes(last), `chunk ends mid-sentence: ...${c.text.slice(-40)}`);
  }
});

test('headings are detected in common formats', () => {
  const heads = findHeadings('# Title\n\n## Sub\n\nChapter 3: The Fall\n\ntext');
  const names = heads.map((h) => h.heading);
  assert.ok(names.includes('Title'));
  assert.ok(names.includes('Sub'));
  assert.ok(names.some((n) => /Chapter 3/.test(n)));
});

test('sentence splitting and word count', () => {
  const s = splitSentences('One. Two! Three? "Four."');
  assert.equal(s.length, 4);
  assert.equal(wordCount('  a b  c '), 3);
});

test('similarity detects repeated passages', () => {
  const a = 'Serena crossed the bridge in the rain while Kade watched from the ridge.';
  const b = 'Serena crossed the bridge in the rain while Kade watched from the ridge.';
  const c = 'The warden read the ledger aloud to a room full of silent wardens.';
  assert.ok(similarity(a, b) > 0.9);
  assert.ok(similarity(a, c) < 0.2);
});

test('json extraction tolerates prose and fences', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```\nDone.'), { a: 2 });
  assert.deepEqual(extractJson('noise {"a":{"b":[1,2]}} trailing'), { a: { b: [1, 2] } });
  assert.equal(extractJson('no json here'), null);
});

test('json list extraction finds several objects', () => {
  const items = extractJsonList<{ n: number }>('text {"n":1} more {"n":2}');
  assert.equal(items.length, 2);
  assert.equal(items[1].n, 2);
});

test('string array coercion', () => {
  assert.deepEqual(toStringArray('a'), ['a']);
  assert.deepEqual(toStringArray(['a', ' b ']), ['a', 'b']);
  assert.deepEqual(toStringArray(null), []);
});

test('duplicate paragraphs are removed from generated prose', () => {
  const body = [
    'Serena walked the length of the ridge while the rain came down steadily on the stone.',
    'She counted the lanterns from the tower, one, two, and then a third far out on the water.',
    'Serena walked the length of the ridge while the rain came down steadily on the stone.',
    'Short line.',
    'Short line.',
  ].join('\n\n');
  const { text, removed } = dedupeParagraphs(body);
  assert.equal(removed, 1);
  assert.ok(!text.includes('while the rain came down steadily on the stone.\n\nShort'));
  assert.equal((text.match(/Short line\./g) ?? []).length, 2, 'short lines are never dropped');
});
