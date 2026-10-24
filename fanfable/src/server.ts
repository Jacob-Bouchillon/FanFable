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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { Db } from './db.ts';
import * as controller from './controller.ts';
import * as lore from './lore.ts';
import * as lorebook from './lorebook.ts';
import * as graph from './graph.ts';
import * as loreDiag from './lore-diagnostics.ts';
import { listConflicts, resolveConflict } from './state-conflicts.ts';
import * as memory from './memory.ts';
import * as planner from './planner.ts';
import * as continuity from './continuity.ts';
import { DEFAULT_LLM_SETTINGS, clientFrom, loadGlobalConfig, saveGlobalConfig } from './llm.ts';
import { DEFAULT_CONTINUITY_SETTINGS, continuitySettings } from './continuity-settings.ts';

const UI_DIR = join(import.meta.dirname, 'ui');

/* ------------------------------------------------------------------- jobs */

interface Job {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  message: string;
  result?: unknown;
  error?: string;
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
      job.message = job.error;
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return { id };
}

/* ------------------------------------------------------------------ utils */

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res: ServerResponse, file: string): void {
  if (!existsSync(file)) {
    json(res, 404, { error: 'not found' });
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain; charset=utf-8' });
  res.end(readFileSync(file));
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
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      /* ---------------------------------------------------------- static */
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        serveStatic(res, join(UI_DIR, 'index.html'));
        return;
      }
      if (method === 'GET' && path.startsWith('/ui/')) {
        serveStatic(res, join(UI_DIR, path.slice(4)));
        return;
      }

      /* --------------------------------------------------------- session */
      if (path === '/api/session' && method === 'GET') {
        const p = projectId === null ? undefined : controller.getProject(db, projectId);
        json(res, 200, {
          projects: controller.listProjects(db).map((x) => ({ id: x.id, name: x.name, updatedAt: x.updatedAt })),
          currentProjectId: p?.id ?? null,
          projectName: p?.name ?? null,
          model: { ...(loadGlobalConfig() as object), ...(p?.settings as object) },
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
        const body = await readJson(req);
        const files = (body.files ?? []) as { name: string; contentBase64: string }[];
        if (!files.length) {
          json(res, 400, { error: 'no files' });
          return;
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
        const { id } = startJob('extract-lore', async (progress) => {
          const p = project();
          return lorebook.extractLore(db, llm(), p.id, {
            onProgress: (m) => progress(m),
          });
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
        json(res, 200, {
          conflicts: listConflicts(db, p.id, { openOnly: url.searchParams.get('all') !== '1' }),
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
          const updated = planner.updateOutline(db, p.id, current.id, {
            premise: revised.premise,
            divergence: revised.divergence,
            structure: revised.structure,
            chapters: revised.chapters,
            preferences: revised.preferences,
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
          return { chapter: res.chapter, issues: res.issues };
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
        const impacted = controller.impactedMaterial(db, p.id, `chapter ${body.number}`);
        json(res, 200, { chapter, impacted: impacted.map((i) => i.chapter.number) });
        return;
      }

      if (path === '/api/chapter/delete' && method === 'POST') {
        const body = await readJson(req);
        const p = project();
        const n = Number(body.number);
        const chapter = controller.getChapter(db, p.id, n);
        if (chapter) {
          db.run('DELETE FROM chapter WHERE project_id = ? AND number = ?', p.id, n);
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
        json(res, 200, { issues: continuity.listIssues(db, p.id, { openOnly: url.searchParams.get('all') !== '1' }) });
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
        json(res, 200, {
          global: { ...DEFAULT_LLM_SETTINGS, ...global },
          project: { ...DEFAULT_LLM_SETTINGS, ...global, ...(p?.settings ?? {}) },
          continuity: p ? continuitySettings(p) : DEFAULT_CONTINUITY_SETTINGS,
        });
        return;
      }

      if (path === '/api/settings' && method === 'POST') {
        const body = await readJson(req);
        const patch: Record<string, unknown> = {};
        for (const key of ['provider', 'baseUrl', 'model', 'temperature', 'maxTokens', 'contextTokens']) {
          if (body[key] !== undefined && body[key] !== '') patch[key] = body[key];
        }
        if (patch.temperature !== undefined) patch.temperature = Number(patch.temperature);
        if (body.continuity !== undefined) {
          patch.continuity = body.continuity;
        }
        const p = project();
        controller.updateProjectSettings(db, p.id, patch);
        if (body.continuity === undefined) saveGlobalConfig(patch as never);
        json(res, 200, { ok: true, settings: controller.getProject(db, p.id)!.settings });
        return;
      }

      /* ----------------------------------------------------------- jobs */
      if (path.startsWith('/api/jobs/') && method === 'GET') {
        const job = jobs.get(path.slice('/api/jobs/'.length));
        if (!job) {
          json(res, 404, { error: 'job not found' });
          return;
        }
        json(res, 200, job);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`fanfable UI: http://127.0.0.1:${port}`);
  });
  return server;
}
