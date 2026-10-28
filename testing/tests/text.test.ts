import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, dedupeParagraphs, findHeadings, similarity, splitSentences, trimFrontBackMatter, wordCount } from '../../fanfable/src/text.ts';
import { extractJson, extractJsonList, toStringArray } from '../../fanfable/src/json.ts';

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

const OVERLAP_SUBJECTS = ['Mara Vell', 'Corin Ashe', 'the gatekeeper', 'Elin Rook', 'the cartwright', 'Sera Holt'];
const OVERLAP_PLACES = ['the northern gate', 'the lower market', 'the river road', 'the old mill', 'the eastern bridge', 'the winter yard'];
const OVERLAP_VERBS = ['counted', 'marked', 'carried', 'checked', 'recorded', 'weighed'];
const OVERLAP_OBJECTS = ['the hourly tolls', 'each sealed letter', 'the grain sacks', 'the iron keys', 'the travel permits', 'the empty crates'];
const OVERLAP_TAILS = ['before the bells had finished ringing', 'while the rain tapped on the roof', 'as the morning crowd pressed forward', 'under a sky the colour of wet slate', 'without stopping to warm their hands', 'before the watch changed at noon'];

function overlapSentence(i: number): string {
  return `${OVERLAP_SUBJECTS[i % 6]} ${OVERLAP_VERBS[(i * 3 + 2) % 6]} ${OVERLAP_OBJECTS[(i * 5 + 3) % 6]} at ${OVERLAP_PLACES[(i * 2 + 1) % 6]} ${OVERLAP_TAILS[(i * 7 + 4) % 6]}.`;
}

function overlapParagraph(seed: number): string {
  return Array.from({ length: 11 }, (_, i) => overlapSentence(seed * 13 + i)).join(' ');
}

const OVERLAP_CORPUS = Array.from({ length: 8 }, (_, i) => overlapParagraph(i + 1)).join('\n\n');

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function suffixPrefixWords(a: string, b: string): number {
  const left = normalise(a).split(' ').filter(Boolean);
  const right = normalise(b).split(' ').filter(Boolean);
  for (let n = Math.min(left.length, right.length); n > 0; n--) {
    if (left.slice(-n).join(' ') === right.slice(0, n).join(' ')) return n;
  }
  return 0;
}

function contentCharRatio(chunks: { text: string }[]): number {
  let total = 0;
  let repeated = 0;
  for (let i = 0; i < chunks.length; i++) {
    total += chunks[i]!.text.length;
    if (!i) continue;
    const a = normalise(chunks[i - 1]!.text);
    const b = normalise(chunks[i]!.text);
    for (let n = Math.min(a.length, b.length); n > 0; n--) {
      if (a.slice(-n) === b.slice(0, n)) {
        repeated += n;
        break;
      }
    }
  }
  return (total - repeated) / total;
}

test('chunk overlap is sentence-bounded and never repeats a chunk', () => {
  const chunks = chunkText(OVERLAP_CORPUS, { maxWords: 220, overlapWords: 20 });
  assert.ok(chunks.length > 4, 'fixture should produce several chunks');
  for (const chunk of chunks) {
    const words = wordCount(chunk.text);
    if (words > 220) {
      assert.equal(splitSentences(chunk.text).length, 1, 'only a single indivisible sentence may exceed maxWords');
    }
    const raw = normalise(OVERLAP_CORPUS.slice(chunk.charStart, chunk.charEnd));
    assert.ok(raw.startsWith(normalise(chunk.text)), `char range does not point at chunk ${chunk.seq}`);
  }
  for (let i = 1; i < chunks.length; i++) {
    const previous = normalise(chunks[i - 1]!.text);
    const current = normalise(chunks[i]!.text);
    assert.notEqual(previous, current, 'adjacent chunks must not be byte-identical');
    assert.ok(!previous.includes(current) && !current.includes(previous), 'a chunk is contained in its neighbour');
    const overlap = suffixPrefixWords(chunks[i - 1]!.text, chunks[i]!.text);
    assert.ok(overlap <= 20, `sentence overlap ${overlap} exceeds the 20-word budget`);
  }
  const ratio = contentCharRatio(chunks);
  assert.ok(ratio >= 0.9, `content character ratio ${ratio.toFixed(3)} is below 0.9`);

  // overlapWords is hard-capped at a quarter of maxWords. Unique sentences
  // keep this measurement about the budget, not repeated fixture phrases.
  const uniqueProse = Array.from(
    { length: 60 },
    (_, i) => `Entry number ${i} records a separate fact about the yard and its carts.`,
  ).join(' ');
  const capped = chunkText(uniqueProse, { maxWords: 120, overlapWords: 40 });
  for (let i = 1; i < capped.length; i++) {
    assert.ok(suffixPrefixWords(capped[i - 1]!.text, capped[i]!.text) <= 30, 'overlap exceeds the quarter cap');
  }
  for (const chunk of capped) {
    assert.ok(wordCount(chunk.text) <= 120 || splitSentences(chunk.text).length === 1);
  }
});

test('page boundaries flush without overlap', () => {
  const pageOne = [
    'On the first page, Mara counted twelve lanterns along the northern wall.',
    'Corin marked the gate receipts in a narrow ledger before noon.',
    'The gatekeeper checked the grain sacks and the iron keys at the old mill.',
    'A cart waited beside the river road while the morning crowd pressed forward.',
    'The watch changed at noon and the bells rang once over the wet slate roof.',
  ].join(' ');
  const pageTwo = [
    'On the second page, Elin sorted travel permits beside the eastern bridge.',
    'A second cart carried empty crates toward the winter yard without stopping.',
    'Sera recorded the hourly tolls and sealed each letter in a blue envelope.',
    'The gatekeeper counted nine lanterns and wrote the total in the margin.',
    'Rain tapped on the roof while the last cart rolled past the mill.',
  ].join(' ');
  const chunks = chunkText(`${pageOne}\n\n\f\n\n${pageTwo}`, { maxWords: 220, overlapWords: 20 });
  assert.equal(chunks.length, 2, 'each page should flush on its own');
  assert.deepEqual(chunks.map((c) => [c.pageStart, c.pageEnd]), [[1, 1], [2, 2]]);
  assert.equal(suffixPrefixWords(chunks[0]!.text, chunks[1]!.text), 0, 'page break must not repeat text');
  assert.ok(!normalise(chunks[1]!.text).includes(normalise(pageOne.slice(-40))), 'page-two chunk starts with new text');
});

test('only a single indivisible sentence may exceed the word cap', () => {
  const giant = `${Array.from({ length: 260 }, (_, i) => `word${i % 7}`).join(' ')}.`;
  const chunks = chunkText(`A short opening sentence. ${giant} A short closing sentence.`, {
    maxWords: 60,
    overlapWords: 15,
  });
  const oversized = chunks.filter((c) => wordCount(c.text) > 60);
  assert.equal(oversized.length, 1, 'exactly the giant sentence goes over the cap');
  assert.equal(splitSentences(oversized[0]!.text).length, 1, 'the over-cap chunk is one sentence');
  for (const chunk of chunks.filter((c) => !oversized.includes(c))) {
    assert.ok(wordCount(chunk.text) <= 60, 'ordinary chunks respect the cap');
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

const TRIMMED_BOOK = [
  'Copyright page words here, all rights reserved by the publisher.',
  '',
  'Contents',
  '',
  '1: The Bridge',
  '2: The Ledger',
  '3: The Fall',
  'About the Author',
  'Also by this Author',
  '',
  '\f',
  'A long time ago in a galaxy far, far away….',
  '',
  '\f',
  'PROLOGUE',
  '',
  'The rain had not stopped for three days, and the bridge at Ardenne still stood.',
  '',
  '\f',
  '1: The Bridge',
  '',
  'Serena watched it from the ridge, wrapped in a coat that had belonged to her brother.',
  '',
  '\f',
  '2: The Ledger',
  '',
  'The warden kept a ledger of debts, and Ilsa Marrow had been entered in it three times.',
  '',
  '\f',
  'About the Author',
  '',
  'Serena is a writer of many fine books, available now in stores everywhere.',
].join('\n');

test('front/back matter trims to the contents-bounded body', () => {
  const r = trimFrontBackMatter(TRIMMED_BOOK);
  assert.equal(r.headPages, 1, 'copyright+contents page blanked');
  assert.equal(r.tailPages, 1, 'author-bio page blanked');
  assert.ok(r.text.includes('The rain had not stopped'), 'prologue kept');
  assert.ok(r.text.includes('ledger of debts'), 'last chapter kept');
  assert.ok(!r.text.includes('available now in stores'), 'ad copy gone');
  assert.ok(r.text.includes('A long time ago'), 'opening crawl kept');
  // Page numbers stable: same form-feed count, blanks in place of matter.
  assert.equal(r.text.split('\f').length, TRIMMED_BOOK.split('\f').length);
});

test('no contents list means no trim', () => {
  const plain = 'Just a story.\n\n\f\nMore story on page two.\n';
  const r = trimFrontBackMatter(plain);
  assert.equal(r.text, plain);
  assert.equal(r.headPages + r.tailPages, 0);
});

test('single-page text is never trimmed', () => {
  const one = '1: The Bridge\n\nSerena crossed at dawn.\n';
  const r = trimFrontBackMatter(one);
  assert.equal(r.text, one);
});

test('consecutive blank pages do not shift later page numbers', () => {
  const text = [
    'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.',
    '',
    '\f',
    '',
    '\f',
    '',
    '\f',
    'Omega line here now today indeed surely forever onward and upward.',
  ].join('\n');
  const chunks = chunkText(text, { maxWords: 12 });
  const starts = chunks.map((c) => c.pageStart);
  const ends = chunks.map((c) => c.pageEnd);
  assert.equal(Math.min(...starts), 1, 'first content stays on page 1');
  assert.equal(Math.max(...ends), 4, 'content after three blanks lands on page 4');
});
