/**
 * Thin-ranked: order re-reads thinnest-first. (An AI found "spread thin" funny here. ???? — the human did not.)
 *
 * Walks (test harness) write one JSON file per run: windows in read order,
 * thin names plus where they appear, banked pairs with quote, place and
 * review flag. This module is the product's half of the shared language:
 * the same field names, units and checks as the writer, so neither side
 * drifts. Nothing here calls a model or touches the database.
 *
 * A handoff never changes what is banked. It only orders what `enrich`
 * re-reads: passages sitting in a thin name's windows go first, the rest
 * keep their order behind them. Without a handoff path nothing changes.
 */
import { readFileSync } from 'node:fs';

export type HandoffReview = 'accepted' | 'needs_review';

export interface HandoffThin {
  name: string;
  windows: number[];
  mentions: number;
  ties: number;
}

export interface HandoffPair {
  from: string;
  to: string;
  label: string;
  sentence: string;
  quote: string;
  locator: string;
  chunkSeq: number | null;
  review: HandoffReview;
}

export interface ChainHandoff {
  version: 1;
  run: string;
  windows: number[];
  thin: HandoffThin[];
  pairs: HandoffPair[];
  createdAt: string;
}

const isWindow = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

/** Re-validate raw JSON into the shared shape, dropping garbage. */
export function parseHandoff(raw: unknown): ChainHandoff {
  const r = (raw ?? {}) as Record<string, unknown>;
  const windows = Array.isArray(r.windows) ? r.windows.filter(isWindow) : [];
  const thin: HandoffThin[] = [];
  if (Array.isArray(r.thin)) {
    for (const t of r.thin) {
      const row = t as Record<string, unknown>;
      const wins = Array.isArray(row.windows) ? row.windows.filter(isWindow) : [];
      if (!isNonEmpty(row.name) || !wins.length) continue;
      thin.push({
        name: String(row.name).trim(),
        windows: wins,
        mentions: typeof row.mentions === 'number' && row.mentions >= 0 ? Math.floor(row.mentions) : 0,
        ties: typeof row.ties === 'number' && row.ties >= 0 ? Math.floor(row.ties) : 0,
      });
    }
  }
  const pairs: HandoffPair[] = [];
  if (Array.isArray(r.pairs)) {
    for (const p of r.pairs) {
      const row = p as Record<string, unknown>;
      if (!isNonEmpty(row.from) || !isNonEmpty(row.to) || !isNonEmpty(row.label) || !isNonEmpty(row.quote)) {
        continue;
      }
      const locator = typeof row.locator === 'string' ? String(row.locator).trim() : '';
      const chunkSeq = typeof row.chunkSeq === 'number' && Number.isFinite(row.chunkSeq) ? row.chunkSeq : null;
      if (!locator && chunkSeq === null) continue;
      pairs.push({
        from: String(row.from).trim(),
        to: String(row.to).trim(),
        label: String(row.label).trim(),
        sentence: typeof row.sentence === 'string' ? String(row.sentence).trim() : '',
        quote: String(row.quote).trim(),
        locator,
        chunkSeq,
        review: row.review === 'needs_review' ? 'needs_review' : 'accepted',
      });
    }
  }
  return {
    version: 1,
    run: isNonEmpty(r.run) ? String(r.run).trim() : 'unnamed-run',
    windows,
    thin,
    pairs,
    createdAt: isNonEmpty(r.createdAt) ? String(r.createdAt) : new Date(0).toISOString(),
  };
}

/** Read + validate a handoff file. Throws on missing file or bad version. */
export function readHandoff(path: string): ChainHandoff {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (raw.version !== 1) throw new Error(`unknown handoff version in ${path}`);
  return parseHandoff(raw);
}

/** Windows the handoff marks thin for a name (case-insensitive), or null. */
export function thinWindowsFor(handoff: ChainHandoff, name: string): number[] | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const hit = handoff.thin.find((t) => t.name.toLowerCase() === want);
  return hit ? [...hit.windows] : null;
}

/**
 * Order passages thin-first.
 *
 * Passages are `{seq, ...}` rows already filtered to the subject. Those
 * whose window (`floor(seq / windowSize)`) is in the thin list come first
 * in handoff order; the rest keep their relative order behind them. Pure,
 * stable, no model. With no thin list the input order is returned as-is.
 */
export function preferThin<T extends { seq: number }>(
  passages: T[],
  thinWindows: number[] | null,
  windowSize = 8,
): T[] {
  if (!thinWindows || !thinWindows.length) return [...passages];
  const rank = new Map(thinWindows.map((w, i) => [w, i] as [number, number]));
  return [...passages]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = rank.get(Math.floor(a.p.seq / windowSize));
      const rb = rank.get(Math.floor(b.p.seq / windowSize));
      if (ra === undefined && rb === undefined) return a.i - b.i;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb || a.i - b.i;
    })
    .map(({ p }) => p);
}
