/**
 * Missing-lore diagnostics and targeted enrichment.
 *
 * A book is never fully captured by one extraction pass. A character who
 * appears in two hundred passages may end up with one relation, because the
 * passages that mentioned their family never happened to be in the same
 * window as the passage that named them.
 *
 * Two things live here:
 *
 *   diagnose()  — looks for the gaps: entities with no relations, pairs whose
 *                 relations disagree, and passages that plainly state a
 *                 relationship the graph does not have. It reports the gap and
 *                 the passage that hints at it. It never invents the relation.
 *
 *   enrich()    — re-reads the passages that mention one entity and extracts
 *                 what is missing about it, so a single under-described
 *                 character can be fixed without re-indexing the book.
 */
import { Db, nowIso, strList, toJson } from './db.ts';
import { extractJson } from './json.ts';
import type { LlmClient } from './llm.ts';
import * as lorebook from './lorebook.ts';
import { truncate } from './text.ts';

/* ------------------------------------------------------------- diagnostics */

export type GapKind =
  | 'isolated-entity'
  | 'thin-entity'
  | 'contradictory-relation'
  | 'missing-relation'
  | 'unsupported-claim';

export interface LoreGap {
  kind: GapKind;
  severity: 'warning' | 'note';
  subject: string;
  message: string;
  /** The passage that shows the gap, so the author can judge it. */
  evidence: string;
  chunkId?: number;
  locator?: string;
  /** What could be done about it. */
  suggestion: string;
}

/**
 * Words that state a relationship, and the kind of relationship they state.
 * Used to notice a relationship the source says plainly and the graph is
 * missing.
 */
const RELATION_CUES: { re: RegExp; kind: string }[] = [
  { re: /\b(?:his|her|their) (?:son|daughter)\b/i, kind: 'child of' },
  { re: /\b(?:son|daughter) of\b/i, kind: 'child of' },
  { re: /\b(?:brother|sister|sibling) of\b/i, kind: 'sibling of' },
  { re: /\b(?:mother|father) of\b/i, kind: 'child of' },
  { re: /\b(?:uncle|aunt) of\b/i, kind: 'relative of' },
  { re: /\b(?:cousin|nephew|niece) of\b/i, kind: 'relative of' },
  { re: /\b(?:wife|husband|spouse) of\b/i, kind: 'married to' },
  { re: /\bhead(?:master|mistress) of\b/i, kind: 'leads' },
  { re: /\bstudent of\b/i, kind: 'student of' },
  { re: /\bmember of\b/i, kind: 'member of' },
  { re: /\bworks? for\b/i, kind: 'works for' },
  { re: /\bbelongs? to\b/i, kind: 'member of' },
  { re: /\bfriend of\b/i, kind: 'friend of' },
  { re: /\benemy of\b/i, kind: 'enemy of' },
  { re: /\bmarried to\b/i, kind: 'married to' },
];

/** The kinds that describe the same relationship, so a near-match is a hit. */
const RELATED_KINDS: Record<string, string[]> = {
  'child of': ['son of', 'daughter of', 'mother of', 'father of', 'parent of', 'sibling of', 'child'],
  'sibling of': ['brother of', 'sister of', 'sibling of', 'brother', 'sister'],
  'relative of': ['uncle of', 'aunt of', 'cousin of', 'nephew of', 'niece of', 'relative of'],
  'married to': ['wife of', 'husband of', 'spouse of', 'married to', 'wife', 'husband'],
  'leads': ['headmaster of', 'headmistress of', 'leads', 'works for'],
  'student of': ['student of', 'studies at', 'attends'],
  'member of': ['member of', 'belongs to', 'part of', 'works for'],
  'friend of': ['friend of', 'friends with', 'best friend of'],
  'enemy of': ['enemy of', 'hates', 'opponent of'],
};

function sameRelation(a: string, b: string): boolean {
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const group = RELATED_KINDS[na] ?? RELATED_KINDS[nb];
  if (!group) return false;
  const other = na === group[0] ? nb : na;
  return group.some((g) => other.includes(g) || g.includes(other));
}

interface EntityRow {
  id: number;
  kind: string;
  name: string;
  aliases: string;
  summary: string;
  role: string;
  status: string;
  mentions: number;
}

/**
 * Find the gaps in the lore index.
 *
 * Nothing here adds a claim to the graph: it reports what looks missing and
 * where to look for it.
 */
export function diagnose(db: Db, projectId: number, opts: { limit?: number } = {}): LoreGap[] {
  const gaps: LoreGap[] = [];
  const limit = opts.limit ?? 25;

  const entities = db.all<EntityRow>(
    'SELECT id, kind, name, aliases, summary, role, status, mentions FROM canon_entity WHERE project_id = ? ORDER BY mentions DESC, name',
    projectId,
  );
  if (!entities.length) return gaps;

  const relations = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    source_refs: string;
  }>('SELECT * FROM canon_relation WHERE project_id = ?', projectId);

  const byEntity = new Map<number, typeof relations>();
  for (const r of relations) {
    byEntity.set(r.from_entity, [...(byEntity.get(r.from_entity) ?? []), r]);
    byEntity.set(r.to_entity, [...(byEntity.get(r.to_entity) ?? []), r]);
  }

  const names = new Map<number, string>();
  for (const e of entities) names.set(e.id, e.name);

  // 1. Entities that are mentioned often but have no relations at all.
  for (const e of entities) {
    if (e.kind !== 'character') continue;
    const rels = byEntity.get(e.id) ?? [];
    if (rels.length === 0) {
      gaps.push({
        kind: 'isolated-entity',
        severity: 'warning',
        subject: e.name,
        message: `${e.name} is in the index but has no relationships recorded.`,
        evidence: e.summary || 'no summary recorded',
        suggestion: 'Run "fanforge lore enrich ' + e.name + '" to read the passages that mention them again.',
      });
    } else if (e.mentions > 3 && rels.length === 1) {
      gaps.push({
        kind: 'thin-entity',
        severity: 'note',
        subject: e.name,
        message: `${e.name} appears in ${e.mentions} passages but has only one relationship recorded.`,
        evidence: rels[0].description || rels[0].kind,
        suggestion: 'Check the passages that mention them; a character with one relation in a long book is usually under-extracted.',
      });
    }
  }

  // 2. Two relations between the same pair that disagree.
  const pairs = new Map<string, typeof relations>();
  for (const r of relations) {
    const key = [r.from_entity, r.to_entity].sort((a, b) => a - b).join(':');
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
  }
  for (const [key, pair] of pairs) {
    if (pair.length < 2) continue;
    const [a, b] = key.split(':').map(Number);
    for (let i = 0; i < pair.length; i++) {
      for (let j = i + 1; j < pair.length; j++) {
        if (sameRelation(pair[i].kind, pair[j].kind)) continue;
        gaps.push({
          kind: 'contradictory-relation',
          severity: 'warning',
          subject: `${names.get(a)} / ${names.get(b)}`,
          message: `${names.get(a)} and ${names.get(b)} are recorded as "${pair[i].kind}" and "${pair[j].kind}".`,
          evidence: `${pair[i].description || '—'} / ${pair[j].description || '—'}`,
          suggestion: 'Check the source and keep the one that is right.',
        });
      }
    }
  }

  // 3. A relationship the source states plainly and the graph does not have.
  //    This is the important one: it never adds the relation, it reports it.
  const passages = db.all<{ id: number; locator: string; text: string }>(
    'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    projectId,
  );
  const relationIndex = new Map<string, Set<string>>();
  for (const r of relations) {
    const key = [r.from_entity, r.to_entity].sort((a, b) => a - b).join(':');
    relationIndex.set(key, relationIndex.get(key) ?? new Set());
    relationIndex.get(key)!.add(r.kind.toLowerCase());
  }

  const nameByLower = new Map<string, EntityRow>();
  for (const e of entities) {
    nameByLower.set(e.name.toLowerCase(), e);
    for (const a of strList(e.aliases)) nameByLower.set(a.toLowerCase(), e);
  }

  const seenGaps = new Set<string>();
  outer: for (const passage of passages) {
    const lower = passage.text.toLowerCase();
    for (const entity of entities) {
      if (entity.kind !== 'character') continue;
      const names = [entity.name, ...strList(entity.aliases)];
      if (!names.some((n) => lower.includes(n.toLowerCase()))) continue;
      for (const cue of RELATION_CUES) {
        const match = cue.re.exec(passage.text);
        if (!match) continue;
        // Who is the other person? The nearest other name in the sentence.
        const sentence = sentenceAround(passage.text, match.index ?? 0);
        const others = entities.filter(
          (e) =>
            e.id !== entity.id &&
            [e.name, ...strList(e.aliases)].some((n) => sentence.toLowerCase().includes(n.toLowerCase())),
        );
        for (const other of others) {
          const key = [entity.id, other.id].sort((a, b) => a - b).join(':');
          const kinds = relationIndex.get(key);
          if (!kinds) continue;
          if ([...kinds].some((k) => sameRelation(k, cue.kind))) continue;
          const dedupe = `${key}:${cue.kind}`;
          if (seenGaps.has(dedupe)) continue;
          seenGaps.add(dedupe);
          gaps.push({
            kind: 'missing-relation',
            severity: 'note',
            subject: `${entity.name} / ${other.name}`,
            message: `The source says "${cue.kind}" between ${entity.name} and ${other.name}, but the graph records only ${[...kinds].join(', ')}.`,
            evidence: truncate(sentence.trim(), 200),
            chunkId: passage.id,
            locator: passage.locator,
            suggestion: `Check the passage, then "fanforge lore enrich ${entity.name}" or correct the relation by hand.`,
          });
          if (gaps.length >= limit * 4) break outer;
        }
      }
    }
  }

  return gaps.slice(0, limit);
}

/** The sentence a match sits in. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index - 1) + 1);
  const end = text.indexOf('.', index);
  return text.slice(start, end > 0 ? end + 1 : start + 240);
}

/* -------------------------------------------------------------- enrichment */

const ENRICH_SYSTEM = `You are re-reading passages about one person or thing, because the first pass missed some of what the source says about them.

Reply with JSON only:
{
  "relations": [{"other":"Name","kind":"one short phrase, such as 'sister of'","description":"one sentence","quote":"an exact phrase from the passage"}],
  "facts": [{"topic":"subject of the fact","statement":"what the source establishes","quote":"an exact phrase from the passage"}],
  "knowledge": [{"other":"Name","fact":"what this person knows or believes","certainty":"knows|believes|suspects|misunderstands"}]
}

Rules:
- Only record what the passages state. Do not infer, and do not use general knowledge about the book.
- "other" must be a name that appears in the passages.
- The direction matters: if A is the sister of B, the relation is from A to B.
- "quote" must be an exact phrase from the passage.
- If the passages say nothing new, return empty arrays.`;

/**
 * Re-read the passages that mention an entity and record what is missing.
 *
 * Only relations and facts that are not already recorded are added, so
 * running it twice does not duplicate anything.
 */
export async function enrichEntity(
  db: Db,
  llm: LlmClient,
  projectId: number,
  name: string,
  opts: { sourceId?: number; maxPassages?: number; onProgress?: (m: string) => void } = {},
): Promise<{ relations: number; facts: number; knowledge: number; passages: number }> {
  const entity = lorebook.findEntity(db, projectId, name);
  if (!entity) throw new Error(`"${name}" is not in the lore index`);
  const names = [entity.name, ...entity.aliases];

  // The passages that mention them.
  const params: unknown[] = [projectId];
  let sql = `SELECT c.id AS id, c.seq AS seq, c.locator AS locator, c.text AS text, s.title AS source_title
             FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.project_id = ?`;
  if (opts.sourceId) {
    sql += ' AND c.source_id = ?';
    params.push(opts.sourceId);
  }
  const all = db.all<{
    id: number;
    seq: number;
    locator: string;
    text: string;
    source_title: string;
  }>(sql, ...params);
  const passages = all
    .filter((p) => names.some((n) => p.text.toLowerCase().includes(n.toLowerCase())))
    .slice(0, opts.maxPassages ?? 12);
  if (!passages.length) return { relations: 0, facts: 0, knowledge: 0, passages: 0 };

  const existing = db.all<{ from_entity: number; to_entity: number; kind: string }>(
    'SELECT from_entity, to_entity, kind FROM canon_relation WHERE project_id = ?',
    projectId,
  );
  const have = new Set(existing.map((r) => `${r.from_entity}:${r.to_entity}:${r.kind.toLowerCase()}`));

  let relations = 0;
  let facts = 0;
  let knowledge = 0;

  // Read in windows so the model is not asked to cover everything at once.
  const windowSize = 4;
  for (let start = 0; start < passages.length; start += windowSize) {
    const window = passages.slice(start, start + windowSize);
    opts.onProgress?.(`reading passages ${start + 1}-${start + window.length} of ${passages.length}`);

    let parsed: Record<string, unknown>;
    try {
      const res = await llm.chat({
        system: ENRICH_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `THE SUBJECT: ${entity.name}\n\nPASSAGES:\n` +
              window
                .map((p) => `--- ${p.locator}\n${truncate(p.text, 1200)}`)
                .join('\n\n'),
          },
        ],
        temperature: 0.1,
        maxTokens: 1600,
      });
      parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
    } catch {
      continue;
    }

    const asArray = (v: unknown): Record<string, unknown>[] =>
      Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

    for (const rel of asArray(parsed.relations)) {
      const otherName = String(rel.other ?? '').trim();
      const kind = String(rel.kind ?? '').trim().toLowerCase();
      if (!otherName || !kind) continue;
      const other = lorebook.findEntity(db, projectId, otherName);
      if (!other || other.id === entity.id) continue;
      const key = `${entity.id}:${other.id}:${kind}`;
      if (have.has(key)) continue;
      have.add(key);
      db.run(
        `INSERT OR IGNORE INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence, review_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        entity.id,
        other.id,
        kind,
        String(rel.description ?? '').trim(),
        String(rel.quote ?? '').trim(),
        toJson([{ source: window[0].source_title, locator: window[0].locator }]),
        0.7,
        'needs_review',
        nowIso(),
      );
      relations++;
    }

    for (const fact of asArray(parsed.facts)) {
      const statement = String(fact.statement ?? '').trim();
      if (!statement) continue;
      const dup = db.get<{ id: number }>(
        'SELECT id FROM canon_fact WHERE project_id = ? AND lower(statement) = lower(?)',
        projectId,
        statement,
      );
      if (dup) continue;
      db.run(
        `INSERT INTO canon_fact (project_id, topic, statement, kind, certainty, subject, subject_entity_id, evidence, source_refs, confidence, review_status, created_at)
         VALUES (?, ?, ?, 'fact', 'inferred', ?, ?, ?, ?, ?, 'needs_review', ?)`,
        projectId,
        String(fact.topic ?? '').trim(),
        statement,
        entity.name,
        entity.id,
        String(fact.quote ?? '').trim(),
        toJson([{ source: window[0].source_title, locator: window[0].locator }]),
        0.6,
        nowIso(),
      );
      facts++;
    }
  }

  return { relations, facts, knowledge, passages: passages.length };
}

/* ------------------------------------------------------------- corrections */

export interface RelationCorrection {
  kind?: string;
  description?: string;
  evidence?: string;
  /** A user correction is trusted: it is marked as confirmed by the author. */
  confirm?: boolean;
}

/** Correct a relation by hand, keeping what was there. */
export function correctRelation(
  db: Db,
  projectId: number,
  id: number,
  patch: RelationCorrection,
): boolean {
  const existing = db.get<{
    id: number;
    kind: string;
    description: string;
    evidence: string;
    review_status: string;
  }>('SELECT id, kind, description, evidence, review_status FROM canon_relation WHERE id = ? AND project_id = ?', id, projectId);
  if (!existing) return false;
  db.run(
    `UPDATE canon_relation SET kind = ?, description = ?, evidence = ?, review_status = ?, confidence = ? WHERE id = ? AND project_id = ?`,
    patch.kind ?? existing.kind,
    patch.description ?? existing.description,
    patch.evidence ?? existing.evidence,
    patch.confirm === false ? existing.review_status : 'user_confirmed',
    patch.confirm === false ? undefined : 1,
    id,
    projectId,
  );
  return true;
}

/** Remove a relation the author does not believe. */
export function removeRelation(db: Db, projectId: number, id: number): boolean {
  const row = db.get<{ id: number }>('SELECT id FROM canon_relation WHERE id = ? AND project_id = ?', id, projectId);
  if (!row) return false;
  db.run('DELETE FROM canon_relation WHERE id = ? AND project_id = ?', id, projectId);
  return true;
}
