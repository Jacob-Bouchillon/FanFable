import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { Db } from '../../fanfable/src/core/db.ts';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { startServer } from '../../fanfable/src/product/server.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

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

test('an empty project reports a truthful empty extraction result through the API', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'empty-server');
  controller.updateProjectSettings(db, project.id, { provider: 'mock' });
  const server: Server = startServer({ db, projectId: project.id, port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const start = await fetch(`${base}/api/book-lore/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(start.status, 200);
    const { jobId } = (await start.json()) as { jobId: string };
    let job: { status: string; result?: { emptySource?: boolean; entities?: number; windows?: number } } = {
      status: 'running',
    };
    for (let i = 0; i < 50; i++) {
      job = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as typeof job;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(job.status, 'done');
    assert.equal(job.result?.emptySource, true);
    assert.equal(job.result?.entities, 0);
    assert.equal(job.result?.windows, 0);
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_run WHERE project_id = ?', project.id)?.n,
      0,
      'an empty source does not create extraction provenance',
    );
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_parent WHERE project_id = ?', project.id)?.n,
      0,
      'an empty source does not create a recovery parent',
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test('explicit staging mode forces the staging boundary for a mock provider', async () => {
  await withServer(async (base, projectId, db) => {
    const start = await fetch(`${base}/api/book-lore/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(start.status, 200);
    const { jobId } = (await start.json()) as { jobId: string };
    let job: { status: string; result?: { stageOnly?: boolean; recovery?: { readiness?: string } } } = {
      status: 'running',
    };
    for (let i = 0; i < 120; i++) {
      job = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as typeof job;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(job.status, 'done');
    assert.equal(job.result?.stageOnly, true);
    assert.equal(job.result?.recovery?.readiness, 'staged_only');
    for (const table of ['canon_entity', 'canon_fact', 'canon_relation', 'canon_timeline', 'extraction_run', 'embedding']) {
      assert.equal(
        db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n,
        0,
        `${table} is untouched by forced staging`,
      );
    }
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', projectId)?.n,
      0,
      'staging never sets mined flags',
    );
  });
});

test('a second stage-only extraction job is rejected safely and writes no canon', async () => {
  await withServer(async (base, projectId, db) => {
    const serena = {
      kind: 'character',
      name: 'Serena Marsh',
      aliases: [],
      summary: '',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const llm = mockProvider((req) => {
      const system = req.system ?? '';
      if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
      if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
      return JSON.stringify({ entities: [serena], facts: [] });
    });
    const baseChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return { ...(await baseChat(req)), finishReason: 'stop' as const };
    };
    const direct = lorebook.extractLore(db, llm, projectId, {
      windowSize: 8,
      concurrency: 1,
      recovery: { stageOnly: true },
    });
    await startedPromise;
    let directResult: Awaited<ReturnType<typeof lorebook.extractLore>> | undefined;
    try {
      const parentsBefore = db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM extraction_recovery_parent WHERE project_id = ?',
        projectId,
      )?.n ?? 0;
      const start = await fetch(`${base}/api/book-lore/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(start.status, 200);
      const { jobId } = (await start.json()) as { jobId: string };
      let job: { status: string; error?: string; message?: string } = { status: 'running' };
      for (let i = 0; i < 120; i++) {
        job = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as typeof job;
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const busy = 'stage-only extraction is already running for this project; ' +
        'only one extraction process per project may run at a time';
      assert.equal(job.status, 'error');
      assert.equal(job.error, busy);
      assert.equal(job.message, busy);
      assert.equal(calls, 1, 'the rejected job never reaches a provider');
      assert.equal(
        db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM extraction_recovery_parent WHERE project_id = ?',
          projectId,
        )?.n,
        parentsBefore,
        'the rejected job creates no recovery parent',
      );
      assert.equal(
        db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM extraction_run WHERE project_id = ?',
          projectId,
        )?.n,
        0,
      );
      assert.equal(
        db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
          projectId,
        )?.n,
        0,
      );
    } finally {
      release();
      directResult = await direct;
    }
    assert.equal(directResult?.recovery?.status, 'complete');
    for (const table of ['canon_entity', 'canon_fact', 'canon_relation', 'canon_timeline']) {
      assert.equal(
        db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n,
        0,
        `${table} remains untouched by stage-only extraction`,
      );
    }
    assert.ok(
      (db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'entity' AND disposition = 'staged'",
      )?.n ?? 0) > 0,
      'the active stage-only run keeps its staged contribution',
    );
  });
});

test('browser job serialization redacts raw window errors but keeps safe failure counts', async () => {
  await withServer(async (base, projectId, db) => {
    const secret = 'SENTINEL_SERVER_SECRET_WINDOW_ERROR';
    db.exec(`
      CREATE TRIGGER synthetic_browser_error
      BEFORE INSERT ON extraction_chunk_lease
      BEGIN SELECT RAISE(ABORT, '${secret}'); END;
    `);
    try {
      const start = await fetch(`${base}/api/book-lore/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(start.status, 200);
      const { jobId } = (await start.json()) as { jobId: string };
      let job: {
        status: string;
        result?: {
          executionFailures?: number;
          emptyWindows?: Array<{ reason?: string; detail?: string }>;
          windowIssues?: Array<{ detail?: string }>;
        };
      } = { status: 'running' };
      for (let i = 0; i < 120; i++) {
        job = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as typeof job;
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(job.status, 'done');
      assert.ok((job.result?.executionFailures ?? 0) >= 1);
      assert.equal(job.result?.emptyWindows?.[0]?.reason, 'error');
      assert.equal(job.result?.emptyWindows?.[0]?.detail, undefined);
      assert.equal(job.result?.windowIssues?.every((entry) => entry.detail === undefined), true);
      assert.equal(JSON.stringify(job).includes(secret), false, 'raw error text is not browser-facing');
    } finally {
      db.exec('DROP TRIGGER synthetic_browser_error');
    }
  });
});

test('extraction progress never exposes raw note-ingestion errors', async () => {
  await withServer(async (base, projectId, db) => {
    const secret = 'SENTINEL_PROGRESS_SECRET_NOTE_ERROR';
    db.exec(`
      CREATE TRIGGER synthetic_progress_error
      BEFORE INSERT ON trace
      BEGIN SELECT RAISE(ABORT, '${secret}'); END;
    `);
    try {
      const start = await fetch(`${base}/api/book-lore/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ legacy: true }),
      });
      assert.equal(start.status, 200);
      const { jobId } = (await start.json()) as { jobId: string };
      let job: { status: string; message?: string; result?: unknown } = { status: 'running' };
      const observed: string[] = [];
      for (let i = 0; i < 300; i++) {
        job = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as typeof job;
        observed.push(JSON.stringify(job));
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(job.status, 'done');
      assert.equal(observed.some((payload) => payload.includes(secret)), false);
      const lorebookSource = readFileSync(new URL('../../fanfable/src/lorebook.ts', import.meta.url), 'utf8');
      assert.match(lorebookSource, /note ingestion skipped for window.*see diagnostics/);
      assert.doesNotMatch(lorebookSource, /note ingestion skipped[^\n]*err\.message/);
    } finally {
      db.exec('DROP TRIGGER synthetic_progress_error');
    }
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
