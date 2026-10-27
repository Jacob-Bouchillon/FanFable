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

/**
 * Downgrade an unsupported CONFIRMED tie to an explicit abstain. Returns the
 * original answer when the question is not a status-of pair, when the bank
 * holds an accepted tie, when one passage names both sides, or when the
 * draft never claims CONFIRMED. Otherwise the tie is not established: the
 * original draft is kept below for audit, never silently dropped.
 */
function enforceStatusTieGuard(
  db: Db,
  projectId: number,
  question: string,
  draft: string,
  passages: Passage[],
): string {
  const pair = lorebook.parseStatusPair(question);
  if (!pair) return draft;
  if (!/\bconfirmed\b/i.test(draft)) return draft;
  let entities: { id: number; name: string; aliases: string[] }[] = [];
  try {
    entities = lorebook
      .listEntities(db, projectId)
      .map((e) => ({ id: e.id, name: e.name, aliases: e.aliases ?? [] }));
  } catch {
    return draft;
  }
  const sideA = entityVariantsFor(entities, pair.a);
  const sideB = entityVariantsFor(entities, pair.b);
  // Same-row identity: a tie to self is never confirmed.
  if (sideA.ids.length && sideA.ids.some((id) => sideB.ids.includes(id))) {
    // Fall through to the abstain below.
  } else if (lorebook.lookupKeeperPair(db, projectId, pair.a, pair.b).length > 0) {
    return draft;
  } else if (passageNamesBoth(passages, sideA.variants, sideB.variants)) {
    return draft;
  }
  return (
    `### Status of ${pair.a} to ${pair.b}\n\n` +
    `Tie not established. The lore index banks no tie between ${pair.a} and ${pair.b}, ` +
    `and no single retrieved passage names both and states the tie. Nothing here is confirmed.\n\n` +
    `---\nOriginal draft (uncorrected, kept for audit):\n${draft}`
  );
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
