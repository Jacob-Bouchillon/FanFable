/**
 * Shared name matching.
 *
 * One canonicalizer, one token matcher, two explicit policies:
 *
 *   LINK     — soft lookup for retrieval, graph scoring, extraction windows,
 *             the answer guard, and lore search. Whole-token matches; a token
 *             one edit away matches when it is long enough.
 *   IDENTITY — exact/alias lookup for `findEntity` and merge decisions. It
 *             intentionally stays exact and is not changed by this module.
 *
 * No book-specific strings; names come from the caller.
 */
import { tokenize } from './text.ts';

/** Shortest token that can identify a name. */
export const NAME_MIN_TOKEN = 3;
/** One-edit fuzz starts at this length, on both sides. */
export const NAME_FUZZY_MIN = 5;
/** Fuzzy bank-token hit weight, relative to an exact hit. */
export const NAME_FUZZY_WEIGHT = 0.5;
/** A name token carried by more entities than this is a title, not a name. */
export const NAME_DF_CAP = 10;

/** Case, possessives, a leading article and punctuation are noise. */
export function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(name: string): string[] {
  return canonicalName(name).split(' ').filter(Boolean);
}

/**
 * How two names relate, deterministically.
 *
 *  - same:        the same name up to case, possessives and a plural
 *  - containment: every word of the shorter name is in the longer one
 *  - null:        not a variant by rule
 */
export function nameRelation(a: string, b: string): 'same' | 'containment' | null {
  const ka = canonicalName(a);
  const kb = canonicalName(b);
  if (!ka || !kb) return null;
  if (ka === kb) return 'same';
  if (ka === `${kb}s` || kb === `${ka}s`) return 'same';
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length !== tb.length) {
    const [short, long] = ta.length < tb.length ? [ta, tb] : [tb, ta];
    if (short.length && short.every((t) => long.includes(t))) return 'containment';
  }
  return null;
}

/** One edit away, or an adjacent transposition. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i]) {
      return a.slice(i + 2) === b.slice(i + 2);
    }
    return a.slice(i + 1) === b.slice(i + 1);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * The bank token a query token names, exact first, then one typo away.
 * Fuzzy hits are half-weight so a correct spelling never loses to a typo path.
 */
export function linkTokenMatch(
  tokens: Set<string>,
  queryToken: string,
): { bankToken: string; weight: number } | undefined {
  if (queryToken.length >= NAME_MIN_TOKEN && tokens.has(queryToken)) {
    return { bankToken: queryToken, weight: 1 };
  }
  if (queryToken.length < NAME_FUZZY_MIN) return undefined;
  for (const token of tokens) {
    if (token.length < NAME_FUZZY_MIN) continue;
    if (withinOneEdit(queryToken, token)) return { bankToken: token, weight: NAME_FUZZY_WEIGHT };
  }
  return undefined;
}

/** Whole-word token set for a piece of text. */
export function textTokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** True when any query token hits a whole hay token, exact or one edit away. */
export function linkTokensMatch(
  queryTokens: readonly string[],
  hayTokens: Set<string>,
): boolean {
  return queryTokens.some((token) => linkTokenMatch(hayTokens, token) !== undefined);
}

/** Is a whole canonical phrase present with word boundaries? */
export function phraseInText(hay: string, needle: string): boolean {
  if (!needle) return false;
  if (hay === needle) return true;
  return hay.startsWith(`${needle} `) || hay.endsWith(` ${needle}`) || hay.includes(` ${needle} `);
}

/** Exact whole token, or one long-token typo. Short names never substring. */
function nameTokenPresent(hayTokens: Set<string>, token: string): boolean {
  if (hayTokens.has(token)) return true;
  if (token.length < NAME_FUZZY_MIN) return false;
  for (const hayToken of hayTokens) {
    if (hayToken.length >= NAME_FUZZY_MIN && withinOneEdit(token, hayToken)) return true;
  }
  return false;
}

/** A name mention against a pre-tokenized text. */
export function nameMentionedFromTokens(
  name: string,
  hayCanonical: string,
  hayTokens: Set<string>,
  opts: { partial?: boolean } = {},
): boolean {
  const canonical = canonicalName(name);
  if (!canonical) return false;
  const meaningful = canonical.split(' ').filter(Boolean);
  if (!meaningful.length) return false;

  if (opts.partial) {
    return meaningful.some((token) => nameTokenPresent(hayTokens, token));
  }
  if (meaningful.length === 1) {
    return nameTokenPresent(hayTokens, meaningful[0]!);
  }
  // A long full name may appear as a phrase; otherwise every distinctive
  // token must be present as a whole token.
  if (canonical.length >= 8 && phraseInText(hayCanonical, canonical)) return true;
  return meaningful.every((token) => nameTokenPresent(hayTokens, token));
}

/** A name mention in free text using the LINK policy. */
export function nameMentioned(
  name: string,
  text: string,
  opts: { partial?: boolean } = {},
): boolean {
  const hayCanonical = canonicalName(text);
  return nameMentionedFromTokens(name, hayCanonical, new Set(hayCanonical.split(' ').filter(Boolean)), opts);
}
