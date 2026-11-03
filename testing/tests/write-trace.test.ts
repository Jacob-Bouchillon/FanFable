/**
 * Phase 3a: write execution tracing.
 *
 * Temp databases and MockProvider only. The trace is diagnostic: tracing on and
 * off must send the same actual ChatRequests and produce the same chapter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatRequest } from '../../fanfable/src/core/llm.ts';
import { MockProvider } from '../../fanfable/src/core/llm.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import * as trace from '../../fanfable/src/trace/trace.ts';
import { WriteTrace } from '../../fanfable/src/trace/write-trace.ts';
import { writeChapter } from '../../fanfable/src/product/writer.ts';
import { seedProject, tempDb } from './helpers.ts';

const AT = '2024-01-01T00:00:00.000Z';
const CLI = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');

function chapterOutline(overrides: Partial<planner.ChapterOutline> = {}): planner.ChapterOutline {
  return {
    number: 1,
    title: 'The Third Lantern',
    goal: 'Serena crosses the bridge.',
    synopsis: 'Serena takes the lantern.',
    scenes: [],
    characters: ['Serena Marsh'],
    characterArcs: '',
    canonEventIds: [],
    notes: '',
    targetWords: 100,
    ...overrides,
  };
}

function approvedProject(db: ReturnType<typeof tempDb>['db'], name: string) {
  const project = seedProject(db, name);
  const outline = planner.saveOutline(db, project.id, {
    premise: 'Serena crosses the bridge.',
    divergence: 'She takes the third lantern.',
    chapters: [chapterOutline()],
    status: 'draft',
  });
  planner.approveOutline(db, project.id, outline.id);
  return project;
}

function emptyBundle(): controller.ContextBundle {
  return {
    memoryText: '',
    canonText: '',
    connectedText: '',
    previousTail: '',
    focus: [],
    requests: [],
  };
}

function scripted(responses: Array<string | ((req: ChatRequest) => string)>) {
  const calls: ChatRequest[] = [];
  let index = 0;
  const llm = new MockProvider();
  llm.handler = (req) => {
    calls.push(structuredClone(req));
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return typeof next === 'function' ? next(req) : (next ?? 'A sufficiently long final response.');
  };
  return { llm, calls };
}

function contextLlm() {
  const llm = new MockProvider();
  llm.handler = (req) => {
    const system = req.system ?? '';
    if (system.includes('Lore Researcher')) {
      return JSON.stringify({ facts: ['A canon fact [S1]'], scenes: [], cautions: [] });
    }
    if (system.includes('expand a lore question')) return '{"terms":["bridge"]}';
    return '{}';
  };
  return llm;
}

function events(db: ReturnType<typeof tempDb>['db'], traceId: string) {
  const view = trace.showTrace(db, traceId);
  assert.ok(view, 'trace exists');
  return view.events;
}

test('tracing on/off sends identical ChatRequests and stores the same chapter', async () => {
  const run = async (traced: boolean) => {
    const { db } = tempDb();
    const project = approvedProject(db, `write-parity-${traced}`);
    const { llm, calls } = scripted(['The bridge stood in the rain, and Serena crossed it.']);
    const result = await controller.writeChapter(db, llm, project.id, {
      chapterNumber: 1,
      bundle: emptyBundle(),
      targetWords: 1,
      skipContinuity: true,
      trace: traced,
    });
    const body = result.chapter.body;
    const stats = result.stats;
    db.close();
    return { calls, body, stats };
  };

  const plain = await run(false);
  const traced = await run(true);
  assert.deepEqual(traced.calls, plain.calls, 'actual request objects are identical');
  assert.equal(traced.body, plain.body);
  assert.deepEqual(traced.stats, plain.stats);
});

test('single-part writes expose lifecycle, prompt and storage without extra calls', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-single');
  const { llm, calls } = scripted(['The bridge stood in the rain, and Serena crossed it before dawn.']);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.ok(writeTraceId);
  assert.equal(calls.length, 1);
  const list = events(db, writeTraceId!);
  assert.ok(list.some((event) => event.event === 'write.started'));
  assert.ok(list.some((event) => event.event === 'write.prompt.built'));
  assert.ok(list.some((event) => event.event === 'write.prompt.section'));
  assert.ok(list.some((event) => event.event === 'write.model.started' && event.promptHash));
  assert.ok(list.some((event) => event.event === 'write.model.message'));
  assert.ok(list.some((event) => event.event === 'write.model.completed'));
  assert.ok(list.some((event) => event.event === 'write.output.final'));
  assert.ok(list.some((event) => event.event === 'write.stored'));
  assert.ok(list.some((event) => event.event === 'write.completed'));
  assert.equal(result.chapter.body, 'The bridge stood in the rain, and Serena crossed it before dawn.');
  db.close();
});

test('multipart writes give every part an initial call and track previous/beats', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-parts');
  const { llm, calls } = scripted([
    'The first part ends here with enough words to stand.',
    'The second part continues from the first part.',
    'The third part closes after the second.',
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    segments: 3,
    contextLimits: { maxRounds: 0, maxRequests: 10 },
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 3, 'one initial call per part even with no follow-up budget');
  assert.match(result.chapter.body, /first part/);
  assert.match(result.chapter.body, /second part/);
  assert.match(result.chapter.body, /third part/);
  const list = events(db, writeTraceId!);
  assert.equal(list.filter((event) => event.event === 'write.part.started').length, 3);
  assert.equal(list.filter((event) => event.event === 'write.part.completed').length, 3);
  assert.ok(!list.some((event) => event.event === 'write.part.skipped'));
  assert.ok(list.some((event) => event.event === 'write.part.started' && event.refs.part === 2));
  assert.ok(
    list.some(
      (event) =>
        event.event === 'write.prompt.built' &&
        event.refs.part === 2 &&
        Number(event.refs.previous_chars) > 0,
    ),
  );
  db.close();
});

test('a protocol-only later response is traced empty and does not erase stored prose', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-protocol-only-later');
  const { llm, calls } = scripted([
    'KEEP THIS STORY PROSE.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    '[[META]]\n{"summary":"only metadata"}\n[[END]]',
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.chapter.body, 'KEEP THIS STORY PROSE.');
  const list = events(db, writeTraceId!);
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 2);
  assert.equal(dispositions[0]?.decision, 'included');
  assert.equal(dispositions[1]?.decision, 'empty');
  assert.equal(dispositions[1]?.refs.contributed_chars, 0);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('repeated and partially overlapping single-part output is stored once and traced accurately', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-overlap');
  const paragraphA = 'Paragraph A is long enough to be treated as a real story paragraph.';
  const { llm, calls } = scripted([
    `${paragraphA}\n\n[[CONTEXT]]\n{"kind":"au","query":"first"}\n[[END]]`,
    `${paragraphA}\n\nParagraph B adds new action.\n\n[[CONTEXT]]\n{"kind":"au","query":"second"}\n[[END]]`,
    paragraphA,
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.chapter.body.match(/Paragraph A is long enough/g)?.length, 1);
  assert.match(result.chapter.body, /Paragraph B adds new action/);
  const list = events(db, writeTraceId!);
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 3);
  assert.deepEqual(
    dispositions.map((event) => event.decision),
    ['included', 'included', 'superseded'],
  );
  assert.ok(Number(dispositions[1]?.refs.contributed_chars) > 0);
  assert.ok(Number(dispositions[2]?.refs.overlap_chars) > 0);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('six parts with defaults and requests keep every initial call', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-six-parts');
  let n = 0;
  const { llm, calls } = scripted([
    () => {
      n++;
      return `PART ${n} DISTINCT PROSE.\n\n[[CONTEXT]]\n{"kind":"au","query":"question ${n}"}\n[[END]]`;
    },
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1200,
    segments: 6,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 10, 'six initial calls plus four additional calls');
  assert.equal(result.stats.initialCalls, 6);
  assert.equal(result.stats.additionalCalls, 4);
  assert.equal(result.stats.unansweredRequests, 6);
  assert.match(result.chapter.body, /PART 1 DISTINCT PROSE/);
  assert.match(result.chapter.body, /PART 6 DISTINCT PROSE/);
  assert.match(result.chapter.body, /PART 10 DISTINCT PROSE/);
  const list = events(db, writeTraceId!);
  assert.equal(list.filter((event) => event.event === 'write.prompt.built').length, 6);
  assert.equal(list.filter((event) => event.event === 'write.part.started').length, 6);
  assert.equal(list.filter((event) => event.event === 'write.part.completed').length, 6);
  assert.ok(!list.some((event) => event.event === 'write.part.skipped'));
  assert.equal(
    list.filter((event) => event.event === 'write.request.unanswered').length,
    6,
  );
  const completed = list.find((event) => event.event === 'write.completed');
  assert.equal(completed?.refs.unanswered_requests, 6);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  assert.ok(audit?.limitations.some((item) => /unanswered/.test(item)));
  db.close();
});

test('two continuation calls retain both instructions and assistant responses', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-two-continuations');
  const first = 'The first short beat opens the chapter.';
  const second = 'A second short beat carries the action forward.';
  const third = 'A third short beat closes the scene.';
  const { llm, calls } = scripted([first, second, third]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 100,
    maxContinuations: 2,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.stats.continuations, 2);
  assert.ok(result.chapter.body.includes(first));
  assert.ok(result.chapter.body.includes(second));
  assert.ok(result.chapter.body.includes(third));
  assert.deepEqual(
    calls.map((request) => request.messages.map((message) => message.role)),
    [
      ['user'],
      ['user', 'assistant', 'user'],
      ['user', 'assistant', 'user', 'assistant', 'user'],
    ],
  );
  assert.match(calls[2]!.messages[1]!.content, /first short beat/);
  assert.match(calls[2]!.messages[2]!.content, /THE CHAPTER SO FAR/);
  assert.match(calls[2]!.messages[3]!.content, /second short beat/);
  assert.match(calls[2]!.messages[4]!.content, /THE CHAPTER SO FAR/);
  const list = events(db, writeTraceId!);
  assert.equal(list.filter((event) => event.event === 'write.continuation.started').length, 2);
  assert.equal(list.filter((event) => event.event === 'write.continuation.completed').length, 2);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('an early part ending in unmarked metadata does not cut later part prose', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-early-bare-metadata');
  const first = 'This is the first surviving paragraph of the chapter.';
  const second = 'This is the second surviving paragraph of the chapter.';
  const { llm, calls } = scripted([
    `${first}\n{"summary":"bare metadata without markers"}`,
    second,
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 20,
    segments: 2,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(result.chapter.body.includes(first));
  assert.ok(result.chapter.body.includes(second));
  assert.ok(!result.chapter.body.includes('bare metadata'));
  const list = events(db, writeTraceId!);
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 2);
  assert.deepEqual(dispositions.map((event) => event.decision), ['included', 'included']);
  assert.equal(dispositions[1]?.refs.contributed_chars, second.length);
  assert.equal(dispositions[1]?.refs.deduped_chars, 0);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('resolved context answers are consumed only by the later writer call', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-request-consumed');
  const { llm, calls } = scripted([
    'First half only.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    'Second half final response.',
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.chapter.body, 'First half only.\n\nSecond half final response.');
  assert.match(result.chapter.body, /First half only/);
  assert.match(result.chapter.body, /Second half final response/);
  const list = events(db, writeTraceId!);
  assert.equal(list.filter((event) => event.event === 'write.prompt.built').length, 1);
  assert.ok(list.some((event) => event.event === 'write.request.resolved'));
  assert.ok(list.some((event) => event.event === 'write.answer.consumed'));
  assert.ok(
    list.some(
      (event) =>
        event.event === 'write.answer.consumed' &&
        event.spanId.startsWith('sp-write-call-'),
    ),
  );
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 2);
  assert.ok(dispositions.every((event) => event.decision === 'included'));
  assert.ok(dispositions.every((event) => Number(event.refs.contributed_chars) > 0));
  assert.ok(!dispositions.some((event) => event.decision === 'superseded'));
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('requests arriving with no additional writer budget are unanswered', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-request-unconsumed');
  const { llm, calls } = scripted([
    'First answer request.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    contextLimits: { maxRounds: 0, maxRequests: 10 },
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 1, 'no follow-up call is made when maxRounds is 0');
  assert.equal(result.chapter.body, 'First answer request.');
  const list = events(db, writeTraceId!);
  assert.ok(list.some((event) => event.event === 'write.request.unanswered'));
  assert.ok(!list.some((event) => event.event === 'write.request.resolved'));
  assert.ok(!list.some((event) => event.event === 'write.answer.not-included'));
  assert.ok(!list.some((event) => event.event === 'write.answer.consumed'));
  const completed = list.find((event) => event.event === 'write.completed');
  assert.equal(completed?.refs.unanswered_requests, 1);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  assert.ok(audit?.limitations.some((item) => /unanswered/.test(item)));
  db.close();
});

test('an answered request left without a writer call is traced not-included', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'write-unconsumed');
  const started = trace.startTrace(db, {
    projectId: project.id,
    metadata: { command: 'write chapter' },
  });
  const writeTrace = new WriteTrace(db, project.id, started.id, {
    chapterNumber: 1,
    mode: 'write',
    existing: false,
    targetWords: 1,
  });
  const llm = scripted([
    'Prose before the resolver fails.\n\n' +
      '[[CONTEXT]]\n{"kind":"au","query":"one"}\n[[END]]\n' +
      '[[CONTEXT]]\n{"kind":"au","query":"two"}\n[[END]]',
  ]).llm;
  let resolved = 0;
  await assert.rejects(
    writeChapter(
      llm,
      { chapterNumber: 1, memoryText: '', canonText: '', segments: 1, targetWords: 1, trace: writeTrace },
      async (req, ctx) => {
        resolved++;
        if (resolved === 1) {
          const answer = { label: 'answer one', kind: 'au' as const, content: 'ANSWER ONE' };
          if (ctx) {
            writeTrace.requestOutcome(ctx, req, 'resolved', answer, {
              status: 'resolved',
              resultCount: 1,
            });
          }
          return answer;
        }
        throw new Error('resolver failed');
      },
      { maxRounds: 2, maxRequests: 10 },
    ),
    /resolver failed/,
  );
  writeTrace.failed('write-error');
  writeTrace.finish(true);
  const list = events(db, started.id);
  assert.equal(list.filter((event) => event.event === 'write.answer.not-included').length, 1);
  assert.equal(list.filter((event) => event.event === 'write.answer.consumed').length, 0);
  const audit = trace.auditTrace(db, started.id);
  assert.equal(audit?.exhaustive, false);
  db.close();
});

test('simultaneous request-slot and round-budget limits remain distinct', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-simultaneous-limits');
  const { llm, calls } = scripted([
    'First prose.\n\n' +
      '[[CONTEXT]]\n{"kind":"au","query":"first"}\n[[END]]\n' +
      '[[CONTEXT]]\n{"kind":"au","query":"second"}\n[[END]]',
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    contextLimits: { maxRounds: 0, maxRequests: 1 },
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.chapter.body, 'First prose.');
  const list = events(db, writeTraceId!);
  assert.equal(list.filter((event) => event.event === 'write.request.unanswered').length, 1);
  assert.equal(list.filter((event) => event.event === 'write.request.not-processed').length, 1);
  assert.equal(list.filter((event) => event.event === 'write.request.resolved').length, 0);
  assert.equal(list.filter((event) => event.event === 'write.request.over-limit').length, 0);
  const completed = list.find((event) => event.event === 'write.completed');
  assert.equal(completed?.refs.unanswered_requests, 1);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  assert.ok(audit?.limitations.some((item) => /additional-call budget/.test(item)));
  assert.ok(audit?.limitations.some((item) => /slot limit/.test(item)));
  db.close();
});

test('near-duplicate removal updates main-output contribution counts', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-near-duplicate-main');
  const paragraphA = 'The rain fell steadily over the empty bridge while Serena watched the dark water below.';
  const paragraphA2 = 'The rain fell steadily over the empty bridge as Serena watched the dark water below.';
  const paragraphB = 'A lantern moved along the far bank and vanished behind the reeds.';
  const { llm } = scripted([
    `${paragraphA}\n\n[[CONTEXT]]\n{"kind":"au","query":"first"}\n[[END]]`,
    `${paragraphA2}\n\n${paragraphB}`,
  ]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    maxContinuations: 0,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.ok(result.chapter.body.includes(paragraphA));
  assert.ok(result.chapter.body.includes(paragraphB));
  assert.ok(!result.chapter.body.includes(paragraphA2));
  const list = events(db, writeTraceId!);
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 2);
  assert.deepEqual(dispositions.map((event) => event.decision), ['included', 'included']);
  assert.ok(Number(dispositions[1]?.refs.contributed_chars) > 0);
  assert.equal(dispositions[1]?.refs.contributed_chars, paragraphB.length);
  assert.equal(dispositions[1]?.refs.deduped_chars, paragraphA2.length);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('a later paragraph contained in an earlier survivor is not credited', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-substring-provenance');
  const paragraphA = 'The rain fell steadily over the empty bridge while Serena watched the dark water below.';
  const paragraphA2 = 'fell steadily over the empty bridge while Serena watched the dark water below.';
  const { llm } = scripted([paragraphA, paragraphA2]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 20,
    segments: 2,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(result.chapter.body, paragraphA);
  const list = events(db, writeTraceId!);
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 2);
  assert.deepEqual(dispositions.map((event) => event.decision), ['included', 'superseded']);
  assert.equal(dispositions[1]?.refs.contributed_chars, 0);
  assert.equal(dispositions[1]?.refs.deduped_chars, paragraphA2.length);
  assert.equal(
    list.find((event) => event.event === 'write.output.dedupe')?.refs.dropped_paragraphs,
    1,
  );
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('intermediate dedupe removals are counted once in stats and trace', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-dedupe-counter');
  const paragraphs = [
    'The first paragraph is long enough to be kept by the dedupe sweep.',
    'The second paragraph is different and also long enough to survive.',
    'The third paragraph carries a separate beat through the scene.',
    'The fourth paragraph adds another distinct piece of action.',
    'The fifth paragraph closes the sequence with a new detail.',
  ];
  const duplicate = paragraphs[0]!;
  const { llm } = scripted([[...paragraphs, duplicate].join('\n\n')]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    maxContinuations: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  const bodyParagraphs = result.chapter.body.split(/\n{2,}/).filter(Boolean);
  assert.equal(bodyParagraphs.length, 5);
  assert.equal((result.chapter.body.match(/The first paragraph/g) ?? []).length, 1);
  assert.equal(result.stats.droppedParagraphs, 1);
  const list = events(db, writeTraceId!);
  assert.equal(
    list.find((event) => event.event === 'write.output.dedupe')?.refs.dropped_paragraphs,
    1,
  );
  assert.equal(
    list.find((event) => event.event === 'write.completed')?.refs.dropped_paragraphs,
    1,
  );
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0]?.refs.deduped_chars, duplicate.length);
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('continuation removed by the final dedupe is traced superseded', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-near-duplicate-continuation');
  const paragraphA = 'The rain fell steadily over the empty bridge while Serena watched the dark water below.';
  const paragraphA2 = 'The rain fell steadily over the empty bridge as Serena watched the dark water below.';
  const { llm } = scripted([paragraphA, paragraphA2]);
  let writeTraceId: string | undefined;
  const result = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 100,
    maxContinuations: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(result.stats.continuations, 1);
  assert.equal(result.chapter.body, paragraphA);
  const list = events(db, writeTraceId!);
  const dispositions = list.filter((event) => event.event === 'write.output.disposition');
  assert.equal(dispositions.length, 2);
  assert.deepEqual(dispositions.map((event) => event.decision), ['included', 'superseded']);
  assert.equal(dispositions[1]?.refs.contributed_chars, 0);
  assert.equal(dispositions[1]?.refs.deduped_chars, paragraphA2.length);
  assert.ok(
    list.some(
      (event) =>
        event.event === 'write.continuation.completed' &&
        event.reasonCode === 'continuation-output',
    ),
  );
  const audit = trace.auditTrace(db, writeTraceId!);
  assert.deepEqual(audit?.violations, []);
  assert.equal(audit?.exhaustive, true);
  db.close();
});

test('duplicates, over-limit, empty and not-processed requests are distinct', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-request-outcomes');
  const sameTurn = scripted([
    'Two requests.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    'Final after duplicate requests.',
  ]);
  let trace1: string | undefined;
  await controller.writeChapter(db, sameTurn.llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      trace1 = id;
    },
  });
  const list1 = events(db, trace1!);
  assert.equal(list1.filter((event) => event.event === 'write.request.parsed').length, 2);
  assert.equal(list1.filter((event) => event.event === 'write.request.resolved').length, 2);
  assert.equal(list1.filter((event) => event.event === 'write.answer.consumed').length, 2);

  const acrossTurns = scripted([
    'First.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    'Same request again.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    'Final after duplicate turn.',
  ]);
  const { db: db2 } = tempDb();
  const project2 = approvedProject(db2, 'write-request-duplicate');
  let trace2: string | undefined;
  await controller.writeChapter(db2, acrossTurns.llm, project2.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      trace2 = id;
    },
  });
  assert.ok(events(db2, trace2!).some((event) => event.event === 'write.request.duplicate'));

  const over = scripted([
    'Over limit.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    'Final after limit.',
  ]);
  const { db: db3 } = tempDb();
  const project3 = approvedProject(db3, 'write-request-over');
  let trace3: string | undefined;
  await controller.writeChapter(db3, over.llm, project3.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    contextLimits: { maxRounds: 4, maxRequests: 0 },
    skipContinuity: true,
    onWriteTraceId: (id) => {
      trace3 = id;
    },
  });
  assert.ok(events(db3, trace3!).some((event) => event.event === 'write.request.over-limit'));

  const empty = scripted([
    'No match.\n\n[[CONTEXT]]\n{"kind":"memory","query":"nothing will match this"}\n[[END]]',
    'Final after empty.',
  ]);
  const { db: db4 } = tempDb();
  const project4 = approvedProject(db4, 'write-request-empty');
  let trace4: string | undefined;
  await controller.writeChapter(db4, empty.llm, project4.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      trace4 = id;
    },
  });
  assert.ok(events(db4, trace4!).some((event) => event.event === 'write.request.empty'));

  const notProcessed = scripted([
    'Two requests, one slot.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]\n[[CONTEXT]]\n{"kind":"au","query":"another change"}\n[[END]]',
    'Final after one request.',
  ]);
  const { db: db5 } = tempDb();
  const project5 = approvedProject(db5, 'write-request-not-processed');
  let trace5: string | undefined;
  await controller.writeChapter(db5, notProcessed.llm, project5.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    contextLimits: { maxRounds: 4, maxRequests: 1 },
    skipContinuity: true,
    onWriteTraceId: (id) => {
      trace5 = id;
    },
  });
  assert.ok(events(db5, trace5!).some((event) => event.event === 'write.request.not-processed'));

  db.close();
  db2.close();
  db3.close();
  db4.close();
  db5.close();
});

test('resolver denied is distinct from writer-side over-limit', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-request-denied');
  const existing = controller.saveChapter(db, project.id, 1, {
    title: 'Existing',
    body: 'Existing body.',
    status: 'draft',
  });
  db.run(
    `INSERT INTO context_request
       (project_id, chapter_id, requester, kind, query, result_count, status, created_at)
     VALUES (?, ?, 'writer', 'au', 'prior request', 0, 'resolved', ?)`,
    project.id,
    existing.id,
    AT,
  );
  const { llm } = scripted([
    'Request.\n\n[[CONTEXT]]\n{"kind":"au","query":"what changed"}\n[[END]]',
    'Final after denial.',
  ]);
  let writeTraceId: string | undefined;
  await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    contextLimits: { maxRounds: 4, maxRequests: 1 },
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  const list = events(db, writeTraceId!);
  assert.ok(list.some((event) => event.event === 'write.request.denied'));
  assert.ok(!list.some((event) => event.event === 'write.request.over-limit'));
  db.close();
});

test('continuation output is tracked as included, empty, or capped', async () => {
  const run = async (responses: string[], maxContinuations: number) => {
    const { db } = tempDb();
    const project = approvedProject(db, `write-cont-${Math.random()}`);
    const { llm } = scripted(responses);
    let writeTraceId: string | undefined;
    const result = await controller.writeChapter(db, llm, project.id, {
      chapterNumber: 1,
      bundle: emptyBundle(),
      targetWords: 80,
      maxContinuations,
      skipContinuity: true,
      onWriteTraceId: (id) => {
        writeTraceId = id;
      },
    });
    const list = events(db, writeTraceId!);
    db.close();
    return { result, list };
  };

  const completed = await run(
    ['Short start.', 'This continuation is long enough to add new words and move the chapter forward.'],
    1,
  );
  assert.ok(completed.list.some((event) => event.event === 'write.continuation.completed'));
  assert.ok(completed.list.some((event) => event.event === 'write.output.disposition' && event.decision === 'included'));

  const empty = await run(['Short start.', ''], 1);
  assert.ok(empty.list.some((event) => event.event === 'write.continuation.empty'));
  assert.ok(empty.list.some((event) => event.event === 'write.output.disposition' && event.decision === 'empty'));

  const capped = await run(['Short start.', 'Still short.', 'Still short again.'], 2);
  assert.ok(
    capped.list.filter((event) => event.event === 'write.continuation.started').length >= 2,
  );
  assert.equal(capped.result.stats.continuations, 2);

  const repetitive = await run(
    [
      'This repeated paragraph is long enough to count as a duplicate.\n\nThis repeated paragraph is long enough to count as a duplicate.',
      'This continuation is long enough to add new words and move the chapter forward with fresh action.',
    ],
    1,
  );
  assert.ok(
    repetitive.list.some(
      (event) =>
        event.event === 'write.continuation.started' &&
        event.reasonCode === 'repetitive',
    ),
  );
});

test('regenerate gets a distinct trace and supersedes the prior body', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-regenerate');
  const first = scripted(['First stored body with enough words to persist.']);
  const one = await controller.writeChapter(db, first.llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
  });
  const second = scripted(['Second stored body with new words.']);
  const two = await controller.writeChapter(db, second.llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
  });
  assert.ok(one.writeTraceId);
  assert.ok(two.writeTraceId);
  assert.notEqual(one.writeTraceId, two.writeTraceId);
  assert.equal(two.chapter.body, 'Second stored body with new words.');
  const list = events(db, two.writeTraceId!);
  assert.ok(list.some((event) => event.event === 'write.regenerate.prior' && event.refs.body_hash));
  assert.ok(list.some((event) => event.event === 'write.stored' && event.refs.body_hash));
  db.close();
});

test('supplied bundle and assembled context are distinguished and linked', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-context-source');
  const supplied = scripted(['Supplied bundle response with enough words.']);
  const result = await controller.writeChapter(db, supplied.llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
  });
  const suppliedEvents = events(db, result.writeTraceId!);
  assert.ok(suppliedEvents.some((event) => event.event === 'write.context.supplied'));
  assert.ok(!suppliedEvents.some((event) => event.event === 'write.context.linked'));

  const { db: db2 } = tempDb();
  const project2 = approvedProject(db2, 'write-context-assembled');
  const assembled = scripted(['Assembled response with enough words.']);
  const result2 = await controller.writeChapter(db2, assembled.llm, project2.id, {
    chapterNumber: 1,
    contextLlm: contextLlm(),
    targetWords: 1,
    skipContinuity: true,
  });
  assert.ok(result2.contextTraceId);
  assert.ok(result2.writeTraceId);
  const list = events(db2, result2.writeTraceId!);
  assert.ok(
    list.some(
      (event) =>
        event.event === 'write.context.linked' &&
        event.refs.context_trace_id === result2.contextTraceId,
    ),
  );
  assert.ok(trace.showTrace(db2, result2.contextTraceId!));
  db.close();
  db2.close();
});

test('diagnostic write failure leaves writing unchanged and makes audit non-exhaustive', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-trace-failure');
  const plain = scripted(['The body that must survive a trace failure.']);
  const plainResult = await controller.writeChapter(db, plain.llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    trace: false,
  });
  db.run(
    `CREATE TRIGGER fail_write_model_completed
       BEFORE INSERT ON trace_event
       WHEN NEW.event = 'write.model.completed'
     BEGIN
       SELECT RAISE(ABORT, 'forced write trace failure');
     END`,
  );
  let writeTraceId: string | undefined;
  const traced = scripted(['The body that must survive a trace failure.']);
  const tracedResult = await controller.writeChapter(db, traced.llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  assert.equal(tracedResult.chapter.body, plainResult.chapter.body);
  assert.deepEqual(traced.calls, plain.calls);
  const view = trace.showTrace(db, writeTraceId!);
  assert.ok(view);
  assert.ok(view!.trace.completeness === 'truncated' || view!.trace.completeness === 'interrupted');
  assert.ok(view!.trace.droppedEvents > 0);
  assert.equal(trace.auditTrace(db, writeTraceId!)?.exhaustive, false);
  assert.ok(trace.auditTrace(db, writeTraceId!)?.violations.some((item) => item.code === 'write_model_call_missing_terminal'));
  db.close();
});

test('write trace rows contain no prompt, response, query or prose text', async () => {
  const { db } = tempDb();
  const project = approvedProject(db, 'write-no-prose');
  const prompt = 'SECRET_PROMPT_TEXT that must not enter the ledger.';
  const response = 'SECRET_RESPONSE_TEXT that must not enter the ledger.';
  const { llm } = scripted([
    `Requesting context for SECRET_QUERY_TEXT.\n\n[[CONTEXT]]\n{"kind":"au","query":"SECRET_QUERY_TEXT"}\n[[END]]`,
    response,
  ]);
  let writeTraceId: string | undefined;
  await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: { ...emptyBundle(), memoryText: prompt },
    userInstructions: prompt,
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  const text = JSON.stringify(trace.showTrace(db, writeTraceId!));
  assert.ok(!text.includes(prompt));
  assert.ok(!text.includes(response));
  assert.ok(!text.includes('SECRET_QUERY_TEXT'));
  db.close();
});

test('write trace show/audit JSON and read-only CLI are valid', async () => {
  const { db, path } = tempDb();
  const project = approvedProject(db, 'write-cli');
  const { llm } = scripted(['Stored chapter body for CLI tracing.']);
  let writeTraceId: string | undefined;
  await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle: emptyBundle(),
    targetWords: 1,
    skipContinuity: true,
    onWriteTraceId: (id) => {
      writeTraceId = id;
    },
  });
  db.close();
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  const show = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, 'trace', 'show', writeTraceId!, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(show.status, 0, show.stderr);
  const view = JSON.parse(show.stdout) as { trace: { id: string }; events: unknown[] };
  assert.equal(view.trace.id, writeTraceId);
  const human = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, 'trace', 'show', writeTraceId!], {
    encoding: 'utf8',
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Write execution tree/);
  assert.match(human.stdout, /Write handoff/);
  const audit = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, 'trace', 'audit', writeTraceId!, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(audit.status, 0, audit.stderr);
  const result = JSON.parse(audit.stdout) as { traceId: string; exhaustive: boolean };
  assert.equal(result.traceId, writeTraceId);
  assert.equal(result.exhaustive, true);
  const after = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(after, before);
});
