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
import { canonicalName, deriveNameVariants, nameRelation, type RosterIndex } from '../identity/names.ts';
import { normalise, splitSentences } from '../core/text.ts';
import { KIND_FILLER, headForms, kindHeadWord } from '../core/vocab.ts';
import {
  RELATION_FAMILIES,
  familiesHeldByName,
  familyOfKind,
  inverseFamiliesOf,
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
const NEGATORS = new Set(['not', 'never', 'nor', 'neither', 'without', 'hardly', 'barely']);
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
  // The kind label's head need not appear in the sentence ("friend of" for
  // "did not trust"). Anchor on the whole family's forms as well, and test
  // every occurrence, so an inflection or a different family word still
  // carries its own denial.
  const family = familyOfKind(row.kind);
  if (family !== 'other') {
    for (const form of familyHeadForms(family)) {
      if (form.includes(' ')) {
        // Multi-word keys ("trained by") are not single tokens here; their
        // component words are common and would over-match.
        continue;
      }
      anchors.add(form);
    }
    // Passive family verbs are not single-word family keys ("trained by",
    // "born to"), but a denial sits directly before them too.
    for (const { verb } of PASSIVE_AGENT) {
      anchors.add(verb);
      for (const form of headForms(verb)) anchors.add(form);
    }
  }
  if (!anchors.size) return false;
  // A hedge or negator just before the assertion softens or denies it. Looking
  // back a few tokens covers "Perhaps Mara feared Tor" and "Mara did not trust
  // Tor" without importing an unrelated clause earlier in the sentence.
  for (let at = 0; at < words.length; at++) {
    if (!anchors.has(words[at]!)) continue;
    // Bare "no" is a negator only when it directly modifies the relation noun
    // ("no friend of Tor"). "there's no one I trust" affirms the tie, and
    // "no doubt, Asha is Bram's sister" is not a denial.
    if (at > 0 && words[at - 1] === 'no') return true;
    if (words.slice(Math.max(0, at - 4), at).some((word) => NEGATORS.has(word) || HEDGES.has(word))) return true;
  }
  return false;
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

/**
 * Role nouns whose family is fixed by what the person in that role holds.
 * The family tables' `keys` are *classification* forms and deliberately mix
 * both sides ("student" sits in master's keys), so they must never decide
 * the arrow. Direction uses heads plus these explicit roles.
 */
const DIRECTION_ROLE: Record<string, RelationFamily> = {
  student: 'servant',
  disciple: 'servant',
  padawan: 'servant',
  employee: 'servant',
};

/** Past-participle forms that put the other endpoint in the actor role:
 * "Mara was trained by Tor" makes Tor the master, not Mara. `born to` is a
 * passive kinship construction with the same shape. */
const PASSIVE_AGENT: ReadonlyArray<{ verb: string; agent: RelationFamily; preposition: 'by' | 'to' }> = [
  { verb: 'trained', agent: 'master', preposition: 'by' },
  { verb: 'taught', agent: 'master', preposition: 'by' },
  { verb: 'mentored', agent: 'master', preposition: 'by' },
  { verb: 'tutored', agent: 'master', preposition: 'by' },
  { verb: 'hired', agent: 'employer', preposition: 'by' },
  { verb: 'employed', agent: 'employer', preposition: 'by' },
  { verb: 'born', agent: 'parent', preposition: 'to' },
  { verb: 'raised', agent: 'parent', preposition: 'by' },
];

/** Head nouns and explicit role nouns a sentence uses to state this family. */
function directionNouns(family: RelationFamily): Set<string> {
  const out = new Set<string>();
  const rule = familyRule(family);
  if (!rule) return out;
  for (const head of rule.heads) {
    out.add(head);
    for (const form of headForms(head)) out.add(form);
  }
  for (const [noun, roleFamily] of Object.entries(DIRECTION_ROLE)) {
    if (roleFamily !== family) continue;
    out.add(noun);
    for (const form of headForms(noun)) out.add(form);
  }
  return out;
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
  const fHeads = [...directionNouns(family)].map(rx).join('|');
  const iHeads = [...directionNouns(inverse)].map(rx).join('|');
  const text = citationText(row);
  if (!from || !to || !fHeads || !iHeads) return 'none';
  // An ordinary qualifier may sit between the possessive and the head:
  // "Tor's business partner", "Tor's old friend". Two words at most so a
  // different clause cannot supply the head.
  const gap = '(?:[a-z][a-z-]*\\s+){0,2}';
  const patterns: Array<[RegExp, 'forward' | 'reverse']> = [
    [new RegExp(`\\b(?:${from})\\b\\s+(?:is|was|became)\\s+(?:${to})(?:'s|’s|s')\\s+${gap}(?:${fHeads})\\b`, 'i'), 'forward'],
    [new RegExp(`\\b(?:${from})\\b\\s+(?:is|was|became)\\s+(?:${to})(?:'s|’s|s')\\s+${gap}(?:${iHeads})\\b`, 'i'), 'reverse'],
    [new RegExp(`\\b(?:${to})\\b\\s+(?:is|was|became)\\s+(?:${from})(?:'s|’s|s')\\s+${gap}(?:${fHeads})\\b`, 'i'), 'reverse'],
    [new RegExp(`\\b(?:${to})\\b\\s+(?:is|was|became)\\s+(?:${from})(?:'s|’s|s')\\s+${gap}(?:${iHeads})\\b`, 'i'), 'forward'],
    [new RegExp(`\\b(?:${to})(?:'s|’s|s')\\s+${gap}(?:${fHeads})\\b\\s+(?:is|was)\\s+(?:${from})\\b`, 'i'), 'forward'],
    [new RegExp(`\\b(?:${from})(?:'s|’s|s')\\s+${gap}(?:${iHeads})\\b\\s+(?:is|was)\\s+(?:${to})\\b`, 'i'), 'forward'],
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

/**
 * Direction from an active verb/role noun placed between the two names.
 *
 * A form's *owning family* decides the arrow, not just its position: a form
 * from the claimed family between the names is forward, a form from the
 * inverse family is reverse. This stops the inverse family's keys ("student"
 * inside master's keys) from certifying an inversion. Ambiguous forms that
 * belong to both sides cancel and leave `none` (fail closed).
 */
function verbOrderDirection(row: PromoteRow, family: RelationFamily, index?: RosterIndex): 'forward' | 'reverse' | 'none' {
  const inverse = inverseFamilyOf(family);
  const text = citationText(row);
  const masked = maskText(text, row, index);
  const owners = new Map<string, RelationFamily>();
  for (const form of directionNouns(family)) owners.set(form, family);
  for (const form of directionNouns(inverse)) if (!owners.has(form)) owners.set(form, inverse);
  const fromAt = firstMention(text, row, 'from', index);
  const toAt = firstMention(text, row, 'to', index);
  if (!Number.isFinite(fromAt) || !Number.isFinite(toAt)) return 'none';
  let forward = false;
  let reverse = false;
  for (const [form, owner] of [...owners].sort(([a], [b]) => b.length - a.length)) {
    const re = new RegExp(`\\b${rx(form)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const at = m.index;
      if (fromAt < at && at < toAt) {
        if (owner === family) forward = true;
        else if (owner === inverse) reverse = true;
      } else if (toAt < at && at < fromAt) {
        if (owner === family) reverse = true;
        else if (owner === inverse) forward = true;
      }
    }
  }
  if (forward === reverse) return 'none';
  return forward ? 'forward' : 'reverse';
}

/**
 * Direction from a passive construction: "FROM was trained by TO" gives TO
 * the actor role, so the claim "FROM master of TO" is backwards while
 * "FROM servant of TO" is forwards. Never infers from a bare `by`; the verb
 * must be one of the closed passive forms above.
 */
function passiveDirection(row: PromoteRow, family: RelationFamily, index?: RosterIndex): 'forward' | 'reverse' | 'none' {
  const from = aliasAlt(row, 'from', index);
  const to = aliasAlt(row, 'to', index);
  const text = citationText(row);
  if (!from || !to) return 'none';
  const between = '[^.!?]{0,60}?';
  for (const { verb, agent, preposition } of PASSIVE_AGENT) {
    // FROM was VERB prep TO  -> TO is the agent.
    const fromPatient = new RegExp(
      `\\b(?:${from})\\b${between}\\b(?:was|were|is|are|been|being)\\b${between}\\b${verb}\\b${between}\\b${preposition}\\b\\s+(?:${to})\\b`,
      'i',
    );
    if (fromPatient.test(text)) {
      if (agent === family) return 'reverse';
      if (inverseFamiliesOf(agent).has(family)) return 'forward';
    }
    // TO was VERB prep FROM -> FROM is the agent.
    const toPatient = new RegExp(
      `\\b(?:${to})\\b${between}\\b(?:was|were|is|are|been|being)\\b${between}\\b${verb}\\b${between}\\b${preposition}\\b\\s+(?:${from})\\b`,
      'i',
    );
    if (toPatient.test(text)) {
      if (agent === family) return 'forward';
      if (inverseFamiliesOf(agent).has(family)) return 'reverse';
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

/** A family title bound to an endpoint: "Aunt Mara", "Captain Voss". The
 * title must sit immediately before the name, so "her friend had arrived"
 * names no endpoint and proves nothing. */
function titledEndpoint(row: PromoteRow, family: RelationFamily, index: RosterIndex | undefined, text: string): boolean {
  const forms = [...familyHeadForms(family)].sort((a, b) => b.length - a.length);
  const names = [...variantsFor(row, 'from', index), ...variantsFor(row, 'to', index)].filter((v) => v.trim() !== '');
  return forms.some((form) => names.some(
    (name) => new RegExp(`\\b${rx(form)}\\b\\s+(?:the\\s+)?${rx(name)}\\b`, 'i').test(text),
  ));
}

/** A family noun explicitly linked to an endpoint by a preposition:
 * "a secret partnership with Tor". The noun must be the one the preposition
 * attaches to the endpoint, so a third party's friend or enemy is not proof. */
function linkedFamilyTerm(row: PromoteRow, family: RelationFamily, index: RosterIndex | undefined, text: string): boolean {
  const forms = [...familyHeadForms(family)].sort((a, b) => b.length - a.length);
  const names = [...variantsFor(row, 'from', index), ...variantsFor(row, 'to', index)]
    .filter((v) => v.trim() !== '')
    .map(rx)
    .join('|');
  if (!names) return false;
  return forms.some((form) => new RegExp(
    `\\b${rx(form)}\\b\\s+(?:with|of|to|for|toward|towards|against)\\s+(?:the\\s+|a\\s+|an\\s+)?(?:${names})\\b`,
    'i',
  ).test(text));
}

/** A family verb between a subject and an object: "Mara feared Tor", or a
 * pronoun pair whose antecedent the anchor names ("She feared him."). The
 * form must be the verb relating the two, never a noun in another phrase. */
function boundFamilyTerm(row: PromoteRow, family: RelationFamily, index: RosterIndex | undefined, text: string): boolean {
  const forms = [...familyHeadForms(family)].filter((form) => !form.includes(' ')).sort((a, b) => b.length - a.length);
  const names = [...variantsFor(row, 'from', index), ...variantsFor(row, 'to', index)]
    .filter((v) => v.trim() !== '')
    .map(rx)
    .join('|');
  if (!names || !forms.length) return false;
  const anchored = (row.anchorEvidence ?? '').trim() !== '';
  const subject = anchored ? `(?:${names}|he|she|they|i)` : `(?:${names})`;
  // A pronoun object's antecedent must come from the anchor; without one the
  // sentence names neither person and cannot prove a tie.
  const object = anchored ? `(?:${names}|him|her|them|me|us|you)` : `(?:${names})`;
  const gap = '(?:[a-z]+\\s+){0,2}?';
  return forms.some((form) => new RegExp(
    `\\b${subject}\\s+${gap}${rx(form)}\\b\\s+${object}\\b`,
    'i',
  ).test(text));
}

/**
 * A symmetric tie stated in one clause. Only grammatical constructions that
 * bind the family word to the two people count: a title on an endpoint, a
 * noun linked to an endpoint by a preposition, or the model's own verbatim
 * kind source. A family word that merely appears somewhere in the clause may
 * belong to an unnamed third party ("Mara told Tor that her friend had
 * arrived") and never proves a tie on its own.
 */
function sameClauseWithBothEndpoints(row: PromoteRow, family: RelationFamily, index?: RosterIndex): boolean {
  const source = (row.kindSource ?? '').trim();
  for (const clause of clausesOf(citationText(row))) {
    if (!bothEndpointsIn(clause, row, index)) continue;
    if (titledEndpoint(row, family, index, clause)) return true;
    if (linkedFamilyTerm(row, family, index, clause)) return true;
    if (boundFamilyTerm(row, family, index, clause)) return true;
    if (source && normalise(maskText(clause, row, index)).includes(normalise(source))) return true;
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
    const dialogue = dialogueDirection(row, family, index);
    if (dialogue === 'forward') return null;
    if (dialogue === 'reverse') return 'direction-mismatch';
    const possessive = possessiveDirection(row, family, index);
    if (possessive === 'forward') return null;
    if (possessive === 'reverse') return 'direction-mismatch';
    const passive = passiveDirection(row, family, index);
    if (passive === 'forward') return null;
    if (passive === 'reverse') return 'direction-mismatch';
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
  // A possessive states a symmetric tie whichever endpoint owns the noun.
  if (possessiveDirection(row, family, index) !== 'none') return null;
  if (sameClauseWithBothEndpoints(row, family, index)) return null;
  if (definiteDescriptionAnchor(row, family, index)) return null;
  if (contiguousDefiniteDescription(row, family, index)) return null;
  if (dialogueAttributionEntails(row, family, index)) return null;
  return 'relationship-not-entailed';
}

/**
 * Gate-local proof normaliser. Folds presentation exactly the way the
 * integrity audit's `auditNormalize` does (curly quotes, dashes, case,
 * whitespace) so a row that passes this gate also passes `findUnverifiedKeepers`.
 * It deliberately keeps punctuation, unlike `core/text.normalise`, whose
 * output feeds claim fingerprints — this function is for the promotion path
 * only and must never replace that one.
 */
export function proofNormalise(text: string): string {
  return (text ?? '')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Substring match that cannot start or end inside a word: "art" is not in
 * "cart". The audit only needs `includes`; this is the stricter gate form, so
 * a gate pass still implies an audit pass. */
function containsVerbatim(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const wordChar = /[a-z0-9']/;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!wordChar.test(before) && !wordChar.test(after)) return true;
    from = at + 1;
  }
  return false;
}

/**
 * The verbatim floor both tiers stand on: the quote and any anchor must sit
 * word-for-word in the cited passage. Taught by invented quotes banked as
 * fact. It must never pass a paraphrase, however close, and never consult
 * meaning — spelling is the whole job.
 */
export function quoteVerbatimReason(row: PromoteRow, chunkText?: string | null): PromoteReason | null {
  const chunk = chunkText ?? '';
  const chunkProof = proofNormalise(chunk);
  if (!row.evidence.trim() || !chunk || !containsVerbatim(chunkProof, proofNormalise(row.evidence))) {
    return 'quote-not-verbatim';
  }
  const anchor = (row.anchorEvidence ?? '').trim();
  if (anchor && !containsVerbatim(chunkProof, proofNormalise(anchor))) return 'quote-not-verbatim';
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
  const sameEndpoint = (name: string): boolean =>
    [row.fromName, row.toName].some((endpoint) => {
      const relation = nameRelation(name, endpoint);
      return relation === 'same' || relation === 'containment';
    });
  const endpointForms = [
    ...variantsFor(row, 'from', index),
    ...variantsFor(row, 'to', index),
  ].map((variant) => canonicalName(variant)).filter(Boolean);
  // A shorter unrelated name is not a third party when a longer endpoint
  // alias covers the same words: "Magister Damask" is the endpoint's alias,
  // while a bare "Damask" row is not a competing referent in that phrase.
  const shadowed = (form: string): boolean =>
    endpointForms.some(
      (longer) =>
        longer !== form &&
        longer.includes(form) &&
        new RegExp(`\\b${rx(longer)}\\b`, 'i').test(source),
    );
  for (const other of index.rows) {
    if (sameEndpoint(other.name)) continue;
    for (const variant of explicitVariants(other.name, other.aliases, index)) {
      const form = canonicalName(variant);
      if (!form || !new RegExp(`\\b${rx(form)}\\b`, 'i').test(source)) continue;
      if (!shadowed(form)) return true;
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

/** Dialogue tags that explicitly name who is speaking. */
const ATTRIBUTION_VERB =
  'said|says|say|replied|replies|answered|answers|asked|asks|whispered|whispers|' +
  'muttered|mutters|growled|growls|responded|responds|added|adds|continued|continues|' +
  'explained|explains|declared|declares|told|tells|strained|strains|suggested|suggests|' +
  'countered|counters|called|calls|shouted|shouts|hissed|hisses|murmured|murmurs|was\\s+saying';

/** Narration that can carry a speech beat when the quote itself names the
 * addressee. It never supplies the addressee on its own. */
const ACTION_BEAT =
  'walked|walk|turned|turn|looked|look|smiled|smile|nodded|nod|ran|run|lifted|lift|' +
  'glanced|glance|stood|stand|sat|sit|rose|rise|stepped|step|moved|move|reached|reach|' +
  'shook|shake|breathed|inhaled|exhaled|paused|pause|watched|watch|gestured|gesture|' +
  'frowned|frown|grinned|grin|laughed|laugh|sighed|sigh|relaxed|relax|narrowed|narrow|' +
  'responded|responds|reenabled|re-enabled';

/** True when a sentence names one side, using the same canonical matching as
 * `mentionSpans` (hyphenated names such as 11-4D included). */
function mentionsSide(text: string, row: PromoteRow, side: 'from' | 'to', index?: RosterIndex): boolean {
  const source = canonicalName(text);
  return variantsFor(row, side, index).some((variant) => {
    const form = canonicalName(variant);
    return form !== '' && new RegExp(`\\b${rx(form)}\\b`, 'i').test(source);
  });
}

/** Which endpoint a sentence names, only when it names exactly one. */
function endpointSide(text: string, row: PromoteRow, index?: RosterIndex): 'from' | 'to' | null {
  const from = mentionsSide(text, row, 'from', index);
  const to = mentionsSide(text, row, 'to', index);
  if (from === to) return null;
  return from ? 'from' : 'to';
}

/** Character position of the first endpoint mention in canonical text. */
function firstMentionCanonical(text: string, row: PromoteRow, side: 'from' | 'to', index?: RosterIndex): number {
  const source = canonicalName(text);
  let best = Infinity;
  for (const variant of variantsFor(row, side, index)) {
    const form = canonicalName(variant);
    if (!form) continue;
    const at = source.search(new RegExp(`\\b${rx(form)}\\b`, 'i'));
    if (at >= 0 && at < best) best = at;
  }
  return best;
}

/** The endpoint an explicit dialogue tag attributes the sentence to. Both
 * endpoints tagged, or neither, is ambiguous and returns null. */
function attributionSpeaker(sentence: string, row: PromoteRow, index?: RosterIndex): 'from' | 'to' | null {
  const from = aliasAlt(row, 'from', index);
  const to = aliasAlt(row, 'to', index);
  if (!from || !to) return null;
  const source = canonicalName(sentence);
  const tag = (alt: string): RegExp =>
    new RegExp(
      `\\b(?:${alt})\\b\\s+(?:${ATTRIBUTION_VERB})\\b|\\b(?:${ATTRIBUTION_VERB})\\b\\s+(?:${alt})\\b`,
      'i',
    );
  const fromSaid = tag(from).test(source);
  const toSaid = tag(to).test(source);
  if (fromSaid === toSaid) return null;
  return fromSaid ? 'from' : 'to';
}

/** An explicit addressee: a vocative set off by punctuation, or "to NAME" in
 * an attribution clause. Proximity alone is never enough. */
function addressedIn(text: string, alt: string): boolean {
  return new RegExp(
    `(?:,\\s*(?:${alt})\\s*[,.;!?"”]|\\b(?:to|told|addressed|asked)\\s+(?:${alt})\\b|^\\s*["“]?\\s*(?:${alt})\\s*[,;])`,
    'i',
  ).test(text);
}

/**
 * A dialogue anchor from an explicit tag or an action beat. A tag must name
 * both endpoints and put the non-speaker in an explicit addressee position.
 * An action beat must name exactly one endpoint and the quote itself must name
 * the addressee with a vocative. A second quote or attribution between the
 * beat and the quote breaks the link.
 */
function dialogueAnchor(
  row: PromoteRow,
  holding: string,
  sentences: string[],
  at: number,
  index?: RosterIndex,
): string | null {
  // The quote must itself be dialogue: quotation marks and a first/second
  // person address. A third-person pronoun may refer outside the pair.
  if (!/["“”]/.test(holding)) return null;
  if (!/\b(?:I|me|my|we|us|our|you|your)\b/i.test(holding)) return null;
  if (/\b(?:he|him|his|she|her|hers|they|them|their)\b/i.test(holding)) return null;
  if (namesOtherEntity(holding, row, index)) return null;
  // An explicit tag inside the holding is the holding's own business; do not
  // replace it with a nearby beat.
  if (attributionSpeaker(holding, row, index)) return null;

  for (const offset of [-1, -2, 1, 2]) {
    const j = at + offset;
    if (j < 0 || j >= sentences.length) continue;
    const candidate = sentences[j]!;

    const speaker = attributionSpeaker(candidate, row, index);
    if (speaker) {
      if (!citationNamesBothEndpoints({ ...row, evidence: candidate, anchorEvidence: undefined }, index)) continue;
      if (namesOtherEntity(candidate, row, index)) continue;
      const addressee = speaker === 'from' ? 'to' : 'from';
      const alt = aliasAlt(row, addressee, index);
      if (!alt || !addressedIn(candidate, alt)) continue;
      // The quoted relationship must address the tagged addressee, not a
      // third party: the quote says "you", or names the addressee as a vocative.
      if (!/\b(?:you|your)\b/i.test(holding) && !addressedIn(holding, alt)) continue;
      if (offset === -2) {
        const between = sentences[at - 1]!;
        if (/["“”]/.test(between)) continue;
        if (attributionSpeaker(between, row, index)) continue;
      }
      if (offset === 2) {
        const between = sentences[at + 1]!;
        if (/["“”]/.test(between)) continue;
        if (attributionSpeaker(between, row, index)) continue;
      }
      return candidate;
    }

    // Action beat: the quote's own vocative supplies the addressee. The
    // endpoint must precede the action verb; a third-party name elsewhere in
    // the narration (for example a faction called "the Sith") does not make
    // the named endpoint any less the actor.
    if (/["“”]/.test(candidate)) continue;
    const speakerSide = endpointSide(candidate, row, index);
    if (!speakerSide) continue;
    const speakerAt = firstMentionCanonical(candidate, row, speakerSide, index);
    const verbAt = new RegExp(`\\b(?:${ACTION_BEAT})\\b`, 'i').exec(canonicalName(candidate))?.index ?? -1;
    if (!Number.isFinite(speakerAt) || verbAt < 0 || speakerAt > verbAt) continue;
    const addressee = speakerSide === 'from' ? 'to' : 'from';
    const alt = aliasAlt(row, addressee, index);
    if (!alt || !addressedIn(holding, alt)) continue;
    if (offset === -2) {
      const between = sentences[at - 1]!;
      if (/["“”]/.test(between)) continue;
      if (attributionSpeaker(between, row, index)) continue;
      if (endpointSide(between, row, index)) continue;
    }
    return candidate;
  }
  return null;
}

/** True when a symmetric dialogue tie is proved by an explicit attribution:
 * the quote carries the family term, names no third party, and addresses the
 * tagged addressee. Asymmetric dialogue keeps the direction grammar below. */
function dialogueAttributionEntails(row: PromoteRow, family: RelationFamily, index?: RosterIndex): boolean {
  if (isAsymmetricFamily(family)) return false;
  const anchor = (row.anchorEvidence ?? '').trim();
  if (!anchor) return false;
  if (!citationNamesBothEndpoints(row, index)) return false;
  const evidence = row.evidence;
  if (/\b(?:he|him|his|she|her|hers|they|them|their)\b/i.test(evidence)) return false;
  if (namesOtherEntity(evidence, row, index)) return false;
  if (namesOtherEntity(anchor, row, index)) return false;
  const speaker = attributionSpeaker(anchor, row, index) ?? endpointSide(anchor, row, index);
  if (!speaker) return false;
  const addressee = speaker === 'from' ? 'to' : 'from';
  const alt = aliasAlt(row, addressee, index);
  if (!alt) return false;
  if (!addressedIn(anchor, alt) && !addressedIn(evidence, alt)) return false;
  if (!/\b(?:you|your)\b/i.test(evidence) && !addressedIn(evidence, alt)) return false;
  const maskedEvidence = maskText(evidence, row, index);
  return familyTermPresent(maskedEvidence, family);
}

/** The arrow of an asymmetric dialogue claim from "I am your HEAD" / "you are
 * my HEAD" and the explicit speaker/addressee. Null means the quote does not
 * place the family in the first or second person; existing grammar decides. */
function dialogueDirection(row: PromoteRow, family: RelationFamily, index?: RosterIndex): 'forward' | 'reverse' | 'none' {
  const anchor = (row.anchorEvidence ?? '').trim();
  if (!anchor) return 'none';
  const speaker = attributionSpeaker(anchor, row, index) ?? endpointSide(anchor, row, index);
  if (!speaker) return 'none';
  const addressee = speaker === 'from' ? 'to' : 'from';
  const evidence = row.evidence;
  if (/\b(?:he|him|his|she|her|hers|they|them|their)\b/i.test(evidence)) return 'none';
  const inverse = inverseFamilyOf(family);
  const heads = [...familyHeadForms(family)].sort((a, b) => b.length - a.length).map(rx).join('|');
  const invHeads = [...familyHeadForms(inverse)].sort((a, b) => b.length - a.length).map(rx).join('|');
  if (!heads || !invHeads) return 'none';

  const firstPerson = new RegExp(
    `\\bI\\s+(?:am|was|become|became|will\\s+be|shall\\s+be)\\s+(?:your|thy)\\s+(?:the\\s+)?(${heads}|${invHeads})\\b`,
    'i',
  ).exec(evidence);
  if (firstPerson) {
    const head = firstPerson[1]!.toLowerCase();
    if (familyHeadForms(family).has(head)) return speaker === 'from' ? 'forward' : 'reverse';
    if (familyHeadForms(inverse).has(head)) return speaker === 'from' ? 'reverse' : 'forward';
  }

  const secondPerson = new RegExp(
    `\\b(?:you|thou)\\s+(?:are|were|become|became|will\\s+be|shall\\s+be)\\s+(?:my|our)\\s+(?:the\\s+)?(${heads}|${invHeads})\\b`,
    'i',
  ).exec(evidence);
  if (secondPerson) {
    const head = secondPerson[1]!.toLowerCase();
    if (familyHeadForms(family).has(head)) return addressee === 'from' ? 'forward' : 'reverse';
    if (familyHeadForms(inverse).has(head)) return addressee === 'from' ? 'reverse' : 'forward';
  }
  return 'none';
}

/**
 * Endpoint context from the quoted sentence itself. A stored relation often
 * quotes a sub-span of the sentence that introduces both people ("Married to
 * Ruwee by arrangement" from "…she was…", with "You remember Jobal?" just
 * before), or a pronoun-only line of dialogue whose speaker and addressee are
 * named by an explicit tag. Identity grounding may use the introduction and a
 * pure description, or an explicit local attribution. It never treats a
 * nearby named character as the antecedent, and it never decides the
 * relationship; entailment remains a separate check.
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
    const anchor =
      introducedReferentAnchor(row, holding, sentences, i, index) ??
      dialogueAnchor(row, holding, sentences, i, index);
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
  // A caller that forgets the model's score has not judged the claim: the
  // missing value must fail the bar, never take the maximum.
  if (claimTier(guarded.confidence ?? 0, min) !== 'accepted') return { ok: false, reason: 'below-threshold' };
  const entailment = relationEntailmentReason(guarded, context.index);
  if (entailment) return { ok: false, reason: entailment };
  return { ok: true };
}
