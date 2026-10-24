/**
 * Lore Researcher.
 *
 * Owns the canon side of the system: importing source material, searching it,
 * and answering lore questions with citations. Canon is write-once — nothing in
 * the story pipeline may modify a canon_source, canon_chunk or canon_event row.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { Db, nowIso, strList } from './db.ts';
import { asRecordArray, extractJson, salvageJsonArray, toStringArray } from './json.ts';
import type { LlmClient } from './llm.ts';
import { chunkText, titleFromPath, truncate, wordCount, STOPWORDS } from './text.ts';
import { importFile, readTextFile, type ImportedText } from './importer.ts';
import * as lorebook from './lorebook.ts';

export interface SourceInfo {
  id: number;
  path: string;
  title: string;
  author: string;
  format: string;
  sha256: string;
  byteSize: number;
  pageCount: number;
  importedAt: string;
}

export interface Passage {
  chunkId: number;
  sourceId: number;
  sourceTitle: string;
  path: string;
  locator: string;
  heading: string;
  text: string;
  score: number;
}

/* --------------------------------------------------------------- importing */

/**
 * Import a source file.
 *
 * Plain text and Markdown are read synchronously. PDF, EPUB and DOCX need
 * external tools or archive parsing, so use `importSourceAsync` for those.
 */
export function importSource(
  db: Db,
  projectId: number,
  filePath: string,
  opts: { title?: string; author?: string; maxWords?: number; overwrite?: boolean } = {},
): { source: SourceInfo; chunks: number; replaced: boolean } {
  return storeSource(db, projectId, filePath, readTextFile(filePath), opts);
}

/** Import any supported format, including PDF, EPUB and DOCX. */
export async function importSourceAsync(
  db: Db,
  projectId: number,
  filePath: string,
  opts: { title?: string; author?: string; maxWords?: number; overwrite?: boolean } = {},
): Promise<{ source: SourceInfo; chunks: number; replaced: boolean }> {
  const imported = await importFile(filePath);
  return storeSource(db, projectId, filePath, imported, opts);
}

function storeSource(
  db: Db,
  projectId: number,
  filePath: string,
  imported: ImportedText,
  opts: { title?: string; author?: string; maxWords?: number; overwrite?: boolean },
): { source: SourceInfo; chunks: number; replaced: boolean } {
  const raw = imported.text;
  const sha = createHash('sha256').update(raw).digest('hex');
  const title = opts.title ?? imported.title ?? titleFromPath(filePath);

  const existing = db.get<{ id: number }>(
    'SELECT id FROM canon_source WHERE project_id = ? AND path = ?',
    projectId,
    filePath,
  );
  if (existing && !opts.overwrite) {
    const row = db.get<RowSource>('SELECT * FROM canon_source WHERE id = ?', existing.id)!;
    return {
      source: {
        id: row.id,
        path: row.path,
        title: row.title,
        author: row.author,
        format: row.format,
        sha256: row.sha256,
        byteSize: row.byte_size,
        pageCount: row.page_count,
        importedAt: row.imported_at,
      },
      chunks: 0,
      replaced: false,
    };
  }

  let sourceId: number;
  let replaced = false;
  if (existing) {
    replaced = true;
    db.run('DELETE FROM canon_source WHERE id = ?', existing.id);
  }
  const res = db.run(
    `INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    filePath,
    title,
    opts.author ?? imported.author,
    imported.format,
    sha,
    statSync(filePath).size,
    imported.pageCount,
    nowIso(),
  );
  sourceId = res.lastInsertRowid;

  const chunks = chunkText(raw, { maxWords: opts.maxWords ?? 220 });
  db.transaction(() => {
    for (const c of chunks) {
      const page = c.pageStart ? (c.pageEnd > c.pageStart ? `p. ${c.pageStart}-${c.pageEnd}` : `p. ${c.pageStart}`) : '';
      const locator = c.heading ? (page ? `${c.heading} (${page})` : c.heading) : page || `passage ${c.seq + 1}`;
      db.run(
        `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sourceId,
        projectId,
        c.seq,
        locator,
        c.heading,
        c.text,
        c.charStart,
        c.charEnd,
        wordCount(c.text),
        c.pageStart,
        c.pageEnd,
      );
    }
  });

  return {
    source: {
      id: sourceId,
      path: filePath,
      title,
      author: opts.author ?? imported.author,
      format: imported.format,
      sha256: sha,
      byteSize: statSync(filePath).size,
      pageCount: imported.pageCount,
      importedAt: nowIso(),
    },
    chunks: chunks.length,
    replaced,
  };
}

interface RowSource {
  id: number;
  path: string;
  title: string;
  author: string;
  format: string;
  sha256: string;
  byte_size: number;
  page_count: number;
  imported_at: string;
}

export function listSources(db: Db, projectId: number): SourceInfo[] {
  const rows = db.all<RowSource>(
    'SELECT * FROM canon_source WHERE project_id = ? ORDER BY title',
    projectId,
  );
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    author: r.author,
    format: r.format,
    sha256: r.sha256,
    byteSize: r.byte_size,
    pageCount: r.page_count,
    importedAt: r.imported_at,
  }));
}

/* ---------------------------------------------------------------- searching */

/**
 * Turn a free-text query into an FTS5-safe MATCH expression.
 *
 * Very common words are dropped: FTS5 matches with OR, so leaving "the" in
 * would make every passage a candidate and drown the real ones.
 */
export function toMatchExpression(query: string): string {
  const terms = (query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (!terms.length) return '';
  return terms.map((t) => `"${t}"`).join(' OR ');
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to a single canon source. */
  sourceId?: number;
  /** Extra terms injected by query expansion. */
  expand?: string[];
}

/**
 * Full-text search over canon chunks, ranked by BM25.
 *
 * Returns passages with the source reference information the spec requires:
 * source title, file path, locator and heading.
 */
export function searchCanon(db: Db, projectId: number, query: string, opts: SearchOptions = {}): Passage[] {
  const limit = opts.limit ?? 8;
  const match = toMatchExpression([query, ...(opts.expand ?? [])].join(' '));
  if (!match) return [];

  let sql = `
    SELECT c.id AS chunk_id, c.source_id, c.locator, c.heading, c.text,
           s.title AS source_title, s.path,
           bm25(canon_chunk_fts) AS rank
    FROM canon_chunk_fts
    JOIN canon_chunk c ON c.id = canon_chunk_fts.rowid
    JOIN canon_source s ON s.id = c.source_id
    WHERE canon_chunk_fts MATCH ? AND c.project_id = ?`;
  const params: unknown[] = [match, projectId];
  if (opts.sourceId) {
    sql += ' AND c.source_id = ?';
    params.push(opts.sourceId);
  }
  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit * 3);

  let rows: Record<string, unknown>[];
  try {
    rows = db.all<Record<string, unknown>>(sql, ...params);
  } catch {
    return [];
  }

  // Merge chunks that are adjacent in the same source so the model sees flow.
  const passages: Passage[] = [];
  for (const r of rows) {
    const score = 1 / (1 + Number(r.rank ?? 0));
    passages.push({
      chunkId: Number(r.chunk_id),
      sourceId: Number(r.source_id),
      sourceTitle: String(r.source_title),
      path: String(r.path),
      locator: String(r.locator),
      heading: String(r.heading ?? ''),
      text: String(r.text),
      score,
    });
  }

  passages.sort((a, b) => b.score - a.score);
  return passages.slice(0, limit);
}

export function getChunk(db: Db, chunkId: number): Passage | undefined {
  const r = db.get<{
    id: number;
    source_id: number;
    locator: string;
    heading: string;
    text: string;
    title: string;
    path: string;
  }>(
    `SELECT c.id, c.source_id, c.locator, c.heading, c.text, s.title, s.path
     FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.id = ?`,
    chunkId,
  );
  if (!r) return undefined;
  return {
    chunkId: r.id,
    sourceId: r.source_id,
    sourceTitle: r.title,
    path: r.path,
    locator: r.locator,
    heading: r.heading,
    text: r.text,
    score: 1,
  };
}

/* ------------------------------------------------------- concept expansion */

/**
 * Ask the model to widen a query into related search terms. Falls back to the
 * original query when the model is unavailable.
 */
export async function expandQuery(llm: LlmClient, query: string, maxTerms = 6): Promise<string[]> {
  try {
    const res = await llm.chat({
      system:
        'You expand a lore question into search keywords for a full-text index of a book. ' +
        'Reply with JSON only: {"terms":["...","..."]}. Use proper names, aliases, ' +
        'places, objects and common synonyms. No prose.',
      messages: [{ role: 'user', content: query }],
      temperature: 0.2,
      maxTokens: 200,
    });
    const parsed = extractJson<{ terms?: unknown }>(res.text);
    const terms = toStringArray(parsed?.terms).slice(0, maxTerms);
    return terms.filter((t) => t.toLowerCase() !== query.toLowerCase());
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- lore answers */

export interface LoreAnswer {
  answer: string;
  passages: Passage[];
  /** True when the model had enough evidence to ground its answer. */
  grounded: boolean;
}

const LORE_SYSTEM = `You are the Lore Researcher for a fanfiction project.
You answer questions about the original source material using the extracted lore index and the
retrieved passages. Those are the only permitted sources of canon.

Rules:
- Cite every claim with the passage label in square brackets, e.g. [S1], [S2], or with the
  entity name when the claim comes from the extracted index, e.g. [Lore: Ilsa Marrow].
- If the material does not contain the answer, say exactly what is missing. Do not invent canon details.
- Clearly separate CONFIRMED (directly supported) from INFERRED (a reasoned guess).
- Quote short key phrases from the source when they matter.
- Keep the answer focused and organised with short sections.`;

export function formatPassages(passages: Passage[]): string {
  return passages
    .map((p, i) => {
      const label = `S${i + 1}`;
      return `[${label}] source: ${p.sourceTitle} (${p.path}) | locator: ${p.locator}\n${p.text}`;
    })
    .join('\n\n');
}

/**
 * Answer a lore question from canon, with citations.
 *
 * `search` is optional; when omitted the researcher performs its own retrieval.
 */
export async function answerLoreQuestion(
  db: Db,
  llm: LlmClient,
  projectId: number,
  question: string,
  opts: { limit?: number; sourceId?: number; search?: Passage[] } = {},
): Promise<LoreAnswer> {
  let passages = opts.search ?? [];
  if (!passages.length) {
    const expanded = await expandQuery(llm, question);
    passages = searchCanon(db, projectId, question, { limit: opts.limit ?? 8, sourceId: opts.sourceId, expand: expanded });
  }

  // The extracted index often answers the question outright, before any
  // passage is needed.
  const index = lorebook.searchLore(db, projectId, question, 10);
  const indexText = formatLoreIndex(index);

  if (!passages.length && !indexText) {
    return {
      answer:
        'No canon passages matched and the lore index has nothing on this. Either the material has ' +
        'not been imported or extracted, or this detail is not present in the source. ' +
        'Nothing can be confirmed here.',
      passages,
      grounded: false,
    };
  }
  const res = await llm.chat({
    system: LORE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `QUESTION:\n${question}\n\n` +
          (indexText ? `EXTRACTED LORE INDEX (from the source material):\n${indexText}\n\n` : '') +
          (passages.length ? `RETRIEVED CANON PASSAGES:\n${formatPassages(passages)}\n\n` : '') +
          'Answer with citations. State clearly when evidence is missing.',
      },
    ],
    temperature: 0.3,
  });
  return {
    answer: res.text.trim(),
    passages,
    grounded: passages.length > 0 || indexText.length > 0,
  };
}

/** Render the extracted lore index for a prompt or a report. */
export function formatLoreIndex(index: {
  entities: lorebook.CanonEntity[];
  relations: lorebook.CanonRelation[];
  facts: lorebook.CanonFact[];
  timeline: lorebook.CanonTimelineEntry[];
}): string {
  const parts: string[] = [];
  if (index.entities.length) {
    parts.push(
      'ENTITIES:\n' +
        index.entities
          .map((e) => {
            const bits = [
              e.summary,
              e.role ? `role: ${e.role}` : '',
              e.status ? `status: ${e.status}` : '',
            ].filter(Boolean);
            return `- [Lore: ${e.name}] (${e.kind}) ${bits.join('. ')}`;
          })
          .join('\n'),
    );
  }
  if (index.relations.length) {
    parts.push(
      'RELATIONSHIPS:\n' +
        index.relations.map((r) => `- ${r.fromName} → ${r.toName}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`).join('\n'),
    );
  }
  if (index.facts.length) {
    parts.push(
      'FACTS:\n' +
        index.facts.map((f) => `- ${f.statement}${f.certainty === 'inferred' ? ' [inferred]' : ''}`).join('\n'),
    );
  }
  if (index.timeline.length) {
    parts.push(
      'TIMELINE:\n' +
        index.timeline.map((t) => `- ${t.when ? `${t.when}: ` : ''}${t.title}${t.location ? ` @ ${t.location}` : ''}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------- canon brief */

export interface CanonBrief {
  /** Canon facts that are safe to use, with passage citations. */
  facts: string;
  /** Canon scenes this chapter could adapt, and what happens in them. */
  scenes: string;
  /** Things the evidence does not settle, so the writer does not invent them. */
  cautions: string;
}

const BRIEF_SYSTEM = `You are the Lore Researcher preparing a canon brief for a writer.
You are given passages from the original source material and the outline of the chapter being written.

Reply with JSON only:
{
  "facts": ["fact ... [S1]", ...],
  "scenes": ["canon event: what happens, who is present, and the beats of it [S2]"],
  "cautions": ["detail the evidence does NOT settle, which the writer must not state as canon"]
}

Rules:
- Every fact and scene must cite the passage it came from, e.g. [S1].
- Only include what the passages actually support.
- Do not write prose for the story; this is a reference sheet, not a draft.`;

export const EMPTY_BRIEF: CanonBrief = { facts: '', scenes: '', cautions: '' };

/**
 * Turn retrieved passages into a compact reference sheet.
 *
 * The writer works from this brief by default and asks for the exact source
 * text only when it needs the wording. That keeps the prose the writer's own
 * instead of a paraphrase of the retrieved passage.
 */
export async function buildCanonBrief(
  llm: LlmClient,
  passages: Passage[],
  context: { goal?: string; characters?: string[]; scenes?: string } = {},
): Promise<CanonBrief> {
  if (!passages.length) return EMPTY_BRIEF;
  try {
    const res = await llm.chat({
      system: BRIEF_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `CHAPTER BEING WRITTEN:\n${context.goal ?? '(not specified)'}\n` +
            (context.characters?.length ? `CHARACTERS: ${context.characters.join(', ')}\n` : '') +
            (context.scenes ? `PLANNED SCENES:\n${context.scenes}\n` : '') +
            `\nPASSAGES:\n${formatPassages(passages)}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 1200,
    });
    const parsed = extractJson<{ facts?: unknown; scenes?: unknown; cautions?: unknown }>(res.text);
    return {
      facts: toStringArray(parsed?.facts).map((f) => `- ${f}`).join('\n'),
      scenes: toStringArray(parsed?.scenes).map((s) => `- ${s}`).join('\n'),
      cautions: toStringArray(parsed?.cautions).map((s) => `- ${s}`).join('\n'),
    };
  } catch {
    // Fall back to the raw passages rather than losing the canon grounding.
    return {
      facts: passages.map((p, i) => `- [S${i + 1}] ${truncate(p.text, 400)}`).join('\n'),
      scenes: '',
      cautions: '',
    };
  }
}

/** Render a brief as the block the writer sees. */
export function formatCanonBrief(brief: CanonBrief): string {
  const parts: string[] = [];
  if (brief.facts) parts.push(`CANON FACTS (use these; they are supported by the source):\n${brief.facts}`);
  if (brief.scenes) parts.push(`CANON SCENES AVAILABLE FOR ADAPTATION:\n${brief.scenes}`);
  if (brief.cautions) parts.push(`NOT ESTABLISHED BY THE EVIDENCE (do not state these as canon):\n${brief.cautions}`);
  if (!parts.length) return '';
  return (
    parts.join('\n\n') +
    '\n\nIf you need the exact wording of a canon scene, request it with a context request ' +
    '(kind "canon" or "lore") instead of assuming it.'
  );
}

/* ------------------------------------------------------- canon event index */

export interface CanonEvent {
  id: number;
  title: string;
  summary: string;
  locator: string;
  sourceTitle: string;
  path: string;
  participants: string[];
  location: string;
  timeLabel: string;
  kind: string;
  quote: string;
  score?: number;
}

/**
 * Extract canonical events from the imported material.
 *
 * This builds the index the AU links against, so that an adapted scene can
 * point at the canon event it came from. Nothing here modifies source text.
 */
export async function extractCanonEvents(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: {
    sourceId?: number;
    maxEvents?: number;
    chunkLimit?: number;
    /** How many passages to read at a time. */
    windowSize?: number;
    onProgress?: (message: string) => void;
    /** Structured window counts, for a progress monitor rather than the console. */
    onWindow?: (progress: {
      phase: 'events';
      done: number;
      total: number;
      passagesDone: number;
      passagesTotal: number;
    }) => void;
  } = {},
): Promise<CanonEvent[]> {
  const params: unknown[] = [projectId];
  let sql = `SELECT c.id, c.locator, c.heading, c.text, c.source_id, s.title, s.path
             FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
             WHERE c.project_id = ?`;
  if (opts.sourceId) {
    sql += ' AND c.source_id = ?';
    params.push(opts.sourceId);
  }
  sql += ' ORDER BY c.source_id, c.seq LIMIT ?';
  params.push(opts.chunkLimit ?? 200);

  const chunks = db.all<{
    id: number;
    locator: string;
    heading: string;
    text: string;
    source_id: number;
    title: string;
    path: string;
  }>(sql, ...params);
  if (!chunks.length) return [];

  // The events of a book are read in windows: one call for the whole book
  // would run out of tokens half way through.
  const windowSize = opts.windowSize ?? 8;
  const totalWindows = Math.ceil(chunks.length / windowSize);
  const created: CanonEvent[] = [];
  let done = 0;
  for (let start = 0; start < chunks.length; start += windowSize) {
    const window = chunks.slice(start, start + windowSize);
    const found = await extractEventsFromWindow(db, llm, projectId, window, opts);
    created.push(...found);
    done++;
    opts.onProgress?.(`read passages ${start + 1}-${start + window.length} of ${chunks.length}`);
    opts.onWindow?.({
      phase: 'events',
      done,
      total: totalWindows,
      passagesDone: start + window.length,
      passagesTotal: chunks.length,
    });
    if ((opts.maxEvents ?? 200) && created.length >= (opts.maxEvents ?? 200)) break;
  }
  return created;
}

/** Read one window of passages and record the events in it. */
async function extractEventsFromWindow(
  db: Db,
  llm: LlmClient,
  projectId: number,
  chunks: {
    id: number;
    locator: string;
    heading: string;
    text: string;
    source_id: number;
    title: string;
    path: string;
  }[],
  opts: { maxEvents?: number },
): Promise<CanonEvent[]> {
  const res = await llm.chat({
    system:
      'You index narrative events from a book for a fanfiction tool. ' +
      'Reply with JSON only: an array of objects with keys ' +
      '{"title":string,"summary":string,"participants":[string],"location":string,' +
      '"time_label":string,"kind":"scene|event|flashback|rule","chunk_index":number}. ' +
      'Only include events that actually occur in the passage. No prose.',
    messages: [
      {
        role: 'user',
        content:
          'PASSAGES:\n' +
          chunks.map((c, i) => `[#${i}] ${c.title} | ${c.locator}\n${truncate(c.text, 1200)}`).join('\n\n'),
      },
    ],
    temperature: 0.2,
    maxTokens: 2000,
  });

  // The model may return a bare array or an object with an "events" key, and
  // it may have run out of tokens part-way through: salvage what is complete.
  const parsedAny = extractJson<unknown>(res.text);
  const objects = parsedAny
    ? asRecordArray(Array.isArray(parsedAny) ? parsedAny : ((parsedAny as any)?.events ?? parsedAny))
    : salvageJsonArray(res.text);
  const created: CanonEvent[] = [];
  const max = opts.maxEvents ?? 200;
  for (const obj of objects) {
    if (created.length >= max) break;
    const idx = Number(obj.chunk_index);
    const chunk = chunks[idx];
    if (!chunk) continue;
    const title = String(obj.title ?? '').trim();
    if (!title) continue;
    const participants = toStringArray(obj.participants);
    const kind = String(obj.kind ?? 'event');
    const r = db.run(
      `INSERT INTO canon_event (project_id, source_id, chunk_id, locator, title, summary, participants, location, time_label, kind, quote, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      chunk.source_id,
      chunk.id,
      chunk.locator,
      title,
      String(obj.summary ?? '').trim(),
      JSON.stringify(participants),
      String(obj.location ?? '').trim(),
      String(obj.time_label ?? '').trim(),
      kind,
      truncate(chunk.text, 400),
      nowIso(),
    );
    created.push({
      id: r.lastInsertRowid,
      title,
      summary: String(obj.summary ?? '').trim(),
      locator: chunk.locator,
      sourceTitle: chunk.title,
      path: chunk.path,
      participants,
      location: String(obj.location ?? '').trim(),
      timeLabel: String(obj.time_label ?? '').trim(),
      kind,
      quote: truncate(chunk.text, 400),
    });
  }
  return created;
}

export function listCanonEvents(db: Db, projectId: number, limit = 100): CanonEvent[] {
  const rows = db.all<{
    id: number;
    title: string;
    summary: string;
    locator: string;
    participants: string;
    location: string;
    time_label: string;
    kind: string;
    quote: string;
    path: string;
    source_title: string;
  }>(
    `SELECT e.id, e.title, e.summary, e.locator, e.participants, e.location, e.time_label, e.kind, e.quote,
            s.path, s.title AS source_title
     FROM canon_event e LEFT JOIN canon_source s ON s.id = e.source_id
     WHERE e.project_id = ? ORDER BY e.id LIMIT ?`,
    projectId,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    locator: r.locator,
    sourceTitle: r.source_title ?? '',
    path: r.path ?? '',
    participants: strList(r.participants),
    location: r.location,
    timeLabel: r.time_label,
    kind: r.kind,
    quote: r.quote,
  }));
}
