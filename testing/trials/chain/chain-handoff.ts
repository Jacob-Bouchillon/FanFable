/**
 * Chain handoff list: helpful-or-nothing breadcrumbs a walk leaves behind.
 *
 * A walk writes one JSON file per run. The next read opens it and goes
 * thin-first instead of re-walking. Nothing here calls a model or touches
 * the database: pure checks plus file IO, so it costs nothing heavy.
 *
 * Helpful means list-shaped and checkable. Each line must pass code checks
 * or it is not written:
 * - windows: finite, non-negative ints, in the order they were read.
 * - thin name: non-empty name, at least one window, mentions >= 0, ties >= 0.
 * - pair: non-empty from/to/label, non-empty quote, a known place
 *   (non-empty locator or finite chunkSeq), review flag accepted/needs_review.
 *
 * Garbage (single words, free sentences, unverified claims) is dropped and
 * counted, never written.
 */

import { readFileSync, writeFileSync } from 'node:fs';

export type ReviewFlag = 'accepted' | 'needs_review';

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
  review: ReviewFlag;
}

export interface ChainHandoff {
  version: 1;
  run: string;
  windows: number[];
  thin: HandoffThin[];
  pairs: HandoffPair[];
  createdAt: string;
}

export interface HandoffWriteResult {
  path: string;
  kept: { windows: number; thin: number; pairs: number };
  dropped: { windows: number; thin: number; pairs: number };
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

function cleanWindows(input: unknown): { kept: number[]; dropped: number } {
  if (!Array.isArray(input)) return { kept: [], dropped: 0 };
  const kept: number[] = [];
  let dropped = 0;
  for (const w of input) {
    if (isInt(w)) kept.push(w);
    else dropped++;
  }
  return { kept, dropped };
}

function cleanThin(input: unknown): { kept: HandoffThin[]; dropped: number } {
  if (!Array.isArray(input)) return { kept: [], dropped: 0 };
  const kept: HandoffThin[] = [];
  let dropped = 0;
  for (const t of input) {
    const r = t as Record<string, unknown>;
    const windows = cleanWindows(r.windows).kept;
    if (!isNonEmpty(r.name) || !windows.length) {
      dropped++;
      continue;
    }
    const mentions = typeof r.mentions === 'number' && r.mentions >= 0 ? Math.floor(r.mentions) : 0;
    const ties = typeof r.ties === 'number' && r.ties >= 0 ? Math.floor(r.ties) : 0;
    kept.push({ name: String(r.name).trim(), windows, mentions, ties });
  }
  return { kept, dropped };
}

function cleanPairs(input: unknown): { kept: HandoffPair[]; dropped: number } {
  if (!Array.isArray(input)) return { kept: [], dropped: 0 };
  const kept: HandoffPair[] = [];
  let dropped = 0;
  for (const p of input) {
    const r = p as Record<string, unknown>;
    if (!isNonEmpty(r.from) || !isNonEmpty(r.to) || !isNonEmpty(r.label) || !isNonEmpty(r.quote)) {
      dropped++;
      continue;
    }
    const locator = typeof r.locator === 'string' ? String(r.locator).trim() : '';
    const chunkSeq = typeof r.chunkSeq === 'number' && Number.isFinite(r.chunkSeq) ? r.chunkSeq : null;
    if (!locator && chunkSeq === null) {
      dropped++;
      continue;
    }
    const review: ReviewFlag = r.review === 'needs_review' ? 'needs_review' : 'accepted';
    kept.push({
      from: String(r.from).trim(),
      to: String(r.to).trim(),
      label: String(r.label).trim(),
      sentence: typeof r.sentence === 'string' ? String(r.sentence).trim() : '',
      quote: String(r.quote).trim(),
      locator,
      chunkSeq,
      review,
    });
  }
  return { kept, dropped };
}

/** Build a handoff value, dropping garbage. Never throws on bad input. */
export function buildHandoff(input: {
  run: unknown;
  windows: unknown;
  thin: unknown;
  pairs: unknown;
}): { handoff: ChainHandoff; dropped: { windows: number; thin: number; pairs: number } } {
  const windows = cleanWindows(input.windows);
  const thin = cleanThin(input.thin);
  const pairs = cleanPairs(input.pairs);
  return {
    handoff: {
      version: 1,
      run: isNonEmpty(input.run) ? String(input.run).trim() : 'unnamed-run',
      windows: windows.kept,
      thin: thin.kept,
      pairs: pairs.kept,
      createdAt: new Date().toISOString(),
    },
    dropped: { windows: windows.dropped, thin: thin.dropped, pairs: pairs.dropped },
  };
}

/** Write a handoff file. Returns kept/dropped counts. */
export function writeHandoff(
  path: string,
  input: { run: unknown; windows: unknown; thin: unknown; pairs: unknown },
): HandoffWriteResult {
  const { handoff, dropped } = buildHandoff(input);
  writeFileSync(path, JSON.stringify(handoff, null, 2));
  return {
    path,
    kept: { windows: handoff.windows.length, thin: handoff.thin.length, pairs: handoff.pairs.length },
    dropped,
  };
}

/** Read + re-validate a handoff file. Garbage never survives a round trip. */
export function readHandoff(path: string): ChainHandoff {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const { handoff } = buildHandoff({ run: raw.run, windows: raw.windows, thin: raw.thin, pairs: raw.pairs });
  if (raw.version !== 1) throw new Error(`unknown handoff version in ${path}`);
  return { ...handoff, run: isNonEmpty(raw.run) ? String(raw.run).trim() : handoff.run };
}
