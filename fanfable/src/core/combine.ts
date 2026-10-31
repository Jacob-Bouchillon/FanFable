/**
 * Weak clues adding up: `score = 1 − Π(1 − sᵢ)` over separate clues.
 *
 * One loud passage is not the only way a tie gets proven. Three quiet
 * passages, each too weak to bank on its own, can add up past the author's
 * bar — provided each one stands on its own. That last part is the whole job
 * here: the failure that taught it left 125 parked notes with 0 promoted,
 * because the span carrying the tie word never held both names. Pooled noise
 * is not proof, so this tally counts a clue only when it is separate:
 *
 * - one share per passage: notes citing one chunk count once, strongest wins;
 * - repeats never count twice: the quote-plus-claim identity is respected, so
 *   reading one passage twice adds nothing;
 * - a sentence cited for more than three different pairs halves every share
 *   it gives: a catch-all line is coverage, not proof of any one tie;
 * - co-presence notes never count: two names in one passage is coverage, and
 *   coverage is not evidence;
 * - a note with no stored assessment counts 0 until assessed: an opinion no
 *   one recorded is not a share, and strengths never default to 1.0.
 *
 * This tally banks nothing and judges nothing. It adds up the shares on one
 * pair's thread and says whether they clear the author's bar. Clearing it
 * makes a held-aside thread a candidate for your review — never a promotion.
 * Only your word, or a later blind read, promotes.
 */
import { DEFAULT_MIN_CONFIDENCE } from '../gates/gates.ts';

/** More pairs citing one sentence than this, and every share halves. */
export const CATCH_ALL_PAIRS = 3;

/** What a catch-all sentence's shares are multiplied by. */
export const CATCH_ALL_WEIGHT = 0.5;

/** One weak clue offered toward a pair's combined tally. */
export interface WeakNote {
  /** The stored assessed share, 0–1. Ignored unless `assessed` is true. */
  strength: number;
  /** True only when a stored assessment set the share. Anything else is 0. */
  assessed: boolean;
  /** The passage cited, or null when unknown. One share per passage. */
  chunkId: number | null;
  /** The quote-plus-claim identity. Repeats of one clue count once. */
  dedupeKey: string;
  /** How many different pairs cite this same sentence. */
  pairsCited: number;
  /** Co-presence notes never count, whatever share they carry. */
  isContext: boolean;
  /** Carried through untouched so callers can link back to the note. */
  noteId?: number;
}

/** One share that survived into the tally, with why. */
export interface Contribution {
  chunkId: number | null;
  /** The share before the catch-all damper. */
  rawStrength: number;
  /** The share as counted. */
  weight: number;
  /** True when the catch-all line halved this share. */
  damped: boolean;
  noteId?: number;
}

export interface CombinedScore {
  /** `1 − Π(1 − sᵢ)` over the surviving shares; 0 when none survive. */
  score: number;
  /** How many separate passages stand behind the tally. */
  independent: number;
  contributions: Contribution[];
}

/** Clamp a share into 0–1; anything unusable is 0, never a default. */
function clampShare(value: unknown): number {
  const s = Number(value);
  if (!Number.isFinite(s) || s < 0) return 0;
  return Math.min(1, s);
}

/**
 * Add up one pair-thread's weak clues.
 *
 * Order matters and is fixed: drop the co-presence and unassessed notes
 * first (they are not shares), collapse repeats by clue identity, keep the
 * strongest share per passage, halve catch-all shares, then tally. Empty in,
 * zero out.
 */
export function combineScore(notes: WeakNote[]): CombinedScore {
  const shares = notes.filter((note) => !note.isContext && note.assessed === true);
  // Repeats never count twice: one clue, one share, strongest wins.
  const byClue = new Map<string, WeakNote>();
  const keyless: WeakNote[] = [];
  for (const note of shares) {
    const key = String(note.dedupeKey ?? '').trim();
    if (!key) {
      keyless.push(note);
      continue;
    }
    const prev = byClue.get(key);
    if (prev === undefined || clampShare(note.strength) > clampShare(prev.strength)) {
      byClue.set(key, note);
    }
  }
  // One share per passage: the strongest clue citing it wins. A note citing
  // no passage cannot prove it shares one, so each stands on its own.
  let unchunked = 0;
  const byChunk = new Map<string, WeakNote>();
  const consider = (note: WeakNote): void => {
    const key = note.chunkId === null ? `none:${unchunked++}` : `chunk:${note.chunkId}`;
    const prev = byChunk.get(key);
    if (prev === undefined || clampShare(note.strength) > clampShare(prev.strength)) {
      byChunk.set(key, note);
    }
  };
  for (const note of byClue.values()) consider(note);
  for (const note of keyless) consider(note);
  const contributions: Contribution[] = [];
  let product = 1;
  for (const note of byChunk.values()) {
    const raw = clampShare(note.strength);
    const damped = Number(note.pairsCited) > CATCH_ALL_PAIRS;
    const weight = raw * (damped ? CATCH_ALL_WEIGHT : 1);
    contributions.push({
      chunkId: note.chunkId,
      rawStrength: raw,
      weight,
      damped,
      ...(note.noteId !== undefined ? { noteId: note.noteId } : {}),
    });
    product *= 1 - weight;
  }
  contributions.sort(
    (a, b) => b.weight - a.weight || (a.chunkId ?? -1) - (b.chunkId ?? -1),
  );
  return { score: contributions.length ? 1 - product : 0, independent: contributions.length, contributions };
}

/**
 * Whether a tally clears the author's bar.
 *
 * The bar has one owner: pass a project's own setting when one is known,
 * otherwise the default stands. This tally never sets it.
 */
export function meetsBar(score: number, minConfidence: number = DEFAULT_MIN_CONFIDENCE): boolean {
  if (!Number.isFinite(score)) return false;
  return score >= minConfidence;
}

/**
 * Count the different pairs citing each sentence.
 *
 * Callers feed every pair-thread note's normalised sentence plus its pair;
 * the tally reads the counts back per note. Sentences are compared exact, so
 * a reworded line is a different sentence and is counted on its own.
 */
export function quotePairCounts(rows: { sentence: string; aEntity: number; bEntity: number }[]): Map<string, number> {
  const pairs = new Map<string, Set<string>>();
  for (const row of rows) {
    const sentence = String(row.sentence ?? '');
    if (!sentence) continue;
    const lo = Math.min(row.aEntity, row.bEntity);
    const hi = Math.max(row.aEntity, row.bEntity);
    const set = pairs.get(sentence) ?? new Set<string>();
    set.add(`${lo}:${hi}`);
    pairs.set(sentence, set);
  }
  const out = new Map<string, number>();
  for (const [sentence, set] of pairs) out.set(sentence, set.size);
  return out;
}
