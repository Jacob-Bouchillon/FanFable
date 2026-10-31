/**
 * Shared name matching.
 *
 * One canonicalizer, one token matcher, two explicit policies:
 *
 *   LINK     — soft lookup for retrieval, graph scoring, extraction windows,
 *             and lore search. Whole-token matches; a token one edit away
 *             matches when it is long enough.
 *   IDENTITY — exact/alias lookup for `findEntity` and merge decisions. It
 *             intentionally stays exact and is not changed by this module.
 *   PROOF    — exact endpoint matching for the answer guard. Whole-token
 *             equality only; no edit distance, no substring, no partial.
 *
 * No book-specific strings; names come from the caller.
 */
import { tokenize } from '../core/text.ts';

/** Shortest token that can identify a name. */
export const NAME_MIN_TOKEN = 3;
/** One-edit fuzz starts at this length, on both sides. */
export const NAME_FUZZY_MIN = 5;
/** Fuzzy bank-token hit weight, relative to an exact hit. */
export const NAME_FUZZY_WEIGHT = 0.5;
/** A name token carried by more entities than this is a title, not a name. */
export const NAME_DF_CAP = 10;

/** Titles a person can carry, universal across books. Leading such a token
 * with more tokens behind it makes it a title, not a distinguishing name. */
const UNIVERSAL_TITLES = new Set([
  'mr', 'mrs', 'miss', 'ms', 'dr', 'doctor', 'professor', 'captain',
  'sir', 'lady', 'lord', 'king', 'queen', 'prince', 'princess',
  'uncle', 'aunt', 'father', 'mother', 'brother', 'sister',
  'grandfather', 'grandmother',
]);

/** Whole-word, case-sensitive occurrences of a term in source text, with
 * regex metacharacters escaped. This is the predicate the suspect-character
 * quarantine uses; derived-name filtering shares it so the two policies can
 * never drift apart. */
export function lowerOccurrencesInText(text: string, term: string): number {
  if (!term) return 0;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\b${safe}\\b`, 'g')) ?? []).length;
}

/** True when the lowercase term occurs whole-word in the source text. */
export function occursLowercaseInText(text: string, term: string): boolean {
  return lowerOccurrencesInText(text, term) > 0;
}

/**
 * Roster index built once per command for match-time derived name variants.
 *
 * Nothing here is stored: the index is a per-command structure, and the
 * derived forms it supports are recomputed on demand from the explicit
 * `name` + `aliases` of each entity row.
 */
export interface RosterIndex {
  /** The rows the index was built from, in order. */
  rows: { name: string; aliases: string[] }[];
  /** All of the project's chunk text, joined with single spaces. */
  text: string;
  /** canonical explicit form -> row indices that store it as name or alias. */
  forms: Map<string, number[]>;
  /** canonical token -> row indices whose explicit forms contain that token. */
  tokenOwners: Map<string, number[]>;
  /** canonical token -> number of entities whose explicit forms contain it. */
  titleFreq: Map<string, number>;
  /** Derivation cache, keyed by row position. Computed at most once per row. */
  variants: Map<number, string[]>;
}

export function buildRosterIndex(
  rows: { name: string; aliases: string[] }[],
  text: string,
): RosterIndex {
  const forms = new Map<string, number[]>();
  const tokenOwners = new Map<string, number[]>();
  const titleFreq = new Map<string, number>();
  const rowTokens: Set<string>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const explicit = [rows[i]!.name, ...rows[i]!.aliases];
    const tokens = new Set<string>();
    for (const form of explicit) {
      const canonical = canonicalName(form);
      if (!canonical) continue;
      const list = forms.get(canonical) ?? [];
      list.push(i);
      forms.set(canonical, list);
      for (const token of canonical.split(' ').filter(Boolean)) {
        tokens.add(token);
        const owners = tokenOwners.get(token) ?? [];
        if (!owners.includes(i)) owners.push(i);
        tokenOwners.set(token, owners);
      }
    }
    rowTokens.push(tokens);
  }
  for (const tokens of rowTokens) {
    for (const token of tokens) titleFreq.set(token, (titleFreq.get(token) ?? 0) + 1);
  }
  return { rows, text, forms, tokenOwners, titleFreq, variants: new Map() };
}

/** Locate a row inside an index by reference, or by exact name/aliases. */
function indexPosition(
  index: RosterIndex,
  row: { name: string; aliases: string[] },
): number {
  const byRef = index.rows.indexOf(row);
  if (byRef >= 0) return byRef;
  return index.rows.findIndex(
    (other) => other.name === row.name && other.aliases.length === row.aliases.length &&
      other.aliases.every((a, k) => row.aliases[k] === a),
  );
}

/**
 * Match-time derived name variants for one entity.
 *
 * Returns the explicit forms first (stored name, then each alias), then the
 * derived forms: full, title-stripped, surname (last token) and given name
 * (first token) for each explicit form. Derived forms are filtered by
 * §2.3 and never written anywhere; they only widen the lists the matchers
 * receive. Ordering is deterministic.
 */
export function deriveNameVariants(
  row: { name: string; aliases: string[] },
  index: RosterIndex,
): string[] {
  const me = indexPosition(index, row);
  if (me >= 0) {
    const cached = index.variants.get(me);
    if (cached) return cached;
  }
  // Same person under the roster's identity rule: "X" and "Captain X" are one
  // row-pair split, not two people. A collision with such a row is allowed.
  const samePerson = (other: number): boolean => {
    const relation = nameRelation(row.name, index.rows[other]!.name);
    return relation === 'same' || relation === 'containment';
  };
  const explicit = [row.name, ...row.aliases].filter((v) => v.trim().length > 0);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const form of explicit) {
    const canonical = canonicalName(form);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  const isTitle = (token: string): boolean =>
    UNIVERSAL_TITLES.has(token) || (index.titleFreq.get(token) ?? 0) > NAME_DF_CAP;
  for (const form of explicit) {
    const tokens = canonicalName(form).split(' ').filter(Boolean);
    const strippedTokens = [...tokens];
    while (strippedTokens.length > 1 && isTitle(strippedTokens[0]!)) {
      strippedTokens.shift();
    }
    const candidates: string[] = [];
    // full form (identical to the explicit form, so it survives only when the
    // Duplicate filter does not drop it)
    if (tokens.length) candidates.push(tokens.join(' '));
    const stripped = strippedTokens.join(' ');
    if (stripped !== tokens.join(' ') && stripped) candidates.push(stripped);
    if (strippedTokens.length > 1) {
      candidates.push(strippedTokens[strippedTokens.length - 1]!); // surname
      candidates.push(strippedTokens[0]!); // given name
    }
    for (const candidate of candidates) {
      if (!candidate || candidate.length < NAME_MIN_TOKEN) continue; // too short
      if (occursLowercaseInText(index.text, candidate)) continue; // common word
      if (seen.has(candidate)) continue; // duplicate of an own explicit form
      if (out.includes(candidate)) continue; // duplicate derived form
      // Roster collision. A bare token collides when another, unrelated
      // entity's stored name or alias also carries that token: a surname
      // shared by several people must not identify any one of them. A
      // multi-token form collides when another, unrelated entity stores it
      // whole.
      const owners = candidate.includes(' ')
        ? index.forms.get(candidate) ?? []
        : index.tokenOwners.get(candidate) ?? [];
      if (owners.some((owner) => owner !== me && !samePerson(owner))) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  if (me >= 0) index.variants.set(me, out);
  return out;
}

/** Case, possessives, a leading article and punctuation are noise. */
export function canonicalName(name: string): string {
  return (
    name
      // The two apostrophes are one character to a reader; make them one to the
      // matcher too, before the filter below can turn the curly form into a
      // space and split one identity into two.
      .replace(/[\u2018\u2019]/g, "'")
      .toLowerCase()
      .replace(/['\u2019]s\b/g, '')
      .replace(/^(the|a|an)\s+/, '')
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
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

/**
 * A name mention in free text using the PROOF policy.
 *
 * Exact whole-token equality after canonicalization, plus an exact multi-word
 * phrase. A proof that one passage names an endpoint must not accept a typo,
 * a substring, or a single token of a multi-word name; those remain in the
 * LINK policy above for retrieval and ranking only.
 */
export function nameMentionedExact(name: string, text: string): boolean {
  const canonical = canonicalName(name);
  if (!canonical) return false;
  const meaningful = canonical.split(' ').filter(Boolean);
  if (!meaningful.length) return false;
  const hayCanonical = canonicalName(text);
  const hayTokens = new Set(hayCanonical.split(' ').filter(Boolean));
  if (meaningful.length === 1) return hayTokens.has(meaningful[0]!);
  if (phraseInText(hayCanonical, canonical)) return true;
  return meaningful.every((token) => hayTokens.has(token));
}
