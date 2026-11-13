/**
 * Reading the bank: entity, relation, fact and timeline rows, pair history,
 * keyword search, and the compact brief the writer receives.
 *
 * Read-only except `updateEntity`, `deleteEntity` and `setFactProvenance`, which
 * are the entity and fact maintenance paths. No model call and no extraction:
 * this module answers "what does the bank already say".
 *
 * Moved out of lorebook.ts on 2026-11-13, logic unchanged. The two helpers it
 * needs from the monolith that are also needed elsewhere (`firstChunkOf`,
 * `normaliseKind`) live in ./shared.ts instead.
 */
import { Db, fromJson, nowIso, strList } from '../core/db.ts';
import { tokenize } from '../core/text.ts';
import { entitySubject, recordRuling } from '../court/ruling.ts';
import {
  NAME_DF_CAP,
  NAME_MIN_TOKEN,
  canonicalName,
  linkTokensMatch,
  textTokenSet,
} from '../identity/names.ts';
import type { RetrievalTraceSink } from '../trace/trace.ts';
import type {
  CanonEntity,
  CanonFact,
  CanonRelation,
  CanonTimelineEntry,
  ClaimAssessment,
  EntityKind,
} from '../lorebook.ts';
import { readClaimAssessment } from '../lorebook.ts';
import { firstChunkOf, normaliseKind } from './shared.ts';

export function listEntities(
  db: Db,
  projectId: number,
  kind?: EntityKind,
  statuses?: readonly string[],
): CanonEntity[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_entity WHERE project_id = ?';
  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  if (statuses?.length) {
    sql += ` AND review_status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ' ORDER BY kind, name';
  const rows = db.all<{
    id: number;
    kind: string;
    name: string;
    aliases: string;
    summary: string;
    attributes: string;
    role: string;
    status: string;
    first_chunk: number | null;
    evidence: string;
    source_refs: string;
    mentions: number;
    review_status: string | null;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as EntityKind,
    name: r.name,
    aliases: strList(r.aliases),
    summary: r.summary,
    attributes: JSON.parse(r.attributes || '{}') as Record<string, string>,
    role: r.role,
    status: r.status,
    firstChunk: r.first_chunk,
    evidence: r.evidence,
    sourceRefs: JSON.parse(r.source_refs || '[]') as { source: string; locator: string }[],
    mentions: r.mentions,
    reviewStatus: r.review_status ?? 'accepted',
  }));
}

export function listRelations(
  db: Db,
  projectId: number,
  statuses?: readonly string[],
): CanonRelation[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.supporting_evidence,
            a.name AS from_name, b.name AS to_name, r.modality, r.conflict_status,
            r.ledger_state, r.scope, r.review_status
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ?`;
  if (statuses?.length) {
    sql += ` AND r.review_status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ' ORDER BY r.id';
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    supporting_evidence: string;
    from_name: string;
    to_name: string;
    modality: string | null;
    conflict_status: string | null;
    ledger_state: string | null;
    scope: string | null;
    review_status: string | null;
  }>(
    sql,
    ...params,
  );
  return rows.map((r) => ({
    id: r.id,
    fromId: r.from_entity,
    fromName: r.from_name,
    toId: r.to_entity,
    toName: r.to_name,
    kind: r.kind,
    description: r.description,
    evidence: r.evidence,
    supportingEvidence: fromJson<Record<string, unknown>[]>(r.supporting_evidence, []).map((item) => ({
      quote: String(item.quote ?? ''),
      sourceRefs: Array.isArray(item.source_refs) ? item.source_refs : [],
      reason: String(item.reason ?? ''),
      movedAt: String(item.moved_at ?? ''),
      assessment: item.assessment ? readClaimAssessment(item.assessment as Record<string, unknown>) : null,
    })),
    modality: r.modality ?? 'asserted',
    conflictStatus: r.conflict_status ?? 'none',
    ledgerState: r.ledger_state ?? 'verified',
    scope: r.scope ?? '',
    reviewStatus: r.review_status ?? 'accepted',
  }));
}

/** One tie in a pair's story, with its story position when known. */
export interface StatusRow extends CanonRelation {
  /** canon_chunk.seq of the proving passage, or null when unplaceable. */
  seq: number | null;
  /** The passage locator (chapter + page) when known. */
  locator: string | null;
}

/** A pair's relationship over the story: what it is now, what it was. */
export interface PairStatus {
  current: StatusRow | null;
  history: StatusRow[];
}

/**
 * Read-time relationship status: append-only rows in, current-vs-history out.
 *
 * Every differing label the extraction banked stays banked; this lines them up
 * by story order (the proving passage's chunk seq, falling back to row order
 * for unplaceable rows) and calls the latest plain-stated row current. Denials
 * and maybes never become status. Same-window rivals keep whatever contested
 * flag the marking pass gave them; far-apart changes simply order as history.
 * With atSeq, the line stops there (unplaceable rows are excluded: a status
 * "at chapter 3" cannot rest on a claim going nowhere).
 */
export function pairHistory(
  db: Db,
  projectId: number,
  aId: number,
  bId: number,
  atSeq?: number,
): PairStatus {
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    supporting_evidence: string;
    from_name: string;
    to_name: string;
    modality: string | null;
    conflict_status: string | null;
    ledger_state: string | null;
    scope: string | null;
    review_status: string | null;
    source_refs: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.supporting_evidence,
            a.name AS from_name, b.name AS to_name, r.modality, r.conflict_status,
            r.ledger_state, r.scope, r.review_status, r.source_refs
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ?
       AND ((r.from_entity = ? AND r.to_entity = ?) OR (r.from_entity = ? AND r.to_entity = ?))
     ORDER BY r.id`,
    projectId, aId, bId, bId, aId,
  );
  const seqByChunk = new Map(
    db
      .all<{ id: number; seq: number; locator: string }>('SELECT id, seq, locator FROM canon_chunk WHERE project_id = ?', projectId)
      .map((c) => [c.id, c] as [number, { seq: number; locator: string }]),
  );
  const placed: StatusRow[] = rows.map((r) => {
    const chunkId = firstChunkOf(r.source_refs);
    const chunk = chunkId !== undefined ? seqByChunk.get(chunkId) : undefined;
    const seq = chunk ? chunk.seq : null;
    return {
      id: r.id,
      fromId: r.from_entity,
      fromName: r.from_name,
      toId: r.to_entity,
      toName: r.to_name,
      kind: r.kind,
      description: r.description,
      evidence: r.evidence,
      supportingEvidence: fromJson<Record<string, unknown>[]>(r.supporting_evidence, []).map((item) => ({
        quote: String(item.quote ?? ''),
        sourceRefs: Array.isArray(item.source_refs) ? item.source_refs : [],
        reason: String(item.reason ?? ''),
        movedAt: String(item.moved_at ?? ''),
        assessment: item.assessment ? readClaimAssessment(item.assessment as Record<string, unknown>) : null,
      })),
      modality: r.modality ?? 'asserted',
      conflictStatus: r.conflict_status ?? 'none',
      ledgerState: r.ledger_state ?? 'verified',
      scope: r.scope ?? '',
      reviewStatus: r.review_status ?? 'accepted',
      seq,
      locator: chunk ? chunk.locator : null,
    };
  });
  // Flagged rows are invisible to status until cleared: pending review reads
  // as no current, not as a guess. Human-confirmed rows stay visible.
  const cleared = placed.filter((r) => r.reviewStatus === 'accepted' || r.reviewStatus === 'user_confirmed');
  const visible = atSeq === undefined ? cleared : cleared.filter((r) => r.seq !== null && r.seq <= atSeq);
  visible.sort((x, y) => (x.seq ?? Number.POSITIVE_INFINITY) - (y.seq ?? Number.POSITIVE_INFINITY) || x.id - y.id);
  const asserted = visible.filter((r) => r.modality === 'asserted');
  const current = asserted.length ? asserted[asserted.length - 1]! : null;
  const history = current ? visible.filter((r) => r.id !== current.id) : visible;
  return { current, history };
}

/**
 * Directed status: A→B and B→A hold separate currents.
 *
 * The undirected pairHistory stays for history views; this is the answering
 * path, where a reversed arrow must become impossible, not just unlikely.
 * Each direction filters to its own arrow, orders by story position, and
 * names the latest asserted row current. Flagged rows stay invisible per
 * direction. Deterministic by construction.
 */
export function directedPairStatus(
  db: Db,
  projectId: number,
  aId: number,
  bId: number,
  atSeq?: number,
): { forward: PairStatus; reverse: PairStatus } {
  const one = (from: number, to: number): PairStatus => {
    const { current, history } = pairHistory(db, projectId, from, to, atSeq);
    // pairHistory reads both arrows; narrow to the requested one.
    const fwd = [current, ...history].filter(Boolean).filter(
      (r) => r!.fromId === from && r!.toId === to,
    ) as StatusRow[];
    fwd.sort((x, y) => (x.seq ?? Number.POSITIVE_INFINITY) - (y.seq ?? Number.POSITIVE_INFINITY) || x.id - y.id);
    const asserted = fwd.filter((r) => r.modality === 'asserted');
    const cur = asserted.length ? asserted[asserted.length - 1]! : null;
    return { current: cur, history: cur ? fwd.filter((r) => r.id !== cur.id) : fwd };
  };
  return { forward: one(aId, bId), reverse: one(bId, aId) };
}

/**
 * Set a fact's provenance and review state. Used by the provenance gate: a
 * verified quote promotes the fact, an ungrounded one is rejected.
 */
export function setFactProvenance(
  db: Db,
  projectId: number,
  factId: number,
  sourceRefs: string,
  status: 'accepted' | 'rejected',
  basis: string,
  quote = '',
): boolean {
  const row = db.get<{ review_status: string; subject_entity_id: number | null }>(
    'SELECT review_status, subject_entity_id FROM canon_fact WHERE id = ? AND project_id = ?',
    factId,
    projectId,
  );
  if (!row) return false;
  return db.transaction(() => {
    db.run(
      'UPDATE canon_fact SET source_refs = ?, review_status = ? WHERE id = ? AND project_id = ?',
      sourceRefs,
      status,
      factId,
      projectId,
    );
    if (row.subject_entity_id) {
      recordRuling(db, projectId, {
        subject: entitySubject(Number(row.subject_entity_id)),
        role: 'verdict',
        actor: 'human',
        standard: 'provenance',
        fromStatus: row.review_status,
        toStatus: status,
        basis,
        quote,
      });
    }
    return true;
  });
}

export function listFacts(db: Db, projectId: number, topic?: string): CanonFact[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_fact WHERE project_id = ?';
  if (topic) {
    sql += ' AND (topic = ? OR lower(topic) LIKE ?)';
    params.push(topic, `%${topic.toLowerCase()}%`);
  }
  sql += ' ORDER BY id';
  const rows = db.all<{
    id: number;
    topic: string;
    statement: string;
    kind: string;
    certainty: string;
    subject: string;
    evidence: string;
    source_refs: string;
    modality: string | null;
    conflict_status: string | null;
    review_status: string | null;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    statement: r.statement,
    kind: r.kind,
    certainty: r.certainty,
    subject: r.subject,
    evidence: r.evidence,
    sourceRefs: JSON.parse(r.source_refs || '[]') as { source: string; locator: string }[],
    modality: r.modality ?? 'asserted',
    conflictStatus: r.conflict_status ?? 'none',
    reviewStatus: r.review_status ?? 'needs_review',
  }));
}

export function listTimeline(db: Db, projectId: number): CanonTimelineEntry[] {
  const rows = db.all<{
    id: number;
    canon_event: number | null;
    seq: number;
    title: string;
    summary: string;
    time_label: string;
    participants: string;
    location: string;
    evidence: string;
  }>('SELECT * FROM canon_timeline WHERE project_id = ? ORDER BY seq, id', projectId);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.canon_event,
    seq: r.seq,
    title: r.title,
    summary: r.summary,
    when: r.time_label,
    participants: strList(r.participants),
    location: r.location,
    evidence: r.evidence,
  }));
}

export function updateEntity(
  db: Db,
  projectId: number,
  id: number,
  patch: Partial<Pick<CanonEntity, 'name' | 'summary' | 'role' | 'status' | 'kind'>>,
): void {
  const existing = db.get<{ name: string; summary: string; role: string; status: string; kind: string }>(
    'SELECT name, summary, role, status, kind FROM canon_entity WHERE id = ? AND project_id = ?',
    id,
    projectId,
  );
  if (!existing) return;
  // A partial patch changes only the fields it names. Resetting the rest to
  // empty would erase the entity's summary or turn a location into a person.
  db.run(
    'UPDATE canon_entity SET name = ?, summary = ?, role = ?, status = ?, kind = ?, updated_at = ? WHERE id = ? AND project_id = ?',
    patch.name ?? existing.name,
    patch.summary ?? existing.summary,
    patch.role ?? existing.role,
    patch.status ?? existing.status,
    patch.kind === undefined ? existing.kind : normaliseKind(patch.kind),
    nowIso(),
    id,
    projectId,
  );
}

/**
 * Remove an entity. Its relations cascade with it, so each one leaves a
 * removal ruling first: a deletion is a court decision, not an absence.
 */
export function deleteEntity(db: Db, projectId: number, id: number): void {
  const entity = db.get<{ id: number; name: string; review_status: string }>(
    'SELECT id, name, review_status FROM canon_entity WHERE id = ? AND project_id = ?',
    id,
    projectId,
  );
  if (!entity) return;
  const relations = db.all<{ id: number; kind: string; evidence: string; review_status: string }>(
    'SELECT id, kind, evidence, review_status FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
    projectId,
    id,
    id,
  );
  db.transaction(() => {
    // The entity's own removal is the parent decision; the relation removals
    // below only record what the cascade took with it.
    recordRuling(db, projectId, {
      subject: entitySubject(id),
      role: 'removal',
      actor: 'human',
      standard: 'entity-removal',
      fromStatus: entity.review_status,
      toStatus: 'removed',
      basis: `entity ${entity.name} removed`,
    });
    for (const row of relations) {
      recordRuling(db, projectId, {
        relationId: row.id,
        role: 'removal',
        actor: 'human',
        standard: 'entity-removal',
        fromStatus: row.review_status,
        toStatus: 'removed',
        basis: `entity ${entity.name} removed (${row.kind})`,
        quote: row.evidence,
      });
    }
    db.run('DELETE FROM canon_entity WHERE id = ? AND project_id = ?', id, projectId);
  });
}

export interface LoreBrief {
  entities: string;
  relations: string;
  facts: string;
  /** Selected row ids, for diagnostics. These do not affect the rendered brief. */
  entityIds?: number[];
  citedEntityIds?: number[];
  relationIds?: number[];
  factIds?: number[];
  citedFactIds?: number[];
}

/**
 * A compact, factual brief of the book lore.
 *
 * This is what the writer gets instead of (or alongside) raw passages: names,
 * roles, states, relationships and the rules of the world, each with the
 * citation it came from.
 */
export function buildLoreBrief(
  db: Db,
  projectId: number,
  opts: { names?: string[]; maxEntities?: number; includeFacts?: boolean } = {},
): LoreBrief {
  const all = listEntities(db, projectId);
  const names = (opts.names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const matched = names.length
    ? all.filter(
        (e) =>
          names.some((n) => e.name.toLowerCase().includes(n) || e.aliases.some((a) => a.toLowerCase().includes(n))),
      )
    : all;
  const chosen = matched.slice(0, opts.maxEntities ?? 20);
  // The writer-facing brief is factual canon only. Needs-review/provisional/
  // attested/rejected candidates stay in the bank and in the planning web
  // brief, but must not be presented to the writer as source relationships.
  const relations = listRelations(db, projectId, ['accepted', 'user_confirmed']).filter(
    (r) => !names.length || chosen.some((e) => e.id === r.fromId || e.id === r.toId),
  );
  const facts = opts.includeFacts === false
    ? []
    // Facts are advisory by design: accepted and needs_review both reach the
    // brief under a "verify before asserting" heading. Only a fact shown to be
    // ungrounded is withheld.
    : listFacts(db, projectId).filter((fact) => fact.reviewStatus !== 'rejected');
  return renderBrief(chosen, relations, facts, names);
}

/** Turn lore records into the three text sections used in prompts. */
export function renderBrief(
  entities: CanonEntity[],
  relations: CanonRelation[],
  facts: CanonFact[],
  names: string[] = [],
): LoreBrief {
  const entityLines = entities.map((e) => {
    const bits = [
      e.summary,
      e.role ? `role: ${e.role}` : '',
      e.status ? `status: ${e.status}` : '',
      Object.entries(e.attributes)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; '),
    ].filter(Boolean);
    const refs = e.sourceRefs.map((r) => r.locator).join(', ');
    return `- ${e.name}${e.aliases.length ? ` (${e.aliases.join(', ')})` : ''} [${e.kind}]` +
      `${bits.length ? `: ${bits.join('. ')}` : ''}${refs ? ` (${refs})` : ''}`;
  });

  const shownRelations = relations.slice(0, 25);
  const relationLines = shownRelations.map(
    (r) => `- ${r.fromName} → ${r.toName}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`,
  );

  const shownFacts = facts
    .filter((f) => !names.length || !f.subject || names.some((n) => f.subject.toLowerCase().includes(n)))
    .slice(0, 25);
  const factLines = shownFacts.map(
    (f) => `- ${f.statement}${f.topic ? ` (${f.topic})` : ''}${f.certainty === 'inferred' ? ' [inferred]' : ''}`,
  );

  return {
    entities: entityLines.join('\n'),
    relations: relationLines.join('\n'),
    facts: factLines.join('\n'),
    entityIds: entities.map((e) => e.id),
    citedEntityIds: entities.filter((e) => e.sourceRefs.length > 0).map((e) => e.id),
    relationIds: shownRelations.map((r) => r.id),
    factIds: shownFacts.map((f) => f.id),
    citedFactIds: shownFacts.filter((f) => f.sourceRefs.length > 0).map((f) => f.id),
  };
}

/** The brief rendered for a prompt. */
export function formatLoreBrief(brief: LoreBrief): string {
  const parts: string[] = [];
  if (brief.entities) parts.push(`PEOPLE, PLACES AND THINGS:\n${brief.entities}`);
  if (brief.relations) parts.push(`RELATIONSHIPS IN THE SOURCE:\n${brief.relations}`);
  if (brief.facts) parts.push(`SOURCE-DERIVED FACTS (VERIFY BEFORE ASSERTING):\n${brief.facts}`);
  if (!parts.length) return '';
  return (
    parts.join('\n\n') +
    '\n\nUse these names, roles, states and rules exactly as given. Do not add numbers, ' +
    'cases or rules that are not stated here or in the retrieved passages.'
  );
}

/**
 * Find the lore entry a name refers to, exactly.
 *
 * IDENTITY policy: exact name, exact alias, or a fuller name with the asked
 * name as a whole prefix. This deliberately does not use LINK/fuzzy matching;
 * a question may be loose, but identity and merge decisions must not be.
 */
export function findEntity(db: Db, projectId: number, name: string): CanonEntity | undefined {
  const clean = (name ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  const all = listEntities(db, projectId);
  const exact = all.find((e) => e.name.toLowerCase() === clean);
  if (exact) return exact;
  const alias = all.find((e) => e.aliases.some((a) => a.toLowerCase() === clean));
  if (alias) return alias;
  // A stored honorific does not change identity: "Ollivander" -> "Mr. Ollivander".
  const HONORIFIC = new Set(['mr', 'mrs', 'ms', 'miss', 'madam', 'professor', 'dr', 'uncle', 'aunt', 'lord', 'lady', 'sir']);
  const core = (value: string) =>
    value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token && !HONORIFIC.has(token)).join(' ');
  const wanted = core(clean);
  if (wanted) {
    const bare = all.filter((e) => core(e.name) === wanted);
    if (bare.length === 1) return bare[0];
  }
  // A fuller name that starts with what was asked for: "Harry" -> "Harry Potter".
  return all.find((e) => e.name.toLowerCase().startsWith(clean + ' '));
}

/**
 * Look up lore entries that mention a name or phrase.
 *
 * Used by the lore researcher to answer from the extracted index first, and to
 * fill in context requests about a character.
 */
export function searchLore(db: Db, projectId: number, query: string, limit = 10, trace?: RetrievalTraceSink): {
  entities: CanonEntity[];
  relations: CanonRelation[];
  facts: CanonFact[];
  timeline: CanonTimelineEntry[];
} {
  const emit = (event: Parameters<RetrievalTraceSink['emit']>[0]): void => {
    trace?.emit({ stage: 'retrieval', ...event });
  };
  const emitIndexSummary = (kind: string, raw: number, selected: number): void => {
    emit({
      event: 'retrieval.summary',
      subject: `search:index:${kind}`,
      decision: 'completed',
      reasonCode: raw ? 'ok' : 'empty',
      refs: {
        raw_count: raw,
        dedup_count: raw,
        ranked_count: raw,
        selected_count: selected,
        budgeted_count: raw - selected,
        excluded_count: 0,
        stage: 'index-match',
      },
    });
    if (raw > selected) {
      emit({
        event: 'retrieval.budget.cutoff',
        subject: `budget:index:${kind}`,
        decision: 'budgeted',
        reasonCode: 'index-limit',
        refs: { count: raw - selected, stage: 'index-match' },
      });
    }
  };
  const q = query.trim().toLowerCase();
  if (!q) {
    for (const kind of ['entity', 'relation', 'fact', 'timeline']) emitIndexSummary(kind, 0, 0);
    emit({
      event: 'retrieval.search.completed',
      subject: 'search:index',
      decision: 'completed',
      reasonCode: 'empty',
      refs: { count: 0, stage: 'index-match' },
    });
    return { entities: [], relations: [], facts: [], timeline: [] };
  }
  const allEntities = listEntities(db, projectId, undefined, ['accepted', 'user_confirmed']);
  const tokenDf = new Map<string, number>();
  for (const entity of allEntities) {
    const tokens = new Set<string>();
    for (const variant of [entity.name, ...entity.aliases]) {
      for (const token of canonicalName(variant).split(' ')) {
        if (token.length >= NAME_MIN_TOKEN) tokens.add(token);
      }
    }
    for (const token of tokens) tokenDf.set(token, (tokenDf.get(token) ?? 0) + 1);
  }
  const words = tokenize(q).filter((word) => (tokenDf.get(word) ?? 0) <= NAME_DF_CAP);
  if (!words.length) {
    for (const kind of ['entity', 'relation', 'fact', 'timeline']) emitIndexSummary(kind, 0, 0);
    emit({
      event: 'retrieval.search.completed',
      subject: 'search:index',
      decision: 'completed',
      reasonCode: 'empty',
      refs: { count: 0, stage: 'index-match' },
    });
    return { entities: [], relations: [], facts: [], timeline: [] };
  }
  const matches = (hay: string): boolean => linkTokensMatch(words, textTokenSet(hay));

  const entities = allEntities.filter((e) => {
    if (e.reviewStatus !== 'accepted' && e.reviewStatus !== 'user_confirmed') return false;
    return matches(`${e.name} ${e.aliases.join(' ')} ${e.summary} ${e.role}`);
  });

  const rels = listRelations(db, projectId, ['accepted', 'user_confirmed']).filter((r) => {
    return matches(`${r.fromName} ${r.toName} ${r.kind} ${r.description}`);
  });

  const facts = listFacts(db, projectId).filter((f) => {
    return matches(`${f.topic} ${f.statement} ${f.subject}`);
  });

  const timeline = listTimeline(db, projectId).filter((t) => {
    return matches(`${t.title} ${t.summary} ${t.participants.join(' ')} ${t.location}`);
  });

  const result = {
    entities: entities.slice(0, limit),
    relations: rels.slice(0, limit),
    facts: facts.slice(0, limit),
    timeline: timeline.slice(0, limit),
  };
  const total = result.entities.length + result.relations.length + result.facts.length + result.timeline.length;
  emit({
    event: 'retrieval.search.completed',
    subject: 'search:index',
    decision: 'completed',
    reasonCode: total ? 'ok' : 'empty',
    refs: { count: total, stage: 'index-match' },
  });
  const groups: Array<{
    kind: string;
    rows: { id: number }[];
    raw: number;
    selected: number;
    refKey?: 'entity_id' | 'relation_id';
  }> = [
    { kind: 'entity', rows: result.entities, raw: entities.length, selected: result.entities.length, refKey: 'entity_id' },
    { kind: 'relation', rows: result.relations, raw: rels.length, selected: result.relations.length, refKey: 'relation_id' },
    { kind: 'fact', rows: result.facts, raw: facts.length, selected: result.facts.length },
    { kind: 'timeline', rows: result.timeline, raw: timeline.length, selected: result.timeline.length },
  ];
  for (const group of groups) {
    emitIndexSummary(group.kind, group.raw, group.selected);
    for (let i = 0; i < group.rows.length; i++) {
      const id = Number(group.rows[i]!.id);
      const refs: { rank: number; stage: string; entity_id?: number; relation_id?: number } = {
        rank: i + 1,
        stage: 'index-match',
      };
      if (group.refKey && Number.isFinite(id)) refs[group.refKey] = id;
      emit({
        event: 'retrieval.candidate.generated',
        subject: `index:${group.kind}:${id}`,
        decision: 'candidate',
        reasonCode: 'index',
        refs,
      });
      emit({
        event: 'retrieval.candidate.disposition',
        subject: `index:${group.kind}:${id}`,
        decision: 'selected',
        reasonCode: 'selected',
        refs,
      });
    }
  }
  return result;
}

/** How much lore has been extracted, for the UI. */
export function loreStats(db: Db, projectId: number): {
  entities: number;
  relations: number;
  facts: number;
  timeline: number;
  characters: number;
  locations: number;
  rules: number;
} {
  const count = (sql: string, ...params: unknown[]) => db.get<{ n: number }>(sql, ...params)?.n ?? 0;
  return {
    entities: count('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId),
    relations: count('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId),
    facts: count('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', projectId),
    timeline: count('SELECT COUNT(*) AS n FROM canon_timeline WHERE project_id = ?', projectId),
    characters: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'character'", projectId),
    locations: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'location'", projectId),
    rules: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'rule'", projectId),
  };
}

/** One line per relationship pair, strongest row first. */
export interface RelationshipPair {
  fromName: string;
  toName: string;
  kind: string;
  status: string;
  locator: string;
  confirmedByUser: boolean;
  rows: number;
}

const RELATION_STATUS_RANK: Record<string, number> = {
  user_confirmed: 0,
  accepted: 1,
  provisional: 2,
  needs_review: 3,
};

/**
 * Collapse the relation table to one row per pair. The same two people may be
 * stored several times (inverse directions, repealed kinds, duplicate roster
 * rows); the strongest status wins and the rest are counted.
 */
export function listRelationshipPairs(db: Db, projectId: number): RelationshipPair[] {
  const rows = db.all<{
    id: number;
    from_id: number;
    to_id: number;
    from_name: string;
    to_name: string;
    kind: string;
    review_status: string;
    confirmed_by_user: number | null;
    source_refs: string;
  }>(
    `SELECT r.id, r.from_entity AS from_id, r.to_entity AS to_id,
            a.name AS from_name, b.name AS to_name, r.kind, r.review_status,
            r.confirmed_by_user, coalesce(r.source_refs, '[]') AS source_refs
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ?`,
    projectId,
  );
  const groups = new Map<string, { best: (typeof rows)[number]; count: number }>();
  for (const row of rows) {
    const key = `${Math.min(row.from_id, row.to_id)}|${Math.max(row.from_id, row.to_id)}`;
    // Status selects the display label among duplicate rows; a verdict adds no
    // rank, so confirming one of two duplicate rows cannot change the pick.
    const rank = RELATION_STATUS_RANK[row.review_status === 'user_confirmed' ? 'accepted' : row.review_status] ?? 4;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { best: row, count: 1 });
      continue;
    }
    group.count++;
    const bestRank =
      RELATION_STATUS_RANK[group.best.review_status === 'user_confirmed' ? 'accepted' : group.best.review_status] ?? 4;
    if (rank < bestRank) group.best = row;
  }
  const locatorOf = (refs: string): string => {
    try {
      const list = JSON.parse(refs) as { locator?: unknown }[];
      return list.map((r) => (typeof r.locator === 'string' ? r.locator.trim() : '')).find(Boolean) ?? '';
    } catch {
      return '';
    }
  };
  return [...groups.values()]
    .map(({ best, count }) => ({
      fromName: best.from_name,
      toName: best.to_name,
      kind: best.kind,
      // The label rides along for audit; the tier is the row's own evidence.
      status: best.review_status,
      locator: locatorOf(best.source_refs),
      confirmedByUser: best.confirmed_by_user === 1,
      rows: count,
    }))
    .sort(
      (a, b) =>
        (RELATION_STATUS_RANK[a.status] ?? 4) - (RELATION_STATUS_RANK[b.status] ?? 4) ||
        a.fromName.localeCompare(b.fromName) ||
        a.toName.localeCompare(b.toName),
    );
}

/** A pair the extractor proposed that never reached the bank. */
export interface TieProposal {
  fromName: string;
  toName: string;
  kind: string;
  reason: string;
  locator: string;
  notes: number;
}

/**
 * Pending tie notes, one row per pair, excluding pairs that already hold a
 * keeper. This is the review queue: everything the extractor offered and the
 * guard refused, with the reason it gave.
 */
export function listTieProposals(db: Db, projectId: number): TieProposal[] {
  const notes = db.all<{
    id: number;
    from_id: number;
    to_id: number;
    from_name: string;
    to_name: string;
    attempted_kind: string;
    reason: string;
    source_refs: string;
  }>(
    `SELECT n.id, n.from_entity AS from_id, n.to_entity AS to_id,
            a.name AS from_name, b.name AS to_name,
            n.attempted_kind, n.reason, coalesce(n.source_refs, '[]') AS source_refs
       FROM canon_tie_note n
       JOIN canon_entity a ON a.id = n.from_entity
       JOIN canon_entity b ON b.id = n.to_entity
      WHERE n.project_id = ? AND n.status = 'pending'`,
    projectId,
  );
  const keepers = new Set(
    db
      .all<{ a: number; b: number }>(
        `SELECT from_entity AS a, to_entity AS b FROM canon_relation
          WHERE project_id = ? AND (review_status = 'user_confirmed' OR confirmed_by_user = 1)`,
        projectId,
      )
      .map((r) => `${Math.min(r.a, r.b)}|${Math.max(r.a, r.b)}`),
  );
  const locatorOf = (refs: string): string => {
    try {
      const list = JSON.parse(refs) as { locator?: unknown }[];
      return list.map((r) => (typeof r.locator === 'string' ? r.locator.trim() : '')).find(Boolean) ?? '';
    } catch {
      return '';
    }
  };
  const groups = new Map<string, { note: (typeof notes)[number]; count: number }>();
  for (const note of notes) {
    const key = `${Math.min(note.from_id, note.to_id)}|${Math.max(note.from_id, note.to_id)}`;
    if (keepers.has(key)) continue;
    const group = groups.get(key);
    if (!group) groups.set(key, { note, count: 1 });
    else group.count++;
  }
  return [...groups.values()]
    .map(({ note, count }) => ({
      fromName: note.from_name,
      toName: note.to_name,
      kind: note.attempted_kind,
      reason: note.reason,
      locator: locatorOf(note.source_refs),
      notes: count,
    }))
    .sort((a, b) => b.notes - a.notes || a.fromName.localeCompare(b.fromName));
}