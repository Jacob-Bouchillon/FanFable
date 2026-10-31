import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient } from '../../fanfable/src/llm.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const OUTLINE_JSON = {
  premise: 'Serena crosses the bridge at Ardenne before dawn.',
  divergence: 'Serena takes the third lantern instead of leaving it in the tower.',
  chapters: [
    {
      number: 1,
      title: 'The Third Lantern',
      goal: 'Serena crosses the bridge',
      synopsis: 'Serena takes the third lantern and crosses at dawn.',
      scenes: [],
      characters: ['Serena Marsh'],
      canon_event_ids: [],
      target_words: 120,
    },
  ],
  preferences: { tone: 'cold' },
};

/** A model that answers a context request, and a model that writes prose. */
function twoModels() {
  const contextCalls: string[] = [];
  const contextLlm = mockProvider((req) => {
    contextCalls.push(req.system ?? '');
    if ((req.system ?? '').includes('expand a lore question')) return '{"terms":["bridge"]}';
    return 'Serena took the third lantern and crossed at dawn.';
  });
  const writeCalls: string[] = [];
  const writeLlm = mockProvider((req) => {
    writeCalls.push(req.system ?? '');
    if ((req.system ?? '').includes('Story Writer')) {
      return 'The bridge at Ardenne still stood, and the rain had not stopped for three days.';
    }
    if ((req.system ?? '').includes('Continuity Checker')) return '{"issues":[]}';
    return '{}';
  });
  return { contextLlm, writeLlm, contextCalls, writeCalls };
}

async function approvedProject(db: ReturnType<typeof tempDb>['db']) {
  const project = seedProject(db, 'context-model');
  const data = await planner.draftOutline(mockProvider(() => JSON.stringify(OUTLINE_JSON)), {
    premise: OUTLINE_JSON.premise,
    chapterCount: 1,
  });
  const draft = planner.saveOutline(db, project.id, { ...data, status: 'draft' });
  planner.approveOutline(db, project.id, draft.id);
  return project;
}

test('the writing model and the context model can be different', async () => {
  const { db } = tempDb();
  const project = await approvedProject(db);
  const { contextLlm, writeLlm, contextCalls, writeCalls } = twoModels();

  const result = await controller.writeChapter(db, writeLlm, project.id, {
    chapterNumber: 1,
    contextLlm,
  });

  assert.ok(result.chapter.body.includes('bridge'));
  // The context was assembled and the writer's request answered by the
  // context model, not by the writing model.
  assert.ok(contextCalls.length > 0, 'the context model was used for the context');
  assert.ok(
    writeCalls.every((s) => !s.includes('expand a lore question')),
    'the writing model was not asked to expand a query',
  );
});

test('a pre-assembled context is used as it is', async () => {
  const { db } = tempDb();
  const project = await approvedProject(db);
  const { contextLlm, writeLlm, contextCalls } = twoModels();

  const bundle = await controller.assembleContext(db, contextLlm, project.id, {
    chapterNumber: 1,
  });
  const callsAfterAssembly = contextCalls.length;

  await controller.writeChapter(db, writeLlm, project.id, {
    chapterNumber: 1,
    bundle,
    contextLlm,
  });

  // The context was not assembled a second time: the same one was used.
  assert.equal(contextCalls.length, callsAfterAssembly);
});

test('the continuity check can be left out of a draft', async () => {
  const { db } = tempDb();
  const project = await approvedProject(db);
  const { contextLlm, writeLlm, writeCalls } = twoModels();

  const result = await controller.writeChapter(db, writeLlm, project.id, {
    chapterNumber: 1,
    contextLlm,
    skipContinuity: true,
  });

  assert.equal(result.issues.length, 0);
  assert.ok(!writeCalls.some((s) => s.includes('Continuity Checker')));
});

test('a model that thinks out loud can be told not to', async () => {
  // The provider must pass the setting on, so a thinking model does not spend
  // the answer's token budget on its reasoning.
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const client = createClient({
      provider: 'ollama',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'm',
      seed: 42,
      think: false,
    });
    await client.chat({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(received[0].think, false);
    assert.equal(received[0].options.seed, 42);
    assert.equal(received[0].options.num_ctx, 16384);
  } finally {
    server.close();
  }
});
