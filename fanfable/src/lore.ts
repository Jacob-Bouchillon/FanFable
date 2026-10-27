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
import { chunkText, lexicalScore, titleFromPath, trimFrontBackMatter, truncate, wordCount } from './text.ts';
import { STOPWORDS } from './vocab.ts';
import { SEARCH_CANDIDATE_POOL, SEARCH_CANDIDATE_POOL_MAX } from './search-policy.ts';
import { nameMentioned } from './names.ts';
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

import {
  importSource,
  importSourceAsync,
  listSources,
} from './lore-import.ts';
import {
  expandQuery,
  getChunk,
  getChunks,
  searchCanon,
  toMatchExpression,
} from './lore-search.ts';
import {
  answerLoreQuestion,
  formatPassages,
  formatLoreIndex,
  passageNamesBoth,
} from './lore-ask.ts';
export {
  importSource,
  importSourceAsync,
  listSources,
} from './lore-import.ts';
export {
  expandQuery,
  getChunk,
  getChunks,
  searchCanon,
  toMatchExpression,
} from './lore-search.ts';
export type { SearchOptions } from './lore-search.ts';
export {
  answerLoreQuestion,
  formatPassages,
  formatLoreIndex,
  passageNamesBoth,
} from './lore-ask.ts';
export type { LoreAnswer } from './lore-ask.ts';

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
  let sql = `SELECT c.id, c.seq, c.locator, c.heading, c.text, c.source_id, s.title, s.path
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
    seq: number;
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
  // The lore pass may already have written timeline entries; join them to the
  // events that now exist.
  lorebook.linkTimelineToEvents(db, projectId);
  return created;
}

/** Read one window of passages and record the events in it. */
async function extractEventsFromWindow(
  db: Db,
  llm: LlmClient,
  projectId: number,
  chunks: {
    id: number;
    seq: number;
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
      `INSERT INTO canon_event (project_id, source_id, chunk_id, locator, title, summary, participants, location, time_label, kind, quote, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      chunk.seq,
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
