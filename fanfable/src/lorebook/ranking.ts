/**
 * Ranking retrieved passages against what the bank already knows.
 *
 * A caller supplies the passages it retrieved; this module only reorders them.
 * It never drops one, never adds one, and never asserts a relationship: the
 * score says "the bank has evidence touching this", not "this passage proves
 * it". Direction is read from the question's grammar, not from book vocabulary.
 *
 * Self-contained: no dependency on any other lorebook module.
 *
 * Moved out of lorebook.ts on 2026-11-13, logic unchanged.
 */
import { Db, fromJson, strList } from '../core/db.ts';
import { tokenize } from '../core/text.ts';
import { ANSWER_CUE_STOPWORDS } from '../core/vocab.ts';
import {
  NAME_DF_CAP,
  NAME_MIN_TOKEN,
  canonicalName,
  linkTokenMatch,
} from '../identity/names.ts';
import { kindHead, inverseKinds } from './kinds.ts';
import { proofTokens } from './roster.ts';

/**
 * One passage a caller already retrieved. Ranking only reorders these; it
 * never drops one and never adds a passage the caller did not supply.
 */
export interface BankRankCandidate {
  chunkId: number;
  text?: string;
  score?: number;
}

/**
 * Weights for the shared bank-aware ranker. Tune here, not at call sites.
 *
 * A candidate scores as:
 *   tier base + alias weight × alias hits + direction weight × lean
 *     + lexical weight × lexical score
 *
 * Tier dominates, so a keeper always outranks a parked row and both outrank
 * plain text. The smaller terms only order candidates inside a tier. Ranking
 * is a reorder, never a filter: a passage with no bank backing keeps its place
 * at the text tier, and a query that names nobody in the bank keeps its order.
 */
const BANK_RANK_TIER = { keeper: 4, attested: 3, parked: 2, mention: 1, text: 0 } as const;
const BANK_RANK_ALIAS_WEIGHT = 0.35;
const BANK_RANK_DIRECTION_WEIGHT = 0.35;
const BANK_RANK_LEXICAL_WEIGHT = 0.2;
/**
 * Coverage of the other ends of a query's banked ties. Their aliases widen
 * what a passage can match, but at a fraction of a directly named entity, and
 * capped so a crowded scene cannot outrank the name the query asked about.
 */
const BANK_RANK_LINKED_ALIAS_WEIGHT = 0.02;
const BANK_RANK_LINKED_ALIAS_CAP = 3;
/** How many bank-backed chunks one query may add to a candidate pool. */
const BANK_RANK_EXPAND_LIMIT = 40;

type BankProofTier = keyof typeof BANK_RANK_TIER;

export interface BankRelationRow {
  id: number;
  fromId: number;
  toId: number;
  kind: string;
  status: string;
  chunks: number[];
}

export interface BankQueryProfile {
  /** Query words that can name something (stopwords removed). */
  tokens: string[];
  /** The query as raw lowercase words, stopwords kept, for direction. */
  words: string[];
  /** Entities the query names directly, by name or alias. */
  matched: Set<number>;
  /** Entities one banked relation away from a matched entity. */
  linked: Set<number>;
  /** Bank tokens the query names, with exact (1) or fuzzy (0.5) weight. */
  matchTokens: Map<string, number>;
  /** Query tokens that linked to at least one bank token. */
  matchedQuery: Set<string>;
  /** Entities named by a query token that is not a relation-kind cue. */
  named: Set<number>;
  /** True when a correctly directed keeper already matches the exact kind. */
  exactCue: boolean;
  /** True when the query's content is only banked names (a name lookup). */
  bareName: boolean;
  /** True when the query asks for a relation (a cue matches a banked kind). */
  bankActive: boolean;
  /** Entity id -> first raw-word position of its name or alias. */
  order: Map<number, number>;
  /** Entity id -> identifying tokens of its name and aliases. */
  entityTokens: Map<number, Set<string>>;
  /** Relations touching a matched entity, with their proving chunks. */
  relations: BankRelationRow[];
}

/**
 * Map a query onto the bank: names and aliases first, then one relation hop.
 *
 * Nothing here reads outside the project, and nothing writes. A query that
 * names no banked entity yields an empty profile, which is what keeps a
 * nonsense question from surfacing a keeper.
 */
export function buildBankProfile(db: Db, projectId: number, query: string): BankQueryProfile {
  const clean = (query ?? '').replace(/[’']s\b/g, '');
  const tokens = tokenize(clean);
  const words = (query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const profile: BankQueryProfile = {
    tokens,
    words,
    matched: new Set(),
    linked: new Set(),
    matchTokens: new Map(),
    matchedQuery: new Set(),
    named: new Set(),
    exactCue: false,
    bareName: false,
    bankActive: false,
    order: new Map(),
    entityTokens: new Map(),
    relations: [],
  };
  if (!tokens.length) return profile;

  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const allTokens = new Map<number, Set<string>>();
  const frequency = new Map<string, number>();
  for (const row of rows) {
    const toks = proofTokens(row.name, 3);
    for (const a of strList(row.aliases)) for (const t of proofTokens(a, 3)) toks.add(t);
    allTokens.set(row.id, toks);
    for (const token of toks) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  for (const [id, toks] of allTokens) {
    profile.entityTokens.set(
      id,
      new Set(
        [...toks].filter(
          (token) =>
            token.length >= NAME_MIN_TOKEN &&
            (frequency.get(token) ?? 0) <= NAME_DF_CAP,
        ),
      ),
    );
  }

  // Map the query's distinctive tokens onto entities. A shared surname can
  // match several rows; that is the bank's existing ambiguity, and the ranker
  // stays soft rather than deciding the merge here. A long token one edit
  // away counts as the same name at half weight.
  for (const [id, toks] of profile.entityTokens) {
    for (const token of tokens) {
      if (token.length < NAME_MIN_TOKEN) continue;
      const hit = linkTokenMatch(toks, token);
      if (!hit) continue;
      profile.matched.add(id);
      profile.matchedQuery.add(token);
      const current = profile.matchTokens.get(hit.bankToken) ?? 0;
      if (hit.weight > current) profile.matchTokens.set(hit.bankToken, hit.weight);
    }
  }
  // A query made only of bank names/titles asks about the entity as a whole;
  // a query with other content words asks something more specific and needs a
  // matching relation kind before a banked tie can count as proof. "Where",
  // "when", "why" and "how" ask for an attribute even when the rest is a name.
  if (!profile.matched.size) return profile;
  const attributeQuestion = /\b(where|when|why|how)\b/.test((query ?? '').toLowerCase());
  profile.bareName =
    !attributeQuestion &&
    tokens.length > 0 &&
    tokens.every((token) => profile.matchedQuery.has(token) || (frequency.get(token) ?? 0) > 0);

  const relationRows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    review_status: string | null;
    source_refs: string;
  }>(
    `SELECT id, from_entity, to_entity, kind, review_status, source_refs
     FROM canon_relation WHERE project_id = ? ORDER BY id`,
    projectId,
  );
  for (const row of relationRows) {
    if (!profile.matched.has(row.from_entity) && !profile.matched.has(row.to_entity)) continue;
    profile.linked.add(row.from_entity);
    profile.linked.add(row.to_entity);
    const chunks: number[] = [];
    for (const ref of fromJson<{ chunk?: unknown }[]>(row.source_refs, [])) {
      const chunk = Number(ref?.chunk);
      if (Number.isFinite(chunk)) chunks.push(chunk);
    }
    profile.relations.push({
      id: row.id,
      fromId: row.from_entity,
      toId: row.to_entity,
      kind: row.kind,
      status: row.review_status ?? 'accepted',
      chunks,
    });
  }

  // A relation kind's words are cues, not names. The set is built once so
  // every path agrees which query words are touch tokens.
  const cueWords = new Set<string>();
  for (const row of relationRows) {
    if (canonicalName(row.kind) === 'appears with') continue;
    for (const token of answerKindTokens(row.kind)) cueWords.add(token);
    for (const kind of inverseKinds(row.kind)) {
      for (const token of answerKindTokens(kind)) cueWords.add(token);
    }
  }
  profile.named.clear();
  for (const [id, toks] of profile.entityTokens) {
    for (const token of profile.tokens) {
      if (cueWords.has(token)) continue;
      if (linkTokenMatch(toks, token)) {
        profile.named.add(id);
        break;
      }
    }
  }

  // Raw-word position of each named entity, skipping cue words first so a
  // title word cannot stand in for the person's actual name.
  profile.order.clear();
  for (const id of profile.named) {
    const toks = profile.entityTokens.get(id);
    if (!toks) continue;
    let fallback = -1;
    for (let i = 0; i < words.length; i++) {
      const word = (words[i] ?? '').replace(/[’']s$/, '');
      if (word.length < NAME_MIN_TOKEN) continue;
      if (!linkTokenMatch(toks, word)) continue;
      if (fallback < 0) fallback = i;
      if (!cueWords.has(word)) {
        profile.order.set(id, i);
        break;
      }
    }
    if (!profile.order.has(id) && fallback >= 0) profile.order.set(id, fallback);
  }

  profile.exactCue = profile.relations.some((relation) => {
    if (relationTier(relation) !== 'keeper') return false;
    if (!profile.named.has(relation.fromId) && !profile.named.has(relation.toId)) return false;
    const hits = answerKindHits(profile, relation.kind);
    if (hits === 0) return false;
    return answerRelationLean(profile, relation, { kind: relation.kind, inverse: false, hits }) >= 0;
  });

  profile.bankActive =
    profile.bareName ||
    profile.relations.some((relation) => {
      const shared = cueDirectionTouch(profile, relation);
      return shared.touches && shared.cueHits > 0;
    });
  return profile;
}

/**
 * What a relation is worth as proof.
 *
 * A keeper is confirmed (user or accepted) and states a tie. Attested sits
 * below keeper: passage-proof and citable with its passage scope, but not
 * sentence-proven. `appears_with` is a mention: two names in one passage,
 * coverage and never evidence. Everything else is parked. Mirrors the answer
 * rule: only keeper-grade ties may be stated outright; attested ties are
 * cited with their passage scope shown.
 */
export function relationTier(relation: BankRelationRow): BankProofTier {
  const kind = canonicalName(relation.kind);
  if (kind === 'appears with') return 'mention';
  if (relation.status === 'accepted' || relation.status === 'user_confirmed') return 'keeper';
  if (relation.status === 'attested') return 'attested';
  return 'parked';
}

/** Kind words that can cue a relation; "of" and articles never count. */
function answerKindTokens(kind: string): Set<string> {
  return new Set(
    tokenize(kindHead(kind)).filter(
      (token) => token.length >= 3 && !ANSWER_CUE_STOPWORDS.has(token),
    ),
  );
}

function answerKindHits(profile: BankQueryProfile, kind: string): number {
  const tokens = answerKindTokens(kind);
  const query = new Set(profile.tokens);
  return [...tokens].filter((token) => query.has(token)).length;
}

interface AnswerCue {
  kind: string;
  inverse: boolean;
  hits: number;
}

/**
 * The kind the question actually names: the row's own kind first, then a
 * universal inverse. "master of" therefore reaches an apprentice-of row.
 */
function answerCue(profile: BankQueryProfile, relation: BankRelationRow): AnswerCue | undefined {
  const actualHits = answerKindHits(profile, relation.kind);
  if (actualHits > 0) return { kind: relation.kind, inverse: false, hits: actualHits };
  // A correctly directed keeper of the asked kind wins over an inverse
  // reading. Inverse kinds are the fallback, not a second equal answer.
  if (profile.exactCue) return undefined;
  let best: AnswerCue | undefined;
  for (const kind of inverseKinds(relation.kind)) {
    const hits = answerKindHits(profile, kind);
    if (hits > (best?.hits ?? 0)) best = { kind, inverse: true, hits };
  }
  return best;
}

/**
 * Existing direction lean, with the arrow flipped when the question used the
 * inverse kind. Still only reorders among keepers that touch a named entity.
 */
function answerRelationLean(
  profile: BankQueryProfile,
  relation: BankRelationRow,
  cue: AnswerCue,
): number {
  const kindTokens = answerKindTokens(cue.kind);
  let lean = Math.min(2, cue.hits);
  const fromMatched = profile.named.has(relation.fromId);
  const toMatched = profile.named.has(relation.toId);
  if (fromMatched && toMatched) {
    const fromOrder = profile.order.get(relation.fromId);
    const toOrder = profile.order.get(relation.toId);
    if (fromOrder !== undefined && toOrder !== undefined) {
      const orderLean = fromOrder < toOrder ? 1 : -1;
      lean += cue.inverse ? -orderLean : orderLean;
    }
    return lean;
  }
  const matchedId = fromMatched ? relation.fromId : toMatched ? relation.toId : undefined;
  if (matchedId === undefined) return lean;
  const side = querySideFor(profile, matchedId, kindTokens);
  if (!side) return lean;
  const agrees = cue.inverse
    ? side === 'from'
      ? matchedId === relation.toId
      : matchedId === relation.fromId
    : side === 'from'
      ? matchedId === relation.fromId
      : matchedId === relation.toId;
  return lean + (agrees ? 1 : -2);
}

/**
 * The shared cue/direction/touch decision.
 *
 * Touch means an endpoint is named by a query token that is not a relation
 * cue. Cue hits use the kind head (particles stripped), the row's own kind
 * first and the existing inverse pairs second. Direction uses the same grammar
 * rules for both paths.
 *
 * `allowBareName` is only for the ranker's focus-name path: a query made only
 * of names has no cue, but the ranker may still surface keeper evidence for a
 * scene. The bank-answer line leaves it false because it must abstain when no
 * relation was asked.
 */
interface CueDirectionTouch {
  touches: boolean;
  cueHits: number;
  inverse: boolean;
  lean: number;
  /** The ranker may treat a bare-name query as evidence; the answer line may not. */
  bare: boolean;
}

export function cueDirectionTouch(
  profile: BankQueryProfile,
  relation: BankRelationRow,
  allowBareName = false,
): CueDirectionTouch {
  const touches = profile.named.has(relation.fromId) || profile.named.has(relation.toId);
  if (!touches) return { touches: false, cueHits: 0, inverse: false, lean: 0, bare: false };
  const cue = answerCue(profile, relation);
  if (!cue) {
    return {
      touches: true,
      cueHits: 0,
      inverse: false,
      lean: 0,
      bare: allowBareName && profile.bareName,
    };
  }
  return {
    touches: true,
    cueHits: cue.hits,
    inverse: cue.inverse,
    lean: answerRelationLean(profile, relation, cue),
    bare: false,
  };
}

/**
 * Which end of a "<role> of" relation the query puts a named entity on.
 *
 * Read from the grammar, not from book words:
 *   "X's role"            → X is the one the role is to (`to`)
 *   "X role" (no article) → same reading, apostrophe omitted
 *   "X the role of"       → X has the role (`from`)
 *   "the role of X"       → X is the one the role is to (`to`)
 * A query that cannot be read stays neutral; direction only reorders.
 */
function querySideFor(
  profile: BankQueryProfile,
  entityId: number,
  kindTokens: Set<string>,
): 'from' | 'to' | undefined {
  const position = profile.order.get(entityId);
  if (position === undefined) return undefined;
  const word = profile.words[position] ?? '';
  if (/[’']s$/.test(word)) return 'to';
  const cuePosition = profile.words.findIndex((entry) => kindTokens.has(entry));
  if (cuePosition < 0) return undefined;
  if (position > cuePosition) return 'to';
  const between = profile.words.slice(position + 1, cuePosition);
  return between.includes('the') ? 'from' : 'to';
}

/**
 * How many of the query's names a passage actually carries.
 *
 * A token the query itself used to name a bank entity counts in full when the
 * spelling is exact and at half weight when it is one typo away. The other
 * ends of those entities' banked ties are expanded to their full alias token
 * sets too, but at a fraction and capped: a page crowded with the queried
 * person's associates cannot outrank the page naming the person.
 */
function aliasHits(profile: BankQueryProfile, text: string): number {
  if (!text || !profile.matchTokens.size) return 0;
  const words = new Set(tokenize(text));
  let hits = 0;
  for (const [token, weight] of profile.matchTokens) {
    if (words.has(token)) hits += weight;
  }
  let linked = 0;
  for (const id of profile.linked) {
    if (profile.matched.has(id)) continue;
    const toks = profile.entityTokens.get(id);
    if (!toks) continue;
    if ([...toks].some((token) => words.has(token))) linked++;
  }
  return hits + Math.min(linked, BANK_RANK_LINKED_ALIAS_CAP) * BANK_RANK_LINKED_ALIAS_WEIGHT;
}

/** The best proof a passage carries, and the direction lean of that proof. */
function proofFor(profile: BankQueryProfile, chunkId: number): { tier: BankProofTier; lean: number } {
  let tier: BankProofTier = 'text';
  let lean = 0;
  for (const relation of profile.relations) {
    if (!relation.chunks.includes(chunkId)) continue;
    const shared = cueDirectionTouch(profile, relation, true);
    if (!shared.touches) continue;
    if (shared.cueHits === 0 && !shared.bare) continue;
    if (shared.lean < 0) continue;
    const next = relationTier(relation);
    const nextLean = shared.lean;
    if (
      BANK_RANK_TIER[next] > BANK_RANK_TIER[tier] ||
      (next === tier && nextLean > lean)
    ) {
      tier = next;
      lean = nextLean;
    }
  }
  return { tier, lean };
}

/**
 * Reorder retrieved passages by what the bank can prove about the query.
 *
 * Universal by construction: it knows only names, aliases, relation kinds,
 * review status and source chunks. It carries no book terms and writes
 * nothing. Callers keep their own candidate pool; this only sorts it.
 */
export function rankWithBank<T extends BankRankCandidate>(
  db: Db,
  projectId: number,
  query: string,
  candidates: T[],
  providedProfile?: BankQueryProfile,
): T[] {
  if (candidates.length < 2) return candidates.slice();
  const profile = providedProfile ?? buildBankProfile(db, projectId, query);
  if (!profile.matched.size || !profile.bankActive) return candidates.slice();

  const textCache = new Map<number, string>();
  const scored = candidates.map((candidate, index) => {
    let text = candidate.text ?? '';
    if (!text) {
      text = textCache.get(candidate.chunkId) ?? '';
      if (!text) {
        text =
          db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', candidate.chunkId)?.text ?? '';
        textCache.set(candidate.chunkId, text);
      }
    }
    const proof = proofFor(profile, candidate.chunkId);
    const lexical = Number.isFinite(candidate.score)
      ? Math.max(0, Math.min(1, Number(candidate.score)))
      : 0;
    const score =
      BANK_RANK_TIER[proof.tier] +
      BANK_RANK_ALIAS_WEIGHT * aliasHits(profile, text) +
      BANK_RANK_DIRECTION_WEIGHT * proof.lean +
      BANK_RANK_LEXICAL_WEIGHT * lexical;
    return { candidate, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.candidate);
}

/**
 * Chunk ids the bank can vouch for on this query.
 *
 * Only relations that touch an entity the query names are returned, so a
 * nonsense query adds nothing. Ordered by proof tier, then cue agreement,
 * then relation id for determinism. Callers fetch the text; nothing is
 * written and no relation is changed.
 */
export function bankLinkedChunkIds(
  db: Db,
  projectId: number,
  query: string,
  limit = BANK_RANK_EXPAND_LIMIT,
  providedProfile?: BankQueryProfile,
): number[] {
  const profile = providedProfile ?? buildBankProfile(db, projectId, query);
  if (!profile.matched.size || !profile.bankActive) return [];
  const best = new Map<number, { tier: number; lean: number; relation: number }>();
  for (const relation of profile.relations) {
    const shared = cueDirectionTouch(profile, relation, true);
    if (!shared.touches) continue;
    if (shared.cueHits === 0 && !shared.bare) continue;
    if (shared.lean < 0) continue;
    const tier = BANK_RANK_TIER[relationTier(relation)];
    const lean = shared.lean;
    for (const chunk of relation.chunks) {
      const current = best.get(chunk);
      if (
        !current ||
        tier > current.tier ||
        (tier === current.tier && lean > current.lean) ||
        (tier === current.tier && lean === current.lean && relation.id < current.relation)
      ) {
        best.set(chunk, { tier, lean, relation: relation.id });
      }
    }
  }
  return [...best.entries()]
    .sort(
      (a, b) =>
        b[1].tier - a[1].tier ||
        b[1].lean - a[1].lean ||
        a[1].relation - b[1].relation ||
        a[0] - b[0],
    )
    .slice(0, limit)
    .map(([chunkId]) => chunkId);
}