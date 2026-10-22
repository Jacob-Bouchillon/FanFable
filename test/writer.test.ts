import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_LIMITS,
  parseContextRequests,
  parseMeta,
  requestKey,
  stripProtocolBlocks,
  stripTrailingMeta,
  writeChapter,
  type ContextRequest,
} from '../src/writer.ts';
import { mockProvider } from './helpers.ts';

test('context requests are parsed from the writer output', () => {
  const text = `Some prose here.

[[CONTEXT]]
{"kind":"lore","query":"what the warden knows about the bridge"}
[[END]]

More prose.

[[CONTEXT]]
{"kind":"character","query":"what Kade knows","character":"Kade"}
[[END]]`;
  const reqs = parseContextRequests(text);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].kind, 'lore');
  assert.equal(reqs[0].query, 'what the warden knows about the bridge');
  assert.equal(reqs[1].character, 'Kade');
});

test('malformed context requests are ignored', () => {
  assert.equal(parseContextRequests('[[CONTEXT]]\nnot json\n[[END]]').length, 0);
  assert.equal(parseContextRequests('[[CONTEXT]]\n{"kind":"lore"}\n[[END]]').length, 0);
});

test('protocol blocks are stripped from the saved prose', () => {
  const text = `Prose.

[[CONTEXT]]
{"kind":"lore","query":"x"}
[[END]]

More prose.

[[META]]
{"events":[]}
[[END]]`;
  const cleaned = stripProtocolBlocks(text);
  assert.ok(!cleaned.includes('CONTEXT'));
  assert.ok(!cleaned.includes('META'));
  assert.match(cleaned, /Prose\./);
  assert.match(cleaned, /More prose\./);
});

test('a metadata object that lost its markers is not saved as prose', () => {
  // A model that writes the JSON straight onto the end of the chapter, and
  // runs out of tokens in the middle of it.
  const text = `The hall was quiet.

{"events":[{"title":"The Sorting","summary":"The hat hesitates","participants":["Harry Potter"],"location":"the Great Hall","kind":"event"}],"knowledge":[{"character":"Harry Potter","fact":"The hat hesitated","certainty":"knows","evidence":"The Hat`;
  const cleaned = stripTrailingMeta(text);
  assert.ok(!cleaned.includes('"events"'), 'the metadata is gone');
  assert.match(cleaned, /The hall was quiet\./);
  assert.ok(!cleaned.includes('The Hat'), 'the truncated metadata is gone');
});

test('prose that merely mentions a brace is left alone', () => {
  const text = 'He said "{listen}" and meant it, and then the door opened.';
  assert.equal(stripTrailingMeta(text), text);
});

test('prose that says the word "events" is not mistaken for metadata', () => {
  // A brace earlier in the chapter and the word "events" in dialogue must not
  // together cost the author the end of their prose.
  const text = `He wrote {a note} and left it on the table.
"I remember the events of that year," she said, and he did not answer.`;
  assert.equal(stripTrailingMeta(text), text.trim());
});

test('meta blocks are parsed', () => {
  const meta = parseMeta('text\n[[META]]\n{"events":[{"title":"x"}]}\n[[END]]');
  assert.ok(meta);
  assert.equal((meta!.events as any[])[0].title, 'x');
  assert.equal(parseMeta('no meta'), null);
});

test('request keys are stable', () => {
  const a: ContextRequest = { kind: 'lore', query: 'The Bridge' };
  const b: ContextRequest = { kind: 'lore', query: 'the bridge' };
  assert.equal(requestKey(a), requestKey(b));
});

test('the writer resolves context requests and continues the scene', async () => {
  let call = 0;
  const llm = mockProvider(() => {
    call++;
    if (call === 1) {
      return `The rain had not stopped.

[[CONTEXT]]
{"kind":"lore","query":"the bridge at Ardenne"}
[[END]]`;
    }
    return 'The bridge at Ardenne still stood, and Serena watched it from the ridge.';
  });

  const resolved: string[] = [];
  const result = await writeChapter(
    llm,
    {
      chapterNumber: 1,
      segments: 1,
      chapter: {
        number: 1,
        title: 'One',
        goal: 'set the scene',
        synopsis: 'Serena watches the bridge.',
        scenes: [],
        characters: ['Serena'],
        characterArcs: '',
        canonEventIds: [],
        notes: '',
        targetWords: 100,
      },
      memoryText: 'MEMORY BLOCK',
      canonText: 'CANON BLOCK',
    },
    async (req) => {
      resolved.push(req.query);
      return { label: `CANON for ${req.query}`, kind: 'lore', content: 'The bridge at Ardenne still stood.' };
    },
  );

  assert.deepEqual(resolved, ['the bridge at Ardenne']);
  assert.equal(result.trace.length, 1);
  assert.match(result.prose, /Ardenne/);
  assert.ok(!result.prose.includes('CONTEXT'));
  assert.equal(result.rounds, 2);
});

test('the writer stops looping when the model repeats a request', async () => {
  let call = 0;
  const llm = mockProvider(() => {
    call++;
    return `Prose.

[[CONTEXT]]
{"kind":"lore","query":"the same question"}
[[END]]`;
  });

  let resolves = 0;
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 1 },
    async () => {
      resolves++;
      return { label: 'answer', kind: 'lore', content: 'the same answer' };
    },
    { maxRounds: 3, maxRequests: 5 },
  );

  assert.equal(resolves, 1, 'the same question is only answered once');
  assert.ok(call >= 2);
});

test('the request budget is enforced', async () => {
  let n = 0;
  const llm = mockProvider(() => {
    n++;
    return `Prose.

[[CONTEXT]]
{"kind":"lore","query":"question ${n}"}
[[END]]`;
  });

  let resolves = 0;
  await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 1 },
    async () => {
      resolves++;
      return { label: 'answer', kind: 'lore', content: 'content' };
    },
    { maxRounds: 10, maxRequests: 2 },
  );

  assert.equal(resolves, 2, 'no more than the allowed number of requests are honoured');
});


test('a chapter written in parts is assembled from every part', async () => {
  let call = 0;
  const llm = mockProvider((req) => {
    call++;
    const user = req.messages[req.messages.length - 1]?.content ?? '';
    if (call === 1) return 'The first part opens the scene at the ridge, in the rain.';
    if (call === 2) return 'The second part carries it towards the tower.';
    return 'The third part closes it at the water.';
  });
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 3, targetWords: 900 },
    async () => null,
  );
  assert.equal(call, 3, 'one call per part');
  assert.match(result.prose, /opens the scene/);
  assert.match(result.prose, /carries it towards/);
  assert.match(result.prose, /closes it at the water/);
});

test('the beats already written are shown to the writer', async () => {
  const { beatsSoFar } = await import('../src/writer.ts');
  const beats = beatsSoFar('The car turned the corner.\n\nRain lashed the glass.\n\nShe counted the lights.');
  assert.equal(beats.length, 3);
  assert.match(beats[0], /car turned the corner/);
});
