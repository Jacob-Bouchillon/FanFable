/**
 * Gate verdicts: the mechanical rules that decide what a claim may become.
 *
 * Single owner for every promotion rule. lorebook.ts imports from here;
 * nothing else reaches a gate decision except through lorebook or this
 * module — a checker elsewhere imports from here, never from lorebook's
 * internals. A rule changes here or not at all; the two tiers never share
 * a mutable check.
 */
import type { Db } from '../core/db.ts';
import { canonicalName, deriveNameVariants, type RosterIndex } from '../identity/names.ts';
import { normalise, splitSentences } from '../core/text.ts';
import { KIND_FILLER, headForms, kindHeadWord } from '../core/vocab.ts';
import {
  RELATION_FAMILIES,
  familiesHeldByName,
  familyOfKind,
  inverseFamilyOf,
  isAsymmetricFamily,
  type RelationFamily,
} from '../identity/relation-proof.ts';

export type PromoteReason =
  | 'open-vocab'
  | 'coverage-only'
  | 'ruled-park'
  | 'quote-not-verbatim'
  | 'tie-word-absent'
  | 'endpoint-unnamed'
  | 'direction-mismatch'
  | 'generic-kind'
  | 'non-person-endpoint'
  | 'same-identity'
  | 'quarantined-entity'
  | 'assertion-missing'
  | 'relationship-not-entailed'
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

/**
 * True when the citation names both endpoints at two different places.
 *
 * One surface string cannot stand for both sides. When two rows share an alias
 * (one row carrying the other's name as an alias), a quote that says only that
 * name would otherwise satisfy both endpoints and prove a tie between a person
 * and themself. Requiring two disjoint mentions closes that hole without
 * needing to know who is who, and without trusting model-written aliases.
 */
export function namesBothDistinctly(
  quote: string,
  fromName: string,
  fromAliases: string[],
  toName: string,
  toAliases: string[],
  index?: RosterIndex,
): boolean {
  const from = mentionSpans(quote, fromName, fromAliases, index);
  const to = mentionSpans(quote, toName, toAliases, index);
  return from.some(([s1, e1]) => to.some(([s2, e2]) => e1 < s2 || e2 < s1));
}

/**
 * True when the citation names both endpoints. The quote states the claim;
 * the anchor may supply the sentence that names the other person. The two
 * halves are read as one citation, so a pronoun-only quote can bank only
 * when its anchor names both people, and a one-name quote only when the
 * anchor supplies the other. A citation that names neither, or names the
 * same side twice, proves no tie.
 */
export function citationNamesBothEndpoints(row: PromoteRow, index?: RosterIndex): boolean {
  const anchor = (row.anchorEvidence ?? '').trim();
  const citation = anchor ? `${row.evidence} ${anchor}` : row.evidence;
  return namesBothDistinctly(
    citation,
    row.fromName,
    row.fromAliases ?? [],
    row.toName,
    row.toAliases ?? [],
    index,
  );
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

/** Marriage terms and romantic-partner terms are never interchangeable:
 * romance does not prove marriage, and marriage does not prove romance. */
const MARRIAGE_TERMS =
  /\b(?:married|marriage|spouse|spouses|husband|husbands|wife|wives|widow|widows|wed|wedding|wedded)\b/i;
const LOVER_TERMS =
  /\b(?:lover|lovers|paramour|paramours|mistress|concubine|romantic\s+partners?)\b/i;

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


/* ------------------------------------------------------- relationship entailment */

/**
 * The entailment floor: a verbatim quote may only bank when its own words
 * express the claimed relation family, in the claimed direction, between the
 * two endpoints. The quote, endpoint, alias, hedge and confidence rules stay
 * in keeperQuoteReason; this rule answers the separate question the old gate
 * never asked: does the sentence say the relationship, or merely name both
 * people?
 *
 * It reuses the production family grammar (familiesHeldByName /
 * directionOfSentence vocabulary) rather than a book-specific word list:
 * copular and appositive forms, possessives, coordinated symmetric forms,
 * dialogue vocatives, and family heads/keys outside the endpoint names.
 */

function rx(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variantsFor(row: PromoteRow, side: 'from' | 'to', index?: RosterIndex): string[] {
  return explicitVariants(
    side === 'from' ? row.fromName : row.toName,
    side === 'from' ? row.fromAliases ?? [] : row.toAliases ?? [],
    index,
  );
}

function citationText(row: PromoteRow): string {
  const anchor = (row.anchorEvidence ?? '').trim();
  return anchor ? `${row.evidence} ${anchor}` : row.evidence;
}

function maskedCitation(row: PromoteRow, index?: RosterIndex): string {
  let text = citationText(row);
  for (const side of ['from', 'to'] as const) {
    for (const variant of variantsFor(row, side, index)) {
      if (!variant.trim()) continue;
      text = text.replace(new RegExp(`\\b${rx(variant)}\\b`, 'gi'), ' ');
    }
  }
  return text;
}

function familyRule(family: RelationFamily) {
  return RELATION_FAMILIES.find((rule) => rule.family === family);
}

function familyHeadForms(family: RelationFamily): Set<string> {
  const out = new Set<string>();
  const rule = familyRule(family);
  if (!rule) return out;
  for (const head of rule.heads) {
    out.add(head);
    for (const form of headForms(head)) out.add(form);
  }
  for (const key of rule.keys) {
    if (/^[a-z]+$/i.test(key)) {
      out.add(key);
      for (const form of headForms(key)) out.add(form);
    } else {
      out.add(key);
    }
  }
  return out;
}

function familyTermPresent(text: string, family: RelationFamily): boolean {
  const forms = [...familyHeadForms(family)].sort((a, b) => b.length - a.length);
  return forms.some((form) => new RegExp(`\\b${rx(form)}\\b`, 'i').test(text));
}

function heldFamilies(row: PromoteRow, side: 'from' | 'to', text: string, index?: RosterIndex): Set<RelationFamily> {
  const out = new Set<RelationFamily>();
  for (const variant of variantsFor(row, side, index)) {
    if (!variant.trim()) continue;
    for (const family of familiesHeldByName(text, variant)) out.add(family);
  }
  return out;
}

function aliasAlt(row: PromoteRow, side: 'from' | 'to', index?: RosterIndex): string {
  return variantsFor(row, side, index).map(rx).join('|');
}

function possessiveDirection(row: PromoteRow, family: RelationFamily, index?: RosterIndex): 'forward' | 'reverse' | 'none' {
  const inverse = inverseFamilyOf(family);
  const from = aliasAlt(row, 'from', index);
  const to = aliasAlt(row, 'to', index);
  const fHeads = [...familyHeadForms(family)].map(rx).join('|');
  const iHeads = [...familyHeadForms(inverse)].map(rx).join('|');
  const text = citationText(row);
  if (!from || !to || !fHeads || !iHeads) return 'none';
  const patterns: Array<[RegExp, 'forward' | 'reverse']> = [
    [new RegExp(`\\b(?:${from})\\b\\s+(?:is|was|became)\\s+(?:${to})(?:'s|’s|s')\\s+(?:${fHeads})\\b`, 'i'), 'forward'],
    [new RegExp(`\\b(?:${from})\\b\\s+(?:is|was|became)\\s+(?:${to})(?:'s|’s|s')\\s+(?:${iHeads})\\b`, 'i'), 'reverse'],
    [new RegExp(`\\b(?:${to})\\b\\s+(?:is|was|became)\\s+(?:${from})(?:'s|’s|s')\\s+(?:${fHeads})\\b`, 'i'), 'reverse'],
    [new RegExp(`\\b(?:${to})\\b\\s+(?:is|was|became)\\s+(?:${from})(?:'s|’s|s')\\s+(?:${iHeads})\\b`, 'i'), 'forward'],
    [new RegExp(`\\b(?:${to})(?:'s|’s|s')\\s+(?:${fHeads})\\b\\s+(?:is|was)\\s+(?:${from})\\b`, 'i'), 'forward'],
    [new RegExp(`\\b(?:${from})(?:'s|’s|s')\\s+(?:${iHeads})\\b\\s+(?:is|was)\\s+(?:${to})\\b`, 'i'), 'forward'],
  ];
  for (const [re, dir] of patterns) if (re.test(text)) return dir;
  return 'none';
}


function firstMention(text: string, row: PromoteRow, side: 'from' | 'to', index?: RosterIndex): number {
  let best = Infinity;
  for (const variant of variantsFor(row, side, index)) {
    if (!variant.trim()) continue;
    const at = text.search(new RegExp(`\\b${rx(variant)}\\b`, 'i'));
    if (at >= 0 && at < best) best = at;
  }
  return best;
}

function verbOrderDirection(row: PromoteRow, family: RelationFamily, index?: RosterIndex): 'forward' | 'reverse' | 'none' {
  const inverse = inverseFamilyOf(family);
  const text = citationText(row);
  const masked = maskText(text, row, index);
  const forms = [...familyHeadForms(family), ...familyHeadForms(inverse)];
  const fromAt = firstMention(text, row, 'from', index);
  const toAt = firstMention(text, row, 'to', index);
  if (!Number.isFinite(fromAt) || !Number.isFinite(toAt)) return 'none';
  for (const form of forms.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${rx(form)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const at = m.index;
      if (fromAt < at && at < toAt) return 'forward';
      if (toAt < at && at < fromAt) return 'reverse';
    }
  }
  return 'none';
}

function coordinatedSymmetric(row: PromoteRow, family: RelationFamily, index?: RosterIndex): boolean {
  if (isAsymmetricFamily(family)) return false;
  const from = aliasAlt(row, 'from', index);
  const to = aliasAlt(row, 'to', index);
  const heads = [...familyHeadForms(family)].map(rx).join('|');
  if (!from || !to || !heads) return false;
  const text = citationText(row);
  return [
    new RegExp(`\\b(?:${from})\\b\\s*(?:and|,)\\s*(?:${to})\\b\\s*(?:are|were|became|remain)\\s+(?:[a-z]+\\s+){0,3}(?:${heads})\\b`, 'i'),
    new RegExp(`\\b(?:${to})\\b\\s*(?:and|,)\\s*(?:${from})\\b\\s*(?:are|were|became|remain)\\s+(?:[a-z]+\\s+){0,3}(?:${heads})\\b`, 'i'),
  ].some((re) => re.test(text));
}

function vocativeDirection(row: PromoteRow, family: RelationFamily, index?: RosterIndex): 'forward' | 'reverse' | 'none' {
  const inverse = inverseFamilyOf(family);
  const text = citationText(row);
  const headFamilies = new Map<string, RelationFamily>();
  for (const rule of RELATION_FAMILIES) {
    for (const head of rule.heads) headFamilies.set(head.toLowerCase(), rule.family);
    for (const form of rule.heads.flatMap((head) => [...headForms(head)])) headFamilies.set(form.toLowerCase(), rule.family);
  }
  const heads = [...headFamilies.keys()].sort((a, b) => b.length - a.length).map(rx).join('|');
  if (!heads) return 'none';
  const vocative = new RegExp(`[,;]\\s*(?:${heads})\\s*[,.;!?"”]`, 'i').exec(text);
  if (!vocative) return 'none';
  const head = vocative[0].replace(/^[,;\s]+|[,.;!?"”\s]+$/g, '').toLowerCase();
  const headFamily = headFamilies.get(head);
  if (!headFamily) return 'none';
  const after = text.slice(vocative.index, vocative.index + 320);
  const fromAlt = aliasAlt(row, 'from', index);
  const toAlt = aliasAlt(row, 'to', index);
  if (!fromAlt || !toAlt) return 'none';
  // The speaker is the endpoint nearest an attribution verb, not any endpoint
  // within a wide window: "Tenebrous strained to say. 'I'm dying, Plagueis'"
  // must choose Tenebrous, not the addressee named in the next sentence.
  const endpointPositions: Array<{ side: 'from' | 'to'; at: number }> = [];
  for (const [side, alt] of [['from', fromAlt], ['to', toAlt]] as const) {
    const re = new RegExp(`\\b(?:${alt})\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(after)) !== null) endpointPositions.push({ side, at: m.index });
  }
  const attribution = /\b(?:said|says|say|strain\w*|replied|asked|whispered|answered|muttered|growled)\b/gi;
  let speakerSide: 'from' | 'to' | null = null;
  let best = Infinity;
  let m: RegExpExecArray | null;
  while ((m = attribution.exec(after)) !== null) {
    for (const endpoint of endpointPositions) {
      const distance = Math.abs(endpoint.at - m.index);
      if (distance <= 120 && distance < best) {
        best = distance;
        speakerSide = endpoint.side;
      }
    }
  }
  if (!speakerSide) return 'none';
  const fromIsSpeaker = speakerSide === 'from';
  const addresseeFamily = headFamily;
  const speakerFamily = inverseFamilyOf(headFamily);
  const fromFamily = fromIsSpeaker ? speakerFamily : addresseeFamily;
  const toFamily = fromIsSpeaker ? addresseeFamily : speakerFamily;
  if (fromFamily === family && toFamily === inverse) return 'forward';
  if (fromFamily === inverse && toFamily === family) return 'reverse';
  return 'none';
}


function maskText(text: string, row: PromoteRow, index?: RosterIndex): string {
  let out = text;
  for (const side of ['from', 'to'] as const) {
    for (const variant of variantsFor(row, side, index)) {
      if (!variant.trim()) continue;
      out = out.replace(new RegExp(`\\b${rx(variant)}\\b`, 'gi'), ' ');
    }
  }
  return out;
}

function clausesOf(text: string): string[] {
  return text
    .split(/[,;]|\band\b|\bbut\b|\bwhile\b/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function bothEndpointsIn(text: string, row: PromoteRow, index?: RosterIndex): boolean {
  const has = (side: 'from' | 'to'): boolean =>
    variantsFor(row, side, index).some((variant) => variant.trim() !== '' && new RegExp(`\\b${rx(variant)}\\b`, 'i').test(text));
  return has('from') && has('to');
}

function sameClauseWithBothEndpoints(row: PromoteRow, family: RelationFamily, index?: RosterIndex): boolean {
  const source = (row.kindSource ?? '').trim();
  for (const clause of clausesOf(citationText(row))) {
    if (!bothEndpointsIn(clause, row, index)) continue;
    const masked = maskText(clause, row, index);
    if (familyTermPresent(masked, family)) return true;
    if (source && normalise(masked).includes(normalise(source))) return true;
  }
  return false;
}

function definiteDescriptionAnchor(row: PromoteRow, family: RelationFamily, index?: RosterIndex): boolean {
  const evidence = row.evidence;
  const anchor = (row.anchorEvidence ?? '').trim();
  if (!anchor || !bothEndpointsIn(citationText(row), row, index)) return false;
  const evidenceHas = (side: 'from' | 'to'): boolean =>
    variantsFor(row, side, index).some((variant) => variant.trim() !== '' && new RegExp(`\\b${rx(variant)}\\b`, 'i').test(evidence));
  const hasFrom = evidenceHas('from');
  const hasTo = evidenceHas('to');
  // The evidence must supply one endpoint plus the relation word; the anchor
  // supplies only the missing endpoint. If both endpoints are already in the
  // evidence, use the same-clause rule, not a distant anchor.
  if (hasFrom === hasTo) return false;
  const missing: 'from' | 'to' = hasFrom ? 'to' : 'from';
  const anchorHasMissing = variantsFor(row, missing, index).some(
    (variant) => variant.trim() !== '' && new RegExp(`\\b${rx(variant)}\\b`, 'i').test(anchor),
  );
  if (!anchorHasMissing) return false;
  const maskedEvidence = maskText(evidence, row, index);
  if (!familyTermPresent(maskedEvidence, family)) return false;
  if (!/\b(?:he|she|him|her|his|the\s+(?:man|woman|person|mother|father|son|daughter|wife|husband))\b/i.test(evidence)) {
    return false;
  }
  return true;
}


function sentenceHas(row: PromoteRow, text: string, side: 'from' | 'to', index?: RosterIndex): boolean {
  return variantsFor(row, side, index).some(
    (variant) => variant.trim() !== '' && new RegExp(`\\b${rx(variant)}\\b`, 'i').test(text),
  );
}

function contiguousDefiniteDescription(row: PromoteRow, family: RelationFamily, index?: RosterIndex): boolean {
  const evidence = row.evidence;
  if (!bothEndpointsIn(evidence, row, index)) return false;
  const sentences = splitSentences(evidence).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length < 2) return false;
  const pronoun = /\b(?:he|she|him|her|his|the\s+(?:man|woman|person|mother|father|son|daughter|wife|husband))\b/i;
  for (const sentence of sentences) {
    const masked = maskText(sentence, row, index);
    if (!familyTermPresent(masked, family) || !pronoun.test(sentence)) continue;
    const hasFrom = sentenceHas(row, sentence, 'from', index);
    const hasTo = sentenceHas(row, sentence, 'to', index);
    if (hasFrom === hasTo) continue;
    const missing: 'from' | 'to' = hasFrom ? 'to' : 'from';
    if (sentences.some((other) => other !== sentence && sentenceHas(row, other, missing, index))) return true;
  }
  return false;
}

/**
 * Fail-closed entailment reason. Null means the citation's own words express
 * the relation family and direction. Every other answer is a refusal; the row
 * stays provisional/needs_review under the existing lifecycle.
 */
export function relationEntailmentReason(row: PromoteRow, index?: RosterIndex): PromoteReason | null {
  const family = familyOfKind(row.kind);
  const text = maskedCitation(row, index);
  const citation = citationText(row);
  const source = (row.kindSource ?? '').trim();
  const sourcePresent = source !== '' && normalise(text).includes(normalise(source));

  if (family === 'other') {
    const head = kindHeadWord(row.kind);
    const support = sourcePresent || (head !== '' && normalise(text).includes(normalise(head)));
    return support ? null : 'relationship-not-entailed';
  }

  if (family === 'spouse') {
    const kind = normalise(row.kind);
    const evidence = maskText(row.evidence, row, index);
    if (/\b(?:married|marriage|spouse|husband|wife|widow)\b/i.test(kind) && !MARRIAGE_TERMS.test(evidence)) {
      return 'relationship-not-entailed';
    }
    if (/\blover\b/i.test(kind) && !LOVER_TERMS.test(evidence)) return 'relationship-not-entailed';
  }

  const asymmetric = isAsymmetricFamily(family);
  const inverse = inverseFamilyOf(family);
  const term = familyTermPresent(text, family) || (asymmetric && familyTermPresent(text, inverse)) || sourcePresent;
  if (!term) return 'relationship-not-entailed';

  if (asymmetric) {
    const fromFamilies = heldFamilies(row, 'from', citation, index);
    const toFamilies = heldFamilies(row, 'to', citation, index);
    if (fromFamilies.has(family) && toFamilies.has(inverse)) return null;
    if (fromFamilies.has(inverse) && toFamilies.has(family)) return 'direction-mismatch';
    const possessive = possessiveDirection(row, family, index);
    if (possessive === 'forward') return null;
    if (possessive === 'reverse') return 'direction-mismatch';
    const vocative = vocativeDirection(row, family, index);
    if (vocative === 'forward') return null;
    if (vocative === 'reverse') return 'direction-mismatch';
    const verb = verbOrderDirection(row, family, index);
    if (verb === 'forward') return null;
    if (verb === 'reverse') return 'direction-mismatch';
    return 'relationship-not-entailed';
  }

  const fromFamilies = heldFamilies(row, 'from', citation, index);
  const toFamilies = heldFamilies(row, 'to', citation, index);
  if (fromFamilies.has(family) && toFamilies.has(family)) return null;
  if (coordinatedSymmetric(row, family, index)) return null;
  if (sameClauseWithBothEndpoints(row, family, index)) return null;
  if (definiteDescriptionAnchor(row, family, index)) return null;
  if (contiguousDefiniteDescription(row, family, index)) return null;
  return 'relationship-not-entailed';
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
 * The proven-tie track's quote rule: the citation is verbatim, hides no
 * hedge or denial in its sentence, and names both endpoints (the quote may
 * name one and its anchor the other). Born in the gate split as an exact copy
 * of the attested rule so the two tracks can evolve apart; the endpoint rule
 * is the proven track's own. It must never weaken the verbatim floor to
 * rescue a good claim.
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
  // Mechanical proof: the citation must put both people in the sentence, not
  // merely in the roster. A quote that names neither side proves no tie.
  if (!citationNamesBothEndpoints(row, index)) return 'endpoint-unnamed';
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
 * A third-person subject that can continue a person introduced one sentence
 * earlier. Possessive forms ("his arm", "her lover") are deliberately absent:
 * their antecedent may be a different person than the nearest name.
 */
const SUBJECT_REFERENCE =
  /\b(?:he|she)\s+(?:was|is|had|has|would|could|seemed|appeared|remained|became)\b|\bthe\s+(?:man|woman|person|mother|father|son|daughter|wife|husband)\s+(?:was|is|had|has|would|could|seemed|appeared|remained|became)\b/i;

/** A sentence that introduces a person by name. A bare mention is not an
 * introduction, so "…and Dooku was elsewhere" cannot bind a later pronoun. */
function introductionNames(sentence: string, variants: string[]): boolean {
  const text = canonicalName(sentence);
  const raw = sentence.replace(/[\u2018\u2019]/g, "'");
  return variants.some((variant) => {
    const form = canonicalName(variant);
    if (!form) return false;
    const intro = new RegExp(
      `\\b(?:you remember|do you remember|this is|meet|say hello to)\\s+(?:the\\s+)?${rx(form)}\\b`,
      'i',
    );
    if (!intro.test(text)) return false;
    // "This is Jobal's house" introduces a house, not Jobal.
    const possessive = new RegExp(
      `\\b(?:you remember|do you remember|this is|meet|say hello to)\\s+(?:the\\s+)?${rx(form)}'s\\b`,
      'i',
    );
    return !possessive.test(raw);
  });
}

/** Sentences for context. Line breaks are flattened first because a book
 * chunk often breaks a sentence across lines, and the chunker's sentence
 * spans treat a bare newline as a boundary without keeping the partial line.
 * A lowercase continuation is then joined to the sentence it continues. */
function contextSentences(text: string): string[] {
  const out: string[] = [];
  const flat = (text ?? '').replace(/\s*\n+\s*/g, ' ');
  for (const sentence of splitSentences(flat).map((part) => part.trim()).filter(Boolean)) {
    const previous = out[out.length - 1];
    if (previous && /^[a-z]/.test(sentence) && !/[.!?]["'”’)]?$/.test(previous)) {
      out[out.length - 1] = `${previous} ${sentence}`;
    } else {
      out.push(sentence);
    }
  }
  return out;
}

/** True when the sentence names any roster entity other than the two
 * endpoints, so a definite-description chain cannot skip over a third person. */
function namesOtherEntity(text: string, row: PromoteRow, index?: RosterIndex): boolean {
  if (!index) return false;
  const source = canonicalName(text);
  for (const other of index.rows) {
    if (other.name === row.fromName || other.name === row.toName) continue;
    for (const variant of explicitVariants(other.name, other.aliases, index)) {
      const form = canonicalName(variant);
      if (form && new RegExp(`\\b${rx(form)}\\b`, 'i').test(source)) return true;
    }
  }
  return false;
}

/**
 * Ground a definite description in the passage that introduces it. The
 * holding sentence must name one endpoint and refer to the other with a
 * third-person subject; the missing endpoint must be introduced by name one
 * or two sentences earlier ("You remember Jobal?"). A two-sentence gap is
 * allowed only across a pure description of that same person: a sentence that
 * names another roster entity breaks the chain. This is identity grounding,
 * never relationship proof, and it refuses bare co-mention.
 */
function introducedReferentAnchor(
  row: PromoteRow,
  holding: string,
  sentences: string[],
  at: number,
  index?: RosterIndex,
): string | null {
  const hasFrom = variantsFor(row, 'from', index).some(
    (variant) => variant.trim() !== '' && new RegExp(`\\b${rx(variant)}\\b`, 'i').test(holding),
  );
  const hasTo = variantsFor(row, 'to', index).some(
    (variant) => variant.trim() !== '' && new RegExp(`\\b${rx(variant)}\\b`, 'i').test(holding),
  );
  if (hasFrom === hasTo) return null;
  if (!SUBJECT_REFERENCE.test(holding)) return null;
  const missing: 'from' | 'to' = hasFrom ? 'to' : 'from';
  for (const back of [1, 2]) {
    const j = at - back;
    if (j < 0) continue;
    const anchor = sentences[j]!;
    if (!introductionNames(anchor, variantsFor(row, missing, index))) continue;
    // The introduction must not name a third person whose antecedent could be
    // the later pronoun.
    if (namesOtherEntity(anchor, row, index)) continue;
    if (back === 2) {
      const between = sentences[at - 1]!;
      if (!SUBJECT_REFERENCE.test(between)) continue;
      if (namesOtherEntity(between, row, index)) continue;
    }
    return anchor;
  }
  return null;
}

/**
 * Endpoint context from the quoted sentence itself. A stored relation often
 * quotes a sub-span of the sentence that introduces both people ("Married to
 * Ruwee by arrangement" from "…she was…", with "You remember Jobal?" just
 * before). Identity grounding may use that introduction and a pure description
 * between it and the quote. It never treats a nearby named character as the
 * antecedent, and it never decides the relationship; entailment remains a
 * separate check.
 */
function contextualEvidence(
  row: PromoteRow,
  chunkText: string | null | undefined,
  index?: RosterIndex,
): PromoteRow | null {
  if (!chunkText || (row.anchorEvidence ?? '').trim()) return null;
  const sentences = contextSentences(chunkText);
  const source = normalise(row.evidence);
  if (!source) return null;
  for (let i = 0; i < sentences.length; i += 1) {
    const holding = sentences[i]!;
    if (!normalise(holding).includes(source)) continue;
    const anchor = introducedReferentAnchor(row, holding, sentences, i, index);
    if (!anchor) continue;
    const withAnchor = { ...row, evidence: holding, anchorEvidence: anchor };
    if (citationNamesBothEndpoints(withAnchor, index)) return withAnchor;
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
  const guarded = contextualEvidence(row, context.chunkText, context.index) ?? row;
  const quoteReason = keeperQuoteReason(guarded, context.chunkText, context.index);
  if (quoteReason) return { ok: false, reason: quoteReason };
  const min = context.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (claimTier(guarded.confidence ?? 1, min) !== 'accepted') return { ok: false, reason: 'below-threshold' };
  const entailment = relationEntailmentReason(guarded, context.index);
  if (entailment) return { ok: false, reason: entailment };
  return { ok: true };
}
