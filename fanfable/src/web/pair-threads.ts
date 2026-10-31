/**
 * Code-only pair threads.
 *
 * Structural coverage for discovery: one row per character pair that shares
 * at least one passage, built mechanically with no model. A thread is an
 * empty scaffold — "no evidence yet", never "no relationship" — and is never
 * promoted into the bank. This module never writes to `canon_relation`,
 * `canon_tie_note` or `canon_tie_hint`.
 *
 * Identity follows the same path as the sentence scan: the roster index is
 * built over every entity plus the full chunk text, each non-quarantined
 * character is matched by its derived name variants, presence is an exact
 * contiguous token-sequence match, and nested names (one entity's canonical
 * tokens inside the other's) are refused as one person the bank split.
 */
import { Db, nowIso, strList, toJson } from '../db.ts';
import { buildRosterIndex, canonicalName, deriveNameVariants } from '../identity/names.ts';

export interface PairThreadBuild {
  /** Non-quarantined characters considered. */
  people: number;
  /** Distinct qualifying pairs found sharing a passage. */
  cooccurringPairs: number;
  /** Thread rows in the table after the build. */
  pairsWithRows: number;
  /** Thread rows with no relation in either direction, at any status. */
  unproposedPairs: number;
  threadsCreated: number;
  threadsUpdated: number;
}

export interface PairThreadCounts {
  threads: number;
  unproposed: number;
}

interface EntityBits {
  id: number;
  name: string;
  tokens: string[];
  variants: string[][];
}

/** Exact contiguous token-sequence matches, the same predicate as the scan. */
function positions(tokens: string[], target: string[]): number[] {
  const at: number[] = [];
  if (!target.length) return at;
  for (let i = 0; i + target.length <= tokens.length; i++) {
    if (target.every((word, k) => tokens[i + k] === word)) at.push(i);
  }
  return at;
}

/** One canonical name nesting contiguously inside the other: one person split. */
function nests(short: string[], long: string[]): boolean {
  return (
    short.length > 0 &&
    short.length < long.length &&
    long.some((_, at) => short.every((word, k) => long[at + k] === word))
  );
}

/**
 * Build (or refresh) the pair threads for a project.
 *
 * Transactional and idempotent: re-running without new mentions creates and
 * updates nothing. Returns reconciliation counts for the run report.
 */
export function buildPairThreads(db: Db, projectId: number): PairThreadBuild {
  const allRows = db
    .all<{ name: string; aliases: string }>(
      'SELECT name, aliases FROM canon_entity WHERE project_id = ?',
      projectId,
    )
    .map((row) => ({ name: row.name, aliases: strList(row.aliases) }));
  const chunkRows = db.all<{ id: number; seq: number; text: string }>(
    'SELECT id, seq, text FROM canon_chunk WHERE project_id = ? ORDER BY source_id, seq',
    projectId,
  );
  const index = buildRosterIndex(
    allRows,
    chunkRows.map((chunk) => chunk.text).join(' '),
  );
  const entities: EntityBits[] = db
    .all<{ id: number; name: string; aliases: string }>(
      "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined'",
      projectId,
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      tokens: canonicalName(row.name).split(' ').filter(Boolean),
      variants: deriveNameVariants({ name: row.name, aliases: strList(row.aliases) }, index)
        .map((variant) => canonicalName(variant).split(' ').filter(Boolean))
        .filter((tokens) => tokens.length > 0),
    }))
    .filter((row) => row.variants.length > 0);

  const pairChunks = new Map<string, { a: number; b: number; chunks: { id: number; seq: number }[] }>();
  for (const chunk of chunkRows) {
    const tokens = canonicalName(chunk.text).split(' ').filter(Boolean);
    if (tokens.length < 2) continue;
    const present = entities.filter((entity) =>
      entity.variants.some((variant) => positions(tokens, variant).length > 0),
    );
    if (present.length < 2) continue;
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = present[i]!;
        const b = present[j]!;
        if (nests(a.tokens, b.tokens) || nests(b.tokens, a.tokens)) continue;
        const lo = Math.min(a.id, b.id);
        const hi = Math.max(a.id, b.id);
        const key = `${lo}|${hi}`;
        const entry = pairChunks.get(key) ?? { a: lo, b: hi, chunks: [] };
        entry.chunks.push({ id: chunk.id, seq: chunk.seq });
        pairChunks.set(key, entry);
      }
    }
  }

  const at = nowIso();
  let threadsCreated = 0;
  let threadsUpdated = 0;
  db.transaction(() => {
    for (const { a, b, chunks } of pairChunks.values()) {
      const shared = toJson(chunks.map((c) => c.id));
      const firstSeq = chunks[0]!.seq;
      const lastSeq = chunks[chunks.length - 1]!.seq;
      const existing = db.get<{
        cooccur_count: number;
        shared_chunks: string;
        first_seq: number;
        last_seq: number;
      }>(
        'SELECT cooccur_count, shared_chunks, first_seq, last_seq FROM canon_pair_thread WHERE project_id = ? AND a_entity = ? AND b_entity = ?',
        projectId,
        a,
        b,
      );
      if (!existing) {
        db.run(
          `INSERT INTO canon_pair_thread
             (project_id, a_entity, b_entity, cooccur_count, shared_chunks, first_seq, last_seq, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'empty', ?, ?)`,
          projectId,
          a,
          b,
          chunks.length,
          shared,
          firstSeq,
          lastSeq,
          at,
          at,
        );
        threadsCreated++;
      } else if (
        existing.cooccur_count !== chunks.length ||
        existing.shared_chunks !== shared ||
        existing.first_seq !== firstSeq ||
        existing.last_seq !== lastSeq
      ) {
        db.run(
          `UPDATE canon_pair_thread
              SET cooccur_count = ?, shared_chunks = ?, first_seq = ?, last_seq = ?, updated_at = ?
            WHERE project_id = ? AND a_entity = ? AND b_entity = ?`,
          chunks.length,
          shared,
          firstSeq,
          lastSeq,
          at,
          projectId,
          a,
          b,
        );
        threadsUpdated++;
      }
    }
  });

  const counts = pairThreadCounts(db, projectId);
  return {
    people: entities.length,
    cooccurringPairs: pairChunks.size,
    pairsWithRows: counts.threads,
    unproposedPairs: counts.unproposed,
    threadsCreated,
    threadsUpdated,
  };
}

/** Counts only; never writes. */
export function pairThreadCounts(db: Db, projectId: number): PairThreadCounts {
  const threads =
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread WHERE project_id = ?', projectId)
      ?.n ?? 0;
  const unproposed =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM canon_pair_thread t
        WHERE t.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM canon_relation r
             WHERE r.project_id = t.project_id
               AND ((r.from_entity = t.a_entity AND r.to_entity = t.b_entity)
                 OR (r.from_entity = t.b_entity AND r.to_entity = t.a_entity))
          )`,
      projectId,
    )?.n ?? 0;
  return { threads, unproposed };
}
