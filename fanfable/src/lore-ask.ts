/**
 * Canon answers.
 *
 * Moved mechanically from lore.ts; imports only, no logic change.
 */
import { Db } from './db.ts';
import { extractJson, toStringArray } from './json.ts';
import type { LlmClient } from './llm.ts';
import { nameMentionedExact } from './names.ts';
import * as lorebook from './lorebook.ts';
import { expandQuery, searchCanon } from './lore-search.ts';
import type { Passage } from './lore.ts';

/* ------------------------------------------------------------- lore answers */

export interface LoreAnswer {
  answer: string;
  passages: Passage[];
  /** True when the model had enough evidence to ground its answer. */
  grounded: boolean;
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
): { ids: number[]; variants: string[] } {
  const q = query.toLowerCase();
  const matched = entities.filter(
    (e) => e.name.toLowerCase() === q || e.aliases.some((al) => al.toLowerCase() === q),
  );
  const pool = matched.length ? matched : [];
  const ids = pool.map((e) => e.id);
  const variants = [q];
  for (const e of pool) {
    variants.push(e.name.toLowerCase());
    for (const al of e.aliases) variants.push(al.toLowerCase());
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
  head: string;
  direction: 'a-to-b' | 'b-to-a' | 'unknown';
  /** A claim naming only one side of the asked pair. */
  offPair?: boolean;
}

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
  if (before) {
    // "A is B's sister": B owns the role, A is the subject.
    if (before === 'b') return 'a-to-b';
    return 'b-to-a';
  }
  if (words[headIndex + 1] === 'of') {
    const object = owner(words[headIndex + 2] ?? '');
    if (object === 'b') return 'a-to-b';
    if (object === 'a') return 'b-to-a';
  }
  return 'unknown';
}

function assertedClaims(
  draft: string,
  pair: { a: string; b: string },
  sideAVariants: string[],
  sideBVariants: string[],
): AssertedClaim[] {
  const sideATokens = nameTokensOf(sideAVariants);
  const sideBTokens = nameTokensOf(sideBVariants);
  const claims = new Map<string, AssertedClaim>();
  const sentences = draft.split(/[.!?\n]+/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/\b(no|not|never|cannot|can't|does not|do not|isn't|wasn't|without|unsupported|unconfirmed|missing|unknown)\b/i.test(sentence)) {
      continue;
    }
    const lower = sentence.toLowerCase();
    const namesA = sideAVariants.some((variant) => lower.includes(variant.toLowerCase()));
    const namesB = sideBVariants.some((variant) => lower.includes(variant.toLowerCase()));
    if (!namesA || !namesB) continue;
    for (const head of CLOSED_HEADS) {
      const forms = [head, PLURAL_HEADS[head]].filter(Boolean) as string[];
      const present = forms.some((form) => new RegExp(`\\b${form}\\b`, 'i').test(sentence));
      if (!present) continue;
      const direction = claimDirection(sentence, head, sideATokens, sideBTokens);
      claims.set(`${head}|${direction}`, { head, direction });
    }
  }
  if (!claims.size) {
    // No sentence names both sides, but a closed relationship phrase is still
    // asserted with one side: it cannot prove anything about the asked pair.
    for (const sentence of sentences) {
      if (/\b(no|not|never|cannot|can't|does not|do not|isn't|wasn't|without|unsupported|unconfirmed|missing|unknown)\b/i.test(sentence)) {
        continue;
      }
      const lower = sentence.toLowerCase();
      const oneSide = sideAVariants.some((variant) => lower.includes(variant.toLowerCase())) ||
        sideBVariants.some((variant) => lower.includes(variant.toLowerCase()));
      if (!oneSide) continue;
      for (const head of CLOSED_HEADS) {
        const forms = [head, PLURAL_HEADS[head]].filter(Boolean) as string[];
        if (!forms.some((form) => new RegExp(`\\b${form}\\b`, 'i').test(sentence))) continue;
        claims.set(`${head}|off`, { head, direction: 'unknown', offPair: true });
        break;
      }
      if (claims.size) break;
    }
  }
  return [...claims.values()];
}

function keeperSupportsClaim(
  db: Db,
  projectId: number,
  pair: { a: string; b: string },
  sideA: { ids: number[] },
  sideB: { ids: number[] },
  claim: AssertedClaim,
): boolean {
  const keepers = lorebook.lookupKeeperPair(db, projectId, pair.a, pair.b);
  const rowDirection = (fromId: number, toId: number): 'a-to-b' | 'b-to-a' | 'unknown' => {
    if (sideA.ids.includes(fromId) && sideB.ids.includes(toId)) return 'a-to-b';
    if (sideB.ids.includes(fromId) && sideA.ids.includes(toId)) return 'b-to-a';
    return 'unknown';
  };
  if (claim.offPair) return false;
  return keepers.some((row) => {
    const rowHead = relationHead(row.kind);
    const inverse = INVERSE_HEADS.get(claim.head)?.has(rowHead) ?? false;
    if (rowHead !== claim.head && !inverse) return false;
    const direction = rowDirection(row.fromId, row.toId);
    if (claim.direction === 'unknown' || direction === 'unknown') return true;
    return inverse ? direction !== claim.direction : direction === claim.direction;
  });
}

function claimLabel(pair: { a: string; b: string }, claim: AssertedClaim): string {
  if (claim.direction === 'b-to-a') return `${pair.b} ${claim.head} ${pair.a}`;
  if (claim.direction === 'a-to-b') return `${pair.a} ${claim.head} ${pair.b}`;
  return `${pair.a} / ${pair.b} ${claim.head}`;
}

/**
 * Verify the relationships an answer actually asserts for the asked pair.
 *
 * Every closed relationship phrase is a claim; only a keeper of that kind (or
 * its closed inverse, in the opposite direction) supports it. All supported
 * leaves the draft untouched; none supported abstains; mixed keeps the answer
 * with one correction line naming what the bank does not hold.
 */
export function enforceStatusTieGuard(
  db: Db,
  projectId: number,
  question: string,
  draft: string,
  _passages: Passage[],
): string {
  // Test-only A/B switch. Unset or any value other than '1' keeps the guard.
  if (process.env.FANFABLE_NO_GUARD === '1') return draft;
  const pair = parsePairQuestion(question);
  if (!pair) return draft;
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
  const sideA = entityVariantsFor(entities, pair.a);
  const sideB = entityVariantsFor(entities, pair.b);
  const claims = assertedClaims(draft, pair, sideA.variants, sideB.variants);
  if (!claims.length) return draft;
  const supported = claims.filter((claim) => keeperSupportsClaim(db, projectId, pair, sideA, sideB, claim));
  const unsupported = claims.filter((claim) => !supported.includes(claim));
  if (!unsupported.length) return draft;
  const abstain =
    `### Status of ${pair.a} to ${pair.b}\n\n` +
    `Tie not established. The lore index banks no keeper for the claimed relationship between ${pair.a} and ${pair.b}.\n\n` +
    `---\nOriginal draft (uncorrected, kept for audit):\n${draft}`;
  if (!supported.length) return abstain;
  const labels = [...new Set(unsupported.map((claim) => claimLabel(pair, claim)))];
  return `Correction: Bank holds no keeper for: ${labels.join('; ')}.\n\n${draft}`;
}

export async function answerLoreQuestion(
  db: Db,
  llm: LlmClient,
  projectId: number,
  question: string,
  opts: { limit?: number; sourceId?: number; search?: Passage[] } = {},
): Promise<LoreAnswer> {
  let passages = opts.search ?? [];
  if (passages.length) {
    // Callers may hand in their own candidate pool; rank it by the same bank
    // signal the keyword path uses, without changing the pool.
    passages = lorebook.rankWithBank(db, projectId, question, passages);
  }
  if (!passages.length) {
    const expanded = await expandQuery(llm, question);
    passages = searchCanon(db, projectId, question, { limit: opts.limit ?? 8, sourceId: opts.sourceId, expand: expanded });
  }

  // The extracted index often answers the question outright, before any
  // passage is needed.
  const index = lorebook.searchLore(db, projectId, question, 10);
  const indexText = formatLoreIndex(index);

  if (!passages.length && !indexText) {
    return {
      answer:
        'No canon passages matched and the lore index has nothing on this. Either the material has ' +
        'not been imported or extracted, or this detail is not present in the source. ' +
        'Nothing can be confirmed here.',
      passages,
      grounded: false,
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
