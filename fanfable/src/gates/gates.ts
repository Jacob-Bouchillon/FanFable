/**
 * Gate verdicts: the mechanical rules that decide what a claim may become.
 *
 * Single owner for every promotion rule. lorebook.ts imports from here;
 * nothing else reaches a gate decision except through lorebook or this
 * module — a checker elsewhere imports from here, never from lorebook's
 * internals. A rule changes here or not at all; the two tiers never share
 * a mutable check.
 */
import type { Db } from '../db.ts';
import { canonicalName, deriveNameVariants, type RosterIndex } from '../names.ts';
import { normalise, splitSentences } from '../text.ts';
import { KIND_FILLER, headForms, kindHeadWord } from '../vocab.ts';

export type PromoteReason =
  | 'open-vocab'
  | 'coverage-only'
  | 'ruled-park'
  | 'quote-not-verbatim'
  | 'tie-word-absent'
  | 'endpoint-unnamed'
  | 'direction-mismatch'
  | 'same-identity'
  | 'quarantined-entity'
  | 'assertion-missing'
  | 'below-threshold'
  | 'moment';

export type AttestedReason = PromoteReason | 'keeper-track' | 'assessment-missing' | 'moment';

export interface PromoteRow {
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  fromAliases?: string[];
  toAliases?: string[];
  kind: string;
  evidence: string;
  /** Verbatim words from the quote that express the kind, when the model named
   * them ("sided with" for ally of). */
  kindSource?: string;
  /** The sentence that names the other endpoint, when the quote names one. */
  anchorEvidence?: string;
  /** The model's own estimate that the passage establishes this relation. */
  confidence?: number;
}

export interface PromoteContext {
  db: Db;
  projectId: number;
  /** Text of the passage the quote cites. */
  chunkText?: string | null;
  /** Optional per-command roster index, kept for name-variant resolution. */
  index?: RosterIndex;
  /** Override the project's `minConfidence` (tests and one-off commands). */
  minConfidence?: number;
}

export interface PromoteDecision {
  ok: boolean;
  reason?: PromoteReason;
}

/**
 * The bar a model's own strength must clear: 0.7.
 * Learned from the 113-row over-promotion, when unjudged rows counted as
 * freely as judged ones. Below this a claim stays queued no matter how
 * well-quoted. This number never measures truth, only whether the model's
 * own judgment was strong.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/**
 * Sorts a claim by the model's own score: at or above the bar it may stand
 * as a proven tie, below it stays provisional. It never judges the words,
 * only the number the model gave them.
 */
export function claimTier(confidence: number, minConfidence = DEFAULT_MIN_CONFIDENCE): 'accepted' | 'provisional' {
  return Number.isFinite(confidence) && confidence >= minConfidence ? 'accepted' : 'provisional';
}

/**
 * The name list a matcher receives: explicit forms, widened by derived
 * variants when a roster index is supplied. With no index this is exactly
 * `[name, ...aliases]`, so non-opting callers behave byte for byte as before.
 * It must never merge two people — the six-person merge taught that fuzzy
 * matching at read time invents family.
 */
export function explicitVariants(name: string, aliases: string[], index?: RosterIndex): string[] {
  return index ? deriveNameVariants({ name, aliases }, index) : [name, ...aliases];
}

/** Token spans of a name and its variants inside a quote. */
export function mentionSpans(text: string, name: string, aliases: string[], index?: RosterIndex): Array<[number, number]> {
  const words = canonicalName(text).split(' ').filter(Boolean);
  const spans: Array<[number, number]> = [];
  for (const variant of explicitVariants(name, aliases, index)) {
    const target = canonicalName(variant).split(' ').filter(Boolean);
    if (!target.length) continue;
    for (let i = 0; i + target.length <= words.length; i++) {
      if (target.every((word, k) => words[i + k] === word)) spans.push([i, i + target.length - 1]);
    }
  }
  return spans;
}

/** Words only: possessives split out, punctuation to spaces, lowercased. */
export function assertionWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'s\b/g, " 's")
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** The label's own head word and its ordinary inflections. Used only when no
 * `kind_source` is supplied; it is morphology, never a synonym list. */
export function labelHeadForms(kind: string): Set<string> {
  const head = kindHeadWord(kind);
  if (!head) return new Set();
  const forms = new Set([head, ...headForms(head)]);
  return forms;
}

/** Negation and uncertainty markers. An asserted tie cannot ride on a denied or
 * merely possible clause. Structural, not a synonym list. */
const NEGATORS = new Set(['not', 'never', 'no', 'nor', 'neither', 'without', 'hardly', 'barely']);
const HEDGES = new Set([
  'perhaps', 'possibly', 'maybe', 'might', 'may', 'could', 'probably', 'apparently',
  'seemingly', 'seemed', 'seems', 'suspected', 'suspect', 'rumoured', 'rumored',
]);

/** Grammatical words that cannot carry a relationship on their own. */
const CITATION_STOP = new Set([
  'of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as', 'at', 'by', 'from',
  'about', 'over', 'under', 'and', 'or', 'but', 'so', 'that', 'this', 'these', 'those',
  'then', 'when', 'while', 'after', 'before', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'may', 'might', 'must', 'should', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', "'s",
]);

/** The cited words with the endpoints removed. A model often quotes the whole
 * clause ("Mara loathed Tor"); the relationship words are what remains. A word
 * that is also the kind's head stays even when it appears in a name
 * ("Aunt Petunia" does not swallow the aunt in an aunt-of citation). */
export function citationWords(
  source: string,
  kind: string,
  fromName: string,
  fromAliases: string[],
  toName: string,
  toAliases: string[],
  index?: RosterIndex,
): string[] {
  const head = kindHeadWord(kind);
  const keep = labelHeadForms(kind);
  const nameWords = new Set<string>();
  for (const variant of [...explicitVariants(fromName, fromAliases, index), ...explicitVariants(toName, toAliases, index)]) {
    for (const token of assertionWords(variant)) nameWords.add(token);
  }
  return assertionWords(source).filter((token) => !nameWords.has(token) || keep.has(token) || token === head);
}

/**
 * True when the clause leading up to the assertion denies or hedges it. The
 * model may quote only the positive core ("Mara feared Tor") from a sentence
 * that says "Perhaps Mara feared Tor"; the quote alone shows no hedge, so the
 * sentence in the source is checked too. It must never reach past four tokens
 * back — an unrelated clause earlier in the sentence is not this claim's
 * denial.
 */
export function leadingDenialOrHedge(sentence: string, row: PromoteRow, index?: RosterIndex): boolean {
  const words = assertionWords(sentence);
  if (!words.length) return false;
  const cited = citationWords(
    row.kindSource ?? '',
    row.kind,
    row.fromName,
    row.fromAliases ?? [],
    row.toName,
    row.toAliases ?? [],
    index,
  ).filter((word) => !CITATION_STOP.has(word));
  const anchors = new Set<string>(cited);
  const head = kindHeadWord(row.kind);
  if (head) anchors.add(head);
  if (!anchors.size) return false;
  const at = words.findIndex((word) => anchors.has(word));
  if (at < 0) return false;
  // A hedge or negator just before the assertion softens or denies it. Looking
  // back a few tokens covers "Perhaps Mara feared Tor" and "Mara did not trust
  // Tor" without importing an unrelated clause earlier in the sentence.
  return words.slice(Math.max(0, at - 4), at).some((word) => NEGATORS.has(word) || HEDGES.has(word));
}

/**
 * The verbatim floor both tiers stand on: the quote and any anchor must sit
 * word-for-word in the cited passage. Taught by invented quotes banked as
 * fact. It must never pass a paraphrase, however close, and never consult
 * meaning — spelling is the whole job.
 */
export function quoteVerbatimReason(row: PromoteRow, chunkText?: string | null): PromoteReason | null {
  const chunk = chunkText ?? '';
  if (!row.evidence.trim() || !chunk || !normalise(chunk).includes(normalise(row.evidence))) {
    return 'quote-not-verbatim';
  }
  const anchor = (row.anchorEvidence ?? '').trim();
  if (anchor && !normalise(chunk).includes(normalise(anchor))) return 'quote-not-verbatim';
  return null;
}

/**
 * The proven-tie track's quote rule: the citation is verbatim and hides no
 * hedge or denial in its sentence. Born in the gate split as an exact copy
 * of the attested rule so the two tracks can evolve apart; today they agree.
 * It must never weaken the verbatim floor to rescue a good claim.
 */
export function keeperQuoteReason(row: PromoteRow, chunkText?: string | null, index?: RosterIndex): PromoteReason | null {
  const verbatim = quoteVerbatimReason(row, chunkText);
  if (verbatim) return verbatim;
  const chunk = chunkText ?? '';
  const anchor = (row.anchorEvidence ?? '').trim();
  // Citation honesty, not grammar: "Mara feared Tor" may not be quoted from
  // "Perhaps Mara feared Tor" as though the hedge were not there.
  for (const span of anchor ? [row.evidence, anchor] : [row.evidence]) {
    const holding = splitSentences(chunk).find((sentence) => normalise(sentence).includes(normalise(span))) ?? span;
    if (leadingDenialOrHedge(holding, row, index)) return 'assertion-missing';
  }
  return null;
}

/**
 * The attested tier's quote rule: the citation is verbatim and hides no
 * hedge or denial in its sentence. Separated from the proven-tie rule in
 * the gate split; today identical by design, not by accident. It must never
 * grant proven-tie grade — passage proof stays citable, never conclusive.
 */
export function attestedQuoteReason(row: PromoteRow, chunkText?: string | null, index?: RosterIndex): PromoteReason | null {
  const verbatim = quoteVerbatimReason(row, chunkText);
  if (verbatim) return verbatim;
  const chunk = chunkText ?? '';
  const anchor = (row.anchorEvidence ?? '').trim();
  for (const span of anchor ? [row.evidence, anchor] : [row.evidence]) {
    const holding = splitSentences(chunk).find((sentence) => normalise(sentence).includes(normalise(span))) ?? span;
    if (leadingDenialOrHedge(holding, row, index)) return 'assertion-missing';
  }
  return null;
}

/**
 * The proven-tie verdict: verbatim quote, honest sentence, model score at
 * the bar. Pure and database-free. Taught by the second-definition-of-truth
 * era, when unjudged rows auto-promoted. It must never invent a reason the
 * passage does not state.
 */
export function provenRelation(
  row: PromoteRow,
  context: { chunkText?: string | null; index?: RosterIndex; minConfidence?: number },
): PromoteDecision {
  const quoteReason = keeperQuoteReason(row, context.chunkText, context.index);
  if (quoteReason) return { ok: false, reason: quoteReason };
  const min = context.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (claimTier(row.confidence ?? 1, min) !== 'accepted') return { ok: false, reason: 'below-threshold' };
  return { ok: true };
}
