/**
 * Application controller.
 *
 * The controller is the only component that talks to the database, the source
 * files and the model. Subsystems are logical roles invoked by the controller,
 * never autonomous agents with their own database access.
 *
 * It owns:
 *   - project lifecycle and persistence
 *   - approval state (outline, chapters, facts)
 *   - context assembly for the writer
 *   - routing of dynamic context requests to the Lore Researcher / Memory Manager
 *   - generation limits (context request rounds, request counts)
 */
import { Db, fromJson, nowIso, strList, toJson } from '../core/db.ts';
import { toStringArray } from '../core/json.ts';
import { clientFrom, createClient } from '../core/llm.ts';
import type { LlmClient, LlmSettings } from '../core/llm.ts';
import * as lore from '../answer/lore.ts';
import * as lorebook from '../lorebook.ts';
import * as retrieval from '../answer/retrieval.ts';
import * as graph from '../support/graph.ts';
import { checkPremise } from '../product/premise-check.ts';
import { detectConflicts, saveConflicts, listConflicts } from '../product/state-conflicts.ts';
import * as memory from '../product/memory.ts';
import * as planner from './planner.ts';
import { buildWebBrief, renderWebBrief } from './brief.ts';
import * as writer from '../product/writer.ts';
import * as continuity from '../product/continuity.ts';
import { continuitySettings, filterBySeverity } from '../product/continuity-settings.ts';
import { truncate, wordCount } from '../core/text.ts';
import { nameMentioned, nameMentionedExact } from '../identity/names.ts';

export interface Project {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown>;
}

export interface Chapter {
  id: number;
  number: number;
  title: string;
  status: string;
  body: string;
  summary: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

/* --------------------------------------------------------------- projects */

export function createProject(db: Db, name: string, settings: Record<string, unknown> = {}): Project {
  const ts = nowIso();
  const r = db.run(
    'INSERT INTO project (name, created_at, updated_at, settings) VALUES (?, ?, ?, ?)',
    name.trim(),
    ts,
    ts,
    toJson(settings),
  );
  return getProject(db, r.lastInsertRowid)!;
}

export function getProject(db: Db, id: number): Project | undefined {
  const r = db.get<{ id: number; name: string; created_at: string; updated_at: string; settings: string }>(
    'SELECT * FROM project WHERE id = ?',
    id,
  );
  if (!r) return undefined;
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    settings: fromJson<Record<string, unknown>>(r.settings, {}),
  };
}

export function getProjectByName(db: Db, name: string): Project | undefined {
  const r = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', name.trim());
  return r ? getProject(db, r.id) : undefined;
}

export function listProjects(db: Db): Project[] {
  const rows = db.all<{ id: number }>('SELECT id FROM project ORDER BY updated_at DESC');
  return rows.map((r) => getProject(db, r.id)!);
}

export function updateProjectSettings(db: Db, projectId: number, patch: Record<string, unknown>): Project {
  const current = getProject(db, projectId);
  if (!current) throw new Error('project not found');
  db.run(
    'UPDATE project SET settings = ?, updated_at = ? WHERE id = ?',
    toJson({ ...current.settings, ...patch }),
    nowIso(),
    projectId,
  );
  return getProject(db, projectId)!;
}

export function touchProject(db: Db, projectId: number): void {
  db.run('UPDATE project SET updated_at = ? WHERE id = ?', nowIso(), projectId);
}

/* ---------------------------------------------------------------- chapters */

interface ChapterRow {
  id: number;
  number: number;
  title: string;
  status: string;
  body: string;
  summary: string;
  word_count: number;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

function rowToChapter(r: ChapterRow): Chapter {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    status: r.status,
    body: r.body,
    summary: r.summary,
    wordCount: r.word_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at,
  };
}

export function getChapter(db: Db, projectId: number, number: number): Chapter | undefined {
  const r = db.get<ChapterRow>(
    'SELECT * FROM chapter WHERE project_id = ? AND number = ?',
    projectId,
    number,
  );
  return r ? rowToChapter(r) : undefined;
}

export function listChapters(db: Db, projectId: number): Chapter[] {
  const rows = db.all<ChapterRow>(
    'SELECT * FROM chapter WHERE project_id = ? ORDER BY number',
    projectId,
  );
  return rows.map(rowToChapter);
}

export function saveChapter(
  db: Db,
  projectId: number,
  number: number,
  fields: { title?: string; body?: string; status?: string; outlineId?: number | null },
): Chapter {
  const existing = getChapter(db, projectId, number);
  const ts = nowIso();
  const title = fields.title ?? existing?.title ?? '';
  const body = fields.body ?? existing?.body ?? '';
  const status = fields.status ?? existing?.status ?? 'draft';
  if (existing) {
    db.run(
      'UPDATE chapter SET title = ?, body = ?, status = ?, word_count = ?, updated_at = ? WHERE id = ?',
      title,
      body,
      status,
      wordCount(body),
      ts,
      existing.id,
    );
  } else {
    db.run(
      `INSERT INTO chapter (project_id, number, title, status, outline_id, body, summary, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
      projectId,
      number,
      title,
      status,
      fields.outlineId ?? null,
      body,
      wordCount(body),
      ts,
      ts,
    );
  }
  touchProject(db, projectId);
  return getChapter(db, projectId, number)!;
}

export function setChapterBody(db: Db, projectId: number, number: number, body: string, note = ''): Chapter {
  const existing = getChapter(db, projectId, number);
  if (existing) {
    db.run(
      'INSERT INTO chapter_revision (chapter_id, body, note, created_at) VALUES (?, ?, ?, ?)',
      existing.id,
      existing.body,
      note || 'previous version',
      nowIso(),
    );
  }
  return saveChapter(db, projectId, number, { body });
}

/* ------------------------------------------------------- context assembly */

export interface ContextBundle {
  memoryText: string;
  canonText: string;
  /** What the scene touches, and how it connects to the rest of the story. */
  connectedText: string;
  previousTail: string;
  focus: string[];
  /** What the writer asked for during this scene, for the author to review. */
  requests: { kind: string; query: string; resultCount: number; status: string }[];
  /** The retrieval that produced the canon text, for inspection. */
  retrieval?: retrieval.RetrievalPackage;
}

/**
 * Assemble the context for a chapter: story memory, canon evidence and the
 * tail of the previous chapter.
 */
export async function assembleContext(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: {
    chapter?: planner.ChapterOutline;
    chapterNumber: number;
    userInstructions?: string;
    /** How many edges away the graph walk may go. */
    hops?: number;
    /** Word budget for the canon part of the context. */
    canonWords?: number;
  },
): Promise<ContextBundle> {
  const focus = new Set<string>();
  if (opts.chapter) {
    for (const c of opts.chapter.characters) focus.add(c);
    for (const s of opts.chapter.scenes) {
      if (s.pov) focus.add(s.pov);
      if (s.location) focus.add(s.location);
    }
    for (const id of opts.chapter.canonEventIds) focus.add(`canon:${id}`);
  }
  for (const m of toStringArray(opts.userInstructions)) focus.add(m);

  const slice = memory.buildContextSlice(db, projectId, { focus: [...focus] });
  const memoryText = memory.renderContextSlice(slice);

  // The passages a canon event in the outline points at, always included.
  const passages: lore.Passage[] = [];
  const canonEventIds = opts.chapter?.canonEventIds ?? [];
  for (const id of canonEventIds) {
    const ev = db.get<{ chunk_id: number | null; source_id: number | null }>(
      'SELECT chunk_id, source_id FROM canon_event WHERE id = ? AND project_id = ?',
      id,
      projectId,
    );
    if (!ev?.chunk_id) continue;
    const chunk = lore.getChunk(db, ev.chunk_id);
    if (chunk) passages.push(chunk);
  }

  // The scene's names: who and what it is about.
  const loreNames = [
    ...(opts.chapter?.characters ?? []),
    ...(opts.chapter?.scenes.map((s) => s.location) ?? []),
    ...(opts.chapter?.scenes.map((s) => s.pov) ?? []),
  ].filter(Boolean);

  // One retrieval: FTS5 for the passages, graph traversal for the connections
  // between them. The two are ranked and budgeted together.
  const retrieved = await retrieval.retrieve(db, llm, projectId, {
    query: [opts.chapter?.goal, opts.chapter?.synopsis].filter(Boolean).join(' '),
    focus: [...loreNames, ...[...focus].filter((f) => !f.startsWith('canon:'))],
    hops: opts.hops ?? 1,
    maxWords: opts.canonWords ?? 1600,
    passageLimit: 6,
  });
  for (const p of retrieved.passages) {
    if (!passages.some((x) => x.chunkId === p.chunkId)) passages.push(p);
  }

  // The writer works from a canon brief (facts and beats) rather than raw
  // passages, so the prose stays its own. The exact source text stays one
  // context request away.
  let canonText = '';
  if (passages.length) {
    const brief = await lore.buildCanonBrief(llm, passages.slice(0, 8), {
      goal: opts.chapter?.goal,
      characters: opts.chapter?.characters,
      scenes: opts.chapter?.scenes.map((s) => `${s.title}: ${s.summary}`).join('\n'),
    });
    canonText = lore.formatCanonBrief(brief);
  }

  // The extracted lore index: who and what exists, how they relate, and what
  // the source has established. This is the grounding the writer cannot invent.
  const loreBrief = lorebook.buildLoreBrief(db, projectId, { names: loreNames });
  const loreText = lorebook.formatLoreBrief(loreBrief);
  if (loreText) {
    canonText = canonText ? `${loreText}\n\n${canonText}` : loreText;
  }

  // The connected context: what this scene touches, and how it all hangs
  // together. The graph says what is related; the passages behind it say
  // whether to believe it. Verdicts computed after mining ride along so the
  // writer sees them: composed family ties, explicit strangers, gaps.
  let connectedText = retrieved.graph.text;
  const verdicts: string[] = [];
  if (retrieved.stats.composedPath) {
    verdicts.push(
      `Family tie implied: ${loreNames.slice(0, 2).join(' / ')} via ${retrieved.stats.composedPath.via} (${retrieved.stats.composedPath.label}).`,
    );
  }
  if (retrieved.stats.strangers) {
    verdicts.push(
      `No recorded connection between ${retrieved.stats.strangers.a} and ${retrieved.stats.strangers.b} in the extracted lore.`,
    );
  }
  if (retrieved.stats.coverage?.missing?.length || retrieved.stats.truncated) {
    verdicts.push(`Coverage incomplete: missing ${retrieved.stats.coverage.missing.join(', ') || 'none listed'}. Do not invent the missing link.`);
  }
  if (verdicts.length) connectedText = connectedText ? `${connectedText}\n\n${verdicts.join('\n')}` : verdicts.join('\n');

  const prev = listChapters(db, projectId).filter((c) => c.number < opts.chapterNumber);
  const last = prev[prev.length - 1];
  const previousTail = last ? truncate(last.body.slice(-2500), 2500) : '';

  return {
    memoryText,
    canonText,
    connectedText,
    previousTail,
    focus: [...focus],
    requests: [],
    retrieval: retrieved,
  };
}

/* --------------------------------------------- dynamic context resolution */

export interface RequestLogEntry {
  kind: string;
  query: string;
  resultCount: number;
  status: string;
}

/**
 * Resolve a structured context request from the writer.
 *
 * Canon evidence, existing AU history and speculative suggestions are kept in
 * clearly separated sections of the answer.
 */
export async function resolveContextRequest(
  db: Db,
  llm: LlmClient,
  projectId: number,
  req: writer.ContextRequest,
  chapterId: number | null,
  limits: { maxRequests: number },
  opts: { lazyExtract?: boolean } = {},
): Promise<{ answer: writer.ResolvedContext | null; log: RequestLogEntry }> {
  const prior = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM context_request WHERE project_id = ? AND chapter_id IS ?',
    projectId,
    chapterId,
  );
  const already = prior?.n ?? 0;
  if (already >= limits.maxRequests) {
    db.run(
      'INSERT INTO context_request (project_id, chapter_id, requester, kind, query, result_count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      projectId,
      chapterId,
      'writer',
      req.kind,
      req.query,
      0,
      'denied',
      nowIso(),
    );
    return {
      answer: null,
      log: { kind: req.kind, query: req.query, resultCount: 0, status: 'denied' },
    };
  }

  let answer: writer.ResolvedContext | null = null;
  let resultCount = 0;

  switch (req.kind) {
    case 'lore': {
      const expanded = await lore.expandQuery(llm, req.query);
      const passages = lore.searchCanon(db, projectId, req.query, {
        limit: req.limit ?? 6,
        expand: expanded,
      });
      // A question that touches unmined text mines those windows first, so the
      // index below includes them. Best-effort: failures keep today's behavior.
      if (opts.lazyExtract !== false) {
        await lorebook.mineUnminedHits(
          db,
          llm,
          projectId,
          passages.map((p) => p.chunkId),
        );
      }
      const index = lorebook.searchLore(db, projectId, req.query, 8);
      const indexText = lore.formatLoreIndex(index);
      resultCount = passages.length + index.entities.length + index.facts.length;
      if (resultCount) {
        answer = {
          label: `CANON EVIDENCE for "${req.query}"`,
          kind: 'lore',
          content:
            (indexText ? `EXTRACTED LORE (from the source material):\n${indexText}\n\n` : '') +
            (passages.length ? lore.formatPassages(passages) + '\n\n' : '') +
            '(These are canon facts from the original source. They are not events of this story.)',
        };
      }
      break;
    }
    case 'canon': {
      const id = Number((req.query.match(/\d+/) ?? [])[0] ?? NaN);
      const ev = Number.isFinite(id)
        ? db.get<{ id: number; title: string; summary: string; locator: string; participants: string; location: string; time_label: string; quote: string; chunk_id: number | null }>(
            'SELECT id, title, summary, locator, participants, location, time_label, quote, chunk_id FROM canon_event WHERE id = ? AND project_id = ?',
            id,
            projectId,
          )
        : undefined;
      if (ev) {
        const chunk = ev.chunk_id ? lore.getChunk(db, ev.chunk_id) : undefined;
        resultCount = 1;
        answer = {
          label: `CANON SCENE #${ev.id}: ${ev.title}`,
          kind: 'canon',
          content:
            `source locator: ${ev.locator}\nsummary: ${ev.summary}\nparticipants: ${strList(ev.participants).join(', ')}\n` +
            `location: ${ev.location}\ntime: ${ev.time_label}\n\noriginal text:\n${chunk?.text ?? ev.quote}`,
        };
      }
      break;
    }
    case 'memory': {
      // Match any significant word of the query against what the story knows.
      const words = req.query
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((w) => w.length > 3)
        .slice(0, 6);
      const like = words.length ? words.map((w) => `%${w}%`) : [`%${req.query}%`];
      const clause = like.map(() => '(e.title LIKE ? OR e.summary LIKE ? OR e.participants LIKE ? OR e.location LIKE ? OR e.divergence_note LIKE ?)').join(' OR ');
      const events = db.all<{ title: string; summary: string; story_time: string; chapter_number: number | null }>(
        `SELECT e.title, e.summary, e.story_time, c.number AS chapter_number FROM au_event e
         LEFT JOIN chapter c ON c.id = e.chapter_id
         WHERE e.project_id = ? AND (${clause})
         ORDER BY e.story_order LIMIT 12`,
        projectId,
        ...like.flatMap((l) => [l, l, l, l, l]),
      );
      const facts = memory.listFacts(db, projectId).filter((f) => {
        const text = `${f.subject} ${f.content}`.toLowerCase();
        return words.length ? words.some((w) => text.includes(w)) : text.includes(req.query.toLowerCase());
      });
      resultCount = events.length + facts.length;
      if (resultCount) {
        answer = {
          label: `STORY HISTORY for "${req.query}"`,
          kind: 'memory',
          content:
            `Events already written in this story:\n${
              events.map((e) => `- ${e.title}${e.chapter_number ? ` (ch${e.chapter_number})` : ''}: ${e.summary}`).join('\n') || '- none'
            }\n\nEstablished facts:\n${
              facts.map((f) => `- (${f.kind}) ${f.subject ? `${f.subject}: ` : ''}${f.content}`).join('\n') || '- none'
            }`,
        };
      }
      break;
    }
    case 'graph': {
      // Connected context: who and what bears on the thing being asked about.
      const names = [req.character, req.query].filter(Boolean) as string[];
      const connected = graph.buildGraphContext(db, projectId, {
        query: req.query,
        focus: names,
        hops: req.limit && req.limit > 1 ? 2 : 1,
        maxWords: 700,
        maxNodes: 30,
      });
      resultCount = connected.nodes.length;
      if (connected.text.trim()) {
        answer = {
          label: `CONNECTED CONTEXT for "${req.query}"`,
          kind: 'graph',
          content:
            `${connected.text}\n\n` +
            '(Connected information: relationships, motives, secrets, events and their ' +
            'consequences. The source passages above it are the evidence.)',
        };
      }
      break;
    }
    case 'character': {
      const name = req.character ?? req.query;
      const ch = memory.findCharacter(db, projectId, name);
      // What the book says about this person, if the lore has been extracted.
      // An exact match first: a loose search for "Harry Potter" would return
      // everyone the book mentions alongside him.
      const exactEntity = lorebook.findEntity(db, projectId, name);
      const canonLore = exactEntity
        ? {
            entities: [exactEntity],
            relations: lorebook.listRelations(db, projectId).filter(
              (r) => r.fromId === exactEntity.id || r.toId === exactEntity.id,
            ),
            facts: lorebook.listFacts(db, projectId).filter((f) =>
              f.subject.toLowerCase().includes(exactEntity.name.toLowerCase()),
            ),
            timeline: [],
          }
        : lorebook.searchLore(db, projectId, name, 6);
      if (canonLore.entities.length) {
        const loreText = lorebook.formatLoreBrief(
          lorebook.renderBrief(canonLore.entities, canonLore.relations, canonLore.facts),
        );
        resultCount += canonLore.entities.length;
        answer = {
          label: `WHAT THE SOURCE SAYS ABOUT ${name.toUpperCase()}`,
          kind: 'character',
          content: `${loreText}\n\n(STORY RECORD follows.)`,
        };
      }
      if (ch) {
        const states = memory.listCharacterStates(db, projectId, ch.id);
        const know = memory.listKnowledge(db, projectId, ch.id);
        const rels = memory.listRelationships(db, projectId).filter(
          (r) => r.a === ch.name || r.b === ch.name,
        );
        resultCount += states.length + know.length + rels.length;
        const storyPart =
            `profile: ${ch.profile || '(not recorded)'}\ntraits: ${ch.traits.join(', ') || '(not recorded)'}\n\n` +
            `state history:\n${
              states.map((s) => `- ${s.location || '?'} | ${s.condition || '?'} | ${s.emotional || '?'} | ${s.situation || '?'}`).join('\n') || '- none'
            }\n\n` +
            `what they know:\n${
              know.map((k) => `- [${k.certainty}/${k.source}] ${k.fact}`).join('\n') || '- none recorded'
            }\n\n` +
            `relationships:\n${
              rels.map((r) => `- ${r.a} & ${r.b}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`).join('\n') || '- none'
            }`;
        answer = {
          label: answer ? `${answer.label} + STORY RECORD for ${ch.name}` : `STORY RECORD for ${ch.name}`,
          kind: 'character',
          content: answer ? `${answer.content}\n\n${storyPart}` : storyPart,
        };
      }
      break;
    }
    case 'au': {
      const changes = db.all<{ description: string; change_type: string; canon_event_id: number | null; title: string | null }>(
        `SELECT cc.description, cc.change_type, cc.canon_event_id, e.title FROM canon_change cc
         LEFT JOIN au_event e ON e.id = cc.au_event_id WHERE cc.project_id = ? ORDER BY cc.id DESC LIMIT 20`,
        projectId,
      );
      const divergence = planner.approvedOutline(db, projectId)?.divergence ?? '';
      resultCount = changes.length;
      if (changes.length || divergence) {
        answer = {
          label: 'WHAT THIS STORY HAS ALREADY CHANGED',
          kind: 'au',
          content:
            `Divergence point: ${divergence || '(not recorded)'}\n\nRecorded changes from canon:\n${
              changes
                .map((c) => `- [${c.change_type}] ${c.title ?? 'event'}: ${c.description}${c.canon_event_id ? ` (canon event ${c.canon_event_id})` : ''}`)
                .join('\n') || '- none'
            }`,
        };
      }
      break;
    }
  }

  db.run(
    'INSERT INTO context_request (project_id, chapter_id, requester, kind, query, result_count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    projectId,
    chapterId,
    'writer',
    req.kind,
    req.query,
    resultCount,
    answer ? 'resolved' : 'empty',
    nowIso(),
  );

  return { answer, log: { kind: req.kind, query: req.query, resultCount, status: answer ? 'resolved' : 'empty' } };
}

/* ------------------------------------------------------------------ writing */

export interface WriteChapterOptions {
  chapterNumber?: number;
  sceneSummary?: string;
  userInstructions?: string;
  contextLimits?: writer.ContextLimits;
  targetWords?: number;
  /** How similar two paragraphs must be before the second counts as a repeat. */
  dedupeThreshold?: number;
  /** Write the chapter in this many parts, to control length and repetition. */
  segments?: number;
  /**
   * The model that assembles the context.
   *
   * Defaults to the writing model. It is separate so that the context — the
   * canon brief, the graph walk, the answers to the writer's context requests
   * — can be built by one model and written against by another: that is what
   * a model comparison needs, and it is also how a cheap indexing model can be
   * kept away from the prose.
   */
  contextLlm?: LlmClient;
  /**
   * A context that has already been assembled. When it is given, the controller
   * does not build one, so several models can be given exactly the same
   * context.
   */
  bundle?: ContextBundle;
  /** Do not run the continuity checker over the draft. */
  skipContinuity?: boolean;
}

export interface WriteChapterResult {
  chapter: Chapter;
  trace: writer.WriteResult['trace'];
  issues: continuity.ContinuityIssue[];
  stats: writer.WriteResult['stats'];
}

/**
 * Write the next chapter (or a specific one) and save it as a draft.
 *
 * The chapter is not part of the story's memory until the author approves it.
 */
export async function writeChapter(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: WriteChapterOptions = {},
): Promise<WriteChapterResult> {
  const outline = planner.approvedOutline(db, projectId);
  if (!outline) throw new Error('No approved outline. Run "plan draft" and "plan approve" first.');

  const existing = listChapters(db, projectId);
  const chapterNumber =
    opts.chapterNumber ?? (existing.length ? Math.max(...existing.map((c) => c.number)) + 1 : 1);
  const chapterOutline = outline.chapters.find((c) => c.number === chapterNumber);

  const bundle =
    opts.bundle ??
    (await assembleContext(db, opts.contextLlm ?? llm, projectId, {
      chapter: chapterOutline,
      chapterNumber,
      userInstructions: opts.userInstructions,
    }));

  const limits = opts.contextLimits ?? writer.DEFAULT_CONTEXT_LIMITS;
  const contextLlm = opts.contextLlm ?? llm;

  // Create the chapter row first so context requests can be attributed to it.
  // If the model fails, a newly created placeholder is removed so numbering never skips.
  const hadExisting = existing.some((c) => c.number === chapterNumber);
  const placeholder = saveChapter(db, projectId, chapterNumber, {
    title: chapterOutline?.title ?? `Chapter ${chapterNumber}`,
    ...(hadExisting ? {} : { body: '', status: 'draft' }),
    outlineId: outline.id,
  });

  let result: Awaited<ReturnType<typeof writer.writeChapter>>;
  try {
    result = await writer.writeChapter(
    llm,
    {
      chapterNumber,
      chapter: chapterOutline,
      outline,
      memoryText: bundle.memoryText,
      canonText: bundle.canonText,
      connectedText: bundle.connectedText,
      previousChapterTail: bundle.previousTail,
      userInstructions: opts.userInstructions,
      sceneSummary: opts.sceneSummary,
      preferences: outline.preferences,
      targetWords: opts.targetWords,
      dedupeThreshold: opts.dedupeThreshold,
      segments: opts.segments,
    },
    async (req) => {
      const { answer } = await resolveContextRequest(db, contextLlm, projectId, req, placeholder.id, limits);
      return answer;
    },
    limits,
  );
  } catch (err) {
    if (!hadExisting) {
      db.run('DELETE FROM chapter WHERE project_id = ? AND number = ?', projectId, chapterNumber);
    }
    throw err;
  }

  const chapter = saveChapter(db, projectId, chapterNumber, {
    title: chapterOutline?.title ?? `Chapter ${chapterNumber}`,
    body: result.prose,
    status: 'draft',
    outlineId: outline.id,
  });

  const settings = continuitySettings(getProject(db, projectId)!);
  const issues =
    !opts.skipContinuity && settings.enabled && settings.onDraft
      ? await runContinuityCheck(db, llm, projectId, chapter, outline, bundle)
      : [];

  return { chapter, trace: result.trace, issues, stats: result.stats };
}

/** Approve a chapter: fold it into memory and continuity state. */
export async function approveChapter(
  db: Db,
  llm: LlmClient,
  projectId: number,
  chapterNumber: number,
): Promise<{
  chapter: Chapter;
  issues: continuity.ContinuityIssue[];
  conflicts: ReturnType<typeof listConflicts>;
}> {
  const chapter = getChapter(db, projectId, chapterNumber);
  if (!chapter) throw new Error(`chapter ${chapterNumber} not found`);
  if (!chapter.body.trim()) throw new Error('chapter has no text');

  const outline = planner.approvedOutline(db, projectId);
  const chapterOutline = outline?.chapters.find((c) => c.number === chapterNumber);

  const canonEvents = db.all<{ id: number; title: string; summary: string }>(
    'SELECT id, title, summary FROM canon_event WHERE project_id = ? ORDER BY id DESC LIMIT 60',
    projectId,
  );

  const extraction = await memory.extractState(llm, chapter.body, { canonEvents });

  // What the chapter claims, compared with what the story already knows.
  // The conflict is recorded; nothing established is overwritten quietly.
  const conflicts = detectConflicts(db, projectId, chapter.id, extraction);

  db.transaction(() => {
    memory.clearChapterExtraction(db, projectId, chapter.id);
    memory.applyStateExtraction(db, projectId, chapter.id, extraction, { source: 'au' });
    if (conflicts.length) saveConflicts(db, projectId, chapter.id, conflicts);
  });

  if (extraction.summary) {
    db.run('UPDATE chapter SET summary = ?, approved_at = ?, updated_at = ?, status = ? WHERE id = ?',
      extraction.summary, nowIso(), nowIso(), 'approved', chapter.id);
  } else {
    db.run('UPDATE chapter SET approved_at = ?, updated_at = ?, status = ? WHERE id = ?',
      nowIso(), nowIso(), 'approved', chapter.id);
  }

  const updated = getChapter(db, projectId, chapterNumber)!;
  const settings = continuitySettings(getProject(db, projectId)!);
  let issues: continuity.ContinuityIssue[] = [];
  if (settings.enabled) {
    const bundle = await assembleContext(db, llm, projectId, {
      chapter: chapterOutline,
      chapterNumber,
    });
    issues = await runContinuityCheck(db, llm, projectId, updated, outline, bundle);
  }

  return {
    chapter: updated,
    issues,
    conflicts: conflicts.length ? listConflicts(db, projectId, { openOnly: true }) : [],
  };
}

/** Keeper/provisional ties whose endpoints both appear in the chapter. */
function keeperTiesForChapter(
  db: Db,
  projectId: number,
  body: string,
  statuses: string[],
): continuity.KeeperTie[] {
  const rows = db.all<{
    kind: string;
    evidence: string;
    source_refs: string;
    from_name: string;
    from_aliases: string;
    to_name: string;
    to_aliases: string;
  }>(
    `SELECT r.kind, r.evidence, r.source_refs,
            a.name AS from_name, a.aliases AS from_aliases,
            b.name AS to_name, b.aliases AS to_aliases
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status IN (${statuses.map(() => '?').join(',')})
      ORDER BY r.id`,
    projectId,
    ...statuses,
  );
  const out: continuity.KeeperTie[] = [];
  for (const row of rows) {
    const fromVariants = [row.from_name, ...strList(row.from_aliases)];
    const toVariants = [row.to_name, ...strList(row.to_aliases)];
    if (!fromVariants.some((name) => nameMentionedExact(name, body))) continue;
    if (!toVariants.some((name) => nameMentionedExact(name, body))) continue;
    let locator = '';
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { locator?: unknown }[];
      locator = String(refs.find((ref) => typeof ref?.locator === 'string')?.locator ?? '');
    } catch {
      locator = '';
    }
    out.push({
      fromName: row.from_name,
      fromAliases: strList(row.from_aliases),
      toName: row.to_name,
      toAliases: strList(row.to_aliases),
      kind: row.kind,
      evidence: row.evidence,
      locator,
    });
  }
  return out;
}

/** Run the continuity checker over a chapter and persist the findings. */
export async function runContinuityCheck(
  db: Db,
  llm: LlmClient,
  projectId: number,
  chapter: Chapter,
  outline: planner.Outline | undefined,
  bundle?: ContextBundle,
  report?: { droppedModelIssues: number },
): Promise<continuity.ContinuityIssue[]> {
  const project = getProject(db, projectId);
  const settings = project ? continuitySettings(project) : { enabled: true, modelChecks: true, minSeverity: 'warning' as const, onDraft: true };
  if (!settings.enabled) return [];

  const slice = memory.buildContextSlice(db, projectId, {});
  const outlineText = outline
    ? JSON.stringify(
        outline.chapters.find((c) => c.number === chapter.number) ?? { number: chapter.number },
        null,
        2,
      )
    : '';
  const stats = { droppedModelIssues: 0 };
  const issues = await continuity.checkChapter(db, projectId, chapter, slice, {
    useModel: settings.modelChecks,
    llm,
    outlineText,
    memoryText: bundle?.memoryText ?? memory.renderContextSlice(slice),
    canonText: bundle?.canonText ?? '',
    connectedText: bundle?.connectedText ?? '',
    keeperTies: keeperTiesForChapter(db, projectId, chapter.body, ['accepted', 'user_confirmed']),
    provisionalTies: keeperTiesForChapter(db, projectId, chapter.body, ['provisional']),
    stats,
  });
  if (report) report.droppedModelIssues = stats.droppedModelIssues;
  // Every finding is persisted; minSeverity is a display filter, not a
  // deletion rule. Callers that print get the filtered view.
  const visible = filterBySeverity(issues, settings);
  db.run('DELETE FROM continuity_issue WHERE project_id = ? AND chapter_id = ?', projectId, chapter.id);
  continuity.saveIssues(db, projectId, chapter.id, issues);
  return visible;
}

/* ------------------------------------------------------- impact analysis */

/**
 * Find material affected by a change, instead of silently changing it.
 *
 * Used when an approved chapter or a story fact is revised: it reports which
 * earlier/later chapters mention the affected subject.
 */
export function impactedMaterial(
  db: Db,
  projectId: number,
  subject: string,
  opts: { excludeChapter?: number } = {},
): { chapter: Chapter; matches: string[] }[] {
  const chapters = listChapters(db, projectId);
  const needle = subject.toLowerCase();
  const out: { chapter: Chapter; matches: string[] }[] = [];
  for (const c of chapters) {
    if (opts.excludeChapter && c.number === opts.excludeChapter) continue;
    const lines = c.body.split('\n').filter((l) => l.toLowerCase().includes(needle));
    if (lines.length) out.push({ chapter: c, matches: lines.slice(0, 5) });
  }
  return out;
}

/* --------------------------------------------------------------- planning */

/**
 * Draft a plan with the planner, grounding it in retrieved canon.
 *
 * Canon references produced by the model are validated against the canon
 * event index: ids that do not exist are dropped and reported, so a plan can
 * never point at events that were never indexed.
 */
/**
 * The canon-event index for a plan.
 *
 * The events the premise touches come first, then the rest, and the whole
 * index is kept inside a character budget: a planner whose context is full
 * cannot finish its outline, and a truncated outline is worth nothing.
 */
export function selectCanonEvents(
  db: Db,
  projectId: number,
  premise: string,
  divergence = '',
  budget = 5000,
): lore.CanonEvent[] {
  // The whole index, not the first 200 events: ordered by passage, that cut
  // reached passage 265 of 527, so the planner never saw the second half.
  const all = lore.listCanonEvents(db, projectId, 5000);
  const words = new Set(
    `${premise} ${divergence}`
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const score = (e: lore.CanonEvent): number => {
    const text = `${e.title} ${e.summary} ${e.participants.join(' ')}`.toLowerCase();
    let n = 0;
    for (const w of words) if (text.includes(w)) n++;
    return n;
  };
  const ranked = [...all].sort((a, b) => score(b) - score(a) || a.id - b.id);
  const out: lore.CanonEvent[] = [];
  let used = 0;
  for (const e of ranked) {
    const line = `- ${e.id}: ${e.title}${e.summary ? ` — ${truncate(e.summary, 160)}` : ''}\n`;
    if (used + line.length > budget) break;
    used += line.length;
    out.push(e);
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Established relationships among the cast the premise and divergence name.
 *
 * Deterministic: the roster names are matched with the LINK policy, then
 * asserted, keeper-grade relation rows are collected — ties with both endpoints
 * in the cast first, widened to ties naming at least one endpoint only when
 * those are scarce. User-confirmed rows sort first so the author's own ruling
 * outranks a derived pick.
 */
function castNames(db: Db, projectId: number, text: string): string[] {
  const entities = lorebook.listEntities(db, projectId);
  const names: string[] = [];
  for (const entity of entities) {
    if (nameMentioned(entity.name, text) || entity.aliases.some((alias) => nameMentioned(alias, text))) {
      names.push(entity.name);
    }
  }
  return names;
}

function castRelationshipBlock(db: Db, projectId: number, text: string): string {
  const entities = lorebook.listEntities(db, projectId);
  const cast = new Set<number>();
  for (const entity of entities) {
    if (nameMentioned(entity.name, text) || entity.aliases.some((alias) => nameMentioned(alias, text))) {
      cast.add(entity.id);
    }
  }
  if (!cast.size) return '';
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    from_name: string;
    to_name: string;
    kind: string;
    review_status: string;
    confirmed_by_user: number | null;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, a.name AS from_name, b.name AS to_name,
            r.kind, r.review_status, r.confirmed_by_user
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ?
        AND COALESCE(r.modality, 'asserted') = 'asserted'
        AND (r.confirmed_by_user = 1 OR r.review_status IN ('accepted','user_confirmed'))
        AND lower(r.kind) != 'appears with'
      ORDER BY CASE WHEN r.confirmed_by_user = 1 THEN 0
                    WHEN r.review_status = 'user_confirmed' THEN 1
                    ELSE 2 END,
               r.id`,
    projectId,
  );
  const both = rows.filter((row) => cast.has(row.from_entity) && cast.has(row.to_entity));
  const chosen = both.slice(0, 40);
  if (chosen.length < 5) {
    const seen = new Set(chosen.map((row) => row.id));
    for (const row of rows) {
      if (chosen.length >= 40) break;
      if (seen.has(row.id)) continue;
      if (!cast.has(row.from_entity) && !cast.has(row.to_entity)) continue;
      chosen.push(row);
      seen.add(row.id);
    }
  }
  // Selection runs in two stages, so order the final list again: the author's
  // confirmation first, then user-confirmed, then accepted, then by id.
  const rank = (row: { review_status: string; confirmed_by_user: number | null }): number =>
    row.confirmed_by_user === 1 ? 0 : row.review_status === 'user_confirmed' ? 1 : 2;
  chosen.sort((x, y) => rank(x) - rank(y) || x.id - y.id);
  return chosen
    .map((row) => {
      const confirmed = row.confirmed_by_user === 1 || row.review_status === 'user_confirmed';
      return `- ${row.from_name} — ${row.kind} — ${row.to_name}  [${confirmed ? 'user-confirmed' : 'quoted'}]`;
    })
    .join('\n');
}

export async function draftPlan(
  db: Db,
  llm: LlmClient,
  projectId: number,
  req: {
    premise: string;
    divergence?: string;
    chapterCount?: number;
    preferences?: Record<string, string>;
    userNotes?: string;
  },
): Promise<{ outline: planner.Outline; warnings: string[] }> {
  const premiseText = `${req.premise} ${req.divergence ?? ''}`;
  const passages = await lore.searchCanon(db, projectId, premiseText, {
    limit: 8,
  });
  const brief = passages.map((p) => p.text).join('\n\n');
  // Established ties among the cast the premise names. Deterministic, separate
  // from the retrieved canon brief so a user-confirmed tie is never buried.
  const castRelationships = castRelationshipBlock(db, projectId, premiseText);

  // The evidence web, for the same cast. A failure here is logged and the plan
  // proceeds without it: the web must never cost a planning run.
  let webBrief: string | undefined;
  const cast = castNames(db, projectId, premiseText);
  if (cast.length) {
    try {
      const web = buildWebBrief(db, projectId, { entities: cast });
      const rendered = renderWebBrief(web);
      if (rendered) webBrief = rendered;
    } catch (err) {
      console.warn(`  evidence web brief skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The connected view of the premise: who it touches, what it connects to, and
  // what the story has already changed. The planner needs the consequences, not
  // just the names.
  const graphContext = graph.buildGraphContext(db, projectId, {
    query: `${req.premise} ${req.divergence ?? ''}`,
    focus: graph.terms(`${req.premise} ${req.divergence ?? ''}`).slice(0, 4),
    hops: 1,
    maxNodes: 30,
    maxWords: 800,
  }).text;

  // The canon-event index is the largest part of the planner's prompt, and a
  // planner whose context is full cannot finish its outline. The events that
  // the premise actually touches come first, and the whole index is kept
  // inside a character budget.
  const canonEvents = selectCanonEvents(db, projectId, req.premise, req.divergence ?? '');

  const data = await planner.draftOutline(llm, {
    premise: req.premise,
    divergence: req.divergence,
    chapterCount: req.chapterCount,
    preferences: req.preferences,
    canonBrief: brief,
    castRelationships,
    webBrief,
    graphContext,
    canonEvents: canonEvents.map((e) => ({ id: e.id, title: e.title, summary: e.summary })),
    userNotes: req.userNotes,
  });

  const warnings: string[] = [];
  const validIds = new Set(canonEvents.map((e) => e.id));
  const check = (ids: number[], where: string): number[] => {
    const kept: number[] = [];
    for (const id of ids) {
      if (!Number.isFinite(id)) continue; // a malformed reference, not a missing one
      if (validIds.has(id)) kept.push(id);
      else warnings.push(`${where}: dropped canon event ${id} (not in the canon index the model was given)`);
    }
    return kept;
  };

  data.canonRefs = check(data.canonRefs, 'outline');
  for (const ch of data.chapters) {
    ch.canonEventIds = check(ch.canonEventIds, `chapter ${ch.number}`);
    for (const s of ch.scenes) s.canonEventIds = check(s.canonEventIds, `chapter ${ch.number} scene "${s.title}"`);
  }

  // A divergence that points at a canon event by number gets the same gate:
  // free text ("when the council falls") passes untouched, but "canon event
  // 12" with no 12 in the index is dropped with a warning, not banked blind.
  const divRef = /canon event\s+#?(\d+)|event\s+#(\d+)/i.exec(data.divergenceRef ?? '');
  if (divRef) {
    const id = Number(divRef[1] ?? divRef[2]);
    if (!Number.isFinite(id) || !validIds.has(id)) {
      warnings.push(`divergence: dropped canon event reference ${id} (not in the canon index the model was given)`);
      data.divergenceRef = '';
    }
  }

  // A premise that contradicts the canon is flagged, not silently accepted.
  for (const w of checkPremise(db, projectId, req.premise, req.divergence ?? '')) {
    warnings.push(`${w.kind}: ${w.message}`);
  }

  const outline = planner.saveOutline(db, projectId, { ...data, status: 'draft' });
  return { outline, warnings };
}

/* ------------------------------------------------------------------ facade */

export class App {
  readonly db: Db;
  readonly projectId: number;
  readonly llm: LlmClient;
  constructor(db: Db, projectId: number, llm: LlmClient) {
    this.db = db;
    this.projectId = projectId;
    this.llm = llm;
  }

  get project(): Project {
    const p = getProject(this.db, this.projectId);
    if (!p) throw new Error('project not found');
    return p;
  }

  setSettings(patch: Partial<LlmSettings>): void {
    updateProjectSettings(this.db, this.projectId, patch as Record<string, unknown>);
  }

  client(): LlmClient {
    return clientFrom(this.project.settings);
  }
}

export { createClient };
