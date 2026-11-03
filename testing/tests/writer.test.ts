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
} from '../../fanfable/src/product/writer.ts';
import type { ChatRequest } from '../../fanfable/src/core/llm.ts';
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

{"events":[{"title":"The Choosing","summary":"The cap hesitates","participants":["Asha Corwin"],"location":"the Long Hall","kind":"event"}],"knowledge":[{"character":"Asha Corwin","fact":"The cap hesitated","certainty":"knows","evidence":"The Cap`;
  const cleaned = stripTrailingMeta(text);
  assert.ok(!cleaned.includes('"events"'), 'the metadata is gone');
  assert.match(cleaned, /The hall was quiet\./);
  assert.ok(!cleaned.includes('The Cap'), 'the truncated metadata is gone');
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
  assert.match(result.prose, /rain had not stopped/);
  assert.match(result.prose, /Ardenne/);
  assert.ok(!result.prose.includes('CONTEXT'));
  assert.equal(result.rounds, 2);
  assert.equal(result.stats.initialCalls, 1);
  assert.equal(result.stats.additionalCalls, 1);
  assert.equal(result.stats.unansweredRequests, 0);
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
  assert.equal(result.rounds, 4, 'one initial call plus the three-call follow-up budget');
  assert.equal(result.stats.additionalCalls, 3);
  assert.equal(result.stats.unansweredRequests, 0);
  assert.ok(call >= 4);
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

test('single-part prose keeps every distinct response across context turns', async () => {
  let call = 0;
  const requests: ChatRequest[] = [];
  const llm = mockProvider((req) => {
    requests.push(structuredClone(req) as ChatRequest);
    call++;
    if (call === 1) {
      return `EARLY DISTINCT PROSE.

[[CONTEXT]]
{"kind":"au","query":"first question"}
[[END]]`;
    }
    if (call === 2) {
      return `MIDDLE DISTINCT PROSE.

[[CONTEXT]]
{"kind":"au","query":"second question"}
[[END]]`;
    }
    return 'LATER DISTINCT PROSE.';
  });
  let resolves = 0;
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 1, targetWords: 1 },
    async () => {
      resolves++;
      return { label: 'answer', kind: 'au', content: 'ANSWER' };
    },
    { maxRounds: 4, maxRequests: 10 },
  );

  assert.equal(call, 3);
  assert.equal(resolves, 2);
  assert.equal(result.rounds, 3);
  assert.equal(result.stats.initialCalls, 1);
  assert.equal(result.stats.additionalCalls, 2);
  assert.equal(result.stats.unansweredRequests, 0);
  assert.ok(result.prose.indexOf('EARLY DISTINCT PROSE.') < result.prose.indexOf('MIDDLE DISTINCT PROSE.'));
  assert.ok(result.prose.indexOf('MIDDLE DISTINCT PROSE.') < result.prose.indexOf('LATER DISTINCT PROSE.'));
  assert.ok(!result.prose.includes('CONTEXT'));
  assert.deepEqual(
    requests.map((request) => request.messages.map((message) => message.role)),
    [
      ['user'],
      ['user', 'assistant', 'user'],
      ['user', 'assistant', 'user', 'assistant', 'user'],
    ],
  );
  assert.match(requests[1]!.messages[1]!.content, /EARLY DISTINCT PROSE/);
  assert.match(requests[1]!.messages[1]!.content, /\[\[CONTEXT\]\]/);
  assert.match(requests[1]!.messages[2]!.content, /ANSWER/);
  assert.match(requests[1]!.messages[2]!.content, /Here is the information you requested/);
  assert.ok(!requests[1]!.messages[2]!.content.includes('Write the prose now'));
  assert.match(requests[2]!.messages[1]!.content, /EARLY DISTINCT PROSE/);
  assert.match(requests[2]!.messages[3]!.content, /MIDDLE DISTINCT PROSE/);
  assert.equal(
    requests[2]!.messages.filter(
      (message) => message.role === 'user' && message.content.includes('Write the prose now'),
    ).length,
    1,
    'follow-ups do not append a second fresh task prompt',
  );
});

test('a protocol-only later response does not erase single-part prose', async () => {
  let call = 0;
  const llm = mockProvider(() => {
    call++;
    if (call === 1) {
      return `KEEP THIS STORY PROSE.

[[CONTEXT]]
{"kind":"au","query":"what changed"}
[[END]]`;
    }
    return `[[META]]
{"summary":"only metadata"}
[[END]]`;
  });
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 1, targetWords: 1 },
    async () => ({ label: 'answer', kind: 'au', content: 'ANSWER' }),
    { maxRounds: 2, maxRequests: 10 },
  );

  assert.equal(call, 2);
  assert.equal(result.prose, 'KEEP THIS STORY PROSE.');
  assert.ok(!result.prose.includes('META'));
  assert.equal(result.meta?.summary, 'only metadata');
});

test('single-part prose removes repeated and partially overlapping output', async () => {
  let call = 0;
  const llm = mockProvider(() => {
    call++;
    if (call === 1) {
      return `Paragraph A is long enough to be treated as a real story paragraph.

[[CONTEXT]]
{"kind":"au","query":"first"}
[[END]]`;
    }
    if (call === 2) {
      return `Paragraph A is long enough to be treated as a real story paragraph.

Paragraph B adds new action and must survive.

[[CONTEXT]]
{"kind":"au","query":"second"}
[[END]]`;
    }
    return 'Paragraph C closes the scene with new consequence.';
  });
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 1, targetWords: 1 },
    async () => ({ label: 'answer', kind: 'au', content: 'ANSWER' }),
    { maxRounds: 4, maxRequests: 10 },
  );

  assert.equal(call, 3);
  assert.equal(result.prose.match(/Paragraph A is long enough/g)?.length, 1);
  assert.match(result.prose, /Paragraph B adds new action/);
  assert.match(result.prose, /Paragraph C closes the scene/);
});

test('six parts with defaults and requests keep every part initial call and cap follow-ups', async () => {
  let call = 0;
  let resolves = 0;
  const llm = mockProvider(() => {
    call++;
    return `PART ${call} DISTINCT PROSE.

[[CONTEXT]]
{"kind":"au","query":"question ${call}"}
[[END]]`;
  });
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 6, targetWords: 1200 },
    async () => {
      resolves++;
      return { label: 'answer', kind: 'au', content: 'ANSWER' };
    },
    DEFAULT_CONTEXT_LIMITS,
  );

  assert.equal(call, 10, 'six initial calls plus four additional calls');
  assert.equal(result.rounds, 10);
  assert.equal(result.stats.initialCalls, 6);
  assert.equal(result.stats.additionalCalls, 4);
  assert.equal(result.stats.unansweredRequests, 6);
  assert.equal(resolves, 4);
  assert.match(result.prose, /PART 1 DISTINCT PROSE/);
  assert.match(result.prose, /PART 6 DISTINCT PROSE/);
  assert.match(result.prose, /PART 10 DISTINCT PROSE/);
});

test('the additional-call budget is exact and the final request is unanswered', async () => {
  let call = 0;
  let resolves = 0;
  const llm = mockProvider(() => {
    call++;
    return `CALL ${call} PROSE.

[[CONTEXT]]
{"kind":"au","query":"question ${call}"}
[[END]]`;
  });
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 1, targetWords: 1 },
    async () => {
      resolves++;
      return { label: 'answer', kind: 'au', content: 'ANSWER' };
    },
    { maxRounds: 2, maxRequests: 10 },
  );

  assert.equal(call, 3, 'one initial call plus exactly two additional calls');
  assert.equal(result.rounds, 3);
  assert.equal(result.stats.initialCalls, 1);
  assert.equal(result.stats.additionalCalls, 2);
  assert.equal(result.stats.unansweredRequests, 1);
  assert.equal(resolves, 2);
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

test('multipart calls carry prior assistant responses between part prompts', async () => {
  const requests: ChatRequest[] = [];
  let call = 0;
  const llm = mockProvider((req) => {
    requests.push(structuredClone(req) as ChatRequest);
    call++;
    return `PART ${call} PROSE.`;
  });
  const result = await writeChapter(
    llm,
    { chapterNumber: 1, memoryText: '', canonText: '', segments: 3, targetWords: 900 },
    async () => null,
  );

  assert.equal(call, 3);
  assert.match(result.prose, /PART 1 PROSE/);
  assert.match(result.prose, /PART 2 PROSE/);
  assert.match(result.prose, /PART 3 PROSE/);
  assert.deepEqual(
    requests.map((request) => request.messages.map((message) => message.role)),
    [
      ['user'],
      ['user', 'assistant', 'user'],
      ['user', 'assistant', 'user', 'assistant', 'user'],
    ],
  );
  assert.match(requests[1]!.messages[1]!.content, /PART 1 PROSE/);
  assert.match(requests[2]!.messages[1]!.content, /PART 1 PROSE/);
  assert.match(requests[2]!.messages[3]!.content, /PART 2 PROSE/);
  for (const request of requests) {
    const roles = request.messages.map((message) => message.role);
    for (let i = 1; i < roles.length; i++) {
      assert.ok(!(roles[i - 1] === 'user' && roles[i] === 'user'), 'no consecutive user turns');
    }
  }
});

test('the beats already written are shown to the writer', async () => {
  const { beatsSoFar } = await import( '../../fanfable/src/product/writer.ts');
  const beats = beatsSoFar('The car turned the corner.\n\nRain lashed the glass.\n\nShe counted the lights.');
  assert.equal(beats.length, 3);
  assert.match(beats[0], /car turned the corner/);
});
