/**
 * Local web UI.
 *
 * A browser front end over the same controller the CLI uses: sources, canon
 * search, planning, chapter writing and approval, story state, continuity
 * warnings and model settings.
 *
 * Model calls take seconds to minutes, so anything that talks to the model is
 * run as a background job and polled by the page.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { Db } from '../core/db.ts';
import * as controller from '../plan/controller.ts';
import * as lore from '../answer/lore.ts';
import * as lorebook from '../lorebook.ts';
import * as embeddings from '../support/embeddings.ts';
import * as graph from '../support/graph.ts';
import * as loreDiag from '../answer/lore-diagnostics.ts';
import { listConflicts, resolveConflict } from './state-conflicts.ts';
import * as memory from './memory.ts';
import * as planner from '../plan/planner.ts';
import * as continuity from './continuity.ts';
import { DEFAULT_LLM_SETTINGS, clientFrom, loadGlobalConfig, saveGlobalConfig } from '../core/llm.ts';
import { DEFAULT_CONTINUITY_SETTINGS, continuitySettings } from './continuity-settings.ts';
import { devGraphSummary } from './dev-summary.ts';
import { buildWebGraph, buildWebMap, webPersonDossier, webThreadDetail } from './web3d.ts';
import { loadBookNlp } from './booknlp.ts';

/**
 * Settings returned to the UI never carry the whole API key.
 *
 * The prefix/suffix shape is only safe while it leaves characters hidden. At
 * 6+4 revealed, any key of 10 or fewer characters was printed in full by the
 * old code (`abc…ghij` is the entire key). Real keys are far longer than that,
 * so the shape is kept for anything 16 characters or more and shorter values
 * are masked completely.
 */
export function maskSettingsForOutput<T extends Record<string, unknown>>(settings: T): T {
  const copy = { ...settings } as Record<string, unknown>;
  if (typeof copy.apiKey === 'string' && copy.apiKey) {
    copy.apiKey = copy.apiKey.length >= 16
      ? `${copy.apiKey.slice(0, 6)}…${copy.apiKey.slice(-4)}`
      : '••••••••';
  }
  return copy as T;
}

const UI_DIR = join(import.meta.dirname, '../ui');

/**
 * The dev visualizer is opt-in. It is a separate page and a separate
 * read-only summary route; the ship UI never links to either. `--dev` on the
 * CLI and FANFABLE_DEV=1 are the only ways in.
 */
const DEV_ENABLED = process.env.FANFABLE_DEV === '1' || process.argv.includes('--dev');

/* ------------------------------------------------------------------- jobs */

interface Job {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  message: string;
  result?: unknown;
  error?: string;
  /** Fixed public text for a known-safe rejection; raw errors stay server-side. */
  publicError?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

/** Keep the map bounded: finished jobs are only needed long enough to poll. */
const MAX_FINISHED_JOBS = 50;

function pruneJobs(): void {
  if (jobs.size <= MAX_FINISHED_JOBS) return;
  for (const [id, job] of jobs) {
    if (job.status === 'running') continue;
    jobs.delete(id);
    if (jobs.size <= MAX_FINISHED_JOBS) break;
  }
}

function startJob(
  name: string,
  fn: (progress: (message: string) => void) => Promise<unknown>,
): { id: string } {
  pruneJobs();
  const id = `job-${++jobCounter}`;
  const job: Job = { id, name, status: 'running', message: 'starting', startedAt: Date.now() };
  jobs.set(id, job);
  void (async () => {
    try {
      job.result = await fn((m) => {
        job.message = m;
      });
      job.status = 'done';
      job.message = 'done';
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      if (err instanceof lorebook.StageOnlyExtractionBusyError) {
        job.publicError = lorebook.StageOnlyExtractionBusyError.publicMessage;
      }
      job.message = job.publicError ?? job.error;
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return { id };
}

/** Diagnostic entries exposed to the browser never carry raw exception text. */
function publicDiagnosticList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const copy = { ...(entry as Record<string, unknown>) };
    delete copy.detail;
    if (Array.isArray(copy.sections)) {
      copy.sections = copy.sections.map((section) => {
        if (!section || typeof section !== 'object' || Array.isArray(section)) return section;
        const safeSection = { ...(section as Record<string, unknown>) };
        delete safeSection.error;
        return safeSection;
      });
    }
    return copy;
  });
}

function publicJobResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicJobResult);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'emptyWindows' || key === 'windowIssues') {
      out[key] = publicDiagnosticList(entry);
    } else {
      out[key] = publicJobResult(entry);
    }
  }
  return out;
}

function publicJobView(job: Job): Record<string, unknown> {
  const result = job.result === undefined ? undefined : publicJobResult(job.result);
  const publicError = job.status === 'error' ? job.publicError ?? 'job failed' : undefined;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    message: publicError ?? job.message,
    ...(publicError === undefined ? {} : { error: publicError }),
    ...(result === undefined ? {} : { result }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  };
}

/* ------------------------------------------------------------------ utils */

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: string | Buffer) => {
      if (settled) return;
      const chunk = typeof c === 'string' ? Buffer.from(c) : c;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    // Decode once: an HTTP chunk can end in the middle of a UTF-8 character.
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

async function readJson(
  req: IncomingMessage,
  maxBytes = 2 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBytes);
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
    return value as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('malformed JSON body'), { statusCode: 400 });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(res: ServerResponse, file: string): void {
  // Read first, then write: a directory or an unreadable path must not leave
  // 200 headers committed when the read throws and the error handler replies.
  let body: Buffer;
  try {
    if (!statSync(file).isFile()) {
      json(res, 404, { error: 'not found' });
      return;
    }
    body = readFileSync(file);
  } catch {
    json(res, 404, { error: 'not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
  });
  res.end(body);
}

/* ----------------------------------------------------------------- server */

export interface ServerOptions {
  db: Db;
  /** The active project, or null when the database has none yet. */
  projectId: number | null;
  port?: number;
  /** Where uploaded source files are written before import. */
  importDir?: string;
}

export function startServer(opts: ServerOptions): import('node:http').Server {
  const { db, port = 8123 } = opts;
  const importDir = opts.importDir ?? join(import.meta.dirname, '..', '..', '.imports');
  let projectId: number | null = opts.projectId;

  const llm = () => clientFrom(controller.getProject(db, projectId ?? -1)?.settings ?? {});
  const project = () => {
    if (projectId === null) throw new Error('no project is selected');
    const p = controller.getProject(db, projectId);
    if (!p) throw new Error('no project');
    return p;
  };
  /** The active project id, or null when there is none yet. */
  const activeId = (): number | null => (projectId === null ? null : projectId);

  const server = createServer(async (req, res) => {
    try {
      // Loopback binding alone does not prevent browser CSRF or DNS rebinding.
      const address = server.address();
      const localPort = address && typeof address !== 'string' ? address.port : port;
      const hosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
      const host = req.headers.host ?? '';
      if (!hosts.has(host) || req.headers['sec-fetch-site'] === 'cross-site'
        || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
        json(res, 403, { error: 'forbidden origin or host' });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        json(res, 400, { error: 'malformed path' });
        return;
      }
      const method = req.method ?? 'GET';
      /* ---------------------------------------------------------- static */
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        serveStatic(res, join(UI_DIR, 'index.html'));
        return;
      }
      if (method === 'GET' && (path === '/web3d/evidence' || path === '/web3d/evidence/'
        || path === '/web3d-evidence' || path === '/web3d-evidence/')) {
        serveStatic(res, join(UI_DIR, 'web3d.html'));
        return;
      }
      if (method === 'GET' && (path === '/web3d' || path === '/web3d/')) {
        serveStatic(res, join(UI_DIR, 'web3d-map.html'));
        return;
      }
      if (method === 'GET' && (path === '/workbench' || path === '/workbench/')) {
        serveStatic(res, join(UI_DIR, 'workbench.html'));
        return;
      }
      // The BookNLP HTML is generated outside the repo. Point at it with
      // FANFABLE_BOOKNLP when it lives somewhere else.
      if (method === 'GET' && (path === '/booknlp-inspector' || path === '/booknlp-inspector/')) {
        serveStatic(res, join(UI_DIR, 'booknlp-inspector.html'));
        return;
      }
      if (method === 'GET' && (path === '/api/booknlp/entities' || path === '/api/booknlp/entities/')) {
        if (activeId() === null) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const current = project();
        const rows = db.all<{
          id: number; name: string; aliases: string; kind: string;
          review_status: string; summary: string; ties: number; facts: number; mentions: number;
        }>(
          `SELECT e.id, e.name, e.aliases, e.kind, e.review_status, e.summary, e.mentions,
                  (SELECT COUNT(*) FROM canon_relation r
                    WHERE r.project_id = e.project_id
                      AND (r.from_entity = e.id OR r.to_entity = e.id)
                      AND r.review_status <> 'rejected') AS ties,
                  (SELECT COUNT(*) FROM canon_fact f
                    WHERE f.subject_entity_id = e.id AND f.review_status <> 'rejected') AS facts
             FROM canon_entity e
            WHERE e.project_id = ? AND e.review_status <> 'quarantined' ORDER BY e.name`,
          current.id,
        );
        json(res, 200, rows.map((row) => ({
          id: Number(row.id),
          name: String(row.name ?? ''),
          aliases: (() => { try { const v = JSON.parse(row.aliases || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })(),
          kind: String(row.kind ?? ''),
          status: String(row.review_status ?? ''),
          hasSummary: String(row.summary ?? '').trim().length > 0,
          ties: Number(row.ties ?? 0),
          facts: Number(row.facts ?? 0),
          mentions: Number(row.mentions ?? 0),
        })));
        return;
      }
      if (method === 'GET' && (path === '/api/booknlp' || path === '/api/booknlp/')) {
        const dir = process.env.FANFABLE_BOOKNLP_DIR
          || join(homedir(), 'fanfable-work', 'booknlp-hp1');
        const payload = loadBookNlp(dir);
        if (!payload) {
          json(res, 404, { error: 'no BookNLP output; run the pipeline first' });
          return;
        }
        json(res, 200, payload);
        return;
      }
      if (method === 'GET' && (path === '/booknlp' || path === '/booknlp/')) {
        const file = process.env.FANFABLE_BOOKNLP
          || join(homedir(), 'fanfable-work', 'booknlp-hp1', 'hp1.book.html');
        if (!existsSync(file)) {
          json(res, 404, { error: 'no BookNLP output; run the BookNLP pipeline first' });
          return;
        }
        // The generated page has no styling and no anchor for the text. Give it
        // a readable default and an id the workbench can jump to.
        const style = '<style>body{background:#fff;color:#111;font:14px/1.5 system-ui,sans-serif;margin:18px 22px}'
          + 'h2{margin:26px 0 10px;font-size:16px}sub{font-size:9px}</style>';
        const html = readFileSync(file, 'utf8')
          .replace('<meta charset="UTF-8">', '<meta charset="UTF-8">' + style)
          .replace('<h2>Text</h2>', '<h2 id="text">Text</h2>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (method === 'GET' && (path === '/dev-viz' || path === '/dev-viz/')) {
        if (!DEV_ENABLED) {
          json(res, 404, { error: 'not found' });
          return;
        }
        serveStatic(res, join(UI_DIR, 'dev-viz.html'));
        return;
      }
      // The dev page's assets live beside the ship UI. Keep them out of reach
      // when the dev switch is off, even though /ui/ is otherwise static.
      if (
        method === 'GET'
        && !DEV_ENABLED
        && (path === '/ui/dev-viz.html' || path === '/ui/dev-viz.js')
      ) {
        json(res, 404, { error: 'not found' });
        return;
      }
      if (method === 'GET' && path.startsWith('/ui/')) {
        const reqPath = normalize(path.slice(4)).replace(/^(\.\.[\\/])+/, '');
        const file = resolve(UI_DIR, reqPath);
        if (file !== UI_DIR && !file.startsWith(UI_DIR + sep)) {
          json(res, 403, { error: 'forbidden' });
          return;
        }
        serveStatic(res, file);
        return;
      }

      /* --------------------------------------------------- dev visualizer */
      if (path === '/api/dev/graph-summary' && method === 'GET') {
        if (!DEV_ENABLED) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const requested = (url.searchParams.get('project') ?? '').trim();
        let p: controller.Project | undefined;
        if (!requested) {
          p = projectId === null ? undefined : controller.getProject(db, projectId);
        } else {
          const numeric = Number(requested);
          p = Number.isInteger(numeric) && numeric > 0 ? controller.getProject(db, numeric) : undefined;
          p ??= controller.getProjectByName(db, requested);
        }
        if (!p) {
          json(res, 404, {
            error: requested ? `no project called "${requested}"` : 'no project is selected',
          });
          return;
        }
        json(res, 200, devGraphSummary(db, p));
        return;
      }

      if (path === '/api/dev/bank-answer' && method === 'GET') {
        if (!DEV_ENABLED) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const question = (url.searchParams.get('q') ?? '').trim();
        if (activeId() === null) {
          json(res, 200, { status: 'none', reason: 'No project is selected.' });
          return;
        }
        if (!question) {
          json(res, 200, { status: 'none', reason: 'No question was asked.' });
          return;
        }
        const p = project();
        json(res, 200, lorebook.bankAnswerForQuestion(db, p.id, question));
        return;
      }

      /* --------------------------------------------------------- session */
      if (path === '/api/session' && method === 'GET') {
        const p = projectId === null ? undefined : controller.getProject(db, projectId);
        // The API key stays on the server: the UI sends settings, never reads the key back.
        const saved: Record<string, unknown> = { ...(loadGlobalConfig() as object) };
        const model = { ...saved, ...(p?.settings as object) } as Record<string, unknown>;
        delete model.apiKey;
        json(res, 200, {
          projects: controller.listProjects(db).map((x) => ({ id: x.id, name: x.name, updatedAt: x.updatedAt })),
          currentProjectId: p?.id ?? null,
          projectName: p?.name ?? null,
          model,
        });
        return;
      }

      if (path === '/api/session/project' && method === 'POST') {
        const body = await readJson(req);
        let id = Number(body.id);
        if (!Number.isFinite(id) || !controller.getProject(db, id)) {
          const name = String(body.name ?? '').trim();
          if (!name) {
            json(res, 400, { error: 'a project name is required' });
            return;
          }
          const existing = controller.getProjectByName(db, name);
          id = existing
            ? existing.id
            : controller.createProject(db, name).id;
        }
        projectId = id;
        saveGlobalConfig({ lastProject: controller.getProject(db, id)!.name } as never);
        json(res, 200, { ok: true, currentProjectId: id, name: controller.getProject(db, id)!.name });
        return;
      }

      /* -------------------------------------------------------- dashboard */
      if (path === '/api/dashboard' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { project: null, outline: null, chapters: [], counts: {}, recentRequests: [] });
          return;
        }
        const p = project();
        const outline = planner.approvedOutline(db, p.id) ?? planner.latestOutline(db, p.id);
        const chapters = controller.listChapters(db, p.id);
        const issues = continuity.listIssues(db, p.id, { openOnly: true });
        const sources = lore.listSources(db, p.id);
        const requests = db.all<{ id: number; kind: string; query: string; result_count: number; status: string; created_at: string }>(
          'SELECT id, kind, query, result_count, status, created_at FROM context_request WHERE project_id = ? ORDER BY id DESC LIMIT 8',
          p.id,
        );
        const canonEvents = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_event WHERE project_id = ?', p.id);
        json(res, 200, {
          project: { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt },
          outline: outline
            ? {
                id: outline.id,
                version: outline.version,
                status: outline.status,
                premise: outline.premise,
                divergence: outline.divergence,
                chapters: outline.chapters.length,
              }
            : null,
          chapters: chapters.map((c) => ({ number: c.number, title: c.title, status: c.status, words: c.wordCount })),
          counts: {
            sources: sources.length,
            canonEvents: canonEvents?.n ?? 0,
            characters: memory.listCharacters(db, p.id).length,
            events: memory.listAuEvents(db, p.id).length,
            threads: memory.listThreads(db, p.id).filter((t) => t.status === 'open').length,
            facts: memory.listFacts(db, p.id).length,
            openIssues: issues.length,
            errors: issues.filter((i) => i.severity === 'error').length,
          },
          recentRequests: requests,
        });
        return;
      }

      /* ---------------------------------------------------------- sources */
      if (path === '/api/sources' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { sources: [] });
          return;
        }
        const p = project();
        const sources = lore.listSources(db, p.id).map((s) => {
          const chunks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE source_id = ?', s.id);
          return { ...s, chunks: chunks?.n ?? 0 };
        });
        json(res, 200, { sources });
        return;
      }

      if (path === '/api/sources/import' && method === 'POST') {
        // Book files arrive base64-encoded and several may be sent at once, so
        // this route needs a larger body budget than ordinary JSON calls.
        const body = await readJson(req, 64 * 1024 * 1024);
        const files = (body.files ?? []) as { name: string; contentBase64: string }[];
        if (!files.length) {
          json(res, 400, { error: 'no files' });
          return;
        }
        if (files.length > 10) {
          json(res, 413, { error: 'too many files (max 10)' });
          return;
        }
        for (const f of files) {
          if (typeof f.contentBase64 !== 'string' || f.contentBase64.length > 15 * 1024 * 1024) {
            json(res, 413, { error: `file too large: ${f.name ?? 'unnamed'}` });
            return;
          }
        }
        const { id } = startJob('import', async (progress) => {
          const p = project();
          const dir = join(importDir, String(p.id));
          mkdirSync(dir, { recursive: true });
          const results: { title: string; chunks: number; format: string; pages: number }[] = [];
          for (const [i, f] of files.entries()) {
            progress(`reading ${f.name} (${i + 1}/${files.length})`);
            const safe = basename(f.name).replace(/[^\w.\- ]+/g, '_') || `file-${i}.txt`;
            const path = join(dir, safe);
            writeFileSync(path, Buffer.from(f.contentBase64, 'base64'));
            const res = await lore.importSourceAsync(db, p.id, path, { overwrite: true });
            results.push({
              title: res.source.title,
              chunks: res.chunks,
              format: res.source.format,
              pages: res.source.pageCount,
            });
          }
          return { imported: results };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/sources/list-files' && method === 'GET') {
        const p = project();
        const dir = join(importDir, String(p.id));
        const files = existsSync(dir) ? readdirSync(dir) : [];
        json(res, 200, { files });
        return;
      }

      /* ------------------------------------------------------------- lore */
      if (path === '/api/lore' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { query: '', passages: [] });
          return;
        }
        const p = project();
        const q = url.searchParams.get('q') ?? '';
        const passages = q ? lore.searchCanon(db, p.id, q, { limit: 12 }) : [];
        json(res, 200, { query: q, passages });
        return;
      }

      if (path === '/api/lore/ask' && method === 'POST') {
        const body = await readJson(req);
        const question = String(body.question ?? '');
        const { id } = startJob('lore-ask', async (progress) => {
          progress('searching the source material');
          const p = project();
          const res = await lore.answerLoreQuestion(db, llm(), p.id, question, { limit: 8 });
          return { answer: res.answer, passages: res.passages };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/book-lore' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { stats: {}, entities: [], relations: [], facts: [], timeline: [] });
          return;
        }
        const p = project();
        const kind = url.searchParams.get('kind') || undefined;
        json(res, 200, {
          stats: lorebook.loreStats(db, p.id),
          entities: lorebook.listEntities(db, p.id, (kind as never) || undefined),
          relations: lorebook.listRelations(db, p.id),
          facts: lorebook.listFacts(db, p.id),
          timeline: lorebook.listTimeline(db, p.id),
        });
        return;
      }

      if (path === '/api/book-lore/extract' && method === 'POST') {
        const body = await readJson(req);
        const num = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        const { id } = startJob('extract-lore', async (progress) => {
          const p = project();
          return lorebook.extractLore(db, llm(), p.id, {
            maxWindows: num(body.maxWindows),
            priorityFirst: num(body.priorityFirst),
            randomFloor: num(body.randomFloor),
            seed: num(body.seed),
            full: body.full === true,
            recovery: body.legacy === true
              ? { enabled: false }
              : { explicitRetry: body.retry === true, stageOnly: true },
            onProgress: (m) => progress(m),
          });
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/book-lore/embed' && method === 'POST') {
        const body = await readJson(req);
        const { id } = startJob('embed-lore', async (progress) => {
          const p = project();
          const cfg = embeddings.resolveEmbedConfig(db, p.id, {
            model: typeof body.model === 'string' ? body.model : undefined,
            fallbackBaseUrl: llm().settings.baseUrl,
          });
          return embeddings.embedBackfill(db, p.id, cfg, (m) => progress(m));
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/book-lore/entity' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        lorebook.updateEntity(db, p.id, Number(body.id), {
          name: body.name ? String(body.name) : undefined,
          summary: body.summary ? String(body.summary) : undefined,
          role: body.role !== undefined ? String(body.role) : undefined,
          status: body.status !== undefined ? String(body.status) : undefined,
          kind: body.kind ? (String(body.kind) as never) : undefined,
        });
        json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/book-lore/entity/delete' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        lorebook.deleteEntity(db, p.id, Number(body.id));
        json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/canon-events' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { events: [] });
          return;
        }
        const p = project();
        json(res, 200, { events: lore.listCanonEvents(db, p.id, 200) });
        return;
      }

      if (path === '/api/canon-events/extract' && method === 'POST') {
        const { id } = startJob('extract-events', async (progress) => {
          progress('reading the source material');
          const p = project();
          const events = await lore.extractCanonEvents(db, llm(), p.id);
          return { count: events.length };
        });
        json(res, 200, { jobId: id });
        return;
      }

      /* ------------------------------------------------------------- plan */
      if (path === '/api/lore-gaps' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { gaps: [] });
          return;
        }
        const p = project();
        const gaps = loreDiag.diagnose(db, p.id, { limit: Number(url.searchParams.get('limit') ?? 30) });
        json(res, 200, { gaps });
        return;
      }

      if (path === '/api/conflicts' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { conflicts: [] });
          return;
        }
        const p = project();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
        json(res, 200, {
          conflicts: listConflicts(db, p.id, { openOnly: url.searchParams.get('all') !== '1' }).slice(0, limit),
        });
        return;
      }

      if (path === '/api/conflicts/resolve' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        resolveConflict(
          db,
          p.id,
          Number(body.id),
          (String(body.resolution ?? 'accepted') as 'open' | 'accepted' | 'resolved'),
        );
        json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/web/graph' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, {
            unchanged: true,
            revision: '',
            projectId: null,
            counts: { personThreads: 0, pairThreads: 0, notes: 0, meetings: 0, births: 0, openEnds: 0 },
            nodes: [],
            links: [],
            openEnds: [],
            updatedAt: '',
          });
          return;
        }
        const p = project();
        const limitRaw = Number(url.searchParams.get('limit') ?? 1500);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, Math.floor(limitRaw))) : 1500;
        const all = url.searchParams.get('all') === '1';
        const notes = url.searchParams.get('notes') === '1';
        const graph = buildWebGraph(db, p.id, { limit, all, notes });
        if (url.searchParams.get('rev') === graph.revision) {
          json(res, 200, { unchanged: true, revision: graph.revision });
          return;
        }
        json(res, 200, graph);
        return;
      }

      if (path === '/api/web/map' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { nodes: [], edges: [] });
          return;
        }
        const p = project();
        json(res, 200, buildWebMap(db, p.id, { includeIsolated: url.searchParams.get('isolated') === '1' }));
        return;
      }

      if (path === '/api/web/thread' && method === 'GET') {
        if (activeId() === null) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const p = project();
        const id = Number(url.searchParams.get('id'));
        if (!Number.isInteger(id) || id <= 0) {
          json(res, 400, { error: 'bad thread id' });
          return;
        }
        const detail = webThreadDetail(db, p.id, id);
        if (!detail) {
          json(res, 404, { error: 'not found' });
          return;
        }
        json(res, 200, detail);
        return;
      }

      if (path === '/api/web/person' && method === 'GET') {
        if (activeId() === null) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const p = project();
        const id = Number(url.searchParams.get('id'));
        if (!Number.isInteger(id) || id <= 0) {
          json(res, 400, { error: 'bad person id' });
          return;
        }
        const dossier = webPersonDossier(db, p.id, id);
        if (!dossier) {
          json(res, 404, { error: 'not found' });
          return;
        }
        json(res, 200, dossier);
        return;
      }

      if (path === '/api/graph' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { stats: {}, connections: [], nodes: [] });
          return;
        }
        const p = project();
        const name = url.searchParams.get('name') ?? '';
        const hops = Number(url.searchParams.get('hops') ?? 1);
        const g = graph.loadGraph(db, p.id);
        const kindCounts: Record<string, number> = {};
        let canonNodes = 0;
        let storyNodes = 0;
        for (const node of g.nodes.values()) {
          kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
          if (node.scope === 'canon') canonNodes++;
          else storyNodes++;
        }
        const typeCounts: Record<string, number> = {};
        for (const e of g.edges) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;

        let connections: {
          from: string;
          to: string;
          type: string;
          description: string;
          confidence: number;
          scope: string;
          depth: number;
        }[] = [];
        let roots: string[] = [];

        if (name) {
          const matched = graph.resolveRoots(g, [name]);
          roots = matched.map((m) => m.node.id);
          const result = graph.traverse(g, { roots, hops, maxNodes: 60, maxEdges: 200 });
          const nameOf = (id: string) => g.nodes.get(id)?.name ?? id;
          connections = result.edges.map((e) => ({
            from: nameOf(e.from),
            to: nameOf(e.to),
            type: e.type,
            description: e.description,
            confidence: e.confidence,
            scope: e.scope,
            depth: Math.min(result.depth.get(e.from) ?? 0, result.depth.get(e.to) ?? 0),
          }));
        }

        json(res, 200, {
          stats: {
            nodes: g.nodes.size,
            edges: g.edges.length,
            kinds: kindCounts,
            types: typeCounts,
            canonNodes,
            storyNodes,
          },
          roots: roots.map((id) => g.nodes.get(id)?.name ?? id),
          connections,
        });
        return;
      }

      if (path === '/api/plan' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { outline: null, messages: [] });
          return;
        }
        const p = project();
        const outline = planner.approvedOutline(db, p.id) ?? planner.latestOutline(db, p.id);
        json(res, 200, {
          outline: outline
            ? {
                id: outline.id,
                version: outline.version,
                status: outline.status,
                premise: outline.premise,
                divergence: outline.divergence,
                divergenceRef: outline.divergenceRef,
                structure: outline.structure,
                preferences: outline.preferences,
                chapters: outline.chapters,
              }
            : null,
          messages: planner.listMessages(db, p.id, 40),
        });
        return;
      }

      if (path === '/api/plan/discuss' && method === 'POST') {
        const body = await readJson(req);
        const message = String(body.message ?? '');
        const { id } = startJob('plan-discuss', async () => {
          const p = project();
          const outline = planner.approvedOutline(db, p.id) ?? planner.latestOutline(db, p.id);
          const passages = await lore.searchCanon(db, p.id, message, { limit: 5 });
          const reply = await planner.discuss(llm(), db, p.id, message, {
            outline,
            canonBrief: passages.map((x) => x.text).join('\n\n'),
          });
          return { reply };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/plan/draft' && method === 'POST') {
        const body = await readJson(req);
        const { id } = startJob('plan-draft', async (progress) => {
          progress('grounding the plan in canon');
          const p = project();
          const { outline, warnings } = await controller.draftPlan(db, llm(), p.id, {
            premise: String(body.premise ?? ''),
            divergence: String(body.divergence ?? ''),
            chapterCount: Number(body.chapters ?? 6),
            preferences: {
              tone: String(body.tone ?? ''),
              pov: String(body.pov ?? ''),
              tense: String(body.tense ?? ''),
            },
            userNotes: String(body.notes ?? ''),
          });
          return { outline, warnings };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/plan/approve' && method === 'POST') {
        const { id } = startJob('plan-approve', async () => {
          const p = project();
          const latest = planner.latestOutline(db, p.id);
          if (!latest) throw new Error('there is no outline to approve');
          const approved = planner.approveOutline(db, p.id, latest.id);
          return { outline: approved };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/plan/revise' && method === 'POST') {
        const body = await readJson(req);
        const { id } = startJob('plan-revise', async (progress) => {
          progress('revising the outline');
          const p = project();
          const current = planner.approvedOutline(db, p.id) ?? planner.latestOutline(db, p.id);
          if (!current) throw new Error('there is no outline to revise');
          const chapterNumber = body.chapter ? Number(body.chapter) : undefined;
          const revised = await planner.reviseOutline(llm(), current, String(body.instruction ?? ''), {
            chapterNumber,
          });
          const updated = planner.saveOutline(db, p.id, {
            premise: revised.premise,
            divergence: revised.divergence,
            divergenceRef: revised.divergenceRef,
            canonRefs: revised.canonRefs,
            structure: revised.structure,
            chapters: revised.chapters,
            preferences: revised.preferences,
            status: 'draft',
          });
          return { outline: updated };
        });
        json(res, 200, { jobId: id });
        return;
      }

      /* ---------------------------------------------------------- writing */
      if (path === '/api/chapters' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { chapters: [] });
          return;
        }
        const p = project();
        json(res, 200, {
          chapters: controller.listChapters(db, p.id).map((c) => ({
            id: c.id,
            number: c.number,
            title: c.title,
            status: c.status,
            words: c.wordCount,
            summary: c.summary,
            updatedAt: c.updatedAt,
          })),
        });
        return;
      }

      if (path === '/api/chapter' && method === 'GET') {
        const n = Number(url.searchParams.get('n'));
        if (activeId() === null) {
          json(res, 404, { error: 'chapter not found' });
          return;
        }
        const chapter = controller.getChapter(db, projectId!, n);
        if (!chapter) {
          json(res, 404, { error: 'chapter not found' });
          return;
        }
        json(res, 200, chapter);
        return;
      }

      if (path === '/api/chapter/write' && method === 'POST') {
        const body = await readJson(req);
        const { id } = startJob('write', async (progress) => {
          const p = project();
          progress('assembling canon and story memory');
          const res = await controller.writeChapter(db, llm(), p.id, {
            chapterNumber: body.number ? Number(body.number) : undefined,
            userInstructions: String(body.notes ?? ''),
            sceneSummary: String(body.scene ?? '') || undefined,
          });
          progress('checking continuity');
          return {
            chapter: res.chapter,
            trace: res.trace,
            contextTraceId: res.contextTraceId,
            writeTraceId: res.writeTraceId,
            issues: res.issues,
          };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/chapter/approve' && method === 'POST') {
        const body = await readJson(req);
        const { id } = startJob('approve', async (progress) => {
          const p = project();
          progress('extracting story state');
          const res = await controller.approveChapter(db, llm(), p.id, Number(body.number));
          progress('checking continuity');
          return { chapter: res.chapter, issues: res.issues, contextTraceId: res.contextTraceId };
        });
        json(res, 200, { jobId: id });
        return;
      }

      if (path === '/api/chapter/edit' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        const chapter = controller.setChapterBody(
          db,
          p.id,
          Number(body.number),
          String(body.body ?? ''),
          'edited in the browser',
        );
        const impacted = controller.impactedByChapterEdit(db, p.id, Number(body.number));
        json(res, 200, { chapter, impacted: impacted.map((i) => i.chapter.number) });
        return;
      }

      if (path === '/api/chapter/delete' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        const n = Number(body.number);
        const chapter = controller.getChapter(db, p.id, n);
        if (chapter) {
          db.transaction(() => {
            // The text and everything approved from it go together. Without
            // this, most derived tables keep their rows with chapter_id NULL
            // and later context reads orphans as live story state.
            memory.clearChapterExtraction(db, p.id, chapter.id);
            db.run(
              "UPDATE state_conflict SET status = 'resolved' WHERE project_id = ? AND chapter_id = ? AND status = 'open'",
              p.id,
              chapter.id,
            );
            db.run('DELETE FROM chapter WHERE project_id = ? AND number = ?', p.id, n);
          });
        }
        json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/chapter/check' && method === 'POST') {
        const body = await readJson(req);
        const { id } = startJob('check', async (progress) => {
          progress('comparing the chapter against canon and story memory');
          const p = project();
          const chapter = controller.getChapter(db, p.id, Number(body.number));
          if (!chapter) throw new Error('chapter not found');
          const outline = planner.approvedOutline(db, p.id);
          const bundle = await controller.assembleContext(db, llm(), p.id, {
            chapter: outline?.chapters.find((c) => c.number === chapter.number),
            chapterNumber: chapter.number,
          });
          const issues = await controller.runContinuityCheck(db, llm(), p.id, chapter, outline, bundle);
          return { issues };
        });
        json(res, 200, { jobId: id });
        return;
      }

      /* --------------------------------------------------------- state */
      if (path === '/api/story-state' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, {
            characters: [], relationships: [], timeline: [], threads: [], facts: [], requests: [], canonEvents: [],
          });
          return;
        }
        const p = project();
        const states = memory.currentStates(db, p.id);
        json(res, 200, {
          characters: memory.listCharacters(db, p.id).map((c) => ({
            ...c,
            state: states.find((s) => s.characterId === c.id) ?? null,
            states: memory.listCharacterStates(db, p.id, c.id),
            knowledge: memory.listKnowledge(db, p.id, c.id),
          })),
          relationships: memory.listRelationships(db, p.id),
          timeline: memory.listAuEvents(db, p.id),
          threads: memory.listThreads(db, p.id),
          facts: memory.listFacts(db, p.id),
          requests: db.all<{ id: number; kind: string; query: string; result_count: number; status: string; created_at: string }>(
            'SELECT id, kind, query, result_count, status, created_at FROM context_request WHERE project_id = ? ORDER BY id DESC LIMIT 60',
            p.id,
          ),
          canonEvents: lore.listCanonEvents(db, p.id, 200),
        });
        return;
      }

      if (path === '/api/story-state/character' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        const name = String(body.name ?? '');
        const char = memory.resolveCharacter(db, p.id, name);
        if (!char) throw new Error('character not found');
        memory.addCharacterState(db, p.id, char.id, {
          location: String(body.location ?? ''),
          condition: String(body.condition ?? ''),
          emotional: String(body.emotional ?? ''),
          situation: String(body.situation ?? ''),
          source: 'user',
        });
        json(res, 200, { ok: true, character: char.name });
        return;
      }

      if (path === '/api/story-state/event' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        const id = Number(body.id);
        const existing = db.get<{ id: number; title: string; story_order: number; kind: string; divergence_note: string }>(
          'SELECT id, title, story_order, kind, divergence_note FROM au_event WHERE id = ? AND project_id = ?',
          id,
          p.id,
        );
        if (!existing) {
          json(res, 404, { error: 'event not found' });
          return;
        }
        const order = body.order !== undefined && body.order !== '' ? Number(body.order) : existing.story_order;
        db.run(
          'UPDATE au_event SET story_order = ?, kind = ?, divergence_note = ? WHERE id = ? AND project_id = ?',
          order,
          String(body.kind ?? existing.kind),
          String(body.note ?? existing.divergence_note),
          id,
          p.id,
        );
        json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/story-state/fact' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        const content = String(body.content ?? '');
        if (!content) {
          json(res, 400, { error: 'content required' });
          return;
        }
        memory.addFact(db, p.id, {
          kind: String(body.kind ?? 'fact'),
          subject: String(body.subject ?? ''),
          content,
          certainty: 'established',
        });
        json(res, 200, { ok: true });
        return;
      }

      /* --------------------------------------------------------- issues */
      if (path === '/api/issues' && method === 'GET') {
        if (activeId() === null) {
          json(res, 200, { issues: [] });
          return;
        }
        const p = project();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
        json(res, 200, { issues: continuity.listIssues(db, p.id, { openOnly: url.searchParams.get('all') !== '1' }).slice(0, limit) });
        return;
      }

      if (path === '/api/issues/resolve' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        continuity.setIssueResolution(
          db,
          p.id,
          Number(body.id),
          (String(body.resolution ?? 'accepted') as 'open' | 'accepted' | 'fixed'),
        );
        json(res, 200, { ok: true });
        return;
      }

      /* ------------------------------------------------------- settings */
      if (path === '/api/settings' && method === 'GET') {
        const p = activeId() === null ? undefined : project();
        const global = loadGlobalConfig() as Record<string, unknown>;
        delete global.lastProject;
        const mergedGlobal = { ...DEFAULT_LLM_SETTINGS, ...global };
        json(res, 200, {
          global: maskSettingsForOutput(mergedGlobal),
          project: maskSettingsForOutput({ ...DEFAULT_LLM_SETTINGS, ...global, ...(p?.settings ?? {}) }),
          continuity: p ? continuitySettings(p) : DEFAULT_CONTINUITY_SETTINGS,
        });
        return;
      }

      if (path === '/api/settings' && method === 'POST') {
        const body = await readJson(req);
        const patch: Record<string, unknown> = {};
        // Numeric settings are coerced here. Storing "32768" as a string makes
        // `num_ctx` a string downstream, which Ollama rejects or ignores.
        const NUMERIC = new Set(['temperature', 'maxTokens', 'contextTokens', 'timeoutMs', 'seed']);
        for (const key of ['provider', 'baseUrl', 'model', 'temperature', 'maxTokens', 'contextTokens', 'timeoutMs', 'seed']) {
          if (body[key] === undefined || body[key] === '') continue;
          patch[key] = NUMERIC.has(key) ? Number(body[key]) : body[key];
        }
        if (body.continuity !== undefined) {
          patch.continuity = body.continuity;
        }
        if (typeof body.recognition === 'boolean') {
          patch.recognition = body.recognition;
        }
        const p = project();
        controller.updateProjectSettings(db, p.id, patch);
        if (body.continuity === undefined) {
          // Recognition is a project setting, not a global model setting.
          const globalPatch = { ...patch };
          delete globalPatch.recognition;
          if (Object.keys(globalPatch).length) saveGlobalConfig(globalPatch as never);
        }
        json(res, 200, {
          ok: true,
          settings: maskSettingsForOutput(controller.getProject(db, p.id)!.settings),
        });
        return;
      }

      /* ----------------------------------------------------------- jobs */
      if (path.startsWith('/api/jobs/') && method === 'GET') {
        const job = jobs.get(path.slice('/api/jobs/'.length));
        if (!job) {
          json(res, 404, { error: 'job not found' });
          return;
        }
        json(res, 200, publicJobView(job));
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
      json(res, code, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`fanfable UI: http://127.0.0.1:${boundPort}`);
  });
  return server;
}
