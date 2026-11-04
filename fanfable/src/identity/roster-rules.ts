/**
 * Roster merge rules.
 *
 * One person under several names is one row; two people who share a surname
 * are two rows. Both statements are code, applied uniformly at every import,
 * and neither is a per-row human verdict: a verdict may label a row, never
 * teach the roster a merge.
 *
 * The rules are deliberately narrow. Anything that merely looks similar is
 * quarantined for a hearing, never merged, because a wrong merge invents a
 * person and every relation of theirs thereafter.
 */
import { canonicalName, isTitleToken, nameRelation, nameTokens } from './names.ts';

/** Entity kinds that are a person. Everything else is a thing, place or role. */
export const PERSON_KINDS: ReadonlySet<string> = new Set(['character']);

/** True when a kind can carry personal ties ("father of", "served"). */
export function isPersonKind(kind: string): boolean {
  return PERSON_KINDS.has(String(kind ?? '').trim().toLowerCase());
}

export type MergeAction = 'merge' | 'quarantine' | 'separate';

export interface MergeVerdict {
  action: MergeAction;
  /** Why the rule decided this; recorded on quarantine rows only. */
  reason: string;
}

export interface RosterRow {
  name: string;
  kind: string;
}

/**
 * The roster rule for one pair, in a fixed order.
 *
 * 1. Different kinds never merge: a person and a place may share a name.
 * 2. A non-person kind never merges into a person row, and vice versa.
 * 3. The same name up to case, possessive and plural merges.
 * 4. Containment (every word of the short name in the long one) merges, unless
 *    both are dialogue speakers in one scene - then two people are talking.
 * 5. A shared surname with different given names never merges: Larsh Hill and
 *    San Hill are two men, not one.
 */
export function mergeVerdict(
  a: RosterRow,
  b: RosterRow,
  opts: { sharedSpeakerScene?: boolean } = {},
): MergeVerdict {
  const kindA = String(a.kind ?? '').trim().toLowerCase();
  const kindB = String(b.kind ?? '').trim().toLowerCase();
  // Rule 1 already blocks a person merging with a place, faction, species or
  // role: the two kinds differ, so nothing is fused and no non-person becomes
  // a character row.
  if (kindA !== kindB) return { action: 'separate', reason: 'different kinds' };
  return mergeSameKind(a, b, opts);
}

function mergeSameKind(
  a: RosterRow,
  b: RosterRow,
  opts: { sharedSpeakerScene?: boolean },
): MergeVerdict {
  const relation = nameRelation(a.name, b.name);
  if (relation === 'same') return { action: 'merge', reason: 'same name' };
  if (relation === 'containment') {
    const short = shorterName(a.name, b.name);
    if (isTitleOnly(short)) return { action: 'separate', reason: 'title only' };
    if (opts.sharedSpeakerScene) {
      return { action: 'quarantine', reason: 'both speak in the same passage' };
    }
    return { action: 'merge', reason: 'containment' };
  }
  if (sharedSurnameOnly(a.name, b.name)) {
    return { action: 'separate', reason: 'surname shared, given names differ' };
  }
  return { action: 'separate', reason: 'no merge rule' };
}

/** The name with fewer words; the longer one on a tie. */
function shorterName(a: string, b: string): string {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  return ta.length <= tb.length ? a : b;
}

function isTitleOnly(name: string): boolean {
  const tokens = nameTokens(name);
  if (!tokens.length) return false;
  return tokens.every((token) => isTitleToken(token));
}

/**
 * Same last word, different first words: two people who share a surname.
 *
 * "Hill" vs "Hill" is the same name and never reaches here; "Larsh Hill" vs
 * "San Hill" does, and must stay two rows.
 */
export function sharedSurnameOnly(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  if (canonicalName(a) === canonicalName(b)) return false;
  const surnameA = ta[ta.length - 1]!;
  const surnameB = tb[tb.length - 1]!;
  if (surnameA !== surnameB) return false;
  const givenA = ta.slice(0, -1);
  const givenB = tb.slice(0, -1);
  return givenA.join(' ') !== givenB.join(' ');
}
