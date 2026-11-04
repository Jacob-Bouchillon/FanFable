/**
 * Canon answers.
 *
 * Moved mechanically from lore.ts; imports only, no logic change.
 */
import { createHash } from 'node:crypto';
import { Db, nowIso } from '../core/db.ts';
import type { LlmClient } from '../core/llm.ts';
import { nameMentionedExact, buildRosterIndex, deriveNameVariants, canonicalName, nameRelation, type RosterIndex } from '../identity/names.ts';
import * as lorebook from '../lorebook.ts';
import { expandQuery, searchCanon } from './lore-search.ts';
import type { Passage } from './lore.ts';
import * as traceLog from '../trace/trace.ts';
import type { RetrievalTraceEvent } from '../trace/trace.ts';

/* ------------------------------------------------------------- lore answers */

export interface LoreAnswer {
  answer: string;
  passages: Passage[];
  /** True when the model had enough evidence to ground its answer. */
  grounded: boolean;
  /** Diagnostic retrieval trace, when requested by the caller. */
  traceId?: string;
}

/** Opt-in tracing for the lore-ask retrieval path. */
export interface LoreAskTraceOptions {
  enabled?: boolean;
  sampledRate?: number;
}

const LORE_SYSTEM = `You are the Lore Researcher for a fanfiction project.
You answer questions about the original source material using the extracted lore index and the
retrieved passages. Those are the only permitted sources of canon.

Rules:
- Cite every claim with the passage label in square brackets, e.g. [S1], [S2], or with the
  entity name when the claim comes from the extracted index, e.g. [Lore: Ilsa Marrow].
- If the material does not contain the answer, say exactly what is missing. Do not invent canon details.
- Clearly separate CONFIRMED (directly supported) from INFERRED (a reasoned guess).
- A tie between two named people is CONFIRMED only when the lore index banks it
  between those two names, or when you quote a passage that names both people AND
  states the tie in so many words. A quote that names one side, or states no tie,
  never confirms one: say the tie is not established.
- Never state that one person is another person. Alias and identity claims need
  an explicit quote; a shared title, shared scenes, or a summary sentence are not proof.
- Quote short key phrases from the source when they matter.
- Keep the answer focused and organised with short sections.`;

export function formatPassages(passages: Passage[]): string {
  return passages
    .map((p, i) => {
      const label = `S${i + 1}`;
      return `[${label}] source: ${p.sourceTitle} (${p.path}) | locator: ${p.locator}\n${p.text}`;
    })
    .join('\n\n');
}

/**
 * Answer a lore question from canon, with citations.
 *
 * `search` is optional; when omitted the researcher performs its own retrieval.
 */
/* --------------------------------------------- answer-tie guard (universal) */

/**
 * Code enforcement behind the LORE_SYSTEM tie rule. The prompt alone is
 * advisory: the model can still write CONFIRMED for a pair the bank never
 * held. This guard runs after the model returns and only affects questions
 * shaped like "status of A to B" (the frozen probe shape and the ask CLI).
 * No names, kinds, or books appear here: A and B come from the question,
 * aliases come from the entity rows, and passage text is only tested for
 * naming both sides in one passage.
 */
function entityVariantsFor(
  entities: { id: number; name: string; aliases: string[] }[],
  query: string,
  index?: RosterIndex,
): { ids: number[]; variants: string[] } {
  const q = query.toLowerCase();
  const canonical = canonicalName(query);
  const matched = entities.filter((e) => {
    if (e.name.toLowerCase() === q || e.aliases.some((al) => al.toLowerCase() === q)) return true;
    // Same person under the roster's identity rule, or a derived variant the
    // prose actually uses. Query-time only: nothing is merged or written.
    const relation = nameRelation(query, e.name);
    if (relation === 'same' || relation === 'containment') return true;
    return index ? deriveNameVariants({ name: e.name, aliases: e.aliases }, index).includes(canonical) : false;
  });
  const pool = matched.length ? matched : [];
  const ids = pool.map((e) => e.id);
  const variants = [q];
  for (const e of pool) {
    if (index) {
      // Explicit forms first, then derived given/surname/title-stripped forms.
      variants.push(...deriveNameVariants(e, index));
    } else {
      variants.push(e.name.toLowerCase());
      for (const al of e.aliases) variants.push(al.toLowerCase());
    }
  }
  return { ids, variants: [...new Set(variants)].filter((v) => v.length > 0) };
}

export function passageNamesBoth(passages: Passage[], variantsA: string[], variantsB: string[]): boolean {
  return passages.some((pg) => {
    if (!pg.text) return false;
    const hitsA = variantsA.some((v) => nameMentionedExact(v, pg.text));
    const hitsB = variantsB.some((v) => nameMentionedExact(v, pg.text));
    return hitsA && hitsB;
  });
}

const RELATION_PARTICLES = new Set(['of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as']);

/** First content word of a closed kind: "master of" -> master. */
function relationHead(kind: string): string {
  return (kind ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .find((word) => !RELATION_PARTICLES.has(word)) ?? '';
}

const PLURAL_HEADS: Record<string, string> = {
  ally: 'allies', enemy: 'enemies', sibling: 'siblings', parent: 'parents',
  child: 'children', spouse: 'spouses', partner: 'partners', friend: 'friends',
  brother: 'brothers', sister: 'sisters', mother: 'mothers', father: 'fathers',
  son: 'sons', daughter: 'daughters', cousin: 'cousins', uncle: 'uncles',
  aunt: 'aunts', nephew: 'nephews', niece: 'nieces', leader: 'leaders',
  member: 'members', student: 'students', teacher: 'teachers', mentor: 'mentors',
  master: 'masters', apprentice: 'apprentices', aide: 'aides', assistant: 'assistants',
  colleague: 'colleagues', peer: 'peers', relative: 'relatives', married: 'married',
};

const CLOSED_HEADS = new Set(
  lorebook.CLOSED_ROLE_KINDS.map(relationHead).filter(Boolean),
);

/** Closed heads whose concept is the same claim in either order. */
const SYMMETRIC_HEADS = new Set(
  lorebook.CLOSED_ROLE_KINDS.filter((kind) => lorebook.isSymmetricKind(kind))
    .map(relationHead)
    .filter(Boolean),
);

const INVERSE_HEADS = (() => {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a)!.add(b);
    map.get(b)!.add(a);
  };
  for (const [left, right] of lorebook.INVERSE_PAIRS) link(left, right);
  return map;
})();

interface AssertedClaim {
  /** Closed head or an open term used only for detection. */
  head: string;
  kind?: string;
  term?: string;
  direction: 'a-to-b' | 'b-to-a' | 'unknown';
  unmapped?: boolean;
  /** A claim naming only one side of the asked pair. */
  offPair?: boolean;
}

interface OpenTerm {
  term: string;
  re: RegExp;
  kind?: string;
}

/** Open wording detected for relationship checking, never for extraction. */
const OPEN_TERMS: OpenTerm[] = [
  { term: 'partnership', re: /\bpartnership\b/i, kind: 'partner' },
  { term: 'partner', re: /\bpartners?\b/i, kind: 'partner' },
  { term: 'alliance', re: /\balliance\b/i, kind: 'ally of' },
  { term: 'allied', re: /\ballied\b/i, kind: 'ally of' },
  { term: 'served under', re: /\bserved\s+(?:under|for)\b/i, kind: 'aide of' },
  { term: 'served', re: /\bserved\b/i, kind: 'aide of' },
  { term: 'worked for', re: /\bworked\s+(?:for|under)\b/i, kind: 'operative for' },
  { term: 'employed', re: /\bemploy(?:ed|s|ment)?\b/i, kind: 'operative for' },
  { term: 'mentor', re: /\bmentor(?:ed|s|ing)?\b/i, kind: 'mentor of' },
  { term: 'student', re: /\bstudents?\b/i, kind: 'student of' },
  { term: 'family', re: /\bfamily\b/i, kind: 'relative of' },
  { term: 'related', re: /\brelated\b/i, kind: 'relative of' },
  { term: 'married', re: /\bmarried\b/i, kind: 'married to' },
  { term: 'friend', re: /\bfriends?\b/i, kind: 'friend of' },
  { term: 'enemy', re: /\benem(?:y|ies)\b/i, kind: 'enemy of' },
  { term: 'rival', re: /\brivals?\b/i, kind: 'rival of' },
  { term: 'subordinate', re: /\bsubordinates?\b/i },
  { term: 'superior', re: /\bsuperiors?\b/i },
  { term: 'employer', re: /\bemployers?\b/i },
  { term: 'employee', re: /\bemployees?\b/i },
  { term: 'bodyguard', re: /\bbodyguards?\b/i },
  { term: 'informant', re: /\binformants?\b/i },
];

function cleanPairName(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

function parsePairQuestion(question: string): { a: string; b: string; kind?: string } | null {
  const noScope = question
    .replace(/\s+as\s+of\s+.*$/i, '')
    .trim()
    .replace(/[.,;:!?]+$/g, '')
    .trim();
  let m = noScope.match(/status\s+of\s+(.+?)\s+to\s+(.+?)\s*$/i);
  if (m) {
    const a = cleanPairName(m[1]!);
    const b = cleanPairName(m[2]!);
    return a && b ? { a, b } : null;
  }
  m = noScope.match(/^(?:who|what)\s+is\s+(.+?)\s+to\s+(.+?)\s*$/i);
  if (m) {
    const a = cleanPairName(m[1]!);
    const b = cleanPairName(m[2]!);
    return a && b ? { a, b } : null;
  }
  m = noScope.match(/^how\s+are\s+(.+?)\s+and\s+(.+?)\s+related\s*$/i);
  if (m) {
    const a = cleanPairName(m[1]!);
    const b = cleanPairName(m[2]!);
    return a && b ? { a, b } : null;
  }
  m = noScope.match(/^is\s+(.+?)\s+(.+?)['’]s\s+(.+?)\s*$/i);
  if (m) {
    const a = cleanPairName(m[1]!);
    const b = cleanPairName(m[2]!);
    const kind = cleanPairName(m[3]!);
    if (a && b) return { a, b, ...(kind ? { kind } : {}) };
  }
  return null;
}

function nameTokensOf(variants: string[]): Set<string> {
  const out = new Set<string>();
  for (const variant of variants) {
    for (const token of variant.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 2) out.add(token);
    }
  }
  return out;
}

/** Which side owns the possessive or the object after "of"/a bare head. */
function claimDirection(
  sentence: string,
  head: string,
  sideATokens: Set<string>,
  sideBTokens: Set<string>,
): 'a-to-b' | 'b-to-a' | 'unknown' {
  const words = sentence.toLowerCase().split(/\s+/).filter(Boolean);
  const headIndex = words.findIndex((word) => word.replace(/[^a-z]/g, '') === head);
  if (headIndex < 0) return 'unknown';
  const owner = (token: string): 'a' | 'b' | null => {
    const base = token.replace(/[^a-z'’]/g, '').replace(/['’]s$/, '');
    if (sideATokens.has(base)) return 'a';
    if (sideBTokens.has(base)) return 'b';
    return null;
  };
  const possessor = (index: number): 'a' | 'b' | null => {
    const token = words[index] ?? '';
    if (!/['’]s$/.test(token)) return null;
    return owner(token);
  };
  const before = possessor(headIndex - 1);
  if (before) return before === 'b' ? 'a-to-b' : 'b-to-a';
  if (words[headIndex + 1] === 'of') {
    const object = owner(words[headIndex + 2] ?? '');
    if (object === 'b') return 'a-to-b';
    if (object === 'a') return 'b-to-a';
  }
  return 'unknown';
}

/** Direction for open wording: nearest named subject before, object after. */
function openTermDirection(
  sentence: string,
  term: OpenTerm,
  sideATokens: Set<string>,
  sideBTokens: Set<string>,
): 'a-to-b' | 'b-to-a' | 'unknown' {
  const match = term.re.exec(sentence);
  if (!match) return 'unknown';
  const before = sentence.slice(0, match.index).toLowerCase();
  const after = sentence.slice(match.index + match[0].length).toLowerCase();
  const side = (text: string): 'a' | 'b' | null => {
    const tokens = text.split(/[^a-z0-9]+/);
    for (const token of tokens) {
      if (sideATokens.has(token)) return 'a';
      if (sideBTokens.has(token)) return 'b';
    }
    return null;
  };
  const subject = side(before);
  const object = side(after);
  if (!subject || !object) return 'unknown';
  const passive = /\b(?:was|were|is|are|been|being)\b[^.]*\bby\b/i.test(after) || /\bby\b[\s\S]*$/.test(after);
  if (passive) return subject === 'b' ? 'a-to-b' : 'b-to-a';
  return subject === 'a' && object === 'b' ? 'a-to-b' : subject === 'b' && object === 'a' ? 'b-to-a' : 'unknown';
}

/** Words that deny or soften the clause they precede. Used only near the
 * asserted relationship term, never to excuse a whole sentence. */
const CLAIM_NEGATORS = new Set(['not', 'never', 'cannot', "can't", "isn't", "wasn't", "aren't", "weren't", "don't", "doesn't", "didn't", 'without', 'hardly', 'barely']);
const CLAIM_HEDGES = new Set(['perhaps', 'possibly', 'maybe', 'might', 'may', 'could', 'probably', 'apparently', 'seemingly', 'suspected', 'rumoured', 'rumored']);

/** True when the relation term at `at` is itself denied or hedged by the four
 * tokens before it. "No doubt, Asha is Bram's sister" keeps its claim; "Asha
 * is not Bram's sister" and "Perhaps Asha is Bram's sister" do not. */
function claimDenied(sentence: string, at: number): boolean {
  const before = sentence.slice(0, Math.max(0, at)).toLowerCase().replace(/[^a-z']+/g, ' ').trim();
  if (!before) return false;
  return before
    .split(' ')
    .filter(Boolean)
    .slice(-4)
    .some((word) => CLAIM_NEGATORS.has(word) || CLAIM_HEDGES.has(word));
}

function assertedClaims(
  draft: string,
  sideAVariants: string[],
  sideBVariants: string[],
): AssertedClaim[] {
  const sideATokens = nameTokensOf(sideAVariants);
  const sideBTokens = nameTokensOf(sideBVariants);
  const claims = new Map<string, AssertedClaim>();
  const sentences = draft.split(/[.!?\n]+/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const namesA = sideAVariants.some((variant) => lower.includes(variant.toLowerCase()));
    const namesB = sideBVariants.some((variant) => lower.includes(variant.toLowerCase()));
    const pronoun = /\b(he|she|they|him|her|them|his|hers|their|theirs)\b/i.test(sentence);
    if (!(namesA && namesB) && !((namesA || namesB) && pronoun)) continue;
    for (const head of CLOSED_HEADS) {
      const forms = [head, PLURAL_HEADS[head]].filter(Boolean) as string[];
      const match = new RegExp(`\\b(?:${forms.join('|')})\\b`, 'i').exec(sentence);
      if (!match) continue;
      // Only a denial of *this* claim suppresses it. A negation elsewhere in
      // the sentence ("No doubt, Asha is Bram's sister") is not a denial.
      if (claimDenied(sentence, match.index)) continue;
      const direction = claimDirection(sentence, head, sideATokens, sideBTokens);
      claims.set(`${head}|${direction}`, { head, direction });
    }
    for (const term of OPEN_TERMS) {
      const match = term.re.exec(sentence);
      if (!match) continue;
      if (claimDenied(sentence, match.index)) continue;
      const kind = term.kind;
      const head = kind ? relationHead(kind) : term.term;
      const direction = openTermDirection(sentence, term, sideATokens, sideBTokens);
      const key = `${term.kind ?? `unmapped:${term.term}`}|${direction}`;
      if (claims.has(key)) continue;
      if (
        kind &&
        [...claims.values()].some((claim) => claim.kind === kind || claim.head === relationHead(kind))
      ) {
        continue;
      }
      claims.set(key, {
        head,
        kind,
        term: term.term,
        direction,
        ...(kind ? {} : { unmapped: true }),
      });
    }
  }
  if (!claims.size) {
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const oneSide = sideAVariants.some((variant) => lower.includes(variant.toLowerCase())) ||
        sideBVariants.some((variant) => lower.includes(variant.toLowerCase()));
      if (!oneSide) continue;
      for (const head of CLOSED_HEADS) {
        const forms = [head, PLURAL_HEADS[head]].filter(Boolean) as string[];
        const match = new RegExp(`\\b(?:${forms.join('|')})\\b`, 'i').exec(sentence);
        if (!match) continue;
        if (claimDenied(sentence, match.index)) continue;
        claims.set(`${head}|off`, { head, direction: 'unknown', offPair: true });
        break;
      }
      if (claims.size) break;
    }
  }
  return [...claims.values()];
}

interface ClaimVerification {
  supported: boolean;
  reason?: 'unsupported-relationship' | 'unmapped-relationship' | 'direction-mismatch';
}

function verifyClaim(
  db: Db,
  projectId: number,
  pair: { a: string; b: string },
  sideA: { ids: number[] },
  sideB: { ids: number[] },
  claim: AssertedClaim,
): ClaimVerification {
  if (claim.offPair) return { supported: false, reason: 'unsupported-relationship' };
  const keepers = lorebook.lookupKeeperPair(db, projectId, pair.a, pair.b);
  if (claim.unmapped) {
    return keepers.length
      ? { supported: true }
      : { supported: false, reason: 'unmapped-relationship' };
  }
  const rowDirection = (fromId: number, toId: number): 'a-to-b' | 'b-to-a' | 'unknown' => {
    if (sideA.ids.includes(fromId) && sideB.ids.includes(toId)) return 'a-to-b';
    if (sideB.ids.includes(fromId) && sideA.ids.includes(toId)) return 'b-to-a';
    return 'unknown';
  };
  let matchedKind = false;
  for (const row of keepers) {
    const rowHead = relationHead(row.kind);
    const inverse = INVERSE_HEADS.get(claim.head)?.has(rowHead) ?? false;
    if (rowHead !== claim.head && !inverse) continue;
    matchedKind = true;
    // A symmetric concept is the same claim in either order; heads that
    // correspond (same or inverse) support it regardless of the arrow.
    if (SYMMETRIC_HEADS.has(claim.head) || SYMMETRIC_HEADS.has(rowHead)) return { supported: true };
    const direction = rowDirection(row.fromId, row.toId);
    if (claim.direction === 'unknown' || direction === 'unknown') return { supported: true };
    if (inverse ? direction !== claim.direction : direction === claim.direction) return { supported: true };
  }
  // Attested rows are citable with their passage scope shown, so they support
  // a claim the same way — but never as keeper-grade.
  for (const row of lorebook.lookupAttestedPair(db, projectId, pair.a, pair.b)) {
    const rowHead = relationHead(row.kind);
    const inverse = INVERSE_HEADS.get(claim.head)?.has(rowHead) ?? false;
    if (rowHead !== claim.head && !inverse) continue;
    matchedKind = true;
    if (SYMMETRIC_HEADS.has(claim.head) || SYMMETRIC_HEADS.has(rowHead)) return { supported: true };
    const direction = rowDirection(row.fromId, row.toId);
    if (claim.direction === 'unknown' || direction === 'unknown') return { supported: true };
    if (inverse ? direction !== claim.direction : direction === claim.direction) return { supported: true };
  }
  return {
    supported: false,
    reason: matchedKind ? 'direction-mismatch' : 'unsupported-relationship',
  };
}

function claimLabel(pair: { a: string; b: string }, claim: AssertedClaim): string {
  if (claim.unmapped) return `${pair.a} / ${pair.b} — ${claim.term}`;
  if (claim.direction === 'b-to-a') return `${pair.b} ${claim.head} ${pair.a}`;
  if (claim.direction === 'a-to-b') return `${pair.a} ${claim.head} ${pair.b}`;
  return `${pair.a} / ${pair.b} ${claim.head}`;
}

/** Normalise presentation only: quotes, dashes, case and whitespace. */
function citationNormalize(text: string): string {
  return (text ?? '')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function quotedSpans(draft: string): string[] {
  const spans: string[] = [];
  const re = /["“]([^"”]+)["”]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(draft)) !== null) {
    const span = match[1]!.trim();
    // Every quoted span is checked, however short: "moon is cheese" claims
    // passage evidence exactly as a long quotation does.
    if (!span) continue;
    const lineEndAt = draft.indexOf('\n', match.index + match[0].length);
    const tail = draft.slice(match.index + match[0].length, lineEndAt < 0 ? undefined : lineEndAt);
    // The extracted-index exemption belongs to *this quote*: the [Lore: ...]
    // marker must immediately follow the closing quotation mark. A marker
    // elsewhere on the line does not excuse a fabricated passage quote.
    if (/^\s*[.,;:]?\s*\[Lore:/i.test(tail) && !/\[S\d/i.test(tail)) continue;
    spans.push(span);
  }
  return spans;
}

interface CitationCheck {
  ok: boolean;
  failing?: string;
}

function verifyCitations(draft: string, passages: Passage[]): CitationCheck {
  const spans = quotedSpans(draft);
  if (!spans.length) return { ok: true };
  const haystacks = passages
    .map((passage) => citationNormalize(passage.text))
    .filter((text) => text.length > 0);
  for (const span of spans) {
    const needle = citationNormalize(span);
    if (!needle) continue;
    if (!haystacks.some((hay) => hay.includes(needle))) {
      return { ok: false, failing: span };
    }
  }
  return { ok: true };
}

function abstainAnswer(pair: { a: string; b: string }, draft: string, reason: string): string {
  return (
    `### Status of ${pair.a} to ${pair.b}\n\n` +
    `Tie not established. The lore index does not authorise the claimed relationship between ${pair.a} and ${pair.b}.\n\n` +
    `Reason: ${reason}\n\n` +
    `---\nOriginal draft (uncorrected, kept for audit):\n${draft}`
  );
}

/**
 * Verify quoted evidence and asserted relationships separately.
 *
 * Check A: every quoted span must be a contiguous verbatim part of a retrieved
 * passage. Check B: every relationship claim must have a keeper of that kind
 * and direction, or for unmapped wording at least one keeper for the pair.
 * Neither check authorises the other.
 */
export function enforceStatusTieGuard(
  db: Db,
  projectId: number,
  question: string,
  draft: string,
  passages: Passage[],
): string {
  // Test-only A/B switch. Unset or any value other than '1' keeps the guard.
  if (process.env.FANFABLE_NO_GUARD === '1') return draft;
  const pair = parsePairQuestion(question);
  if (!pair) return draft;

  const citation = verifyCitations(draft, passages);
  if (!citation.ok) {
    return abstainAnswer(pair, draft, `quote-not-in-passage — "${citation.failing!.slice(0, 160)}"`);
  }

  let entities: { id: number; name: string; aliases: string[] }[] = [];
  try {
    entities = lorebook.listEntities(db, projectId).map((entity) => ({
      id: entity.id,
      name: entity.name,
      aliases: entity.aliases ?? [],
    }));
  } catch {
    return draft;
  }
  // One index for this guard pass: a question naming a full stored name is
  // satisfied by the short form the passage actually uses.
  let index: RosterIndex | undefined;
  try {
    index = buildRosterIndex(
      entities,
      db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
        .map((row) => row.text)
        .join(' '),
    );
  } catch {
    index = undefined;
  }
  const sideA = entityVariantsFor(entities, pair.a, index);
  const sideB = entityVariantsFor(entities, pair.b, index);
  const claims = assertedClaims(draft, sideA.variants, sideB.variants);
  if (!claims.length) return draft;
  const results = claims.map((claim) => ({ claim, result: verifyClaim(db, projectId, pair, sideA, sideB, claim) }));
  const unsupported = results.filter((row) => !row.result.supported);
  if (!unsupported.length) return draft;
  const supported = results.filter((row) => row.result.supported);
  const reasons = [...new Set(unsupported.map((row) => row.result.reason ?? 'unsupported-relationship'))];
  if (!supported.length) return abstainAnswer(pair, draft, reasons.join(', '));
  const labels = [...new Set(unsupported.map((row) => claimLabel(pair, row.claim)))];
  return `Correction: Bank holds no keeper for: ${labels.join('; ')} (${reasons.join(', ')}).\n\n${draft}`;
}

export async function answerLoreQuestion(
  db: Db,
  llm: LlmClient,
  projectId: number,
  question: string,
  opts: { limit?: number; sourceId?: number; search?: Passage[]; trace?: LoreAskTraceOptions } = {},
): Promise<LoreAnswer> {
  const traceStartedAt = nowIso();
  const traceBuffer = opts.trace?.enabled === true ? traceLog.createRetrievalTraceBuffer() : undefined;
  const queryHash = createHash('sha256').update(question, 'utf8').digest('hex');
  const emit = (event: RetrievalTraceEvent): void => {
    traceBuffer?.emit(event);
  };
  const finishTrace = (mode: string, interrupted = false): string | undefined => {
    if (!traceBuffer) return undefined;
    let traceId: string | undefined;
    try {
      const record = traceLog.startTrace(db, {
        projectId,
        startedAt: traceStartedAt,
        sampledRate: opts.trace?.sampledRate ?? 1,
        metadata: {
          command: 'lore ask',
          mode,
          query_sha256: queryHash,
          query_length: question.length,
          limit: opts.limit ?? 8,
          ...(opts.sourceId !== undefined ? { source_id: opts.sourceId } : {}),
        },
      });
      traceId = record.id;
      traceLog.flushRetrievalTrace(db, projectId, record.id, traceBuffer);
      traceLog.finishTrace(db, record.id, interrupted ? { interrupted: true } : {});
    } catch {
      // Diagnostic tracing must never change the lore answer.
    }
    return traceId;
  };
  // A user's own confirmation needs no book passage. Answer it plainly and
  // carry no citation, so it can never be mistaken for quoted canon.
  const pair = parsePairQuestion(question);
  if (pair) {
    const keepers = lorebook.lookupKeeperPair(db, projectId, pair.a, pair.b);
    const hasRefs = (keeper: lorebook.PairKeeper): boolean => {
      try {
        const refs = JSON.parse(keeper.sourceRefs || '[]');
        return Array.isArray(refs) && refs.length > 0;
      } catch {
        return false;
      }
    };
    const userConfirmed = keepers.filter((keeper) => keeper.confirmedByUser && !hasRefs(keeper));
    const passageBacked = keepers.filter(hasRefs);
    if (userConfirmed.length && !passageBacked.length) {
      emit({
        event: 'retrieval.shortcut',
        subject: 'shortcut:pair',
        decision: 'selected',
        reasonCode: 'user-confirmed',
        refs: { count: userConfirmed.length, stage: 'shortcut' },
      });
      emit({
        event: 'retrieval.completed',
        subject: 'retrieval',
        decision: 'completed',
        reasonCode: 'shortcut',
        refs: { count: 0, stage: 'handoff' },
      });
      const traceId = finishTrace('pair-user-confirmed');
      return {
        answer:
          `### Status of ${pair.a} to ${pair.b}\n\n` +
          'Confirmed by the user. This tie is held in the bank because the user confirmed it; ' +
          'no book passage was cited.\n\n' +
          `Bank line: ${userConfirmed.map((keeper) => `${keeper.fromName} — ${keeper.kind} ${keeper.toName}`).join('; ')}`,
        passages: [],
        grounded: true,
        ...(traceId ? { traceId } : {}),
      };
    }
    // Attested-only pairs are answered distinctly: quote plus passage scope,
    // marked as passage-level rather than keeper-grade. No model call.
    const attestedOnly = lorebook.lookupAttestedPair(db, projectId, pair.a, pair.b).filter(hasRefs);
    if (!passageBacked.length && attestedOnly.length) {
      const cited = [...attestedOnly].sort((x, y) => x.id - y.id)[0]!;
      let chunkId: number | undefined;
      try {
        chunkId = (JSON.parse(cited.sourceRefs || '[]') as { chunk?: unknown }[])
          .map((ref) => Number(ref?.chunk))
          .find((id) => Number.isFinite(id));
      } catch {
        chunkId = undefined;
      }
      const chunk = chunkId === undefined ? undefined : db.get<{
        id: number; source_id: number; title: string; path: string; locator: string; heading: string; text: string;
      }>(
        'SELECT c.id, c.source_id, s.title, s.path, c.locator, c.heading, c.text FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.id = ? AND c.project_id = ?',
        chunkId,
        projectId,
      );
      const shortcutPassages = chunk
        ? [{ chunkId: chunk.id, sourceId: chunk.source_id, sourceTitle: chunk.title, path: chunk.path, locator: chunk.locator, heading: chunk.heading, text: chunk.text, score: 1 }]
        : [];
      emit({
        event: 'retrieval.shortcut',
        subject: 'shortcut:pair',
        decision: 'selected',
        reasonCode: 'attested',
        refs: { count: shortcutPassages.length, stage: 'shortcut' },
      });
      if (chunk) {
        for (const event of ['retrieval.candidate.generated', 'retrieval.candidate.disposition']) {
          emit({
            event,
            subject: `chunk:${chunk.id}`,
            decision: event === 'retrieval.candidate.generated' ? 'candidate' : 'selected',
            reasonCode: event === 'retrieval.candidate.generated' ? 'shortcut' : 'selected',
            refs: { chunk_id: chunk.id, rank: 1, score: 1, stage: 'shortcut' },
          });
        }
      }
      emit({
        event: 'retrieval.completed',
        subject: 'retrieval',
        decision: 'completed',
        reasonCode: 'shortcut',
        refs: { count: shortcutPassages.length, stage: 'handoff' },
      });
      const traceId = finishTrace('pair-attested');
      return {
        answer:
          `### Status of ${pair.a} to ${pair.b}\n\n` +
          'Attested (passage-level, not keeper-grade). The quote states the tie and both names appear in the cited passage, but no single sentence proves it and no reviewer confirmed it.\n\n' +
          `Bank line: ${cited.fromName} — ${cited.kind} ${cited.toName}\n` +
          `Quote: ${cited.evidence}\n` +
          (chunk ? `Passage: ${chunk.locator} (${chunk.title})` : 'Passage: uncited'),
        passages: shortcutPassages,
        grounded: true,
        ...(traceId ? { traceId } : {}),
      };
    }
  }
  let passages = opts.search ?? [];
  let indexText = '';
  let index: ReturnType<typeof lorebook.searchLore> = { entities: [], relations: [], facts: [], timeline: [] };
  let mode = opts.search?.length ? 'supplied-search' : 'fts';
  let traceId: string | undefined;
  try {
    if (passages.length) {
      // Callers may hand in their own candidate pool; rank it by the same bank
      // signal the keyword path uses, without changing the pool.
      const rawSupplied = passages.length;
      passages = lorebook.rankWithBank(db, projectId, question, passages);
      emit({
        event: 'retrieval.summary',
        subject: 'search:supplied',
        decision: 'completed',
        reasonCode: passages.length ? 'ok' : 'empty',
        refs: {
          raw_count: rawSupplied,
          dedup_count: rawSupplied,
          ranked_count: passages.length,
          selected_count: passages.length,
          budgeted_count: 0,
          excluded_count: 0,
          stage: 'supplied',
        },
      });
      emit({
        event: 'retrieval.search.completed',
        subject: 'search:supplied',
        decision: 'completed',
        reasonCode: passages.length ? 'ok' : 'empty',
        refs: { count: passages.length, stage: 'supplied' },
      });
      for (let i = 0; i < passages.length; i++) {
        const passage = passages[i]!;
        for (const event of ['retrieval.candidate.generated', 'retrieval.candidate.disposition']) {
          emit({
            event,
            subject: `chunk:${passage.chunkId}`,
            decision: event === 'retrieval.candidate.generated' ? 'candidate' : 'selected',
            reasonCode: event === 'retrieval.candidate.generated' ? 'supplied' : 'selected',
            refs: { chunk_id: passage.chunkId, rank: i + 1, score: passage.score, stage: 'supplied' },
          });
        }
      }
    } else {
      const expanded = await expandQuery(llm, question);
      emit({
        event: 'retrieval.query.expanded',
        subject: `query:${queryHash}`,
        decision: 'candidate',
        reasonCode: expanded.length ? 'model' : 'fallback-empty',
        refs: {
          candidate_id: createHash('sha256').update(JSON.stringify(expanded)).digest('hex'),
          count: expanded.length,
          stage: 'expand',
        },
      });
      passages = searchCanon(db, projectId, question, {
        limit: opts.limit ?? 8,
        sourceId: opts.sourceId,
        expand: expanded,
        trace: traceBuffer,
      });
    }

    // The extracted index often answers the question outright, before any
    // passage is needed.
    index = lorebook.searchLore(db, projectId, question, 10, traceBuffer);
    indexText = formatLoreIndex(index);
    mode = opts.search?.length ? 'supplied-search' : passages.length ? 'fts' : indexText ? 'index-only' : 'fts';
    emit({
      event: 'retrieval.completed',
      subject: 'retrieval',
      decision: 'completed',
      reasonCode: passages.length ? 'ok' : indexText ? 'index-only' : 'empty',
      refs: { count: passages.length, stage: 'handoff' },
    });
    traceId = finishTrace(mode);
  } catch (error) {
    emit({
      event: 'retrieval.failed',
      subject: 'retrieval',
      decision: 'failed',
      reasonCode: 'error',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    finishTrace(mode, true);
    throw error;
  }

  if (!passages.length && !indexText) {
    return {
      answer:
        'No canon passages matched and the lore index has nothing on this. Either the material has ' +
        'not been imported or extracted, or this detail is not present in the source. ' +
        'Nothing can be confirmed here.',
      passages,
      grounded: false,
      ...(traceId ? { traceId } : {}),
    };
  }
  const res = await llm.chat({
    system: LORE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `QUESTION:\n${question}\n\n` +
          (indexText ? `EXTRACTED LORE INDEX (from the source material):\n${indexText}\n\n` : '') +
          (passages.length ? `RETRIEVED CANON PASSAGES:\n${formatPassages(passages)}\n\n` : '') +
          'Answer with citations. State clearly when evidence is missing.',
      },
    ],
    temperature: 0.1,
  });
  const guarded = enforceStatusTieGuard(db, projectId, question, res.text.trim(), passages);
  return {
    answer: guarded,
    passages,
    grounded: passages.length > 0 || indexText.length > 0,
    ...(traceId ? { traceId } : {}),
  };
}

/** Render the extracted lore index for a prompt or a report. */
export function formatLoreIndex(index: {
  entities: lorebook.CanonEntity[];
  relations: lorebook.CanonRelation[];
  facts: lorebook.CanonFact[];
  timeline: lorebook.CanonTimelineEntry[];
}): string {
  const parts: string[] = [];
  if (index.entities.length) {
    parts.push(
      'ENTITIES:\n' +
        index.entities
          .map((e) => {
            const bits = [
              e.summary,
              e.role ? `role: ${e.role}` : '',
              e.status ? `status: ${e.status}` : '',
            ].filter(Boolean);
            return `- [Lore: ${e.name}] (${e.kind}) ${bits.join('. ')}`;
          })
          .join('\n'),
    );
  }
  if (index.relations.length) {
    parts.push(
      'RELATIONSHIPS:\n' +
        index.relations.map((r) => `- ${r.fromName} → ${r.toName}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`).join('\n'),
    );
  }
  if (index.facts.length) {
    parts.push(
      'FACTS:\n' +
        index.facts.map((f) => `- ${f.statement}${f.certainty === 'inferred' ? ' [inferred]' : ''}`).join('\n'),
    );
  }
  if (index.timeline.length) {
    parts.push(
      'TIMELINE:\n' +
        index.timeline.map((t) => `- ${t.when ? `${t.when}: ` : ''}${t.title}${t.location ? ` @ ${t.location}` : ''}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}
