/**
 * Recognition filter: off by default, opt-in via project settings or a request
 * override. The embedder is a local HTTP mock and the judge is a mock client;
 * no real model is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createProject,
  updateProjectSettings,
} from '../../fanfable/src/plan/controller.ts';
import { recognitionEnabled, retrieve } from '../../fanfable/src/answer/retrieval.ts';
import * as embeddings from '../../fanfable/src/support/embeddings.ts';
import type { EmbedFn } from '../../fanfable/src/support/embeddings.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const QUERY = 'who is the sibling of Astra';

/** Toy vectors by keyword: the query says sibling, the triples say brother. */
function keywordEmbed(): EmbedFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      const lower = t.toLowerCase();
      if (lower.includes('sibling') || lower.includes('brother')) return [1, 0, 0];
      if (lower.includes('bridge')) return [0, 1, 0];
      return [0, 0, 1];
    });
}

async function startEmbedServer() {
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/embed') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests++;
      let input: string[] = [];
      try {
        input = (JSON.parse(body) as { input?: string[] }).input ?? [];
      } catch {
        /* an empty batch below */
      }
      const vectors = input.map((t) => {
        const lower = String(t).toLowerCase();
        if (lower.includes('sibling') || lower.includes('brother')) return [1, 0, 0];
        if (lower.includes('bridge')) return [0, 1, 0];
        return [0, 0, 1];
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: vectors }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Astra -> Bram -> Cora, both triples saying "brother"; fake vectors stored. */
async function harness(name: string) {
  const { db } = tempDb();
  const project = seedProject(db, name);
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  const [c0, c1, c2] = chunks;
  const ids = new Map<string, number>();
  for (const [entityName, chunk] of [
    ['Astra', c0],
    ['Bram', c1],
    ['Cora', c2],
  ] as [string, { id: number; locator: string }][]) {
    ids.set(
      entityName,
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project.id,
        'character',
        entityName,
        `${entityName} appears here.`,
        JSON.stringify([{ source: 'sample', locator: chunk!.locator, chunk: chunk!.id }]),
        AT,
        AT,
      ).lastInsertRowid,
    );
  }
  const relate = (from: string, to: string, description: string): void => {
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      ids.get(from)!,
      ids.get(to)!,
      'sister of',
      description,
      AT,
    );
  };
  relate('Astra', 'Bram', 'Bram is the brother here.');
  relate('Astra', 'Cora', 'Cora is the brother here.');

  const counts = await embeddings.embedBackfill(db, project.id, {
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    embedFn: keywordEmbed(),
  });
  assert.ok(counts.embedded > 0, 'the fake vectors are stored');

  const embedServer = await startEmbedServer();
  updateProjectSettings(db, project.id, {
    embeddingModel: 'fake',
    embeddingBaseUrl: embedServer.url,
  });
  return { db, project, embedServer };
}

function judgeMock(opts: { fail?: boolean } = {}) {
  const systems: string[] = [];
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    systems.push(system);
    if (!system.includes('For each candidate')) {
      return JSON.stringify({ relations: [], entities: [], facts: [], timeline: [] });
    }
    if (opts.fail) throw new Error('judge unavailable');
    const user = req.messages.map((m) => m.content).join('\n');
    const ids = [...user.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]!);
    return JSON.stringify({ results: ids.map((id) => ({ id, supported: true })) });
  });
  return {
    llm,
    recognitionCalls: () => systems.filter((s) => s.includes('For each candidate')).length,
  };
}

test('the recognition resolver defaults off and honours overrides', () => {
  const { db } = tempDb();
  const project = createProject(db, 'recognition-resolver');
  assert.equal(recognitionEnabled(db, project.id), false, 'off with no setting');
  updateProjectSettings(db, project.id, { recognition: true });
  assert.equal(recognitionEnabled(db, project.id), true, 'project setting opts in');
  assert.equal(recognitionEnabled(db, project.id, false), false, 'request false wins');
  assert.equal(recognitionEnabled(db, project.id, true), true, 'request true wins');
  updateProjectSettings(db, project.id, { recognition: false });
  assert.equal(recognitionEnabled(db, project.id), false);
  assert.equal(recognitionEnabled(db, project.id, true), true, 'request can still opt in');
  db.run("UPDATE project SET settings = 'not json' WHERE id = ?", project.id);
  assert.equal(recognitionEnabled(db, project.id), false, 'a broken settings blob is off');
  db.close();
});

test('a default retrieve makes no recognition call even with dense seeds', async () => {
  const { db, project, embedServer } = await harness('recognition-default');
  const judge = judgeMock();
  const pkg = await retrieve(db, judge.llm, project.id, {
    query: QUERY,
    focus: ['Astra'],
    route: 'relational',
    hops: 1,
  });
  assert.ok(embedServer.requests() > 0, 'the dense path ran');
  assert.ok(pkg.graph.stats.ppr, 'the PPR path ran');
  assert.equal(pkg.stats.recognition, undefined, 'no recognition stats');
  assert.equal(judge.recognitionCalls(), 0, 'the judge was never called');
  db.close();
  await embedServer.close();
});

test('project.settings.recognition=true reaches the judge', async () => {
  const { db, project, embedServer } = await harness('recognition-setting-on');
  updateProjectSettings(db, project.id, { recognition: true });
  const judge = judgeMock();
  const pkg = await retrieve(db, judge.llm, project.id, {
    query: QUERY,
    focus: ['Astra'],
    route: 'relational',
    hops: 1,
  });
  assert.equal(judge.recognitionCalls(), 1, 'one filter call');
  assert.ok(pkg.stats.recognition, 'recognition stats are reported');
  assert.ok((pkg.stats.recognition?.checked ?? 0) > 0, 'candidates were checked');
  db.close();
  await embedServer.close();
});

test('an explicit request override wins in both directions', async () => {
  const { db, project, embedServer } = await harness('recognition-override');
  updateProjectSettings(db, project.id, { recognition: true });
  const offJudge = judgeMock();
  const off = await retrieve(db, offJudge.llm, project.id, {
    query: QUERY,
    focus: ['Astra'],
    route: 'relational',
    hops: 1,
    recognition: false,
  });
  assert.equal(offJudge.recognitionCalls(), 0, 'request false suppresses the setting');
  assert.equal(off.stats.recognition, undefined);

  updateProjectSettings(db, project.id, { recognition: false });
  const onJudge = judgeMock();
  const on = await retrieve(db, onJudge.llm, project.id, {
    query: QUERY,
    focus: ['Astra'],
    route: 'relational',
    hops: 1,
    recognition: true,
  });
  assert.equal(onJudge.recognitionCalls(), 1, 'request true opts in despite the setting');
  assert.ok(on.stats.recognition, 'stats follow the override');
  db.close();
  await embedServer.close();
});

test('a failing judge keeps the seeds and never throws', async () => {
  const { db, project, embedServer } = await harness('recognition-failopen');
  updateProjectSettings(db, project.id, { recognition: true });
  const judge = judgeMock({ fail: true });
  const pkg = await retrieve(db, judge.llm, project.id, {
    query: QUERY,
    focus: ['Astra'],
    route: 'relational',
    hops: 1,
  });
  assert.equal(judge.recognitionCalls(), 1, 'the filter was attempted');
  assert.equal(pkg.stats.recognition?.checked, 0, 'no verdict counted');
  assert.equal(pkg.stats.recognition?.dropped, 0, 'nothing dropped on error');
  assert.ok((pkg.stats.recognition?.kept ?? 0) > 0, 'seeds stay kept');
  db.close();
  await embedServer.close();
});
