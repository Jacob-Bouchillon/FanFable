import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { Db } from '../../fanfable/src/core/db.ts';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { startServer } from '../../fanfable/src/product/server.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { seedProject, tempDb } from './helpers.ts';

/** Start the UI server on a free port and hand the base URL to the test. */
async function withServer(fn: (base: string, projectId: number, db: Db) => Promise<void>): Promise<void> {
  const { db } = tempDb();
  const project = seedProject(db, 'server');
  // The mock provider keeps the tests offline and instant.
  controller.updateProjectSettings(db, project.id, { provider: 'mock' });
  const server: Server = startServer({ db, projectId: project.id, port: 0 });
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, project.id, db);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

test('the UI API serves the project state', async () => {
  await withServer(async (base, projectId) => {
    const session = (await (await fetch(`${base}/api/session`)).json()) as {
      projects: unknown[];
      currentProjectId: number;
    };
    assert.ok(session.projects.length >= 1);
    assert.equal(session.currentProjectId, projectId);

    const dash = (await (await fetch(`${base}/api/dashboard`)).json()) as {
      counts: { sources: number };
      project: { name: string };
    };
    assert.equal(dash.counts.sources, 1);
    assert.equal(dash.project.name, 'server');

    const lore = (await (await fetch(`${base}/api/lore?q=bridge`)).json()) as {
      passages: { sourceTitle: string }[];
    };
    assert.ok(lore.passages.length > 0, 'canon search works through the API');
    assert.ok(lore.passages[0].sourceTitle.length > 0);
  });
});

test('the local API refuses foreign origins and DNS-rebinding hosts', async () => {
  await withServer(async (base) => {
    const forbiddenHeaders: Record<string, string>[] = [
      { origin: 'https://untrusted.example' },
      { origin: 'null' },
      { host: 'untrusted.example' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of forbiddenHeaders) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${base}/api/story-state/fact`, {
          method: 'POST', headers: { ...headers, 'content-type': 'text/plain' },
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end(JSON.stringify({ kind: 'promise', subject: 'Ilsa', content: 'unwanted change' }));
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
    const response = await fetch(`${base}/api/story-state/fact`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'promise', subject: 'Ilsa', content: 'allowed change' }),
    });
    assert.equal(response.status, 200);
    const state = await (await fetch(`${base}/api/story-state`)).json() as { facts: { content: string }[] };
    assert.deepEqual(state.facts.map(f => f.content), ['allowed change']);
  });
});

test('JSON endpoints reject non-object bodies as client errors', async () => {
  await withServer(async (base) => {
    for (const body of ['null', '[]', '42', '"text"']) {
      const response = await fetch(`${base}/api/story-state/fact`, { method: 'POST', body });
      assert.equal(response.status, 400);
    }
  });
});

test('session output never exposes a project API key', async () => {
  await withServer(async (base, projectId, db) => {
    controller.updateProjectSettings(db, projectId, { apiKey: 'private-project-key' });
    const session = await (await fetch(`${base}/api/session`)).json() as { model: Record<string, unknown> };
    assert.equal(session.model.apiKey, undefined);
  });
});

test('request bodies preserve UTF-8 characters split across network chunks', async () => {
  await withServer(async (base) => {
    const body = Buffer.from(JSON.stringify({ kind: 'promise', subject: 'Ilsa', content: 'café 🌙' }));
    const split = body.indexOf(Buffer.from('é')) + 1;
    await new Promise<void>((resolve, reject) => {
      const req = request(`${base}/api/story-state/fact`, { method: 'POST' }, res => {
        res.resume();
        res.on('end', () => {
          try { assert.equal(res.statusCode, 200); resolve(); } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.write(body.subarray(0, split));
      setTimeout(() => req.end(body.subarray(split)), 10);
    });
    const state = await (await fetch(`${base}/api/story-state`)).json() as { facts: { content: string }[] };
    assert.equal(state.facts[0].content, 'café 🌙');
  });
});

test('the UI API can record a fact and read it back', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/story-state/fact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'promise', subject: 'Ilsa', content: 'Ilsa will not tell Kade' }),
    });
    assert.equal(res.status, 200);

    const state = (await (await fetch(`${base}/api/story-state`)).json()) as {
      facts: { kind: string; content: string }[];
    };
    const fact = state.facts.find((f: { content: string }) => f.content.includes('Ilsa will not tell Kade'));
    assert.ok(fact, 'the fact is stored');
    assert.equal(fact.kind, 'promise');
  });
});

test('model calls run as jobs the page can poll', async () => {
  await withServer(async (base) => {
    const start = await fetch(`${base}/api/lore/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Who is Kade?' }),
    });
    const { jobId } = (await start.json()) as { jobId: string };
    assert.ok(jobId);

    let job: { status: string; result?: { answer: string } };
    for (let i = 0; i < 50; i++) {
      job = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as typeof job;
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(job!.status, 'running', 'the job finished');
    assert.equal(job!.status, 'done');
    assert.ok(job!.result?.answer !== undefined);
  });
});

test('the static interface is served', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /fanfable/);
    assert.match(html, /\/ui\/style\.css/);

    const css = await fetch(`${base}/ui/style.css`);
    assert.equal(css.status, 200);
    const js = await fetch(`${base}/ui/app.js`);
    assert.equal(js.status, 200);
    for (const path of ['/ui/dev-viz.html', '/ui/%64ev-viz.html', '/ui/%64ev-viz.js']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  });
});
