/**
 * Edge ranking: gated, bounded consensus over banked ties.
 *
 * Provenance gates (rows without proof never rank), corroboration nudges
 * (independent windows behind one triple, capped), density breaks ties
 * (claims from quiet windows outrank claims from crowded ones). Pure
 * functions over plain rows: no database, no model, no migration. Same
 * input rows always produce the same order.
 *
 * Deliberately not here: graph walks per query, dense similarity, learned
 * weights. Those graduate only on human-judged material.
 */

/** The most corroboration one triple may contribute. A thread thicker than
 * this still counts exactly this — support nudges, never overrides. */
export const CORROBORATION_CAP = 5;

export interface RankRow {
  id: number;
  /** Entity ids, either direction. */
  a: number;
  b: number;
  kind: string;
  /** Exact quote behind the claim; empty means unproven. */
  evidence: string;
  /** Story position of the proving passage, when known. */
  chunkSeq: number | null;
}

/** One triple under either direction and any casing: the identity two rows
 * share when they assert the same tie. */
export function tripleKey(a: number, b: number, kind: string): string {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `${lo}:${hi}:${kind.trim().toLowerCase()}`;
}

/** How many claims each chunk produced (chunk id -> count). The density
 * weight of a row is 1 divided by its chunk's count: quiet windows win. */
export type ClaimsPerChunk = Map<number, number>;

/** Independent chunks behind one triple key (chunk id or -1 when unplaced). */
export function corroboration(
  rows: { key: string; chunk: number }[],
  key: string,
): number {
  const chunks = new Set<number>();
  for (const r of rows) if (r.key === key) chunks.add(r.chunk);
  return Math.min(chunks.size, CORROBORATION_CAP);
}

/**
 * Order rows for ranking display. Proven rows (non-empty proof) always come
 * before unproven ones; among proven rows, corroboration descends, then
 * density weight descends, then row id ascends for determinism. Unproven
 * rows keep id order among themselves at the end, never deleted here.
 */
export function rankRows<T extends RankRow>(
  rows: T[],
  claimsPerChunk: ClaimsPerChunk,
  chunkOf: (row: T) => number,
): T[] {
  const byKey = rows.map((r) => ({
    key: tripleKey(r.a, r.b, r.kind),
    chunk: chunkOf(r),
  }));
  const scored = rows.map((r) => {
    const key = tripleKey(r.a, r.b, r.kind);
    const proven = r.evidence.trim().length > 0;
    const corroborated = corroboration(byKey, key);
    const claims = Math.max(1, claimsPerChunk.get(chunkOf(r)) ?? 1);
    return { r, proven, corroborated, density: 1 / claims };
  });
  return scored
    .sort((x, y) => {
      if (x.proven !== y.proven) return x.proven ? -1 : 1;
      if (x.corroborated !== y.corroborated) return y.corroborated - x.corroborated;
      if (x.density !== y.density) return y.density - x.density;
      return x.r.id - y.r.id;
    })
    .map((s) => s.r);
}
