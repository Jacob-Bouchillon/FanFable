/**
 * Canon search.
 *
 * Moved mechanically from lore.ts; imports only, no logic change.
 */
import { Db } from '../core/db.ts';
import type { LlmClient } from '../core/llm.ts';
import { extractJson, toStringArray } from '../core/json.ts';
import { lexicalScore } from '../core/text.ts';
import { STOPWORDS } from '../core/vocab.ts';
import { SEARCH_CANDIDATE_POOL, SEARCH_CANDIDATE_POOL_MAX } from '../support/search-policy.ts';
import * as lorebook from '../lorebook.ts';
import type { Passage } from './lore.ts';

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
  /** A caller-built bank profile, shared across expansion and ranking. */
  bankProfile?: lorebook.BankQueryProfile;
}

/**
 * How wide the lexical candidate pool is before bank ranking.
 *
 * A keeper passage often mentions its endpoints without repeating the word
 * the question used ("apprentice"), so BM25 can rank it far below the cut.
 * Fetching a wider pool gives the bank ranker something to promote; the
 * caller still receives only `limit` passages. Capped so a query cannot scan
 * an unbounded slice of a large book.
 */
/**
 * Full-text search over canon chunks, ranked by BM25.
 *
 * Returns passages with the source reference information the spec requires:
 * source title, file path, locator and heading.
 */
export function searchCanon(db: Db, projectId: number, query: string, opts: SearchOptions = {}): Passage[] {
  const limit = opts.limit ?? 8;
  const searchText = [query, ...(opts.expand ?? [])].join(' ');
  // Expansion widens what the lexical index may return; ranking reads the
  // question as asked, so an expanded synonym cannot quietly change who the
  // query names.
  const rankText = query;
  const match = toMatchExpression(searchText);
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
  params.push(Math.min(SEARCH_CANDIDATE_POOL_MAX, Math.max(limit * 12, SEARCH_CANDIDATE_POOL)));

  let rows: Record<string, unknown>[];
  try {
    rows = db.all<Record<string, unknown>>(sql, ...params);
  } catch {
    return [];
  }

  // Merge chunks that are adjacent in the same source so the model sees flow.
  const passages: Passage[] = [];
  for (const r of rows) {
    const score = lexicalScore(Number(r.rank ?? 0));
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

  // Bank-backed candidates: relations the query names can prove, even when
  // the passage itself does not repeat the query word. The wider pool above
  // and this expansion only decide what the ranker may see; the caller still
  // gets `limit` passages, and ranking never filters.
  const bankProfile = opts.bankProfile ?? lorebook.buildBankProfile(db, projectId, rankText);
  const seen = new Set(passages.map((p) => p.chunkId));
  const bankIds = lorebook
    .bankLinkedChunkIds(db, projectId, rankText, undefined, bankProfile)
    .filter((chunkId) => !seen.has(chunkId));
  for (const chunk of getChunks(db, bankIds)) {
    if (seen.has(chunk.chunkId)) continue;
    if (opts.sourceId && chunk.sourceId !== opts.sourceId) continue;
    chunk.score = 0;
    passages.push(chunk);
    seen.add(chunk.chunkId);
  }

  passages.sort((a, b) => b.score - a.score);
  const ranked = lorebook.rankWithBank(db, projectId, rankText, passages, bankProfile);
  return ranked.slice(0, limit);
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

export function getChunks(db: Db, chunkIds: number[]): Passage[] {
  const ids = [...new Set(chunkIds)].filter((id) => Number.isFinite(id));
  if (!ids.length) return [];
  const rows = db.all<{
    id: number;
    source_id: number;
    locator: string;
    heading: string;
    text: string;
    title: string;
    path: string;
  }>(
    `SELECT c.id, c.source_id, c.locator, c.heading, c.text, s.title, s.path
     FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
     WHERE c.id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  return rows.map((r) => ({
    chunkId: r.id,
    sourceId: r.source_id,
    sourceTitle: r.title,
    path: r.path,
    locator: r.locator,
    heading: r.heading,
    text: r.text,
    score: 1,
  }));
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
